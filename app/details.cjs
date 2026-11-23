const { ORIGIN, detailSnapshot } = require('./site.cjs');
const unavailableMessage = 'Product page is unavailable';
function unavailableDetails() {
  return { detailsState: 'unavailable', description: unavailableMessage, descriptionRich: null,
    descriptionLinks: [], gallery: [], videos: [] };
}
async function getProductDetails(product, load, { force = false } = {}) {
  if (!force && product.detailsState === 'unavailable') return unavailableDetails();
  return load();
}
async function readDetailsPage(window, adapter, url) {
  let status = null;
  const navigated = (_event, address, code) => {
    try { status = new URL(address).origin === ORIGIN ? code : null; } catch { status = null; }
  };
  window.webContents.on('did-navigate', navigated);
  try {
    try { await window.loadURL(url); }
    catch (error) { if (status === 404 || status === 410) return unavailableDetails(); throw error; }
    if (status === 404 || status === 410) return unavailableDetails();
    if (status >= 400) throw new Error(`Product page request failed (HTTP ${status}).`);
    const result = await adapter.wait(detailSnapshot,
      data => data && (data.detailsState === 'unavailable' || !!data.description || data.gallery?.length > 0), 12000);
    return result.detailsState === 'unavailable' ? unavailableDetails() : { ...result, detailsState: 'available' };
  } finally { window.webContents.removeListener('did-navigate', navigated); }
}
module.exports = { unavailableDetails, getProductDetails, readDetailsPage };
