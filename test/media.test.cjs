const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../app/archive.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = new Archive(() => {}); await archive.open(root);
  return { root, archive };
}
test('CDN images served as octet-stream are saved and reused', async t => {
  const { root, archive } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6L8AAAAASUVORK5CYII=', 'base64');
  let calls = 0;
  const session = { fetch: async () => { calls++; return new Response(png, { headers: { 'Content-Type': 'binary/octet-stream' } }); } };
  const url = 'https://cdna.artstation.com/example.png';
  const relative = await archive.media(url, 'products/test/media', session);
  assert.deepEqual(await fs.readFile(path.join(root, relative)), png);
  assert.equal(await archive.media(url, 'products/test/media', session), relative);
  assert.equal(calls, 1);
});
test('HTML cannot masquerade as an image and a failed preview can be retried', async t => {
  const { root, archive } = await fixture(t);
  const url = 'https://cdna.artstation.com/example.jpg';
  const session = { fetch: async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'image/jpeg' } }) };
  await assert.rejects(archive.media(url, 'products/test/media', session), /unsupported preview/);
  assert.deepEqual(await fs.readdir(path.join(root, 'products/test/media')), []);
  session.fetch = async () => new Response(Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]));
  assert.ok(await archive.media(url, 'products/test/media', session));
});
