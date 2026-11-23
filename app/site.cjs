// DOM contract isolated from storage/UI. Never execute scripts from saved pages.
// These selectors come from the supplied HTML and the observed live library.
const ORIGIN = 'https://www.artstation.com';
const LIBRARY_URL = ORIGIN + '/marketplace/library';

function accountSnapshot() {
  return document.querySelector('[aria-label="User Navigation"] a')?.getAttribute('href') || null;
}

function librarySnapshot() {
  const text = (root, selector) => root.querySelector(selector)?.textContent.trim() || '';
  const cards = [...document.querySelectorAll('#drop-area .marketplace-card')].map((el, index) => ({
    index, title: el.querySelector('.marketplace-card-thumbnail img')?.alt || text(el, '.marketplace-card-title'),
    author: text(el, '.marketplace-card-author-name').replace(/^by\s+/i, ''),
    coverUrl: el.querySelector('.marketplace-card-thumbnail img')?.src || '',
    avatarUrl: el.querySelector('.marketplace-card-author-avatar img')?.src || '',
  }));
  const folders = [...document.querySelectorAll('library-folder')].map((el, index) => {
    const digits = text(el, '.projects_count').replace(/[^0-9]/g, '');
    return { index, name: text(el, '.album-title'), count: digits ? Number(digits) : null };
  });
  const sectionName = text(document, '.portfolio-content-head .page-head-title');
  const account = document.querySelector('[aria-label="User Navigation"] a')?.getAttribute('href') || null;
  const grid = !!document.querySelector('#drop-area');
  const counter = document.querySelector('.portfolio-content-head .projects_count')?.textContent || '';
  const count = counter.match(/\b([\d,]+)\s+Products?\b/i);
  const displayedCount = count ? Number(count[1].replace(/,/g, '')) : null;
  const shell = !!document.querySelector('.portfolio-content-head') && folders.length > 0;
  const loading = !!document.querySelector('[aria-busy="true"], .loading-spinner, .spinner-border');
  const empty = !grid && !!account && shell && displayedCount === 0 && !loading;
  const hiddenButton = [...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'Hidden Products');
  const activeFilter = hiddenButton?.closest('.btn-group')?.querySelector('button.active')?.textContent.trim();
  return { cards, folders, account, ready: grid || empty, grid, empty, displayedCount, activeFilter, loading, sectionName,
    pageState: grid ? 'grid' : empty ? 'empty-library-section' : shell ? 'library-loading' : 'library-not-visible',
    expected: displayedCount };
}
function modalSnapshot() {
  const el = [...document.querySelectorAll('purchased-product-modal .modal')].find(node => getComputedStyle(node).display !== 'none');
  if (!el) return null;
  const text = selector => el.querySelector(selector)?.textContent.trim() || '';
  const links = [...el.querySelectorAll('a')];
  const link = label => links.find(a => a.textContent.includes(label))?.href || '';
  const select = el.querySelector('form-select2[formcontrolname="release"] select');
  const options = select ? [...select.options].map(o => ({ id: o.value, name: o.textContent.trim(), selected: o.selected })) : [];
  const selected = options.find(o => o.selected);
  const releaseLine = [...el.querySelectorAll('.d-flex')].find(e => e.textContent.trim().startsWith('Release:'));
  const files = [...el.querySelectorAll('.product-file-item')].map((row, index) => ({
    index, name: row.querySelector('.product-file-name')?.textContent.trim() || '',
    meta: row.querySelector('.product-file-meta')?.textContent.trim() || '',
    downloadable: [...row.querySelectorAll('button, a')].some(b => /Download/i.test(b.textContent)),
  }));
  const fileHeading = [...el.querySelectorAll('h2, h3, h4')].map(h => h.textContent.trim()).find(t => /^Files\s*\(/i.test(t));
  const count = fileHeading?.match(/^Files\s*\(\s*(\d+)\s*\)/i);
  const expectedFiles = count ? Number(count[1]) : null;
  return { route: location.href, title: text('.product-view-title'), author: text('.my-library-product-user'),
    authorUrl: el.querySelector('.my-library-product-user')?.href || '',
    avatarUrl: el.querySelector('.product-card-author img')?.src || '',
    coverUrl: el.querySelector('.product-cover-modal img')?.src || '',
    rating: text('.badge-rating'), license: text('license-title'), licenseText: text('license-popover .popover-body'),
    detailsUrl: link('View Details'), invoiceUrl: link('View Invoice'),
    release: { id: selected?.id || 'default', name: selected?.name || releaseLine?.textContent.replace('Release:', '').trim() || 'Current', options },
    releaseNotes: text('.product-view-well'), files, expectedFiles,
    filesReady: expectedFiles === null ? files.length > 0 : files.length === expectedFiles };
}
function detailSnapshot() {
  const area = document.querySelector('.productPage-wrapper');
  if (!area || (!area.querySelector('.product-description') && !area.querySelector('.image-gallery-lg'))) {
    const headings = [...document.querySelectorAll('h1,h2,h3,p')].map(node => node.textContent.trim().replace(/\s+/g, ' '));
    if (headings.includes('404') && headings.some(text => /^Page not found[.!]?$/i.test(text))) return { detailsState: 'unavailable' };
  }
  if (!area) return null;
  const description = area.querySelector('.product-description');
  // Store a small document tree, never executable page HTML or styles.
  const allowed = new Set('p div span strong b em i u s del mark h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code br hr a table thead tbody tfoot tr th td'.split(' '));
  const omitted = new Set('script style iframe object embed svg math form input button textarea select link meta img video audio source template noscript'.split(' '));
  let remaining = 20000;
  function readNodes(parent, depth = 0) {
    if (depth > 60) return [];
    return [...parent.childNodes].flatMap(node => {
      if (--remaining < 0) return [];
      if (node.nodeType === 3) return [{ text: node.textContent }];
      if (node.nodeType !== 1) return [];
      const tag = node.tagName.toLowerCase();
      if (omitted.has(tag)) return [];
      const children = readNodes(node, depth + 1);
      if (!allowed.has(tag)) return children;
      const result = { tag, children };
      if (tag === 'a' && node.getAttribute('href')) {
        try {
          const url = new URL(node.getAttribute('href'), location.href);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) result.href = url.href;
        } catch { /* Keep the label of unsupported links. */ }
      }
      for (const attribute of tag === 'ol' ? ['start'] : tag === 'li' ? ['value'] : ['td', 'th'].includes(tag) ? ['colspan', 'rowspan'] : []) {
        const value = node.getAttribute(attribute);
        if (value !== null && /^-?\d{1,4}$/.test(value)) result[attribute] = Number(value);
      }
      return [result];
    });
  }
  return {
    description: description?.innerText || '',
    descriptionRich: description ? { version: 1, nodes: readNodes(description) } : null,
    gallery: [...new Set([...area.querySelectorAll('.image-gallery-lg img')].map(i => i.src).filter(Boolean))],
    videos: [...new Set([...area.querySelectorAll('iframe')].map(i => i.src).filter(u => /^https:\/\/(www\.)?(youtube(?:-nocookie)?\.com|player\.vimeo\.com)\//.test(u)))],
    descriptionLinks: [...(description?.querySelectorAll('a') || [])].map(a => ({ text: a.textContent.trim(), url: a.href })).filter(a => /^https:\/\//.test(a.url)),
  };
}
function scrollLibrary(direction = 'down') {
  const grid = document.querySelector('#drop-area');
  if (!grid) return false;
  const page = document.scrollingElement || document.documentElement;
  let target = page;
  // Scroll the catalog's ancestor, never a sidebar or the product dialog.
  for (let node = grid; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
      target = node; break;
    }
  }
  const isPage = target === page;
  const viewport = (isPage ? window.innerHeight : target.clientHeight) || 600;
  const max = Math.max(0, target.scrollHeight - viewport);
  const current = isPage ? window.scrollY : target.scrollTop;
  const step = Math.max(120, Math.floor(viewport * .85));
  const next = direction === 'reset' ? 0 : direction === 'back' ? Math.max(0, current - step) : Math.min(max, current + step);
  if (isPage) window.scrollTo({ top: next, behavior: 'instant' });
  else target.scrollTop = next;
  // At an unchanged bottom scrollTo alone produces no event. Rechecking also
  // covers delayed initialization of the site's infinite-scroll listener.
  (isPage ? window : target).dispatchEvent(new Event('scroll'));
  return { atEnd: next >= max - 2, position: next, max, target: isPage ? 'page' : 'catalog' };
}
function siteAction(action, arg) {
  if (action === 'folder') {
    const folders = [...document.querySelectorAll('library-folder')];
    const folder = folders.find(el => el.querySelector('.album-title')?.textContent.trim() === arg);
    const link = folder?.querySelector('.album-link');
    if (!link) return false;
    link.click(); return true;
  }
  if (action === 'filter') { const node = [...document.querySelectorAll('main button')].find(b => b.textContent.trim() === arg); if (!node) return false; node.click(); return true; }
  if (action === 'open') {
    const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const card = [...document.querySelectorAll('#drop-area .marketplace-card')][arg.index];
    const title = card?.querySelector('.marketplace-card-thumbnail img')?.alt || card?.querySelector('.marketplace-card-title')?.textContent;
    const author = card?.querySelector('.marketplace-card-author-name')?.textContent.replace(/^\s*by\s+/i, '');
    if (!card || normalize(title) !== normalize(arg.title) || (arg.author != null && normalize(author) !== normalize(arg.author))) {
      throw new Error('The library card changed before it could be opened. Synchronize again to refresh the catalog.');
    }
    const button = card.querySelector('.marketplace-card-thumbnail-content');
    if (!button) return false;
    button.click(); return true;
  }
  if (action === 'close') {
    const modal = [...document.querySelectorAll('purchased-product-modal .modal')].find(node => getComputedStyle(node).display !== 'none');
    modal?.querySelector('.btn-close')?.click();
    return true;
  }
  if (action === 'download') {
    const row = [...document.querySelectorAll('purchased-product-modal .product-file-item')][arg];
    const button = [...(row?.querySelectorAll('button, a') || [])].find(b => /Download/i.test(b.textContent));
    if (!button) return false; button.click(); return true;
  }
  return false;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function purchaseIdentity(route) {
  try {
    const url = new URL(route);
    if (url.origin !== ORIGIN) return null;
    const match = url.pathname.match(/^\/marketplace\/library\/([^/]+)\/([^/]+)(?:\/|$)/);
    return match ? match[1] + '/' + match[2] : null;
  } catch { return null; }
}
class SiteAdapter {
  constructor(window, { now = Date.now, sleep = pause, log = () => {} } = {}) { this.window = window; this.now = now; this.sleep = sleep; this.log = log; }
  async evaluate(fn, ...args) {
    const url = new URL(this.window.webContents.getURL());
    if (url.origin !== ORIGIN) throw new Error('Please finish signing in to ArtStation.');
    return this.window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
  }
  async wait(fn, predicate, timeout = 25000, stopped = () => false) {
    const end = this.now() + timeout;
    while (this.now() < end) {
      if (stopped()) throw new Error('Import paused.');
      const result = await this.evaluate(fn);
      if (predicate(result)) return result;
      await this.sleep(250);
    }
    throw new Error('ArtStation did not finish loading. Check the sign-in window and retry.');
  }
  async library() { return this.evaluate(librarySnapshot); }
  async sidebar(stopped) {
    let last = '', since = 0;
    return this.wait(librarySnapshot, snapshot => {
      const folders = snapshot.folders;
      if (!snapshot.ready || snapshot.loading || !folders.some(f => f.name === 'All' && f.count !== null) ||
          !folders.every(f => f.name)) { last = ''; return false; }
      const signature = JSON.stringify(folders);
      if (last !== signature) { last = signature; since = this.now(); }
      return this.now() - since >= 1500;
    }, 45000, stopped);
  }
  async action(name, arg) {
    const result = name === 'scroll' ? await this.evaluate(scrollLibrary, arg) : await this.evaluate(siteAction, name, arg);
    if (!result) throw new Error(`ArtStation layout changed (${name}).`);
    return result;
  }
  async scan(expected, onProgress, stopped, hidden = false, section = null) {
    const known = Number.isInteger(expected) && expected >= 0;
    let previous = -1, result, atEnd = false, bottomSince = null, lastRetry = 0;
    let missingSince = null, resetScroll = true, scrollFailureSince = null;
    let replacements = 0;
    let matchingCards = null, matchingSince = 0;
    const started = this.now();
    while (this.now() - started < 30 * 60 * 1000) {
      if (stopped()) throw new Error('Import paused.');
      result = await this.library();
      const filterPending = hidden && (result.activeFilter !== 'Hidden Products' || result.loading);
      const sectionPending = section && (result.sectionName !== section || result.loading ||
        (known && (result.cards.length > expected || (result.displayedCount != null && result.displayedCount !== expected))));
      if (!result.ready || filterPending || sectionPending) {
        matchingCards = null;
        if (hidden || section) { previous = -1; atEnd = false; resetScroll = true; }
        if (missingSince === null) {
          missingSince = this.now();
          this.log('warning', 'site.library-wait', { stage: sectionPending ? 'folder-pending' : filterPending ? 'hidden-filter-pending' : result.pageState || 'library-not-visible', products: result.cards.length });
        }
        const seconds = Math.floor((this.now() - missingSince) / 1000);
        onProgress(Math.max(0, previous), { waitingSeconds: seconds, waitingForLibrary: true });
        if (this.now() - missingSince >= 45000) {
          this.log('error', 'site.library-unavailable', { stage: result.pageState || 'library-not-visible', displayedCount: result.displayedCount });
          throw new Error('The library section did not become ready within 45 seconds. Your saved products are kept. Retry synchronization; sign in again if requested.');
        }
        await this.sleep(500); continue;
      }
      if (missingSince !== null) {
        this.log('info', 'site.library-restored');
        missingSince = null; bottomSince = null;
      }
      if (resetScroll && !result.empty) {
        try { await this.action('scroll', 'reset'); resetScroll = false; scrollFailureSince = null; }
        catch (error) {
          scrollFailureSince ??= this.now();
          if (this.now() - scrollFailureSince >= 45000) {
            this.log('error', 'site.library-scroll-failed', { stage: 'reset-scroll', error });
            throw new Error('The library grid could not be prepared within 45 seconds. Retry synchronization.');
          }
          await this.sleep(500); continue;
        }
      }
      const count = result.cards.length, now = this.now();
      // The filter button can become active before ArtStation replaces the old grid.
      if (hidden && count < previous && ++replacements <= 3) {
        this.log('info', 'site.filtered-grid-replaced', { stage: 'Hidden Products', displayedCount: previous, products: count });
        previous = -1; atEnd = false; bottomSince = null; resetScroll = true;
        await this.sleep(500); continue;
      }
      if (count < previous || (known && count > expected)) throw new Error('The ArtStation catalog changed while being read. Synchronize again to retry.');
      if (count !== previous) { bottomSince = null; lastRetry = now; }
      onProgress(count, { waitingSeconds: bottomSince == null ? 0 : Math.floor((now - bottomSince) / 1000) });
      // A grid-less empty section must stay empty; zero may be transient during filter changes.
      if (known && count === expected && !result.empty) {
        if (!section) return result;
        const signature = JSON.stringify(result.cards.map(card => [card.title, card.author]));
        if (signature !== matchingCards) { matchingCards = signature; matchingSince = now; }
        if (now - matchingSince >= 1500) return result;
        await this.sleep(500); continue;
      }
      matchingCards = null;
      if (bottomSince != null && now - bottomSince >= 45000) {
        if (known && count !== expected) throw new Error(`Library incomplete: ${count} of ${expected} products loaded. ArtStation did not provide the next page within 45 seconds. Synchronize again to retry.`);
        return result; // Unknown filter count: only settle after repeated bottom checks.
      }
      if (result.empty) {
        atEnd = true; bottomSince ??= now; previous = count;
        await this.sleep(500); continue;
      }
      // Re-arm downward scrolling after waiting at the bottom. The back/down
      // movements are separated in time so the site observes both directions.
      if (atEnd && now - lastRetry >= 3000) {
        await this.action('scroll', 'back');
        await this.sleep(250);
        if (stopped()) throw new Error('Import paused.');
        lastRetry = this.now();
      }
      const scroll = await this.action('scroll', 'down');
      atEnd = scroll.atEnd;
      if (atEnd) bottomSince ??= this.now();
      else bottomSince = null;
      previous = count;
      await this.sleep(500);
    }
    throw new Error('Library scan exceeded its time limit; please retry.');
  }
  async waitProduct(title, stopped, expectedIdentity = null) {
    let last = null;
    try {
      return await this.wait(modalSnapshot, modal => {
        last = modal;
        const identity = purchaseIdentity(modal?.route);
        return modal && identity && (!expectedIdentity || identity === expectedIdentity) && modal.filesReady;
      }, 25000, stopped);
    } catch (error) {
      if (!stopped()) {
        const identity = purchaseIdentity(last?.route);
        const reason = !last ? 'modal-not-visible' : !identity ? 'purchase-route-not-ready' : expectedIdentity && identity !== expectedIdentity ? 'purchase-route-mismatch' : 'file-list-not-ready';
        this.log('warning', 'site.product-not-ready', { stage: reason, product: title, modalTitle: last?.title,
          license: last?.license, fileRows: last?.files?.length, expectedFiles: last?.expectedFiles,
          downloadButtons: last?.files?.filter(file => file.downloadable).length, filesReady: last?.filesReady, error });
        error.message += ` [${reason}; files=${last?.files?.length ?? 'unknown'}/${last?.expectedFiles ?? 'unknown'}]`;
      }
      throw error;
    }
  }
  async openCard(index, title, stopped = () => false, author = null) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped()) throw new Error('Import paused.');
      let stage = 'close-previous-modal';
      try {
        await this.action('close');
        await this.wait(modalSnapshot, m => !m, 5000, stopped);
        stage = 'click-card';
        await this.action('open', { index, title, author });
        stage = 'read-open-modal';
        return await this.waitProduct(title, stopped);
      } catch (error) {
        if (stage === 'close-previous-modal' && !stopped()) error.code = 'PREVIOUS_MODAL_STUCK';
        if (!stopped()) this.log('warning', 'site.open-card-attempt', { stage, product: title, attempt: attempt + 1, error });
        if (stopped() || attempt === 1) throw error;
        await this.sleep(750);
      }
    }
  }
  async openRoute(route, stopped = () => false) {
    const u = new URL(route);
    const identity = purchaseIdentity(route);
    if (!identity) throw new Error('Invalid product route.');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped()) throw new Error('Import paused.');
      try {
        await this.window.loadURL(u.href);
        return await this.waitProduct(null, stopped, identity);
      } catch (error) {
        if (!stopped()) this.log('warning', 'site.open-route-attempt', { attempt: attempt + 1, error });
        if (stopped() || attempt === 1) throw error;
        await this.sleep(750);
      }
    }
  }
}
module.exports = { ORIGIN, LIBRARY_URL, SiteAdapter, accountSnapshot, librarySnapshot, modalSnapshot, detailSnapshot, scrollLibrary, siteAction, pause, purchaseIdentity };
