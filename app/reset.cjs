const fs = require('node:fs/promises');
const path = require('node:path');
const { inside, safeName, newLibrary } = require('./core.cjs');
const { unresolvedDirectory } = require('./catalog.cjs');

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
async function statOrMissing(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkedTarget(root, relative, action = 'Wipe') {
  const full = inside(root, relative);
  let current = root;
  for (const part of path.relative(root, full).split(path.sep)) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`${action} refused: an archive path is a symbolic link or junction.`);
    if (!contains(root, await fs.realpath(current))) throw new Error(`${action} refused: a path leaves the library.`);
  }
  return full;
}
async function checkedProductTarget(root, product, action = 'Wipe') {
  const parts = String(product.directory || '').split(/[\\/]/);
  const name = parts.at(-1);
  const knownLayout = parts.length === 1 || (parts.length === 2 && parts[0] === 'products');
  const current = product.id && name.endsWith('--' + safeName(product.id, 35));
  const recovered = product.sourceCard?.title && name === unresolvedDirectory(product.sourceCard);
  if (!knownLayout || !product.id || (!current && !recovered)) {
    throw new Error(`${action} refused: unrecognized directory for product ${product.title || product.id || '(unknown)'}.`);
  }
  const full = await checkedTarget(root, product.directory, action);
  if (!current && await statOrMissing(full)) {
    // A successful retry keeps the original directory but writes the permanent ID to product.json.
    const marker = await checkedTarget(root, path.join(product.directory, 'product.json'), action);
    let saved;
    if ((await statOrMissing(marker))?.isFile()) {
      try { saved = JSON.parse(await fs.readFile(marker, 'utf8')); }
      catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    }
    if (saved?.id !== product.id || saved.directory !== product.directory) {
      throw new Error(`${action} refused: product.json does not confirm the directory for ${product.title || product.id}.`);
    }
  }
  return full;
}
async function checkedLibraryRoot(directory, protectedPaths, action) {
  const root = await fs.realpath(directory);
  if (root === path.parse(root).root) throw new Error(`${action} refused: the library cannot be a drive root.`);
  for (const protectedPath of protectedPaths.filter(Boolean)) {
    let real = path.resolve(protectedPath);
    try { real = await fs.realpath(real); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contains(root, real)) throw new Error(`${action} refused: the library contains a protected application or system folder.`);
  }
  return root;
}
async function planLibraryWipe(archive, protectedPaths = []) {
  if (!archive.root) return null;
  const root = await checkedLibraryRoot(archive.root, protectedPaths, 'Wipe');
  await checkedTarget(root, 'library.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'library.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A prior reset may have removed the archive but failed while clearing settings.
    for (const product of archive.data.products) {
      if (await statOrMissing(await checkedTarget(root, product.directory))) throw new Error('Wipe refused: library.json is missing while product data still exists.');
    }
    return { root, products: [] };
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.products)) throw new Error('Wipe refused: invalid library manifest.');
  const products = [];
  for (const product of archive.data.products) {
    if (!manifest.products.some(p => p.id === product.id && p.directory === product.directory)) throw new Error('Wipe refused: the library changed on disk.');
    await checkedProductTarget(root, product);
    products.push({ id: product.id, title: product.title, directory: product.directory, sourceCard: product.sourceCard });
  }
  return { root, products };
}
async function wipeLibrary(plan) {
  if (!plan) return;
  // Validate every target before deleting anything, then check again at each removal.
  if (await fs.realpath(plan.root) !== plan.root) throw new Error('Wipe refused: the library location changed.');
  await checkedTarget(plan.root, 'library.json');
  for (const product of plan.products) await checkedProductTarget(plan.root, product);
  for (const product of plan.products) {
    const target = await checkedProductTarget(plan.root, product);
    // Node removes nested links themselves, without traversing their destinations.
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
  await fs.rm(await checkedTarget(plan.root, 'library.json'), { force: true });
  // The legacy container may contain unrelated data; remove it only when empty.
  if (plan.products.some(p => /^products[\\/]/.test(p.directory))) {
    try { await fs.rmdir(await checkedTarget(plan.root, 'products')); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}
async function resetAllData({ archive, confirm, stop, clearSessions, clearSettings, protectedPaths }) {
  if (!await confirm(archive.root)) return false;
  await stop();
  await archive.saving;
  const plan = await planLibraryWipe(archive, protectedPaths);
  await clearSessions();
  await wipeLibrary(plan);
  await clearSettings();
  archive.root = null; archive.data = newLibrary(); archive.activity = {};
  archive.update({ phase: 'idle', message: 'All app data has been wiped. Choose a library location to start again.' });
  return true;
}

async function deletePack({ archive, id, confirm, protectedPaths = [] }) {
  const { products, folders } = archive.data;
  const product = products.find(p => p.id === id);
  if (!archive.root || !product) throw new Error('Pack not found.');
  const action = 'Delete pack';
  const root = await checkedLibraryRoot(archive.root, protectedPaths, action);
  if (!await confirm(product)) return false;
  await archive.saving.catch(() => {});
  if (await fs.realpath(archive.root) !== root) throw new Error('Delete pack refused: the library location changed.');
  const manifestPath = await checkedTarget(root, 'library.json', action);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.products) ||
      !manifest.products.some(p => p.id === id && p.directory === product.directory)) {
    throw new Error('Delete pack refused: the library changed on disk.');
  }
  const target = await checkedProductTarget(root, product, action);
  if ([...manifest.products, ...products].some(p => p.id !== id && typeof p.directory === 'string' &&
      contains(target, path.resolve(root, p.directory)))) {
    throw new Error('Delete pack refused: another pack uses this directory.');
  }
  const stat = await statOrMissing(target);
  if (stat && !stat.isDirectory()) throw new Error('Delete pack refused: the pack path is not a directory.');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });

  archive.data.products = products.filter(p => p.id !== id);
  archive.data.folders = folders.map(folder => {
    const updated = { ...folder };
    for (const field of ['productIds', 'sourceMembers', 'excludedProductIds']) {
      if (folder[field]?.includes(id)) updated[field] = folder[field].filter(member => member !== id);
    }
    return updated;
  });
  try { await archive.save(); }
  catch (error) {
    archive.data.products = products;
    archive.data.folders = folders;
    throw new Error('The pack folder was deleted, but the catalog could not be saved. Try Delete pack again.', { cause: error });
  }
  archive.update({ expectedProducts: undefined, message: `Deleted ${product.title || 'pack'}.` });
  return true;
}

module.exports = { planLibraryWipe, wipeLibrary, resetAllData, deletePack };
