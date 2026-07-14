// Feedback Studio — overlay client
// Mounted on every page via the local feedback server. Lets you attach
// comments (typed or spoken) to any element or text selection, persists them
// server-side, and renders pins + a cross-page review panel.

(function () {
  if (window.__kbfMounted) return;
  window.__kbfMounted = true;

  // Share role (injected by the server under --share): 'full' when absent.
  // view = read-only; comment = may add comments/replies (no statuses, edits or
  // deletes — those are the host team's); none = no valid key, mount nothing.
  const ROLE = window.__kbfRole || 'full';
  if (ROLE === 'none') return;
  const LABEL = String(window.__kbfLabel || '').slice(0, 60); // site name in a multi-site repo
  const CAN_COMMENT = ROLE !== 'view';
  const CAN_MANAGE = ROLE === 'full' || ROLE === 'admin';

  const API = '/__feedback/api';
  const ROOT = API.replace(/\/api$/, ''); // '/__feedback' — base for /events and /api/*
  const PAGE = normalizePath(location.pathname);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

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
  const SS = mkStore(() => window.sessionStorage);
  const LS = mkStore(() => window.localStorage);

  // ---------- state ----------
  let comments = [];
  let mode = SS.get('kbf-mode') === '1';
  let panelOpen = SS.get('kbf-panel') === '1';
  let filter = SS.get('kbf-filter') || 'all';
  let theme = LS.get('kbf-theme') === 'dark' ? 'dark' : 'light'; // light (default) | dark; legacy 'auto'/unset -> light
  let activeComposer = null; // { kind:'new'|'edit', anchor, rect, comment? }
  let placed = []; // [{ comment, el, pinEl }]
  let targetEls = []; // rainbow highlight boxes over the element/text being commented on
  let expandedId = null; // which comment's conversation thread is open in the panel
  let focusReplyNext = false; // focus the reply box on the next render (after an explicit expand)
  // id -> in-progress reply text, preserved across re-renders. Entries are only
  // removed on a successful send; a draft for a deleted comment is harmless
  // (ids are UUIDs, never reused) and the map clears on page reload.
  const replyDrafts = {};
  const isOpenC = (c) => c.status !== 'resolved' && c.status !== 'rejected';
  let recognizing = false;
  let recognition = null;
  let voiceManualStop = false; // true when the user (not a pause) stopped dictation
  let rafHover = 0;
  // Voice dictation languages (BCP-47, the most widely spoken + common dev locales).
  // The UI is English by default; this only sets the speech-recognition language.
  const LANGS = [
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
  const DEFAULT_LANG = 'en-US';
  let speechLang = LS.get('kbf-voicelang') || DEFAULT_LANG;
  if (!LANGS.some((l) => l.code === speechLang)) speechLang = DEFAULT_LANG;
  const langName = (code) => (LANGS.find((l) => l.code === code) || LANGS[0]).name;
  const langShort = (code) => code.split('-')[0].toUpperCase();
  const PLACEHOLDER = 'What needs to change here? (typed or spoken)';

  // Comment types decide how much latitude the AI agent gets. Websites and
  // documents need different verbs, so the set depends on the mode.
  // NOTE: this is a mirror of WEB_TYPES/MD_TYPES in lib/store.mjs — the overlay
  // can't import the server module (it runs in the browser). store.test.mjs
  // asserts the two stay in sync, so update both if you change the type set.
  const MODE = (typeof window !== 'undefined' && window.__kbfMode) || 'web';
  const TYPE_SETS = {
    web: [
      { id: 'fix', label: 'Fix', hint: 'Something is broken or wrong — reproduce and patch it.', placeholder: 'What’s broken, and what should happen instead? (typed or spoken)' },
      { id: 'change', label: 'Change', hint: 'Make it exactly this — apply near-verbatim, no redesign.', placeholder: 'What should this say or look like? (typed or spoken)' },
      { id: 'improve', label: 'Improve', hint: 'This is weak — rewrite or redesign with judgement.', placeholder: 'What could be better here? (typed or spoken)' },
      { id: 'question', label: 'Ask', hint: 'Ask about this — the agent answers in a reply, and does not change it.', placeholder: 'What’s your question about this? (typed or spoken)' },
    ],
    md: [
      { id: 'comment', label: 'Comment', hint: 'A general note about this passage.', placeholder: 'Your note on this passage (typed or spoken)' },
      { id: 'rephrase', label: 'Rephrase', hint: 'Propose specific replacement wording.', placeholder: 'How should this be reworded? (typed or spoken)' },
      { id: 'expand', label: 'Expand', hint: 'Add more detail / content here.', placeholder: 'What should be added or expanded on? (typed or spoken)' },
      { id: 'delete', label: 'Delete', hint: 'Remove this passage.', placeholder: 'Why should this be removed? (optional, typed or spoken)' },
      { id: 'question', label: 'Question', hint: 'Ask the agent something about this.', placeholder: 'What’s your question about this? (typed or spoken)' },
    ],
  };
  const TYPES = TYPE_SETS[MODE] || TYPE_SETS.web;
  const TYPE_IDS = TYPES.map((t) => t.id);
  const placeholderFor = (id) => (TYPES.find((t) => t.id === id) || {}).placeholder || PLACEHOLDER;
  let ctype = LS.get('kbf-ctype-' + MODE) || TYPES[0].id;
  if (!TYPE_IDS.includes(ctype)) ctype = TYPES[0].id;

  function normalizePath(p) {
    // '/x' and '/x/' serve the same content here — collapse to one key so pins
    // made on one form still render when the page is visited via the other.
    p = p.replace(/index\.html$/, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }

  // The .md file this page renders (comment.sourceFile), '' in web mode.
  const SOURCE = (typeof window !== 'undefined' && window.__kbfSource) || '';
  // In Markdown mode the rendered HTML is throwaway and several .md files can
  // share ONE .feedback dir — and in single-file `--md` mode they all serve at
  // the same path ('/'), so filtering by `page` alone leaks another file's
  // comments onto this view (the "cross-file bleed" bug). Scope the whole
  // overlay's comment universe to the served source file. In web mode SOURCE is
  // '' and this is a no-op; in md-index mode each file has its own sourceFile so
  // it simply keeps each page to its own comments.
  function scopeComments(list) {
    if (MODE !== 'md') return list;
    return list.filter((c) => (c.sourceFile || '') === SOURCE);
  }

  // ---------- icons ----------
  const I = {
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
    themeAuto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>',
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

  // ---------- shadow host ----------
  const host = document.createElement('div');
  host.id = 'kbf-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;margin:0;padding:0;border:0;';
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/__feedback/overlay.css';
  root.appendChild(link);

  const ui = document.createElement('div');
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

    <aside class="kbf-panel ${panelOpen ? 'is-open' : ''}" id="kbf-panel" role="region" aria-label="Feedback">
      <div class="kbf-panel-head">
        <div class="kbf-panel-title">
          <h2>Feedback${LABEL ? ` <span class="kbf-site">${escapeHtml(LABEL)}</span>` : ''}</h2>
          <div class="kbf-panel-actions">
            <button class="kbf-x" id="kbf-theme-toggle" title="Theme" aria-label="Theme"></button>
            <button class="kbf-x" id="kbf-panel-close" title="Close" aria-label="Close feedback panel">${I.close}</button>
          </div>
        </div>
        <div class="kbf-panel-sub" id="kbf-panel-sub"></div>
        <div class="kbf-agent-chip" id="kbf-agent-chip" hidden role="status"><span class="kbf-agent-dot"></span><span id="kbf-agent-text"></span></div>
        <div class="kbf-filters" role="group" aria-label="Filter comments">
          <button class="kbf-filter" data-filter="all" aria-pressed="false">All</button>
          <button class="kbf-filter" data-filter="open" aria-pressed="false">Open</button>
          <button class="kbf-filter" data-filter="resolved" aria-pressed="false">Resolved</button>
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
      <button class="kbf-fab kbf-fab--mini" id="kbf-toggle-panel" title="Feedback list" aria-label="Open feedback list" aria-expanded="${panelOpen ? 'true' : 'false'}">
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

  const $ = (id) => root.getElementById(id);
  const hl = $('kbf-hl');
  const hlTag = $('kbf-tag');
  const pinsLayer = $('kbf-pins');
  const targetsLayer = $('kbf-targets');
  const picker = $('kbf-picker');
  const pickerTag = $('kbf-picker-tag');
  const composerSlot = $('kbf-composer-slot');
  const panel = $('kbf-panel');
  const listEl = $('kbf-list');
  const subEl = $('kbf-panel-sub');
  const countEl = $('kbf-count');
  const readyEl = $('kbf-ready');
  const modeBtn = $('kbf-toggle-mode');
  const toastsEl = $('kbf-toasts');

  // ---------- anchoring ----------
  function cssEsc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el === document.body) return 'body';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node === document.body) { parts.unshift('body'); break; }
      if (node.id && document.querySelectorAll('#' + cssEsc(node.id)).length === 1) {
        parts.unshift('#' + cssEsc(node.id));
        return parts.join(' > ');
      }
      let sel = node.nodeName.toLowerCase();
      let nth = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.nodeName === node.nodeName) nth++;
      parts.unshift(sel + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  // A stable attribute selector (test ids, name, unique id), if one resolves uniquely.
  function stableAttrSelector(el) {
    const tag = el.nodeName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-id', 'id', 'name']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const sel = a === 'id' ? '#' + cssEsc(v) : tag + '[' + a + '="' + String(v).replace(/"/g, '\\"') + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
    }
    return '';
  }
  function xPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) { try { if (document.querySelectorAll('#' + cssEsc(el.id)).length === 1) return '//*[@id="' + el.id + '"]'; } catch (e) {} }
    const segs = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let i = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.nodeName === node.nodeName) i++;
      segs.unshift(node.nodeName.toLowerCase() + '[' + i + ']');
      if (node === document.body) break;
    }
    return '/' + segs.join('/');
  }
  function byXPath(xp) {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue instanceof Element ? r.singleNodeValue : null;
    } catch (e) { return null; }
  }
  // Cache the all-elements scan for one resolve pass (renderPins resolves every
  // comment; without this each byText() fallback re-walks the whole DOM).
  function makePool() {
    let all = null;
    return { all() { if (!all) { try { all = [...document.querySelectorAll('*')]; } catch (e) { all = []; } } return all; } };
  }
  function byText(snip, tag, pool) {
    if (!snip) return null;
    const t = norm(snip).slice(0, 80).toLowerCase(); // case-insensitive: text-transform shifts innerText case
    let list;
    if (tag && tag !== 'body') {
      try { list = [...document.querySelectorAll(tag)]; } catch (e) { list = pool ? pool.all() : [...document.querySelectorAll('*')]; }
    } else {
      list = pool ? pool.all() : [...document.querySelectorAll('*')];
    }
    let found = list.find((e) => norm(e.textContent).toLowerCase().startsWith(t) && e.getClientRects().length);
    if (!found) found = list.find((e) => norm(e.textContent).toLowerCase().includes(t) && e.getClientRects().length);
    return found || null;
  }

  // How well an element's text corroborates the stored snippet.
  //   strong = text starts with the snippet (the element itself, not a wrapper)
  //   weak   = snippet is buried inside much larger text (likely an over-broad ancestor)
  //   none   = snippet not present at all
  function textRel(el, snip) {
    if (!snip) return 'strong';
    const a = norm(el.textContent).toLowerCase();
    const b = norm(snip).toLowerCase().slice(0, 80);
    if (!b) return 'strong';
    if (a.startsWith(b)) return 'strong';
    if (a.includes(b)) return a.length <= b.length * 1.6 ? 'strong' : 'weak';
    return 'none';
  }
  // A built anchor with no text gets a "<tag>" placeholder snippet — not real text.
  const isPlaceholderSnippet = (s) => !s || /^<[a-z0-9]+>$/i.test(s);

  // Resolve an anchor with a confidence tier. The key safety property: selector
  // and xpath are BOTH positional encodings of the same DOM path, so they rot
  // together after an edit — their agreement is not independent corroboration.
  // We group them into one "structural" family and require a genuinely
  // independent signal (a stable attr, or a strong text match) before we call a
  // match "high". Anything weaker degrades to medium/low so a guessed wrong
  // element is never edited with confidence.
  function resolveWithConfidence(a, pool) {
    if (!a) return { el: null, confidence: null };
    const rawSnip = a.snippet || a.rangeText;
    const hasText = !isPlaceholderSnippet(rawSnip);
    const cands = [];
    const tryStrat = (name, fn) => { try { const el = fn(); if (el) cands.push({ name, el }); } catch (e) {} };
    if (a.attrSelector) tryStrat('attr', () => document.querySelector(a.attrSelector));
    if (a.selector) tryStrat('selector', () => document.querySelector(a.selector));
    if (a.xpath) tryStrat('xpath', () => byXPath(a.xpath));
    if (hasText) tryStrat('text', () => byText(rawSnip, a.tag, pool));
    if (!cands.length) return { el: null, confidence: null };

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
      const tr = textRel(best, rawSnip);
      if ((set.has('attr') || set.has('structural')) && tr === 'strong') confidence = 'high';
      else if (set.has('text') && tr === 'strong') confidence = 'high';
      else if (tr !== 'none') confidence = 'medium'; // text present but not a clean match → re-check
      else confidence = 'low';
    } else {
      // No real text to corroborate. Trust only a uniquely-resolving stable attr.
      confidence = set.has('attr') ? 'high' : 'low';
    }
    return { el: best, confidence };
  }
  function resolveAnchor(a, pool) { return resolveWithConfidence(a, pool).el; }

  function buildElementAnchor(el) {
    return {
      type: 'element',
      selector: cssPath(el),
      attrSelector: stableAttrSelector(el),
      xpath: xPath(el),
      tag: el.nodeName.toLowerCase(),
      id: el.id || '',
      // textContent (not innerText): casing as authored in source, and stable across
      // text-transform / hidden descendants — better for re-finding and for grepping.
      snippet: norm(el.textContent).slice(0, 140) || ('<' + el.nodeName.toLowerCase() + '>'),
    };
  }
  function buildRangeAnchor(sel) {
    const range = sel.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType !== 1) container = container.parentElement;
    return {
      type: 'range',
      selector: cssPath(container),
      attrSelector: stableAttrSelector(container),
      xpath: xPath(container),
      tag: container.nodeName.toLowerCase(),
      id: container.id || '',
      rangeText: norm(sel.toString()).slice(0, 240),
      snippet: norm(sel.toString()).slice(0, 140),
    };
  }

  // Test hook: the anchor an element would get (used by the anchor-rot harness).
  window.__kbfBuildAnchor = (el) => (el && el.nodeType === 1 ? buildElementAnchor(el) : null);

  // Reproducible anchor self-test: re-resolve every comment anchored on this page
  // and report the confidence + whether the resolved element still matches the text.
  window.__kbfSelfTest = function () {
    const pool = makePool();
    const out = pageComments().map((c) => {
      const { el, confidence } = resolveWithConfidence(c.anchor, pool);
      const snip = c.anchor && (c.anchor.snippet || c.anchor.rangeText);
      const textOk = el ? textRel(el, snip) !== 'none' : false;
      return { id: c.id, confidence, found: !!el, textOk };
    });
    const n = out.length;
    // "Resolved" = confidently re-found (high/medium); low/none are refuse-and-re-pin.
    const resolved = out.filter((o) => o.confidence === 'high' || o.confidence === 'medium').length;
    return { total: n, resolved, rate: n ? +(resolved / n).toFixed(3) : null, detail: out };
  };

  // ---------- comment mode ----------
  function setMode(on, announce) {
    if (!CAN_COMMENT) on = false; // view links never enter comment mode
    if (on && (narrating || walkState)) return; // don't enter Point mode mid-narration/walkthrough
    const was = mode;
    mode = on;
    SS.set('kbf-mode', on ? '1' : '0');
    modeBtn.classList.toggle('is-active', on);
    modeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // label stays "Point" — active state is shown by colour, not a longer word
    // (which was clipping to "Pointin" in the fixed-width pill).
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { hideHighlight(); closeComposer(); }
    // Uniform with Talk: announce the mode when the user turns it on (not on load).
    if (on && !was && announce) toast('Point mode — click any element, or select text, to comment');
  }

  function hideHighlight() { hl.classList.remove('is-on'); }
  function showHighlightFor(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) { hideHighlight(); return; }
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    hlTag.textContent = el.nodeName.toLowerCase() + (el.id ? '#' + el.id : '');
    hl.classList.add('is-on');
  }

  function isInUI(e) {
    if (e.composedPath) {
      const p = e.composedPath();
      if (p && p.length) return p.includes(host);
    }
    return !!(e.target && host.contains(e.target));
  }

  document.addEventListener('mousemove', (e) => {
    if (!mode || activeComposer) return;
    if (isInUI(e)) { hideHighlight(); return; }
    if (rafHover) return;
    rafHover = requestAnimationFrame(() => {
      rafHover = 0;
      const el = e.target;
      if (el && el instanceof Element && el !== document.documentElement && el !== document.body) showHighlightFor(el);
      else hideHighlight();
    });
  }, true);

  document.addEventListener('click', (e) => {
    if (!mode || isInUI(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Pointer-based selection. Mouse opens the composer straight away (with the
  // live hover highlight to aim). Touch/pen taps a candidate element and shows a
  // picker to walk up/down the DOM, because phones have no hover to preview with.
  let pdown = null;
  document.addEventListener('pointerdown', (e) => {
    if (!mode || isInUI(e)) return;
    pdown = { x: e.clientX, y: e.clientY, type: e.pointerType };
  }, true);

  document.addEventListener('pointerup', (e) => {
    if (!mode || isInUI(e) || activeComposer) return;
    const moved = pdown ? Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y) : 0;
    const type = e.pointerType || (pdown && pdown.type) || 'mouse';
    const target = e.target;
    pdown = null;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && norm(sel.toString())) {
        clearPick();
        openComposer({ kind: 'new', anchor: buildRangeAnchor(sel), rect: sel.getRangeAt(0).getBoundingClientRect(), range: sel.getRangeAt(0).cloneRange() });
        return;
      }
      if (moved > 10) return; // a scroll / swipe / drag, not a tap
      if (!(target instanceof Element) || target === document.body || target === document.documentElement) return;
      // never anchor a comment to a variant-preview candidate — it's throwaway DOM
      if (target.closest('[data-kbf-variant]')) return;
      if (type === 'mouse') {
        openComposer({ kind: 'new', anchor: buildElementAnchor(target), rect: target.getBoundingClientRect(), el: target });
      } else {
        startPick(target); // touch / pen: confirm + adjust with the picker
      }
    }, 0);
  }, true);

  // Double-click on the commented element = jump straight into editing its text
  // (the first click of the pair already opened the composer via pointerup).
  document.addEventListener('dblclick', (e) => {
    if (!mode || isInUI(e)) return;
    e.preventDefault();
    const a = activeComposer;
    if (a && a.textEditApi && a.el && (a.el === e.target || a.el.contains(e.target))) a.textEditApi.start();
  }, true);

  // ---------- touch element picker ----------
  let pickChain = [];
  let pickIdx = 0;
  function startPick(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    pickChain = [el];
    pickIdx = 0;
    renderPick();
  }
  function pickWider() {
    const cur = pickChain[pickIdx];
    const par = cur && cur.parentElement;
    if (!par || par === document.body || par === document.documentElement) return;
    if (pickIdx === pickChain.length - 1) pickChain.push(par);
    else pickChain[pickIdx + 1] = par;
    pickIdx++;
    renderPick();
  }
  function pickNarrower() {
    if (pickIdx > 0) { pickIdx--; renderPick(); }
  }
  function renderPick() {
    const el = pickChain[pickIdx];
    if (!el) return;
    showHighlightFor(el);
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
    pickerTag.textContent = el.nodeName.toLowerCase() + (el.id ? '#' + el.id : cls);
    picker.style.display = 'flex';
    const r = el.getBoundingClientRect();
    const pw = picker.offsetWidth || 250, ph = picker.offsetHeight || 46;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - ph - 8);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
    const par = el.parentElement;
    picker.querySelector('[data-pick="wider"]').disabled = !(par && par !== document.body && par !== document.documentElement);
    picker.querySelector('[data-pick="narrower"]').disabled = pickIdx === 0;
  }
  function clearPick() {
    pickChain = [];
    pickIdx = 0;
    picker.style.display = 'none';
    hideHighlight();
  }
  picker.addEventListener('click', (e) => {
    const act = e.target.closest('[data-pick]')?.dataset.pick;
    if (act === 'wider') pickWider();
    else if (act === 'narrower') pickNarrower();
    else if (act === 'cancel') clearPick();
    else if (act === 'comment') {
      const el = pickChain[pickIdx];
      picker.style.display = 'none';
      if (el) openComposer({ kind: 'new', anchor: buildElementAnchor(el), rect: el.getBoundingClientRect(), el });
    }
  });

  // ---------- tweak mode (live style knobs on the picked element) ----------
  // Lets the user *show* a style change instead of describing it: steppers and
  // pickers preview live via ONE overlay-owned <style> tag in the host document
  // (plus a marker attribute on the element), and Save records exact
  // {prop, from, to} deltas on the comment for the agent to apply to source.
  // The preview is temporary by design: everything reverts the moment the
  // composer closes — the page itself is never durably altered.
  const TWEAK_ATTR = 'data-kbf-tweak';
  const TWEAK_STYLE_ID = 'kbf-tweak-style';
  // The knobs exposed here are a subset of TWEAKABLE_PROPS in lib/store.mjs
  // (the browser can't import it); the server accepts the wider list.
  // `when(info)` gates each knob on RELEVANCE for the picked element — a knob
  // that can't visibly do anything (text size on an image, gap on a non-flex
  // box) is hidden, not disabled: fewer rows, zero dead controls.
  const TWEAK_CONTROLS = [
    { prop: 'font-size', label: 'Text size', kind: 'px', min: 6, max: 300, when: (i) => i.hasText },
    { prop: 'font-weight', label: 'Weight', kind: 'weight', when: (i) => i.hasText },
    { prop: 'text-align', label: 'Align', kind: 'align', when: (i) => i.hasText && !i.inline },
    { prop: 'color', label: 'Text color', kind: 'color', when: (i) => i.hasText },
    { prop: 'line-height', label: 'Line height', kind: 'px', min: 8, max: 400, when: (i) => i.hasText },
    { prop: 'background-color', label: 'Background color', kind: 'color' },
    { prop: 'padding', label: 'Padding', kind: 'px4', min: 0, max: 400 },
    { prop: 'margin', label: 'Margin', kind: 'px4', min: -200, max: 400 },
    // corners only make sense once there's something to round (bg / border /
    // replaced element) — but setting a Background color reveals this row live
    { prop: 'border-radius', label: 'Corners', kind: 'px4', min: 0, max: 300, when: (i) => i.hasBox },
    { prop: 'gap', label: 'Gap', kind: 'px', min: 0, max: 200, when: (i) => i.isFlexGrid },
    { prop: 'opacity', label: 'Opacity', kind: 'pct', min: 0, max: 100, step: 5 },
  ];

  // Relevance facts about the picked element, computed once per composer.
  function tweakInfo(el, cs) {
    const disp = cs.display;
    const replaced = /^(img|video|canvas|svg|picture|iframe|input|textarea|select|button)$/i.test(el.nodeName);
    const bg = cs.backgroundColor;
    return {
      hasText: !!norm(el.textContent) || /^(input|textarea|select|button)$/i.test(el.nodeName),
      inline: disp === 'inline',
      isFlexGrid: /(flex|grid)/.test(disp) && el.children.length > 1,
      hasBox: replaced || !!cssColorToHex(bg) || isTranslucent(bg) || parseFloat(cs.borderTopWidth) > 0,
    };
  }

  function clearTweakPreview() {
    const s = document.getElementById(TWEAK_STYLE_ID);
    if (s) s.remove();
    try { document.querySelectorAll('[' + TWEAK_ATTR + ']').forEach((el) => el.removeAttribute(TWEAK_ATTR)); } catch (e) {}
  }

  // rgb()/rgba() → #rrggbb (color inputs only speak hex). '' = not representable
  // as opaque hex: transparent, semi-transparent (alpha must not be silently
  // flattened away — the raw rgba() is kept as the recorded value), or unknown.
  function cssColorToHex(v) {
    v = String(v || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(v);
    if (!m || (m[4] !== undefined && parseFloat(m[4]) < 1)) return '';
    const h = (n) => (+n < 256 ? +n : 255).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }
  // alpha strictly between 0 and 1 → a real translucent color (not just "none")
  function isTranslucent(v) {
    const m = /^rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(String(v || '').trim());
    if (!m) return false;
    const a = parseFloat(m[1]);
    return a > 0 && a < 1;
  }
  const fmtPx = (n) => (Math.round(n * 10) / 10) + 'px';
  // 4 side/corner values → the shortest CSS shorthand ("16px", "16px 24px", …).
  function shorthand4(t, r, b, l) {
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return t + ' ' + r;
    if (r === l) return t + ' ' + r + ' ' + b;
    return t + ' ' + r + ' ' + b + ' ' + l;
  }

  // Read the element's current computed values for every knob (the "from" side).
  function readTweakState(el) {
    const cs = getComputedStyle(el);
    const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const state = {};
    for (const ctl of TWEAK_CONTROLS) {
      if (ctl.kind === 'px') {
        const raw = cs.getPropertyValue(ctl.prop).trim();
        let n = parseFloat(raw);
        if (isNaN(n)) {
          // line-height "normal" (and friends): show the effective px, but the
          // recorded "from" stays the honest keyword.
          n = ctl.prop === 'line-height' ? (px('font-size') || 16) * 1.2 : 0;
          state[ctl.prop] = { num: Math.round(n * 10) / 10, css: raw || 'normal', mixed: false };
        } else {
          state[ctl.prop] = { num: Math.round(n * 10) / 10, css: fmtPx(n), mixed: false };
        }
      } else if (ctl.kind === 'pct') {
        const v = parseFloat(cs.getPropertyValue(ctl.prop));
        const n = isNaN(v) ? 1 : v;
        state[ctl.prop] = { num: Math.round(n * 100), css: String(n), mixed: false };
      } else if (ctl.kind === 'align') {
        const raw = cs.getPropertyValue('text-align').trim();
        const phys = { start: 'left', end: 'right', '-webkit-left': 'left', '-webkit-right': 'right', '-webkit-center': 'center' }[raw] || raw;
        state[ctl.prop] = { val: ['left', 'center', 'right'].includes(phys) ? phys : '', css: raw, mixed: false };
      } else if (ctl.kind === 'weight') {
        const w = parseInt(cs.getPropertyValue('font-weight'), 10) || 400;
        state[ctl.prop] = { num: w, css: String(w), mixed: false };
      } else if (ctl.kind === 'color') {
        const raw = cs.getPropertyValue(ctl.prop).trim();
        const hex = cssColorToHex(raw);
        const translucent = !hex && isTranslucent(raw);
        // A translucent "from" is recorded as the honest rgba(), never a flattened hex.
        state[ctl.prop] = { hex, css: hex || (translucent ? raw : 'transparent'), raw, translucent, mixed: false };
      } else if (ctl.kind === 'px4') {
        const sides = ctl.prop === 'border-radius'
          ? ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']
          : [ctl.prop + '-top', ctl.prop + '-right', ctl.prop + '-bottom', ctl.prop + '-left'];
        const v = sides.map((s) => px(s));
        state[ctl.prop] = {
          num: Math.round(v[0] * 10) / 10,
          css: shorthand4(fmtPx(v[0]), fmtPx(v[1]), fmtPx(v[2]), fmtPx(v[3])),
          mixed: !(v[0] === v[1] && v[1] === v[2] && v[2] === v[3]),
        };
      }
    }
    return state;
  }

  function editsSummary(c) {
    const ed = Array.isArray(c.edits) ? c.edits : [];
    return ed.map((e) => e.prop + ' ' + (e.from || '?') + ' → ' + e.to).join(', ');
  }

  // A direct fresh pick (kind 'new') is ground truth. ANY element that came from
  // re-resolving a stored anchor — including the one editFromCard hands in via
  // opts.el when reopening an existing comment — must clear the confidence bar
  // before we read values off it (Tweak knobs, edit-in-place text): capturing
  // authoritative before/after data off a low-confidence GUESSED element would
  // hand the agent exactly the "confident wrong edit" the invariant forbids.
  // One shared, per-composer cache: verified once, trusted for the session.
  function makeTrustedGetEl(opts) {
    let trusted = opts.kind !== 'edit';
    return () => {
      if (trusted && opts.el && opts.el.isConnected) return opts.el;
      const { el, confidence } = resolveWithConfidence(opts.anchor);
      // Only a HIGH-confidence re-resolve is trusted for recording source-changing
      // data — 'medium' means the snippet is present but not a clean match (a
      // possibly over-broad/wrong element), which is a re-pin, not a guess.
      if (!el || confidence !== 'high') return null;
      trusted = true;
      opts.el = el;
      return el;
    };
  }

  // Build the collapsible "Tweak style" section inside the composer. Returns
  // { getEdits, count } or null when there is no live element to preview on.
  function setupTweaks(box, opts, hooks) {
    const getEl = opts.getTargetEl;
    const el = getEl();
    if (!el) return null;

    const base = readTweakState(el); // "from" values, captured once at open
    const tweaks = new Map();        // prop -> to (css string)
    const touched = new Set();       // props the USER changed this session (not primed)
    let dirty = false;               // any user touch at all?
    let priming = false;             // true while prefilling stored edits (not a user touch)

    const info = tweakInfo(el, getComputedStyle(el));
    const wrap = document.createElement('div');
    wrap.className = 'kbf-tweak';
    wrap.innerHTML = `
      <button type="button" class="kbf-tweak-toggle" aria-expanded="false">
        ${I.sliders}<span class="kbf-tweak-title">Tweak style</span>
        <span class="kbf-tweak-count" hidden></span>
        <span class="kbf-tweak-chev">${I.down}</span>
      </button>
      <div class="kbf-tweak-body">
        <div class="kbf-tweak-rows">
        ${TWEAK_CONTROLS.map((ctl) => {
          const st = base[ctl.prop];
          const off = ctl.when && !ctl.when(info);
          let control = '';
          if (ctl.kind === 'px' || ctl.kind === 'px4' || ctl.kind === 'pct') {
            const unit = ctl.kind === 'pct' ? '%' : 'px';
            control = `
              <span class="kbf-tweak-num">
                <button type="button" class="kbf-tweak-step" data-step="-1" title="Decrease (Shift: ±10)" aria-label="Decrease ${ctl.label}">−</button>
                <input class="kbf-tweak-input" type="number" step="1" value="${st.num}" aria-label="${ctl.label} in ${unit === '%' ? 'percent' : 'pixels'}">
                <span class="kbf-tweak-unit">${unit}</span>
                <button type="button" class="kbf-tweak-step" data-step="1" title="Increase (Shift: ±10)" aria-label="Increase ${ctl.label}">+</button>
              </span>`;
          } else if (ctl.kind === 'weight') {
            const ws = [100, 200, 300, 400, 500, 600, 700, 800, 900];
            if (!ws.includes(st.num)) { ws.push(st.num); ws.sort((a, b) => a - b); }
            control = `<select class="kbf-tweak-select" aria-label="${ctl.label}">${ws.map((w) => `<option value="${w}"${w === st.num ? ' selected' : ''}>${w}</option>`).join('')}</select>`;
          } else if (ctl.kind === 'align') {
            control = `
              <span class="kbf-tweak-alignseg" role="group" aria-label="${ctl.label}">
                ${['left', 'center', 'right'].map((a) => `<button type="button" class="kbf-tweak-alignbtn${st.val === a ? ' is-active' : ''}" data-align="${a}" title="Align ${a}" aria-label="Align ${a}">${I['align' + a[0].toUpperCase()]}</button>`).join('')}
              </span>`;
          } else if (ctl.kind === 'color') {
            const bg = st.hex || (st.translucent ? st.raw : '');
            control = `
              <span class="kbf-tweak-colorwrap${bg ? '' : ' is-none'}" title="${ctl.label}${st.translucent ? ': ' + st.raw : ''}">
                <span class="kbf-tweak-swatch"${bg ? ` style="background:${bg}"` : ''}></span>
                <span class="kbf-tweak-hex">${st.hex || (st.translucent ? 'alpha' : 'none')}</span>
                <input class="kbf-tweak-color" type="color" value="${st.hex || '#888888'}" aria-label="${ctl.label}">
              </span>`;
          }
          return `
            <div class="kbf-tweak-row${off ? ' kbf-tweak-row--off' : ''}" data-prop="${ctl.prop}" data-kind="${ctl.kind}"${st.mixed ? ` title="Sides differ (${st.css}) — changing sets all sides"` : ''}>
              <span class="kbf-tweak-label">${ctl.label}${st.mixed ? ' <em class="kbf-tweak-mixed">mixed</em>' : ''}</span>
              ${control}
              <button type="button" class="kbf-tweak-undo" title="Reset ${ctl.label}" aria-label="Reset ${ctl.label}">${I.undo}</button>
            </div>`;
        }).join('')}
          <div class="kbf-tweak-foot">
            <button type="button" class="kbf-tweak-resetall" hidden>Reset all</button>
          </div>
        </div>
      </div>`;
    const ta = box.querySelector('.kbf-textarea');
    ta.parentElement.insertBefore(wrap, ta);

    const toggle = wrap.querySelector('.kbf-tweak-toggle');
    const countBadge = wrap.querySelector('.kbf-tweak-count');
    const resetAllBtn = wrap.querySelector('.kbf-tweak-resetall');

    function applyPreview() {
      const target = getEl();
      if (!tweaks.size || !target) { clearTweakPreview(); schedulePos(); return; }
      target.setAttribute(TWEAK_ATTR, '1');
      let s = document.getElementById(TWEAK_STYLE_ID);
      if (!s) { s = document.createElement('style'); s.id = TWEAK_STYLE_ID; document.head.appendChild(s); }
      s.textContent = '[' + TWEAK_ATTR + ']{' + [...tweaks].map(([p, v]) => p + ':' + v + ' !important;').join('') + '}';
      schedulePos(); // padding/margin moved things — track the highlight + pins
    }
    function setTweak(prop, toCss) {
      if (!priming) { dirty = true; touched.add(prop); }
      if (toCss === base[prop].css) tweaks.delete(prop);
      else tweaks.set(prop, toCss);
      const row = wrap.querySelector('.kbf-tweak-row[data-prop="' + prop + '"]');
      if (row) row.classList.toggle('is-changed', tweaks.has(prop));
      // giving a bare box a background makes Corners relevant — reveal it live
      if (prop === 'background-color' && tweaks.has(prop)) {
        const rr = wrap.querySelector('.kbf-tweak-row[data-prop="border-radius"]');
        if (rr) rr.classList.remove('kbf-tweak-row--off');
      }
      countBadge.hidden = !tweaks.size;
      countBadge.textContent = String(tweaks.size);
      resetAllBtn.hidden = !tweaks.size;
      ta.placeholder = tweaks.size ? 'Optional note — the tweaks above are the change' : placeholderFor(ctype);
      applyPreview();
      if (hooks.validate) hooks.validate();
    }
    const clamp = (ctl, n) => Math.max(ctl.min, Math.min(ctl.max, n));
    // writeBack=false while the user is mid-keystroke: clamp only the value we
    // preview/record, NEVER rewrite the field under their cursor (typing "16"
    // into a min-6 control must not become "6" → "66"). Blur/steppers write back.
    function commitRow(row, writeBack = true) {
      const prop = row.dataset.prop;
      const ctl = TWEAK_CONTROLS.find((c) => c.prop === prop);
      if (ctl.kind === 'px' || ctl.kind === 'px4' || ctl.kind === 'pct') {
        const input = row.querySelector('.kbf-tweak-input');
        let n = parseFloat(input.value);
        if (isNaN(n)) return;
        n = clamp(ctl, n);
        if (writeBack) input.value = n;
        setTweak(prop, ctl.kind === 'pct' ? String(Math.round(n) / 100) : fmtPx(n));
      } else if (ctl.kind === 'weight') {
        setTweak(prop, row.querySelector('.kbf-tweak-select').value);
      } else if (ctl.kind === 'color') {
        const hex = row.querySelector('.kbf-tweak-color').value;
        row.querySelector('.kbf-tweak-swatch').style.background = hex;
        row.querySelector('.kbf-tweak-hex').textContent = hex;
        row.querySelector('.kbf-tweak-colorwrap').classList.remove('is-none');
        setTweak(prop, hex);
      }
    }
    function resetRow(row) {
      const prop = row.dataset.prop;
      const st = base[prop];
      const kind = row.dataset.kind;
      if (kind === 'px' || kind === 'px4' || kind === 'pct') row.querySelector('.kbf-tweak-input').value = st.num;
      else if (kind === 'weight') row.querySelector('.kbf-tweak-select').value = String(st.num);
      else if (kind === 'align') {
        row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.align === st.val));
      }
      else if (kind === 'color') {
        const bg = st.hex || (st.translucent ? st.raw : '');
        row.querySelector('.kbf-tweak-color').value = st.hex || '#888888';
        row.querySelector('.kbf-tweak-swatch').style.background = bg;
        row.querySelector('.kbf-tweak-hex').textContent = st.hex || (st.translucent ? 'alpha' : 'none');
        row.querySelector('.kbf-tweak-colorwrap').classList.toggle('is-none', !bg);
      }
      setTweak(prop, st.css);
    }

    // Collapsed by default; expanding animates via grid-template-rows 0fr→1fr
    // (the CSS owns the motion). Reposition after the height settles.
    function setOpen(open) {
      wrap.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (hooks.reposition) setTimeout(hooks.reposition, 300);
    }
    toggle.addEventListener('click', () => setOpen(!wrap.classList.contains('is-open')));
    resetAllBtn.addEventListener('click', () => wrap.querySelectorAll('.kbf-tweak-row').forEach(resetRow));
    wrap.addEventListener('click', (e) => {
      const undo = e.target.closest('.kbf-tweak-undo');
      if (undo) { resetRow(undo.closest('.kbf-tweak-row')); return; }
      const alignBtn = e.target.closest('.kbf-tweak-alignbtn');
      if (alignBtn) {
        const row = alignBtn.closest('.kbf-tweak-row');
        if (alignBtn.classList.contains('is-active')) { resetRow(row); return; } // tap again = back to original
        row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b === alignBtn));
        setTweak(row.dataset.prop, alignBtn.dataset.align);
        return;
      }
      const stepBtn = e.target.closest('.kbf-tweak-step');
      if (stepBtn && !stepBtn.dataset.held) stepRow(stepBtn, e.shiftKey);
    });
    function stepRow(stepBtn, big) {
      const row = stepBtn.closest('.kbf-tweak-row');
      const ctl = TWEAK_CONTROLS.find((c) => c.prop === row.dataset.prop);
      const input = row.querySelector('.kbf-tweak-input');
      const cur = parseFloat(input.value) || 0;
      input.value = cur + Number(stepBtn.dataset.step) * (big ? 10 : (ctl.step || 1));
      commitRow(row);
    }
    // Press-and-hold on a stepper repeats (400ms delay, then ~14/s).
    wrap.addEventListener('pointerdown', (e) => {
      const stepBtn = e.target.closest('.kbf-tweak-step');
      if (!stepBtn) return;
      let fired = false;
      const t1 = setTimeout(() => {
        const t2 = setInterval(() => { fired = true; stepRow(stepBtn, e.shiftKey); }, 70);
        stepBtn._t2 = t2;
      }, 400);
      const stop = () => {
        clearTimeout(t1);
        if (stepBtn._t2) { clearInterval(stepBtn._t2); stepBtn._t2 = null; }
        if (fired) stepBtn.dataset.held = '1'; // swallow the trailing click
        setTimeout(() => delete stepBtn.dataset.held, 0);
        stepBtn.removeEventListener('pointerup', stop);
        stepBtn.removeEventListener('pointerleave', stop);
        stepBtn.removeEventListener('pointercancel', stop);
      };
      stepBtn.addEventListener('pointerup', stop);
      stepBtn.addEventListener('pointerleave', stop);
      stepBtn.addEventListener('pointercancel', stop);
    });
    wrap.addEventListener('input', (e) => {
      const row = e.target.closest('.kbf-tweak-row');
      if (!row) return;
      // number fields: preview without writing back (don't fight the keystroke)
      if (e.target.classList.contains('kbf-tweak-input')) commitRow(row, false);
      else if (e.target.classList.contains('kbf-tweak-color')) commitRow(row);
    });
    wrap.addEventListener('change', (e) => {
      const row = e.target.closest('.kbf-tweak-row');
      if (!row) return;
      // blur / Enter on a number field: NOW normalise + clamp the field itself
      if (e.target.classList.contains('kbf-tweak-input') || e.target.classList.contains('kbf-tweak-select')) commitRow(row);
    });

    // Editing a comment that already carries tweaks: prime the knobs with the
    // stored target values and preview them straight away. Priming is NOT a user
    // touch — if the page has since been updated (agent applied the tweak, dev
    // server reloaded), the stored "to" now equals the live value, the knobs show
    // no diff, and an untouched Save must NOT wipe the historical edits[].
    if (opts.kind === 'edit' && Array.isArray(opts.comment?.edits) && opts.comment.edits.length) {
      priming = true;
      for (const ed of opts.comment.edits) {
        const row = wrap.querySelector('.kbf-tweak-row[data-prop="' + ed.prop + '"]');
        if (!row) continue;
        row.classList.remove('kbf-tweak-row--off'); // a stored edit makes its row relevant
        const kind = row.dataset.kind;
        if (kind === 'px' || kind === 'px4') {
          const n = parseFloat(ed.to);
          if (!isNaN(n)) { row.querySelector('.kbf-tweak-input').value = n; commitRow(row); }
        } else if (kind === 'pct') {
          const n = parseFloat(ed.to);
          if (!isNaN(n)) { row.querySelector('.kbf-tweak-input').value = Math.round(n * 100); commitRow(row); }
        } else if (kind === 'align' && ['left', 'center', 'right'].includes(ed.to)) {
          row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.align === ed.to));
          setTweak(ed.prop, ed.to);
        } else if (kind === 'weight') {
          const sel = row.querySelector('.kbf-tweak-select');
          if ([...sel.options].some((o) => o.value === ed.to)) { sel.value = ed.to; commitRow(row); }
        } else if (kind === 'color' && /^#[0-9a-f]{6}$/i.test(ed.to)) {
          row.querySelector('.kbf-tweak-color').value = ed.to;
          commitRow(row);
        }
      }
      priming = false;
      if (tweaks.size) setOpen(true);
    }

    return {
      count: () => tweaks.size,
      dirty: () => dirty,
      getEdits: () => [...tweaks].map(([prop, to]) => ({ prop, from: base[prop].css, to })),
      // Per-prop merge for re-saves of an existing comment: props the user did
      // NOT touch this session keep their stored (historical) entry — including
      // ones already applied to source, which show no live diff anymore — while
      // touched props take the current knob state (an intentional reset back to
      // base correctly drops that prop). Full replacement would silently erase
      // applied history the moment any unrelated knob was moved.
      mergeEdits: (stored) => {
        const kept = (Array.isArray(stored) ? stored : []).filter((e) => e && !touched.has(e.prop));
        const mine = [...tweaks].filter(([p]) => touched.has(p)).map(([prop, to]) => ({ prop, from: base[prop].css, to }));
        return [...kept, ...mine];
      },
    };
  }

  // ---------- edit-in-place text (retype the element's copy on the page) ----------
  // The user edits the element's text directly (contenteditable, temporary),
  // and Save records the exact {before, after} wording as `textEdit` — the
  // agent applies the after-wording to source verbatim. Like Tweak previews,
  // the on-page edit reverts when the composer closes.
  let activeTextEditRestore = null; // module-level so closeComposer always restores

  const PHRASING_RE = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;

  function setupTextEdit(box, opts, hooks) {
    const getEl = opts.getTargetEl;
    const el = getEl();
    if (!el) return null;
    // Only where retyping is faithful: real text, and only inline (phrasing)
    // children — retyping a layout container would flatten its structure.
    if (!norm(el.textContent)) return null;
    if (![...el.children].every((c) => PHRASING_RE.test(c.nodeName))) return null;

    // The before-snapshot is taken when the user STARTS editing, not when the
    // composer opens: a live host page (data binding, websocket updates) may
    // change this element's text while the composer sits open, and that drift
    // must never be misattributed as the user's deliberate retype — the agent
    // is told the {before, after} pair is exact.
    let baseline = null;  // { html, text } as of the first edit-start
    let editing = false;
    let dirtyTE = false;  // the user performed (or reverted) an edit this session
    let prevCursor = '';  // the element's own inline cursor, restored after editing

    const row = document.createElement('div');
    row.className = 'kbf-editext';
    row.innerHTML = `
      <button type="button" class="kbf-editext-btn">${I.edit}<span class="kbf-editext-label">Edit text on page</span></button>
      <button type="button" class="kbf-editext-undo" title="Restore the original text" aria-label="Restore the original text" hidden>${I.undo}</button>`;
    const ta = box.querySelector('.kbf-textarea');
    ta.parentElement.insertBefore(row, ta);

    const btn = row.querySelector('.kbf-editext-btn');
    const label = row.querySelector('.kbf-editext-label');
    const undoBtn = row.querySelector('.kbf-editext-undo');

    const changed = () => !!baseline && norm(el.textContent) !== baseline.text;
    function refreshRow() {
      row.classList.toggle('is-editing', editing);
      row.classList.toggle('is-changed', changed());
      label.textContent = editing ? 'Editing… Enter = done · Esc = cancel'
        : changed() ? '“' + norm(el.textContent).slice(0, 42) + (norm(el.textContent).length > 42 ? '…' : '') + '”'
        : 'Edit text on page';
      undoBtn.hidden = !changed();
      if (hooks.validate) hooks.validate();
    }
    function start() {
      if (editing) { finish(); return; }
      if (!getEl() || !el.isConnected) { toastError('The element changed — re-pin to edit its text.'); return; }
      // First edit of the session snapshots the CURRENT content as "before"
      // (drift-proof); resuming an in-progress edit keeps the same baseline.
      if (!baseline || !changed()) baseline = { html: el.innerHTML, text: norm(el.textContent) };
      editing = true;
      try { el.contentEditable = 'plaintext-only'; } catch (e) { el.contentEditable = 'true'; }
      // I-beam over the editable text — comment mode's crosshair (set on <html>)
      // would otherwise win and nothing signals "you can type here now".
      prevCursor = el.style.cursor;
      el.style.cursor = 'text';
      el.focus();
      try { // caret to the end of the text
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      } catch (e) {}
      refreshRow();
    }
    function finish() {
      if (!editing) return;
      editing = false;
      el.removeAttribute('contenteditable');
      el.style.cursor = prevCursor;
      if (changed()) {
        dirtyTE = true;
        // retyped wording is a near-verbatim request by nature
        if (hooks.suggestType) hooks.suggestType(MODE === 'md' ? 'rephrase' : 'change');
      }
      refreshRow();
    }
    function revert() {
      if (baseline && el.innerHTML !== baseline.html) { el.innerHTML = baseline.html; dirtyTE = true; }
      finish();
      refreshRow();
    }
    const onKey = (e) => {
      if (!editing) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); revert(); }
    };
    const onInput = () => { if (editing) refreshRow(); };
    // Clicking anywhere else blurs the contenteditable — that must COMMIT the
    // edit exactly like Enter, or a click-away-then-Save silently loses it.
    const onBlur = () => { if (editing) finish(); };
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('input', onInput);
    el.addEventListener('blur', onBlur);

    btn.addEventListener('click', start);
    undoBtn.addEventListener('click', revert);

    // Reopening a comment that already carries a text edit: surface it without
    // re-applying (the page may already contain the new wording).
    if (opts.kind === 'edit' && opts.comment?.textEdit?.after) {
      label.textContent = 'Saved: “' + opts.comment.textEdit.after.slice(0, 38) + (opts.comment.textEdit.after.length > 38 ? '…' : '') + '” — click to redo';
    }

    activeTextEditRestore = () => {
      el.removeAttribute('contenteditable');
      if (editing) el.style.cursor = prevCursor; // composer closed mid-edit
      el.removeEventListener('keydown', onKey, true);
      el.removeEventListener('input', onInput);
      el.removeEventListener('blur', onBlur);
      // Only undo what the USER previewed — never stomp content the host page
      // itself changed while the composer was open.
      if (baseline && el.innerHTML !== baseline.html) el.innerHTML = baseline.html;
    };

    return {
      start,
      dirty: () => dirtyTE,
      changed,
      getTextEdit: () => (changed() ? { before: baseline.text, after: norm(el.textContent) } : null),
    };
  }

  // ---------- element screenshots (pin-time visual ground truth) ----------
  // Captured AFTER save + preview-revert, so the image shows the page as the
  // reviewer saw it (not our temporary tweaks). Entirely best-effort: the
  // library is lazy-vendored by the server; any failure just means no shot.
  let _hti = null;
  let _htiLoading = null;
  function loadHti() {
    if (window.__kbfShots === false) return Promise.resolve(null); // --no-shots: don't even try
    if (_hti) return Promise.resolve(_hti);
    if (_htiLoading) return _htiLoading;
    _htiLoading = (async () => {
      for (const entry of ['es/index.js', 'dist/html-to-image.esm.js']) {
        try { _hti = await import(ROOT + '/vendor/html-to-image/' + entry); break; } catch (e) {}
      }
      return _hti; // null = disabled/unavailable; we don't retry per save
    })();
    return _htiLoading;
  }
  function shotBackground() {
    for (const el of [document.body, document.documentElement]) {
      try {
        const bg = getComputedStyle(el).backgroundColor;
        if (cssColorToHex(bg) || isTranslucent(bg)) return bg;
      } catch (e) {}
    }
    return '#ffffff';
  }
  async function captureShot(commentId, opts) {
    try {
      // Same confidence bar as Tweak Mode / edit-in-place: if the clicked node
      // is gone (SPA re-render between click and save), NEVER screenshot a
      // low-confidence guess — a wrong image sold as "visual ground truth" is
      // worse than none. getTargetEl covers element anchors; ranges re-resolve
      // their container here with the identical gate.
      let target = null;
      if (opts.getTargetEl) target = opts.getTargetEl();
      else if (opts.el && opts.el.isConnected) target = opts.el;
      else {
        const { el, confidence } = resolveWithConfidence(opts.anchor);
        if (el && confidence === 'high') target = el; // never screenshot a guessed element as "ground truth"
      }
      if (!target) return;
      const hti = await loadHti();
      if (!hti || !hti.toPng) return;
      // tiny targets (an icon, a short link) get their parent for visual context
      let node = target;
      const tr = target.getBoundingClientRect();
      if ((tr.width < 48 || tr.height < 24) && target.parentElement && target.parentElement !== document.body) {
        node = target.parentElement;
      }
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height || r.width * r.height > 4_000_000) return; // nothing, or absurdly large
      const dataUrl = await hti.toPng(node, {
        pixelRatio: Math.min(1.5, Math.max(0.4, 1000 / r.width)), // ~1000px wide max
        backgroundColor: shotBackground(),
      });
      if (!dataUrl || dataUrl.length > 780000) return; // keep under the server's cap
      await api('/shot/' + commentId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }),
      });
    } catch (e) { /* best-effort by design */ }
  }

  // ---------- variant preview (agent-proposed alternatives, tried ON the page) ----------
  // An agent reply can carry 2–4 `variants` (sanitized server-side at write
  // time). "Preview on the page" hides the pinned element and shows each
  // candidate in its place via an overlay-owned container; a floating switcher
  // flips Original/A/B/C, and "Use this" records the pick on the thread. Like
  // every preview here, it is temporary — the page reverts on close, the agent
  // implements the picked variant in source.
  let variantPreview = null; // { comment, reply, el, prevDisplay, container, bar, index, scrubbed }

  // Second, AUTHORITATIVE sanitation layer, run immediately before injection.
  // The server sanitizes at write time with regexes, but regexes over raw
  // markup cannot fully reason about HTML entity encoding — this pass parses
  // the fragment into an inert <template> (no script execution, no resource
  // loads) where the browser has ALREADY decoded entities, then walks the real
  // tree: executable elements out, on* handlers out, script-ish URLs (decoded!)
  // neutralised, external url() beacons stripped from inline styles.
  const SCRUB_BAD_TAG = /^(script|style|iframe|object|embed|base|meta|form|link|frame|frameset|title)$/i;
  const SCRUB_URL_ATTRS = ['href', 'src', 'xlink:href', 'formaction', 'action'];
  // Safe to EAGER-LOAD only if fragment, relative/same-origin, or inline
  // data:image. An absolute cross-origin resource is a network beacon that fires
  // the instant a variant is previewed (leaking viewer IP/referrer, worse over
  // share links). Navigational href on <a> loads on click, not preview, so it's
  // left alone — only resource attributes are gated.
  function sameOriginOrData(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s || s[0] === '#') return true;
    if (/^data:image\//i.test(s)) return true;
    try { return new URL(s, location.href).origin === location.origin; } catch (e) { return false; }
  }
  function scrubVariantHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    for (const el of [...tpl.content.querySelectorAll('*')]) {
      if (SCRUB_BAD_TAG.test(el.tagName)) { el.remove(); continue; }
      const tag = el.tagName.toLowerCase();
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') { el.removeAttribute(attr.name); continue; }
        if (SCRUB_URL_ATTRS.includes(name)) {
          const v = String(attr.value).replace(/[\u0000-\u0020\u00a0]+/g, '').toLowerCase();
          if (/^(javascript|vbscript|data:text\/html)/.test(v)) { el.setAttribute(attr.name, '#'); continue; }
        }
        // eager-loading resource attributes: drop external ones (beacons)
        const isEager = name === 'src' || name === 'poster'
          || ((name === 'href' || name === 'xlink:href') && (tag === 'image' || tag === 'use'));
        if (isEager && !sameOriginOrData(attr.value)) { el.removeAttribute(attr.name); continue; }
        if (name === 'srcset') {
          const kept = String(attr.value).split(',').map((s) => s.trim()).filter(Boolean)
            .filter((cand) => sameOriginOrData(cand.split(/\s+/)[0]));
          if (kept.length) el.setAttribute('srcset', kept.join(', ')); else el.removeAttribute('srcset');
          continue;
        }
        if (name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(attr.value)) {
          el.setAttribute('style', String(attr.value)
            .replace(/url\s*\(\s*(['"]?)\s*(?!#|data:image\/)[^)]*\)/gi, 'none')
            .replace(/@import/gi, '')
            .replace(/expression\s*\(/gi, 'none('));
        }
      }
    }
    return tpl.innerHTML;
  }

  function closeVariantPreview() {
    const v = variantPreview;
    if (!v) return;
    variantPreview = null;
    try { v.container.remove(); } catch (e) {}
    try { v.el.style.display = v.prevDisplay; } catch (e) {}
    try { v.bar.remove(); } catch (e) {}
    schedulePos();
  }

  function positionVariantBar() {
    const v = variantPreview;
    if (!v) return;
    const target = v.index < 0 ? v.el : v.container;
    const r = target.getBoundingClientRect();
    const bw = v.bar.offsetWidth || 280, bh = v.bar.offsetHeight || 44;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = r.top - bh - 10;
    if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - bh - 8);
    v.bar.style.left = left + 'px';
    v.bar.style.top = top + 'px';
    v.bar.style.visibility = 'visible'; // revealed only once it has coordinates
  }

  function showVariant(index) {
    const v = variantPreview;
    if (!v) return;
    v.index = index;
    if (index < 0) { // original
      v.container.style.display = 'none';
      v.el.style.display = v.prevDisplay;
    } else {
      v.el.style.display = 'none';
      v.container.style.display = '';
      // parser-based scrub right before injection (see scrubVariantHtml) — the
      // write-time sanitizer is only the first of two independent layers
      if (!v.scrubbed[index]) v.scrubbed[index] = scrubVariantHtml(v.reply.variants[index].html);
      v.container.innerHTML = v.scrubbed[index];
    }
    v.bar.querySelectorAll('.kbf-vchip').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === index));
    const use = v.bar.querySelector('.kbf-vuse');
    use.disabled = index < 0;
    const note = v.bar.querySelector('.kbf-vnote');
    note.textContent = index < 0 ? 'Original' : (v.reply.variants[index].note || v.reply.variants[index].label);
    requestAnimationFrame(positionVariantBar);
  }

  async function pickVariant() {
    const v = variantPreview;
    if (!v || v.index < 0) return;
    const chosen = v.reply.variants[v.index];
    try {
      const data = await api('/comments/' + v.comment.id + '/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: 'user',
          authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '',
          text: 'Picked: ' + chosen.label + (chosen.note ? ' — ' + chosen.note : ''),
          pick: { of: v.reply.id, index: v.index, label: chosen.label },
        }),
      });
      const i = comments.findIndex((c) => c.id === v.comment.id);
      if (i >= 0) comments[i] = data.comment;
      if (CAN_MANAGE) {
        try {
          const d2 = await api('/comments/' + v.comment.id, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
          });
          if (i >= 0) comments[i] = d2.comment;
        } catch (e) {}
      }
      closeVariantPreview();
      refresh();
      toast('Choice recorded — your agent implements “' + chosen.label + '”');
    } catch (e) {
      toastError('Could not record the pick — ' + e.message);
    }
  }

  function openVariantPreview(comment, reply) {
    closeVariantPreview();
    closeComposer();
    // Same confidence bar as every other on-page action: swapping markup on a
    // GUESSED element would preview the wrong thing entirely. High only — a
    // 'medium' (buried-text) match is not trustworthy enough to replace.
    const { el, confidence } = resolveWithConfidence(comment.anchor);
    if (!el || confidence !== 'high') {
      toastError("Couldn't confidently locate this element — re-pin the comment first.");
      return;
    }
    if (panelIsFullScreen()) setPanel(false); // the page must be visible to compare
    const container = document.createElement('div');
    container.setAttribute('data-kbf-variant', '1');
    // In an explicitly-placed grid (grid-area/column/row on the original), a bare
    // sibling would auto-flow into the wrong cell — carry the placement over.
    // `order` keeps flex position honest too.
    try {
      const cs = getComputedStyle(el);
      for (const p of ['grid-area', 'grid-column', 'grid-row', 'justify-self', 'align-self', 'order']) {
        const val = cs.getPropertyValue(p);
        if (val && val !== 'auto' && val !== 'auto / auto / auto / auto' && val !== '0') container.style.setProperty(p, val);
      }
    } catch (e) {}
    el.parentNode.insertBefore(container, el.nextSibling);

    const bar = document.createElement('div');
    bar.className = 'kbf-vbar';
    bar.style.visibility = 'hidden'; // no top-left flash before positionVariantBar runs
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Try the proposed options');
    bar.innerHTML = `
      <button type="button" class="kbf-vchip is-active" data-v="-1">Original</button>
      ${reply.variants.map((vv, i) => `<button type="button" class="kbf-vchip" data-v="${i}" title="${escapeHtml(vv.note || '')}">${escapeHtml(vv.label)}</button>`).join('')}
      <span class="kbf-vnote">Original</span>
      <button type="button" class="kbf-vuse" disabled>${I.check} Use this</button>
      <button type="button" class="kbf-vx" title="Close (Esc)" aria-label="Close variant preview">${I.close}</button>`;
    root.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const chip = e.target.closest('.kbf-vchip');
      if (chip) { showVariant(Number(chip.dataset.v)); return; }
      if (e.target.closest('.kbf-vuse')) { pickVariant(); return; }
      if (e.target.closest('.kbf-vx')) closeVariantPreview();
    });

    variantPreview = { comment, reply, el, prevDisplay: el.style.display, container, bar, index: -1, scrubbed: [] };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showVariant(-1);
    setTimeout(positionVariantBar, 300); // after the scroll settles
  }

  // ---------- "Talk me through it" — narrate the page → draft comments ----------
  // The reviewer speaks while moving the cursor; we capture two timestamped
  // streams (what was SAID, what was POINTED AT) and hand them to the pure
  // correlation engine (lib/narration.mjs), which grounds each utterance on the
  // element under the cursor (Put-That-There). Draft comments come back for the
  // reviewer to confirm — nothing is committed without a glance, and an
  // unconfident target asks for a pin rather than guessing.
  let narrating = false;
  let narrSession = 0;           // bumped on every start/stop — stale recognizer events no-op
  let narrRec = null;            // dedicated SpeechRecognition (separate from composer dictation)
  let narrTranscript = [];       // [{ t, text }] finalised phrases
  let narrHovers = [];           // [{ key, text, t0, t1, anchor }]
  let narrClicks = [];           // [{ t, key, text, anchor }]
  let narrCur = null;            // current hover interval being built
  let narrBar = null;            // the live recording bar
  let narrTimeout = 0;           // safety auto-stop
  let _narrEngine = null;
  async function loadNarrEngine() {
    if (_narrEngine) return _narrEngine;
    try { _narrEngine = await import(ROOT + '/lib/narration.mjs'); } catch (e) { _narrEngine = null; }
    return _narrEngine;
  }
  // The tall draft tray sits in the FAB's own corner, so hide the cluster while
  // it's up. (Used only for the draft tray now — see setFabRaised for the bars.)
  function setChromeHidden(hidden) {
    const fw = root.querySelector('.kbf-fab-wrap');
    if (fw) fw.style.visibility = hidden ? 'hidden' : '';
  }
  // For the narrate/walk bottom bars: DON'T hide the buttons (that felt like the
  // whole UI vanished) — just lift the cluster above the bar so they stay visible
  // and reachable. Only affects bottom corners; top-docked FABs need no lift.
  function setFabRaised(raised) {
    const fw = root.querySelector('.kbf-fab-wrap');
    if (fw) fw.classList.toggle('kbf-fab-wrap--raised', raised);
  }
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function narrKeyFor(el) {
    const a = buildElementAnchor(el);
    return { key: a.selector || a.xpath || a.tag, text: a.snippet || '', anchor: a };
  }
  function narrCloseHover(t) { if (narrCur) { narrCur.t1 = t; narrHovers.push(narrCur); narrCur = null; } }

  const narrMove = (e) => {
    if (!narrating || isInUI(e)) return;
    const el = e.target;
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
    if (narrCur && narrCur.el === el) return; // same element — skip the (costly) anchor build
    const k = narrKeyFor(el);
    const now = Date.now();
    narrCloseHover(now);
    narrCur = { el, key: k.key, text: k.text, anchor: k.anchor, t0: now, t1: now };
    showHighlightFor(el);
    updateNarrPointing(k.text || el.nodeName.toLowerCase());
  };
  const narrClick = (e) => {
    if (!narrating || isInUI(e)) return;
    const el = e.target;
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
    // A click is a "this one" signal, not an interaction — suppress it so the
    // page can't navigate away (losing the session) or fire side effects.
    e.preventDefault(); e.stopPropagation();
    const k = narrKeyFor(el);
    narrClicks.push({ t: Date.now(), key: k.key, text: k.text, anchor: k.anchor });
  };

  function updateNarrPointing(text) {
    if (!narrBar) return;
    const p = narrBar.querySelector('.kbf-narr-point');
    if (p) p.textContent = text ? ('pointing at: ' + text.slice(0, 40)) : '';
  }
  function updateNarrTicker(text) {
    if (!narrBar) return;
    const t = narrBar.querySelector('.kbf-narr-ticker');
    if (t) t.textContent = text || '';
  }

  function showNarrBar() {
    narrBar = document.createElement('div');
    narrBar.className = 'kbf-narr-bar';
    narrBar.innerHTML = `
      <span class="kbf-narr-dot"></span>
      <span class="kbf-narr-live">
        <span class="kbf-narr-ticker">Listening… talk me through the page.</span>
        <span class="kbf-narr-point"></span>
      </span>
      <label class="kbf-langwrap kbf-narr-lang" title="Voice language: ${escapeHtml(langName(speechLang))}">
        <span class="kbf-lang" aria-hidden="true">${escapeHtml(langShort(speechLang))}</span>
        <select class="kbf-langselect" aria-label="Voice language">
          ${LANGS.map((l) => `<option value="${l.code}"${l.code === speechLang ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="kbf-narr-stop" data-narr="stop">${I.stop}<span>Stop &amp; review</span></button>`;
    root.appendChild(narrBar);
    narrBar.querySelector('[data-narr="stop"]').addEventListener('click', stopNarrate);
    // Blur after picking so the <select> doesn't keep focus — otherwise pressing
    // T to stop would type-ahead the dropdown (e.g. jump to "Turkish") instead.
    narrBar.querySelector('.kbf-langselect').addEventListener('change', (e) => { setNarrLang(e.target.value); e.target.blur(); });
  }
  function setNarrLang(code) {
    if (!LANGS.some((l) => l.code === code)) return;
    speechLang = code;
    LS.set('kbf-voicelang', code);
    if (narrBar) {
      const chip = narrBar.querySelector('.kbf-narr-lang .kbf-lang'); if (chip) chip.textContent = langShort(code);
      const w = narrBar.querySelector('.kbf-narr-lang'); if (w) w.title = 'Voice language: ' + langName(code);
    }
    // switch the running recogniser to the new language mid-session (onend restarts it)
    if (narrating && narrRec) { narrRec.lang = code; try { narrRec.stop(); } catch (e) {} }
    toast('Voice language: ' + langName(code));
  }
  function hideNarrBar() { if (narrBar) { try { narrBar.remove(); } catch (e) {} narrBar = null; } }

  function startNarrate() {
    if (!CAN_COMMENT) return;
    if (narrating) { stopNarrate(); return; }
    if (!SR) { toastError('Voice needs Chrome or Edge over a secure connection'); return; }
    // narration is its own mode; make sure comment mode / composer / walkthrough
    // are off (a live walkthrough speaks aloud — the mic would hear the agent).
    if (mode) setMode(false);
    closeComposer();
    closeWalkthrough();
    closeDraftTray();               // any leftover review tray from a prior session
    if (panelOpen) setPanel(false); // clear the feedback overview: more room to point, and the draft tray won't land on top of it
    narrating = true;
    const session = ++narrSession; // this run's id; stale recognizer events check against it
    narrTranscript = []; narrHovers = []; narrClicks = []; narrCur = null;
    document.documentElement.style.cursor = 'crosshair';
    const nb = $('kbf-narrate'); if (nb) { nb.classList.add('is-live'); nb.setAttribute('aria-pressed', 'true'); }
    setFabRaised(true); // keep the buttons visible, just lift them above the bar
    showNarrBar();
    loadNarrEngine();
    document.addEventListener('pointermove', narrMove, true);
    document.addEventListener('click', narrClick, true);
    // speech
    narrRec = new SR();
    narrRec.lang = speechLang; narrRec.interimResults = true; narrRec.continuous = true;
    narrRec.onresult = (e) => {
      if (session !== narrSession) return; // event from a superseded/stopped session
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          const txt = norm(seg);
          if (!txt) continue;
          const now = Date.now();
          const last = narrTranscript[narrTranscript.length - 1];
          // Mobile Web Speech re-emits a GROWING cumulative final ("so" →
          // "so explain" → "so explain me"…) in quick succession. Collapse a
          // prefix chain ONLY when the finals arrive close together — otherwise a
          // genuine repeat ("make this bigger" … later …) would be wrongly merged.
          if (last && (now - last.t) < 1400 && (txt.startsWith(last.text) || last.text.startsWith(txt))) {
            if (txt.length >= last.text.length) { last.text = txt; last.t = now; }
          } else {
            narrTranscript.push({ t: now, text: txt });
          }
        } else interim += seg;
      }
      updateNarrTicker(norm(interim) || (narrTranscript.length ? '“' + narrTranscript[narrTranscript.length - 1].text + '”' : 'Listening…'));
    };
    narrRec.onerror = (ev) => { if (session === narrSession && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) { toastError('Microphone blocked — allow mic access'); stopNarrate(); } };
    narrRec.onend = () => { if (session === narrSession && narrating) { try { narrRec.start(); } catch (e) {} } };
    try { narrRec.start(); } catch (e) {}
    clearTimeout(narrTimeout);
    narrTimeout = setTimeout(() => { if (narrating) { toast('Narration auto-stopped after 10 min'); stopNarrate(); } }, 600000);
    // One-time privacy note: continuous capture routes audio through the
    // browser's cloud speech recognizer (shown once per browser).
    if (!LS.get('kbf-narr-privacy')) { LS.set('kbf-narr-privacy', '1'); toast('Narrating — talk and point. (Voice is transcribed by your browser’s speech service.) Hit Stop when done.', { duration: 5000 }); }
    else toast('Narrating — talk and point. Hit Stop when done.');
  }

  async function stopNarrate() {
    if (!narrating) return;
    narrating = false;
    narrSession++; // invalidate the recognizer's queued events immediately
    clearTimeout(narrTimeout);
    document.documentElement.style.cursor = '';
    const nb = $('kbf-narrate'); if (nb) { nb.classList.remove('is-live'); nb.setAttribute('aria-pressed', 'false'); }
    narrCloseHover(Date.now());
    document.removeEventListener('pointermove', narrMove, true);
    document.removeEventListener('click', narrClick, true);
    if (narrRec) { try { narrRec.stop(); } catch (e) {} narrRec = null; }
    hideHighlight(); hideNarrBar();
    setFabRaised(false); // drop the cluster back down (draft tray, if it opens, will hide it)
    // Snapshot the timelines BEFORE the await, so a start-during-await (which
    // resets these arrays) can't make us correlate the wrong session's data.
    const transcript = narrTranscript.slice(), hovers = narrHovers.slice(), clicks = narrClicks.slice();
    const eng = await loadNarrEngine();
    if (!eng) { toastError('Could not load the narration engine'); return; }
    const drafts = eng.correlate(transcript, { hovers, clicks }).filter((d) => (d.text || '').trim());
    if (!drafts.length) { toast('No feedback caught — nothing to review'); return; }
    // Confident ones behave exactly like a manual comment: they're pinned right
    // away and PPF picks them up — no accept step. Only the ones we couldn't
    // confidently place ask the reviewer to point at the element.
    const confident = drafts.filter((d) => !d.needsPin);
    const needPin = drafts.filter((d) => d.needsPin);
    let saved = 0;
    const failed = [];
    for (const d of confident) { try { if (await saveNarrationComment(d)) saved++; else failed.push(d); } catch (e) { failed.push(d); } }
    if (saved) { refresh(); toast(saved + ' spoken comment' + (saved === 1 ? '' : 's') + ' pinned'); }
    if (failed.length) toastError(failed.length + ' comment' + (failed.length === 1 ? "" : 's') + " couldn't save — review below");
    const review = needPin.concat(failed); // don't drop failed saves — surface them for retry/pin
    if (review.length) openDraftTray(review);
    else if (!saved) toast('No feedback caught — nothing to review');
  }

  // POST one narration draft as a real comment (the confident path + the "placed
  // it" path both call this). Behaves like a manual save: pin appears, PPF sees it.
  async function saveNarrationComment(d) {
    const text = (d.text || '').trim();
    if (!text) return null;
    const data = await api('/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: PAGE, pageTitle: document.title, url: location.href, anchor: d.anchor || {}, text, type: d.type, via: 'narration', authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '' }),
    });
    comments.push(data.comment);
    if (d.anchor) captureShot(data.comment.id, { anchor: d.anchor });
    return data.comment;
  }

  // ---------- draft tray — ONLY for spoken comments we couldn't confidently place ----------
  let draftTray = null;
  function openDraftTray(drafts) {
    closeDraftTray();
    const n = drafts.length;
    draftTray = document.createElement('div');
    draftTray.className = 'kbf-drafts';
    draftTray.innerHTML = `
      <div class="kbf-drafts-head">
        <b>${n} spoken comment${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a spot</b>
        <span class="kbf-drafts-sub">I heard ${n === 1 ? 'this' : 'these'} but wasn’t sure where — point at the element</span>
        <button type="button" class="kbf-x" data-dr="close" title="Dismiss">${I.close}</button>
      </div>
      <div class="kbf-drafts-list"></div>
      <div class="kbf-drafts-foot">
        <button type="button" class="kbf-btn kbf-btn--ghost" data-dr="discardall">Discard all</button>
        <div class="kbf-spacer"></div>
        <button type="button" class="kbf-btn kbf-btn--ghost" data-dr="saveall">Save all without pins</button>
      </div>`;
    root.appendChild(draftTray);
    setChromeHidden(true);
    const list = draftTray.querySelector('.kbf-drafts-list');
    drafts.forEach((d, i) => list.appendChild(renderDraftRow(d, i)));
    draftTray.addEventListener('click', (e) => {
      const act = e.target.closest('[data-dr]')?.dataset.dr;
      if (act === 'close' || act === 'discardall') { closeDraftTray(); return; }
      if (act === 'saveall') { saveAllUnpinned(); return; }
    });
  }
  function renderDraftRow(d, i) {
    // Two kinds land in the tray: ones we couldn't confidently place (no anchor —
    // "Point to it"), and ones that were anchored fine but whose save FAILED
    // (already have a good spot — just "Retry"). Render each accurately.
    const needsSpot = d.needsPin || !d.anchor;
    const row = document.createElement('div');
    row.className = 'kbf-draft' + (needsSpot ? ' needs-pin' : '');
    row.dataset.i = i;
    row._draft = d;
    row.innerHTML = `
      <div class="kbf-draft-top">
        <span class="kbf-draft-conf kbf-conf-${d.confidence}" title="anchor confidence: ${d.confidence}"></span>
        <span class="kbf-draft-type-tag kbf-type-${d.type}">${d.type}</span>
        <span class="kbf-draft-nopin">${needsSpot ? 'unsure where' : 'couldn’t save'}</span>
      </div>
      <textarea class="kbf-draft-text" rows="1">${escapeHtml(d.text)}</textarea>
      <div class="kbf-draft-foot">
        ${needsSpot ? '<button type="button" class="kbf-chip-btn kbf-draft-pin" data-d="pin">' + I.jump + ' Point to it</button>' : ''}
        <div class="kbf-spacer"></div>
        <button type="button" class="kbf-chip-btn kbf-draft-discard" data-d="discard">${I.reject} Discard</button>
        <button type="button" class="kbf-chip-btn kbf-draft-accept" data-d="accept">${I.check} ${needsSpot ? 'Save anyway' : 'Retry'}</button>
      </div>`;
    const ta = row.querySelector('.kbf-draft-text');
    ta.addEventListener('input', () => { d.text = ta.value; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    setTimeout(() => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }, 0);
    row.addEventListener('click', (e) => {
      const act = e.target.closest('[data-d]')?.dataset.d;
      // (No "show me" here — needs-a-spot drafts have no anchor yet; the user
      // places one with "Point to it".)
      if (act === 'discard') { row.remove(); updateDraftCount(); return; }
      if (act === 'pin') { startDraftPin(d, row); return; }
      if (act === 'accept') { acceptDraft(d, row); return; }
    });
    return row;
  }
  function startDraftPin(d, row) {
    if (draftTray) draftTray.style.display = 'none';
    toast('Click the element this is about', { duration: 4000 });
    const onPick = async (e) => {
      if (isInUI(e)) return;
      e.preventDefault(); e.stopPropagation();
      const el = e.target;
      cleanup();
      if (draftTray) draftTray.style.display = '';
      if (el instanceof Element && el !== document.body) {
        d.anchor = buildElementAnchor(el); d.needsPin = false; d.confidence = 'high';
        await acceptDraft(d, row); // placed → save it immediately, like a confident one
      }
    };
    const onMove = (e) => { if (!isInUI(e) && e.target instanceof Element) showHighlightFor(e.target); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(); if (draftTray) draftTray.style.display = ''; } };
    function cleanup() {
      document.removeEventListener('click', onPick, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.style.cursor = ''; // restore the page cursor
      hideHighlight();
    }
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('click', onPick, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('keydown', onKey, true);
  }
  async function acceptDraft(d, row) {
    if (d._saving) return; // idempotent: ignore repeat clicks while the POST is in flight
    if (!(d.text || '').trim()) { toastError('Add a note or discard this'); return; }
    d._saving = true;
    if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await saveNarrationComment(d);
      if (row) row.remove();
      refresh();
      toast('Comment added');
      updateDraftCount();
    } catch (e) {
      d._saving = false; // let them retry
      if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      toastError('Save failed — ' + e.message);
    }
  }
  async function saveAllUnpinned() {
    if (!draftTray) return;
    const rows = [...draftTray.querySelectorAll('.kbf-draft')];
    for (const r of rows) await acceptDraft(r._draft, r);
    updateDraftCount();
  }
  // Recompute the header count whenever a draft is discarded/accepted/pinned; close
  // the tray once the last one is gone.
  function updateDraftCount() {
    if (!draftTray) return;
    const n = draftTray.querySelectorAll('.kbf-draft').length;
    if (!n) { closeDraftTray(); return; }
    const b = draftTray.querySelector('.kbf-drafts-head b');
    if (b) b.textContent = n + ' spoken comment' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') + ' a spot';
    const sub = draftTray.querySelector('.kbf-drafts-sub');
    if (sub) sub.textContent = 'I heard ' + (n === 1 ? 'this' : 'these') + ' but wasn’t sure where — point at the element';
  }
  function closeDraftTray() { if (draftTray) { try { draftTray.remove(); } catch (e) {} draftTray = null; setChromeHidden(false); } }

  // ---------- "Agent narrates back" — a guided walkthrough of what the agent changed ----------
  // The mirror of narrate mode: after the agent processes feedback and leaves a
  // reply on each comment explaining what it did, the reviewer can play a tour —
  // each element is scrolled into view and highlighted while the agent's own
  // words are read aloud (native SpeechSynthesis — zero-dep). Turns a review into
  // a two-way conversation.
  const TTS = window.speechSynthesis || null;
  let walkState = null;   // { list, i, playing }
  let walkBar = null;

  function walkComments() {
    // Only this page's comments — the tour resolves anchors against the live DOM.
    return comments.filter((c) => normalizePath(c.page) === PAGE
      && Array.isArray(c.thread) && c.thread.some((r) => r.author === 'agent' && norm(r.text)));
  }
  function lastAgentReply(c) {
    const rs = (c.thread || []).filter((r) => r.author === 'agent' && norm(r.text));
    return rs.length ? rs[rs.length - 1].text : '';
  }
  // Epoch guard: every stop/step/speak bumps walkState.epoch, and each utterance's
  // onend/onerror (or the no-TTS timer) only fires its callback if the epoch it was
  // created under is still current. This neutralises the `onend` that the browser
  // fires when TTS.cancel() aborts an in-flight utterance — otherwise a cancelled
  // step could spuriously auto-advance the new one.
  // Make a reply readable ALOUD: markup, code, file paths, URLs and code-ish
  // punctuation would otherwise be spelled out ("less-than section id equals…").
  // Strip them to plain, ear-friendly prose before handing it to the synthesiser.
  // ---------- read a reply in ITS language, not the mic's ----------
  // The agent's reply may be written in a different language than the one the mic
  // was set to. Detect it — the browser's built-in LanguageDetector when present
  // (Chrome, zero-dep), else a small stopword heuristic — so the walkthrough reads
  // it in the right accent. Falls back to the selected voice language.
  let _langDet = null, _langDetTried = false;
  async function getLangDetector() {
    if (_langDetTried) return _langDet;
    _langDetTried = true;
    try {
      if (self.LanguageDetector?.create) _langDet = await self.LanguageDetector.create();
      else if (self.translation?.createDetector) _langDet = await self.translation.createDetector();
      else if (self.ai?.languageDetector?.create) _langDet = await self.ai.languageDetector.create();
    } catch (e) { _langDet = null; }
    return _langDet;
  }
  const LANG_HINTS = {
    nl: /\b(de|het|een|en|is|dat|niet|van|ik|je|op|te|voor|met|aan|maar|deze|moet|naar|zijn)\b/gi,
    de: /\b(der|die|das|und|ist|nicht|von|ich|ein|zu|auf|mit|für|aber|sich|werden|nach|sind)\b/gi,
    fr: /\b(le|la|les|un|une|et|est|ne|pas|de|je|vous|pour|avec|mais|ce|que|dans|sur)\b/gi,
    es: /\b(el|la|los|un|una|y|es|no|de|que|para|con|pero|este|más|se|por|como)\b/gi,
    it: /\b(il|la|le|un|una|e|è|non|di|che|per|con|ma|questo|come|sono|del)\b/gi,
    en: /\b(the|a|is|and|to|of|it|this|that|you|for|with|but|should|what|here|your)\b/gi,
  };
  function heuristicLang(text) {
    const t = ' ' + String(text).toLowerCase() + ' ';
    let best = null, bestN = 1; // need at least 2 hits to claim a language
    for (const k in LANG_HINTS) { const n = (t.match(LANG_HINTS[k]) || []).length; if (n > bestN) { bestN = n; best = k; } }
    return best;
  }
  async function detectLang(text) {
    const d = await getLangDetector();
    if (d) { try { const r = await d.detect(text); if (r && r[0] && r[0].detectedLanguage && (r[0].confidence == null || r[0].confidence > 0.5)) return r[0].detectedLanguage; } catch (e) {} }
    return heuristicLang(text);
  }
  function voiceForLang(code) {
    try { return ((TTS.getVoices && TTS.getVoices()) || []).find((v) => v.lang && v.lang.toLowerCase().slice(0, 2) === code.slice(0, 2)) || null; }
    catch (e) { return null; }
  }
  function speakableText(text) {
    return String(text == null ? '' : text)
      .replace(/[\uFFFD\u0000-\u001F]/g, ' ')                    // replacement / control chars
      .replace(/<[^>]*>/g, ' ')                                                   // HTML tags
      .replace(/`[^`]*`/g, ' ')                                                   // `inline code`
      .replace(/https?:\/\/\S+/gi, ' link ')                                      // URLs
      .replace(/\b[\w./-]+\.(?:html?|css|jsx?|mjs|tsx?|json|md|py|rb|go|svg|png|jpe?g|webp|gif)\b/gi, ' ') // filenames
      .replace(/[~#*_>{}()[\]|\\/=<>]+/g, ' ')                                     // code punctuation
      .replace(/\s+([.,;:!?])/g, '$1')                                            // tidy space-before-punct
      .replace(/\s+/g, ' ')
      .trim();
  }
  async function speakWalk(text, onDone) {
    if (!walkState) return;
    walkState.epoch = (walkState.epoch || 0) + 1;
    const myEpoch = walkState.epoch;
    const fire = () => { if (walkState && walkState.epoch === myEpoch && onDone) onDone(); };
    const spoken = speakableText(text);
    if (!TTS || !spoken) { walkState._t = setTimeout(fire, 1400); return; }
    const detected = await detectLang(spoken);               // read it in the reply's own language
    if (!walkState || walkState.epoch !== myEpoch) return;   // a newer step started during detection
    try {
      TTS.cancel();
      const u = new SpeechSynthesisUtterance(spoken.slice(0, 500));
      u.lang = detected || speechLang || 'en-US';
      const v = voiceForLang(u.lang);
      if (v) u.voice = v;
      u.onend = fire;
      u.onerror = fire;
      TTS.speak(u);
    } catch (e) { walkState._t = setTimeout(fire, 1400); }
  }
  function stopWalkSpeak() {
    if (walkState) walkState.epoch = (walkState.epoch || 0) + 1; // invalidate any in-flight callback
    if (TTS) { try { TTS.cancel(); } catch (e) {} }
    if (walkState && walkState._t) { clearTimeout(walkState._t); walkState._t = 0; }
  }

  function startWalkthrough() {
    if (narrating) { toast('Stop narrating first'); return; }
    const list = walkComments();
    if (!list.length) { toast('No changes to walk through yet — run “Please process feedback” first.'); return; }
    getLangDetector(); // warm up the language detector so the first step isn't laggy
    closeWalkthrough();
    closeDraftTray(); // mutually exclusive bottom surfaces
    if (mode) setMode(false);
    walkState = { list, i: 0, playing: true, _t: 0, epoch: 0 };
    setFabRaised(true); // keep buttons visible above the walk bar
    walkBar = document.createElement('div');
    walkBar.className = 'kbf-walk-bar';
    walkBar.setAttribute('role', 'group');
    walkBar.setAttribute('aria-label', 'Walkthrough of changes');
    walkBar.innerHTML = `
      <div class="kbf-walk-body">
        <span class="kbf-walk-step"></span>
        <span class="kbf-walk-text"></span>
      </div>
      <div class="kbf-walk-ctrls">
        <button type="button" data-walk="prev" title="Previous" aria-label="Previous">${I.prev}</button>
        <button type="button" data-walk="playpause" title="Play / pause" aria-label="Play or pause">${I.pause}</button>
        <button type="button" data-walk="next" title="Next" aria-label="Next">${I.next}</button>
        <button type="button" class="kbf-walk-x" data-walk="close" title="Close" aria-label="Close walkthrough">${I.close}</button>
      </div>`;
    root.appendChild(walkBar);
    walkBar.addEventListener('click', (e) => {
      const a = e.target.closest('[data-walk]')?.dataset.walk;
      if (a === 'prev') walkGo(walkState.i - 1);
      else if (a === 'next') walkGo(walkState.i + 1); // epoch guard makes this safe while playing
      else if (a === 'playpause') walkTogglePlay();
      else if (a === 'close') closeWalkthrough();
    });
    walkGo(0);
  }
  function walkGo(i) {
    if (!walkState) return;
    stopWalkSpeak();
    if (i >= walkState.list.length) { closeWalkthrough(); toast('That’s everything I changed.'); return; }
    if (i < 0) i = 0;
    walkState.i = i;
    const c = walkState.list[i];
    const text = lastAgentReply(c);
    walkBar.querySelector('.kbf-walk-step').textContent = (i + 1) + ' / ' + walkState.list.length;
    walkBar.querySelector('.kbf-walk-text').textContent = text;
    const el = resolveAnchor(c.anchor);
    if (el) { try { el.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' }); } catch (e) {} showHighlightFor(el); flashEl(el); }
    else hideHighlight();
    updateWalkIcon();
    if (walkState.playing) speakWalk(text, () => { if (walkState && walkState.playing) walkGo(walkState.i + 1); });
  }
  function walkTogglePlay() {
    if (!walkState) return;
    walkState.playing = !walkState.playing;
    updateWalkIcon();
    if (walkState.playing) speakWalk(lastAgentReply(walkState.list[walkState.i]), () => { if (walkState && walkState.playing) walkGo(walkState.i + 1); });
    else stopWalkSpeak();
  }
  function updateWalkIcon() {
    const b = walkBar && walkBar.querySelector('[data-walk="playpause"]');
    if (b) b.innerHTML = walkState && walkState.playing ? I.pause : I.play;
  }
  function closeWalkthrough() {
    stopWalkSpeak();
    hideHighlight();
    if (walkBar) { try { walkBar.remove(); } catch (e) {} walkBar = null; }
    walkState = null;
    setFabRaised(false);
  }

  // ---------- image replacement (swap an <img>/background for a local file) ----------
  // Reviewer picks an image element, chooses a local file, frames/crops it live
  // on the page. Everything is native (canvas + FileReader — no dependency): the
  // file is decoded, auto-downscaled to keep it performant, re-encoded, and
  // previewed in place. On save the processed blob is staged under .feedback/media
  // and the agent later moves it into the repo. Preview reverts on close.
  const IMG_MAX_DIM = 2048;             // longest side after downscale
  const IMG_MAX_SRC_PIXELS = 40_000_000; // reject decompression bombs (~40 MP)
  const IMG_BYTE_BUDGET = 1_500_000;    // ~1.5 MB target for lossy formats
  let activeImageRestore = null;        // module-level so closeComposer always reverts
  let activeCropClose = null;           // ditto for an open crop modal

  // What kind of image (if any) the picked element carries.
  function imageTargetOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.nodeName.toLowerCase();
    if (tag === 'img') return { kind: 'img', el };
    if (tag === 'picture') { const img = el.querySelector('img'); if (img) return { kind: 'img', el: img }; }
    try {
      const bg = getComputedStyle(el).backgroundImage || '';
      if (/url\(/i.test(bg) && !/^none$/i.test(bg)) return { kind: 'background', el };
    } catch (e) {}
    return null;
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  function canvasToBlob(canvas, mime, q) {
    return new Promise((res) => canvas.toBlob((b) => res(b), mime, q));
  }
  let _webpOk = null;
  function webpSupported() {
    if (_webpOk === null) { try { _webpOk = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); } catch (e) { _webpOk = false; } }
    return _webpOk;
  }
  // Draw a source region down to the target size WITHOUT ever allocating a
  // full-native-resolution canvas (that's the DoS vector on a huge/bomb image):
  // the first draw goes straight from the decoded <img> into a canvas no larger
  // than 2× the target, then we step down by halves so the result stays crisp.
  function drawScaled(img, sx, sy, sw, sh, tw, th) {
    let stepW = sw, stepH = sh;
    while (stepW > tw * 2 && stepH > th * 2) { stepW = Math.max(tw, Math.round(stepW / 2)); stepH = Math.max(th, Math.round(stepH / 2)); }
    let cur = document.createElement('canvas'); cur.width = stepW; cur.height = stepH;
    cur.getContext('2d').imageSmoothingQuality = 'high';
    cur.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, stepW, stepH);
    let cw = stepW, ch = stepH;
    while (cw > tw * 2 && ch > th * 2) {
      const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
      const tmp = document.createElement('canvas'); tmp.width = nw; tmp.height = nh;
      const tctx = tmp.getContext('2d'); tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = tmp; cw = nw; ch = nh;
    }
    if (cw === tw && ch === th) return cur;
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    const octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
    return out;
  }
  // Decode → (crop) → downscale → re-encode. cropRect is in natural-source pixels.
  async function processImage(file, cropRect) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('could not read that image')); i.src = url; });
      const natW = img.naturalWidth || img.width, natH = img.naturalHeight || img.height;
      if (!natW || !natH) throw new Error('empty image');
      if (natW * natH > IMG_MAX_SRC_PIXELS) throw new Error('image is too large to process (over ~40 megapixels)');
      let sx = 0, sy = 0, sw = natW, sh = natH;
      if (cropRect) {
        sx = Math.max(0, Math.min(cropRect.x, natW - 1));
        sy = Math.max(0, Math.min(cropRect.y, natH - 1));
        sw = Math.max(1, Math.min(cropRect.w, natW - sx));
        sh = Math.max(1, Math.min(cropRect.h, natH - sy));
      }
      let tw = sw, th = sh;
      const longest = Math.max(sw, sh);
      if (longest > IMG_MAX_DIM) { const k = IMG_MAX_DIM / longest; tw = Math.max(1, Math.round(sw * k)); th = Math.max(1, Math.round(sh * k)); }
      const canvas = drawScaled(img, sx, sy, sw, sh, tw, th);
      const hasAlpha = file.type === 'image/png' || /\.png$/i.test(file.name || '');
      let mime = hasAlpha ? 'image/png' : (webpSupported() ? 'image/webp' : 'image/jpeg');
      let blob = await canvasToBlob(canvas, mime, 0.85);
      // Over budget: a detailed PNG at 2048px is routinely several MB. WebP keeps
      // the alpha channel, so an oversized PNG re-encodes to webp rather than
      // shipping a blob the server would reject; lossy formats step quality down.
      if (blob && blob.size > IMG_BYTE_BUDGET && mime === 'image/png' && webpSupported()) {
        mime = 'image/webp';
        blob = await canvasToBlob(canvas, mime, 0.85);
      }
      if (blob && blob.size > IMG_BYTE_BUDGET && mime !== 'image/png') blob = await canvasToBlob(canvas, mime, 0.72);
      if (!blob) throw new Error('could not encode the image');
      // Hard ceiling aligned with the server's media route (3 MB decoded): fail
      // here with a clear message instead of a doomed upload.
      if (blob.size > 3_000_000) throw new Error('still over 3 MB after downscaling — crop it or pick a smaller image');
      const dataUrl = await blobToDataUrl(blob);
      return { blob, dataUrl, mime, w: tw, h: th, natW, natH, cropRect: cropRect || null };
    } finally { URL.revokeObjectURL(url); }
  }

  const IMG_ALIGN = [ // 3×3 object-position grid
    ['0% 0%', '50% 0%', '100% 0%'],
    ['0% 50%', '50% 50%', '100% 50%'],
    ['0% 100%', '50% 100%', '100% 100%'],
  ];

  function setupImageReplace(box, opts, hooks) {
    const getEl = opts.getTargetEl;
    const el0 = getEl && getEl();
    const tgt = imageTargetOf(el0);
    if (!tgt) return null;
    const el = tgt.el;

    // originals for a clean revert
    const orig = tgt.kind === 'img'
      ? { src: el.getAttribute('src'), srcset: el.getAttribute('srcset'), of: el.style.objectFit, op: el.style.objectPosition, w: el.style.width, h: el.style.height }
      : { bi: el.style.backgroundImage, bs: el.style.backgroundSize, bp: el.style.backgroundPosition, w: el.style.width, h: el.style.height };

    let processed = null;   // { blob, dataUrl, mime, w, h, natW, natH, cropRect }
    let chosenFile = null;  // the raw File (kept so Crop can re-process a region)
    const state = { fit: '', position: '', w: undefined, h: undefined, crop: null, alt: (tgt.kind === 'img' ? (el.getAttribute('alt') || '') : '') };
    let dirtyIR = false;

    const wrap = document.createElement('div');
    wrap.className = 'kbf-imgrep';
    wrap.innerHTML = `
      <div class="kbf-imgrep-head">${I.image}<span>Replace image</span><span class="kbf-imgrep-kind">${tgt.kind === 'background' ? 'background' : ''}</span></div>
      <input type="file" class="kbf-imgrep-file" accept="image/png,image/jpeg,image/webp" hidden>
      <button type="button" class="kbf-imgrep-choose" data-ir="choose">Choose image…</button>
      <div class="kbf-imgrep-body" hidden>
        <div class="kbf-imgrep-info"><img class="kbf-imgrep-thumb" alt=""><span class="kbf-imgrep-meta"></span><button type="button" class="kbf-imgrep-redo" data-ir="choose" title="Choose a different file">↺</button></div>
        <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">Fit</span>
          <span class="kbf-imgrep-seg" data-ir-seg="fit">
            <button type="button" data-fit="cover">Cover</button><button type="button" data-fit="contain">Contain</button><button type="button" data-fit="fill">Fill</button>
          </span></div>
        <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">Align</span>
          <span class="kbf-imgrep-grid">${IMG_ALIGN.flat().map((p) => `<button type="button" class="kbf-imgrep-cell" data-pos="${p}" aria-label="align ${p}"></button>`).join('')}</span></div>
        <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">Size</span>
          <span class="kbf-imgrep-size"><input type="number" class="kbf-imgrep-w" min="1" max="20000" aria-label="width px"><span>×</span><input type="number" class="kbf-imgrep-h" min="1" max="20000" aria-label="height px"><span class="kbf-imgrep-unit">px</span></span></div>
        <div class="kbf-imgrep-foot"><button type="button" class="kbf-imgrep-crop" data-ir="crop">Crop…</button><button type="button" class="kbf-imgrep-reset" data-ir="reset">Reset</button></div>
      </div>`;
    const ta = box.querySelector('.kbf-textarea');
    ta.parentElement.insertBefore(wrap, ta);

    const fileInput = wrap.querySelector('.kbf-imgrep-file');
    const body = wrap.querySelector('.kbf-imgrep-body');
    const thumb = wrap.querySelector('.kbf-imgrep-thumb');
    const metaEl = wrap.querySelector('.kbf-imgrep-meta');
    const wIn = wrap.querySelector('.kbf-imgrep-w'), hIn = wrap.querySelector('.kbf-imgrep-h');

    function markDirty() { dirtyIR = true; if (hooks.validate) hooks.validate(); }

    // apply the current processed image + framing to the element (live preview)
    function applyPreview() {
      if (!processed) return;
      if (!activeImageRestore) activeImageRestore = restore; // arm revert on first apply
      if (tgt.kind === 'img') {
        el.src = processed.dataUrl;
        el.removeAttribute('srcset');
        if (state.fit) el.style.objectFit = state.fit;
        if (state.position) el.style.objectPosition = state.position;
      } else {
        el.style.backgroundImage = 'url("' + processed.dataUrl + '")';
        if (state.fit) el.style.backgroundSize = state.fit === 'fill' ? '100% 100%' : state.fit;
        if (state.position) el.style.backgroundPosition = state.position;
      }
      if (state.w) el.style.width = state.w + 'px';
      if (state.h) el.style.height = state.h + 'px';
      schedulePos();
    }
    function restore() {
      try {
        if (tgt.kind === 'img') {
          if (orig.src != null) el.setAttribute('src', orig.src); else el.removeAttribute('src'); // fully undo the data: preview
          if (orig.srcset != null) el.setAttribute('srcset', orig.srcset); else el.removeAttribute('srcset');
          el.style.objectFit = orig.of || ''; el.style.objectPosition = orig.op || '';
        } else {
          el.style.backgroundImage = orig.bi || ''; el.style.backgroundSize = orig.bs || ''; el.style.backgroundPosition = orig.bp || '';
        }
        el.style.width = orig.w || ''; el.style.height = orig.h || '';
      } catch (e) {}
      schedulePos();
    }

    async function ingest(file, cropRect) {
      if (!file) return;
      if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { toastError('Choose a PNG, JPEG or WebP image'); return; }
      try {
        processed = await processImage(file, cropRect);
        chosenFile = file;
        state.crop = processed.cropRect;
        // Don't force a pixel size — leave the element's own sizing (fluid/
        // responsive) intact. The current rendered size is only a placeholder;
        // width/height are applied ONLY if the user actually types one.
        const rr = el.getBoundingClientRect();
        wIn.placeholder = Math.round(rr.width) || ''; hIn.placeholder = Math.round(rr.height) || '';
        wIn.value = ''; hIn.value = '';
        thumb.src = processed.dataUrl;
        metaEl.textContent = `${processed.w}×${processed.h} · ${Math.round(processed.blob.size / 1024)} KB${processed.mime === 'image/webp' ? ' · webp' : processed.mime === 'image/png' ? ' · png' : ' · jpg'}`;
        body.hidden = false;
        wrap.classList.add('is-active');
        markDirty();
        applyPreview();
      } catch (e) { toastError('Image failed — ' + e.message); }
    }

    wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-ir]')?.dataset.ir;
      if (act === 'choose') { fileInput.click(); return; }
      if (act === 'reset') { restore(); processed = null; chosenFile = null; dirtyIR = true; body.hidden = true; wrap.classList.remove('is-active'); activeImageRestore = null; if (hooks.validate) hooks.validate(); return; }
      if (act === 'crop') { if (chosenFile) openCropModal(chosenFile, processed, (rect) => ingest(chosenFile, rect)); return; }
      const fitBtn = e.target.closest('[data-fit]');
      if (fitBtn) { state.fit = fitBtn.dataset.fit; wrap.querySelectorAll('[data-fit]').forEach((b) => b.classList.toggle('is-active', b === fitBtn)); markDirty(); applyPreview(); return; }
      const cell = e.target.closest('.kbf-imgrep-cell');
      if (cell) { state.position = cell.dataset.pos; wrap.querySelectorAll('.kbf-imgrep-cell').forEach((c) => c.classList.toggle('is-active', c === cell)); markDirty(); applyPreview(); return; }
    });
    fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; ingest(f, null); });
    const onSize = () => { const w = parseInt(wIn.value, 10), h = parseInt(hIn.value, 10); state.w = Number.isFinite(w) ? w : undefined; state.h = Number.isFinite(h) ? h : undefined; markDirty(); applyPreview(); };
    wIn.addEventListener('input', onSize); hIn.addEventListener('input', onSize);

    return {
      count: () => (processed ? 1 : 0),
      dirty: () => dirtyIR,
      getMeta: () => (processed ? {
        target: tgt.kind, fit: state.fit || undefined, position: state.position || undefined,
        w: state.w, h: state.h, natW: processed.natW, natH: processed.natH,
        crop: processed.cropRect || undefined, alt: state.alt || undefined,
      } : null),
      getDataUrl: () => (processed ? processed.dataUrl : null),
    };
  }

  // ---------- crop modal (drag a rectangle over the source image) ----------
  function openCropModal(file, processed, onApply) {
    const url = URL.createObjectURL(file);
    const modal = document.createElement('div');
    modal.className = 'kbf-crop';
    modal.innerHTML = `
      <div class="kbf-crop-panel">
        <div class="kbf-crop-stage"><img class="kbf-crop-img" alt=""><div class="kbf-crop-box"><span class="kbf-crop-handle" data-h="se"></span></div></div>
        <div class="kbf-crop-bar"><span class="kbf-crop-hint">Drag to move · corner to resize</span><button type="button" class="kbf-btn kbf-btn--ghost" data-crop="cancel">Cancel</button><button type="button" class="kbf-btn kbf-btn--primary" data-crop="apply">Crop</button></div>
      </div>`;
    root.appendChild(modal);
    const imgEl = modal.querySelector('.kbf-crop-img');
    const boxEl = modal.querySelector('.kbf-crop-box');
    const stage = modal.querySelector('.kbf-crop-stage');
    let natW = 0, natH = 0, dispScale = 1, offX = 0, offY = 0; // display mapping
    const cbox = { x: 0, y: 0, w: 0, h: 0 }; // in displayed px within the image

    imgEl.onload = () => {
      natW = imgEl.naturalWidth; natH = imgEl.naturalHeight;
      const r = imgEl.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      dispScale = r.width / natW; offX = r.left - sr.left; offY = r.top - sr.top;
      // start with the current crop (mapped) or an inset 80%
      const c = processed && processed.cropRect;
      if (c) { cbox.x = c.x * dispScale; cbox.y = c.y * dispScale; cbox.w = c.w * dispScale; cbox.h = c.h * dispScale; }
      else { cbox.w = r.width * 0.8; cbox.h = r.height * 0.8; cbox.x = r.width * 0.1; cbox.y = r.height * 0.1; }
      drawBox();
    };
    imgEl.src = url;
    function drawBox() {
      boxEl.style.left = (offX + cbox.x) + 'px'; boxEl.style.top = (offY + cbox.y) + 'px';
      boxEl.style.width = cbox.w + 'px'; boxEl.style.height = cbox.h + 'px';
    }
    // drag move / resize (SE handle)
    let drag = null;
    modal.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.kbf-crop-handle');
      const inBox = e.target.closest('.kbf-crop-box');
      if (!handle && !inBox) return;
      const r = imgEl.getBoundingClientRect();
      drag = { mode: handle ? 'resize' : 'move', x: e.clientX, y: e.clientY, bx: cbox.x, by: cbox.y, bw: cbox.w, bh: cbox.h, maxW: r.width, maxH: r.height };
      try { modal.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    modal.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.mode === 'move') {
        cbox.x = Math.max(0, Math.min(drag.bx + dx, drag.maxW - cbox.w));
        cbox.y = Math.max(0, Math.min(drag.by + dy, drag.maxH - cbox.h));
      } else {
        cbox.w = Math.max(16, Math.min(drag.bw + dx, drag.maxW - cbox.x));
        cbox.h = Math.max(16, Math.min(drag.bh + dy, drag.maxH - cbox.y));
      }
      drawBox();
    });
    const endDrag = (e) => { if (drag) { try { modal.releasePointerCapture(e.pointerId); } catch (_) {} drag = null; } };
    modal.addEventListener('pointerup', endDrag);
    modal.addEventListener('pointercancel', endDrag);
    function close() { if (activeCropClose === close) activeCropClose = null; try { modal.remove(); } catch (e) {} URL.revokeObjectURL(url); }
    activeCropClose = close; // so closeComposer / Escape can tear it down
    function apply() {
      const rect = { x: Math.round(cbox.x / dispScale), y: Math.round(cbox.y / dispScale), w: Math.round(cbox.w / dispScale), h: Math.round(cbox.h / dispScale) };
      close(); onApply(rect);
    }
    modal.addEventListener('click', (e) => {
      const act = e.target.closest('[data-crop]')?.dataset.crop;
      if (act === 'cancel' || e.target === modal) { close(); return; }
      if (act === 'apply') apply();
    });
    // Keyboard: arrows nudge / Shift+arrows resize the box, Enter applies, Esc cancels.
    boxEl.tabIndex = 0;
    boxEl.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      const r = imgEl.getBoundingClientRect();
      if (e.key === 'Enter') { e.preventDefault(); apply(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!move) return;
      e.preventDefault();
      if (e.altKey) { // resize with Alt
        cbox.w = Math.max(16, Math.min(cbox.w + move[0], r.width - cbox.x));
        cbox.h = Math.max(16, Math.min(cbox.h + move[1], r.height - cbox.y));
      } else {
        cbox.x = Math.max(0, Math.min(cbox.x + move[0], r.width - cbox.w));
        cbox.y = Math.max(0, Math.min(cbox.y + move[1], r.height - cbox.h));
      }
      drawBox();
    });
    setTimeout(() => { try { boxEl.focus(); } catch (e) {} }, 30);
  }

  // ---------- composer ----------
  function closeComposer() {
    stopRecognition();
    clearTarget();
    clearTweakPreview();
    closeVariantPreview(); // never compose on top of a swapped-in candidate
    if (activeTextEditRestore) { try { activeTextEditRestore(); } catch (e) {} activeTextEditRestore = null; }
    if (activeImageRestore) { try { activeImageRestore(); } catch (e) {} activeImageRestore = null; }
    if (activeCropClose) { try { activeCropClose(); } catch (e) {} activeCropClose = null; } // never orphan the crop modal
    activeComposer = null;
    composerSlot.innerHTML = '';
    pickChain = [];
    pickIdx = 0;
    picker.style.display = 'none';
  }

  // Rainbow highlight over exactly what's being commented on, while the composer
  // is open (the native text selection is lost once the textarea takes focus).
  function clearTarget() {
    targetEls.forEach((e) => e.remove());
    targetEls = [];
  }
  function targetRects() {
    const a = activeComposer;
    if (!a) return [];
    if (a.range) { try { return [...a.range.getClientRects()].filter((r) => r.width || r.height); } catch (e) { return []; } }
    const el = a.el && a.el.isConnected ? a.el : resolveAnchor(a.anchor);
    if (el && el.getClientRects().length) return [el.getBoundingClientRect()];
    return [];
  }
  function showTarget() {
    clearTarget();
    for (const r of targetRects()) {
      const d = document.createElement('div');
      d.className = 'kbf-target';
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      targetsLayer.appendChild(d);
      targetEls.push(d);
    }
  }
  function positionTarget() {
    if (!activeComposer || !targetEls.length) return;
    const rects = targetRects();
    if (rects.length !== targetEls.length) { showTarget(); return; }
    rects.forEach((r, i) => {
      const d = targetEls[i];
      d.style.left = r.left + 'px'; d.style.top = r.top + 'px';
      d.style.width = r.width + 'px'; d.style.height = r.height + 'px';
    });
  }

  // The VISIBLE viewport, not the layout one: on a phone the on-screen keyboard
  // shrinks only the visual viewport, while window.innerHeight stays full-height.
  // A composer clamped against innerHeight lands BEHIND the keyboard (fixed
  // position, so scrolling can't reach its Save button). Clamp against this.
  function vvBox() {
    const vv = window.visualViewport;
    return vv
      ? { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height }
      : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  }
  function positionComposer(box, rect) {
    const w = 340, pad = 12;
    const vv = vvBox();
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + w > vv.left + vv.width - pad) left = vv.left + vv.width - w - pad;
    if (left < vv.left + pad) left = vv.left + pad;
    const h = box.offsetHeight || 230;
    if (top + h > vv.top + vv.height - pad) {
      top = rect.top - h - 8;
      if (top < vv.top + pad) top = vv.top + pad;
    }
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }
  // Used when the box merely CHANGES HEIGHT in place (e.g. expanding Tweak style)
  // or the visual viewport changes (keyboard opens): keep it fully in the VISIBLE
  // viewport by nudging it just enough — never flip it to the other side of the
  // element, which was the jarring jump to the top and back.
  function keepComposerInView(box) {
    const pad = 12;
    const vv = vvBox();
    const h = box.offsetHeight;
    let top = parseFloat(box.style.top) || 0;
    if (top + h > vv.top + vv.height - pad) top = vv.top + vv.height - h - pad;
    if (top < vv.top + pad) top = vv.top + pad;
    box.style.top = top + 'px';
  }
  // Keyboard open/close and pinch-zoom fire visualViewport events — re-clamp the
  // open composer so its Save row is never stranded behind the keyboard. This
  // deliberately overrides a hand-dragged position too: an unreachable composer
  // is worse than a nudged one.
  if (window.visualViewport) {
    let rafVV = 0;
    const onVV = () => {
      if (rafVV) return;
      rafVV = requestAnimationFrame(() => {
        rafVV = 0;
        if (!activeComposer) return;
        const box = composerSlot.querySelector('.kbf-composer');
        if (box) keepComposerInView(box);
      });
    };
    window.visualViewport.addEventListener('resize', onVV);
    window.visualViewport.addEventListener('scroll', onVV);
  }

  function openComposer(opts) {
    closeComposer();
    activeComposer = opts;
    hideHighlight();
    const isEdit = opts.kind === 'edit';
    const anchor = opts.anchor;
    const kindLabel = anchor.type === 'range' ? 'text' : (anchor.tag || 'element');
    const snippet = norm(anchor.snippet || anchor.rangeText) || ('<' + (anchor.tag || 'element') + '>');

    const box = document.createElement('div');
    box.className = 'kbf-composer';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', isEdit ? 'Edit comment' : 'Add a comment');
    box.innerHTML = `
      <div class="kbf-composer-head">
        <span class="kbf-chip">${escapeHtml(kindLabel)}</span>
        <span class="kbf-snippet" title="${escapeHtml(snippet)}">${escapeHtml(snippet)}</span>
        <button class="kbf-x" data-act="cancel" title="Cancel">${I.close}</button>
      </div>
      <div class="kbf-composer-body">
        <div class="kbf-types">
          ${TYPES.map((t) => `<button class="kbf-type${t.id === ctype ? ' is-active' : ''}" data-type="${t.id}" title="${escapeHtml(t.hint)}">${t.label}</button>`).join('')}
        </div>
        ${ROLE === 'comment' ? `<input class="kbf-name-input" maxlength="60" placeholder="Your name (shown with your comment)" value="${escapeHtml(LS.get('kbf-name') || '')}" aria-label="Your name">` : ''}
        <textarea class="kbf-textarea" placeholder="${escapeHtml(placeholderFor(ctype))}"></textarea>
        <div class="kbf-rec-hint" role="status" aria-live="polite"><span class="kbf-rec-dot"></span> <span class="kbf-rec-text">Listening…</span></div>
        <div class="kbf-composer-foot">
          <button class="kbf-mic" data-act="mic" aria-pressed="false" aria-label="Dictate (voice to text)" title="${SR ? 'Dictate (voice to text)' : 'Voice not supported in this browser'}">${I.mic}</button>
          <label class="kbf-langwrap" title="Voice language: ${escapeHtml(langName(speechLang))}">
            <span class="kbf-lang" aria-hidden="true">${escapeHtml(langShort(speechLang))}</span>
            <select class="kbf-langselect" aria-label="Voice language">
              ${LANGS.map((l) => `<option value="${l.code}"${l.code === speechLang ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
            </select>
          </label>
          <div class="kbf-spacer"></div>
          <button class="kbf-btn kbf-btn--ghost" data-act="cancel">Cancel</button>
          <button class="kbf-btn kbf-btn--primary" data-act="save" title="${isEdit ? 'Update' : 'Save'} (⌘↵ / Ctrl+Enter)" disabled>${isEdit ? 'Update' : 'Save'} <span class="kbf-kbd-hint">⌘↵</span></button>
        </div>
      </div>`;
    composerSlot.appendChild(box);
    showTarget();

    // Desktop: drag the composer by its header to move it off the content it comments on.
    // Touch keeps the auto-position (small screen + on-screen keyboard leave nowhere useful).
    let userMovedComposer = false; // once dragged, never auto-reposition it again
    const head = box.querySelector('.kbf-composer-head');
    (function makeComposerDraggable() {
      let s = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (e.target.closest('button, [data-act]')) return; // not when grabbing the close button
        const r = box.getBoundingClientRect();
        s = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
        box.classList.add('kbf-composer--dragging');
        try { head.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      head.addEventListener('pointermove', (e) => {
        if (!s) return;
        const pad = 12;
        const left = Math.max(pad, Math.min(e.clientX - s.dx, window.innerWidth - s.w - pad));
        const top = Math.max(pad, Math.min(e.clientY - s.dy, window.innerHeight - s.h - pad));
        box.style.left = left + 'px'; box.style.top = top + 'px';
      });
      function end(e) {
        if (!s) return;
        try { head.releasePointerCapture(e.pointerId); } catch (_) {}
        box.classList.remove('kbf-composer--dragging');
        userMovedComposer = true;
        s = null;
      }
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    })();

    const ta = box.querySelector('.kbf-textarea');
    const micBtn = box.querySelector('[data-act="mic"]');
    const langSel = box.querySelector('.kbf-langselect');
    const langWrap = box.querySelector('.kbf-langwrap');
    const saveBtn = box.querySelector('[data-act="save"]');
    const hint = box.querySelector('.kbf-rec-hint');
    const hintText = box.querySelector('.kbf-rec-text');
    if (!SR) { micBtn.disabled = true; langSel.disabled = true; langWrap.classList.add('is-disabled'); }
    if (isEdit) {
      ta.value = opts.comment.text;
      if (opts.comment.type && TYPE_IDS.includes(opts.comment.type)) {
        ctype = opts.comment.type;
        box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === ctype));
      }
    }

    function validate() {
      saveBtn.disabled = !ta.value.trim()
        && !(opts.tweaks && opts.tweaks.count())
        && !(opts.textEditApi && opts.textEditApi.changed())
        && !(opts.imageReplace && opts.imageReplace.count());
    }
    function autoGrow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; }
    ta.addEventListener('input', () => { validate(); autoGrow(); });

    // A retyped text / dialled tweak implies a type; honour an explicit choice.
    let userPickedType = false;
    opts.suggestType = (t) => {
      if (userPickedType || !TYPE_IDS.includes(t)) return;
      ctype = t;
      box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === ctype));
    };
    opts.markTypePicked = () => { userPickedType = true; };

    // Element anchors get the show-don't-tell sections (a text range has no box).
    if (anchor.type !== 'range') {
      opts.getTargetEl = makeTrustedGetEl(opts);
      const hooks = {
        validate,
        suggestType: opts.suggestType,
        reposition: () => { if (!userMovedComposer) keepComposerInView(box); },
      };
      // Edit-in-place text: both modes (in --md it's the headline use).
      opts.textEditApi = setupTextEdit(box, opts, hooks);
      // Tweak Mode + Replace image: web pages only.
      if (MODE === 'web') {
        opts.tweaks = setupTweaks(box, opts, hooks);
        opts.imageReplace = setupImageReplace(box, opts, hooks); // null unless the element is an image
      }
      if (opts.startTextEdit && opts.textEditApi) setTimeout(() => opts.textEditApi.start(), 60);
    }

    box.addEventListener('click', (e) => {
      const typeBtn = e.target.closest('[data-type]');
      if (typeBtn) {
        ctype = typeBtn.dataset.type;
        LS.set('kbf-ctype-' + MODE, ctype);
        if (opts.markTypePicked) opts.markTypePicked();
        box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === ctype));
        const taEl = box.querySelector('.kbf-textarea'); // prompt matches the picked type
        if (taEl && !taEl.value) taEl.placeholder = placeholderFor(ctype);
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeComposer();
      else if (act === 'mic') toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow);
      else if (act === 'save') doSave(opts, ta.value.trim());
    });
    langSel.addEventListener('change', () => { setVoiceLang(langSel.value, box, micBtn, hintText); langSel.blur(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!saveBtn.disabled) doSave(opts, ta.value.trim()); }
    });

    positionComposer(box, opts.rect);
    validate(); autoGrow();
    requestAnimationFrame(() => positionComposer(box, opts.rect));
    setTimeout(() => ta.focus(), 30);
  }

  // fetch + JSON with the error contract enforced: a non-2xx response throws
  // (with the server's error message) instead of being mistaken for data —
  // otherwise an { error } body would be pushed into `comments` as undefined.
  // A network failure (server gone) throws a TypeError from fetch itself.
  async function api(path, opts) {
    let res;
    try { res = await fetch(API + path, opts); }
    catch (e) { const err = new Error('is the server running?'); err.network = true; throw err; }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('server error ' + res.status));
    return data;
  }

  async function doSave(opts, text) {
    const edits = opts.tweaks ? opts.tweaks.getEdits() : [];
    const textEdit = opts.textEditApi ? opts.textEditApi.getTextEdit() : null;
    const imageReplace = opts.imageReplace ? opts.imageReplace.getMeta() : null;
    const imageDataUrl = opts.imageReplace ? opts.imageReplace.getDataUrl() : null;
    if (!text && !edits.length && !textEdit && !imageReplace) return;
    let savedNew = null;
    try {
      if (opts.kind === 'edit') {
        const body = { text, type: ctype };
        // Only rewrite edits when the user actually touched a knob this session,
        // and then merge per-prop: untouched props keep their stored (possibly
        // already-applied) history, touched props take the new knob state.
        if (opts.tweaks && opts.tweaks.dirty()) body.edits = opts.tweaks.mergeEdits(opts.comment.edits);
        // Same rule for the text edit: only send when this session touched it
        // (a redo replaces; a revert-to-original clears it via null). changed()
        // is the belt-and-braces: an in-flight edit not yet committed by
        // Enter/blur must still reach the save, never be silently dropped.
        if (opts.textEditApi && (opts.textEditApi.dirty() || opts.textEditApi.changed())) body.textEdit = textEdit;
        if (opts.imageReplace && opts.imageReplace.dirty()) body.imageReplace = imageReplace; // null clears it
        const data = await api('/comments/' + opts.comment.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const i = comments.findIndex((c) => c.id === data.comment.id);
        if (i >= 0) comments[i] = data.comment;
        if (imageReplace && imageDataUrl) savedNew = data.comment; // upload the new bytes below
        toast('Comment updated');
      } else {
        // shared "comment" links attach the reviewer's name (persisted locally)
        const nameEl = composerSlot.querySelector('.kbf-name-input');
        const authorName = nameEl ? nameEl.value.trim().slice(0, 60) : '';
        if (nameEl) LS.set('kbf-name', authorName);
        const data = await api('/comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: PAGE, pageTitle: document.title, url: location.href, anchor: opts.anchor, text, type: ctype, edits, textEdit, imageReplace, authorName, sourceFile: window.__kbfSource || '' }),
        });
        comments.push(data.comment);
        toast(edits.length || textEdit || imageReplace ? 'Saved — the page reverts; your agent applies it to source' : 'Comment saved');
        savedNew = data.comment;
      }
      // Upload the replacement image bytes to .feedback/media (needs the id), then
      // revert the preview — mirrors the screenshot flow.
      if (savedNew && imageReplace && imageDataUrl) {
        try {
          const up = await api('/media/' + savedNew.id, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: imageDataUrl }),
          });
          const i = comments.findIndex((c) => c.id === savedNew.id);
          if (i >= 0 && up.comment) comments[i] = up.comment;
        } catch (e) {
          // Upload failed — clear the dangling imageReplace so the comment doesn't
          // persist as a bare "image intended, none here" bullet.
          toastError('Image upload failed — ' + e.message);
          try {
            const cl = await api('/comments/' + savedNew.id, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageReplace: null }),
            });
            const i = comments.findIndex((c) => c.id === savedNew.id);
            if (i >= 0 && cl.comment) comments[i] = cl.comment;
          } catch (e2) {}
        }
      }
      closeComposer();
      refresh();
      // capture AFTER previews reverted: the shot is the page as reviewed
      if (savedNew && !imageReplace) captureShot(savedNew.id, opts);
    } catch (e) {
      toastError('Save failed — ' + e.message);
    }
  }

  // ---------- voice ----------
  function stopRecognition() {
    voiceManualStop = true;
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    recognizing = false;
  }
  function appendSentence(a, b) {
    a = a.trim(); b = b.trim();
    if (!a) return b;
    if (!b) return a;
    return a + ' ' + b;
  }
  function setVoiceLang(code, box, micBtn, hintText) {
    speechLang = code;
    LS.set('kbf-voicelang', code);
    const chip = box.querySelector('.kbf-lang');
    if (chip) chip.textContent = langShort(code);
    const wrap = box.querySelector('.kbf-langwrap');
    if (wrap) wrap.title = 'Voice language: ' + langName(code);
    const sel = box.querySelector('.kbf-langselect');
    if (sel && sel.value !== code) sel.value = code;
    if (hintText) hintText.textContent = 'Listening… (' + langName(code) + ')';
    // a live language switch takes effect on the next dictation start
    if (recognizing) { stopRecognition(); if (micBtn) micBtn.classList.remove('is-recording'); }
    toast('Voice language: ' + langName(code));
  }
  function toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow) {
    if (!SR) return;
    const setPressed = (on) => {
      micBtn.classList.toggle('is-recording', on);
      micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      hint.classList.toggle('is-on', on);
    };
    if (recognizing) { stopRecognition(); setPressed(false); return; }
    voiceManualStop = false;
    let voiceErrored = false;
    if (hintText) hintText.textContent = 'Listening… (' + langName(speechLang) + ')';
    recognition = new SR();
    recognition.lang = speechLang;
    recognition.interimResults = true;
    recognition.continuous = true;
    let committed = ta.value;
    let lastApplied = ta.value;
    // Mobile Web Speech re-emits a GROWING cumulative final in quick succession
    // ("so" → "so explain" → "so explain me"…), so a plain append repeats the
    // words over and over. Same collapse rule as the narration recognizer: a
    // final arriving shortly after the previous one that extends it (or is a
    // prefix of it) REPLACES it on the same base instead of appending. Compared
    // case-insensitively — mobile recognisers re-capitalise the re-emit.
    let lastFinal = null; // { text, t, base } — base = committed BEFORE this chain
    recognition.onresult = (e) => {
      // If the user typed into the box since our last write, adopt that as the
      // base so manual edits made while dictating aren't discarded.
      if (ta.value !== lastApplied) { committed = ta.value; lastFinal = null; }
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          const txt = norm(seg);
          if (!txt) continue;
          const now = Date.now();
          const a = txt.toLowerCase(), b = lastFinal ? lastFinal.text.toLowerCase() : '';
          if (lastFinal && (now - lastFinal.t) < 1400 && (a.startsWith(b) || b.startsWith(a))) {
            if (txt.length >= lastFinal.text.length) { // grown — replace, don't append
              committed = appendSentence(lastFinal.base, txt);
              lastFinal = { text: txt, t: now, base: lastFinal.base };
            } else lastFinal.t = now; // shorter re-emit of the same phrase — ignore
          } else {
            lastFinal = { text: txt, t: now, base: committed };
            committed = appendSentence(committed, txt);
          }
        } else interim += seg;
      }
      const val = interim ? appendSentence(committed, interim) : committed;
      ta.value = val; lastApplied = val;
      validate(); autoGrow();
    };
    recognition.onerror = (ev) => {
      voiceErrored = true;
      const msg = {
        'not-allowed': 'Microphone blocked — allow mic access',
        'service-not-allowed': 'Microphone blocked — allow mic access',
        'no-speech': 'No speech detected — try again',
        'audio-capture': 'No microphone found',
        'network': 'Voice recognition network error',
      }[ev.error];
      if (msg) toast(msg);
    };
    recognition.onend = () => {
      // The engine auto-stops after a silence; keep listening unless the user
      // toggled off or an error ended it.
      if (!voiceManualStop && !voiceErrored) {
        try { recognition.start(); return; } catch (e) {}
      }
      recognizing = false;
      setPressed(false);
    };
    try { recognition.start(); recognizing = true; setPressed(true); }
    catch (e) { recognizing = false; setPressed(false); }
  }

  // ---------- pins ----------
  function pageComments() {
    return comments.filter((c) => normalizePath(c.page) === PAGE);
  }
  function renderPins() {
    pinsLayer.innerHTML = '';
    placed = [];
    const list = pageComments();
    const pool = makePool();
    list.forEach((c, idx) => {
      const el = resolveAnchor(c.anchor, pool);
      if (!el) return;
      const pin = document.createElement('div');
      pin.className = 'kbf-pin'
        + (c.author === 'agent' ? ' is-agent' : '')
        + (c.status === 'resolved' ? ' is-resolved' : '')
        + (c.status === 'approved' ? ' is-approved' : '')
        + (c.status === 'rejected' ? ' is-rejected' : '');
      pin.innerHTML = c.author === 'agent' ? I.bot : String(idx + 1);
      const gist = c.text || (c.textEdit && c.textEdit.after ? '“' + c.textEdit.after + '”' : editsSummary(c));
      pin.title = (c.author === 'agent' ? '[agent] ' : '') + gist;
      pin.setAttribute('role', 'button');
      pin.tabIndex = 0;
      // Hidden until positionPins() gives it real coordinates — a fixed-position
      // pin with no left/top paints at the top-left corner otherwise (the flash
      // seen when clicking through pages before the anchor is measured).
      pin.style.display = 'none';
      pin.setAttribute('aria-label', (c.author === 'agent' ? 'Agent comment: ' : 'Comment: ') + norm(gist).slice(0, 80));
      const activate = () => focusComment(c.id, true);
      pin.addEventListener('click', activate);
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
      pinsLayer.appendChild(pin);
      placed.push({ comment: c, el, pinEl: pin });
    });
    positionPins();
    // A newly-navigated page may still be laying out (images/fonts/SPA DOM) when
    // this first pass runs, so some anchors measure 0×0 and stay hidden above.
    // Re-measure on the next frame to reveal them without waiting for a scroll.
    requestAnimationFrame(positionPins);
  }
  function positionPins() {
    for (const p of placed) {
      const r = p.el.getBoundingClientRect();
      // No box yet (not laid out / display:none ancestor) — keep it hidden rather
      // than parking it at 0,0. A later pass reveals it once it has a real rect.
      if (!r.width && !r.height) { p.pinEl.style.display = 'none'; continue; }
      p.pinEl.style.left = r.left + 'px';
      p.pinEl.style.top = r.top + 'px';
      const off = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      p.pinEl.style.display = off ? 'none' : 'flex';
    }
  }
  let rafPos = 0;
  function schedulePos() {
    if (rafPos) return;
    rafPos = requestAnimationFrame(() => {
      rafPos = 0;
      positionPins();
      positionTarget();
      if (pickChain.length && picker.style.display !== 'none') renderPick();
      if (variantPreview) positionVariantBar();
    });
  }
  window.addEventListener('scroll', schedulePos, true);
  window.addEventListener('resize', schedulePos);

  // In proxied SPAs / HMR the host page swaps its DOM on route changes: anchored
  // elements detach and pins read zeros with no recovery until a full reload.
  // Re-resolve (debounced) when the page mutates, and re-attach our host if the
  // host page removed it. Shadow-DOM mutations are encapsulated, so our own pin
  // updates don't trigger this.
  let moTimer = 0;
  function startDomObserver() {
    if (typeof MutationObserver === 'undefined') return;
    // Our own tweak-preview <style> writes (insert/remove in <head>, textContent
    // swaps on the tag) are not page mutations — ignoring them keeps every knob
    // change from scheduling a pointless full pin re-resolve.
    const isTweakNoise = (m) => (m.target && m.target.id === TWEAK_STYLE_ID)
      || (m.target === document.head
        && [...m.addedNodes, ...m.removedNodes].every((n) => n && n.id === TWEAK_STYLE_ID));
    const obs = new MutationObserver((muts) => {
      if (!muts.some((m) => !host.contains(m.target) && !isTweakNoise(m))) return; // all ours
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      clearTimeout(moTimer);
      moTimer = setTimeout(() => { renderPins(); if (panelOpen) renderPanel(); }, 200);
    });
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  // ---------- panel ----------
  function setPanel(open) {
    panelOpen = open;
    SS.set('kbf-panel', open ? '1' : '0');
    panel.classList.toggle('is-open', open);
    const tb = $('kbf-toggle-panel');
    if (tb) { tb.setAttribute('aria-expanded', open ? 'true' : 'false'); tb.classList.toggle('is-active', open); } // stay expanded while the panel is open
    if (open) renderPanel();
  }
  function setFilter(f) {
    filter = f;
    SS.set('kbf-filter', f);
    renderPanel();
  }
  function filtered(list) {
    if (filter === 'open') return list.filter(isOpenC);
    if (filter === 'resolved') return list.filter((c) => c.status === 'resolved');
    return list;
  }

  function renderPanel() {
    root.querySelectorAll('.kbf-filter').forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const open = comments.filter(isOpenC).length;
    const agentOpen = comments.filter((c) => c.author === 'agent' && c.status === 'open').length;
    subEl.textContent = `${comments.length} comment${comments.length === 1 ? '' : 's'} · ${open} open`
      + (agentOpen ? ` · ${agentOpen} from your agent to review` : '');

    const view = filtered(comments);
    if (!view.length) {
      listEl.innerHTML = `<div class="kbf-empty">${I.empty}<p>${comments.length ? 'Nothing in this filter.' : 'No comments yet.<br>Turn on comment mode and click anything on the page.<br><span class="kbf-empty-kbd">Press <kbd>C</kbd> to toggle comment mode.</span>'}</p></div>`;
      return;
    }

    // group by page, current page first
    const groups = new Map();
    for (const c of view) {
      const key = normalizePath(c.page);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === PAGE ? -1 : b === PAGE ? 1 : a.localeCompare(b)));

    // index map per page for pin numbers (based on full page list, not filtered)
    const pageIndex = new Map();
    for (const c of comments) {
      const k = normalizePath(c.page);
      if (!pageIndex.has(k)) pageIndex.set(k, []);
      pageIndex.get(k).push(c.id);
    }

    let html = '';
    for (const key of keys) {
      const here = key === PAGE;
      const title = groups.get(key)[0].pageTitle || '';
      html += `<div class="kbf-group-label">${escapeHtml(key)}${here ? '<span class="kbf-here">this page</span>' : ''}</div>`;
      for (const c of groups.get(key)) {
        const num = (pageIndex.get(key).indexOf(c.id)) + 1;
        const anchorTxt = norm(c.anchor && (c.anchor.snippet || c.anchor.rangeText)) || ('<' + (c.anchor?.tag || 'element') + '>');
        const st = c.status || 'open';
        const ct = c.type || 'comment';
        const isAgent = c.author === 'agent';
        // Unnamed user comments read "you" ONLY in the single-viewer (full) case;
        // on shared panels they're the host's — labelling them "you" for every
        // viewer would misattribute them.
        const who = isAgent ? (c.authorName || 'agent') : (c.authorName || (ROLE === 'full' ? 'you' : 'host'));
        const thread = Array.isArray(c.thread) ? c.thread : [];
        const expanded = c.id === expandedId;
        const stateClass = [
          st === 'resolved' ? 'is-resolved' : '', st === 'approved' ? 'is-approved' : '',
          st === 'rejected' ? 'is-rejected' : '', isAgent ? 'is-agent' : '', expanded ? 'is-expanded' : '',
        ].filter(Boolean).join(' ');
        html += `
          <div class="kbf-card ${stateClass}" data-id="${c.id}" data-page="${escapeHtml(key)}" data-url="${escapeHtml(c.url || '')}">
            <div class="kbf-card-top">
              <span class="kbf-badge">${isAgent ? I.bot : num}</span>
              <span class="kbf-type-tag kbf-type-${ct}">${ct}</span>
              <span class="kbf-author ${isAgent ? 'is-agent' : ''}">${escapeHtml(who)}</span>
              ${st === 'approved' || st === 'rejected' ? `<span class="kbf-status kbf-status-${st}">${st}</span>` : ''}
              <span class="kbf-card-anchor" title="${escapeHtml(anchorTxt)}">${escapeHtml(anchorTxt)}</span>
            </div>
            ${c.text ? `<div class="kbf-card-text">${escapeHtml(c.text)}</div>` : ''}
            ${c.textEdit && c.textEdit.after ? `<div class="kbf-card-textedit" title="${escapeHtml((c.textEdit.before || '') + ' → ' + c.textEdit.after)}"><del>${escapeHtml(c.textEdit.before || '')}</del><ins>${escapeHtml(c.textEdit.after)}</ins></div>` : ''}
            ${Array.isArray(c.edits) && c.edits.length ? `<div class="kbf-card-edits">${c.edits.map((ed) => `
              <span class="kbf-edit-chip" title="${escapeHtml(ed.prop + ': ' + (ed.from || '?') + ' → ' + ed.to)}"><b>${escapeHtml(ed.prop)}</b>${/^#[0-9a-f]{6}$/i.test(ed.to) ? `<i class="kbf-edit-dot" style="background:${escapeHtml(ed.to)}"></i>` : ''}<span>${escapeHtml((ed.from || '?') + ' → ' + ed.to)}</span></span>`).join('')}</div>` : ''}
            ${c.imageReplace && c.imageReplace.media ? `<div class="kbf-card-imgrep"><img class="kbf-card-newimg" data-act="newimg" tabindex="0" role="button" src="${API}/media/${c.id}" alt="Replacement image — open full size" title="New image — click to open" loading="lazy"><span class="kbf-card-imglabel">${I.image} replaces the ${c.imageReplace.target === 'background' ? 'background' : 'image'}${c.imageReplace.fit ? ` · ${escapeHtml(c.imageReplace.fit)}` : ''}</span></div>` : ''}
            ${expanded ? `
              ${c.shot ? `<img class="kbf-card-shot" data-act="shot" tabindex="0" role="button" src="${API}/shot/${c.id}" alt="Element screenshot at pin time — open full size" title="What this looked like when pinned — click to open" loading="lazy">` : ''}
              ${thread.length ? `<div class="kbf-thread">${thread.map((r) => `
                <div class="kbf-reply ${r.author === 'agent' ? 'is-agent' : ''}">
                  <span class="kbf-reply-who">${escapeHtml(r.author === 'agent' ? (r.authorName || 'agent') : (r.authorName || (ROLE === 'full' ? 'you' : 'host')))}</span>
                  <span class="kbf-reply-text">${escapeHtml(r.text)}</span>
                  ${Array.isArray(r.variants) && r.variants.length ? `
                    <button type="button" class="kbf-vpreview" data-act="variants" data-reply="${escapeHtml(r.id)}">${I.eye}<span>Try ${r.variants.length} option${r.variants.length === 1 ? '' : 's'} on the page</span></button>` : ''}
                  ${r.pick ? `<span class="kbf-vpicked">${I.check} Picked: ${escapeHtml(r.pick.label || ('#' + (r.pick.index + 1)))}</span>` : ''}
                </div>`).join('')}</div>` : ''}
              ${CAN_COMMENT ? `<div class="kbf-replybox">
                <textarea class="kbf-reply-input" placeholder="Reply to this thread…" rows="1"></textarea>
                <button class="kbf-reply-send" data-act="send" title="Send reply">${I.send}</button>
              </div>` : ''}
              ${CAN_MANAGE ? `<div class="kbf-approvals">
                ${st !== 'approved' ? `<button class="kbf-chip-btn kbf-approve" data-act="approve">${I.check} Approve</button>` : ''}
                ${st !== 'rejected' ? `<button class="kbf-chip-btn kbf-rejectb" data-act="reject">${I.reject} Reject</button>` : ''}
              </div>` : ''}
            ` : (thread.length ? `<button class="kbf-thread-toggle" data-act="thread">${I.comment}<span>${thread.length} repl${thread.length === 1 ? 'y' : 'ies'}</span></button>` : '')}
            <div class="kbf-card-foot">
              <span class="kbf-time">${timeAgo(c.createdAt)}</span>
              <button class="kbf-mini" data-act="jump" title="Go to element">${I.jump}</button>
              ${CAN_MANAGE ? `
              <button class="kbf-mini" data-act="edit" title="Edit">${I.edit}</button>
              <button class="kbf-mini kbf-mini--ok ${st === 'resolved' ? 'is-done' : ''}" data-act="resolve" title="${st === 'resolved' ? 'Reopen' : 'Resolve'}">${I.check}</button>
              <button class="kbf-mini kbf-mini--danger" data-act="delete" title="Delete">${I.trash}</button>` : ''}
            </div>
          </div>`;
      }
    }
    // Preserve reply-box focus + caret across the re-render (an SSE push or a
    // reply sent elsewhere shouldn't yank the cursor out mid-sentence).
    const active = root.activeElement;
    let restore = null;
    if (active && active.classList && active.classList.contains('kbf-reply-input')) {
      const card = active.closest('.kbf-card');
      restore = { id: card && card.dataset.id, start: active.selectionStart, end: active.selectionEnd };
    }

    listEl.innerHTML = html;

    // restore an in-progress reply draft for the expanded card
    if (expandedId) {
      const ta = root.querySelector('.kbf-card[data-id="' + expandedId + '"] .kbf-reply-input');
      if (ta && replyDrafts[expandedId]) {
        ta.value = replyDrafts[expandedId];
        ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
      }
    }
    // restore focus + caret if a reply box was focused before this re-render…
    if (restore && restore.id) {
      const ta = root.querySelector('.kbf-card[data-id="' + restore.id + '"] .kbf-reply-input');
      if (ta) { ta.focus(); try { ta.setSelectionRange(restore.start, restore.end); } catch (e) {} }
    } else if (focusReplyNext && expandedId) {
      // …or focus it once, right after an explicit expand
      const ta = root.querySelector('.kbf-card[data-id="' + expandedId + '"] .kbf-reply-input');
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    }
    focusReplyNext = false;
  }

  function toggleExpand(c) {
    expandedId = expandedId === c.id ? null : c.id;
    focusReplyNext = !!expandedId;
    renderPanel();
    if (expandedId && normalizePath(c.page) === PAGE) focusComment(c.id, false);
  }

  listEl.addEventListener('input', (e) => {
    if (e.target.classList.contains('kbf-reply-input')) {
      replyDrafts[expandedId] = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    }
  });
  listEl.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('kbf-reply-input') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const card = e.target.closest('.kbf-card');
      if (card) sendReply(card.dataset.id);
      return;
    }
    if (e.target.dataset && e.target.dataset.act === 'shot' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const card = e.target.closest('.kbf-card');
      if (card) window.open(API + '/shot/' + card.dataset.id, '_blank', 'noopener');
    }
  });

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.kbf-card');
    if (!card) return;
    const id = card.dataset.id;
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    if (e.target.closest('.kbf-reply-input')) return;
    const actBtn = e.target.closest('[data-act]');
    const act = actBtn && actBtn.dataset.act;
    if (act === 'delete') return deleteComment(id);
    if (act === 'resolve') return toggleResolve(c);
    if (act === 'edit') return editFromCard(c);
    if (act === 'thread') return toggleExpand(c);
    if (act === 'send') return sendReply(id);
    if (act === 'approve') return setStatus(c, 'approved');
    if (act === 'reject') return setStatus(c, 'rejected');
    if (act === 'jump') return goToComment(c);
    if (act === 'shot') { window.open(API + '/shot/' + c.id, '_blank', 'noopener'); return; }
    if (act === 'newimg') { window.open(API + '/media/' + c.id, '_blank', 'noopener'); return; }
    if (act === 'variants') {
      const r = (c.thread || []).find((x) => x.id === actBtn.dataset.reply);
      if (r && Array.isArray(r.variants) && r.variants.length) openVariantPreview(c, r);
      return;
    }
    // default: click on the card body toggles the conversation thread
    toggleExpand(c);
  });

  // The panel goes full-screen on phones (≤480px), so it would cover the element
  // we jump to — close it first there.
  function panelIsFullScreen() {
    return window.matchMedia ? window.matchMedia('(max-width: 480px)').matches : window.innerWidth <= 480;
  }
  // A comment's stored `url` comes from the API and could be anything; only ever
  // navigate to a SAME-ORIGIN http(s) target, so a `javascript:`/`data:` url (or
  // an off-origin link, e.g. a tunnel-era URL clicked from localhost) can't turn
  // "Go to element" into script execution or an unexpected origin hop. Anything
  // else falls back to the same-origin page path.
  function safeNavUrl(url, fallback) {
    if (!url) return fallback;
    try {
      const u = new URL(url, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin) return u.href;
    } catch (e) {}
    return fallback;
  }
  function goToComment(c) {
    const key = normalizePath(c.page);
    if (key === PAGE) {
      if (panelIsFullScreen()) setPanel(false);
      const found = focusComment(c.id, false);
      if (!found) toast("Couldn't locate this element on the page — it may need a re-pin.");
    } else {
      SS.set('kbf-focus', c.id);
      SS.set('kbf-panel', panelIsFullScreen() ? '0' : '1');
      location.href = safeNavUrl(c.url, location.origin + key);
    }
  }

  function focusComment(id, openPanel) {
    const p = placed.find((x) => x.comment.id === id);
    if (p) {
      p.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashEl(p.el);
      root.querySelectorAll('.kbf-pin').forEach((pin) => pin.classList.remove('is-active'));
      p.pinEl.classList.add('is-active');
      setTimeout(() => p.pinEl.classList.remove('is-active'), 1600);
    }
    if (openPanel) setPanel(true);
    const card = root.querySelector('.kbf-card[data-id="' + id + '"]');
    if (card) { card.scrollIntoView({ block: 'nearest' }); flashCard(card); }
    return !!p; // whether the element was found on the page
  }

  function flashEl(el) {
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    f.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid var(--kbf-clay);border-radius:6px;background:rgba(217,119,87,.12);pointer-events:none;z-index:3;transition:opacity .9s ease;`;
    pinsLayer.appendChild(f);
    requestAnimationFrame(() => { f.style.opacity = '0'; });
    setTimeout(() => f.remove(), 1000);
  }
  function flashCard(card) {
    card.style.transition = 'box-shadow .3s';
    card.style.boxShadow = '0 0 0 2px var(--kbf-clay)';
    setTimeout(() => { card.style.boxShadow = ''; }, 1100);
  }

  function editFromCard(c) {
    const el = resolveAnchor(c.anchor);
    const rect = el ? el.getBoundingClientRect() : { left: window.innerWidth / 2 - 170, right: 0, top: 120, bottom: 140 };
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    setTimeout(() => openComposer({ kind: 'edit', anchor: c.anchor, rect: (el ? el.getBoundingClientRect() : rect), comment: c, el }), el ? 260 : 0);
  }

  async function toggleResolve(c) {
    await setStatus(c, c.status === 'resolved' ? 'open' : 'resolved');
  }
  async function setStatus(c, status) {
    try {
      const data = await api('/comments/' + c.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      const i = comments.findIndex((x) => x.id === c.id);
      if (i >= 0) comments[i] = data.comment;
      refresh();
      toast(status === 'resolved' ? 'Marked resolved' : status === 'open' ? 'Reopened'
        : status === 'approved' ? 'Approved — your agent can implement it' : 'Rejected');
    } catch (e) { toastError('Update failed — ' + e.message); }
  }
  async function sendReply(id) {
    const text = (replyDrafts[id] || '').trim();
    if (!text) return;
    try {
      const data = await api('/comments/' + id + '/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'user', text, authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '' }),
      });
      const i = comments.findIndex((c) => c.id === id);
      if (i >= 0) comments[i] = data.comment;
      delete replyDrafts[id];
      expandedId = id;
      refresh();
      toast('Reply sent');
    } catch (e) { toastError('Reply failed — ' + e.message); }
  }

  // Ids deleted locally whose server DELETE is still deferred (the Undo window).
  // An SSE broadcast in that window still contains them server-side — filtering
  // them out of applyComments stops the deleted card flickering back for 5s.
  const pendingDeletes = new Set();
  function deleteComment(id) {
    const idx = comments.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const removed = comments[idx];
    // Optimistic: drop locally now, defer the server delete so Undo can cancel it.
    comments.splice(idx, 1);
    pendingDeletes.add(id);
    if (expandedId === id) expandedId = null;
    refresh();
    const timer = setTimeout(async () => {
      try { await api('/comments/' + id, { method: 'DELETE' }); }
      catch (e) {
        // Server delete failed — restore so we don't silently lose data.
        // (A 404 means it's already gone server-side; restoring would resurrect
        // a phantom, so only restore on other failures.)
        if (!/not found/i.test(e.message) && !comments.some((c) => c.id === id)) {
          comments.splice(Math.min(idx, comments.length), 0, removed); refresh();
          toastError('Delete failed — ' + e.message);
        }
      } finally { pendingDeletes.delete(id); }
    }, 5000);
    toast('Comment deleted', { actionLabel: 'Undo', duration: 5000, onAction: () => {
      clearTimeout(timer);
      pendingDeletes.delete(id);
      if (!comments.some((c) => c.id === id)) { comments.splice(Math.min(idx, comments.length), 0, removed); refresh(); }
    } });
  }

  // ---------- toast ----------
  // opts: { error?:bool, actionLabel?:string, onAction?:fn, duration?:ms }
  function toast(msg, opts = {}) {
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
  function toastError(msg) { return toast(msg, { error: true }); }

  // ---------- misc ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function updateCount() {
    const open = comments.filter(isOpenC).length;
    countEl.textContent = open ? String(open) : '';
    if (readyEl) {
      readyEl.textContent = !comments.length ? 'No comments yet'
        : open ? `${open} comment${open === 1 ? '' : 's'} ready for your agent`
        : 'All resolved';
    }
  }
  function refresh() {
    renderPins();
    if (panelOpen) renderPanel();
    updateCount();
    // Offer the "walk me through the changes" tour only once the agent has
    // actually replied to something (i.e. there's a walkthrough to narrate).
    const wb = $('kbf-walk');
    if (wb) wb.style.display = walkComments().length ? '' : 'none';
  }

  // ---------- live updates (SSE) ----------
  function animateResolve(id) {
    const p = placed.find((x) => x.comment.id === id);
    if (p) { p.pinEl.classList.add('kbf-just-resolved'); setTimeout(() => p.pinEl.classList.remove('kbf-just-resolved'), 1000); }
  }
  function applyComments(next) {
    // Skip comments the user just deleted locally (server DELETE still deferred
    // for Undo) — a broadcast mid-window must not resurrect the card.
    if (pendingDeletes.size) next = next.filter((c) => !pendingDeletes.has(c.id));
    next = scopeComments(next);
    const prev = new Map(comments.map((c) => [c.id, c.status]));
    comments = next;
    refresh();
    next.filter((c) => normalizePath(c.page) === PAGE && c.status === 'resolved' && prev.get(c.id) && prev.get(c.id) !== 'resolved')
      .forEach((c) => animateResolve(c.id));
  }
  // Watch-mode presence: show "agent online / working" live (chip in the panel
  // head + a dot on the list FAB). Presence ages out if heartbeats stop.
  let presenceTimer = 0;
  function applyAgentStatus(a) {
    const st = (a && a.state) || 'offline';
    const on = st === 'online' || st === 'working';
    const chip = $('kbf-agent-chip');
    const txt = $('kbf-agent-text');
    if (chip) {
      chip.hidden = !on;
      chip.classList.toggle('is-working', st === 'working');
      if (txt) txt.textContent = ((a && a.name) || 'Agent') + (st === 'working' ? ' is working…' : ' is online');
    }
    const fw = root.querySelector('.kbf-fab-wrap');
    if (fw) fw.classList.toggle('kbf-agent-live', on);
    clearTimeout(presenceTimer);
    // Generous vs the ≤60s heartbeat cadence, so one late beat (agent busy
    // mid-apply) doesn't flicker the chip to offline and back.
    if (on) presenceTimer = setTimeout(() => applyAgentStatus({ state: 'offline' }), 100000);
  }

  // The agent finished a batch and wants the page to show its edits under the
  // now-green pins. Reload — but NEVER yank the page out from under in-progress
  // work: if a composer, a variant preview, the touch picker, or a focused text
  // field is open, defer and surface a one-tap "Reload" toast instead. The panel
  // open/mode/filter state survives the reload (kept in sessionStorage), so it
  // feels seamless. A brief delay lets the green-pin flip register first.
  let reloadPending = false;
  function reloadIsUnsafe() {
    // Never yank the page out from under an in-progress flow — narration, the
    // spoken-draft review tray, or a walkthrough would all lose unsaved state.
    if (activeComposer || variantPreview || pickChain.length) return true;
    if (narrating || draftTray || walkState) return true;
    const a = root.activeElement || document.activeElement;
    if (a && (/^(input|textarea|select)$/i.test(a.nodeName) || a.isContentEditable)) return true;
    return false;
  }
  function doReload() { try { location.reload(); } catch (e) {} }
  function requestReload() {
    if (reloadPending) return;
    reloadPending = true;
    if (reloadIsUnsafe()) {
      // don't interrupt: offer it, and also auto-apply once the work is dismissed
      toast('Page updated by your agent', { actionLabel: 'Reload now', duration: 8000, onAction: doReload });
      const iv = setInterval(() => { if (!reloadIsUnsafe()) { clearInterval(iv); doReload(); } }, 1000);
      setTimeout(() => clearInterval(iv), 60000); // give up after a minute; the toast still stands
      return;
    }
    toast('Applying your agent’s edits — reloading…', { duration: 1200 });
    setTimeout(doReload, 700);
  }

  let es = null;
  let sseBackoff = 1000;
  function subscribeLive() {
    if (typeof EventSource === 'undefined') return;
    try { es = new EventSource(ROOT + '/events'); }
    catch (e) { scheduleResubscribe(); return; }
    es.addEventListener('comments', (e) => {
      sseBackoff = 1000;
      try { const d = JSON.parse(e.data); if (d && Array.isArray(d.comments)) applyComments(d.comments); } catch (err) {}
    });
    es.addEventListener('agent-status', (e) => {
      try { const d = JSON.parse(e.data); if (d && d.agent) applyAgentStatus(d.agent); } catch (err) {}
    });
    es.addEventListener('reload', () => requestReload());
    es.addEventListener('store-error', (e) => {
      // Server-sent application error (its own event name, so it never collides
      // with EventSource's built-in connection 'error') — e.g. the comments file
      // became unreadable. Surface it rather than letting the panel go stale.
      try { if (e && e.data && JSON.parse(e.data).error === 'ECORRUPT') toastError('Comments file unreadable — check .feedback/comments.json'); } catch (err) {}
    });
    es.onopen = () => { sseBackoff = 1000; resync(); };
    es.onerror = () => {
      // EventSource silently auto-retries transient blips; it does NOT recover
      // from a terminal close (proxy idle-timeout, dev-server restart). Handle
      // that ourselves with capped backoff and a full resync on reconnect.
      if (es && es.readyState === EventSource.CLOSED) {
        try { es.close(); } catch (e) {}
        es = null;
        scheduleResubscribe();
      }
    };
  }
  function scheduleResubscribe() {
    const wait = Math.min(sseBackoff, 15000);
    sseBackoff = Math.min(sseBackoff * 2, 15000);
    setTimeout(subscribeLive, wait);
  }
  async function resync() {
    try {
      const res = await fetch(API + '/comments');
      const data = await res.json();
      if (data && Array.isArray(data.comments)) applyComments(data.comments);
    } catch (e) {}
  }

  // ---------- wiring ----------
  // Role-appropriate chrome: view links get the pins + panel, not the tools.
  if (!CAN_COMMENT) modeBtn.style.display = 'none';
  if (ROLE !== 'full') {
    const cap = root.querySelector('.kbf-copyfb-caption');
    if (cap) cap.style.display = 'none'; // "tell your agent PPF" is host guidance
  }
  let justDraggedFab = false; // set true on a FAB drag so the trailing click doesn't toggle
  modeBtn.addEventListener('click', () => { if (justDraggedFab) return; setMode(!mode, true); });
  $('kbf-toggle-panel').addEventListener('click', () => { if (justDraggedFab) return; setPanel(!panelOpen); });
  $('kbf-panel-close').addEventListener('click', () => setPanel(false));
  // Narrate ("Talk me through it") — hidden when voice or the role can't support it.
  const narrateBtn = $('kbf-narrate');
  if (narrateBtn) {
    if (!SR || !CAN_COMMENT) narrateBtn.style.display = 'none';
    else narrateBtn.addEventListener('click', () => { if (justDraggedFab) return; startNarrate(); });
  }
  const walkBtn = $('kbf-walk');
  if (walkBtn) walkBtn.addEventListener('click', () => startWalkthrough());

  // ---------- theme (light / dark) ----------
  // Light is the default. `data-kbf-theme` is ALWAYS set (light or dark) so a forced light
  // theme overrides an OS dark preference — the prefers-color-scheme:dark rules are scoped to
  // :not([data-kbf-theme="light"]), so they only ever apply if the attribute were absent.
  const THEME_CYCLE = { light: 'dark', dark: 'light' };
  const THEME_ICON = { light: I.sun, dark: I.moon };
  const themeBtn = $('kbf-theme-toggle');
  function applyTheme(t) {
    theme = t === 'dark' ? 'dark' : 'light';
    host.setAttribute('data-kbf-theme', theme);
    LS.set('kbf-theme', theme);
    themeBtn.innerHTML = THEME_ICON[theme];
    const label = 'Theme: ' + theme;
    themeBtn.title = label + ' — click to switch';
    themeBtn.setAttribute('aria-label', label);
  }
  themeBtn.addEventListener('click', () => applyTheme(THEME_CYCLE[theme]));
  applyTheme(theme);

  // ---------- FAB: drag to any corner (persisted; works on mouse, touch and pen) ----------
  // A plain click still toggles comment mode / the panel; only a real drag (> 8px) moves the
  // cluster, then it snaps to the nearest corner. The 8px threshold separates tap from drag on
  // touch, and click from drag on desktop — the same idea as the element-pick threshold above.
  const fabWrap = root.querySelector('.kbf-fab-wrap');
  const FAB_CORNERS = ['br', 'bl', 'tr', 'tl'];
  const CORNER_NAME = { br: 'bottom-right', bl: 'bottom-left', tr: 'top-right', tl: 'top-left' };
  function applyFabCorner(corner) {
    const c = FAB_CORNERS.includes(corner) ? corner : 'br';
    FAB_CORNERS.forEach((k) => fabWrap.classList.toggle('kbf-fab-wrap--' + k, k === c));
  }
  applyFabCorner(LS.get('kbf-fab-corner') || 'br');
  (function makeFabDraggable() {
    let start = null, grab = null, dragging = false;
    // Cleanup for the springy "landing" animation (FLIP transform on drop).
    let landTimer = 0, landHandler = null;
    function settleLanding() {
      clearTimeout(landTimer); landTimer = 0;
      if (landHandler) { fabWrap.removeEventListener('transitionend', landHandler); landHandler = null; }
      fabWrap.classList.remove('kbf-fab-wrap--landing');
      fabWrap.style.transform = '';
    }
    fabWrap.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // left button / touch / pen only
      settleLanding(); // cancel any in-flight snap before a fresh grab
      const r = fabWrap.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY };
      grab = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
      dragging = false;
    });
    fabWrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        dragging = true;
        fabWrap.classList.add('kbf-fab-wrap--dragging'); // lifts + starts the wobble
        try { fabWrap.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!dragging) return;
      const pad = 12;
      const left = Math.max(pad, Math.min(e.clientX - grab.dx, window.innerWidth - grab.w - pad));
      const top = Math.max(pad, Math.min(e.clientY - grab.dy, window.innerHeight - grab.h - pad));
      fabWrap.style.left = left + 'px'; fabWrap.style.top = top + 'px';
      fabWrap.style.right = 'auto'; fabWrap.style.bottom = 'auto';
    });
    function endDrag(e) {
      if (!start) return;
      try { fabWrap.releasePointerCapture(e.pointerId); } catch (_) {}
      if (dragging) {
        // Stop the wobble first, so the drop position is measured without the jiggle transform.
        fabWrap.classList.remove('kbf-fab-wrap--dragging');
        const r0 = fabWrap.getBoundingClientRect();
        const corner = (r0.top + r0.height / 2 < window.innerHeight / 2 ? 't' : 'b')
          + (r0.left + r0.width / 2 < window.innerWidth / 2 ? 'l' : 'r');
        fabWrap.style.left = fabWrap.style.top = fabWrap.style.right = fabWrap.style.bottom = '';
        applyFabCorner(corner);
        LS.set('kbf-fab-corner', corner);
        // FLIP: snap the layout to the corner, then spring the button there from the drop
        // point — the landing transition overshoots slightly for a bouncy feel.
        const r1 = fabWrap.getBoundingClientRect();
        const dx = Math.round(r0.left - r1.left), dy = Math.round(r0.top - r1.top);
        if (dx || dy) {
          fabWrap.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          void fabWrap.offsetWidth; // reflow so the next change animates from the drop point
          fabWrap.classList.add('kbf-fab-wrap--landing');
          fabWrap.style.transform = 'translate(0px,0px)';
          landHandler = (ev) => { if (!ev.propertyName || ev.propertyName === 'transform') settleLanding(); };
          fabWrap.addEventListener('transitionend', landHandler);
          landTimer = setTimeout(settleLanding, 320); // safety net if transitionend is missed
        }
        toast('Comment button moved to ' + CORNER_NAME[corner]);
        justDraggedFab = true; // swallow the click that fires right after this pointerup
        setTimeout(() => { justDraggedFab = false; }, 0);
      }
      start = grab = null; dragging = false;
    }
    fabWrap.addEventListener('pointerup', endDrag);
    fabWrap.addEventListener('pointercancel', endDrag);
  })();
  root.querySelectorAll('.kbf-filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  if (MODE === 'md') {
    const stampBtn = $('kbf-stamp');
    stampBtn.style.display = '';
    stampBtn.addEventListener('click', async () => {
      try {
        const r = await api('/md-export', { method: 'POST' });
        toast(`Stamped ${r.stamped} marker${r.stamped === 1 ? '' : 's'} into ${r.files} file${r.files === 1 ? '' : 's'}`
          + (r.notFound ? ` (${r.notFound} skipped — no unique matching line/file; re-pin those)` : ''));
      } catch (e) { toastError('Stamp failed — ' + e.message); }
    });
  }

  document.addEventListener('keydown', (e) => {
    const typing = e.target && /^(input|textarea|select)$/i.test(e.target.nodeName) || (e.target && e.target.isContentEditable);
    const inComposer = e.composedPath && e.composedPath().includes(host);
    if (e.key === 'Escape') {
      if (walkState) { closeWalkthrough(); return; } // Stop the walkthrough tour
      if (narrating) { stopNarrate(); return; } // Stop narration → draft tray
      if (draftTray) { closeDraftTray(); return; }
      if (activeCropClose) { activeCropClose(); return; } // crop modal is topmost — close it first, keep the composer
      if (variantPreview) { closeVariantPreview(); return; }
      if (pickChain.length) { clearPick(); return; }
      if (activeComposer) { closeComposer(); return; }
      if (panelOpen) { setPanel(false); return; }
    }
    // Bare P: Point — toggle click-to-comment (P matches "Point", like T matches
    // "Talk"). Bare only, so Ctrl/Cmd+P (print) and Alt+P are left alone.
    if (!typing && !inComposer && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'P')) { setMode(!mode, true); }
    // Bare T: Talk — start / stop the mic. While narrating, T stops even if the
    // narrate-bar language <select> has focus (otherwise its native single-letter
    // type-ahead eats the key and jumps languages, e.g. to "Turkish").
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      const inRealText = e.target && (/^(input|textarea)$/i.test(e.target.nodeName) || e.target.isContentEditable);
      if (narrating && !inRealText) { e.preventDefault(); stopNarrate(); }
      else if (!narrating && !typing && !inComposer && SR && CAN_COMMENT) startNarrate();
    }
  });

  // ---------- boot ----------
  async function load() {
    try {
      const data = await api('/comments');
      comments = scopeComments(data.comments || []);
    } catch (e) {
      comments = [];
      // A server-side error (e.g. a corrupt comments.json) must not look like
      // "no comments yet" — say so. A plain network failure stays quiet.
      if (!e.network) toastError('Could not load comments — ' + e.message);
    }
    setMode(mode);
    refresh();
    if (panelOpen) { panel.classList.add('is-open'); renderPanel(); }
    const focusId = SS.get('kbf-focus');
    if (focusId) {
      SS.remove('kbf-focus');
      setTimeout(() => focusComment(focusId, panelOpen), 400);
    }
    subscribeLive();
    startDomObserver();
  }
  load();
})();
