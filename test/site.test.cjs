const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { SiteAdapter, librarySnapshot, modalSnapshot, detailSnapshot, siteAction, purchaseIdentity } = require('../app/site.cjs');
const purchaseRoute = 'https://www.artstation.com/marketplace/library/product/variant/item';
function clickCard(title, author, expected) {
  const { document } = parseHTML('<div id="drop-area"><div class="marketplace-card"><div class="marketplace-card-thumbnail"><img></div><div class="marketplace-card-author-name"></div><button class="marketplace-card-thumbnail-content">View</button></div></div>');
  document.querySelector('img').alt = title;
  document.querySelector('.marketplace-card-author-name').textContent = 'by ' + author;
  let clicks = 0; document.querySelector('button').addEventListener('click', () => clicks++);
  const run = () => vm.runInNewContext(`(${siteAction.toString()})('open', ${JSON.stringify({ index: 0, ...expected })})`, { document });
  return { run, clicks: () => clicks };
}
test('the exact scanned card and author are checked before clicking, independently of modal labels', () => {
  const correct = clickCard('Example\n Generator', 'Artist', { title: 'Example Generator', author: 'Artist' });
  assert.equal(correct.run(), true); assert.equal(correct.clicks(), 1);
  for (const [title, author] of [['Different pack', 'Artist'], ['Example Generator', 'Different seller']]) {
    const changed = clickCard(title, author, { title: 'Example Generator', author: 'Artist' });
    assert.throws(changed.run, /card changed/); assert.equal(changed.clicks(), 0);
  }
});
test('purchase identity uses product and purchased variant IDs, not a license name or URL slug', () => {
  assert.equal(purchaseIdentity(purchaseRoute), 'product/variant');
  assert.equal(purchaseIdentity(purchaseRoute.replace('/item', '/custom-slug?tab=files')), 'product/variant');
  assert.notEqual(purchaseIdentity(purchaseRoute.replace('/variant/', '/other/')), 'product/variant');
  for (const route of ['https://www.artstation.com/marketplace/library', 'https://www.artstation.com/marketplace/p/product/item', 'https://example.com/marketplace/library/product/variant/item']) assert.equal(purchaseIdentity(route), null);
});
test('opening a saved route rejects a different purchase variant even with identical names and files', async () => {
  let clock = 0;
  const adapter = new SiteAdapter({ loadURL: async () => {} }, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.evaluate = async () => ({ route: purchaseRoute.replace('/variant/', '/other/'), title: 'Same title', files: [], filesReady: true });
  await assert.rejects(adapter.openRoute(purchaseRoute), /purchase-route-mismatch/);
  adapter.evaluate = async () => ({ route: purchaseRoute.replace('/item', '/renamed'), title: 'Custom arbitrary license title', files: [], filesReady: true });
  assert.ok((await adapter.openRoute(purchaseRoute)).filesReady);
});
function extract(fn, html) {
  const { document } = parseHTML(html);
  return vm.runInNewContext(`(${fn.toString()})()`, { document, URL, location: { href: 'https://www.artstation.com/marketplace/library/test/1/item' }, getComputedStyle: () => ({ display: 'block' }) });
}
test('library extraction preserves page order and collects folders independently', () => {
  const result = extract(librarySnapshot, `<html><body><div aria-label="User Navigation"><a href="/test-user">Test</a></div><library-folder><div class="album-title">All</div><div class="projects_count">2 Products</div></library-folder><div id="drop-area">${['New','Old'].map(title => `<div class="marketplace-card"><div class="marketplace-card-thumbnail"><img alt="${title}" src="https://cdn.artstation.com/test.jpg"></div><div class="marketplace-card-author-name">by Test Artist</div></div>`).join('')}</div></body></html>`);
  assert.equal(result.cards[0].title, 'New'); assert.equal(result.cards[1].title, 'Old'); assert.equal(result.cards[0].author, 'Test Artist'); assert.equal(result.folders[0].count, 2);
});

test('a grid-less zero-product section needs an authenticated library shell', () => {
  const shell = '<library-folder><div class="album-title">All</div><div class="projects_count">2 Products</div></library-folder><div class="portfolio-content-head"><div class="projects_count">0 Products</div></div>';
  assert.equal(extract(librarySnapshot, shell).ready, false);
  const ready = extract(librarySnapshot, '<div aria-label="User Navigation"><a href="/artist">Profile</a></div>' + shell);
  assert.equal(ready.ready, true); assert.equal(ready.empty, true); assert.equal(ready.displayedCount, 0);
  assert.equal(extract(librarySnapshot, '<div aria-label="User Navigation"><a href="/artist">Profile</a></div>' + shell + '<div aria-busy="true"></div>').ready, false);
});

test('opens the named folder when the sidebar order changes and reads its heading', () => {
  const names = ['All', 'New folder', 'Brushes'];
  const html = names.map(n => `<library-folder><div class="album-link"><div class="album-title">${n}</div></div></library-folder>`).join('') +
    '<div class="portfolio-content-head"><h2 class="page-head-title">Brushes </h2></div>';
  const { document } = parseHTML(html);
  const clicked = [];
  for (const link of document.querySelectorAll('.album-link')) link.addEventListener('click', () => clicked.push(link.textContent));
  vm.runInNewContext(`(${siteAction.toString()})('folder', 'Brushes')`, { document });
  assert.deepEqual(clicked, ['Brushes']);
  assert.equal(extract(librarySnapshot, html).sectionName, 'Brushes');
});

test('the active library filter comes from the group containing Hidden Products', () => {
  const html = '<main><button class="active">Other</button><div class="btn-group"><button>All</button><button class="active"><span>Hidden Products</span></button></div></main>';
  assert.equal(extract(librarySnapshot, html).activeFilter, 'Hidden Products');
});
test('modal with a single release and link-document is not assumed to be a ZIP', () => {
  const result = extract(modalSnapshot, `<purchased-product-modal><div class="modal"><h3 class="product-view-title">Example product</h3><a href="https://www.artstation.com/marketplace/p/example/item">View Details</a><div class="d-flex">Release: 1.0</div><div class="product-file-item"><span class="product-file-name">Download_link</span><span class="product-file-meta">DOCX / 13 KB</span><button>Download</button></div></div></purchased-product-modal>`);
  assert.equal(result.release.name, '1.0'); assert.equal(result.files.length, 1); assert.equal(result.files[0].meta, 'DOCX / 13 KB'); assert.equal(result.files[0].downloadable, true);
});
test('details exclude recommendations and unrecognized embedded content', () => {
  const result = extract(detailSnapshot, `<div class="productPage-wrapper"><div class="product-description">Example description</div><div class="image-gallery-lg"><img src="https://cdn.artstation.com/a.jpg"></div><div class="recommendations"><img src="https://cdn.artstation.com/other.jpg"></div><iframe src="https://www.youtube.com/embed/test"></iframe><iframe src="https://evil.example/widget"></iframe></div>`);
  assert.equal(result.description, 'Example description'); assert.equal(result.gallery.length, 1); assert.equal(result.videos.length, 1);
});

test('file-list readiness handles explicit zero and waits for all advertised rows', () => {
  const wrap = body => `<purchased-product-modal><div class="modal"><h3 class="product-view-title">Example</h3>${body}</div></purchased-product-modal>`;
  assert.equal(extract(modalSnapshot, wrap('<h3>Files (0)</h3>')).filesReady, true);
  assert.equal(extract(modalSnapshot, wrap('')).filesReady, false);
  assert.equal(extract(modalSnapshot, wrap('<h3>Files (2)</h3><div class="product-file-item"><span class="product-file-name">One</span></div>')).filesReady, false);
});

test('a timed-out card is closed and retried; whitespace differences do not reject the loaded title', async () => {
  let clock = 0, opened = 0, current = null;
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.evaluate = async () => current;
  adapter.action = async name => {
    if (name === 'close') current = null;
    if (name === 'open') { opened++; current = { route: purchaseRoute, title: 'Leaf\n Generator', files: [], filesReady: opened === 2 }; }
    return true;
  };
  const modal = await adapter.openCard(0, 'Leaf Generator');
  assert.equal(opened, 2); assert.equal(modal.filesReady, true); assert.ok(clock >= 25000);
});

test('a modal without a purchased-product route is not accepted after a card click', async () => {
  let clock = 0, current = null;
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.evaluate = async () => current;
  adapter.action = async name => { current = name === 'open' ? { title: 'Other purchase', filesReady: true } : null; return true; };
  await assert.rejects(adapter.openCard(0, 'Expected purchase'), /did not finish loading/);
});



test('an arbitrary license suffix does not affect readiness', async () => {
  let clock = 0, current = null;
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.evaluate = async () => current;
  adapter.action = async action => {
    current = action === 'open' ? { route: purchaseRoute, title: 'Example Generator - Creator custom terms 2026', license: 'Something unrelated', filesReady: true } : null;
    return true;
  };
  assert.ok((await adapter.openCard(0, 'Example Generator')).filesReady);
  assert.equal(clock, 0);
});



test('a loaded purchase imports despite arbitrary differences in title and license labels', async () => {
  let clock = 0, current = null, opens = 0;
  const logs = [];
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; }, log: (...entry) => logs.push(entry) });
  adapter.evaluate = async () => current;
  adapter.action = async action => {
    if (action === 'close') current = null;
    if (action === 'open') {
      opens++;
      current = { route: purchaseRoute, title: 'Example Generator / Whatever the author calls it', license: '',
        files: [{ name: 'Generator.sbsar', downloadable: true }], expectedFiles: 1, filesReady: true };
    }
    return true;
  };
  const modal = await adapter.openCard(0, 'Example Generator');
  assert.equal(modal.files.length, 1); assert.equal(opens, 1); assert.equal(clock, 0); assert.equal(logs.length, 0);
  current = { ...modal, files: [], filesReady: false };
  await assert.rejects(adapter.waitProduct('Example Generator', () => false), /file-list-not-ready/);
});

test('modal extraction ignores a retained hidden modal before the visible product', () => {
  const { document } = parseHTML('<purchased-product-modal><div class="modal" hidden><h3 class="product-view-title">Old</h3></div><div class="modal"><h3 class="product-view-title">Current</h3><h3>Files (0)</h3></div></purchased-product-modal>');
  const result = vm.runInNewContext(`(${modalSnapshot.toString()})()`, { document, location: { href: 'https://www.artstation.com/marketplace/library/test/1/item' },
    getComputedStyle: node => ({ display: node.hasAttribute('hidden') ? 'none' : 'block' }) });
  assert.equal(result.title, 'Current'); assert.equal(result.filesReady, true);
});

test('close clicks the visible product modal when a hidden copy remains in the DOM', () => {
  const { document } = parseHTML('<purchased-product-modal><div class="modal" hidden><button class="btn-close"></button></div><div class="modal"><button class="btn-close"></button></div></purchased-product-modal>');
  const clicks = [];
  [...document.querySelectorAll('button')].forEach((button, i) => button.addEventListener('click', () => clicks.push(i)));
  vm.runInNewContext(`(${siteAction.toString()})('close')`, { document,
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block' }) });
  assert.deepEqual(clicks, [1]);
});

test('a previous modal that never closes is identified before any click on the next card', async () => {
  let clock = 0;
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.action = async action => assert.equal(action, 'close');
  adapter.evaluate = async () => ({ title: 'Previous product' });
  await assert.rejects(adapter.openCard(0, 'Next product'), { code: 'PREVIOUS_MODAL_STUCK' });
});

test('product timeouts log the actual title and file counts for each distinct failure', async () => {
  for (const [modal, reason] of [[null, 'modal-not-visible'],
    [{ title: 'Other', filesReady: true, files: [], expectedFiles: 0 }, 'purchase-route-not-ready'],
    [{ route: purchaseRoute, title: 'Expected', filesReady: false, files: [{ downloadable: true }], expectedFiles: 2 }, 'file-list-not-ready']]) {
    let clock = 0; const logs = [];
    const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; }, log: (level, event, data) => logs.push({ level, event, ...data }) });
    adapter.evaluate = async () => modal;
    await assert.rejects(adapter.waitProduct('Expected', () => false), new RegExp(reason));
    const record = logs[0]; assert.equal(record.event, 'site.product-not-ready'); assert.equal(record.stage, reason);
    if (modal) { assert.equal(record.modalTitle, modal.title); assert.equal(record.fileRows, modal.files.length); assert.equal(record.expectedFiles, modal.expectedFiles); }
  }
});
