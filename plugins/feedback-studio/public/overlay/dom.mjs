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

export const { makePool, textRel, resolveWithConfidence, resolveAnchor, buildElementAnchor } = A;

// A text selection: the container is the element the selection sits in.
export function buildRangeAnchor(sel) { return buildRangeAnchorFromRange(sel.getRangeAt(0)); }
export function buildRangeAnchorFromRange(range) {
  let container = range.commonAncestorContainer;
  if (container.nodeType !== 1) container = container.parentElement;
  return A.buildRangeAnchor(container, range.toString());
}

export { norm };
