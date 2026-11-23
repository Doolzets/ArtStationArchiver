const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inside, safeName, atomicJson } = require('./core.cjs');
const { imageType } = require('./archive.cjs');

async function copySelected(source, directory) {
  const name = path.basename(source), ext = path.extname(name), stem = path.basename(name, ext);
  if (!(await fs.stat(source)).isFile()) throw new Error('Choose a regular file.');
  for (let n = 1; ; n++) {
    const target = path.join(directory, n === 1 ? name : `${stem} (${n})${ext}`);
    try { await fs.copyFile(source, target, constants.COPYFILE_EXCL); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function createLocalPack(archive, fields, sources = [], coverFile = null) {
  const title = String(fields.title || '').trim();
  if (!archive.root || !title) throw new Error('Choose a library location and enter a pack name.');
  const id = 'local-' + randomUUID().slice(0, 18);
  const directory = safeName(title, 65) + '--' + id;
  const root = await fs.realpath(archive.root);
  const destination = inside(root, directory);
  const stage = await fs.mkdtemp(path.join(root, '.import-'));
  const product = { id, source: 'local', title, directory, createdAt: Date.now(), files: [],
    author: String(fields.author || '').trim(), description: String(fields.description || '').trim(),
    release: { name: String(fields.version || '').trim() }, metadataState: 'complete' };
  let committedDirectory = false;
  try {
    const files = path.join(stage, 'files');
    await fs.mkdir(files);
    for (const source of new Set(sources)) await copySelected(source, files);
    if (coverFile) {
      const header = Buffer.alloc(64), handle = await fs.open(coverFile, 'r');
      let type;
      try { const { bytesRead } = await handle.read(header); type = imageType(header.subarray(0, bytesRead)); }
      finally { await handle.close(); }
      if (!type) throw new Error('Choose a PNG, JPEG, GIF, WebP or AVIF cover image.');
      const cover = 'cover.' + type;
      await fs.copyFile(coverFile, path.join(stage, cover), constants.COPYFILE_EXCL);
      product.cover = directory + '/' + cover;
    }
    await atomicJson(path.join(stage, 'product.json'), product);
    await fs.rename(stage, destination);
    committedDirectory = true;
    archive.data.products.push(product);
    const folders = archive.data.folders.filter(f => fields.collections?.includes(f.id));
    const previouslyEdited = folders.map(folder => folder.locallyEdited);
    for (const folder of folders) { folder.productIds.push(id); folder.locallyEdited = true; }
    try { await archive.save(); }
    catch (error) {
      archive.data.products = archive.data.products.filter(p => p !== product);
      folders.forEach((folder, i) => {
        folder.productIds = folder.productIds.filter(value => value !== id);
        folder.locallyEdited = previouslyEdited[i];
      });
      throw error;
    }
  } catch (error) {
    const created = committedDirectory ? destination : stage;
    if (await fs.realpath(created) === created) await fs.rm(created, { recursive: true, force: true });
    throw error;
  }
  archive.update({});
  return id;
}

async function packDirectory(root, product) {
  const realRoot = await fs.realpath(root);
  const target = inside(realRoot, product.directory);
  if (path.relative(target, await fs.realpath(target)) !== '' || !(await fs.stat(target)).isDirectory()) {
    throw new Error('The product folder has moved or is a link.');
  }
  return target;
}

function excludedFiles(product) {
  const paths = [product.cover, product.avatar, ...(product.galleryLocal || [])];
  for (const release of [product, ...(product.previousReleases || [])]) {
    for (const file of release.files || []) {
      if (file.relativePath) paths.push(file.relativePath, file.relativePath + '.part');
    }
  }
  return new Set(paths.filter(Boolean).map(p => path.normalize(p).toLowerCase()));
}

async function diskFiles(root, product) {
  const dir = await packDirectory(root, product);
  const excluded = excludedFiles(product), found = [], available = [];
  const recorded = new Map((product.files || []).filter(f => f.relativePath)
    .map(f => [path.normalize(f.relativePath).toLowerCase(), f.id]));
  async function visit(relative) {
    const current = relative ? inside(dir, relative) : dir;
    if (path.relative(current, await fs.realpath(current)) !== '') return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const sub = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink() || /^product\.json(?:$|\.[\da-f-]+\.tmp$)/i.test(sub)) continue;
      if (entry.isDirectory()) {
        try { await visit(sub); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if (entry.isFile()) {
        const normalized = path.join(product.directory, sub).toLowerCase();
        if (recorded.has(normalized)) available.push(recorded.get(normalized));
        if (excluded.has(normalized)) continue;
        // Old cached previews can outlive the release or gallery that referenced them.
        if (product.source !== 'local' && /^media\/[a-f0-9]{16}\.(png|jpe?g|webp|gif|avif)(\.part)?$/i.test(sub)) continue;
        found.push(sub);
      }
    }
  }
  await visit('');
  return { files: found.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), available: available.sort() };
}

async function diskFilePath(root, product, relative) {
  const dir = await packDirectory(root, product);
  const file = inside(dir, relative);
  if (path.relative(file, await fs.realpath(file)) !== '' || !(await fs.lstat(file)).isFile()) {
    throw new Error('The selected file has moved or is a link.');
  }
  return file;
}
module.exports = { createLocalPack, packDirectory, diskFiles, diskFilePath };
