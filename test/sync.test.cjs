const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Synchronizer } = require('../app/sync.cjs');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const events = [], states = [];
  const sync = new Synchronizer({
    publish: s => states.push(s),
    authenticate: async () => events.push('sign-in'),
    catalog: async () => events.push('catalog'),
    files: async () => events.push('files'),
    resumeFiles: async () => events.push('resume'),
    pause: () => events.push('pause'), ...overrides,
  });
  return { sync, events, states };
}
test('one synchronization waits for login, imports catalog, then downloads', async () => {
  const gate = deferred();
  const f = fixture({ authenticate: () => gate.promise });
  const running = f.sync.start(true);
  assert.equal(f.sync.running, true); assert.deepEqual(f.events, []);
  await f.sync.start(); // A second click must not start a competing run.
  gate.resolve(); await running;
  assert.deepEqual(f.events, ['catalog', 'files']);
  assert.equal(f.sync.running, false); assert.equal(f.states.at(-1).busy, false);
});
test('pausing discovery does not fall through into file downloads', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ catalog: async () => { entered.resolve(); await gate.promise; } });
  const running = f.sync.start(); await entered.promise;
  f.sync.pause(); gate.resolve(); await running;
  assert.ok(!f.events.includes('files'));
  assert.equal(f.states.at(-1).phase, 'paused');
});
test('resuming an active download keeps its current queue', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ files: async () => { entered.resolve(); await gate.promise; } });
  const running = f.sync.start(); await entered.promise;
  f.sync.pause(); await f.sync.start();
  assert.equal(f.events.filter(e => e === 'catalog').length, 1);
  assert.ok(f.events.includes('resume'));
  gate.resolve(); await running;
  assert.equal(f.sync.running, false);
});
test('failed sign-in stops the pipeline and allows a later retry', async () => {
  const f = fixture({ authenticate: async () => { throw new Error('Sign-in closed'); } });
  await f.sync.start();
  assert.deepEqual(f.events, []); assert.equal(f.sync.running, false);
  assert.ok(f.states.some(s => s.phase === 'error' && s.message === 'Sign-in closed'));
  f.sync.tasks.authenticate = async () => {};
  await f.sync.start(); assert.deepEqual(f.events, ['catalog', 'files']);
});

test('Re-sync bypasses full catalog and scopes deep file verification to the resolved product', async () => {
  let scope;
  const f = fixture({ catalog: () => assert.fail('Full catalog should not run'),
    product: async id => { assert.equal(id, 'placeholder'); return 'resolved'; },
    files: async (ids, deep) => { scope = { ids, deep }; } });
  await f.sync.start(false, 'placeholder');
  assert.deepEqual(scope, { ids: ['resolved'], deep: true });
});
