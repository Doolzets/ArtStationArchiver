const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Archive, DownloadQueue } = require('../app/archive.cjs');
const { cachedProduct, finishFolder } = require('../app/catalog.cjs');
const { planLibraryWipe } = require('../app/reset.cjs');
const { createLocalPack, packDirectory, diskFiles, diskFilePath } = require('../app/local-packs.cjs');

async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-local-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const archive = new Archive(() => {});
  await archive.open(path.join(temp, 'library'));
  return { temp, archive };
}
test('a name alone creates an offline pack and sync ignores it after reopening', async t => {
  const { archive } = await setup(t);
  const id = await createLocalPack(archive, { title: 'Brushes' });
  await archive.open(archive.root);
  const [pack] = archive.data.products;
  assert.equal(pack.id, id);
  assert.deepEqual(await diskFiles(archive.root, pack), { files: [], available: [] });
  assert.equal((await planLibraryWipe(archive)).products[0].id, id);
  assert.equal(cachedProduct(archive.data, { title: 'Brushes', author: '' }), null);
  assert.equal(archive.state().progress.discoveredProducts, 0);
  archive.persistProduct = () => assert.fail('Queue must skip local packs');
  await new DownloadQueue(archive, null, null).start();
});
test('copies picked files, disambiguates collisions, saves optional fields and collection membership', async t => {
  const { archive, temp } = await setup(t);
  const folder = { id: 'brushes', productIds: [], sourceMembers: [] };
  archive.data.folders.push(folder);
  const paths = [];
  for (const name of ['one', 'two']) {
    const dir = path.join(temp, name); await fs.mkdir(dir);
    const file = path.join(dir, 'brush.zip'); await fs.writeFile(file, name); paths.push(file);
  }
  const cover = path.join(temp, 'image.png');
  await fs.writeFile(cover, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6L8AAAAASUVORK5CYII=', 'base64'));
  const id = await createLocalPack(archive, { title: 'My: pack', author: 'Me', description: 'Notes', version: '2', collections: ['brushes'] }, paths, cover);
  const [pack] = archive.data.products;
  assert.equal(pack.author, 'Me'); assert.equal(pack.release.name, '2'); assert.equal(pack.description, 'Notes');
  assert.deepEqual(await fs.readFile(path.join(archive.root, pack.cover)), await fs.readFile(cover));
  const { files: visible } = await diskFiles(archive.root, pack);
  assert.deepEqual(visible.sort(), ['files/brush (2).zip', 'files/brush.zip']);
  assert.equal(await fs.readFile(await diskFilePath(archive.root, pack, visible[0]), 'utf8'), 'two');
  assert.equal(await fs.readFile(paths[0], 'utf8'), 'one');
  finishFolder(folder, ['remote']); assert.deepEqual(folder.productIds, ['remote', id]);
});
test('a failed copy leaves no half-created pack and a retry succeeds', async t => {
  const { archive, temp } = await setup(t);
  await assert.rejects(createLocalPack(archive, { title: 'Pack' }, [path.join(temp, 'gone.zip')]), /ENOENT/);
  assert.deepEqual(await fs.readdir(archive.root), ['library.json']);
  assert.equal(archive.data.products.length, 0);
  await createLocalPack(archive, { title: 'Pack' });
  assert.equal(archive.data.products.length, 1);
});
test('purchased and legacy pack folders show disk changes without duplicating downloads', async t => {
  const { archive, temp } = await setup(t);
  const directory = 'products/Example--123';
  const remote = { id: '123', directory, files: [{ id: 'zip', state: 'pending', relativePath: directory + '/releases/1/files/pack.zip' }] };
  await archive.persistProduct(remote);
  const root = await packDirectory(archive.root, remote);
  await fs.mkdir(path.join(root, 'releases/1/files'), { recursive: true });
  await fs.mkdir(path.join(root, 'media'));
  for (const relative of ['releases/1/files/pack.zip','releases/1/files/pack.zip.part',
    'media/0123456789abcdef.jpg','media/notes.txt','releases/1/files/extra.zip','extra.zip']) {
    await fs.writeFile(path.join(root, relative), relative);
  }
  assert.deepEqual(await diskFiles(archive.root, remote), { files: ['extra.zip','media/notes.txt','releases/1/files/extra.zip'], available: ['zip'] });
  await fs.rename(path.join(root, 'extra.zip'), path.join(root, 'new.zip'));
  await fs.unlink(path.join(root, 'media/notes.txt'));
  assert.deepEqual((await diskFiles(archive.root, remote)).files, ['new.zip','releases/1/files/extra.zip']);
  assert.equal(await diskFilePath(archive.root, remote, 'new.zip'), path.join(root, 'new.zip'));
  await fs.symlink(temp, path.join(root, 'external'), 'junction');
  assert.deepEqual((await diskFiles(archive.root, remote)).files, ['new.zip','releases/1/files/extra.zip']);
  await assert.rejects(diskFilePath(archive.root, remote, '../other.zip'));
  await assert.rejects(diskFilePath(archive.root, remote, 'external/library/library.json'));
});

test('a failed catalog save rolls back the new pack and collection membership', async t => {
  const { archive } = await setup(t);
  const folder = { id: 'test', productIds: ['existing'], locallyEdited: false };
  archive.data.folders.push(folder);
  archive.save = async () => { throw Error('Simulated write failure'); };
  await assert.rejects(createLocalPack(archive, { title: 'Pack', collections: ['test'] }), /write failure/);
  assert.deepEqual(archive.data.products, []);
  assert.deepEqual(folder.productIds, ['existing']);
  assert.equal(folder.locallyEdited, false);
  assert.deepEqual(await fs.readdir(archive.root), ['library.json']);
});
