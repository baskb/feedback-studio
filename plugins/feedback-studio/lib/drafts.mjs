// Feedback Studio — unsent comments that survive a page reload.
//
// The page can reload while the reviewer is halfway through a comment: the
// agent finished the previous one and asked for a reload, a dev server behind
// --proxy reloaded the page by itself after the agent saved a file, the
// reviewer pressed "Reload now", or a phone threw the tab away in the
// background. The overlay holds back only the reloads it starts itself, so it
// also keeps what is being typed in the tab's sessionStorage on every change
// and brings it back after the load.
//
// This module holds the pure part, so it can be tested in Node: what a stored
// draft looks like, when one is too old or belongs to another page, and where
// a restored draft goes. The browser side is public/overlay/restore.mjs (and
// the writes in composer.mjs and panel.mjs).

export const DRAFT_KEY = 'kbf-draft';          // the comment box that was open
export const HELD_KEY = 'kbf-draft-held';      // a restored draft waiting for "Point to it"
export const REPLY_KEY = 'kbf-reply-drafts';   // half-written replies, per comment id
// Unclaimed photo uploads are deleted by the server after a day, and a phone
// tab can live for days. A draft older than this is dropped, not restored.
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TEXT_MAX = 20000;
const PHOTOS_MAX = 20;
const REPLIES_MAX = 50;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// The draft as stored, or '' when there is nothing worth keeping (no text and
// no photos). `d` is { kind, commentId, original, page, source, anchor, text,
// type, typePicked, photos: [{ id, name, thumb }], lost: { tweaks, textEdit, image } }.
// For an edit, `original` is the comment's text and type before this edit: an
// edit box nobody typed in holds nothing to restore.
export function packDraft(d, now = Date.now()) {
  if (!d || (d.kind !== 'new' && d.kind !== 'edit')) return '';
  const text = str(d.text, TEXT_MAX);
  const photos = (Array.isArray(d.photos) ? d.photos : [])
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .slice(0, PHOTOS_MAX)
    .map((p) => ({ id: p.id, name: str(p.name, 120), thumb: str(p.thumb, 200000) }));
  if (!text.trim() && !photos.length) return '';
  if (d.kind === 'edit') {
    if (!d.commentId) return '';
    const o = d.original || {};
    if (text === (o.text || '') && (d.type || '') === (o.type || '')) return '';
  }
  const lost = d.lost || {};
  return JSON.stringify({
    v: 1,
    kind: d.kind,
    commentId: d.kind === 'edit' ? String(d.commentId) : '',
    page: String(d.page || '/'),
    source: String(d.source || ''),
    anchor: d.anchor && typeof d.anchor === 'object' ? d.anchor : null,
    text,
    type: str(d.type, 40),
    typePicked: !!d.typePicked,
    photos,
    lost: { tweaks: !!lost.tweaks, textEdit: !!lost.textEdit, image: !!lost.image },
    at: now,
  });
}

// Read a stored draft back. Returns { status, draft }:
//   'none'       nothing stored
//   'drop'       unreadable, of an unknown shape, or too old: remove it
//   'elsewhere'  made on another page (or another .md file): leave it be
//   'ok'         for this page; `draft` is the parsed draft
export function readDraft(raw, { page, source = '', now = Date.now() } = {}) {
  if (!raw) return { status: 'none', draft: null };
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { return { status: 'drop', draft: null }; }
  if (!d || d.v !== 1 || (d.kind !== 'new' && d.kind !== 'edit')) return { status: 'drop', draft: null };
  if (typeof d.text !== 'string' || !Array.isArray(d.photos)) return { status: 'drop', draft: null };
  if (d.kind === 'new' && (!d.anchor || typeof d.anchor !== 'object')) return { status: 'drop', draft: null };
  if (d.kind === 'edit' && !d.commentId) return { status: 'drop', draft: null };
  if (!Number.isFinite(d.at) || now - d.at > DRAFT_MAX_AGE_MS || d.at - now > 60000) return { status: 'drop', draft: null };
  if (d.page !== page || (d.source || '') !== (source || '')) return { status: 'elsewhere', draft: d };
  return { status: 'ok', draft: d };
}

// Where a restored draft goes:
//   'composer'  reopen the comment box on its spot, text filled in
//   'tray'      show it in the "needs a spot" tray: the reviewer points again
// A new comment reopens only on a spot found with HIGH confidence, the same
// rule every on-page action uses (makeTrustedGetEl): the agent may just have
// changed the very thing the comment was about, and a comment must never
// quietly move to a guessed element. An edit is saved by the comment's id, so
// it reopens as long as that comment still exists.
export function restoreRoute(draft, { confidence = null, commentExists = false } = {}) {
  if (!draft) return 'none';
  if (draft.kind === 'edit') return commentExists ? 'composer' : 'tray';
  return confidence === 'high' ? 'composer' : 'tray';
}

// Restored drafts waiting in the tray for "Point to it": a list, kept until
// each is saved, discarded or handed to the comment box, so a second reload
// while the tray is up loses nothing. Returns { here, others }: the drafts for
// this page, and the ones made elsewhere (written back untouched). Too old or
// unreadable ones are left out of both.
export function readHeld(raw, ctx = {}) {
  const out = { here: [], others: [] };
  if (!raw) return out;
  let list = null;
  try { list = JSON.parse(raw); } catch (e) { return out; }
  if (!Array.isArray(list)) return out;
  for (const d of list.slice(0, 10)) {
    const r = readDraft(JSON.stringify(d), ctx);
    if (r.status === 'ok') out.here.push(r.draft);
    else if (r.status === 'elsewhere') out.others.push(r.draft);
  }
  return out;
}
export function packHeld(list) {
  const keep = (Array.isArray(list) ? list : []).filter(Boolean).slice(0, 10);
  return keep.length ? JSON.stringify(keep) : '';
}

// Half-written replies:{ at, drafts: { <comment id>: text } }. Empty ones are
// left out; '' when none are left (the caller removes the key).
export function packReplyDrafts(map, now = Date.now()) {
  const drafts = {};
  let n = 0;
  for (const [id, text] of Object.entries(map || {})) {
    if (n >= REPLIES_MAX) break;
    if (!id || typeof text !== 'string' || !text.trim()) continue;
    drafts[id] = text.slice(0, TEXT_MAX);
    n++;
  }
  return n ? JSON.stringify({ at: now, drafts }) : '';
}

export function readReplyDrafts(raw, now = Date.now()) {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw);
    if (!d || !Number.isFinite(d.at) || now - d.at > DRAFT_MAX_AGE_MS || !d.drafts || typeof d.drafts !== 'object') return {};
    const out = {};
    for (const [id, text] of Object.entries(d.drafts)) if (typeof text === 'string' && text.trim()) out[id] = text;
    return out;
  } catch (e) { return {}; }
}
