const { key, safeName } = require('./core.cjs');
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
function cardKey(card) { return key(normalize(card.title) + '\n' + normalize(card.author)); }
function unresolvedDirectory(card) { return `${safeName(card.title, 65)}--unresolved-${cardKey(card)}`; }
function prepareCatalogGroups(library, sidebar) {
  const groups = [];
  for (const { name, count } of sidebar.filter(f => f.name !== 'All')) {
    const id = key('source-folder:' + name);
    let folder = library.folders.find(f => f.id === id);
    if (!folder) {
      folder = { id, name, sourceName: name, sourceMembers: [], productIds: [] };
      // Keep scanning source-only purchases even if their sidebar collection was deleted locally.
      if (!library.deletedSourceFolders?.includes(id)) library.folders.push(folder);
    }
    folder.sourceCount = count;
    folder.membersPending = true;
    groups.push({ name, folder, expected: count, hidden: false });
  }
  return [...groups,
    { name: 'All', folder: null, expected: sidebar.find(f => f.name === 'All').count, hidden: false },
    { name: 'Hidden Products', folder: null, expected: null, hidden: true }];
}
function finishFolder(folder, members) {
  const additions = folder.locallyEdited ? folder.productIds.filter(id => !(folder.sourceMembers || []).includes(id)) : [];
  const excluded = new Set(folder.excludedProductIds);
  folder.productIds = [...new Set([...members, ...additions])].filter(id => !excluded.has(id));
  folder.sourceMembers = members;
  folder.membersPending = false;
}
function cachedProduct(library, card) {
  const signature = cardKey(card);
  const matches = library.products.filter(p => p.source !== 'local' && (p.sourceKey === signature || (!p.sourceKey && cardKey(p) === signature)));
  return matches.length === 1 ? matches[0] : null;
}
function uniqueCardKeys(cards) {
  const keys = cards.map(cardKey);
  if (new Set(keys).size !== keys.length) throw new Error('Two cards have the same title and author. Import stopped to avoid merging different purchases.');
  return keys;
}
// The section scan supplies card identities; a reload can assign different DOM indices.
function recoveringCardReader({ cards, open, reload, stopped, log }) {
  const keys = uniqueCardKeys(cards);
  const byKey = rows => new Map(rows.map(card => [cardKey(card), card]));
  let current = byKey(cards), failures = 0;
  return async card => {
    const signature = cardKey(card);
    try {
      const modal = await open(current.get(signature));
      failures = 0;
      return modal;
    } catch (error) {
      if (stopped()) throw error;
      failures++;
      if (error.code !== 'PREVIOUS_MODAL_STUCK' && failures < 2) throw error;
      log('warning', 'catalog.reconnect', { product: card.title, error });
    }
    try {
      const fresh = await reload(card);
      if (stopped()) throw new Error('Import paused.');
      current = byKey(fresh);
      if (fresh.length !== keys.length || keys.some(key => !current.has(key))) {
        throw new Error('The products in this section changed during synchronization.');
      }
      const modal = await open(current.get(signature));
      failures = 0;
      log('info', 'catalog.reconnected', { product: card.title });
      return modal;
    } catch (cause) {
      if (stopped()) throw cause;
      const error = new Error(`Library recovery failed: ${cause.message} Synchronize library to resume from saved progress.`);
      error.code = 'CATALOG_UNAVAILABLE';
      log('error', 'catalog.reconnect-failed', { product: card.title, error });
      throw error;
    }
  };
}
function indexFolderCards(library, folder, cards) {
  const keys = uniqueCardKeys(cards);
  finishFolder(folder, cards.map((card, i) => cachedProduct(library, card)?.id || 'unresolved-' + keys[i]));
  return keys;
}
function resolveFolderMember(folders, from, to) {
  if (from === to) return;
  for (const folder of folders) {
    for (const field of ['productIds', 'sourceMembers', 'excludedProductIds']) {
      if (folder[field]?.includes(from)) folder[field] = [...new Set(folder[field].map(id => id === from ? to : id))];
    }
    if (folder.excludedProductIds?.includes(to) && folder.productIds.includes(to)) {
      folder.productIds = folder.productIds.filter(id => id !== to);
    }
  }
}
function applyPurchaseOrder(library, keys) {
  const ranks = new Map(keys.map((signature, index) => [signature, index]));
  const outsideAll = [];
  for (const product of library.products) {
    if (product.source === 'local') continue;
    const rank = ranks.get(product.sourceKey || cardKey(product));
    if (rank !== undefined) product.order = rank;
    else outsideAll.push(product);
  }
  // Keep archived purchases missing from the current All list behind its last card.
  outsideAll.sort((a, b) => a.order - b.order).forEach((p, i) => { p.order = keys.length + i; });
}
// Isolate per-product failures; persistence errors must still stop the run.
const coverWarning = 'Library cover could not be updated. Synchronize again to retry.';
async function saveCover(archive, product, url, session) {
  if (!url) return;
  // Commit the new source only after a validated image has been saved.
  const cover = await archive.media(url, product.directory + '/media', session);
  Object.assign(product, { cover, coverUrl: url });
}
async function readProduct({ archive, card, order, hidden, read, save, stopped, force = false, session }) {
  card = { index: card.index, title: card.title, author: card.author, coverUrl: card.coverUrl, avatarUrl: card.avatarUrl };
  const existing = cachedProduct(archive.data, card);
  if (!force && existing && (existing.metadataState === 'skipped' || await archive.metadataPresent(existing))) {
    if (existing.metadataState !== 'skipped' && session && card.coverUrl) {
      existing.warnings = (existing.warnings || []).filter(warning => warning !== coverWarning);
      try { await saveCover(archive, existing, card.coverUrl, session); }
      catch (error) { archive.log('warning', 'preview.failed', { product: existing.title, stage: 'cached-cover', error }); existing.warnings.push(coverWarning); }
    }
    Object.assign(existing, { sourceKey: cardKey(card), sourceCard: card, order, sourceHidden: hidden,
      hidden: existing.localHidden ?? hidden, sourcePresent: true });
    await archive.persistProduct(existing); archive.update({});
    return existing;
  }
  let modal;
  try { modal = await read(); }
  catch (error) {
    if (stopped() || error.code === 'CATALOG_UNAVAILABLE') throw error;
    archive.log('error', 'catalog.product-failed', { product: card.title, stage: 'read-product', error });
    const id = existing?.id || `unresolved-${cardKey(card)}`;
    const product = existing || { id, title: card.title, author: card.author, files: [],
      directory: unresolvedDirectory(card), metadataState: 'error' };
    Object.assign(product, { sourceKey: cardKey(card), sourceCard: card, order, sourceHidden: hidden,
      hidden: product.localHidden ?? hidden, sourcePresent: true,
      catalogError: 'Product could not be read after retrying. Use Re-sync to try this product again.',
      lastAttemptAt: new Date().toISOString() });
    if (!existing) archive.data.products.push(product);
    await archive.persistProduct(product); archive.update({});
    return product;
  }
  return save(modal, card, order, hidden);
}
module.exports = { cardKey, unresolvedDirectory, cachedProduct, prepareCatalogGroups, finishFolder,
  uniqueCardKeys, indexFolderCards, resolveFolderMember, applyPurchaseOrder, recoveringCardReader, readProduct, saveCover };
