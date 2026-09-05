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
import { normalizePath } from '/__feedback/lib/nav.mjs';
import { lastTouch, matchesQuery, SORT_DEFAULT, isSortKey, defaultDir } from '/__feedback/lib/sort.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';
export { normalizePath, lastTouch };

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

// The page key lives on S.page (below) and is updated live when a single-page
// app changes the path without a load; see lib/nav.mjs and boot.mjs.

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

export const PLACEHOLDER = t('What needs to change here? (typed or spoken)');

// ---------- comment types ----------
// Comment types decide how much latitude the AI agent gets. Websites and
// documents need different verbs, so the set depends on the mode. The ID SET is
// the shared schema's (imported above) — the overlay only adds the wording, so
// the two can no longer drift apart.
const TYPE_META = {
  web: {
    fix: { label: t('Fix'), hint: t('Something is broken or wrong — reproduce and patch it.'), placeholder: t('What’s broken, and what should happen instead? (typed or spoken)') },
    change: { label: t('Change'), hint: t('Make it exactly this — apply near-verbatim, no redesign.'), placeholder: t('What should this say or look like? (typed or spoken)') },
    improve: { label: t('Improve'), hint: t('This is weak — rewrite or redesign with judgement.'), placeholder: t('What could be better here? (typed or spoken)') },
    question: { label: t('Ask'), hint: t('Ask about this — the agent answers in a reply, and does not change it.'), placeholder: t('What’s your question about this? (typed or spoken)') },
  },
  md: {
    comment: { label: t('Comment'), hint: t('A general note about this passage.'), placeholder: t('Your note on this passage (typed or spoken)') },
    rephrase: { label: t('Rephrase'), hint: t('Propose specific replacement wording.'), placeholder: t('How should this be reworded? (typed or spoken)') },
    expand: { label: t('Expand'), hint: t('Add more detail / content here.'), placeholder: t('What should be added or expanded on? (typed or spoken)') },
    delete: { label: t('Delete'), hint: t('Remove this passage.'), placeholder: t('Why should this be removed? (optional, typed or spoken)') },
    question: { label: t('Question'), hint: t('Ask the agent something about this.'), placeholder: t('What’s your question about this? (typed or spoken)') },
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

// lastTouch (newest activity on a comment) is shared with the sort rules in lib/sort.mjs.

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
  return S.comments.filter((c) => normalizePath(c.page) === S.page);
}

// The List's chips and search box, applied to any list of comments. The pins
// use the same rule, so what you hide in the List is hidden on the page too.
export function filtered(list) {
  let out = list;
  if (S.filter === 'open') out = out.filter(isOpenC);
  else if (S.filter === 'resolved') out = out.filter((c) => c.status === 'resolved');
  else if (S.filter === 'today') out = out.filter(isTodayC);
  else if (S.filter === 'round') out = out.filter((c) => (c.round || 1) === S.round);
  if (S.query) out = out.filter((c) => matchesQuery(c, S.query));
  return out;
}

// The sort the reviewer picked, remembered for this tab. A key that no longer
// exists falls back to the default rather than breaking the List.
function initialSort() {
  try {
    const s = JSON.parse(SS.get('kbf-sort') || 'null');
    if (s && isSortKey(s.key)) return { key: s.key, dir: s.dir === 'asc' ? 'asc' : 'desc' };
  } catch (e) {}
  return { ...SORT_DEFAULT };
}
export { defaultDir };

// A share-link commenter's own comments: a random token made once per browser
// is sent with every request; the server keeps only its hash and lets that
// browser edit or delete its own comments while they are still open. The host
// (full / admin) does not need it, so it is only made for the comment role.
function authorToken() {
  if (ROLE !== 'comment') return '';
  let tok = LS.get('kbf-author') || '';
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(tok)) {
    const bytes = new Uint8Array(24);
    try { crypto.getRandomValues(bytes); } catch (e) { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
    tok = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    LS.set('kbf-author', tok);
  }
  return tok;
}
export const AUTHOR_TOKEN = authorToken();
// The ids this browser created, so its cards show Edit / Delete. The server
// checks the token on every such request; this list only decides what to show.
function loadMine() { try { return new Set(JSON.parse(LS.get('kbf-mine') || '[]')); } catch (e) { return new Set(); } }
const MINE = loadMine();
export function markMine(id) {
  if (ROLE !== 'comment' || !id) return;
  MINE.add(id);
  LS.set('kbf-mine', JSON.stringify([...MINE].slice(-500)));
}
export const isMineC = (c) => ROLE === 'comment' && MINE.has(c.id);

export function editsSummary(c) {
  const ed = Array.isArray(c.edits) ? c.edits : [];
  return ed.map((e) => e.prop + ' ' + (e.from || '?') + ' → ' + e.to).join(', ');
}

// The comments a walkthrough can narrate: only this page's (the tour resolves
// anchors against the live DOM) and only ones the agent has replied to.
export function walkComments() {
  return S.comments.filter((c) => normalizePath(c.page) === S.page
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
  return '#' + n + (key === S.page ? '' : ' on ' + key);
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
  page: normalizePath(location.pathname),      // the page key; moves with the URL in a single-page app
  mode: SS.get('kbf-mode') === '1',           // Point mode on/off
  panelOpen: SS.get('kbf-panel') === '1',
  panelRelease: null,                          // releases the panel's focus trap (phone layout) on close
  filter: SS.get('kbf-filter') || 'all',
  sort: initialSort(),                         // { key, dir } — see lib/sort.mjs
  query: SS.get('kbf-query') || '',            // the List's search box
  round: 1,                                    // the current review round, from the server
  roundStartedAt: '',
  view: 'list',                                // 'list' | 'history' (Markdown mode: the document's versions)
  cursorId: null,                              // the pin the keyboard (j / k) is on
  lang: 'en',
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

  // live stream, reload
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
