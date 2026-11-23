// Browser + Node test entry point. Archived content is always treated as untrusted.
(function (root) {
  function renderRichText(document, rich, openLink) {
    if (rich?.version !== 1 || !Array.isArray(rich.nodes)) return null;
    const allowed = new Set('p div span strong b em i u s del mark h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code br hr a table thead tbody tfoot tr th td'.split(' '));
    const fragment = document.createDocumentFragment();
    let remaining = 20000;
    function append(parent, nodes, depth = 0) {
      if (!Array.isArray(nodes) || depth > 60) return;
      for (const node of nodes) {
        if (--remaining < 0) return;
        if (!node || typeof node !== 'object') continue;
        if (typeof node.text === 'string') { parent.append(document.createTextNode(node.text)); continue; }
        if (!allowed.has(node.tag)) continue;
        const element = document.createElement(node.tag);
        if (node.tag === 'a' && typeof node.href === 'string') {
          try {
            const url = new URL(node.href);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
              element.setAttribute('href', url.href);
              element.addEventListener('click', event => { event.preventDefault(); openLink(url.href); });
              element.addEventListener('auxclick', event => { event.preventDefault(); if (event.button === 1) openLink(url.href); });
            }
          } catch { /* Unsupported links remain plain text. */ }
        }
        for (const attr of node.tag === 'ol' ? ['start'] : node.tag === 'li' ? ['value'] : ['td', 'th'].includes(node.tag) ? ['colspan', 'rowspan'] : []) {
          if (Number.isInteger(node[attr]) && Math.abs(node[attr]) <= 9999) element.setAttribute(attr, String(node[attr]));
        }
        append(element, node.children, depth + 1); parent.append(element);
      }
    }
    append(fragment, rich.nodes); return fragment;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderRichText };
  else root.archiverRichText = Object.freeze({ renderRichText });
})(globalThis);
