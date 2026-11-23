const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Diagnostics } = require('../app/diagnostics.cjs');
async function fixture(t, limit) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, logger: new Diagnostics(path.join(root, 'logs'), 'test-version', limit) };
}
test('logs preserve error context but remove URLs, credentials, paths and unapproved fields', async t => {
  const { logger } = await fixture(t);
  await logger.write('error', 'download.failed', { product: 'Example pack', file: 'Blender.zip', stage: 'await-download',
    error: Object.assign(Error('Failed https://cdn.example/private?token=TOP_SECRET token=SECOND_SECRET C:\\Users\\PrivateName\\file.zip'), { code: 'EACCES' }),
    cookies: 'COOKIE_SECRET', url: 'https://private.example/invoice', stack: 'SECRET_STACK' });
  await logger.write('error', 'headers.failed', { message: 'Cookie: COOKIE_TOKEN=COOKIE_VALUE\nAuthorization: Bearer BEARER_SECRET' });
  await logger.write('warning', 'site.product-not-ready', { modalTitle: 'Example - Standard License', expectedFiles: 2, fileRows: 1, downloadButtons: 1, filesReady: false, attempt: 2 });
  await logger.flush();
  const raw = await fs.readFile(logger.file(), 'utf8'), entry = JSON.parse(raw.split('\n')[0]);
  for (const secret of ['TOP_SECRET', 'SECOND_SECRET', 'PrivateName', 'COOKIE_SECRET', 'COOKIE_TOKEN', 'COOKIE_VALUE', 'BEARER_SECRET', 'SECRET_STACK', 'cdn.example', 'private.example']) assert.ok(!raw.includes(secret), secret);
  assert.equal(entry.product, 'Example pack'); assert.equal(entry.file, 'Blender.zip');
  assert.equal(entry.stage, 'await-download'); assert.equal(entry.code, 'EACCES');
  assert.equal(entry.version, 'test-version'); assert.ok(entry.time); assert.ok(entry.session);
  const modal = JSON.parse(raw.trim().split('\n').at(-1));
  assert.equal(modal.modalTitle, 'Example - Standard License'); assert.equal(modal.filesReady, false); assert.equal(modal.fileRows, 1);
});
test('concurrent records remain valid ordered JSON lines, with three bounded rotating files', async t => {
  const { logger } = await fixture(t, 450);
  await Promise.all(Array.from({ length: 30 }, (_, i) => logger.write('info', 'entry-' + i)));
  await logger.flush();
  const names = await fs.readdir(logger.directory);
  assert.deepEqual(names.sort(), ['diagnostics.1.log', 'diagnostics.2.log', 'diagnostics.log']);
  const records = [];
  for (const index of [2, 1, 0]) {
    const raw = await fs.readFile(logger.file(index), 'utf8');
    assert.ok(Buffer.byteLength(raw) <= 450);
    records.push(...raw.trim().split('\n').map(line => JSON.parse(line).event));
  }
  const numbers = records.map(event => Number(event.slice(6)));
  assert.equal(numbers.at(-1), 29);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});
test('log write failures do not reject operational writes and are reported when opening logs', async t => {
  const { root } = await fixture(t);
  const blocked = path.join(root, 'not-a-folder'); await fs.writeFile(blocked, 'keep');
  const logger = new Diagnostics(blocked, 'test');
  await assert.doesNotReject(logger.write('error', 'download.failed', { message: 'Example error' }));
  await assert.rejects(logger.flush(), /Could not write/);
  assert.equal(await fs.readFile(blocked, 'utf8'), 'keep');
});
test('factory reset clears all rotated logs but preserves unrelated files', async t => {
  const { logger } = await fixture(t, 250);
  for (let i = 0; i < 6; i++) await logger.write('info', 'entry-' + i);
  await fs.writeFile(path.join(logger.directory, 'unrelated.txt'), 'keep');
  await logger.clear();
  assert.deepEqual(await fs.readdir(logger.directory), ['unrelated.txt']);
  await logger.write('info', 'after-reset'); await logger.flush();
  assert.equal(JSON.parse((await fs.readFile(logger.file(), 'utf8')).trim()).event, 'after-reset');
});
