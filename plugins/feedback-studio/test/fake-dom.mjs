// A tiny page model for testing lib/anchor.mjs in Node, without a browser.
//
// It understands exactly the selectors and XPaths that lib/anchor.mjs itself
// writes (`#id`, `tag`, `tag:nth-of-type(n)` chains joined by " > ",
// `tag[attr="value"]`, `//*[@id="x"]`, `/body[1]/tag[i]/...`) and throws on
// anything else. That is on purpose: if the anchor module ever starts writing a
// selector this file cannot read, the anchor tests fail loudly instead of
// passing without checking anything.
//
// Build a page from literals:
//   const page = makePage(h('body', {}, [h('h1', { id: 'title' }, ['Hello']), h('p', {}, ['Text'])]));
//   page.dom            the adapter for createAnchoring()
//   page.find(pred)     first element node matching a predicate
//   page.byId('title')  an element by id
// Change the page between resolves with the mutation helpers on `page`.

export function h(tag, attrs = {}, children = []) {
  const node = { tag: String(tag).toLowerCase(), attrs: { ...attrs }, children: [], parent: null, hidden: false };
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent, child) {
  if (typeof child === 'string') { parent.children.push(child); return child; }
  child.parent = parent;
  parent.children.push(child);
  return child;
}

const isEl = (x) => !!x && typeof x === 'object' && typeof x.tag === 'string';

function textOf(node) {
  let s = '';
  for (const c of node.children) s += typeof c === 'string' ? c : textOf(c);
  return s;
}

function elementChildren(node) { return node.children.filter(isEl); }

function walk(node, out = []) {
  out.push(node);
  for (const c of elementChildren(node)) walk(c, out);
  return out;
}

function prevSibling(node) {
  if (!node.parent) return null;
  const sibs = elementChildren(node.parent);
  const i = sibs.indexOf(node);
  return i > 0 ? sibs[i - 1] : null;
}

const unescape = (s) => String(s).replace(/\\(.)/g, '$1');

export function makePage(body) {
  if (!isEl(body) || body.tag !== 'body') throw new Error('makePage wants an h("body", …) node');
  const html = h('html', {}, [body]);

  const all = () => walk(html).slice(1); // every element in document order, html itself excluded
  const byId = (id) => all().find((e) => e.attrs.id === id) || null;

  // One selector segment against a list of candidate elements.
  function matchSegment(seg, candidates) {
    let m;
    if ((m = /^#(.+)$/.exec(seg))) { const id = unescape(m[1]); return candidates.filter((e) => e.attrs.id === id); }
    if ((m = /^([a-z0-9]+)\[([a-z0-9-]+)="((?:[^"\\]|\\.)*)"\]$/.exec(seg))) {
      const val = unescape(m[3]);
      return candidates.filter((e) => e.tag === m[1] && e.attrs[m[2]] === val);
    }
    if ((m = /^([a-z0-9]+):nth-of-type\((\d+)\)$/.exec(seg))) {
      const tag = m[1], n = Number(m[2]);
      return candidates.filter((e) => {
        if (e.tag !== tag) return false;
        let i = 1, s = e;
        while ((s = prevSibling(s))) if (s.tag === tag) i++;
        return i === n;
      });
    }
    if ((m = /^([a-z0-9]+)$/.exec(seg))) return candidates.filter((e) => e.tag === m[1]);
    throw new Error('fake-dom cannot read selector segment: ' + seg);
  }

  function allBySelector(sel) {
    const segs = String(sel).split(' > ').map((s) => s.trim());
    // The first segment may match anywhere; each later one must be a direct child.
    let current = matchSegment(segs[0], all());
    for (const seg of segs.slice(1)) {
      const kids = current.flatMap((e) => elementChildren(e));
      current = matchSegment(seg, kids);
    }
    return current;
  }

  function byXPath(xp) {
    let m;
    if ((m = /^\/\/\*\[@id="([^"]*)"\]$/.exec(xp))) return byId(m[1]);
    if (!xp.startsWith('/')) throw new Error('fake-dom cannot read xpath: ' + xp);
    const segs = xp.slice(1).split('/');
    let current = [html];
    for (const seg of segs) {
      const sm = /^([a-z0-9]+)\[(\d+)\]$/.exec(seg);
      if (!sm) throw new Error('fake-dom cannot read xpath segment: ' + seg);
      const tag = sm[1], n = Number(sm[2]);
      current = current.flatMap((e) => elementChildren(e).filter((k) => k.tag === tag)).filter((k) => {
        let i = 1, s = k;
        while ((s = prevSibling(s))) if (s.tag === tag) i++;
        return i === n;
      });
      if (!current.length) return null;
    }
    return current[0] || null;
  }

  const visible = (el) => { for (let n = el; n; n = n.parent) if (n.hidden) return false; return true; };
  const contains = (a, b) => { for (let n = b; n; n = n.parent) if (n === a) return true; return false; };

  const dom = {
    bySelector: (sel) => allBySelector(sel)[0] || null,
    allBySelector,
    byXPath: (xp) => { try { return byXPath(xp); } catch (e) { return null; } },
    byTag: (tag) => all().filter((e) => e.tag === tag),
    all,
    body,
    root: html,
    isElement: isEl,
    text: textOf,
    visible,
    tag: (el) => el.tag,
    id: (el) => el.attrs.id || '',
    attr: (el, name) => (name in el.attrs ? el.attrs[name] : null),
    parent: (el) => (el.parent && el.parent !== html ? el.parent : (el.parent === html ? html : null)),
    prevSibling,
    contains,
  };

  // Mutation helpers for rot scenarios.
  const page = {
    dom, html, body, all, byId,
    find: (pred) => all().find(pred) || null,
    findAll: (pred) => all().filter(pred),
    // Put `node` in front of `ref` (both under the same parent).
    insertBefore(ref, node) {
      const p = ref.parent; const i = p.children.indexOf(ref);
      node.parent = p; p.children.splice(i, 0, node); return node;
    },
    insertAfter(ref, node) {
      const p = ref.parent; const i = p.children.indexOf(ref);
      node.parent = p; p.children.splice(i + 1, 0, node); return node;
    },
    append(parent, node) { return appendChild(parent, node); },
    remove(node) {
      const p = node.parent; const i = p.children.indexOf(node);
      if (i >= 0) p.children.splice(i, 1); node.parent = null; return node;
    },
    // Replace the element's own text (its string children) with new text.
    replaceText(node, text) {
      node.children = node.children.filter((c) => typeof c !== 'string');
      node.children.unshift(String(text)); return node;
    },
    // A copy of the element (same tag, attributes and text) placed right after it.
    duplicate(node) {
      const copy = clone(node); return page.insertAfter(node, copy);
    },
    hide(node) { node.hidden = true; return node; },
  };
  return page;
}

function clone(node) {
  const c = h(node.tag, node.attrs, []);
  for (const k of node.children) appendChild(c, typeof k === 'string' ? k : clone(k));
  return c;
}
