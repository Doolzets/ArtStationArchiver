const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeName, inside, atomicJson, recover, newLibrary, progress, assignDownloadPaths } = require('../app/core.cjs');

test('download names are readable, with numbered suffixes for Windows name collisions', () => {
  const product = { directory: 'Pack--id', release: { id: 'r1' }, files: ['Blender', 'Blender.zip', 'BLENDER', 'Unity_2022.x', 'FBX'].map((name, i) => ({ id: 'internal-' + i, name, meta: 'ZIP / 1 MB' })) };
  assignDownloadPaths(product);
  assert.deepEqual(product.files.map(f => path.posix.basename(f.relativePath)), ['Blender.zip', 'Blender (2).zip', 'BLENDER (3).zip', 'Unity_2022.x.zip', 'FBX.zip']);
  const before = structuredClone(product.files); assignDownloadPaths(product); assert.deepEqual(product.files, before);
});

test('download names handle sanitization collisions and reserve partial and previous-release paths', () => {
  const dir = 'Pack--id/files/';
  const product = { directory: 'Pack--id', release: { id: 'default' }, files: [
    { id: 'saved', name: 'Old', relativePath: 'Pack--id/releases/default/files/hash-Old.zip', state: 'complete', sha256: 'hash' },
    ...['a?b', 'a:b', 'Blender', 'a_b.zip.part'].map(name => ({ name, meta: name.endsWith('.part') ? '' : 'ZIP / 1 MB' })),
  ], previousReleases: [{ files: [{ relativePath: dir + 'Blender.zip' }] }] };
  assignDownloadPaths(product);
  assert.equal(product.files[0].relativePath, 'Pack--id/releases/default/files/hash-Old.zip');
  assert.equal(product.files[0].sha256, 'hash');
  assert.deepEqual(product.files.slice(1).map(f => f.relativePath), ['a_b.zip', 'a_b (2).zip', 'Blender (2).zip', 'a_b.zip (2).part'].map(name => dir + name));
});

test('Windows names and paths cannot escape the selected library', () => {
  assert.equal(safeName('CON.zip'), '_CON.zip');
  assert.equal(safeName('a/b:c? '), 'a_b_c_');
  assert.equal(safeName('...'), 'Untitled');
  const root = path.resolve('archive');
  for (const invalid of ['../secret', 'C:\\secret', '', '/etc/passwd']) assert.throws(() => inside(root, invalid));
  assert.equal(inside(root, 'products/a.zip'), path.join(root, 'products/a.zip'));
});
test('discovery has no invented percentage or ETA', () => {
  const p = progress(newLibrary(), { phase: 'scanning', expectedProducts: 300 });
  assert.equal(p.percent, null); assert.equal(p.eta, null); assert.equal(p.totalProducts, 300);
});
test('known bytes report remaining work, failures do not count as finished', () => {
  const l = { ...newLibrary(), discoveryComplete: true, products: [{ metadataState: 'complete', files: [
    { state: 'complete', total: 100 }, { state: 'downloading', received: 50, total: 100 }, { state: 'error', total: 100 }
  ] }] };
  const p = progress(l, { phase: 'downloading', speed: 10 });
  assert.equal(p.percent, 50); assert.equal(p.eta, 15); assert.equal(p.remainingFiles, 2); assert.equal(p.failedFiles, 1); assert.equal(p.complete, false);
});
test('unknown sizes fall back to file counts without invented total bytes', () => {
  const l = { ...newLibrary(), discoveryComplete: true, products: [{ metadataState: 'complete', files: [{ state: 'complete', total: 10 }, { state: 'pending', total: null }] }] };
  assert.equal(progress(l).percent, 50); assert.equal(progress(l).totalBytes, null); assert.equal(progress(l).eta, null);
});
test('100% is only reached after verification, and reset tasks survive restart', () => {
  const l = { ...newLibrary(), discoveryComplete: true, products: [{ metadataState: 'complete', files: [{ state: 'verifying', received: 10, total: 10 }] }] };
  assert.equal(progress(l).percent, 99.9);
  recover(l); assert.equal(l.products[0].files[0].state, 'pending'); assert.equal(l.products[0].files[0].received, 0);
  l.products[0].files[0].state = 'complete'; assert.equal(progress(l).percent, 100);
});
test('manifest commits are readable and completed files remain completed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-test-'));
  try {
    const l = { ...newLibrary(), products: [{ files: [{ state: 'complete', total: 12 }] }] };
    await atomicJson(path.join(dir, 'library.json'), l);
    const read = recover(JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8')));
    assert.equal(read.products[0].files[0].state, 'complete');
    assert.deepEqual(await fs.readdir(dir), ['library.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
