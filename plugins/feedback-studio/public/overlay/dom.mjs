// Feedback Studio — the browser side of anchoring.
//
// All the anchor logic lives in lib/anchor.mjs, which has no DOM of its own and
// reads the page through a small adapter. This file is that adapter for a real
// browser (test/fake-dom.mjs is the one for the Node test suite), plus the two
// Range wrappers only a browser can provide. Everything else re-exported here
// is the shared implementation, so what CI proves about anchoring is the same
// code the overlay runs.

import { createAnchoring, norm } from '/__feedback/lib/anchor.mjs';

export function browserDom() {
  return {
    bySelector: (sel) => document.querySelector(sel),
    allBySelector: (sel) => [...document.querySelectorAll(sel)],
    byXPath(xp) {
      try {
        const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue instanceof Element ? r.singleNodeValue : null;
      } catch (e) { return null; }
    },
    byTag: (tag) => [...document.querySelectorAll(tag)],
    all: () => [...document.querySelectorAll('*')],
    // Getters, not captured values: a live dev server can replace <body>, and
    // cssPath/xPath compare against it by identity on every call.
    get body() { return document.body; },
    get root() { return document.documentElement; },
    isElement: (x) => x instanceof Element,
    text: (el) => el.textContent,
    visible: (el) => el.getClientRects().length > 0,
    tag: (el) => el.nodeName.toLowerCase(),
    id: (el) => el.id || '',
    attr: (el, name) => (el.getAttribute ? el.getAttribute(name) : null),
    parent: (el) => el.parentElement,
    prevSibling: (el) => el.previousElementSibling,
    contains: (a, b) => a.contains(b),
    cssEscape: window.CSS && CSS.escape ? (s) => CSS.escape(s) : undefined,
  };
}

const A = createAnchoring(browserDom());

export const { makePool, textRel, resolveWithConfidence, resolveAnchor } = A;

// ---------- the popup an element sits in ----------
// A comment made inside a dialog, drawer, menu or popover records that
// container on the anchor as a short selector (`dialog.mnav`, `div#cart`),
// picked from the same semantics a page uses to build such a thing. The agent
// then knows to look for the element inside it, and the List can say "in a
// closed popup" instead of "pin lost" while it is shut. Ordinary page content
// gets no `layer` at all.
const LAYERS = 'dialog, [popover], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-modal="true"]';
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

export function layerOf(el) {
  const l = el instanceof Element ? el.closest(LAYERS) : null;
  if (!l || l === document.body || l === document.documentElement) return '';
  const tag = l.nodeName.toLowerCase();
  if (l.id) return tag + '#' + cssEsc(l.id);
  const cls = typeof l.className === 'string' ? l.className.trim().split(/\s+/)[0] : '';
  if (cls) return tag + '.' + cssEsc(cls);
  if (l.hasAttribute('popover')) return tag + '[popover]';
  const role = l.getAttribute('role');
  return role ? `${tag}[role="${role}"]` : tag;
}

// Is the anchor's container shut right now? True when it cannot be found, is a
// closed <dialog> or popover, or has no box on the page. False for an anchor
// without a layer.
export function layerClosed(anchor) {
  if (!anchor || !anchor.layer) return false;
  let l = null;
  try { l = document.querySelector(anchor.layer); } catch (e) { return false; }
  if (!l) return true;
  if (typeof HTMLDialogElement !== 'undefined' && l instanceof HTMLDialogElement) return !l.open;
  if (l.hasAttribute('popover')) { try { return !l.matches(':popover-open'); } catch (e) {} }
  return !l.getClientRects().length;
}

function withLayer(anchor, el) {
  const layer = layerOf(el);
  if (layer) anchor.layer = layer;
  return anchor;
}

export function buildElementAnchor(el) { return withLayer(A.buildElementAnchor(el), el); }

// A text selection: the container is the element the selection sits in.
export function buildRangeAnchor(sel) { return buildRangeAnchorFromRange(sel.getRangeAt(0)); }
export function buildRangeAnchorFromRange(range) {
  let container = range.commonAncestorContainer;
  if (container.nodeType !== 1) container = container.parentElement;
  return withLayer(A.buildRangeAnchor(container, range.toString()), container);
}

export { norm };
