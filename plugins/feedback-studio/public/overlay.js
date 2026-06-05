// Feedback Studio — overlay client
// Mounted on every page via the local feedback server. Lets you attach
// comments (typed or spoken) to any element or text selection, persists them
// server-side, and renders pins + a cross-page review panel.

(function () {
  if (window.__kbfMounted) return;
  window.__kbfMounted = true;

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
  let activeComposer = null; // { kind:'new'|'edit', anchor, rect, comment? }
  let placed = []; // [{ comment, el, pinEl }]
  let targetEls = []; // rainbow highlight boxes over the element/text being commented on
  let expandedId = null; // which comment's conversation thread is open in the panel
  let focusReplyNext = false; // focus the reply box on the next render (after an explicit expand)
  const replyDrafts = {}; // id -> in-progress reply text, preserved across re-renders
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
  const MODE = (typeof window !== 'undefined' && window.__kbfMode) || 'web';
  const TYPE_SETS = {
    web: [
      { id: 'fix', label: 'Fix', hint: 'Something is broken or wrong — reproduce and patch it.' },
      { id: 'change', label: 'Change', hint: 'Make it exactly this — apply near-verbatim, no redesign.' },
      { id: 'improve', label: 'Improve', hint: 'This is weak — rewrite or redesign with judgement.' },
    ],
    md: [
      { id: 'comment', label: 'Comment', hint: 'A general note about this passage.' },
      { id: 'rephrase', label: 'Rephrase', hint: 'Propose specific replacement wording.' },
      { id: 'expand', label: 'Expand', hint: 'Add more detail / content here.' },
      { id: 'delete', label: 'Delete', hint: 'Remove this passage.' },
      { id: 'question', label: 'Question', hint: 'Ask the agent something about this.' },
    ],
  };
  const TYPES = TYPE_SETS[MODE] || TYPE_SETS.web;
  const TYPE_IDS = TYPES.map((t) => t.id);
  let ctype = LS.get('kbf-ctype-' + MODE) || TYPES[0].id;
  if (!TYPE_IDS.includes(ctype)) ctype = TYPES[0].id;

  function normalizePath(p) {
    p = p.replace(/index\.html$/, '');
    if (p.length > 1) p = p.replace(/\/+$/, '/');
    return p || '/';
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
          <h2>Feedback</h2>
          <button class="kbf-x" id="kbf-panel-close" title="Close" aria-label="Close feedback panel">${I.close}</button>
        </div>
        <div class="kbf-panel-sub" id="kbf-panel-sub"></div>
        <div class="kbf-filters" role="group" aria-label="Filter comments">
          <button class="kbf-filter" data-filter="all" aria-pressed="false">All</button>
          <button class="kbf-filter" data-filter="open" aria-pressed="false">Open</button>
          <button class="kbf-filter" data-filter="resolved" aria-pressed="false">Resolved</button>
        </div>
      </div>
      <div class="kbf-list" id="kbf-list"></div>
      <div class="kbf-panel-foot">
        <span class="kbf-readyline" id="kbf-ready" title="Saved to .feedback/comments.json + FEEDBACK.md"></span>
        <button class="kbf-btn kbf-btn--ghost kbf-stamp" id="kbf-stamp" title="Write these comments into the .md as @FB markers (portable + greppable)" style="display:none">Stamp .md</button>
        <button class="kbf-btn kbf-btn--primary kbf-copyfb" id="kbf-copyfb" title="Copy the command, then paste it into Claude Code / your agent">Copy /feedback</button>
        <span class="kbf-copyfb-caption">Paste into Claude Code / your agent to apply these.</span>
      </div>
    </aside>

    <div class="kbf-fab-wrap">
      <button class="kbf-fab kbf-fab--mini" id="kbf-toggle-panel" title="Open feedback list" aria-label="Open feedback list" aria-expanded="${panelOpen ? 'true' : 'false'}">
        ${I.list}<span class="kbf-count" id="kbf-count"></span>
      </button>
      <button class="kbf-fab" id="kbf-toggle-mode" title="Toggle comment mode (C)" aria-pressed="false">
        ${I.comment}<span class="kbf-fab-label" id="kbf-mode-label">Comment</span>
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
  const modeLabel = $('kbf-mode-label');
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
  function setMode(on) {
    mode = on;
    SS.set('kbf-mode', on ? '1' : '0');
    modeBtn.classList.toggle('is-active', on);
    modeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    modeLabel.textContent = on ? 'Commenting' : 'Comment';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { hideHighlight(); closeComposer(); }
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
      if (type === 'mouse') {
        openComposer({ kind: 'new', anchor: buildElementAnchor(target), rect: target.getBoundingClientRect(), el: target });
      } else {
        startPick(target); // touch / pen: confirm + adjust with the picker
      }
    }, 0);
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

  // ---------- composer ----------
  function closeComposer() {
    stopRecognition();
    clearTarget();
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

  function positionComposer(box, rect) {
    const w = 340, pad = 12;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (left < pad) left = pad;
    const h = box.offsetHeight || 230;
    if (top + h > window.innerHeight - pad) {
      top = rect.top - h - 8;
      if (top < pad) top = pad;
    }
    box.style.left = left + 'px';
    box.style.top = top + 'px';
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
        <textarea class="kbf-textarea" placeholder="${escapeHtml(PLACEHOLDER)}"></textarea>
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

    function validate() { saveBtn.disabled = !ta.value.trim(); }
    function autoGrow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; }
    ta.addEventListener('input', () => { validate(); autoGrow(); });

    box.addEventListener('click', (e) => {
      const typeBtn = e.target.closest('[data-type]');
      if (typeBtn) {
        ctype = typeBtn.dataset.type;
        LS.set('kbf-ctype-' + MODE, ctype);
        box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === ctype));
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeComposer();
      else if (act === 'mic') toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow);
      else if (act === 'save') doSave(opts, ta.value.trim());
    });
    langSel.addEventListener('change', () => setVoiceLang(langSel.value, box, micBtn, hintText));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (ta.value.trim()) doSave(opts, ta.value.trim()); }
    });

    positionComposer(box, opts.rect);
    validate(); autoGrow();
    requestAnimationFrame(() => positionComposer(box, opts.rect));
    setTimeout(() => ta.focus(), 30);
  }

  async function doSave(opts, text) {
    if (!text) return;
    try {
      if (opts.kind === 'edit') {
        const res = await fetch(API + '/comments/' + opts.comment.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, type: ctype }),
        });
        const data = await res.json();
        const i = comments.findIndex((c) => c.id === data.comment.id);
        if (i >= 0) comments[i] = data.comment;
        toast('Comment updated');
      } else {
        const res = await fetch(API + '/comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: PAGE, pageTitle: document.title, url: location.href, anchor: opts.anchor, text, type: ctype, sourceFile: window.__kbfSource || '' }),
        });
        const data = await res.json();
        comments.push(data.comment);
        toast('Comment saved');
      }
      closeComposer();
      refresh();
    } catch (e) {
      toastError('Save failed — is the server running?');
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
    recognition.onresult = (e) => {
      // If the user typed into the box since our last write, adopt that as the
      // base so manual edits made while dictating aren't discarded.
      if (ta.value !== lastApplied) committed = ta.value;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i][0].transcript;
        if (e.results[i].isFinal) committed = appendSentence(committed, seg);
        else interim += seg;
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
      pin.title = (c.author === 'agent' ? '[agent] ' : '') + c.text;
      pin.setAttribute('role', 'button');
      pin.tabIndex = 0;
      pin.setAttribute('aria-label', (c.author === 'agent' ? 'Agent comment: ' : 'Comment: ') + norm(c.text).slice(0, 80));
      const activate = () => focusComment(c.id, true);
      pin.addEventListener('click', activate);
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
      pinsLayer.appendChild(pin);
      placed.push({ comment: c, el, pinEl: pin });
    });
    positionPins();
  }
  function positionPins() {
    for (const p of placed) {
      const r = p.el.getBoundingClientRect();
      p.pinEl.style.left = r.left + 'px';
      p.pinEl.style.top = r.top + 'px';
      const off = r.bottom < 0 || r.top > window.innerHeight;
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
    const obs = new MutationObserver((muts) => {
      if (!muts.some((m) => !host.contains(m.target))) return; // all inside our UI
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
    if (tb) tb.setAttribute('aria-expanded', open ? 'true' : 'false');
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
        const who = isAgent ? (c.authorName || 'agent') : 'you';
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
            <div class="kbf-card-text">${escapeHtml(c.text)}</div>
            ${expanded ? `
              ${thread.length ? `<div class="kbf-thread">${thread.map((r) => `
                <div class="kbf-reply ${r.author === 'agent' ? 'is-agent' : ''}">
                  <span class="kbf-reply-who">${escapeHtml(r.author === 'agent' ? (r.authorName || 'agent') : 'you')}</span>
                  <span class="kbf-reply-text">${escapeHtml(r.text)}</span>
                </div>`).join('')}</div>` : ''}
              <div class="kbf-replybox">
                <textarea class="kbf-reply-input" placeholder="Reply to this thread…" rows="1"></textarea>
                <button class="kbf-reply-send" data-act="send" title="Send reply">${I.send}</button>
              </div>
              <div class="kbf-approvals">
                ${st !== 'approved' ? `<button class="kbf-chip-btn kbf-approve" data-act="approve">${I.check} Approve</button>` : ''}
                ${st !== 'rejected' ? `<button class="kbf-chip-btn kbf-rejectb" data-act="reject">${I.reject} Reject</button>` : ''}
              </div>
            ` : (thread.length ? `<button class="kbf-thread-toggle" data-act="thread">${I.comment}<span>${thread.length} repl${thread.length === 1 ? 'y' : 'ies'}</span></button>` : '')}
            <div class="kbf-card-foot">
              <span class="kbf-time">${timeAgo(c.createdAt)}</span>
              <button class="kbf-mini" data-act="jump" title="Go to element">${I.jump}</button>
              <button class="kbf-mini" data-act="edit" title="Edit">${I.edit}</button>
              <button class="kbf-mini kbf-mini--ok ${st === 'resolved' ? 'is-done' : ''}" data-act="resolve" title="${st === 'resolved' ? 'Reopen' : 'Resolve'}">${I.check}</button>
              <button class="kbf-mini kbf-mini--danger" data-act="delete" title="Delete">${I.trash}</button>
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
    // default: click on the card body toggles the conversation thread
    toggleExpand(c);
  });

  // The panel goes full-screen on phones (≤480px), so it would cover the element
  // we jump to — close it first there.
  function panelIsFullScreen() {
    return window.matchMedia ? window.matchMedia('(max-width: 480px)').matches : window.innerWidth <= 480;
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
      location.href = c.url || (location.origin + key);
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
      const res = await fetch(API + '/comments/' + c.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      const data = await res.json();
      const i = comments.findIndex((x) => x.id === c.id);
      if (i >= 0) comments[i] = data.comment;
      refresh();
      toast(status === 'resolved' ? 'Marked resolved' : status === 'open' ? 'Reopened'
        : status === 'approved' ? 'Approved — your agent can implement it' : 'Rejected');
    } catch (e) { toastError('Update failed'); }
  }
  async function sendReply(id) {
    const text = (replyDrafts[id] || '').trim();
    if (!text) return;
    try {
      const res = await fetch(API + '/comments/' + id + '/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: 'user', text }),
      });
      const data = await res.json();
      const i = comments.findIndex((c) => c.id === id);
      if (i >= 0) comments[i] = data.comment;
      delete replyDrafts[id];
      expandedId = id;
      refresh();
      toast('Reply sent');
    } catch (e) { toastError('Reply failed'); }
  }

  function deleteComment(id) {
    const idx = comments.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const removed = comments[idx];
    // Optimistic: drop locally now, defer the server delete so Undo can cancel it.
    comments.splice(idx, 1);
    if (expandedId === id) expandedId = null;
    refresh();
    const timer = setTimeout(async () => {
      try { await fetch(API + '/comments/' + id, { method: 'DELETE' }); }
      catch (e) {
        // Server delete failed — restore so we don't silently lose data.
        if (!comments.some((c) => c.id === id)) { comments.splice(Math.min(idx, comments.length), 0, removed); refresh(); }
        toastError('Delete failed');
      }
    }, 5000);
    toast('Comment deleted', { actionLabel: 'Undo', duration: 5000, onAction: () => {
      clearTimeout(timer);
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
        : open ? `${open} ready for your agent`
        : 'All resolved';
    }
  }
  function refresh() {
    renderPins();
    if (panelOpen) renderPanel();
    updateCount();
  }

  // ---------- live updates (SSE) ----------
  function animateResolve(id) {
    const p = placed.find((x) => x.comment.id === id);
    if (p) { p.pinEl.classList.add('kbf-just-resolved'); setTimeout(() => p.pinEl.classList.remove('kbf-just-resolved'), 1000); }
  }
  function applyComments(next) {
    const prev = new Map(comments.map((c) => [c.id, c.status]));
    comments = next;
    refresh();
    next.filter((c) => normalizePath(c.page) === PAGE && c.status === 'resolved' && prev.get(c.id) && prev.get(c.id) !== 'resolved')
      .forEach((c) => animateResolve(c.id));
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
  modeBtn.addEventListener('click', () => setMode(!mode));
  $('kbf-toggle-panel').addEventListener('click', () => setPanel(!panelOpen));
  $('kbf-panel-close').addEventListener('click', () => setPanel(false));
  root.querySelectorAll('.kbf-filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  $('kbf-copyfb').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('/feedback'); toast('Copied "/feedback" — paste it into your agent'); }
    catch (e) { toast('Run /feedback in Claude Code to process these'); }
  });
  if (MODE === 'md') {
    const stampBtn = $('kbf-stamp');
    stampBtn.style.display = '';
    stampBtn.addEventListener('click', async () => {
      try {
        const r = await fetch(API + '/md-export', { method: 'POST' }).then((x) => x.json());
        toast(`Stamped ${r.stamped} marker${r.stamped === 1 ? '' : 's'} into ${r.files} file${r.files === 1 ? '' : 's'}` + (r.notFound ? ` (${r.notFound} appended at end)` : ''));
      } catch (e) { toastError('Stamp failed'); }
    });
  }

  document.addEventListener('keydown', (e) => {
    const typing = e.target && /^(input|textarea|select)$/i.test(e.target.nodeName) || (e.target && e.target.isContentEditable);
    const inComposer = e.composedPath && e.composedPath().includes(host);
    if (e.key === 'Escape') {
      if (pickChain.length) { clearPick(); return; }
      if (activeComposer) { closeComposer(); return; }
      if (panelOpen) { setPanel(false); return; }
    }
    if (!typing && !inComposer && (e.key === 'c' || e.key === 'C')) { setMode(!mode); }
  });

  // ---------- boot ----------
  async function load() {
    try {
      const res = await fetch(API + '/comments');
      const data = await res.json();
      comments = data.comments || [];
    } catch (e) { comments = []; }
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
