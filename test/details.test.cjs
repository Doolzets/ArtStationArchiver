const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { readDetailsPage, getProductDetails, unavailableDetails } = require('../app/details.cjs');
const { detailSnapshot } = require('../app/site.cjs');
const { Archive } = require('../app/archive.cjs');
const { readProduct } = require('../app/catalog.cjs');
const url = 'https://www.artstation.com/marketplace/p/example/product';
function fixture(status, result, failure) {
  const webContents = new EventEmitter();
  const window = { webContents, loadURL: async () => {
    if (status) webContents.emit('did-navigate', {}, url, status);
    if (failure) throw failure;
  } };
  const adapter = { wait: async (_snapshot, ready) => {
    if (!ready(result)) throw Error('Timed out');
    return result;
  } };
  return { window, adapter };
}
for (const code of [404, 410]) test(`HTTP ${code} is a saved unavailable state, without waiting for an absent description`, async () => {
  const { window, adapter } = fixture(code);
  adapter.wait = () => assert.fail('Do not wait on a deleted page');
  assert.deepEqual(await readDetailsPage(window, adapter, url), unavailableDetails());
  assert.equal(window.webContents.listenerCount('did-navigate'), 0);
});
test('a confirmed missing HTTP response remains unavailable even if loadURL rejects', async () => {
  const { window, adapter } = fixture(404, null, Error('Load failed'));
  assert.equal((await readDetailsPage(window, adapter, url)).detailsState, 'unavailable');
});
test('network, login, rate-limit and server errors are not recorded as deleted pages', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { window, adapter } = fixture(status, { detailsState: 'unavailable' });
    await assert.rejects(readDetailsPage(window, adapter, url), /request failed/);
    assert.equal(window.webContents.listenerCount('did-navigate'), 0);
  }
  const { window, adapter } = fixture(null, null, Error('Network disconnected'));
  await assert.rejects(readDetailsPage(window, adapter, url), /Network disconnected/);
  const blank = fixture(200, null);
  await assert.rejects(readDetailsPage(blank.window, blank.adapter, url), /Timed out/);
});
test('the explicit ArtStation 404 screen is recognized, but a description mentioning 404 is not', async () => {
  const extract = html => vm.runInNewContext(`(${detailSnapshot.toString()})()`, { document: parseHTML(html).document });
  const missing = extract('<main><h1>404</h1><h2>Page not found</h2></main>');
  assert.equal(missing.detailsState, 'unavailable');
  const { window, adapter } = fixture(200, missing);
  assert.equal((await readDetailsPage(window, adapter, url)).detailsState, 'unavailable');
  assert.equal(extract('<h1>403</h1><p>Access denied</p>'), null);
  assert.equal(extract('<h1>Page not found</h1>'), null);
  const valid = extract('<div class="productPage-wrapper"><div class="product-description"><h1>404</h1><p>Page not found</p><p>Error page asset pack</p></div></div>');
  assert.notEqual(valid.detailsState, 'unavailable');
});
test('unavailable state survives restart and skips catalog reads without blocking completion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-details-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let archive = new Archive(() => {}); await archive.open(root);
  const product = { id: 'example', title: 'Example', author: 'Artist', directory: 'Example--example',
    metadataState: 'complete', route: 'https://www.artstation.com/marketplace/library/example/1/item', release: { id: 'r1' },
    files: [{ state: 'complete', received: 4, total: 4 }], ...unavailableDetails() };
  archive.data.products.push(product); archive.data.discoveryComplete = true; await archive.persistProduct(product);
  archive = new Archive(() => {}); await archive.open(root);
  const result = await readProduct({ archive, card: { title: 'Example', author: 'Artist' }, order: 0, hidden: false,
    stopped: () => false, read: () => assert.fail('Must reuse completed metadata'), save: () => assert.fail() });
  assert.equal(result.description, 'Product page is unavailable');
  assert.equal(archive.state().progress.failedProducts, 0);
  assert.equal(archive.state().progress.complete, true);
});
test('other metadata retries skip the known missing page; explicit Re-sync can discover restoration', async () => {
  const product = { ...unavailableDetails(), metadataState: 'error' };
  assert.equal((await getProductDetails(product, () => assert.fail('Do not retry known missing details'))).detailsState, 'unavailable');
  const restored = fixture(200, { description: 'Restored description', gallery: [] });
  const result = await getProductDetails(product, () => readDetailsPage(restored.window, restored.adapter, url), { force: true });
  assert.equal(result.detailsState, 'available'); assert.equal(result.description, 'Restored description');
});
