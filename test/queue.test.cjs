const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Archive, DownloadQueue } = require('../app/archive.cjs');
const { skipProductErrors, retrySkippedErrors } = require('../app/core.cjs');
async function fixture(t, mime = 'application/zip') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = new Archive(() => {}); await archive.open(root);
  const product = { id: 'test', directory: 'products/test', title: 'Test', metadataState: 'complete', route: 'https://www.artstation.com/marketplace/library/test/1/test', release: { id: 'r1', name: '1.0' }, files: [{ id: 'f1', index: 0, name: 'file.zip', meta: 'ZIP / 4 B', state: 'pending' }] };
  archive.data.products.push(product); archive.data.discoveryComplete = true;
  const session = new EventEmitter(); let calls = 0;
  const adapter = { window: { webContents: { id: 1 } }, openRoute: async () => ({ release: product.release, files: product.files }), action: async () => {
    calls++; const item = new EventEmitter();
    Object.assign(item, { setSavePath: p => { item.path = p; }, getReceivedBytes: () => 4, getTotalBytes: () => 4, getMimeType: () => mime, pause: () => {}, resume: () => {} });
    session.emit('will-download', {}, item, { id: 1 });
    await fs.writeFile(item.path, 'test'); item.emit('updated'); item.emit('done', {}, 'completed');
  } };
  return { root, archive, product, queue: new DownloadQueue(archive, adapter, session), calls: () => calls };
}
test('queue commits verified files and repeat runs do not download duplicates', async t => {
  const f = await fixture(t); await f.queue.start(); assert.equal(f.product.files[0].state, 'complete'); assert.equal(f.product.files[0].sha256.length, 64);
  assert.equal(f.product.files[0].relativePath, f.product.directory + '/files/file.zip');
  assert.equal(await fs.readFile(path.join(f.root, f.product.directory, 'files', 'file.zip'), 'utf8'), 'test');
  await f.queue.start(); assert.equal(f.calls(), 1);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'library.json'), 'utf8')); assert.equal(saved.products[0].files[0].state, 'complete');
});

test('skipping a failed file survives reopening and allows other files to download until explicitly retried', async t => {
  const f = await fixture(t);
  const [failed] = f.product.files;
  f.product.files.push({ ...failed, id: 'f2', index: 1, name: 'second.zip' });
  failed.state = 'error';
  assert.equal(skipProductErrors(f.product), true);
  assert.equal(skipProductErrors(f.product), false);
  await f.archive.persistProduct(f.product);
  await f.archive.open(f.root);
  const [saved] = f.archive.data.products;
  await f.queue.start();
  assert.deepEqual(saved.files.map(file => file.state), ['skipped', 'complete']);
  assert.equal(f.calls(), 1);
  const stats = f.archive.state().progress;
  assert.deepEqual(stats.failedProductIds, []);
  assert.equal(stats.completedFiles, 1);
  assert.equal(stats.remainingFiles, 0);
  assert.equal(stats.skippedFiles, 1);
  assert.equal(stats.complete, false);
  assert.equal(retrySkippedErrors(saved), true);
  assert.deepEqual(f.archive.state().progress.failedProductIds, [saved.id]);
  await f.queue.start();
  assert.equal(f.calls(), 2);
  assert.equal(f.archive.state().progress.complete, true);
});

for (const late of [false, true]) test(`reset stops ${late ? 'a pending' : 'an active paused'} download and waits for queue writes`, async t => {
  const f = await fixture(t);
  let ready, send;
  const requested = new Promise(resolve => { ready = resolve; });
  f.queue.adapter.action = async () => {
    const item = new EventEmitter();
    Object.assign(item, { setSavePath: () => {}, pause: () => {}, cancel: () => item.emit('done', {}, 'cancelled') });
    send = () => f.queue.session.emit('will-download', {}, item, { id: 1 });
    if (!late) send(); ready();
  };
  const run = f.queue.start(); await requested;
  f.queue.pause(); f.queue.stop();
  if (late) send();
  await run; await f.archive.saving;
  assert.equal(f.queue.running, false); assert.equal(f.queue.item, null);
  assert.equal(f.queue.session.listenerCount('will-download'), 0);
  assert.notEqual(f.product.files[0].state, 'complete');
});
test('an HTML login response is not marked as an archived ZIP', async t => {
  const f = await fixture(t, 'text/html'), logs = [];
  f.archive.diagnostics = { write: (level, event, fields) => logs.push({ level, event, ...fields }) };
  await f.queue.start(); assert.equal(f.product.files[0].state, 'error'); assert.equal(f.archive.state().progress.complete, false);
  const failure = logs.find(entry => entry.event === 'download.failed');
  assert.equal(failure.product, 'Test'); assert.equal(failure.file, 'file.zip'); assert.equal(failure.stage, 'validate-response');
  assert.equal(logs.find(entry => entry.event === 'download.response').mime, 'text/html');
});
test('release changes stop the download before any file request', async t => {
  const f = await fixture(t), logs = [];
  f.archive.diagnostics = { write: (level, event, fields) => logs.push({ level, event, ...fields }) };
  f.queue.adapter.openRoute = async () => ({ release: { name: '2.0' }, files: f.product.files });
  await f.queue.start(); assert.equal(f.calls(), 0); assert.equal(f.product.files[0].state, 'error');
  assert.equal(logs.find(entry => entry.event === 'product.download-blocked').product, 'Test');
});

test('a completed partial import is distinct from a complete library', async t => {
  const f = await fixture(t); f.archive.data.discoveryComplete = false;
  await f.queue.start();
  assert.equal(f.archive.state().progress.complete, false);
  assert.equal(f.archive.state().progress.remainingFiles, 0);
  assert.match(f.archive.activity.message, /All product files are saved/);
  assert.match(f.archive.activity.message, /full catalog/);
});

test('an unverified release cannot be downloaded by synchronization', async t => {
  const f = await fixture(t); f.product.release.needsReview = true;
  await f.queue.start();
  assert.equal(f.calls(), 0); assert.equal(f.product.files[0].state, 'error');
  assert.match(f.product.files[0].error, /latest release/);
});

test('a missed section allows known downloads and appears in the final status', async t => {
  const f = await fixture(t);
  f.archive.data.discoveryComplete = false;
  f.archive.data.incompleteSections = ['Hidden Products'];
  await f.queue.start();
  assert.equal(f.product.files[0].state, 'complete');
  assert.equal(f.archive.state().progress.complete, false);
  assert.match(f.archive.activity.message, /Hidden Products/);
});

test('download verification records survive restart and missing files are detected', async t => {
  const f = await fixture(t); await f.queue.start();
  const reopened = new Archive(() => {}); await reopened.open(f.root);
  const file = reopened.data.products[0].files[0];
  assert.equal(file.verifiedSize, 4); assert.ok(Number.isFinite(file.verifiedMtimeMs));
  assert.equal(await reopened.validFile(file, { deep: false }), true);
  await fs.unlink(path.join(f.root, file.relativePath));
  assert.equal(await reopened.validFile(file, { deep: false }), false);
});

test('quick checks detect changed timestamps; deep checks detect same-size changes with preserved timestamps', async t => {
  const f = await fixture(t); await f.queue.start();
  const file = f.product.files[0], full = path.join(f.root, file.relativePath);
  await fs.writeFile(full, 'edit');
  await fs.utimes(full, new Date(), new Date(file.verifiedMtimeMs + 10000));
  assert.equal(await f.archive.validFile(file, { deep: false }), false);
  file.verifiedMtimeMs = (await fs.stat(full)).mtimeMs;
  assert.equal(await f.archive.validFile(file, { deep: false }), true); // Fast path deliberately trusts the saved stamp.
  assert.equal(await f.archive.validFile(file, { deep: true }), false);
});

test('a single-product queue verifies and downloads only that product', async t => {
  const f = await fixture(t);
  const other = { ...f.product, id: 'other', directory: 'other', files: [{ id: 'other-file', state: 'pending' }] };
  f.archive.data.products.push(other);
  const queue = new DownloadQueue(f.archive, f.queue.adapter, f.queue.session, { productIds: ['test'], deep: true });
  await queue.start();
  assert.equal(f.calls(), 1); assert.equal(other.files[0].state, 'pending');
  assert.equal(f.product.files[0].state, 'complete');
  assert.match(f.archive.activity.message, /selected product/);
});

test('completed files use quick verification on ordinary sync and deep verification on Re-sync', async t => {
  const f = await fixture(t); await f.queue.start();
  const checks = [], original = f.archive.validFile.bind(f.archive);
  f.archive.validFile = (file, options) => { checks.push(options.deep); return original(file, options); };
  await f.queue.start();
  await new DownloadQueue(f.archive, f.queue.adapter, f.queue.session, { productIds: ['test'], deep: true }).start();
  assert.deepEqual(checks, [false, true]); assert.equal(f.calls(), 1);
});
