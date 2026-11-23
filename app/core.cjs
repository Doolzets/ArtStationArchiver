const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');

function safeName(input, max = 90) {
  let name = String(input).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, max).replace(/[. ]+$/g, '');
  if (!name) name = 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function key(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 16); }
function assignDownloadPaths(product) {
  const normalize = value => value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
  const used = new Set();
  const reserve = value => { used.add(normalize(value)); used.add(normalize(value + '.part')); };
  for (const file of [...product.files, ...(product.previousReleases || []).flatMap(release => release.files || [])]) {
    if (file.relativePath) reserve(file.relativePath);
  }
  const directory = `${product.directory}/files/`;
  for (const file of product.files) {
    // Existing paths are part of the saved download record, including partial files.
    if (file.relativePath) continue;
    const extension = String(file.meta || '').split('/')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const base = safeName(file.name, 85);
    const name = base + (extension && !base.toLowerCase().endsWith('.' + extension) ? '.' + extension : '');
    const ext = path.posix.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = directory + name, number = 2;
    while (used.has(normalize(candidate)) || used.has(normalize(candidate + '.part'))) {
      candidate = `${directory}${stem} (${number++})${ext}`;
    }
    file.relativePath = candidate; reserve(candidate);
  }
}
function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Invalid archive path.');
  const full = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path leaves the library.');
  return full;
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
function newLibrary() { return { schemaVersion: 1, account: null, products: [], folders: [], discoveryComplete: false, updatedAt: null }; }
function recover(library) {
  if (library.schemaVersion !== 1 || !Array.isArray(library.products) || !Array.isArray(library.folders)) throw new Error('Unsupported or damaged library manifest.');
  for (const p of library.products) for (const f of p.files || []) {
    if (['downloading', 'paused', 'verifying'].includes(f.state)) { f.state = 'pending'; f.received = 0; }
  }
  return library;
}
function needsAttention(p) {
  return p.source !== 'local' && ((p.metadataState !== 'skipped' && (p.catalogError || p.metadataState === 'error')) ||
    p.files?.some(f => f.state === 'error'));
}
function skipProductErrors(p) {
  if (!needsAttention(p)) return false;
  if (p.catalogError || p.metadataState === 'error') p.metadataState = 'skipped';
  for (const file of p.files || []) if (file.state === 'error') file.state = 'skipped';
  return true;
}
function retrySkippedErrors(p) {
  let changed = false;
  if (p.metadataState === 'skipped') { p.metadataState = 'error'; changed = true; }
  for (const file of p.files || []) {
    if (file.state === 'skipped') { file.state = 'error'; changed = true; }
  }
  return changed;
}
function progress(library, activity = {}) {
  library = { ...library, products: library.products.filter(p => p.source !== 'local') };
  const files = library.products.flatMap(p => p.files || []);
  const completed = files.filter(f => f.state === 'complete').length;
  const failed = files.filter(f => f.state === 'error').length;
  const skippedFiles = files.filter(f => f.state === 'skipped').length;
  const skippedProducts = library.products.filter(p => p.metadataState === 'skipped' || p.files?.some(f => f.state === 'skipped')).length;
  const known = files.every(f => Number.isFinite(f.total) && f.total > 0);
  const totalBytes = files.reduce((n, f) => n + (f.total || 0), 0);
  const receivedBytes = files.reduce((n, f) => n + (f.state === 'complete' ? (f.total || f.received || 0) : Math.min(f.received || 0, f.total || Infinity)), 0);
  const failedProductIds = library.products.filter(needsAttention).map(p => p.id);
  const metadataDone = library.products.filter(p => p.metadataState === 'complete' && !p.catalogError).length;
  const readyProducts = library.products.filter(p => p.metadataState === 'complete' && !p.catalogError && p.files?.every(f => f.state === 'complete')).length;
  const bytesKnown = known && files.length > 0 && library.discoveryComplete;
  const ratio = bytesKnown ? receivedBytes / totalBytes : (files.length ? completed / files.length : 0);
  // 100% means verified completion, never merely "all bytes received".
  const allComplete = library.discoveryComplete && files.length > 0 && completed === files.length && metadataDone === library.products.length;
  return {
    phase: activity.phase || 'idle', message: activity.message || '',
    busy: !!activity.busy, signedIn: !!activity.signedIn,
    totalProducts: activity.expectedProducts ?? library.products.length,
    discoveredProducts: library.products.length, metadataDone, readyProducts, failedProducts: failedProductIds.length, failedProductIds,
    catalogRead: activity.catalogRead ?? 0, catalogExpected: activity.catalogExpected ?? null,
    totalFiles: files.length, completedFiles: completed, failedFiles: failed,
    remainingFiles: files.length - completed - skippedFiles, skippedFiles, skippedProducts, receivedBytes, totalBytes: bytesKnown ? totalBytes : null,
    percent: library.discoveryComplete ? (allComplete ? 100 : Math.min(99.9, Math.max(0, ratio * 100))) : null,
    speed: activity.speed || 0,
    eta: bytesKnown && activity.speed > 0 && activity.phase === 'downloading' ? Math.max(0, (totalBytes - receivedBytes) / activity.speed) : null,
    currentFile: activity.currentFile || '', complete: allComplete,
  };
}
function externalUrl(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Only HTTP and HTTPS web links are supported.');
  return u.href;
}
module.exports = { safeName, key, inside, atomicJson, newLibrary, recover, progress, externalUrl, assignDownloadPaths, skipProductErrors, retrySkippedErrors };
