// Feedback Studio — overlay configuration, shared state and pure helpers.
//
// Three kinds of thing live here, and nothing else:
//   1. Configuration read once from the page (role, mode, paths, storage).
//   2. `S` — the one object holding every piece of mutable state the modules
//      share. It used to be ~60 module-level `let`s inside one big IIFE; as
//      separate modules they need a single owner, and this is it. Read and
//      write them as `S.comments`, `S.mode`, … from anywhere.
//   3. Pure helpers over that state (no DOM, no network).
//
// This module imports nothing but the shared schema and the anchoring helper,
// so it can never take part in an import cycle.

import { WEB_TYPES, MD_TYPES, UNIVERSAL_TYPES } from '/__feedback/lib/schema.mjs';
import { norm } from '/__feedback/lib/anchor.mjs';

// ---------- role / config ----------
// Share role (injected by the server under --share): 'full' when absent.
// view = read-only; comment = may add comments/replies (no statuses, edits or
// deletes — those are the host team's); none = no valid key, mount nothing.
export const ROLE = window.__kbfRole || 'full';
export const LABEL = String(window.__kbfLabel || '').slice(0, 60); // site name in a multi-site repo
export const CAN_COMMENT = ROLE !== 'view';
export const CAN_MANAGE = ROLE === 'full' || ROLE === 'admin';

export const API = '/__feedback/api';
export const ROOT = API.replace(/\/api$/, ''); // '/__feedback' — base for /events and /api/*
export const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Storage can throw in private mode / sandboxed iframes — never let that abort
// the overlay. These wrappers degrade to no-ops instead.
function mkStore(get) {
  let s = null;
  try { s = get(); } catch (e) {}
  return {
    get(k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (s) s.setItem(k, v); } catch (e) {} },
    remove(k) { try { if (s) s.removeItem(k); } catch (e) {} },
  };
}
export const SS = mkStore(() => window.sessionStorage);
export const LS = mkStore(() => window.localStorage);

export function normalizePath(p) {
  // '/x' and '/x/' serve the same content here — collapse to one key so pins
  // made on one form still render when the page is visited via the other.
  p = p.replace(/index\.html$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}
export const PAGE = normalizePath(location.pathname);

export const MODE = (typeof window !== 'undefined' && window.__kbfMode) || 'web';
// The .md file this page renders (comment.sourceFile), '' in web mode.
export const SOURCE = (typeof window !== 'undefined' && window.__kbfSource) || '';

// In Markdown mode the rendered HTML is throwaway and several .md files can
// share ONE .feedback dir — and in single-file `--md` mode they all serve at
// the same path ('/'), so filtering by `page` alone leaks another file's
// comments onto this view (the "cross-file bleed" bug). Scope the whole
// overlay's comment universe to the served source file. In web mode SOURCE is
// '' and this is a no-op; in md-index mode each file has its own sourceFile so
// it simply keeps each page to its own comments.
export function scopeComments(list) {
  if (MODE !== 'md') return list;
  return list.filter((c) => (c.sourceFile || '') === SOURCE);
}

// ---------- voice languages ----------
// Voice dictation languages (BCP-47, the most widely spoken + common dev locales).
// The UI is English by default; this only sets the speech-recognition language.
export const LANGS = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'es-ES', name: 'Espanol (Espana)' },
  { code: 'es-MX', name: 'Espanol (Latinoamerica)' },
  { code: 'zh-CN', name: '中文 (普通话)' },
  { code: 'hi-IN', name: 'हिन्दी' },
  { code: 'ar-SA', name: 'العربية' },
  { code: 'pt-BR', name: 'Portugues (Brasil)' },
  { code: 'fr-FR', name: 'Francais' },
  { code: 'de-DE', name: 'Deutsch' },
  { code: 'ja-JP', name: '日本語' },
  { code: 'ko-KR', name: '한국어' },
  { code: 'ru-RU', name: 'Русский' },
  { code: 'it-IT', name: 'Italiano' },
  { code: 'nl-NL', name: 'Nederlands' },
  { code: 'tr-TR', name: 'Turkce' },
  { code: 'pl-PL', name: 'Polski' },
  { code: 'id-ID', name: 'Bahasa Indonesia' },
];
export const DEFAULT_LANG = 'en-US';
export const langName = (code) => (LANGS.find((l) => l.code === code) || LANGS[0]).name;
export const langShort = (code) => code.split('-')[0].toUpperCase();

export const PLACEHOLDER = 'What needs to change here? (typed or spoken)';

// ---------- comment types ----------
// Comment types decide how much latitude the AI agent gets. Websites and
// documents need different verbs, so the set depends on the mode. The ID SET is
// the shared schema's (imported above) — the overlay only adds the wording, so
// the two can no longer drift apart.
const TYPE_META = {
  web: {
    fix: { label: 'Fix', hint: 'Something is broken or wrong — reproduce and patch it.', placeholder: 'What’s broken, and what should happen instead? (typed or spoken)' },
    change: { label: 'Change', hint: 'Make it exactly this — apply near-verbatim, no redesign.', placeholder: 'What should this say or look like? (typed or spoken)' },
    improve: { label: 'Improve', hint: 'This is weak — rewrite or redesign with judgement.', placeholder: 'What could be better here? (typed or spoken)' },
    question: { label: 'Ask', hint: 'Ask about this — the agent answers in a reply, and does not change it.', placeholder: 'What’s your question about this? (typed or spoken)' },
  },
  md: {
    comment: { label: 'Comment', hint: 'A general note about this passage.', placeholder: 'Your note on this passage (typed or spoken)' },
    rephrase: { label: 'Rephrase', hint: 'Propose specific replacement wording.', placeholder: 'How should this be reworded? (typed or spoken)' },
    expand: { label: 'Expand', hint: 'Add more detail / content here.', placeholder: 'What should be added or expanded on? (typed or spoken)' },
    delete: { label: 'Delete', hint: 'Remove this passage.', placeholder: 'Why should this be removed? (optional, typed or spoken)' },
    question: { label: 'Question', hint: 'Ask the agent something about this.', placeholder: 'What’s your question about this? (typed or spoken)' },
  },
};
// MD_TYPES already carries `question`; the web set has to add the universal one.
const TYPE_ORDER = { web: [...WEB_TYPES, ...UNIVERSAL_TYPES], md: [...MD_TYPES] };
const typeSetFor = (m) => TYPE_ORDER[m].map((id) => ({
  id, label: id, hint: '', placeholder: PLACEHOLDER, ...(TYPE_META[m][id] || {}),
}));
const TYPE_SETS = { web: typeSetFor('web'), md: typeSetFor('md') };

export const TYPES = TYPE_SETS[MODE] || TYPE_SETS.web;
export const TYPE_IDS = TYPES.map((t) => t.id);
export const placeholderFor = (id) => (TYPES.find((t) => t.id === id) || {}).placeholder || PLACEHOLDER;

// ---------- pure helpers over the comment list ----------
export const isOpenC = (c) => c.status !== 'resolved' && c.status !== 'rejected';

// Newest activity on a comment: created, updated (reply / status / edit), or its newest reply.
export const lastTouch = (c) => {
  let t = (c.updatedAt && c.updatedAt > (c.createdAt || '')) ? c.updatedAt : (c.createdAt || '');
  for (const r of (Array.isArray(c.thread) ? c.thread : [])) if (r.createdAt && r.createdAt > t) t = r.createdAt;
  return t;
};

// "Today" = added or touched on the reviewer's local calendar day (timestamps are UTC ISO strings).
export const isTodayC = (c) => { const d = new Date(lastTouch(c) || 0); const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };

// True when an agent reply on the thread is newer than the comment itself AND
// reads like an applied change: a "Queued…" reply parks the item (the server
// uses the same word to decide, see the reply route) and a variants proposal
// is a question, not an edit. Neither can vouch for changed text.
export const agentRepliedAfter = (c) => (Array.isArray(c.thread) ? c.thread : []).some((r) =>
  r.author === 'agent' && r.createdAt && r.createdAt > (c.createdAt || '')
  && !/\bqueued\b/i.test(String(r.text || '')) && !(Array.isArray(r.variants) && r.variants.length));

export function pageComments() {
  return S.comments.filter((c) => normalizePath(c.page) === PAGE);
}

export function filtered(list) {
  if (S.filter === 'open') return list.filter(isOpenC);
  if (S.filter === 'resolved') return list.filter((c) => c.status === 'resolved');
  if (S.filter === 'today') return list.filter(isTodayC);
  return list;
}

export function editsSummary(c) {
  const ed = Array.isArray(c.edits) ? c.edits : [];
  return ed.map((e) => e.prop + ' ' + (e.from || '?') + ' → ' + e.to).join(', ');
}

// The comments a walkthrough can narrate: only this page's (the tour resolves
// anchors against the live DOM) and only ones the agent has replied to.
export function walkComments() {
  return S.comments.filter((c) => normalizePath(c.page) === PAGE
    && Array.isArray(c.thread) && c.thread.some((r) => r.author === 'agent' && norm(r.text)));
}
export function lastAgentReply(c) {
  const rs = (c.thread || []).filter((r) => r.author === 'agent' && norm(r.text));
  return rs.length ? rs[rs.length - 1].text : '';
}

// ---------- pure helpers about the agent ----------
export const agentName = () => S.agent.name || 'Agent';

export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// "#3" for a comment on this page, "#2 on /about" elsewhere, "" if unknown.
export function pinLabel(id) {
  const c = S.comments.find((x) => x.id === id);
  if (!c) return '';
  const key = normalizePath(c.page);
  const n = S.comments.filter((x) => normalizePath(x.page) === key).findIndex((x) => x.id === id) + 1;
  return '#' + n + (key === PAGE ? '' : ' on ' + key);
}

export function activityText(e) {
  if (!e) return '';
  if (e.kind === 'edit') return 'edited ' + (e.file || e.text || 'a file');
  if (e.kind === 'done') return (e.text || 'done') + (e.took ? ' · took ' + fmtDur(e.took) : '');
  if (e.kind === 'idle') return e.text || 'paused';
  return e.text || e.kind;
}

// ---------- the shared mutable state ----------
function initialLang() {
  const l = LS.get('kbf-voicelang') || DEFAULT_LANG;
  return LANGS.some((x) => x.code === l) ? l : DEFAULT_LANG;
}

export const S = {
  comments: [],
  mode: SS.get('kbf-mode') === '1',           // Point mode on/off
  panelOpen: SS.get('kbf-panel') === '1',
  filter: SS.get('kbf-filter') || 'all',
  theme: LS.get('kbf-theme') === 'dark' ? 'dark' : 'light', // light (default) | dark; legacy 'auto'/unset -> light
  activeComposer: null,                        // { kind:'new'|'edit', anchor, rect, comment? }
  placed: [],                                  // [{ comment, el, pinEl }]
  // How each current-page comment's anchor resolved on the LAST renderPins pass:
  // id → 'high' | 'medium' | 'low' | 'lost'. The List reads this to warn the
  // reviewer (and offer a re-pin) BEFORE the agent hits a refuse-and-ask.
  pinConf: new Map(),
  targetEls: [],                               // rainbow highlight boxes over the element/text being commented on
  expandedId: null,                            // which comment's conversation thread is open in the panel
  focusReplyNext: false,                       // focus the reply box on the next render (after an explicit expand)
  // id -> in-progress reply text, preserved across re-renders. Entries are only
  // removed on a successful send; a draft for a deleted comment is harmless
  // (ids are UUIDs, never reused) and the map clears on page reload.
  replyDrafts: {},

  // voice dictation (composer)
  recognizing: false,
  recognition: null,
  voiceManualStop: false,                      // true when the user (not a pause) stopped dictation
  speechLang: initialLang(),

  // hover / aiming
  rafHover: 0,
  lastMouse: null,                             // last known cursor position — lets a scroll re-aim the hover highlight
  sentEls: [],                                 // fill boxes over the hovered sentence (one per line box)
  sentCache: null,                             // { block, pieces, text, segs } for the block under the cursor

  // touch element picker
  pickChain: [],
  pickIdx: 0,

  // composer type + the previews that must be torn down when it closes
  ctype: TYPES[0].id,
  // Every live on-page preview registers its own undo here, and closeComposer
  // drains the list. Keyed so one can be closed on its own (Escape closes the
  // crop modal without closing the composer under it).
  teardown: [],                                // [{ key, fn }]
  variantPreview: null,                        // { comment, reply, el, prevDisplay, container, bar, index, scrubbed }

  // narration ("Talk me through it")
  narrating: false,
  narrSession: 0,                              // bumped on every start/stop — stale recognizer events no-op
  narrRec: null,                               // dedicated SpeechRecognition (separate from composer dictation)
  narrTranscript: [],                          // [{ t, text }] finalised phrases
  narrHovers: [],                              // [{ key, text, t0, t1, anchor }]
  narrClicks: [],                              // [{ t, key, text, anchor }]
  narrCur: null,                               // current hover interval being built
  narrBar: null,                               // the live recording bar
  narrTimeout: 0,                              // safety auto-stop
  draftTray: null,

  // walkthrough ("agent narrates back")
  walkState: null,                             // { list, i, playing }
  walkBar: null,

  // positioning + DOM watching
  rafPos: 0,
  moTimer: 0,

  // agent presence + activity
  agent: { state: 'offline', name: '', commentId: '', since: 0, note: '', lastSeen: 0, queue: [] },
  activity: [],
  activityUnread: 0,
  activityOpen: false,
  agentTick: 0,
  agentKey: '',
  baseTitle: '',
  tabDone: false,
  favOrig: null,

  // deletes, live stream, reload
  // Ids deleted locally whose server DELETE is still deferred (the Undo window).
  // An SSE broadcast in that window still contains them server-side — filtering
  // them out of applyComments stops the deleted card flickering back for 5s.
  pendingDeletes: new Set(),
  es: null,
  sseBackoff: 1000,
  reloadPending: false,

  justDraggedFab: false,                       // set true on a FAB drag so the trailing click doesn't toggle
};

// ---------- preview teardown registry ----------
export function addTeardown(key, fn) {
  removeTeardown(key);
  S.teardown.push({ key, fn });
}
export function removeTeardown(key) {
  const i = S.teardown.findIndex((t) => t.key === key);
  if (i >= 0) S.teardown.splice(i, 1);
}
export function hasTeardown(key) {
  return S.teardown.some((t) => t.key === key);
}
// Run and forget ONE preview's undo. Returns false when it wasn't registered.
export function runTeardown(key) {
  const i = S.teardown.findIndex((t) => t.key === key);
  if (i < 0) return false;
  const [t] = S.teardown.splice(i, 1);
  try { t.fn(); } catch (e) {}
  return true;
}
// Undo every live preview, in the order they were armed.
export function drainTeardown() {
  for (const t of S.teardown.splice(0)) { try { t.fn(); } catch (e) {} }
}
