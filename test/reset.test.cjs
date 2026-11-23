const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../app/archive.cjs');
const { readProduct } = require('../app/catalog.cjs');
const { planLibraryWipe, wipeLibrary, resetAllData, deletePack } = require('../app/reset.cjs');

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-reset-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const archive = new Archive(() => {});
  await archive.open(path.join(workspace, 'library'));
  for (const [id, directory] of [['new', 'New--new'], ['old', 'products/Old--old']]) {
    const product = { id, directory, files: [] };
    archive.data.products.push(product); await archive.persistProduct(product);
    await fs.writeFile(path.join(archive.root, directory, 'download.zip'), 'download');
    await fs.writeFile(path.join(archive.root, directory, 'download.zip.part'), 'partial');
  }
  await fs.writeFile(path.join(archive.root, 'personal.txt'), 'keep');
  return { archive, workspace };
}

test('wipe removes current and legacy product directories, retains unrelated files and the library root', async t => {
  const { archive } = await fixture(t);
  await wipeLibrary(await planLibraryWipe(archive));
  assert.deepEqual(await fs.readdir(archive.root), ['personal.txt']);
  assert.equal(await fs.readFile(path.join(archive.root, 'personal.txt'), 'utf8'), 'keep');
});

test('cancel changes nothing, including active work and sessions', async t => {
  const { archive } = await fixture(t), before = await fs.readFile(path.join(archive.root, 'library.json'), 'utf8');
  const fail = () => assert.fail('Cancellation must not run reset steps');
  assert.equal(await resetAllData({ archive, confirm: async () => false, stop: fail, clearSessions: fail, clearSettings: fail }), false);
  assert.equal(await fs.readFile(path.join(archive.root, 'library.json'), 'utf8'), before);
});

async function recoveredProduct(archive) {
  const product = await readProduct({ archive, card: { title: 'Demo: Pack', author: 'Artist' },
    read: async () => { throw Error('Timed out'); }, stopped: () => false });
  product.id = '123-456';
  await archive.persistProduct(product);
  return product;
}

test('wipe recognizes the original directory after a product gets a permanent purchase ID', async t => {
  const { archive } = await fixture(t);
  await recoveredProduct(archive);
  await wipeLibrary(await planLibraryWipe(archive));
  assert.deepEqual(await fs.readdir(archive.root), ['personal.txt']);
});

test('a recovered folder with missing or changed ownership blocks deletion before any removal', async t => {
  const { archive } = await fixture(t);
  const product = await recoveredProduct(archive);
  const marker = path.join(archive.root, product.directory, 'product.json');
  const plan = await planLibraryWipe(archive);
  await fs.unlink(marker);
  await assert.rejects(wipeLibrary(plan), /product.json/);
  await fs.writeFile(marker, JSON.stringify({ id: 'other', directory: product.directory }));
  await assert.rejects(planLibraryWipe(archive), /product.json/);
  await fs.access(path.join(archive.root, 'New--new', 'download.zip'));
});

test('a temporary directory derived from a different card is refused even with a matching marker', async t => {
  const { archive } = await fixture(t);
  const product = await recoveredProduct(archive);
  product.sourceCard.author = 'Different artist';
  await archive.persistProduct(product);
  await assert.rejects(planLibraryWipe(archive), /unrecognized directory/);
  await fs.access(path.join(archive.root, product.directory, 'product.json'));
});

test('reset waits for work and pending writes, clears sessions/settings and returns to first-run state', async t => {
  const { archive, workspace } = await fixture(t), calls = [];
  const settings = path.join(workspace, 'settings.json'); await fs.writeFile(settings, '{}');
  archive.activity = { signedIn: true, busy: true };
  const result = await resetAllData({ archive, confirm: async () => true,
    stop: async () => {
      calls.push('stop');
      const product = { id: 'last', directory: 'Last--last', files: [] };
      archive.data.products.push(product); await archive.persistProduct(product);
      archive.saving = archive.saving.then(() => { calls.push('saved'); });
    },
    clearSessions: async () => { calls.push('sessions'); },
    clearSettings: async () => { calls.push('settings'); await fs.unlink(settings); },
  });
  assert.equal(result, true); assert.deepEqual(calls, ['stop', 'saved', 'sessions', 'settings']);
  assert.equal(archive.root, null); assert.deepEqual(archive.data.products, []);
  assert.equal(archive.state().progress.signedIn, false); assert.equal(archive.state().progress.busy, false);
  assert.deepEqual(await fs.readdir(path.join(workspace, 'library')), ['personal.txt']);
});

test('unsafe paths and protected roots are rejected before any product is deleted', async t => {
  const { archive } = await fixture(t), valid = archive.data.products[1].directory;
  for (const bad of ['../outside--old', '.', 'personal.txt', path.resolve(archive.root, 'Old--old')]) {
    archive.data.products[1].directory = bad; await archive.save();
    await assert.rejects(planLibraryWipe(archive), /refused/);
    await fs.access(path.join(archive.root, 'New--new', 'download.zip'));
  }
  archive.data.products[1].directory = valid; await archive.save();
  await assert.rejects(planLibraryWipe(archive, [path.join(archive.root, 'program')] ), /protected/);
  await assert.rejects(planLibraryWipe({ root: path.parse(archive.root).root }), /drive root/);
});

test('a product junction is refused; a link inside a product never deletes its destination', async t => {
  const { archive, workspace } = await fixture(t);
  const outside = path.join(workspace, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  const productPath = path.join(archive.root, 'New--new');
  await fs.symlink(outside, path.join(productPath, 'linked'), 'junction');
  await wipeLibrary(await planLibraryWipe(archive));
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  await archive.save();
  await fs.symlink(outside, productPath, 'junction');
  await assert.rejects(planLibraryWipe(archive), /junction/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('a path replaced by a junction after planning is refused before deleting other products', async t => {
  const { archive, workspace } = await fixture(t), plan = await planLibraryWipe(archive);
  const outside = path.join(workspace, 'outside'); await fs.mkdir(outside);
  const legacy = path.join(archive.root, 'products', 'Old--old');
  await fs.rename(legacy, path.join(workspace, 'moved'));
  await fs.symlink(outside, legacy, 'junction');
  await assert.rejects(wipeLibrary(plan), /junction/);
  await fs.access(path.join(archive.root, 'New--new', 'download.zip'));
});

test('failure clearing sessions leaves archive intact; failure clearing settings can be retried', async t => {
  const { archive } = await fixture(t);
  const options = { archive, confirm: async () => true, stop: async () => {}, clearSessions: async () => { throw Error('session busy'); }, clearSettings: async () => {} };
  await assert.rejects(resetAllData(options), /session busy/);
  await fs.access(path.join(archive.root, 'New--new', 'download.zip'));
  options.clearSessions = async () => {};
  options.clearSettings = async () => { throw Error('settings busy'); };
  await assert.rejects(resetAllData(options), /settings busy/);
  assert.ok(archive.root);
  options.clearSettings = async () => {};
  assert.equal(await resetAllData(options), true); assert.equal(archive.root, null);
});

test('reset works before a library has been selected', async () => {
  const archive = new Archive(() => {}), calls = [];
  assert.equal(await resetAllData({ archive, confirm: async root => { assert.equal(root, null); return true; },
    stop: async () => {}, clearSessions: async () => calls.push('sessions'), clearSettings: async () => calls.push('settings') }), true);
  assert.deepEqual(calls, ['sessions', 'settings']);
});

test('pack deletion requires confirmation and removes just the selected tree and its collection entries', async t => {
  const { archive, workspace } = await fixture(t);
  const target = path.join(archive.root, 'products', 'Old--old');
  const nested = path.join(target, 'files');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'custom.blend'), 'custom');
  await fs.symlink(workspace, path.join(target, 'linked'), 'junction');
  archive.data.folders.push({ id: 'tools', productIds: ['new', 'old'], sourceMembers: ['old'], excludedProductIds: ['new', 'old'] });
  await archive.save();

  const options = { archive, id: 'old', confirm: async product => { assert.equal(product.id, 'old'); return false; } };
  assert.equal(await deletePack(options), false);
  await fs.access(path.join(nested, 'custom.blend'));
  assert.deepEqual(archive.data.products.map(p => p.id), ['new', 'old']);

  options.confirm = async () => true;
  assert.equal(await deletePack(options), true);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await fs.access(path.join(archive.root, 'New--new', 'download.zip'));
  assert.equal(await fs.readFile(path.join(archive.root, 'personal.txt'), 'utf8'), 'keep');
  await archive.open(archive.root);
  assert.deepEqual(archive.data.products.map(p => p.id), ['new']);
  assert.deepEqual(archive.data.folders, [{ id: 'tools', productIds: ['new'], sourceMembers: [], excludedProductIds: ['new'] }]);
});

test('pack deletion rejects junctions, shared directories and catalog changes on disk', async t => {
  const { archive, workspace } = await fixture(t);
  const options = { archive, id: 'new', confirm: async () => true };
  const target = path.join(archive.root, 'New--new');
  const manifestPath = path.join(archive.root, 'library.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const other = archive.data.products[1];
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, products: [other] }));
  await assert.rejects(deletePack(options), /library changed on disk/);

  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const original = other.directory;
  other.directory = 'New--new';
  await assert.rejects(deletePack(options), /another pack uses this directory/);
  other.directory = original;

  const moved = path.join(workspace, 'moved');
  await fs.rename(target, moved);
  await fs.symlink(moved, target, 'junction');
  await assert.rejects(deletePack(options), /junction/);
  await fs.access(path.join(moved, 'download.zip'));
});

test('pack deletion can finish the catalog update after a save failure', async t => {
  const { archive } = await fixture(t);
  const options = { archive, id: 'new', confirm: async () => true };
  const save = archive.save.bind(archive);
  archive.save = () => { archive.saving = Promise.reject(new Error('Save failed')); return archive.saving; };
  await assert.rejects(deletePack(options), /catalog could not be saved/);
  await assert.rejects(fs.access(path.join(archive.root, 'New--new')), { code: 'ENOENT' });
  assert.deepEqual(archive.data.products.map(p => p.id), ['new', 'old']);

  archive.save = save;
  assert.equal(await deletePack(options), true);
  await archive.open(archive.root);
  assert.deepEqual(archive.data.products.map(p => p.id), ['old']);
});
