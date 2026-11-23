const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { key, inside, atomicJson, newLibrary, recover, progress, assignDownloadPaths } = require('./core.cjs');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function imageType(header) {
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a/.test(header.toString('ascii', 0, 6))) return 'gif';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (header.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(header.toString('ascii', 8))) return 'avif';
  return null;
}
class Archive {
  constructor(publish, diagnostics = null) { this.publish = publish; this.diagnostics = diagnostics; this.root = null; this.data = newLibrary(); this.activity = {}; this.saving = Promise.resolve(); }
  log(level, event, fields) { this.diagnostics?.write(level, event, fields); }
  async open(root) {
    await this.saving;
    const file = path.join(root, 'library.json');
    let data;
    try { data = recover(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = newLibrary(); }
    this.root = root; this.data = data;
    await this.save(); this.update({ phase: 'idle', message: 'Library ready.' });
  }
  save() {
    if (!this.root) return Promise.resolve();
    this.data.updatedAt = new Date().toISOString();
    const file = path.join(this.root, 'library.json'), snapshot = structuredClone(this.data);
    this.saving = this.saving.catch(() => {}).then(() => atomicJson(file, snapshot));
    return this.saving;
  }
  state() { return { root: this.root, library: this.data, progress: progress(this.data, this.activity) }; }
  update(activity) { this.activity = { ...this.activity, ...activity }; this.publish(this.state()); }
  async persistProduct(p) { await atomicJson(inside(this.root, p.directory + '/product.json'), p); await this.save(); }
  async validFile(f, { deep = true } = {}) {
    if (!f.relativePath || !f.sha256) return false;
    try {
      const full = inside(this.root, f.relativePath), stat = await fs.stat(full);
      if (!stat.isFile() || stat.size !== f.received) return false;
      if (!deep && f.verifiedMtimeMs === stat.mtimeMs && f.verifiedSize === stat.size) return true;
      if (await digest(full) !== f.sha256) return false;
      f.verifiedMtimeMs = stat.mtimeMs; f.verifiedSize = stat.size;
      f.verifiedAt = new Date().toISOString();
      return true;
    } catch { return false; }
  }
  async metadataPresent(product) {
    if (product.metadataState !== 'complete' || product.catalogError || !product.route || !product.release) return false;
    const media = [product.cover, product.avatar, ...(product.galleryLocal || [])].filter(Boolean);
    for (const relative of media) {
      try { const stat = await fs.stat(inside(this.root, relative)); if (!stat.isFile() || !stat.size) return false; }
      catch { return false; }
    }
    return true;
  }
  async media(url, relative, session) {
    if (!url) return null;
    const u = new URL(url);
    // ArtStation media only: no arbitrary local/network URLs from page content.
    if (u.protocol !== 'https:' || !(u.hostname === 'artstation.com' || u.hostname.endsWith('.artstation.com'))) throw new Error(`Unsupported media host (${u.hostname || 'no hostname'}).`);
    const ext = /\.(png|jpe?g|webp|gif|avif)$/i.exec(u.pathname)?.[1]?.toLowerCase() || 'jpg';
    const rel = `${relative}/${key(url)}.${ext}`, full = inside(this.root, rel);
    try { if ((await fs.stat(full)).size > 0) return rel; } catch {}
    const response = await session.fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Preview image is unavailable (HTTP ${response.status}).`);
    // The CDN also serves JPEGs as binary/octet-stream. Validate file bytes,
    // not just Content-Type, so an HTML error page cannot become a preview.
    await fs.mkdir(path.dirname(full), { recursive: true });
    const partial = full + '.part';
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const handle = await fs.open(partial, 'r');
      const header = Buffer.alloc(64);
      let bytesRead;
      try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)); } finally { await handle.close(); }
      if (!imageType(header.subarray(0, bytesRead))) throw new Error('The server returned an unsupported preview instead of an image.');
      await fs.rename(partial, full); return rel;
    } finally { await fs.rm(partial, { force: true }).catch(() => {}); }
  }
}

class DownloadQueue {
  constructor(archive, adapter, session, { productIds = null, deep = false } = {}) {
    this.archive = archive; this.adapter = adapter; this.session = session; this.productIds = productIds; this.deep = deep;
    this.running = false; this.paused = false; this.item = null;
  }
  pause() { this.paused = true; this.item?.pause(); this.archive.update({ phase: 'paused', message: 'Paused. Synchronize library to continue.', speed: 0 }); }
  stop() { this.paused = true; this.cancelled = true; this.item?.cancel(); }
  async start() {
    if (this.running) { this.paused = false; this.item?.resume(); return; }
    if (!this.archive.root) throw new Error('Choose a library folder first.');
    this.running = true; this.paused = false;
    const products = this.archive.data.products.filter(p => p.source !== 'local' && (!this.productIds || this.productIds.includes(p.id)));
    try {
      // Detect externally removed/changed files before skipping them.
      this.archive.update({ phase: 'verifying', message: this.deep ? 'Re-sync: verifying product file contents...' : 'Checking the saved file records...', speed: 0 });
      for (const p of products) {
        for (const f of p.files || []) {
          if (this.paused) break;
          if (f.state === 'complete' && !await this.archive.validFile(f, { deep: this.deep })) { f.state = 'pending'; }
        }
        await this.archive.persistProduct(p);
        if (this.paused) break;
      }
      await this.archive.save();
      for (const p of products) {
        if (this.paused) break;
        if (p.catalogError) { this.archive.log('warning', 'product.skipped', { product: p.title, productId: p.id, stage: 'catalog', message: p.catalogError }); continue; }
        const needsDownload = f => f.state !== 'complete' && f.state !== 'skipped';
        const waiting = (p.files || []).filter(needsDownload);
        if (!waiting.length) continue;
        try {
          this.archive.log('info', 'product.download-check', { product: p.title, productId: p.id, release: p.release?.name, files: waiting.length });
          if (p.release?.needsReview) throw new Error('The latest release could not be verified. This product was not downloaded.');
          const modal = await this.adapter.openRoute(p.route);
          const live = modal.files.map(f => f.name + '|' + f.meta).join('\n');
          const saved = p.files.map(f => f.name + '|' + f.meta).join('\n');
          if (modal.release.name !== p.release.name || modal.release.id !== p.release.id || live !== saved) throw new Error('Product release changed. Synchronize the library again.');
          for (const f of waiting) {
            if (this.paused) break;
            if (!needsDownload(f)) continue;
            this.downloadStage = 'prepare-file';
            try { await this.one(p, f); }
            catch (error) {
              if (f.state === 'skipped') continue;
              this.archive.log(this.cancelled ? 'info' : 'error', this.cancelled ? 'download.cancelled' : 'download.failed',
                { product: p.title, productId: p.id, file: f.name, fileId: f.id, stage: this.downloadStage, received: f.received, total: f.total, error });
              f.state = 'error'; f.error = error.message; await this.archive.save();
            }
          }
        } catch (error) {
          this.archive.log('error', 'product.download-blocked', { product: p.title, productId: p.id, stage: 'open-product-or-release-check', error });
          for (const f of waiting.filter(needsDownload)) { f.state = 'error'; f.error = error.message; }
          await this.archive.save();
        }
      }
      const stats = progress({ ...this.archive.data, products });
      this.archive.log('info', 'downloads.summary', { files: stats.totalFiles, failedFiles: stats.failedFiles, failedProducts: stats.failedProducts, state: this.paused ? 'paused' : 'finished' });
      const filesDone = stats.totalFiles > 0 && stats.remainingFiles === 0;
      const message = this.paused ? 'Paused. Completed files are saved.'
        : this.productIds ? (products.every(p => !p.catalogError && p.metadataState === 'complete' && p.files.every(f => f.state === 'complete'))
          ? 'Re-sync complete for the selected product.' : 'Re-sync finished with issues. Check this product for details.')
        : stats.failedProducts ? `Synchronization finished with ${stats.failedProducts} product(s) needing attention. Open their cards and use Re-sync.`
        : stats.skippedProducts ? 'Synchronization finished with skipped errors. Use Re-sync on a product to retry.'
        : stats.complete ? 'Your library is archived.'
        : filesDone ? (stats.metadataDone < stats.discoveredProducts
          ? 'All product files are saved. Some previews are missing; synchronize again to retry them.'
          : 'All product files are saved. Synchronize library to check the full catalog.')
        : 'Some files could not be saved. Synchronize library to retry.';
      this.archive.update({ phase: this.paused ? 'paused' : stats.complete && !this.productIds ? 'complete' : 'idle', speed: 0, currentFile: '',
        message: !this.paused && !this.productIds && this.archive.data.incompleteSections?.length
          ? `Processed known files. Sections to retry: ${this.archive.data.incompleteSections.join(', ')}. Synchronize library to try again.`
          : message });
    } finally { this.item = null; this.running = false; await this.archive.save(); }
  }
  async one(product, file) {
    this.archive.log('info', 'download.start', { product: product.title, productId: product.id, file: file.name, fileId: file.id, release: product.release.name });
    assignDownloadPaths(product);
    const destination = inside(this.archive.root, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Never overwrite an unverified existing file.
    try { await fs.access(destination); if (await this.archive.validFile(file)) { file.state = 'complete'; return; } throw new Error('A different file already exists at this path. Move it aside before retrying.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (file.state === 'skipped') return;
    file.state = 'downloading'; file.error = null; file.received = 0; file.total = null;
    await this.archive.save();
    this.archive.update({ phase: 'downloading', currentFile: file.name, message: product.title, speed: 0 });
    this.downloadStage = 'await-download';
    await new Promise((resolve, reject) => {
      let timer, checkpoint = Date.now(), previous = 0, lastSave = 0, smoothSpeed = 0;
      const cleanup = () => { clearTimeout(timer); this.session.removeListener('will-download', handler); this.item = null; };
      const handler = (event, item, webContents) => {
        if (webContents?.id !== this.adapter.window.webContents.id) return;
        clearTimeout(timer); this.session.removeListener('will-download', handler);
        this.item = item; item.setSavePath(destination + '.part');
        this.downloadStage = 'receiving';
        if (this.paused && !this.cancelled) item.pause();
        let previousDownloadState;
        item.on('updated', (_event, state) => {
          if (state === 'interrupted' && previousDownloadState !== state) this.archive.log('warning', 'download.interrupted',
            { product: product.title, file: file.name, received: item.getReceivedBytes(), total: item.getTotalBytes(), state });
          previousDownloadState = state;
          file.received = item.getReceivedBytes(); file.total = item.getTotalBytes() || null;
          const now = Date.now(), elapsed = (now - checkpoint) / 1000;
          const speed = elapsed > 0 ? Math.max(0, (file.received - previous) / elapsed) : 0;
          if (elapsed >= .4) { checkpoint = now; previous = file.received; smoothSpeed = smoothSpeed ? smoothSpeed * .7 + speed * .3 : speed; this.archive.update({ phase: this.paused ? 'paused' : 'downloading', speed: this.paused ? 0 : smoothSpeed }); }
          if (now - lastSave > 2000) { lastSave = now; this.archive.save().catch(() => this.pause()); }
        });
        item.once('done', async (_event, state) => {
          cleanup();
          try {
            this.archive.log('info', 'download.response', { product: product.title, file: file.name, state,
              received: item.getReceivedBytes?.(), total: item.getTotalBytes?.(), mime: item.getMimeType?.() });
            if (state !== 'completed') throw new Error('Download interrupted. Retry to restart this unfinished file.');
            this.downloadStage = 'validate-response';
            const mime = item.getMimeType();
            if (/text\/html/i.test(mime) && !/\.html?$/i.test(file.name)) throw new Error('The server returned a web page instead of the file. Sign in again.');
            this.downloadStage = 'verify-file';
            file.state = 'verifying'; this.archive.update({ phase: 'verifying', speed: 0 });
            const stat = await fs.stat(destination + '.part');
            if (item.getTotalBytes() > 0 && stat.size !== item.getTotalBytes()) throw new Error('Downloaded file size does not match the server.');
            file.sha256 = await digest(destination + '.part');
            this.downloadStage = 'save-file';
            await fs.rename(destination + '.part', destination);
            file.received = stat.size; file.total = stat.size; file.state = 'complete';
            const committed = await fs.stat(destination);
            file.verifiedMtimeMs = committed.mtimeMs; file.verifiedSize = committed.size;
            file.verifiedAt = new Date().toISOString();
            await this.archive.persistProduct(product); this.archive.update({ phase: 'downloading' });
            this.archive.log('info', 'download.complete', { product: product.title, file: file.name, received: file.received }); resolve();
          } catch (error) { reject(error); }
        });
        if (this.cancelled) item.cancel();
      };
      this.session.on('will-download', handler);
      timer = setTimeout(() => { cleanup(); reject(new Error('Download did not start. Check the ArtStation sign-in window.')); }, 45000);
      this.adapter.action('download', file.index).catch(error => { cleanup(); reject(error); });
    });
  }
}
module.exports = { Archive, DownloadQueue, digest, imageType };
