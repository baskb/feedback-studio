// Tests for the unsent-draft rules: what is kept across a reload, when it is
// dropped, and where a restored draft goes. Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packDraft, readDraft, restoreRoute, packReplyDrafts, readReplyDrafts,
  readHeld, packHeld, DRAFT_MAX_AGE_MS,
} from '../lib/drafts.mjs';
import { createAnchoring } from '../lib/anchor.mjs';
import { h, makePage } from './fake-dom.mjs';

const NOW = 1_800_000_000_000;
const anchor = { type: 'element', tag: 'h1', selector: 'h1', snippet: 'Welcome' };
const base = { kind: 'new', page: '/about', source: '', anchor, text: 'make this bigger', type: 'change' };
const ctx = { page: '/about', source: '', now: NOW + 1000 };

test('a draft with words round-trips', () => {
  const raw = packDraft({ ...base, typePicked: true, photos: [{ id: 'a_12345678', name: 'x.jpg', thumb: 'data:image/jpeg;base64,AA' }] }, NOW);
  const r = readDraft(raw, ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.draft.text, 'make this bigger');
  assert.equal(r.draft.type, 'change');
  assert.equal(r.draft.typePicked, true);
  assert.deepEqual(r.draft.anchor, anchor);
  assert.equal(r.draft.photos.length, 1);
  assert.equal(r.draft.photos[0].id, 'a_12345678');
});

test('nothing worth keeping gives an empty string', () => {
  assert.equal(packDraft({ ...base, text: '   ' }, NOW), '');
  assert.equal(packDraft(null, NOW), '');
  assert.equal(packDraft({ ...base, kind: 'other' }, NOW), '');
  // photos alone are worth keeping
  assert.notEqual(packDraft({ ...base, text: '', photos: [{ id: 'a_12345678' }] }, NOW), '');
  // a photo without an upload id is not
  assert.equal(packDraft({ ...base, text: '', photos: [{ name: 'x' }] }, NOW), '');
});

test('an edit nobody changed is not kept; a changed one is', () => {
  const edit = { ...base, kind: 'edit', commentId: 'c1', original: { text: 'make this bigger', type: 'change' } };
  assert.equal(packDraft(edit, NOW), '');
  assert.notEqual(packDraft({ ...edit, text: 'make this much bigger' }, NOW), '');
  assert.notEqual(packDraft({ ...edit, type: 'fix' }, NOW), '');
  assert.equal(packDraft({ ...edit, commentId: '', text: 'changed' }, NOW), '');
});

test('the on-page changes that cannot come back are noted', () => {
  const r = readDraft(packDraft({ ...base, lost: { tweaks: true } }, NOW), ctx);
  assert.deepEqual(r.draft.lost, { tweaks: true, textEdit: false, image: false });
});

test('an old, broken or odd draft is dropped', () => {
  assert.equal(readDraft('', ctx).status, 'none');
  assert.equal(readDraft(null, ctx).status, 'none');
  assert.equal(readDraft('{not json', ctx).status, 'drop');
  assert.equal(readDraft(JSON.stringify({ v: 2 }), ctx).status, 'drop');
  const raw = packDraft(base, NOW);
  assert.equal(readDraft(raw, { ...ctx, now: NOW + DRAFT_MAX_AGE_MS + 1 }).status, 'drop');
  assert.equal(readDraft(raw, { ...ctx, now: NOW + DRAFT_MAX_AGE_MS - 1 }).status, 'ok');
  // a clock far behind the draft: not trusted either
  assert.equal(readDraft(raw, { ...ctx, now: NOW - 10 * 60000 }).status, 'drop');
  const noAnchor = JSON.parse(raw); noAnchor.anchor = null;
  assert.equal(readDraft(JSON.stringify(noAnchor), ctx).status, 'drop');
});

test('a draft from another page or another .md file is left alone', () => {
  const raw = packDraft(base, NOW);
  assert.equal(readDraft(raw, { ...ctx, page: '/' }).status, 'elsewhere');
  assert.equal(readDraft(raw, { ...ctx, source: 'docs/a.md' }).status, 'elsewhere');
  const md = packDraft({ ...base, page: '/', source: 'docs/a.md' }, NOW);
  assert.equal(readDraft(md, { page: '/', source: 'docs/a.md', now: NOW }).status, 'ok');
  assert.equal(readDraft(md, { page: '/', source: 'docs/b.md', now: NOW }).status, 'elsewhere');
});

test('a new comment reopens only on a spot found with high confidence', () => {
  const d = readDraft(packDraft(base, NOW), ctx).draft;
  assert.equal(restoreRoute(d, { confidence: 'high' }), 'composer');
  assert.equal(restoreRoute(d, { confidence: 'medium' }), 'tray');
  assert.equal(restoreRoute(d, { confidence: 'low' }), 'tray');
  assert.equal(restoreRoute(d, { confidence: null }), 'tray');
  assert.equal(restoreRoute(null), 'none');
});

test('an edit reopens while its comment exists', () => {
  const d = readDraft(packDraft({ ...base, kind: 'edit', commentId: 'c1', original: { text: 'x' } }, NOW), ctx).draft;
  assert.equal(restoreRoute(d, { commentExists: true, confidence: null }), 'composer');
  assert.equal(restoreRoute(d, { commentExists: false, confidence: 'high' }), 'tray');
});

// The real anchoring code on a fake page: the agent rewrote the heading the
// comment was about, so the spot is no longer sure and the draft must go to
// the tray instead of a guessed element.
test('a heading the agent rewrote sends the draft to the tray', () => {
  const build = (heading) => {
    const h1 = h('h1', {}, [heading]);
    return { dom: makePage(h('body', {}, [h1, h('p', {}, ['Some other text here'])])).dom, h1 };
  };
  const before = build('Welcome to the coffee shop');
  const a = createAnchoring(before.dom).buildElementAnchor(before.h1);
  const d = readDraft(packDraft({ ...base, anchor: a }, NOW), ctx).draft;

  const same = build('Welcome to the coffee shop');
  const s = createAnchoring(same.dom).resolveWithConfidence(d.anchor);
  assert.equal(restoreRoute(d, { confidence: s.confidence }), 'composer');

  const changed = build('Fresh beans, roasted daily');
  const c = createAnchoring(changed.dom).resolveWithConfidence(d.anchor);
  assert.notEqual(c.confidence, 'high');
  assert.equal(restoreRoute(d, { confidence: c.confidence }), 'tray');
});

test('held drafts are split into this page and elsewhere', () => {
  const here = JSON.parse(packDraft(base, NOW));
  const there = JSON.parse(packDraft({ ...base, page: '/' }, NOW));
  const old = JSON.parse(packDraft(base, NOW - DRAFT_MAX_AGE_MS - 5000));
  const r = readHeld(packHeld([here, there, old]), ctx);
  assert.equal(r.here.length, 1);
  assert.equal(r.others.length, 1);
  assert.equal(r.others[0].page, '/');
  assert.equal(packHeld([]), '');
  assert.deepEqual(readHeld('nonsense', ctx), { here: [], others: [] });
});

test('reply drafts round-trip, empty ones are left out', () => {
  const raw = packReplyDrafts({ c1: 'half a reply', c2: '   ', c3: '' }, NOW);
  assert.deepEqual(readReplyDrafts(raw, NOW + 1), { c1: 'half a reply' });
  assert.equal(packReplyDrafts({ c2: ' ' }, NOW), '');
  assert.deepEqual(readReplyDrafts(raw, NOW + DRAFT_MAX_AGE_MS + 1), {});
  assert.deepEqual(readReplyDrafts('{bad', NOW), {});
});
