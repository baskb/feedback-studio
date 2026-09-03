// Feedback Studio — anchoring: how a comment remembers its element, and how it
// finds it again later.
//
// This module has no DOM of its own. Everything it needs from the page comes in
// through a small `dom` adapter (see `createAnchoring` below), so the same code
// runs in the browser (public/overlay/dom.mjs wraps `document`) and in the Node
// test suite (test/fake-dom.mjs builds a page from a literal). That is how the
// tool's central promise is checked in CI: an anchor must refuse to guess.
//
// An anchor stores several independent ways of finding the element: a stable
// attribute or id selector, a CSS nth-of-type path, an XPath, and a quoted text
// snippet. On resolve every strategy runs and votes. The CSS path and the XPath
// are two encodings of the SAME position, so they rot together after an edit
// and count as one "structural" family. Only a genuinely independent family
// agreeing (a stable attribute, or the text) earns "high" confidence. "low" and
// "none" mean: do not edit, ask for a re-pin.

// The adapter every function reads the page through. All methods are synchronous.
//   bySelector(sel)      first element matching a CSS selector, or null (may throw on a bad selector)
//   allBySelector(sel)   every element matching a CSS selector (array; may throw)
//   byXPath(xp)          first element for an XPath, or null (never throws)
//   byTag(tag)           every element with this tag name (array)
//   all()                every element in document order (array)
//   body                 the body element
//   root                 the document element (html)
//   isElement(x)         true for an element node
//   text(el)             the element's textContent
//   visible(el)          true when the element has a box on screen
//   tag(el)              lower-case tag name
//   id(el)               the id attribute or ''
//   attr(el, name)       an attribute value or null
//   parent(el)           the parent element or null
//   prevSibling(el)      the previous element sibling or null
//   contains(a, b)       true when a is b or an ancestor of b
//   cssEscape(s)         optional; CSS.escape when the platform has it

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// A built anchor with no text gets a "<tag>" placeholder snippet, not real text.
export const isPlaceholderSnippet = (s) => !s || /^<[a-z0-9]+>$/i.test(s);

// Attributes that identify an element on purpose, most trustworthy first.
const STABLE_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-id', 'id', 'name'];

export function createAnchoring(dom) {
  const cssEsc = (s) => (dom.cssEscape ? dom.cssEscape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const count = (sel) => { try { return dom.allBySelector(sel).length; } catch (e) { return 0; } };
  const uniqueId = (id) => !!id && count('#' + cssEsc(id)) === 1;

  // The element's position as a CSS path, stopping at the first unique id.
  function cssPath(el) {
    if (!dom.isElement(el)) return '';
    if (el === dom.body) return 'body';
    const parts = [];
    let node = el;
    while (node && node !== dom.root) {
      if (node === dom.body) { parts.unshift('body'); break; }
      const id = dom.id(node);
      if (uniqueId(id)) {
        parts.unshift('#' + cssEsc(id));
        return parts.join(' > ');
      }
      const tag = dom.tag(node);
      let nth = 1, sib = node;
      while ((sib = dom.prevSibling(sib))) if (dom.tag(sib) === tag) nth++;
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = dom.parent(node);
    }
    return parts.join(' > ');
  }

  // A stable attribute selector (test ids, name, unique id), if one resolves uniquely.
  function stableAttrSelector(el) {
    const tag = dom.tag(el);
    for (const a of STABLE_ATTRS) {
      const v = dom.attr(el, a);
      if (!v) continue;
      const sel = a === 'id' ? '#' + cssEsc(v) : tag + '[' + a + '="' + String(v).replace(/"/g, '\\"') + '"]';
      if (count(sel) === 1) return sel;
    }
    return '';
  }

  function xPath(el) {
    if (!dom.isElement(el)) return '';
    const id = dom.id(el);
    if (uniqueId(id)) return '//*[@id="' + id + '"]';
    const segs = [];
    for (let node = el; node && dom.isElement(node); node = dom.parent(node)) {
      const tag = dom.tag(node);
      let i = 1;
      for (let sib = dom.prevSibling(node); sib; sib = dom.prevSibling(sib)) if (dom.tag(sib) === tag) i++;
      segs.unshift(tag + '[' + i + ']');
      if (node === dom.body) break;
    }
    return '/' + segs.join('/');
  }

  // One resolve pass looks up every comment; cache the all-elements scan so the
  // text fallback does not walk the whole page once per comment.
  function makePool() {
    let all = null;
    return { all() { if (!all) { try { all = dom.all(); } catch (e) { all = []; } } return all; } };
  }

  // Find an element by its quoted text. Returns { el, ambiguous }: `ambiguous`
  // is true when the text is found on more than one separate element of the
  // recorded tag, in which case `el` is only the first of them and the caller
  // must not treat it as a sure find.
  function byText(snip, tag, pool) {
    if (!snip) return { el: null, ambiguous: false };
    const t = norm(snip).slice(0, 80).toLowerCase(); // case-insensitive: text-transform shifts on-screen case
    let list;
    if (tag && tag !== 'body') {
      try { list = dom.byTag(tag); } catch (e) { list = pool ? pool.all() : dom.all(); }
    } else {
      list = pool ? pool.all() : dom.all();
    }
    const textOf = (e) => norm(dom.text(e)).toLowerCase();
    let hits = list.filter((e) => textOf(e).startsWith(t) && dom.visible(e));
    if (!hits.length) hits = list.filter((e) => textOf(e).includes(t) && dom.visible(e));
    // A wrapper and the element inside it carry the same text once, not twice:
    // keep only the innermost hits. What is left are genuinely separate
    // occurrences (two "Submit" buttons, repeated "Read more" links).
    const inner = hits.filter((e) => !hits.some((o) => o !== e && dom.contains(e, o)));
    return { el: inner[0] || null, ambiguous: inner.length > 1 };
  }

  // How well an element's text corroborates the stored snippet.
  //   strong = text starts with the snippet (the element itself, not a wrapper)
  //   weak   = snippet is buried inside much larger text (likely an over-broad ancestor)
  //   none   = snippet not present at all
  function textRel(el, snip) {
    if (!snip) return 'strong';
    const a = norm(dom.text(el)).toLowerCase();
    const b = norm(snip).toLowerCase().slice(0, 80);
    if (!b) return 'strong';
    if (a.startsWith(b)) return 'strong';
    if (a.includes(b)) return a.length <= b.length * 1.6 ? 'strong' : 'weak';
    return 'none';
  }

  // Resolve an anchor with a confidence tier. Returns { el, confidence, ambiguous }.
  //   high    edit with confidence
  //   medium  the text is there but not a clean match: re-check before editing
  //   low     only the position matched, which rots after edits: ask for a re-pin
  //   null    nothing found (the caller treats it as "none")
  function resolveWithConfidence(a, pool) {
    if (!a) return { el: null, confidence: null, ambiguous: false };
    const rawSnip = a.snippet || a.rangeText;
    const hasText = !isPlaceholderSnippet(rawSnip);
    const cands = [];
    const tryStrat = (name, fn) => { try { const el = fn(); if (el) cands.push({ name, el }); } catch (e) {} };
    if (a.attrSelector) tryStrat('attr', () => dom.bySelector(a.attrSelector));
    if (a.selector) tryStrat('selector', () => dom.bySelector(a.selector));
    if (a.xpath) tryStrat('xpath', () => dom.byXPath(a.xpath));
    let textAmbiguous = false; // the snippet matched several separate elements
    if (hasText) tryStrat('text', () => { const r = byText(rawSnip, a.tag, pool); textAmbiguous = r.ambiguous; return r.el; });
    if (!cands.length) return { el: null, confidence: null, ambiguous: textAmbiguous };

    // (When the element has a unique id, the attribute selector and the CSS
    // path both reduce to that id. They then vote for the same element twice,
    // which changes nothing: a unique id can only ever resolve to one element.)
    const familyOf = { attr: 'attr', selector: 'structural', xpath: 'structural', text: 'text' };
    const weight = { attr: 3, structural: 2, text: 2 };
    const fams = new Map(); // element -> Set(families pointing at it)
    for (const c of cands) {
      if (!fams.has(c.el)) fams.set(c.el, new Set());
      fams.get(c.el).add(familyOf[c.name]);
    }
    // Pick the element backed by the strongest combination of independent families.
    let best = cands[0].el, bestScore = -1;
    for (const [el, set] of fams) {
      let s = 0; for (const f of set) s += weight[f] || 0;
      if (s > bestScore) { best = el; bestScore = s; }
    }
    const set = fams.get(best);

    let confidence;
    if (hasText) {
      let tr = textRel(best, rawSnip);
      // A range anchor (a selected sentence) stores a FRAGMENT of its container's
      // text, so "buried inside much larger text" is the expected relation, as
      // long as the element is the same kind of container that was recorded (an
      // <li> stays an <li>; an <article> that merely contains it does not qualify).
      if (tr === 'weak' && a.type === 'range' && a.tag && dom.tag(best) === a.tag) tr = 'strong';
      if ((set.has('attr') || set.has('structural')) && tr === 'strong') confidence = 'high';
      // Text alone earns "high" only when it points at ONE element.
      else if (set.has('text') && tr === 'strong' && !textAmbiguous) confidence = 'high';
      else if (tr !== 'none') confidence = 'medium';
      else confidence = 'low';
    } else {
      // No real text to corroborate. Trust only a uniquely-resolving stable attribute.
      confidence = set.has('attr') ? 'high' : 'low';
    }
    return { el: best, confidence, ambiguous: textAmbiguous };
  }
  function resolveAnchor(a, pool) { return resolveWithConfidence(a, pool).el; }

  function buildElementAnchor(el) {
    return {
      type: 'element',
      selector: cssPath(el),
      attrSelector: stableAttrSelector(el),
      xpath: xPath(el),
      tag: dom.tag(el),
      id: dom.id(el) || '',
      // textContent, not innerText: casing as written in the source, and stable
      // across text-transform and hidden descendants.
      snippet: norm(dom.text(el)).slice(0, 140) || ('<' + dom.tag(el) + '>'),
    };
  }
  // A selected sentence: `container` is the element holding the selection,
  // `text` the selected text itself.
  function buildRangeAnchor(container, text) {
    const t = norm(text);
    return {
      type: 'range',
      selector: cssPath(container),
      attrSelector: stableAttrSelector(container),
      xpath: xPath(container),
      tag: dom.tag(container),
      id: dom.id(container) || '',
      rangeText: t.slice(0, 240),
      snippet: t.slice(0, 140),
    };
  }

  return { cssPath, stableAttrSelector, xPath, makePool, byText, textRel, resolveWithConfidence, resolveAnchor, buildElementAnchor, buildRangeAnchor };
}
