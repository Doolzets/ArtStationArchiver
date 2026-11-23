const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Archive } = require('../app/archive.cjs');
const { skipProductErrors } = require('../app/core.cjs');
const { readProduct, cachedProduct, prepareCatalogGroups, finishFolder, uniqueCardKeys,
  indexFolderCards, applyPurchaseOrder, resolveFolderMember, recoveringCardReader } = require('../app/catalog.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = new Archive(() => {}); await archive.open(root);
  return archive;
}
function product(id) {
  return { id, title: `Pack ${id}`, author: 'Artist', directory: `Pack--${id}`, order: 0,
    metadataState: 'complete', route: `https://www.artstation.com/marketplace/library/${id}/1/item`, release: { id: 'default', name: '1.0' },
    files: [{ id: 'file', state: 'pending' }] };
}
test('ordinary sync preserves an acknowledged unreadable card and independent new errors still need attention', async t => {
  const archive = await fixture(t);
  const saved = product('broken');
  saved.catalogError = 'Product could not be read.';
  archive.data.products.push(saved);
  assert.equal(skipProductErrors(saved), true);
  await archive.persistProduct(saved);
  await archive.open(archive.root);
  const cached = await readProduct({ archive, card: saved, order: 4, hidden: false,
    read: () => assert.fail('Unexpected catalog retry'), stopped: () => false });
  assert.equal(cached.metadataState, 'skipped');
  assert.equal(cached.order, 4);
  assert.deepEqual(archive.state().progress.failedProductIds, []);
  cached.files[0].state = 'error';
  assert.deepEqual(archive.state().progress.failedProductIds, [cached.id]);
});

test('source folders exist before product reads, share purchases and survive an offline reopen', async t => {
  const archive = await fixture(t);
  const sidebar = [{ name: 'All', count: 2 }, { name: 'Brushes', count: 2 },
    { name: 'Favorites', count: 1 }, { name: 'Empty', count: 0 }];
  const groups = prepareCatalogGroups(archive.data, sidebar);
  assert.deepEqual(groups.map(g => g.name), ['Brushes', 'Favorites', 'Empty', 'All', 'Hidden Products']);
  await archive.save();
  const reopened = new Archive(() => {});
  await reopened.open(archive.root);
  assert.equal(reopened.data.folders[0].sourceCount, 2);
  assert.equal(reopened.data.folders[0].membersPending, true);
  archive.data.products.push(product('a'), product('b'));
  finishFolder(groups[0].folder, ['b', 'a']);
  finishFolder(groups[1].folder, ['b']);
  finishFolder(groups[2].folder, []);
  await archive.save();
  await reopened.open(archive.root);
  assert.deepEqual(reopened.data.folders.map(f => f.productIds), [['b', 'a'], ['b'], []]);
  assert.ok(reopened.data.folders.every(f => !f.membersPending));
  assert.equal(reopened.data.products.length, 2);
});

test('a retry preserves prior memberships until the completed scan and keeps local additions', () => {
  const library = { folders: [] }, sidebar = [{ name: 'All', count: 3 }, { name: 'Brushes', count: 2 }];
  const folder = prepareCatalogGroups(library, sidebar)[0].folder;
  finishFolder(folder, ['a', 'b']);
  folder.productIds.push('local'); folder.locallyEdited = true;
  const retry = prepareCatalogGroups(library, sidebar)[0].folder;
  assert.equal(retry, folder);
  assert.deepEqual(folder.productIds, ['a', 'b', 'local']);
  finishFolder(retry, ['b', 'c']);
  assert.deepEqual(folder.productIds, ['b', 'c', 'local']);
  assert.equal(library.folders.length, 1);
});

test('a stuck dialog reloads its section and retries the same identity at its new index', async () => {
  const cards = ['One','Two'].map((title, index) => ({title, index})), calls = [];
  let reloads = 0;
  const read = recoveringCardReader({ cards, stopped: () => false, log() {},
    reload: async () => { reloads++; return [{...cards[1], index:0}, {...cards[0], index:1}]; },
    open: async card => {
      calls.push([card.title, card.index]);
      if (!reloads) throw Object.assign(Error('Timeout'), {code:'PREVIOUS_MODAL_STUCK'});
      return card.title;
    } });
  assert.equal(await read(cards[0]), 'One');
  assert.equal(await read(cards[1]), 'Two');
  assert.deepEqual(calls, [['One',0], ['One',1], ['Two',0]]);
  assert.equal(reloads, 1);
});

test('successive read failures trigger one recovery and a failed retry never marks the next purchase broken', async t => {
  const archive = await fixture(t), cards = [{title:'One'}, {title:'Two'}];
  let reloads = 0;
  const read = recoveringCardReader({ cards, stopped: () => false, log() {},
    reload: async () => { reloads++; return cards; }, open: async () => { throw Error('No modal'); } });
  const index = card => readProduct({archive, card, stopped: () => false, read: () => read(card)});
  assert.ok((await index(cards[0])).catalogError);
  assert.equal(reloads, 0);
  await assert.rejects(index(cards[1]), {code:'CATALOG_UNAVAILABLE'});
  assert.equal(reloads, 1);
  assert.deepEqual(archive.data.products.map(p => p.title), ['One']);
});

test('user pause during reconnect prevents the retry click', async () => {
  const cards = [{title:'Item'}]; let paused = false, clicks = 0;
  const read = recoveringCardReader({cards, stopped: () => paused, log() {},
    open: async () => { clicks++; throw Object.assign(Error('Timeout'), {code:'PREVIOUS_MODAL_STUCK'}); },
    reload: async () => { paused = true; return cards; }});
  await assert.rejects(read(cards[0]), /paused/);
  assert.equal(clicks, 1);
});

test('folder scans only tag cards; purchases appear in All order even across a pause', async t => {
  const archive = await fixture(t);
  const [brushes, favorites] = prepareCatalogGroups(archive.data, [
    {name: 'All', count: 3}, {name: 'Brushes', count: 2}, {name: 'Favorites', count: 1}]);
  const [newest, middle, oldest] = ['new', 'mid', 'old'].map(product);
  const cards = [newest, middle, oldest];
  indexFolderCards(archive.data, brushes.folder, [oldest, newest]);
  indexFolderCards(archive.data, favorites.folder, [oldest]);
  assert.deepEqual(archive.data.products, []);
  const keys = uniqueCardKeys(cards);
  for (const [i, p] of cards.entries()) {
    p.order = i;
    resolveFolderMember(archive.data.folders, 'unresolved-' + keys[i], p.id);
    archive.data.products.push(p);
    await archive.persistProduct(p);
    await archive.open(archive.root);
    assert.deepEqual(archive.data.products.map(p => p.id), ['new', 'mid', 'old'].slice(0, i + 1));
  }
  assert.deepEqual(archive.data.folders.map(f => f.productIds), [['old', 'new'], ['old']]);
  assert.deepEqual(archive.data.folders.map(f => f.sourceMembers), [['old', 'new'], ['old']]);
});

test('the All snapshot corrects saved folder-first ranks before metadata reads', () => {
  const [older, archived, newer] = ['older', 'archived', 'newer'].map(product);
  [older, archived, newer].forEach((p, i) => { p.order = i; });
  const library = { products: [older, archived, newer], folders: [] };
  const folder = prepareCatalogGroups(library, [{name: 'All', count: 3}, {name: 'Brushes', count: 1}])[0].folder;
  indexFolderCards(library, folder, [older]);
  assert.deepEqual(library.products.map(p => p.order), [0, 1, 2]);
  applyPurchaseOrder(library, uniqueCardKeys([newer, product('missing'), older]));
  assert.deepEqual(library.products.map(p => p.order), [2, 3, 0]);
  assert.deepEqual(folder.productIds, [older.id]);
});
test('saved metadata survives restart and skips network reads even with pending downloads', async t => {
  const archive = await fixture(t), p = product('one');
  archive.data.products.push(p); await archive.persistProduct(p);
  const reopened = new Archive(() => {}); await reopened.open(archive.root);
  const result = await readProduct({ archive: reopened, card: { title: p.title, author: p.author }, order: 7, hidden: false,
    read: () => assert.fail('A saved product should not be reopened on the site'), save: () => assert.fail(), stopped: () => false });
  assert.equal(result.id, p.id); assert.equal(result.order, 7); assert.equal(result.files[0].state, 'pending');
});
test('an unreadable product is recorded and the next product still imports', async t => {
  const archive = await fixture(t);
  const bad = await readProduct({ archive, card: { title: 'Unavailable', author: 'Artist' }, order: 0, hidden: false,
    read: async () => { throw new Error('Timeout'); }, save: () => assert.fail(), stopped: () => false });
  assert.ok(bad.catalogError); assert.equal(bad.files.length, 0);
  const next = product('next');
  await readProduct({ archive, card: next, order: 1, hidden: false, read: async () => ({}), stopped: () => false,
    save: async () => { archive.data.products.push(next); await archive.persistProduct(next); return next; } });
  archive.data.discoveryComplete = true;
  assert.equal(archive.data.products.length, 2); assert.equal(archive.state().progress.failedProducts, 1);
  assert.equal(archive.state().progress.complete, false);
  await archive.open(archive.root); assert.ok(archive.data.products[0].catalogError);
});
test('Re-sync bypasses the metadata cache for the selected product', async t => {
  const archive = await fixture(t), p = product('one'); archive.data.products.push(p);
  let read = 0, save = 0;
  await readProduct({ archive, card: p, order: 0, hidden: false, force: true, stopped: () => false,
    read: async () => { read++; return { title: p.title }; }, save: async () => { save++; return p; } });
  assert.equal(read, 1); assert.equal(save, 1);
});
test('missing previews invalidate metadata reuse', async t => {
  const archive = await fixture(t), p = product('one'); p.cover = 'missing.jpg';
  assert.equal(await archive.metadataPresent(p), false);
});
test('ambiguous cards are not matched to an arbitrary cached purchase', () => {
  const a = product('a'), b = { ...a, id: 'b' };
  assert.equal(cachedProduct({ products: [a, b] }, a), null);
});
test('pausing a product read does not persist a fake failure', async t => {
  const archive = await fixture(t);
  await assert.rejects(readProduct({ archive, card: { title: 'Paused' }, order: 0, hidden: false,
    stopped: () => true, read: async () => { throw new Error('Import paused.'); }, save: () => assert.fail() }), /paused/);
  assert.equal(archive.data.products.length, 0);
});

test('failed Re-sync preserves the existing product and its saved file records', async t => {
  const archive = await fixture(t), p = product('one');
  p.files = [{ id: 'saved', state: 'complete', relativePath: 'Pack--one/file.zip', sha256: 'recorded-hash' }];
  archive.data.products.push(p);
  await readProduct({ archive, card: p, order: 0, hidden: false, force: true, stopped: () => false,
    read: async () => { throw new Error('Unavailable'); }, save: () => assert.fail() });
  assert.equal(archive.data.products.length, 1);
  assert.equal(p.files[0].state, 'complete'); assert.equal(p.files[0].sha256, 'recorded-hash');
  assert.ok(p.catalogError); assert.equal(await archive.metadataPresent(p), false);
});

test('a disk write failure is not mistaken for a skippable product error', async t => {
  const archive = await fixture(t);
  archive.persistProduct = async () => { throw new Error('Disk full'); };
  await assert.rejects(readProduct({ archive, card: { title: 'Example' }, order: 0, hidden: false, stopped: () => false,
    read: async () => { throw new Error('Unavailable'); }, save: () => assert.fail() }), /Disk full/);
});

test('cached products switch to the library cover without rereading metadata or redownloading it on restart', async t => {
  let archive = await fixture(t);
  const p = product('cover');
  p.cover = p.directory + '/media/modal.jpg';
  p.coverUrl = 'https://cdna.artstation.com/modal.jpg';
  p.files = [{ id: 'saved', state: 'complete', sha256: 'saved-hash' }];
  await fs.mkdir(path.join(archive.root, p.directory, 'media'), { recursive: true });
  await fs.writeFile(path.join(archive.root, p.cover), 'old cover');
  archive.data.products.push(p); await archive.persistProduct(p);
  const card = { title: p.title, author: p.author, coverUrl: 'https://cdna.artstation.com/library.jpg' };
  let downloads = 0;
  const session = { fetch: async url => {
    assert.equal(url, card.coverUrl); downloads++;
    return new Response(Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]));
  } };
  const run = () => readProduct({ archive, card, session, order: 0, hidden: false, stopped: () => false,
    read: () => assert.fail('Must not reopen product metadata'), save: () => assert.fail() });
  const result = await run();
  assert.notEqual(result.cover, p.directory + '/media/modal.jpg');
  assert.equal(result.coverUrl, card.coverUrl);
  assert.deepEqual(result.files, [{ id: 'saved', state: 'complete', sha256: 'saved-hash' }]);
  const root = archive.root;
  archive = new Archive(() => {}); await archive.open(root); await run();
  assert.equal(downloads, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(root, p.directory, 'product.json'), 'utf8'));
  assert.equal(persisted.coverUrl, card.coverUrl);
});

test('failed cover replacement preserves the previous image and retries without reopening the product', async t => {
  const archive = await fixture(t), p = product('retry-cover');
  p.cover = p.directory + '/media/old.jpg'; p.coverUrl = 'https://cdna.artstation.com/old.jpg';
  await fs.mkdir(path.join(archive.root, p.directory, 'media'), { recursive: true });
  await fs.writeFile(path.join(archive.root, p.cover), 'old cover'); archive.data.products.push(p);
  const oldPath = p.cover, oldUrl = p.coverUrl;
  const card = { title: p.title, author: p.author, coverUrl: 'https://cdna.artstation.com/new.jpg' };
  const session = { fetch: async () => new Response('Unavailable', { status: 503 }) };
  const run = () => readProduct({ archive, card, session, order: 0, hidden: false, stopped: () => false,
    read: () => assert.fail('Must not reopen metadata for a cover retry'), save: () => assert.fail() });
  await run(); await run();
  assert.equal(p.cover, oldPath); assert.equal(p.coverUrl, oldUrl); assert.equal(p.warnings.length, 1);
  session.fetch = async () => new Response(Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]));
  await run();
  assert.equal(p.coverUrl, card.coverUrl); assert.equal(p.warnings.length, 0);
  assert.equal(await fs.readFile(path.join(archive.root, oldPath), 'utf8'), 'old cover');
});
