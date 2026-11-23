const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { detailSnapshot } = require('../app/site.cjs');
const { renderRichText } = require('../app/rich-text.js');
const { externalUrl } = require('../app/core.cjs');

function snapshot(html) {
  const { document } = parseHTML(`<div class="productPage-wrapper"><div class="product-description">${html}</div></div>`);
  return vm.runInNewContext(`(${detailSnapshot.toString()})()`, { document, URL,
    location: { href: 'https://www.artstation.com/marketplace/p/example/product' } });
}
function render(rich, open = () => {}) {
  const { document, window } = parseHTML('<html><body></body></html>');
  const fragment = renderRichText(document, rich, open);
  if (fragment) document.body.append(fragment);
  return { document, window, body: document.body, fragment };
}

test('description formatting and inline links survive JSON persistence and render in place', () => {
  const source = snapshot('<p><em>All packages by <a href="/artist"><strong>Example Art</strong></a></em></p><p><strong>KEY FEATURES</strong></p><ul><li><strong>75 assets</strong></li><li>Game ready<br>Customizable</li></ul>');
  const archived = JSON.parse(JSON.stringify(source));
  const opened = [];
  const { body, window } = render(archived.descriptionRich, url => opened.push(url));
  assert.equal(body.querySelector('p em a strong').textContent, 'Example Art');
  assert.equal(body.querySelectorAll('ul li').length, 2);
  assert.equal(body.querySelector('li strong').textContent, '75 assets');
  assert.ok(body.querySelector('li br'));
  const anchor = body.querySelector('a'), event = new window.Event('click', { cancelable: true });
  anchor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, ['https://www.artstation.com/artist']);
});

test('extraction drops executable content, attributes and remote embeds; unsafe links remain labels', () => {
  const rich = snapshot('<p onclick="bad()" style="color:red">Safe<script>bad()</script><iframe src="https://evil.example"></iframe><img src="https://evil.example/pixel"><svg onload="bad()"></svg><a href="javascript:bad()">Label</a><a>No URL</a></p>').descriptionRich;
  const encoded = JSON.stringify(rich);
  assert.doesNotMatch(encoded, /bad\(|evil|onclick|style/);
  const { body } = render(rich);
  assert.equal(body.textContent, 'SafeLabelNo URL');
  assert.equal(body.querySelectorAll('a[href]').length, 0);
  assert.equal(body.querySelectorAll('script,img,iframe,svg').length, 0);
});

test('renderer revalidates modified archive trees rather than trusting stored tags or URLs', () => {
  const { body } = render({ version: 1, nodes: [
    { tag: 'script', children: [{ text: 'bad()' }] },
    { tag: 'img', src: 'https://evil.example/image' },
    { tag: 'a', href: 'file:///C:/test', onclick: 'bad()', children: [{ text: 'File label' }] },
    { tag: 'p', style: 'background:url(https://evil.example)', children: [{ text: '<img onerror=bad()>' }] },
  ] });
  assert.equal(body.querySelectorAll('script,img,[style],[onclick],a[href]').length, 0);
  assert.match(body.textContent, /<img onerror=bad\(\)>/);
});

test('headings, numbered lists, tables, quotes and preformatted text keep their structure', () => {
  const { body } = render(snapshot('<h3>Setup</h3><ol start="3"><li value="5">Step</li></ol><blockquote>Note</blockquote><pre><code>A\n  B</code></pre><table><tr><td colspan="2">Cell</td></tr></table>').descriptionRich);
  assert.equal(body.querySelector('ol').getAttribute('start'), '3');
  assert.equal(body.querySelector('li').getAttribute('value'), '5');
  assert.equal(body.querySelector('td').getAttribute('colspan'), '2');
  assert.equal(body.querySelector('pre code').textContent, 'A\n  B');
  assert.equal(body.querySelector('h3').textContent, 'Setup');
  assert.equal(body.querySelector('blockquote').textContent, 'Note');
});

test('old descriptions use the plain-text fallback and external links only permit web schemes', () => {
  assert.equal(render(undefined).fragment, null);
  assert.equal(render({ version: 2, nodes: [] }).fragment, null);
  assert.equal(externalUrl('http://example.com/tutorial'), 'http://example.com/tutorial');
  assert.equal(externalUrl('https://example.com/tutorial'), 'https://example.com/tutorial');
  for (const url of ['javascript:alert(1)', 'file:///C:/test', 'data:text/html,test', 'https://user:pass@example.com/', 'shell:AppsFolder']) assert.throws(() => externalUrl(url));
});
