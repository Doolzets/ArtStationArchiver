const api = window.archiver;
const $ = selector => document.querySelector(selector);
let state, folderId = null, activeProductId = null;
let wiping = false;
let attentionOnly = false;
const detailsId = new URLSearchParams(location.search).get('product');
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function button(text, action, className) { const node = element('button', className, text); node.addEventListener('click', () => invoke(action)); return node; }
function image(relative, alt = '') { const img = element('img'); img.alt = alt; if (relative) img.src = 'archive://library/' + relative.split('/').map(encodeURIComponent).join('/'); img.loading = 'lazy'; return img; }
async function invoke(action) { try { $('#notice').hidden = true; return await action(); } catch (error) { $('#notice').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); $('#notice').hidden = false; } }
function bytes(value) { if (value == null) return 'Unknown'; if (value < 1024) return `${value} B`; const n = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** n).toFixed(1)} ${['B','KB','MB','GB','TB'][n]}`; }
function duration(seconds) { if (seconds == null) return 'Calculating remaining time'; if (seconds < 60) return 'Less than a minute left'; if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min left`; return `About ${(seconds / 3600).toFixed(1)} hours left`; }
function renderProgress(p) {
  const names = { idle: 'Ready', resetting: 'Wiping data', connecting: 'Connecting to ArtStation', scanning: 'Reading library', metadata: 'Saving descriptions and previews', downloading: 'Downloading files', verifying: 'Verifying files', pausing: 'Pausing', paused: 'Paused', complete: 'Archive complete', error: 'Action required' };
  $('#phase').textContent = names[p.phase] || p.phase;
  const discovering = ['scanning', 'metadata'].includes(p.phase);
  if (p.percent == null && discovering) $('#progress').removeAttribute('value'); else $('#progress').value = p.percent || 0;
  $('#percentage').textContent = p.percent == null ? (discovering ? 'Discovering files…' : 'Catalog not fully indexed') : `${p.percent.toFixed(1)}%`;
  const catalogCount = p.phase === 'scanning'
    ? `${p.catalogRead}${p.catalogExpected == null ? '' : ' / ' + p.catalogExpected} products found`
    : `${p.metadataDone} / ${p.totalProducts} products indexed`;
  const segments = [catalogCount, `${p.completedFiles} / ${p.totalFiles} files downloaded`, p.percent == null ? `${p.remainingFiles} known files remaining · total not final` : `${p.remainingFiles} files remaining`];
  if (p.totalBytes != null) segments.push(`${bytes(p.receivedBytes)} / ${bytes(p.totalBytes)}`);
  else if (p.receivedBytes > 0) segments.push(`${bytes(p.receivedBytes)} received · total size unknown`);
  if (p.failedFiles) segments.push(`${p.failedFiles} failed`);
  if (p.skippedProducts) segments.push(`Errors skipped in ${p.skippedProducts} ${p.skippedProducts === 1 ? 'product' : 'products'}`);
  const toggle = $('#attention-filter');
  toggle.hidden = !p.failedProducts;
  toggle.textContent = p.failedProducts === 1 ? '1 product needs attention' : `${p.failedProducts} products need attention`;
  toggle.setAttribute('aria-pressed', String(attentionOnly));
  if (p.phase === 'downloading') segments.push(`${bytes(Math.round(p.speed))}/s`, duration(p.eta));
  $('#counts').replaceChildren(...segments.map(s => element('span', '', s)));
  $('#current').textContent = [p.message, p.currentFile].filter(Boolean).join(' — ');
  const busy = p.busy;
  $('#pause-button').disabled = !busy || ['paused', 'pausing'].includes(p.phase);
  $('#sync-button').disabled = !state.root || (busy && p.phase !== 'paused');
  $('#sync-button').textContent = p.phase === 'paused' ? 'Resume synchronization' : 'Synchronize library';
  $('#signin-button').disabled = busy || !state.root;
  $('#signin-button').hidden = p.signedIn;
  $('#change-location').disabled = busy;
  $('#settings-path').textContent = state.root || 'No location selected';
  for (const node of document.querySelectorAll('.resync-product')) node.disabled = busy;
}
const updateSidebar = createFolderSidebar($('#folders'), {
  select: id => { folderId = id; renderLibrary(); },
  organize: change => api.organize(change),
  confirmDelete: name => window.confirm(`Delete “${name}” from this library? Its products and files will stay in your archive.`),
  reportError: error => { $('#notice').textContent = error.message; $('#notice').hidden = false; },
});
let draggingProduct = false;
function renderFolders() {
  const all = [{ id: null, name: 'All', productIds: state.library.products }, ...state.library.folders];
  updateSidebar(all.map(folder => {
    const count = folder.membersPending ? folder.sourceCount : folder.productIds.length;
    const label = count == null ? [] : [`${count} Products`];
    if (folder.membersPending) label.push('Awaiting index');
    return { id: folder.id, name: folder.name, label: label.join(' · '), editable: !!folder.id };
  }), folderId);
}
function renderLibrary() {
  renderFolders();
  $('#library-path').textContent = state.root || 'No library selected';
  const selectedFolder = state.library.folders.find(f => f.id === folderId);
  $('#folder-title span').textContent = selectedFolder?.name || 'All';
  const selectedSeller = $('#seller').value;
  const sellers = [...new Set(state.library.products.map(p => p.author).filter(Boolean))].sort();
  $('#seller').replaceChildren(...['', ...sellers].map(name => { const o = element('option', '', name || 'All Sellers'); o.value = name; return o; }));
  $('#seller').value = selectedSeller;
  const query = $('#search').value.toLowerCase(), hidden = $('#visibility').value === 'hidden';
  const positions = selectedFolder && new Map(selectedFolder.productIds.map((id, index) => [id, index]));
  const attentionIds = attentionOnly && new Set(state.progress.failedProductIds);
  const products = state.library.products.filter(p => (!attentionIds || attentionIds.has(p.id)) && !!p.hidden === hidden && (!positions || positions.has(p.id)) &&
    (!selectedSeller || p.author === selectedSeller) && `${p.title} ${p.author}`.toLowerCase().includes(query))
    .sort((a,b) => {
      if (positions) return positions.get(a.id) - positions.get(b.id);
      const aLocal = a.source === 'local', bLocal = b.source === 'local';
      if (aLocal !== bLocal) return aLocal ? -1 : 1;
      return aLocal ? b.createdAt - a.createdAt : a.order - b.order;
    });
  $('#product-count').textContent = `${products.length} Products`;
  $('#empty').hidden = folderId !== null || state.library.products.length > 0;
  if (draggingProduct) return;
  $('#grid').replaceChildren(...products.map(p => {
    const card = element('article', 'card'); card.draggable = true;
    card.addEventListener('dragstart', event => {
      draggingProduct = true;
      event.dataTransfer.setData(productDragType, p.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => { draggingProduct = false; renderLibrary(); });
    const thumb = button('', () => openProduct(p.id), 'thumbnail'); thumb.setAttribute('aria-label', `View ${p.title}`);
    if (p.cover) thumb.append(image(p.cover, p.title));
    const hover = element('span'); hover.append(element('b', '', 'View')); thumb.append(hover);
    const author = button(`by ${p.author || 'Unknown author'}`, () => p.authorUrl && api.openLink(p.authorUrl), 'author');
    if (p.avatar) author.prepend(image(p.avatar));
    const done = (p.files || []).filter(f => f.state === 'complete').length;
    const preview = element('div', 'card-preview');
    preview.append(thumb);
    if (selectedFolder) {
      const remove = button('', () => api.organize({
        type: 'remove-from-folder', folderId: selectedFolder.id, productId: p.id
      }), 'remove-from-collection');
      remove.title = `Remove from ${selectedFolder.name}`;
      remove.setAttribute('aria-label', `Remove ${p.title} from ${selectedFolder.name}`);
      remove.append($('#remove-pack-icon').content.cloneNode(true));
      preview.append(remove);
    }
    card.append(preview, element('h3', '', p.title));
    if (p.source === 'local') {
      if (p.author) card.append(element('div', 'author', p.author));
    } else card.append(author, element('div', 'card-status', `${done} / ${p.files?.length || 0} files saved${p.metadataState === 'skipped' ? ' · Error skipped' : p.catalogError ? ' · Re-sync needed' : p.metadataState === 'error' ? ' · Preview incomplete' : ''}`));
    for (const img of card.querySelectorAll('img')) img.draggable = false;
    return card;
  }));
  if (attentionOnly && !products.length) $('#grid').append(element('p', 'muted', 'No products needing attention in this view.'));
}
function openProduct(id, refresh = false) {
  const p = state.library.products.find(p => p.id === id);
  if (!p) {
    activeProductId = null;
    $('#product-modal').close();
    return;
  }
  activeProductId = id;
  const head = element('section', 'modal-head');
  const info = element('div'); info.append(element('h2', '', p.title));
  if (p.rating) info.append(element('span', 'rating', p.rating));
  const local = p.source === 'local';
  if (local && p.author) info.append(element('div', '', p.author));
  if (!local) info.append(element('div', '', 'by '), button(p.author, () => api.openLink(p.authorUrl), 'author-link'), element('p', '', p.license || 'Purchased license'));
  const actions = element('div', 'actions');
  const message = button('➤ Message', () => api.openLink(p.authorUrl), 'message'); message.disabled = !p.authorUrl;
  const invoice = button('▤ View Invoice', () => api.openLink(p.invoiceUrl)); invoice.disabled = !p.invoiceUrl;
  if (!local) actions.append(message);
  actions.append(button('◉ View Details', () => api.details(p.id)));
  if (!local) actions.append(invoice);
  const resync = button('Re-sync', () => api.resyncProduct(p.id), 'resync-product');
  resync.disabled = state.progress.busy;
  if (!local) actions.append(resync);
  actions.append(button('Open pack folder', () => api.openPackDirectory(p.id)));
  if (state.progress.failedProductIds.includes(p.id)) actions.append(button('Skip error', () => api.skipError(p.id)));
  info.append(actions);
  if (p.cover) head.append(image(p.cover, p.title));
  else head.classList.add('without-cover');
  head.append(info, button('×', () => $('#product-modal').close(), 'close'));
  const body = element('section', 'modal-body');
  if (!local || p.release?.name) body.append(element('div', '', `Release: ${p.release?.name || 'Unknown'}`));
  if (p.detailsState === 'unavailable') body.append(element('p', 'muted', 'Product page is unavailable'));
  if (p.releaseNotes) body.append(element('h3', '', 'Release Notes'), element('div', 'release-notes', p.releaseNotes));
  if (p.metadataState === 'skipped') body.append(element('p', 'muted', 'Product information error skipped. Use Re-sync to retry.'));
  else {
    for (const warning of p.warnings || []) body.append(element('p', 'file-error', warning));
    if (p.catalogError) body.append(element('p', 'file-error', p.catalogError));
  }
  const heading = element('h3', '', 'Files'); heading.id = 'files-heading'; body.append(heading);
  for (const f of p.files || []) {
    const row = element('div', 'file-row'), name = element('div', 'name', f.name);
    const skipped = f.state === 'skipped';
    name.append(element('div', '', ''), element('small', f.error && !skipped ? 'file-error' : '', skipped ? 'Error skipped · Use Re-sync to retry' : f.error || f.meta));
    const open = button('↗ Open folder', () => api.openFile(p.id, f.id));
    open.dataset.archiveFile = f.id; open.disabled = true;
    row.append(name, open); body.append(row);
  }
  const extra = element('div'); extra.id = 'disk-files'; body.append(extra);
  const footer = element('footer', 'pack-footer');
  const status = element('p', 'file-error'); status.setAttribute('role', 'alert'); status.hidden = true;
  const remove = button('Delete pack', async () => {
    remove.disabled = true;
    status.hidden = true;
    try { await api.deletePack(p.id); }
    catch (error) {
      status.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
      status.hidden = false;
    } finally { remove.disabled = false; }
  }, 'delete-pack');
  remove.prepend($('#remove-pack-icon').content.cloneNode(true));
  footer.append(button(p.hidden ? 'Restore to library' : 'Hide product', () => api.organize({ type: 'toggle-hidden', productId: p.id })), remove);
  body.append(footer, status);
  $('#product-content').replaceChildren(head, body);
  if (!refresh && !$('#product-modal').open) $('#product-modal').showModal();
  if (diskView?.id === id && refresh) renderDiskFiles(diskView);
  else startDiskView(id);
}
let diskView;
function renderDiskFiles(view) {
  const container = $('#disk-files');
  if (!container) return;
  const product = state.library.products.find(p => p.id === view.id);
  const available = new Set(view.available);
  for (const btn of $('#product-content').querySelectorAll('[data-archive-file]')) btn.disabled = !available.has(btn.dataset.archiveFile);
  $('#files-heading').textContent = `Files (${(product?.files?.length || 0) + view.files.length})`;
  container.replaceChildren(...view.files.map(relative => {
    const row = element('div', 'file-row');
    const parts = relative.split('/');
    const name = element('div', 'name', parts.pop());
    if (parts.length) name.append(element('div', '', ''), element('small', '', parts.join('/')));
    row.append(name, button('↗ Open folder', () => api.revealDiskFile(view.id, relative)));
    return row;
  }));
  if (view.error) container.append(element('p', 'file-error', view.error));
}
function stopDiskView() { clearTimeout(diskView?.timer); diskView = null; }
function startDiskView(id) {
  stopDiskView();
  const view = { id, files: [], available: [], error: '', signature: null };
  diskView = view;
  async function read() {
    let files = [], available = [], error = '';
    try { ({ files, available } = await api.diskFiles(id)); } catch (e) { error = e.message; }
    if (diskView !== view || !$('#product-modal').open) return;
    const signature = JSON.stringify([files, available, error]);
    if (signature !== view.signature) {
      Object.assign(view, { files, available, error, signature });
      renderDiskFiles(view);
    }
    view.timer = setTimeout(read, 3000);
  }
  read();
}
$('#product-modal').addEventListener('close', stopDiskView);
function renderDetails() {
  let page = $('#details-page');
  if (!page) {
    $('.layout').hidden = true; $('.toolbar').hidden = true; $('#progress-panel').hidden = true;
    page = element('main', 'details-page'); page.id = 'details-page'; document.body.append(page);
  }
  const p = state.library.products.find(p => p.id === detailsId);
  if (!p) { page.textContent = 'Product not found in this library.'; return; }
  document.title = p.title + ' — ArtStation Archiver';
  const byline = element('div', 'details-byline');
  if (p.author) byline.append(p.authorUrl ? button(`by ${p.author}`, () => api.openLink(p.authorUrl), 'author-link') : element('span', '', p.author));
  if (p.rating) byline.append(element('span', 'rating', p.rating));
  page.replaceChildren(element('h1', '', p.title), byline);
  const layout = element('div', 'details-layout'), gallery = element('section');
  const images = p.galleryLocal?.length ? p.galleryLocal : [p.cover].filter(Boolean);
  const hero = image(images[0], p.title); hero.className = 'hero-image'; if (images.length) gallery.append(hero);
  const thumbs = element('div', 'thumbs');
  for (const relative of images) { const thumb = button('', () => { hero.src = image(relative).src; }); thumb.append(image(relative, 'View image')); thumbs.append(thumb); }
  gallery.append(thumbs);
  const videos = element('div', 'video-links');
  for (const [i, url] of (p.videos || []).entries()) videos.append(button(`▶ Watch video ${i + 1}`, () => api.openLink(url)));
  gallery.append(videos);
  const description = element('section');
  const unavailable = p.detailsState === 'unavailable';
  const rich = unavailable ? null : window.archiverRichText.renderRichText(document, p.descriptionRich, url => invoke(() => api.openLink(url)));
  const body = element('div', rich ? 'description rich-description' : 'description');
  if (rich) body.append(rich);
  else body.textContent = unavailable ? 'Product page is unavailable' : p.description || (p.source === 'local' ? 'No description added.' : 'Description has not been saved yet. Synchronize the library to retry.');
  description.append(element('h2', '', 'Description'), body);
  if (!rich && !unavailable) for (const link of p.descriptionLinks || []) description.append(button(link.text || 'Related link', () => api.openLink(link.url), 'author-link'), element('br'));
  if (p.releaseNotes) description.append(element('h2', '', 'Release Notes'), element('div', 'description', p.releaseNotes));
  layout.append(gallery, description); page.append(layout);
}
let lastCatalogSignature = '';
function render(next) {
  const activeSource = state?.library.products.find(p => p.id === activeProductId)?.sourceKey;
  if (next.root !== state?.root || !next.progress.failedProducts) attentionOnly = false;
  state = next;
  if (folderId && !state.library.folders.some(f => f.id === folderId)) folderId = null;
  if (activeSource && !state.library.products.some(p => p.id === activeProductId)) activeProductId = state.library.products.find(p => p.sourceKey === activeSource)?.id || activeProductId;
  if (detailsId) return renderDetails();
  $('#setup').hidden = !!state.root;
  $('.layout').hidden = !state.root;
  $('#progress-panel').hidden = !state.root;
  renderProgress(next.progress);
  // Keep typing/scroll position steady while only download bytes change.
  const signature = JSON.stringify([next.root, next.library.folders, next.library.products.map(p => [p.id,p.title,p.order,p.hidden,p.metadataState,p.catalogError,p.detailsState,p.lastIndexedAt,p.cover,p.files?.map(f => [f.state, f.error])])]);
  if (signature !== lastCatalogSignature) { lastCatalogSignature = signature; renderLibrary(); if ($('#product-modal').open) openProduct(activeProductId, true); }
}
for (const id of ['#location-button', '#change-location']) $(id).addEventListener('click', () => invoke(async () => {
  $('#settings-modal').close();
  await api.chooseLocation();
}));
$('#settings-button').addEventListener('click', () => $('#settings-modal').showModal());
const packForm = $('#pack-form'), packModal = $('#pack-modal');
let selectedFiles = new Map(), selectedCover = null, savingPack = false;
function showPickedFiles() {
  const rows = [...selectedFiles.values()].map(f => ({ file: f, cover: false }));
  if (selectedCover) rows.unshift({ file: selectedCover, cover: true });
  $('#picked-list').replaceChildren(...rows.map(({file, cover}) => {
    const li = element('li', '', (cover ? 'Cover · ' : '') + file.name);
    const remove = button('Remove', () => {
      if (cover) selectedCover = null; else selectedFiles.delete(file.token);
      showPickedFiles();
    });
    remove.type = 'button'; li.append(remove); return li;
  }));
}
$('#add-pack').addEventListener('click', () => invoke(async () => {
  await api.beginPack(); packForm.reset(); selectedFiles.clear(); selectedCover = null; showPickedFiles();
  $('#pack-status').textContent = '';
  const collections = $('#pack-collections');
  collections.replaceChildren(element('legend', '', 'Collections'));
  for (const folder of state.library.folders) {
    const input = element('input'); input.type = 'checkbox'; input.name = 'collections'; input.value = folder.id;
    const label = element('label'); label.append(input, document.createTextNode(folder.name)); collections.append(label);
  }
  collections.hidden = !state.library.folders.length;
  packModal.showModal(); packForm.elements.title.focus();
}));
for (const [selector, cover] of [['#pick-files', false], ['#pick-cover', true]]) {
  $(selector).addEventListener('click', async () => {
    try {
      const picked = await api.pickPackFiles(cover);
      if (cover && picked.length) selectedCover = picked[0];
      if (!cover) for (const f of picked) selectedFiles.set(f.token, f);
      showPickedFiles();
    } catch (e) { $('#pack-status').textContent = e.message; }
  });
}
$('#cancel-pack').addEventListener('click', () => packModal.close());
packModal.addEventListener('cancel', e => { if (savingPack) e.preventDefault(); });
packForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (savingPack) return;
  const data = new FormData(packForm);
  const fields = { ...Object.fromEntries(data), collections: data.getAll('collections'), files: [...selectedFiles.keys()], cover: selectedCover?.token };
  savingPack = true;
  for (const control of packForm.elements) control.disabled = true;
  $('#pack-status').textContent = 'Saving pack…';
  try {
    const id = await api.createPack(fields);
    folderId = null; $('#search').value = ''; $('#seller').value = ''; $('#visibility').value = 'visible';
    state = await api.state(); renderLibrary(); packModal.close(); openProduct(id);
  } catch (error) { $('#pack-status').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally {
    savingPack = false;
    for (const control of packForm.elements) control.disabled = false;
  }
});
$('#open-logs').addEventListener('click', async () => {
  $('#log-status').textContent = '';
  try { await api.openLogs(); $('#log-status').textContent = 'Log folder opened. The latest log is diagnostics.log.'; }
  catch (error) { $('#log-status').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
});
$('#settings-modal').addEventListener('cancel', event => { if (wiping) event.preventDefault(); });
$('#wipe-all-data').addEventListener('click', async () => {
  if (wiping) return;
  wiping = true;
  $('#wipe-all-data').disabled = true; $('#settings-close').disabled = true;
  $('#wipe-status').textContent = 'Waiting for confirmation. After confirmation, active downloads will stop and data will be deleted.';
  try {
    if (await api.wipeAllData()) {
      folderId = null; activeProductId = null; lastCatalogSignature = '';
      $('#search').value = ''; $('#visibility').value = 'visible'; $('#seller').value = '';
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      render(await api.state());
    }
    $('#wipe-status').textContent = '';
  } catch (error) {
    $('#wipe-status').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') + ' Reset was not completed.';
  } finally {
    wiping = false; $('#wipe-all-data').disabled = false; $('#settings-close').disabled = false;
  }
});
$('#signin-button').addEventListener('click', () => invoke(() => api.signIn()));
$('#sync-button').addEventListener('click', () => invoke(() => api.synchronize()));
$('#pause-button').addEventListener('click', () => invoke(() => api.pause()));
for (const selector of ['#search','#visibility','#seller']) $(selector).addEventListener('input', renderLibrary);
$('#clear-search').addEventListener('click', () => {
  const search = $('#search');
  search.value = '';
  search.focus();
  renderLibrary();
});
$('#attention-filter').addEventListener('click', () => {
  attentionOnly = !attentionOnly;
  $('#attention-filter').setAttribute('aria-pressed', String(attentionOnly));
  renderLibrary();
});
$('#new-folder').addEventListener('click', () => { $('#folder-name').value = ''; $('#folder-modal').showModal(); });
$('#folder-modal').addEventListener('close', () => { if ($('#folder-modal').returnValue === 'create') invoke(() => api.organize({ type: 'create-folder', name: $('#folder-name').value })); });
$('#product-modal').addEventListener('click', event => { if (event.target === $('#product-modal')) $('#product-modal').close(); });
api.onState(render); invoke(async () => render(await api.state()));
