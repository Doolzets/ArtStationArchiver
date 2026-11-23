const { randomUUID } = require('node:crypto');

function changeCollection(library, change) {
  const folders = library.folders;
  const index = folders.findIndex(f => f.id === change.folderId);
  const folder = folders[index];
  if (change.type !== 'create-folder' && !folder) throw new Error('Collection not found.');
  switch (change.type) {
    case 'create-folder':
    case 'rename-folder': {
      const name = String(change.name || '').trim().slice(0, 80);
      if (!name || folders.some(f => f !== folder && f.name === name)) throw new Error('Choose a unique collection name.');
      if (change.type === 'rename-folder') folder.name = name;
      else folders.push({ id: randomUUID(), name, productIds: [], locallyEdited: true });
      break;
    }
    case 'delete-folder':
      if (folder.sourceName) {
        library.deletedSourceFolders = [...new Set([...(library.deletedSourceFolders || []), folder.id])];
      }
      folders.splice(index, 1);
      break;
    case 'move-folder': {
      const target = folders.find(f => f.id === change.targetId);
      if (!target || !['before', 'after'].includes(change.position)) throw new Error('Invalid collection destination.');
      if (target === folder) break;
      folders.splice(index, 1);
      folders.splice(folders.indexOf(target) + (change.position === 'after' ? 1 : 0), 0, folder);
      break;
    }
    case 'add-to-folder':
      if (!library.products.some(p => p.id === change.productId)) throw new Error('Product not found.');
      if (!folder.productIds.includes(change.productId)) folder.productIds.push(change.productId);
      if (folder.excludedProductIds?.includes(change.productId)) {
        folder.excludedProductIds = folder.excludedProductIds.filter(id => id !== change.productId);
      }
      folder.locallyEdited = true;
      break;
    case 'remove-from-folder':
      if (!folder.productIds.includes(change.productId)) break;
      folder.productIds = folder.productIds.filter(id => id !== change.productId);
      if (folder.sourceName) {
        folder.excludedProductIds ??= [];
        folder.excludedProductIds.push(change.productId);
      }
      break;
    default:
      throw new Error('Unknown collection action.');
  }
}
module.exports = { changeCollection };
