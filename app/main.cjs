const { app, BrowserWindow, ipcMain, dialog, session, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Archive, DownloadQueue } = require('./archive.cjs');
const { changeCollection } = require('./collections.cjs');
const { createLocalPack, packDirectory, diskFiles, diskFilePath } = require('./local-packs.cjs');
const { safeName, key, inside, externalUrl, atomicJson, skipProductErrors, retrySkippedErrors } = require('./core.cjs');
const { ORIGIN, LIBRARY_URL, SiteAdapter, accountSnapshot, librarySnapshot, pause } = require('./site.cjs');
const { getProductDetails, readDetailsPage } = require('./details.cjs');
const { Synchronizer } = require('./sync.cjs');
const { cardKey, cachedProduct, prepareCatalogGroups, uniqueCardKeys, indexFolderCards,
  resolveFolderMember, applyPurchaseOrder, recoveringCardReader, readProduct, saveCover } = require('./catalog.cjs');
const { resetAllData, deletePack } = require('./reset.cjs');
const { Diagnostics } = require('./diagnostics.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'archive', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
if (argument('--state-dir')) app.setPath('userData', path.resolve(argument('--state-dir')));
const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
let mainWindow, siteWindow, siteSession, adapter, queue, importing = false, stopImport = false, resetting = false;
let creatingPack = false;
let deletingPack = false, pendingPackDeletionConflicts = 0;
const packDeletionConflicts = new Set(['choose-location', 'wipe-all-data', 'sign-in', 'synchronize', 'resync-product', 'skip-error', 'create-pack', 'organize']);
const pickedFiles = new Map();
const windows = new Set();
const diagnostics = new Diagnostics(path.join(app.getPath('userData'), 'logs'), app.getVersion());
const archive = new Archive(state => { for (const win of windows) if (!win.isDestroyed()) win.webContents.send('state', state); }, diagnostics);
const synchronizer = new Synchronizer({
  log: (level, event, fields) => archive.log(level, event, fields),
  publish: activity => archive.update(activity),
  authenticate: (cancelled, show) => authenticate(cancelled, show),
  catalog: () => importLibrary(),
  product: id => resyncProduct(id),
  files: async (productIds, deep) => {
    queue = new DownloadQueue(archive, adapter, siteSession, { productIds, deep });
    await queue.start();
  },
  resumeFiles: () => queue?.start(),
  pause: () => { stopImport = true; queue?.pause(); },
});
const html = path.join(__dirname, 'index.html');
function localWindow(query = {}) {
  const win = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 650, backgroundColor: '#17171a', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setMenuBarVisibility(false); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  windows.add(win); win.on('closed', () => windows.delete(win));
  win.once('ready-to-show', () => win.show()); win.loadFile(html, { query }); return win;
}
function assertLocal(event) {
  if (![...windows].some(win => win.webContents.id === event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted caller.');
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => { assertLocal(event); try {
    if (resetting && name !== 'state') throw new Error('Please wait for the data reset to finish.');
    if (creatingPack && ['create-pack', 'wipe-all-data', 'choose-location'].includes(name)) throw new Error('Wait for the pack files to finish copying.');
    const conflictsWithDeletion = packDeletionConflicts.has(name);
    if (deletingPack && conflictsWithDeletion) throw new Error('Wait for pack deletion to finish.');
    if (conflictsWithDeletion) pendingPackDeletionConflicts++;
    try { return await fn(...args); }
    finally { if (conflictsWithDeletion) pendingPackDeletionConflicts--; }
  } catch (error) { archive.log('error', 'action.failed', { stage: name, error }); throw new Error(error.message || 'Operation failed.'); } });
}
function guardIdle(message = 'Pause synchronization and wait for it to stop before changing the library location.') {
  if (synchronizer.running || importing || queue?.running) throw new Error(message);
}
function protectedArchivePaths() {
  return [app.getPath('home'), app.getPath('userData'), app.getAppPath(), process.resourcesPath,
    process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
}
function ensureSite(show = false) {
  if (siteWindow && !siteWindow.isDestroyed()) { if (show) { siteWindow.show(); siteWindow.focus(); } return; }
  siteWindow = new BrowserWindow({ width: 1280, height: 860, show, title: 'Sign in to ArtStation - ArtStation Archiver',
    webPreferences: { session: siteSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  siteWindow.setMenuBarVisibility(false);
  siteWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Authentication stays in the isolated site window; never give remote content the app preload.
    const u = new URL(url);
    if (u.protocol === 'https:' && /(^|\.)(artstation\.com|epicgames\.com|google\.com|facebook\.com)$/.test(u.hostname)) {
      siteWindow.loadURL(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  adapter = new SiteAdapter(siteWindow, { log: (level, event, fields) => archive.log(level, event, fields) });
  siteWindow.on('closed', () => { archive.update({ signedIn: false }); });
  siteWindow.loadURL(LIBRARY_URL).catch(error => {
    // OAuth can replace the initial navigation while the user signs in.
    if (error.code !== 'ERR_ABORTED') archive.update({ message: 'Could not open ArtStation. Check your network connection.' });
  });
}
async function signedAccount() {
  if (!siteWindow || siteWindow.isDestroyed()) throw new Error('Click Sign in to ArtStation first.');
  const profile = await adapter.evaluate(accountSnapshot);
  if (!profile) throw new Error('Finish signing in to ArtStation first.');
  const account = new URL(profile, ORIGIN).pathname.toLowerCase().replace(/\/$/, '');
  if (archive.data.account && archive.data.account !== account) throw new Error('This archive belongs to a different ArtStation account. Sign in to the matching account.');
  return account;
}
async function authenticate(cancelled, show) {
  ensureSite(show);
  const started = Date.now();
  while (!cancelled()) {
    if (!siteWindow || siteWindow.isDestroyed()) throw new Error('Sign-in window was closed. Click Sign in to try again.');
    let profile = null;
    try { profile = await adapter.evaluate(accountSnapshot); } catch { /* Login can be on another origin. */ }
    if (profile) {
      await signedAccount();
      siteWindow.hide();
      archive.update({ signedIn: true, message: 'Signed in. Synchronizing your library...' });
      return;
    }
    if (!siteWindow.isVisible() && Date.now() - started > 2000) siteWindow.show();
    archive.update({ phase: 'connecting', message: 'Finish signing in in the ArtStation window. Synchronization will start automatically.' });
    await pause(750);
  }
}
async function detailsFor(product, force = false) {
  return getProductDetails(product, async () => {
  if (!product.detailsUrl) throw new Error('Product details link is missing.');
  const url = new URL(product.detailsUrl);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/marketplace/p/')) throw new Error('Unsupported product details address.');
  const window = new BrowserWindow({ show: false, webPreferences: { session: siteSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const detailAdapter = new SiteAdapter(window);
    return await readDetailsPage(window, detailAdapter, url.href);
  } finally { window.destroy(); }
  }, { force });
}
async function saveProduct(modal, card, orderIndex, hidden, forceDetails = false) {
  const route = new URL(modal.route), match = route.pathname.match(/^\/marketplace\/library\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (!match) throw new Error('Unrecognized purchased-product address.');
  const id = `${match[1]}-${match[2]}`;

  const unresolved = cachedProduct(archive.data, card);
  const existing = archive.data.products.find(p => p.id === id) || (unresolved?.id.startsWith('unresolved-') ? unresolved : null);
  const product = { ...existing, ...modal, id, title: card.title, author: modal.author || card.author,
    sourceKey: cardKey(card), sourceCard: card, catalogError: null, lastIndexedAt: new Date().toISOString(),
    order: orderIndex,
    sourceHidden: hidden, hidden: existing?.localHidden ?? hidden,
    directory: existing?.directory || `${safeName(card.title, 65)}--${safeName(id, 35)}`,
    metadataState: 'pending', warnings: [], sourcePresent: true };
  // Never infer versions from their names. The site's selected release is recorded explicitly.
  product.release.selection = 'site-default';
  if (modal.release.options.length > 1 && !modal.release.options.at(-1).selected) {
    product.warnings.push('The site did not select its last listed release. Verify the latest release before downloading.');
    product.release.needsReview = true;
  }
  product.files = modal.files.map(f => {
    const fileId = key(product.release.id + ':' + product.release.name + ':' + f.index + ':' + f.name + ':' + f.meta);
    const old = existing?.files?.find(file => file.id === fileId);
    return { ...old, ...f, id: fileId, state: old?.state || 'pending', received: old?.received || 0, total: old?.total || null,
      relativePath: old?.relativePath, sha256: old?.sha256, error: old?.error || null };
  });
  if (existing?.release && (existing.release.name !== product.release.name || existing.release.id !== product.release.id)) {
    product.previousReleases = [...(existing.previousReleases || []), { release: existing.release, files: existing.files }];
  }
  const index = archive.data.products.findIndex(p => p.id === (existing?.id || id));
  if (index < 0) archive.data.products.push(product); else archive.data.products[index] = product;
  resolveFolderMember(archive.data.folders, 'unresolved-' + product.sourceKey, id);
  if (existing && existing.id !== id) resolveFolderMember(archive.data.folders, existing.id, id);
  await archive.persistProduct(product);
  const issues = [];
  try { Object.assign(product, await detailsFor(product, forceDetails)); }
  catch (error) { archive.log('warning', 'description.failed', { product: product.title, productId: product.id, error }); issues.push('Description could not be saved. Synchronize again to retry.'); }
  for (const [field, url] of [['cover', card.coverUrl || modal.coverUrl], ['avatar', modal.avatarUrl || card.avatarUrl]]) {
    if (stopImport) break;
    try {
      if (field === 'cover') await saveCover(archive, product, url, siteSession);
      else product[field] = await archive.media(url, product.directory + '/media', siteSession);
    }
    catch (error) { archive.log('warning', 'preview.failed', { product: product.title, stage: field, error }); issues.push(`${field === 'cover' ? 'Cover' : 'Author image'} could not be saved. Synchronize again to retry.`); }
  }
  const galleryLocal = [];
  for (const url of product.gallery || []) {
    if (stopImport) break;
    try { galleryLocal.push(await archive.media(url, product.directory + '/media', siteSession)); }
    catch (error) { archive.log('warning', 'preview.failed', { product: product.title, stage: 'gallery', error }); issues.push('A gallery image could not be saved. Synchronize again to retry.'); }
  }
  if (galleryLocal.length || !product.galleryLocal) product.galleryLocal = galleryLocal;
  product.metadataState = stopImport ? 'pending' : issues.length ? 'error' : 'complete';
  product.warnings.push(...new Set(issues));
  await archive.persistProduct(product); archive.update({});
  return product;
}

async function scanCatalogSection(group) {
  await adapter.action('close');
  await adapter.action('folder', group.folder ? group.name : 'All');
  if (!group.folder) {
    const all = await adapter.wait(librarySnapshot, s => s.sectionName === 'All' && !s.loading, 45000, () => stopImport);
    if (group.hidden || (all.activeFilter && all.activeFilter !== 'All')) {
      await adapter.action('filter', group.hidden ? 'Hidden Products' : 'All');
    }
  }
  await pause(900);
  return adapter.scan(group.expected, (n, status) => archive.update({ phase: 'scanning', catalogRead: n, catalogExpected: group.expected,
    message: `Reading ${group.name}: ${n}${group.expected == null ? '' : ' / ' + group.expected} products${status.waitingForLibrary ? ' — waiting for the library section (' + status.waitingSeconds + 's)' : status.waitingSeconds >= 3 ? ' — waiting for the next page (' + status.waitingSeconds + 's)' : ''}` }), () => stopImport, group.hidden, group.hidden ? null : group.name);
}

async function importLibrary() {
  if (!archive.root) throw new Error('Choose a library folder first.');
  importing = true; stopImport = false;
  try {
    const account = await signedAccount();
    archive.data.account = account; archive.data.discoveryComplete = false;
    archive.data.incompleteSections = [];
    archive.update({ phase: 'scanning', message: 'Reading the ArtStation catalog...', speed: 0, currentFile: '' });
    await siteWindow.loadURL(LIBRARY_URL);
    const initial = await adapter.sidebar(() => stopImport);
    const groups = prepareCatalogGroups(archive.data, initial.folders);
    await archive.save();
    archive.update({ expectedProducts: initial.folders.find(f => f.name === 'All').count });
    const seen = new Set(), indexedKeys = new Set(), folderKeys = new Map();
    // Only revisit a folder if it contained purchases absent from both All and Hidden Products.
    const fallback = groups.filter(g => g.folder).map(g => ({ ...g, folderOnly: true }));
    let visibleCount = 0, hiddenCount = 0, folderOnlyCount = 0;
    for (const group of [...groups, ...fallback]) {
      if (stopImport) break;
      if (group.folderOnly && !folderKeys.get(group.folder.id)?.some(k => !indexedKeys.has(k))) continue;
      archive.log('info', 'catalog.section-start', { stage: group.name, products: group.expected });
      let scan;
      try {
        scan = await scanCatalogSection(group);
      } catch (error) {
        if (stopImport || (!group.hidden && group.folder === null)) throw error;
        await signedAccount();
        archive.log('warning', 'catalog.section-incomplete', { stage: group.name, error });
        archive.data.incompleteSections.push(group.name);
        continue;
      }
      const signatures = group.folder ? indexFolderCards(archive.data, group.folder, scan.cards) : uniqueCardKeys(scan.cards);
      if (group.folder && !group.folderOnly) {
        folderKeys.set(group.folder.id, signatures);
        await archive.save();
        archive.update({});
        continue;
      }
      if (!group.folder && !group.hidden) {
        visibleCount = scan.cards.length;
        applyPurchaseOrder(archive.data, signatures);
        await archive.save();
        archive.update({});
      }
      if (group.hidden) hiddenCount = scan.cards.length;
      const openCard = recoveringCardReader({
        cards: scan.cards, stopped: () => stopImport, log: (...args) => archive.log(...args),
        open: card => adapter.openCard(card.index, card.title, () => stopImport, card.author),
        reload: async card => {
          archive.update({ phase: 'scanning', message: `Reconnecting to ArtStation to retry ${card.title}…` });
          await siteWindow.loadURL(LIBRARY_URL);
          await adapter.sidebar(() => stopImport);
          await signedAccount();
          return (await scanCatalogSection(group)).cards;
        },
      });
      for (const card of scan.cards) {
        if (stopImport) break;
        const signature = signatures[card.index];
        if (indexedKeys.has(signature)) continue;
        const order = group.folderOnly ? visibleCount + hiddenCount + folderOnlyCount++
          : group.hidden ? visibleCount + card.index : card.index;
        archive.update({ phase: 'metadata', message: `Saving product information: ${card.title}`, currentFile: '' });
        let product;
        try {
          product = await readProduct({ archive, card, session: siteSession, order, hidden: group.folder ? cachedProduct(archive.data, card)?.sourceHidden ?? false : group.hidden,
            read: () => openCard(card), save: saveProduct, stopped: () => stopImport });
        } catch (error) { if (stopImport) break; throw error; }
        indexedKeys.add(signature); seen.add(product.id);
        await adapter.action('close');
      }
      await archive.save();
      archive.update({});
    }
    if (!stopImport) {
      archive.data.discoveryComplete = archive.data.incompleteSections.length === 0;
      for (const p of archive.data.products) {
        if (p.source === 'local') continue;
        if (seen.has(p.id)) p.sourcePresent = true;
        else if (archive.data.discoveryComplete) p.sourcePresent = false;
      }
    }
    await archive.save();
    archive.update({ phase: stopImport ? 'paused' : 'idle', expectedProducts: archive.data.products.filter(p => p.source !== 'local').length,
      message: stopImport ? 'Paused. Saved products are kept.' : 'Catalog saved. Checking and downloading missing files...' });
  } finally { importing = false; }
}

async function resyncProduct(id) {
  const product = archive.data.products.find(p => p.id === id);
  if (!product) throw new Error('Product not found.');
  importing = true; stopImport = false;
  try {
    archive.update({ phase: 'metadata', message: `Re-sync: ${product.title}`, speed: 0, currentFile: '' });
    if (retrySkippedErrors(product)) await archive.persistProduct(product);
    let card = product.sourceCard || { title: product.title, author: product.author, coverUrl: product.coverUrl, avatarUrl: product.avatarUrl };
    const result = await readProduct({ archive, card, order: product.order, hidden: product.sourceHidden ?? product.hidden,
      force: true, stopped: () => stopImport, save: (...args) => saveProduct(...args, true),
      read: async () => {
        if (product.route) return adapter.openRoute(product.route, () => stopImport);
        // An unreadable card has no purchased-product route yet. Locate only
        // this card; no other product metadata or files are re-synchronized.
        await siteWindow.loadURL(LIBRARY_URL);
        await adapter.wait(librarySnapshot, s => s.ready);
        const hidden = product.sourceHidden ?? product.hidden;
        await adapter.action('filter', hidden ? 'Hidden Products' : 'All');
        await pause(900);
        const first = await adapter.library();
        const expected = hidden ? null : first.folders.find(f => f.name === 'All')?.count;
        const scan = await adapter.scan(expected, n => archive.update({ message: `Locating ${product.title}: ${n} products read` }), () => stopImport, hidden);
        const matches = scan.cards.filter(c => cardKey(c) === cardKey(card));
        if (matches.length !== 1) throw new Error('The product could not be uniquely located in the current library.');
        return adapter.openCard(matches[0].index, matches[0].title, () => stopImport, matches[0].author);
      } });
    return result.id;
  } finally { importing = false; }
}

app.whenReady().then(async () => {
  if (!instanceLock) return;
  archive.log('info', 'app.started');
  siteSession = session.fromPartition('persist:artstation-auth');
  siteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  siteSession.setPermissionCheckHandler(() => false);
  protocol.handle('archive', async request => {
    try {
      if (!archive.root) return new Response('', { status: 404 });
      const u = new URL(request.url);
      if (u.hostname !== 'library') return new Response('', { status: 403 });
      const full = inside(archive.root, decodeURIComponent(u.pathname.slice(1)));
      if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(full)) return new Response('', { status: 403 });
      const realRoot = await fs.realpath(archive.root), realFile = await fs.realpath(full);
      inside(realRoot, path.relative(realRoot, realFile));
      return net.fetch(pathToFileURL(realFile).href);
    } catch { return new Response('', { status: 404 }); }
  });
  handle('state', () => archive.state());
  handle('open-logs', async () => {
    // Include errors saved by older versions, even before the user repeats a download.
    for (const product of archive.data.products) {
      if (product.catalogError) archive.log('warning', 'saved.product-error', { product: product.title, message: product.catalogError });
      for (const warning of product.warnings || []) archive.log('warning', 'saved.metadata-warning', { product: product.title, message: warning });
      for (const file of product.files || []) if (file.error) archive.log('error', 'saved.file-error', { product: product.title, file: file.name, message: file.error, state: file.state });
    }
    archive.log('info', 'logs.opened');
    await diagnostics.flush();
    const error = await shell.openPath(diagnostics.directory);
    if (error) throw new Error(error);
  });
  handle('wipe-all-data', async () => {
    resetting = true;
    try {
      const reset = await resetAllData({ archive,
        protectedPaths: protectedArchivePaths(),
        confirm: async root => {
          const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Wipe all data',
            message: 'Permanently delete your local archive and reset the app?',
            detail: `${root ? 'Library: ' + root + '\n\nAll archived product folders and everything inside them, including downloads, will be permanently deleted. The library catalog will also be deleted.' : 'No library is currently selected.'}\n\nSettings and the saved sign-in inside this app will be cleared. Other library locations, unrelated files outside product folders, and your ArtStation account will not be deleted. This cannot be undone.`,
            buttons: ['Cancel', 'Wipe all data'], defaultId: 0, cancelId: 0, noLink: true });
          return result.response === 1;
        },
        stop: async () => {
          synchronizer.pause(); stopImport = true; queue?.stop();
          archive.update({ message: 'Stopping synchronization before wiping data...' });
          const deadline = Date.now() + 120000;
          while (synchronizer.running || importing || queue?.running) {
            if (Date.now() > deadline) throw new Error('Synchronization has not stopped yet. No files were deleted. Wait and try Wipe all data again.');
            await pause(100);
          }
          archive.update({ busy: true, phase: 'resetting', message: 'Wiping local archive and app data...' });
          for (const win of [...windows]) if (win !== mainWindow) win.destroy();
          if (siteWindow && !siteWindow.isDestroyed()) siteWindow.destroy();
          siteWindow = null; adapter = null; queue = null;
        },
        clearSessions: async () => {
          for (const browserSession of [siteSession, session.defaultSession]) {
            await browserSession.closeAllConnections();
            await browserSession.clearData();
            await browserSession.clearAuthCache();
            await browserSession.clearCodeCaches({});
          }
        },
        clearSettings: async () => {
          await diagnostics.clear();
          await fs.rm(path.join(app.getPath('userData'), 'settings.json'), { force: true });
        },
      });
      if (reset) { synchronizer.paused = false; stopImport = false; }
      return reset;
    } catch (error) {
      archive.update({ busy: false, phase: 'error', message: 'Reset did not finish: ' + error.message + ' You can retry Wipe all data.' });
      throw error;
    } finally { resetting = false; }
  });
  handle('choose-location', async () => {
    guardIdle();
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Library location', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return;
    await archive.open(result.filePaths[0]);
    await atomicJson(path.join(app.getPath('userData'), 'settings.json'), { libraryRoot: archive.root });
    synchronizer.start(true);
    return archive.state();
  });
  for (const [name, show] of [['sign-in', true], ['synchronize', false]]) handle(name, () => {
    if (!archive.root) throw new Error('Choose a library location first.');
    synchronizer.start(show);
  });
  handle('pause', () => synchronizer.pause());
  handle('skip-error', async id => {
    const product = findPack(id);
    if (!skipProductErrors(product)) return;
    await archive.persistProduct(product);
    archive.update({ message: `Skipped errors for ${product.title}.` });
  });
  handle('resync-product', id => {
    guardIdle();
    if (!archive.data.products.some(p => p.id === id && p.source !== 'local')) throw new Error('ArtStation product not found.');
    synchronizer.start(false, id);
  });
  handle('open-link', url => shell.openExternal(externalUrl(url)));
  handle('begin-pack', () => { pickedFiles.clear(); });
  handle('pick-pack-files', async cover => {
    const result = await dialog.showOpenDialog(mainWindow, cover
      ? { title: 'Choose cover image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp','gif','avif'] }] }
      : { title: 'Choose pack files', properties: ['openFile', 'multiSelections'] });
    return result.filePaths.map(file => {
      const token = key(file);
      pickedFiles.set(token, file);
      return { token, name: path.basename(file) };
    });
  });
  handle('create-pack', async fields => {
    const selected = token => {
      if (!pickedFiles.has(token)) throw new Error('Choose the files again.');
      return pickedFiles.get(token);
    };
    creatingPack = true;
    try {
      const id = await createLocalPack(archive, fields, fields.files.map(selected), fields.cover ? selected(fields.cover) : null);
      pickedFiles.clear();
      return id;
    } finally { creatingPack = false; }
  });
  function findPack(id) {
    const p = archive.data.products.find(p => p.id === id);
    if (!archive.root || !p) throw new Error('Product not found.');
    return p;
  }
  handle('delete-pack', async id => {
    if (deletingPack || pendingPackDeletionConflicts) throw new Error('Wait for the current library operation to finish.');
    guardIdle('Wait for synchronization to finish before deleting a pack.');
    deletingPack = true;
    try {
      return await deletePack({ archive, id, protectedPaths: protectedArchivePaths(), confirm: async product => {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: 'Delete pack', message: 'Are you sure you want to delete this pack?',
          detail: `“${product.title}” and all files in its pack folder will be permanently deleted from this computer.`,
          buttons: ['Cancel', 'Delete pack'], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1;
      } });
    } finally { deletingPack = false; }
  });
  handle('disk-files', id => diskFiles(archive.root, findPack(id)));
  handle('reveal-disk-file', async (id, relative) => shell.showItemInFolder(await diskFilePath(archive.root, findPack(id), relative)));
  handle('open-pack-directory', async id => {
    const error = await shell.openPath(await packDirectory(archive.root, findPack(id)));
    if (error) throw new Error(error);
  });
  handle('open-file', async (productId, fileId) => {
    const p = archive.data.products.find(p => p.id === productId), f = p?.files.find(f => f.id === fileId);
    if (!f?.relativePath) throw new Error('This file is not on disk yet.');
    const relative = path.relative(inside(archive.root, p.directory), inside(archive.root, f.relativePath));
    shell.showItemInFolder(await diskFilePath(archive.root, p, relative));
  });
  handle('details', id => { if (!archive.data.products.some(p => p.id === id)) throw new Error('Product not found.'); localWindow({ product: id }); });
  handle('organize', async change => {
    if (!archive.root) throw new Error('Choose a library folder first.');
    if (change.type === 'toggle-hidden') {
      const product = archive.data.products.find(p => p.id === change.productId);
      if (!product) throw new Error('Product not found.');
      product.localHidden = !product.hidden; product.hidden = product.localHidden;
    } else changeCollection(archive.data, change);
    await archive.save(); archive.update({});
  });
  mainWindow = localWindow();
  mainWindow.on('close', event => { if (resetting || creatingPack || deletingPack) event.preventDefault(); });
  mainWindow.on('closed', () => app.quit());
  try {
    if (argument('--library')) { await archive.open(path.resolve(argument('--library'))); return; }
    const settings = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (settings.libraryRoot) await archive.open(settings.libraryRoot);
  } catch (error) { if (error.code !== 'ENOENT') archive.update({ message: 'The previous library could not be opened. Choose its folder again.' }); }
});
app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { stopImport = true; queue?.pause(); });
