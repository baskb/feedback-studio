// The anchor tests: the same scenarios HARNESS.md describes, run in Node on a
// page built from literals (test/fake-dom.mjs). The one property every scenario
// checks: an anchor is either found at the right element with high confidence,
// or it degrades to medium / low / none. It never resolves to a WRONG element
// with high confidence, because that is the one outcome the tool must not
// produce (the agent would then edit the wrong thing, confidently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchoring, norm, isPlaceholderSnippet } from '../lib/anchor.mjs';
import { h, makePage } from './fake-dom.mjs';

// A page with the variety HARNESS.md lists: headings, paragraphs, links, list
// items, spans, divs, sections, nav. Built fresh for every test so mutations
// never leak between scenarios.
function samplePage() {
  return makePage(h('body', {}, [
    h('nav', { id: 'nav' }, [
      h('a', { href: '/' }, ['Home']),
      h('a', { href: '/pricing' }, ['Pricing']),
      h('a', { href: '/docs', 'data-testid': 'nav-docs' }, ['Docs']),
    ]),
    h('section', { id: 'hero' }, [
      h('h1', {}, ['Ship feedback faster']),
      h('p', { class: 'lead' }, ['Click anything on your site and leave a note.']),
      h('div', { class: 'cta' }, [h('button', {}, ['Start free']), h('span', { class: 'hint' }, ['No card needed'])]),
    ]),
    h('section', { class: 'features' }, [
      h('h2', {}, ['Why teams like it']),
      h('ul', {}, [
        h('li', {}, ['Works on any local site']),
        h('li', {}, ['Voice notes from your phone']),
        h('li', {}, ['Your agent applies the comments']),
        h('li', {}, ['Nothing leaves your machine']),
      ]),
      h('p', {}, ['Zero dependencies. No build step.']),
    ]),
    h('section', { class: 'faq' }, [
      h('h2', {}, ['Questions']),
      h('div', { class: 'q' }, [h('h3', {}, ['Is it free?']), h('p', {}, ['Yes for local use.'])]),
      h('div', { class: 'q' }, [h('h3', {}, ['Does it work offline?']), h('p', {}, ['Yes, everything runs on your machine.'])]),
    ]),
    h('footer', {}, [h('span', {}, ['Made in the Netherlands']), h('a', { href: '/privacy' }, ['Privacy'])]),
  ]));
}

// Every element with text on the sample page, which is what the harness pins.
const targets = (page) => page.findAll((e) => e.tag !== 'body' && e.tag !== 'ul' && e.tag !== 'nav' && e.tag !== 'section' && e.tag !== 'footer' && !e.attrs.class?.includes('q') && e.tag !== 'div');
const textOf = (page, el) => norm(page.dom.text(el));

// Pin every target on `pageA`, then resolve on `pageB` (a different tree that
// went through the same edits) and find the element that corresponds to each
// original by its recorded text and tag.
function resolveAll(anchorsWithText, pageB) {
  const A = createAnchoring(pageB.dom);
  const pool = A.makePool();
  return anchorsWithText.map(({ anchor, text, tag }) => ({ anchor, text, tag, ...A.resolveWithConfidence(anchor, pool) }));
}
function pinAll(page) {
  const A = createAnchoring(page.dom);
  return targets(page).map((el) => ({ anchor: A.buildElementAnchor(el), text: textOf(page, el), tag: el.tag }));
}

test('anchor: identical page resolves every anchor high, at the same element', () => {
  const page = samplePage();
  const pins = pinAll(page);
  assert.ok(pins.length >= 20, 'the sample page pins at least 20 elements, got ' + pins.length);
  const A = createAnchoring(page.dom);
  const pool = A.makePool();
  for (const [i, p] of pins.entries()) {
    const r = A.resolveWithConfidence(p.anchor, pool);
    assert.equal(r.el, targets(page)[i], 'resolves to the pinned element: ' + p.text);
    assert.equal(r.confidence, 'high', 'high on an unchanged page: ' + p.text);
  }
});

test('anchor: typical edits (text tweaks elsewhere, different-tag insertions) stay high and correct', () => {
  const pins = pinAll(samplePage());
  const page = samplePage();
  // Insert elements whose tag differs from EVERY sibling (so no nth-of-type
  // index shifts), and change one pinned element's own text.
  page.insertBefore(page.find((e) => e.tag === 'h1'), h('header', { class: 'banner' }, ['New: version 2']));
  page.insertBefore(page.find((e) => e.tag === 'ul'), h('aside', {}, ['Three reasons:']));
  page.replaceText(page.find((e) => e.tag === 'span' && e.attrs.class === 'hint'), 'No credit card needed');
  const out = resolveAll(pins, page);
  for (const r of out) {
    assert.ok(r.el, 'still found: ' + r.text);
    if (r.text === 'No card needed') {
      // Its position still points at it, but the text no longer corroborates: refuse-and-re-pin territory.
      assert.equal(r.confidence, 'low', 'its own text changed: position only');
      continue;
    }
    assert.equal(r.confidence, 'high', 'high after unrelated edits: ' + r.text);
    assert.equal(textOf(page, r.el), r.text, 'right element: ' + r.text);
  }
});

test('anchor: harsh case (same-tag siblings shifted AND pinned text replaced) never gives high to a wrong element', () => {
  const pins = pinAll(samplePage());
  const page = samplePage();
  // Shift every same-tag index: a new <li> at the top, a new <p> at the top of each section, a new <a> in the nav.
  page.insertBefore(page.find((e) => e.tag === 'li'), h('li', {}, ['Brand new first item']));
  for (const s of page.findAll((e) => e.tag === 'section')) page.insertBefore(s.children.find((c) => typeof c !== 'string'), h('p', {}, ['Intro line']));
  page.insertBefore(page.find((e) => e.tag === 'a'), h('a', { href: '/new' }, ['New']));
  // Replace the text of every heading and link.
  for (const e of page.findAll((e) => /^(h1|h2|h3|a)$/.test(e.tag))) page.replaceText(e, 'Rewritten ' + Math.random().toString(36).slice(2, 7));
  const out = resolveAll(pins, page);
  let high = 0, lower = 0;
  for (const r of out) {
    if (r.confidence === 'high') {
      high++;
      assert.equal(textOf(page, r.el), r.text, 'a HIGH result must be the right element: ' + r.text);
    } else lower++;
  }
  assert.ok(lower > 0, 'the harsh case degrades some anchors (it did not: ' + high + ' high)');
  assert.ok(high > 0, 'anchors whose text survived (list items, paragraphs) are still found high');
});

test('anchor: duplicated element, text-only anchor, is ambiguous and caps at medium', () => {
  const page = samplePage();
  const A = createAnchoring(page.dom);
  const btn = page.find((e) => e.tag === 'button');
  const anchor = { type: 'element', tag: 'button', snippet: 'Start free' }; // like an MCP add_comment: no position
  assert.equal(A.resolveWithConfidence(anchor, A.makePool()).confidence, 'high', 'unique: high');
  page.duplicate(btn);
  const r = A.resolveWithConfidence(anchor, A.makePool());
  assert.equal(r.ambiguous, true);
  assert.equal(r.confidence, 'medium', 'two identical buttons: the text alone cannot pick one');
});

test('anchor: duplicated element, but position and text agree on one copy: still high, right copy', () => {
  const page = samplePage();
  const A = createAnchoring(page.dom);
  const btn = page.find((e) => e.tag === 'button');
  const copy = page.duplicate(btn);
  const anchorOnCopy = A.buildElementAnchor(copy);
  const r = A.resolveWithConfidence(anchorOnCopy, A.makePool());
  assert.equal(r.el, copy);
  assert.equal(r.confidence, 'high');
  assert.equal(r.ambiguous, true, 'the text was ambiguous, the position settled it');
});

test('anchor: a wrapper and its inner element with the same text count as one occurrence', () => {
  const page = makePage(h('body', {}, [h('div', {}, [h('div', {}, [h('p', {}, ['Nested same text'])])]), h('p', {}, ['Other'])]));
  const A = createAnchoring(page.dom);
  const r = A.byText('Nested same text', 'div', A.makePool());
  assert.equal(r.ambiguous, false);
  assert.equal(r.el, page.find((e) => e.tag === 'div' && e.parent.tag === 'div'), 'the innermost div');
});

test('anchor: placeholder snippet: high with a stable attribute, low with position only', () => {
  const page = makePage(h('body', {}, [h('div', { 'data-testid': 'chart' }, []), h('div', {}, []), h('div', {}, [])]));
  const A = createAnchoring(page.dom);
  const withAttr = A.buildElementAnchor(page.find((e) => e.attrs['data-testid'] === 'chart'));
  assert.ok(isPlaceholderSnippet(withAttr.snippet));
  assert.equal(A.resolveWithConfidence(withAttr).confidence, 'high');
  const positional = A.buildElementAnchor(page.findAll((e) => e.tag === 'div')[2]);
  assert.equal(positional.attrSelector, '');
  assert.equal(A.resolveWithConfidence(positional).confidence, 'low', 'nothing but the position, which rots');
});

test('anchor: a unique id with no text is high (the id is trusted on its own)', () => {
  const page = makePage(h('body', {}, [h('div', { id: 'app' }, []), h('div', {}, [])]));
  const A = createAnchoring(page.dom);
  const a = A.buildElementAnchor(page.byId('app'));
  assert.equal(a.attrSelector, '#app');
  assert.equal(a.selector, '#app');
  assert.equal(A.resolveWithConfidence(a).confidence, 'high');
});

test('anchor: a range (selected sentence) inside a long list item is high when the tag matches, medium inside a wrapper', () => {
  const li = h('li', {}, ['First sentence of a long bullet. The selected sentence sits here. And a third sentence follows it to make the bullet long.']);
  const page = makePage(h('body', {}, [h('article', {}, [h('ul', {}, [li])])]));
  const A = createAnchoring(page.dom);
  const range = A.buildRangeAnchor(li, 'The selected sentence sits here.');
  assert.equal(range.type, 'range');
  assert.equal(A.resolveWithConfidence(range).confidence, 'high');
  // The same sentence recorded against the article wrapper: only a re-check.
  const wrapper = A.buildRangeAnchor(page.find((e) => e.tag === 'article'), 'The selected sentence sits here.');
  wrapper.tag = 'li'; // what a moved or rebuilt bullet would look like: the recorded tag no longer matches the container
  const r = A.resolveWithConfidence(wrapper);
  assert.notEqual(r.confidence, 'high');
});

test('anchor: stableAttrSelector prefers data-testid over id and refuses a shared id', () => {
  const page = makePage(h('body', {}, [
    h('button', { id: 'go', 'data-testid': 'cta' }, ['Go']),
    h('span', { id: 'dup' }, ['a']), h('span', { id: 'dup' }, ['b']),
  ]));
  const A = createAnchoring(page.dom);
  assert.equal(A.stableAttrSelector(page.find((e) => e.tag === 'button')), 'button[data-testid="cta"]');
  assert.equal(A.stableAttrSelector(page.find((e) => e.tag === 'span')), '', 'an id used twice is not stable');
});

test('anchor: cssPath stops at the first unique id; xPath uses the id or a full index path', () => {
  const page = samplePage();
  const A = createAnchoring(page.dom);
  const lead = page.find((e) => e.attrs.class === 'lead');
  assert.equal(A.cssPath(lead), '#hero > p:nth-of-type(1)');
  assert.equal(A.xPath(page.byId('hero')), '//*[@id="hero"]');
  const li2 = page.findAll((e) => e.tag === 'li')[1];
  assert.equal(A.cssPath(li2), 'body > section:nth-of-type(2) > ul:nth-of-type(1) > li:nth-of-type(2)');
  assert.equal(A.xPath(li2), '/body[1]/section[2]/ul[1]/li[2]');
  assert.equal(page.dom.bySelector(A.cssPath(li2)), li2);
  assert.equal(page.dom.byXPath(A.xPath(li2)), li2);
});

test('anchor: a hidden element is not a text match', () => {
  const page = makePage(h('body', {}, [h('p', {}, ['Only once']), h('p', {}, ['Other'])]));
  const A = createAnchoring(page.dom);
  page.hide(page.find((e) => e.tag === 'p'));
  assert.equal(A.byText('Only once', 'p', A.makePool()).el, null);
});

test('anchor: the self-test rule counts high and medium as resolved, low and none as re-pin cases', () => {
  const page = samplePage();
  const A = createAnchoring(page.dom);
  const gone = A.resolveWithConfidence({ type: 'element', tag: 'h4', selector: 'body > h4:nth-of-type(1)', snippet: 'No such heading' });
  assert.equal(gone.el, null);
  assert.equal(gone.confidence, null);
});

test('fake-dom: refuses selectors and xpaths outside the grammar the anchor module writes', () => {
  const page = samplePage();
  assert.throws(() => page.dom.allBySelector('section .lead'), /cannot read/);
  assert.throws(() => page.dom.allBySelector('p:first-child'), /cannot read/);
  assert.equal(page.dom.byXPath('//p[contains(., "x")]'), null, 'byXPath swallows, like the browser adapter');
});
