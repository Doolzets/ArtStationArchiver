const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SiteAdapter, scrollLibrary } = require('../app/site.cjs');

function paginatedLibrary({ total = 332, delay = 7000, stalled = false } = {}) {
  let clock = 0, loaded = Math.min(50, total), pending = null;
  const actions = [], progress = [];
  const adapter = new SiteAdapter(null, { now: () => clock, sleep: async ms => { clock += ms; } });
  adapter.library = async () => {
    if (pending !== null && clock >= pending) { loaded = Math.min(total, loaded + 50); pending = null; }
    return { ready: true, cards: Array.from({ length: loaded }, (_, index) => ({ index, title: `Product ${index}` })) };
  };
  adapter.action = async (action, direction) => {
    actions.push([action, direction]);
    if (direction === 'down' && !stalled && loaded < total && pending === null) pending = clock + delay;
    return { atEnd: direction === 'down' };
  };
  return { adapter, actions, progress, now: () => clock, report: (count, status) => progress.push({ count, ...status }) };
}

test('reads all 332 products in batches of 50 even when each page takes longer than four seconds', async () => {
  const f = paginatedLibrary();
  const result = await f.adapter.scan(332, f.report, () => false);
  assert.equal(result.cards.length, 332);
  assert.equal(result.cards.at(-1).index, 331);
  assert.deepEqual([...new Set(f.progress.map(p => p.count))], [50, 100, 150, 200, 250, 300, 332]);
  assert.ok(f.actions.some(([, direction]) => direction === 'back'));
  assert.ok(f.progress.some(p => p.waitingSeconds >= 5));
});

test('a stalled first page fails explicitly instead of accepting an incomplete catalog', async () => {
  const f = paginatedLibrary({ stalled: true });
  await assert.rejects(f.adapter.scan(332, f.report, () => false), /50 of 332.*45 seconds/);
  assert.ok(f.now() >= 45000);
});

test('pause interrupts waiting for the next page without waiting for the timeout', async () => {
  const f = paginatedLibrary({ stalled: true });
  await assert.rejects(f.adapter.scan(332, f.report, () => f.now() >= 2000), /paused/);
  assert.ok(f.now() < 3000);
});

test('unknown-size filters wait for delayed batches before settling at the bottom', async () => {
  const f = paginatedLibrary({ total: 65 });
  const result = await f.adapter.scan(null, f.report, () => false);
  assert.equal(result.cards.length, 65);
});

test('switching to Hidden waits for the filter and accepts its replacement grid', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => {
    const t = f.now();
    const cards = t < 7000 ? Array(332).fill({ title: 'Old grid' })
      : t < 13000 ? [] : [{ title: 'Hidden item' }];
    return { ready: true, activeFilter: t < 3500 ? 'All' : 'Hidden Products', cards, empty: !cards.length };
  };
  const result = await f.adapter.scan(null, f.report, () => false, true);
  assert.deepEqual(result.cards, [{ title: 'Hidden item' }]);
  assert.ok(f.progress[0].waitingForLibrary);
  assert.ok(f.now() >= 58000);
});

test('a filter that stays on All cannot supply cards for Hidden Products', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: true, activeFilter: 'All', cards: [{ title: 'Visible' }] });
  await assert.rejects(f.adapter.scan(null, f.report, () => false, true), /45 seconds/);
  assert.equal(f.actions.length, 0);
});

test('the main catalog still rejects a shrinking grid', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: true, cards: Array(f.now() ? 2 : 50).fill({}) });
  await assert.rejects(f.adapter.scan(332, f.report, () => false), /catalog changed/);
});

test('an empty known catalog finishes without waiting for another page', async () => {
  const f = paginatedLibrary({ total: 0 });
  assert.equal((await f.adapter.scan(0, f.report, () => false)).cards.length, 0);
  assert.equal(f.now(), 0);
});

test('a library section that temporarily disappears is awaited before scanning resumes', async () => {
  const f = paginatedLibrary({ total: 60, delay: 1000 });
  const read = f.adapter.library.bind(f.adapter);
  f.adapter.library = async () => f.now() < 4000 ? { ready: false, cards: [], pageState: 'library-loading' } : read();
  assert.equal((await f.adapter.scan(60, f.report, () => false)).cards.length, 60);
  assert.ok(f.progress.some(p => p.waitingForLibrary));
  assert.ok(f.now() >= 4000);
});

test('a missing library is not accepted as an empty filter and stops after a bounded wait', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: false, cards: [], pageState: 'library-not-visible' });
  await assert.rejects(f.adapter.scan(null, f.report, () => false), /45 seconds/);
  assert.ok(f.now() >= 45000 && f.now() < 46000);
  assert.equal(f.actions.length, 0);
});

test('an explicitly empty section without a grid settles without scrolling', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: true, empty: true, cards: [], displayedCount: 0 });
  assert.equal((await f.adapter.scan(null, f.report, () => false)).cards.length, 0);
  assert.ok(f.now() >= 45000); assert.equal(f.actions.length, 0);
});

test('an empty loading placeholder does not hide products that appear later', async () => {
  const f = paginatedLibrary({ total: 2 });
  const read = f.adapter.library.bind(f.adapter);
  f.adapter.library = async () => f.now() < 8000 ? { ready: true, empty: true, cards: [] } : read();
  assert.equal((await f.adapter.scan(2, f.report, () => false)).cards.length, 2);
});

test('waiting for the library section can be paused', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: false, cards: [] });
  await assert.rejects(f.adapter.scan(null, f.report, () => f.now() >= 1000), /paused/);
  assert.equal(f.now(), 1000);
});

test('initial sidebar can receive custom folders after All appears', async () => {
  const f = paginatedLibrary();
  f.adapter.evaluate = async () => ({ ready: true, folders: [
    { name: 'All', count: 35 }, ...(f.now() < 1000 ? [] : [{ name: 'Brushes', count: 4 }])] });
  const result = await f.adapter.sidebar(() => false);
  assert.equal(result.folders[1].name, 'Brushes');
  assert.ok(f.now() >= 2500);
});

test('named folder waits for its heading and refreshed cards even with equal folder counts', async () => {
  const f = paginatedLibrary();
  f.adapter.library = async () => ({ ready: true, displayedCount: 1, sectionName: f.now() < 1000 ? 'All' : 'Brushes',
    cards: [{ title: f.now() < 1500 ? 'Old list' : 'Folder item', author: 'Artist' }] });
  const result = await f.adapter.scan(1, f.report, () => false, false, 'Brushes');
  assert.equal(result.cards[0].title, 'Folder item');
});

test('a grid that disappears between snapshot and initial scroll is retried with a time limit', async () => {
  const f = paginatedLibrary();
  f.adapter.action = async () => { throw Error('Grid unavailable'); };
  await assert.rejects(f.adapter.scan(332, f.report, () => false), /grid could not be prepared within 45 seconds/);
  assert.ok(f.now() < 46000);
});

function scrollFixture(nested) {
  const events = [], calls = [];
  const page = { scrollHeight: nested ? 600 : 4000 };
  const body = { parentElement: page };
  const container = { parentElement: body, overflowY: nested ? 'auto' : 'visible', scrollHeight: 4000, clientHeight: 600, scrollTop: 0,
    dispatchEvent: e => events.push(['catalog', e.type]) };
  const grid = { parentElement: container, overflowY: 'visible', scrollHeight: 4000, clientHeight: 4000 };
  const document = { scrollingElement: page, documentElement: page, body, querySelector: selector => selector === '#drop-area' ? grid : null };
  const window = { innerHeight: 600, scrollY: 0, scrollTo: ({ top }) => { calls.push(top); window.scrollY = top; }, dispatchEvent: e => events.push(['page', e.type]) };
  const context = { document, window, getComputedStyle: node => ({ overflowY: node.overflowY }), Event: class { constructor(type) { this.type = type; } } };
  const scroll = direction => vm.runInNewContext(`(${scrollLibrary.toString()})(${JSON.stringify(direction)})`, context);
  return { scroll, container, window, events, calls };
}

test('scrolls a nested catalog instead of the outer page and can re-arm the bottom', () => {
  const f = scrollFixture(true);
  for (let i = 0; i < 8; i++) f.scroll('down');
  assert.equal(f.container.scrollTop, 3400); assert.equal(f.calls.length, 0);
  assert.equal(f.scroll('back').atEnd, false);
  assert.equal(f.scroll('down').atEnd, true);
  assert.ok(f.events.every(([target]) => target === 'catalog'));
  f.scroll('reset'); assert.equal(f.container.scrollTop, 0);
});

test('falls back to the document and still emits a scroll event at an unchanged bottom', () => {
  const f = scrollFixture(false);
  for (let i = 0; i < 8; i++) f.scroll('down');
  assert.equal(f.window.scrollY, 3400);
  const before = f.events.length;
  assert.equal(f.scroll('down').atEnd, true);
  assert.equal(f.events.length, before + 1);
  assert.deepEqual(f.events.at(-1), ['page', 'scroll']);
});
