// Feedback Studio — the overlay's own chrome: icons, the shadow host, the
// element references every other module writes into, and the small shared UI
// helpers (toasts, the hover highlight, escaping).
//
// mountUI() builds the whole thing once, from boot.mjs. Until it runs the
// exported element references are undefined by design — they are live bindings,
// so importers see the real nodes the moment they exist.

import { S, LABEL } from '/__feedback/overlay/state.mjs';

// ---------- icons ----------
export const I = {
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  jump: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  reject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.3" y1="5.3" x2="7" y2="7"/><line x1="17" y1="17" x2="18.7" y2="18.7"/><line x1="5.3" y1="18.7" x2="7" y2="17"/><line x1="17" y1="7" x2="18.7" y2="5.3"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  alignL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="14" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>',
  alignC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6.5" y1="12" x2="17.5" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>',
  alignR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  narrate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M2 19h5M17 19h5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  point: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l6.5 16 2.2-6.8 6.8-2.2z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h2v14H7zM20 5v14l-10-7z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M15 5h2v14h-2zM4 5v14l10-7z"/></svg>',
};

// ---------- the shadow host and everything inside it ----------
// Live bindings: undefined until mountUI() runs, the real nodes afterwards.
export let host;
export let root;
export let ui;
export let hl;
export let hlTag;
export let pinsLayer;
export let targetsLayer;
export let sentsLayer;
export let picker;
export let pickerTag;
export let composerSlot;
export let panel;
export let listEl;
export let subEl;
export let countEl;
export let readyEl;
export let modeBtn;
export let toastsEl;

export const $ = (id) => root.getElementById(id);

export function mountUI() {
  host = document.createElement('div');
  host.id = 'kbf-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;margin:0;padding:0;border:0;';
  (document.body || document.documentElement).appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/__feedback/overlay.css';
  root.appendChild(link);

  ui = document.createElement('div');
  // Boot invisibly until the stylesheet has actually applied: over a slow link
  // (e.g. a tunnel) overlay.css lands well after first paint, so the raw
  // panel/FAB markup flashes unstyled — and when the CSS then applies, the
  // panel's closed-state transform TRANSITIONS to off-screen, a visible
  // left→right slide on every load. kbf-preboot freezes transitions/animations
  // for that first styled frame so state applies as a jump, not a slide.
  ui.classList.add('kbf-preboot');
  ui.style.visibility = 'hidden';
  const bootReveal = () => requestAnimationFrame(() => {
    ui.classList.remove('kbf-preboot');
    ui.style.visibility = '';
  });
  if (link.sheet) bootReveal();
  else {
    link.addEventListener('load', bootReveal);
    link.addEventListener('error', bootReveal); // unstyled beats invisible
    setTimeout(bootReveal, 2000); // safety net (idempotent if load already fired)
  }
  ui.innerHTML = `
    <div class="kbf-highlight" id="kbf-hl"><span class="kbf-tag" id="kbf-tag"></span></div>
    <div id="kbf-sents"></div>
    <div id="kbf-targets"></div>
    <div id="kbf-pins"></div>
    <div class="kbf-picker" id="kbf-picker">
      <span class="kbf-picker-tag" id="kbf-picker-tag"></span>
      <button class="kbf-picker-btn" data-pick="wider" title="Select the surrounding element">${I.up}</button>
      <button class="kbf-picker-btn" data-pick="narrower" title="Select a more specific element">${I.down}</button>
      <button class="kbf-picker-go" data-pick="comment">Comment</button>
      <button class="kbf-picker-btn kbf-picker-x" data-pick="cancel" title="Cancel">${I.close}</button>
    </div>
    <div id="kbf-composer-slot"></div>

    <aside class="kbf-panel ${S.panelOpen ? 'is-open' : ''}" id="kbf-panel" role="region" aria-label="Feedback" tabindex="-1">
      <div class="kbf-panel-head">
        <div class="kbf-panel-title">
          <h2>Feedback${LABEL ? ` <span class="kbf-site">${escapeHtml(LABEL)}</span>` : ''}</h2>
          <div class="kbf-panel-actions">
            <button class="kbf-x" id="kbf-theme-toggle" title="Theme" aria-label="Theme"></button>
            <button class="kbf-x" id="kbf-panel-close" title="Close" aria-label="Close feedback panel">${I.close}</button>
          </div>
        </div>
        <div class="kbf-panel-sub" id="kbf-panel-sub"></div>
        <div class="kbf-agent-row" id="kbf-agent-row" hidden>
          <div class="kbf-agent-chip" id="kbf-agent-chip" role="status"><span class="kbf-agent-dot"></span><span id="kbf-agent-text"></span></div>
          <button type="button" class="kbf-agent-actbtn" id="kbf-activity-btn" title="What the agent has been doing" aria-expanded="false">Activity<span class="kbf-agent-count" id="kbf-activity-count" hidden></span></button>
        </div>
        <div class="kbf-agent-note" id="kbf-agent-note" hidden></div>
        <div class="kbf-activity" id="kbf-activity" hidden aria-label="Agent activity"></div>
        <div class="kbf-filters" role="group" aria-label="Filter comments">
          <button class="kbf-filter" data-filter="all" aria-pressed="false">All</button>
          <button class="kbf-filter" data-filter="open" aria-pressed="false">Open</button>
          <button class="kbf-filter" data-filter="resolved" aria-pressed="false">Resolved</button>
          <button class="kbf-filter" data-filter="today" aria-pressed="false" title="Comments added or changed today">Today</button>
        </div>
      </div>
      <div class="kbf-list" id="kbf-list"></div>
      <div class="kbf-panel-foot">
        <span class="kbf-readyline" id="kbf-ready" title="Saved to .feedback/comments.json + FEEDBACK.md"></span>
        <button class="kbf-btn kbf-btn--ghost kbf-walk-btn" id="kbf-walk" title="Play a guided tour of what the agent changed, read aloud" style="display:none">${I.play} Walk me through the changes</button>
        <button class="kbf-btn kbf-btn--ghost kbf-stamp" id="kbf-stamp" title="Write these comments into the .md as @FB markers (portable + greppable)" style="display:none">Stamp .md</button>
        <span class="kbf-copyfb-caption" title="Saved to .feedback/ — say this to your coding agent to apply the comments">Tell your agent: <strong>“Please process feedback”</strong> (PPF)</span>
      </div>
    </aside>

    <div class="kbf-fab-wrap">
      ${LABEL ? `<div class="kbf-fab-site" title="This feedback session: ${escapeHtml(LABEL)}">${escapeHtml(LABEL)}</div>` : ''}
      <button class="kbf-fab kbf-fab--mini" id="kbf-toggle-panel" title="Feedback list" aria-label="Open feedback list" aria-expanded="${S.panelOpen ? 'true' : 'false'}">
        <span class="kbf-fab-label">List</span><span class="kbf-fab-ico">${I.list}<span class="kbf-count" id="kbf-count"></span></span>
      </button>
      <button class="kbf-fab kbf-fab--talk" id="kbf-narrate" title="Talk — narrate the page by voice (T)" aria-label="Talk (narrate the page), shortcut T" aria-pressed="false">
        <span class="kbf-fab-label">Talk</span><span class="kbf-fab-ico">${I.narrate}</span>
      </button>
      <button class="kbf-fab" id="kbf-toggle-mode" title="Point at an element to comment (P)" aria-pressed="false">
        <span class="kbf-fab-label" id="kbf-mode-label">Point</span><span class="kbf-fab-ico">${I.point}</span>
      </button>
    </div>

    <div class="kbf-toasts" id="kbf-toasts" role="status" aria-live="polite"></div>
  `;
  root.appendChild(ui);

  hl = $('kbf-hl');
  hlTag = $('kbf-tag');
  pinsLayer = $('kbf-pins');
  targetsLayer = $('kbf-targets');
  sentsLayer = $('kbf-sents');
  picker = $('kbf-picker');
  pickerTag = $('kbf-picker-tag');
  composerSlot = $('kbf-composer-slot');
  panel = $('kbf-panel');
  listEl = $('kbf-list');
  subEl = $('kbf-panel-sub');
  countEl = $('kbf-count');
  readyEl = $('kbf-ready');
  modeBtn = $('kbf-toggle-mode');
  toastsEl = $('kbf-toasts');
}

// ---------- small shared helpers ----------
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

// Grow a textarea to fit its content, up to `max` px. Used by every multi-line
// box in the overlay (composer, replies, spoken drafts).
export function autoGrow(ta, max) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
}

// True when the event happened inside our own shadow UI, not on the host page.
export function isInUI(e) {
  if (e.composedPath) {
    const p = e.composedPath();
    if (p && p.length) return p.includes(host);
  }
  return !!(e.target && host.contains(e.target));
}

// The panel goes full-screen on phones (≤480px), so it would cover the element
// we jump to — close it first there.
export function panelIsFullScreen() {
  return window.matchMedia ? window.matchMedia('(max-width: 480px)').matches : window.innerWidth <= 480;
}

// ---------- hover highlight + sentence fill ----------
export function hideHighlight() { hl.classList.remove('is-on'); clearSentence(); }

export function showHighlightFor(el) {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) { hideHighlight(); return; }
  hl.style.left = r.left + 'px';
  hl.style.top = r.top + 'px';
  hl.style.width = r.width + 'px';
  hl.style.height = r.height + 'px';
  hlTag.textContent = el.nodeName.toLowerCase() + (el.id ? '#' + el.id : '');
  hl.classList.add('is-on');
}

export function clearSentence() {
  S.sentEls.forEach((d) => d.remove());
  S.sentEls = [];
}

export function showSentence(range) {
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
  while (S.sentEls.length > rects.length) S.sentEls.pop().remove();
  while (S.sentEls.length < rects.length) {
    const d = document.createElement('div');
    d.className = 'kbf-sent';
    sentsLayer.appendChild(d);
    S.sentEls.push(d);
  }
  rects.forEach((r, i) => {
    S.sentEls[i].style.cssText = `left:${r.left - 2}px;top:${r.top - 1}px;width:${r.width + 4}px;height:${r.height + 2}px`;
  });
}

export function flashEl(el) {
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  f.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid var(--kbf-clay);border-radius:6px;background:rgba(217,119,87,.12);pointer-events:none;z-index:3;transition:opacity .9s ease;`;
  pinsLayer.appendChild(f);
  requestAnimationFrame(() => { f.style.opacity = '0'; });
  setTimeout(() => f.remove(), 1000);
}

export function flashCard(card) {
  card.style.transition = 'box-shadow .3s';
  card.style.boxShadow = '0 0 0 2px var(--kbf-clay)';
  setTimeout(() => { card.style.boxShadow = ''; }, 1100);
}

// Before scrolling to a host element, let the host page un-hide it: the --md
// doc shell listens for this and reopens a folded chapter that contains the
// target. On pages without a listener it's a no-op.
export function revealEl(el) {
  if (!el) return;
  try { document.dispatchEvent(new CustomEvent('kbf:reveal', { detail: { el } })); } catch (e) {}
}

// ---------- the FAB cluster, as seen by the bottom bars ----------
// The tall draft tray sits in the FAB's own corner, so hide the cluster while
// it's up. (Used only for the draft tray now — see setFabRaised for the bars.)
export function setChromeHidden(hidden) {
  const fw = root.querySelector('.kbf-fab-wrap');
  if (fw) fw.style.visibility = hidden ? 'hidden' : '';
}
// For the narrate/walk bottom bars: DON'T hide the buttons (that felt like the
// whole UI vanished) — just lift the cluster above the bar so they stay visible
// and reachable. Only affects bottom corners; top-docked FABs need no lift.
export function setFabRaised(raised) {
  const fw = root.querySelector('.kbf-fab-wrap');
  if (fw) fw.classList.toggle('kbf-fab-wrap--raised', raised);
}

// ---------- toast ----------
// opts: { error?:bool, actionLabel?:string, onAction?:fn, duration?:ms }
// ---------- keyboard focus ----------
// Keep Tab inside a dialog while it is open, and put focus back where it was
// when it closes. Returns the release function. `initial` is focused right
// away when given. Only elements that are visible take part, so a hidden
// section of the composer never captures the Tab key.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function trapFocus(container, opts = {}) {
  const prev = root.activeElement || document.activeElement;
  const items = () => [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length);
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const list = items();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const cur = root.activeElement;
    if (e.shiftKey && (cur === first || !container.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !container.contains(cur))) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  if (opts.initial) { try { opts.initial.focus(); } catch (e) {} }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    container.removeEventListener('keydown', onKey);
    // Give focus back only when it is still inside the closing dialog (or was
    // lost with it); a reviewer who already clicked elsewhere keeps their place.
    const cur = root.activeElement;
    const inside = !cur || container.contains(cur);
    if (inside && prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (e) {}
    }
  };
}

export function toast(msg, opts = {}) {
  const t = document.createElement('div');
  t.className = 'kbf-toast' + (opts.error ? ' kbf-toast--error' : '');
  t.innerHTML = (opts.error ? I.alert : I.check) + '<span>' + escapeHtml(msg) + '</span>';
  let dismissed = false;
  const remove = () => { if (dismissed) return; dismissed = true; t.classList.add('is-out'); setTimeout(() => t.remove(), 220); };
  if (opts.actionLabel) {
    const a = document.createElement('button');
    a.className = 'kbf-toast-action';
    a.textContent = opts.actionLabel;
    a.addEventListener('click', () => { if (opts.onAction) opts.onAction(); remove(); });
    t.appendChild(a);
  }
  toastsEl.appendChild(t);
  setTimeout(remove, opts.duration || 2200);
  return t;
}
export function toastError(msg) { return toast(msg, { error: true }); }
