// Developer-only visual preview. Input snapshots and output never ship with the app.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { newLibrary, key, safeName, atomicJson } = require('../app/core.cjs');
async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node scripts/preview-reference.cjs <saved-library.html> <preview-folder>');
  const root = path.resolve(destination); await fs.mkdir(root, { recursive: true });
  try { await fs.access(path.join(root, 'library.json')); throw new Error('Output already contains a library. Choose a new preview folder.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { document } = parseHTML(await fs.readFile(source, 'utf8'));
  const library = newLibrary();
  for (const [order, card] of [...document.querySelectorAll('#drop-area .marketplace-card')].entries()) {
    const cover = card.querySelector('.marketplace-card-thumbnail img');
    const title = cover?.alt || 'Untitled';
    const id = key(`${order}:${title}`), directory = `products/${safeName(title, 60)}--${id}`;
    const relative = `${directory}/media/cover.jpg`; await fs.mkdir(path.join(root, directory, 'media'), { recursive: true });
    const sourceImage = cover?.getAttribute('src');
    let copied = false;
    if (sourceImage && !/^https?:/.test(sourceImage)) {
      try { await fs.copyFile(path.resolve(path.dirname(source), decodeURIComponent(sourceImage)), path.join(root, relative)); copied = true; } catch {}
    }
    library.products.push({ id, title, author: card.querySelector('.marketplace-card-author-name')?.textContent.trim().replace(/^by\s+/, '') || '',
      order, directory, cover: copied ? relative : null, metadataState: 'pending', hidden: false, files: [], release: { name: 'Preview only' },
      description: 'Visual reference preview. Product metadata and files have not been imported.', warnings: ['Visual preview only. No product files downloaded.'] });
  }
  await atomicJson(path.join(root, 'library.json'), library);
  console.log(`Prepared ${library.products.length} local preview cards. No network requests or product downloads.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
