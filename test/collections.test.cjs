const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { Archive } = require('../app/archive.cjs');
const { changeCollection } = require('../app/collections.cjs');
const { prepareCatalogGroups, finishFolder, resolveFolderMember } = require('../app/catalog.cjs');
const { createFolderSidebar, productDragType, folderDragType } = require('../app/folder-sidebar.js');

test('local collection edits and order survive restart and sync without changing purchases', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const archive = new Archive(() => {}); await archive.open(temp);
  const data = archive.data, sidebar = [{name:'All', count:2}, {name:'Brushes', count:1}, {name:'Textures', count:0}];
  const [brushes, textures] = prepareCatalogGroups(data, sidebar).map(g => g.folder);
  data.products.push({id:'b', order:1}, {id:'a', order:0}, {id:'own', source:'local'});
  const originalProducts = structuredClone(data.products);
  finishFolder(brushes, ['b']);
  changeCollection(data, { type:'create-folder', name:'Mix' });
  const mix = data.folders.at(-1);
  for (const id of ['own','a','a']) changeCollection(data, { type:'add-to-folder', folderId:brushes.id, productId:id });
  changeCollection(data, { type:'rename-folder', folderId:brushes.id, name:' Tools ' });
  changeCollection(data, { type:'move-folder', folderId:mix.id, targetId:brushes.id, position:'before' });
  changeCollection(data, { type:'move-folder', folderId:textures.id, targetId:mix.id, position:'after' });
  assert.deepEqual(data.folders.map(f => f.name), ['Mix', 'Textures', 'Tools']);
  changeCollection(data, { type:'delete-folder', folderId:textures.id });
  await archive.save(); await archive.open(temp);
  const groups = prepareCatalogGroups(archive.data, sidebar);
  finishFolder(groups[0].folder, ['b']);
  assert.deepEqual(archive.data.folders.map(f => f.name), ['Mix','Tools']);
  assert.deepEqual(archive.data.folders[1].productIds, ['b','own','a']);
  assert.deepEqual(archive.data.products, originalProducts);
  assert.equal(groups[0].name, 'Brushes');
  for (const name of ['', 'Mix']) assert.throws(() => changeCollection(archive.data, {type:'rename-folder', folderId:brushes.id, name}));
  assert.throws(() => changeCollection(archive.data, {type:'delete-folder', folderId:'@local-packs'}));
});

test('a removed pack stays out of its collection across restart, sync and purchase ID resolution', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-removal-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const archive = new Archive(() => {});
  await archive.open(temp);
  const sidebar = [{ name: 'All', count: 2 }, { name: 'Brushes', count: 2 }];
  const [{ folder: brushes }] = prepareCatalogGroups(archive.data, sidebar);
  const products = [{ id: 'unresolved-brush' }, { id: 'other-brush' }, { id: 'own', source: 'local' }];
  archive.data.products.push(...structuredClone(products));
  finishFolder(brushes, ['unresolved-brush', 'other-brush']);
  changeCollection(archive.data, { type: 'create-folder', name: 'Mix' });
  const mix = archive.data.folders.at(-1);
  for (const productId of ['unresolved-brush', 'own']) {
    changeCollection(archive.data, { type: 'add-to-folder', folderId: mix.id, productId });
  }
  const removeBrush = { type: 'remove-from-folder', folderId: brushes.id, productId: 'unresolved-brush' };
  changeCollection(archive.data, removeBrush);
  changeCollection(archive.data, removeBrush);
  changeCollection(archive.data, { type: 'remove-from-folder', folderId: mix.id, productId: 'own' });
  assert.deepEqual(brushes.productIds, ['other-brush']);
  assert.deepEqual(brushes.excludedProductIds, ['unresolved-brush']);
  assert.deepEqual(mix.productIds, ['unresolved-brush']);
  assert.deepEqual(archive.data.products, products);

  await archive.save();
  await archive.open(temp);
  const [{ folder: synced }] = prepareCatalogGroups(archive.data, sidebar);
  finishFolder(synced, ['unresolved-brush', 'other-brush']);
  assert.deepEqual(synced.productIds, ['other-brush']);
  assert.deepEqual(archive.data.folders.find(folder => folder.id === mix.id).productIds, ['unresolved-brush']);

  archive.data.products[0].id = 'brush';
  resolveFolderMember(archive.data.folders, 'unresolved-brush', 'brush');
  finishFolder(synced, ['brush', 'other-brush']);
  assert.deepEqual(synced.productIds, ['other-brush']);
  assert.deepEqual(archive.data.folders.find(folder => folder.id === mix.id).productIds, ['brush']);
  changeCollection(archive.data, { type: 'add-to-folder', folderId: synced.id, productId: 'brush' });
  finishFolder(synced, ['brush', 'other-brush']);
  assert.deepEqual(synced.productIds, ['brush', 'other-brush']);
});

test('sidebar distinguishes pack drops from grip moves and preserves an open title editor on refresh', async () => {
  const { document, Event } = parseHTML('<nav></nav>');
  const nav = document.querySelector('nav'), changes = [];
  const render = createFolderSidebar(nav, {select() {}, organize: async c => { changes.push(c); },
    confirmDelete: () => false, reportError: assert.fail});
  const folders = [{id:null,name:'All'}, {id:'x',name:'First',editable:true}, {id:'y',name:'Second',editable:true}];
  render(folders, null);
  assert.equal(nav.querySelectorAll('.collection-icon use[href="#collection-folder-shape"]').length, folders.length);
  assert.ok(nav.firstElementChild.querySelector('.folder.active .collection-icon'));
  const row = nav.children[1], bar = row.firstElementChild;
  assert.equal(nav.firstElementChild.querySelector('.collection-edit'), null);
  bar.getBoundingClientRect = () => ({top:10,height:40});
  function drag(target, type, mime, data, y) {
    const event = new Event(type, {bubbles:true,cancelable:true});
    const transfer = {types:[mime], getData: k => k === mime ? data : '', setData(k,v) { this.sent = [k,v]; }};
    Object.assign(event, {dataTransfer:transfer, clientY:y}); target.dispatchEvent(event); return transfer;
  }
  assert.deepEqual(drag(row.querySelector('.collection-grip'), 'dragstart', '', '', 0).sent, [folderDragType,'x']);
  drag(bar,'drop',productDragType,'own',30);
  drag(bar,'drop',folderDragType,'y',12);
  drag(bar,'drop',folderDragType,'y',48);
  drag(bar,'drop','text/plain','unrelated',10);
  assert.deepEqual(changes, [
    {type:'add-to-folder',folderId:'x',productId:'own'},
    {type:'move-folder',folderId:'y',targetId:'x',position:'before'},
    {type:'move-folder',folderId:'y',targetId:'x',position:'after'}]);
  document.defaultView.HTMLInputElement.prototype.select = () => {};
  row.querySelector('.collection-edit').click();
  const input = row.querySelector('input'); input.value = 'New title';
  render(folders.map(f => ({...f, label:'2 Products'})), 'x');
  assert.ok(row.querySelector('.folder.active .collection-icon'));
  assert.equal(nav.firstElementChild.querySelector('.folder.active'), null);
  assert.equal(row.querySelector('input'), input);
  row.querySelector('.collection-delete').click();
  assert.equal(changes.length, 3);
  row.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true}));
  await Promise.resolve();
  assert.deepEqual(changes.at(-1), {type:'rename-folder',folderId:'x',name:'New title'});
  assert.equal(row.querySelector('form'), null);
});
