// Feedback Studio — overlay client
// Mounted on every page via the local feedback server. Lets you attach
// comments (typed or spoken) to any element or text selection, persists them
// server-side, and renders pins + a cross-page review panel.

(function () {
  if (window.__kbfMounted) return;
  window.__kbfMounted = true;

  const API = '/__feedback/api';
  const PAGE = normalizePath(location.pathname);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- state ----------
  let comments = [];
  let mode = sessionStorage.getItem('kbf-mode') === '1';
  let panelOpen = sessionStorage.getItem('kbf-panel') === '1';
  let filter = sessionStorage.getItem('kbf-filter') || 'all';
  let activeComposer = null; // { kind:'new'|'edit', anchor, rect, comment? }
  let placed = []; // [{ comment, el, pinEl }]
  let recognizing = false;
  let recognition = null;
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
  let speechLang = localStorage.getItem('kbf-voicelang') || DEFAULT_LANG;
  if (!LANGS.some((l) => l.code === speechLang)) speechLang = DEFAULT_LANG;
  const langName = (code) => (LANGS.find((l) => l.code === code) || LANGS[0]).name;
  const langShort = (code) => code.split('-')[0].toUpperCase();
  const PLACEHOLDER = 'What needs to change here? (typed or spoken)';

  // Comment types decide how much latitude the AI agent gets when it acts on a comment.
  const TYPES = [
    { id: 'fix', label: 'Fix', hint: 'Something is broken or wrong — reproduce and patch it.' },
    { id: 'change', label: 'Change', hint: 'Make it exactly this — apply near-verbatim, no redesign.' },
    { id: 'improve', label: 'Improve', hint: 'This is weak — rewrite or redesign with judgement.' },
  ];
  const TYPE_IDS = TYPES.map((t) => t.id);
  let ctype = localStorage.getItem('kbf-ctype') || 'change';
  if (!TYPE_IDS.includes(ctype)) ctype = 'change';

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
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
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
    <div id="kbf-pins"></div>
    <div class="kbf-picker" id="kbf-picker">
      <span class="kbf-picker-tag" id="kbf-picker-tag"></span>
      <button class="kbf-picker-btn" data-pick="wider" title="Select the surrounding element">${I.up}</button>
      <button class="kbf-picker-btn" data-pick="narrower" title="Select a more specific element">${I.down}</button>
      <button class="kbf-picker-go" data-pick="comment">Comment</button>
      <button class="kbf-picker-btn kbf-picker-x" data-pick="cancel" title="Cancel">${I.close}</button>
    </div>
    <div id="kbf-composer-slot"></div>

    <aside class="kbf-panel ${panelOpen ? 'is-open' : ''}" id="kbf-panel">
      <div class="kbf-panel-head">
        <div class="kbf-panel-title">
          <h2>Feedback</h2>
          <button class="kbf-x" id="kbf-panel-close" title="Close">${I.close}</button>
        </div>
        <div class="kbf-panel-sub" id="kbf-panel-sub"></div>
        <div class="kbf-filters">
          <button class="kbf-filter" data-filter="all">All</button>
          <button class="kbf-filter" data-filter="open">Open</button>
          <button class="kbf-filter" data-filter="resolved">Resolved</button>
        </div>
      </div>
      <div class="kbf-list" id="kbf-list"></div>
      <div class="kbf-panel-foot">
        <span class="kbf-readyline" id="kbf-ready" title="Saved to .feedback/comments.json + FEEDBACK.md"></span>
        <button class="kbf-btn kbf-btn--primary kbf-copyfb" id="kbf-copyfb" title="Copy the command, then paste it into Claude Code / your agent">Copy /feedback</button>
      </div>
    </aside>

    <div class="kbf-fab-wrap">
      <button class="kbf-fab kbf-fab--mini" id="kbf-toggle-panel" title="Open feedback list">
        ${I.list}<span class="kbf-count" id="kbf-count"></span>
      </button>
      <button class="kbf-fab" id="kbf-toggle-mode" title="Toggle comment mode (C)">
        ${I.comment}<span class="kbf-fab-label" id="kbf-mode-label">Comment</span>
      </button>
    </div>

    <div class="kbf-toasts" id="kbf-toasts"></div>
  `;
  root.appendChild(ui);

  const $ = (id) => root.getElementById(id);
  const hl = $('kbf-hl');
  const hlTag = $('kbf-tag');
  const pinsLayer = $('kbf-pins');
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
  function byText(snip, tag) {
    if (!snip) return null;
    const t = norm(snip).slice(0, 80).toLowerCase(); // case-insensitive: text-transform shifts innerText case
    let list = [];
    try { list = [...document.querySelectorAll(tag && tag !== 'body' ? tag : '*')]; } catch (e) { list = [...document.querySelectorAll('*')]; }
    let found = list.find((e) => norm(e.textContent).toLowerCase().startsWith(t) && e.getClientRects().length);
    if (!found) found = list.find((e) => norm(e.textContent).toLowerCase().includes(t) && e.getClientRects().length);
    return found || null;
  }

  // Resolve an anchor with a confidence tier. Strategies are tried strongest-first;
  // when several independent strategies agree on the same element we are most sure.
  function resolveWithConfidence(a) {
    if (!a) return { el: null, confidence: null };
    const cands = [];
    const tryStrat = (name, fn) => { try { const el = fn(); if (el) cands.push({ name, el }); } catch (e) {} };
    if (a.attrSelector) tryStrat('attr', () => document.querySelector(a.attrSelector));
    if (a.selector) tryStrat('selector', () => document.querySelector(a.selector));
    if (a.xpath) tryStrat('xpath', () => byXPath(a.xpath));
    const snip = a.snippet || a.rangeText;
    if (snip) tryStrat('text', () => byText(snip, a.tag));
    if (!cands.length) return { el: null, confidence: null };

    // Pick the element the most strategies agree on (attr/selector weigh extra).
    const score = new Map();
    const weight = { attr: 2, selector: 2, xpath: 1, text: 1 };
    for (const c of cands) score.set(c.el, (score.get(c.el) || 0) + (weight[c.name] || 1));
    let best = cands[0].el, bestScore = 0;
    for (const [el, s] of score) if (s > bestScore) { best = el; bestScore = s; }

    const textOk = !snip || norm(best.textContent).toLowerCase().includes(norm(snip).slice(0, 40).toLowerCase());
    let confidence;
    if (bestScore >= 3 && textOk) confidence = 'high';
    else if ((cands.some((c) => c.name === 'attr') || (cands.some((c) => c.name === 'selector') && textOk))) confidence = 'high';
    else if (textOk) confidence = 'medium';
    else confidence = 'low';
    return { el: best, confidence };
  }
  function resolveAnchor(a) { return resolveWithConfidence(a).el; }

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
    const out = pageComments().map((c) => {
      const { el, confidence } = resolveWithConfidence(c.anchor);
      const snip = norm(c.anchor && (c.anchor.snippet || c.anchor.rangeText)).slice(0, 40).toLowerCase();
      const textOk = el ? norm(el.textContent).toLowerCase().includes(snip) : false;
      return { id: c.id, confidence, found: !!el, textOk };
    });
    const n = out.length;
    const resolved = out.filter((o) => o.found && o.textOk).length;
    return { total: n, resolved, rate: n ? +(resolved / n).toFixed(3) : null, detail: out };
  };

  // ---------- comment mode ----------
  function setMode(on) {
    mode = on;
    sessionStorage.setItem('kbf-mode', on ? '1' : '0');
    modeBtn.classList.toggle('is-active', on);
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
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(host);
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
        openComposer({ kind: 'new', anchor: buildRangeAnchor(sel), rect: sel.getRangeAt(0).getBoundingClientRect() });
        return;
      }
      if (moved > 10) return; // a scroll / swipe / drag, not a tap
      if (!(target instanceof Element) || target === document.body || target === document.documentElement) return;
      if (type === 'mouse') {
        openComposer({ kind: 'new', anchor: buildElementAnchor(target), rect: target.getBoundingClientRect() });
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
      if (el) openComposer({ kind: 'new', anchor: buildElementAnchor(el), rect: el.getBoundingClientRect() });
    }
  });

  // ---------- composer ----------
  function closeComposer() {
    stopRecognition();
    activeComposer = null;
    composerSlot.innerHTML = '';
    pickChain = [];
    pickIdx = 0;
    picker.style.display = 'none';
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
        <div class="kbf-rec-hint"><span class="kbf-rec-dot"></span> <span class="kbf-rec-text">Listening…</span></div>
        <div class="kbf-composer-foot">
          <button class="kbf-mic" data-act="mic" title="${SR ? 'Dictate (voice to text)' : 'Voice not supported in this browser'}">${I.mic}</button>
          <div class="kbf-langwrap">
            <button class="kbf-lang" data-act="lang" title="Voice language: ${escapeHtml(langName(speechLang))}">${escapeHtml(langShort(speechLang))}</button>
            <div class="kbf-langmenu" hidden>
              ${LANGS.map((l) => `<button class="kbf-langitem${l.code === speechLang ? ' is-current' : ''}" data-lang="${l.code}">${escapeHtml(l.name)}</button>`).join('')}
            </div>
          </div>
          <div class="kbf-spacer"></div>
          <button class="kbf-btn kbf-btn--ghost" data-act="cancel">Cancel</button>
          <button class="kbf-btn kbf-btn--primary" data-act="save" disabled>${isEdit ? 'Update' : 'Save'}</button>
        </div>
      </div>`;
    composerSlot.appendChild(box);

    const ta = box.querySelector('.kbf-textarea');
    const micBtn = box.querySelector('[data-act="mic"]');
    const langBtn = box.querySelector('[data-act="lang"]');
    const saveBtn = box.querySelector('[data-act="save"]');
    const hint = box.querySelector('.kbf-rec-hint');
    const hintText = box.querySelector('.kbf-rec-text');
    if (!SR) { micBtn.disabled = true; langBtn.disabled = true; }
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

    const langMenu = box.querySelector('.kbf-langmenu');
    box.addEventListener('click', (e) => {
      const typeBtn = e.target.closest('[data-type]');
      if (typeBtn) {
        ctype = typeBtn.dataset.type;
        localStorage.setItem('kbf-ctype', ctype);
        box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === ctype));
        return;
      }
      const langItem = e.target.closest('[data-lang]');
      if (langItem) { setVoiceLang(langItem.dataset.lang, box, micBtn, hintText); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeComposer();
      else if (act === 'mic') toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow);
      else if (act === 'lang') { langMenu.hidden = !langMenu.hidden; }
      else if (act === 'save') doSave(opts, ta.value.trim());
      else if (langMenu && !langMenu.hidden) langMenu.hidden = true;
    });
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
          body: JSON.stringify({ page: PAGE, pageTitle: document.title, url: location.href, anchor: opts.anchor, text, type: ctype }),
        });
        const data = await res.json();
        comments.push(data.comment);
        toast('Comment saved');
      }
      closeComposer();
      refresh();
    } catch (e) {
      toast('Save failed — is the server running?');
    }
  }

  // ---------- voice ----------
  function stopRecognition() {
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
    localStorage.setItem('kbf-voicelang', code);
    const langBtn = box.querySelector('.kbf-lang');
    if (langBtn) { langBtn.textContent = langShort(code); langBtn.title = 'Voice language: ' + langName(code); }
    box.querySelectorAll('.kbf-langitem').forEach((it) => it.classList.toggle('is-current', it.dataset.lang === code));
    const menu = box.querySelector('.kbf-langmenu');
    if (menu) menu.hidden = true;
    if (hintText) hintText.textContent = 'Listening… (' + langName(code) + ')';
    // a live language switch takes effect on the next dictation start
    if (recognizing) { stopRecognition(); if (micBtn) micBtn.classList.remove('is-recording'); }
    toast('Voice language: ' + langName(code));
  }
  function toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow) {
    if (!SR) return;
    if (recognizing) { stopRecognition(); micBtn.classList.remove('is-recording'); hint.classList.remove('is-on'); return; }
    if (hintText) hintText.textContent = 'Listening… (' + langName(speechLang) + ')';
    recognition = new SR();
    recognition.lang = speechLang;
    recognition.interimResults = true;
    recognition.continuous = true;
    let committed = ta.value;
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i][0].transcript;
        if (e.results[i].isFinal) committed = appendSentence(committed, seg);
        else interim += seg;
      }
      ta.value = interim ? appendSentence(committed, interim) : committed;
      validate(); autoGrow();
    };
    recognition.onend = () => { recognizing = false; micBtn.classList.remove('is-recording'); hint.classList.remove('is-on'); };
    recognition.onerror = (ev) => {
      recognizing = false; micBtn.classList.remove('is-recording'); hint.classList.remove('is-on');
      if (ev.error === 'not-allowed') toast('Microphone blocked — allow mic access');
    };
    try { recognition.start(); recognizing = true; micBtn.classList.add('is-recording'); hint.classList.add('is-on'); }
    catch (e) {}
  }

  // ---------- pins ----------
  function pageComments() {
    return comments.filter((c) => normalizePath(c.page) === PAGE);
  }
  function renderPins() {
    pinsLayer.innerHTML = '';
    placed = [];
    const list = pageComments();
    list.forEach((c, idx) => {
      const el = resolveAnchor(c.anchor);
      if (!el) return;
      const pin = document.createElement('div');
      pin.className = 'kbf-pin' + (c.status === 'resolved' ? ' is-resolved' : '');
      pin.textContent = String(idx + 1);
      pin.title = c.text;
      pin.addEventListener('click', () => focusComment(c.id, true));
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
      if (pickChain.length && picker.style.display !== 'none') renderPick();
    });
  }
  window.addEventListener('scroll', schedulePos, true);
  window.addEventListener('resize', schedulePos);

  // ---------- panel ----------
  function setPanel(open) {
    panelOpen = open;
    sessionStorage.setItem('kbf-panel', open ? '1' : '0');
    panel.classList.toggle('is-open', open);
    if (open) renderPanel();
  }
  function setFilter(f) {
    filter = f;
    sessionStorage.setItem('kbf-filter', f);
    renderPanel();
  }
  function filtered(list) {
    if (filter === 'open') return list.filter((c) => c.status !== 'resolved');
    if (filter === 'resolved') return list.filter((c) => c.status === 'resolved');
    return list;
  }

  function renderPanel() {
    root.querySelectorAll('.kbf-filter').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === filter));
    const open = comments.filter((c) => c.status !== 'resolved').length;
    subEl.textContent = `${comments.length} comment${comments.length === 1 ? '' : 's'} across the site · ${open} open`;

    const view = filtered(comments);
    if (!view.length) {
      listEl.innerHTML = `<div class="kbf-empty">${I.empty}<p>${comments.length ? 'Nothing in this filter.' : 'No comments yet.<br>Turn on comment mode and click anything on the page.'}</p></div>`;
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
        const done = c.status === 'resolved';
        const ct = TYPE_IDS.includes(c.type) ? c.type : 'change';
        html += `
          <div class="kbf-card ${done ? 'is-resolved' : ''}" data-id="${c.id}" data-page="${escapeHtml(key)}" data-url="${escapeHtml(c.url || '')}">
            <div class="kbf-card-top">
              <span class="kbf-badge">${num}</span>
              <span class="kbf-type-tag kbf-type-${ct}">${ct}</span>
              <span class="kbf-card-anchor" title="${escapeHtml(anchorTxt)}">${escapeHtml(anchorTxt)}</span>
            </div>
            <div class="kbf-card-text">${escapeHtml(c.text)}</div>
            <div class="kbf-card-foot">
              <span class="kbf-time">${timeAgo(c.createdAt)}</span>
              <button class="kbf-mini" data-act="jump" title="Go to element">${I.jump}</button>
              <button class="kbf-mini" data-act="edit" title="Edit">${I.edit}</button>
              <button class="kbf-mini kbf-mini--ok ${done ? 'is-done' : ''}" data-act="resolve" title="${done ? 'Reopen' : 'Resolve'}">${I.check}</button>
              <button class="kbf-mini kbf-mini--danger" data-act="delete" title="Delete">${I.trash}</button>
            </div>
          </div>`;
      }
    }
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.kbf-card');
    if (!card) return;
    const id = card.dataset.id;
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    const actBtn = e.target.closest('[data-act]');
    const act = actBtn && actBtn.dataset.act;
    if (act === 'delete') return deleteComment(id);
    if (act === 'resolve') return toggleResolve(c);
    if (act === 'edit') return editFromCard(c);
    // default / jump
    goToComment(c);
  });

  function goToComment(c) {
    const key = normalizePath(c.page);
    if (key === PAGE) {
      focusComment(c.id, false);
    } else {
      sessionStorage.setItem('kbf-focus', c.id);
      sessionStorage.setItem('kbf-panel', '1');
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
    setTimeout(() => openComposer({ kind: 'edit', anchor: c.anchor, rect: (el ? el.getBoundingClientRect() : rect), comment: c }), el ? 260 : 0);
  }

  async function toggleResolve(c) {
    const next = c.status === 'resolved' ? 'open' : 'resolved';
    try {
      const res = await fetch(API + '/comments/' + c.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      const i = comments.findIndex((x) => x.id === c.id);
      if (i >= 0) comments[i] = data.comment;
      refresh();
      toast(next === 'resolved' ? 'Marked resolved' : 'Reopened');
    } catch (e) { toast('Update failed'); }
  }

  async function deleteComment(id) {
    try {
      await fetch(API + '/comments/' + id, { method: 'DELETE' });
      comments = comments.filter((c) => c.id !== id);
      refresh();
      toast('Comment deleted');
    } catch (e) { toast('Delete failed'); }
  }

  // ---------- toast ----------
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'kbf-toast';
    t.innerHTML = I.check + '<span>' + escapeHtml(msg) + '</span>';
    toastsEl.appendChild(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 220); }, 2200);
  }

  // ---------- misc ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function updateCount() {
    const open = comments.filter((c) => c.status !== 'resolved').length;
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
  function subscribeLive() {
    if (typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource(API.replace('/api', '') + '/events');
      es.addEventListener('comments', (e) => {
        try { const d = JSON.parse(e.data); if (d && Array.isArray(d.comments)) applyComments(d.comments); } catch (err) {}
      });
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
    const focusId = sessionStorage.getItem('kbf-focus');
    if (focusId) {
      sessionStorage.removeItem('kbf-focus');
      setTimeout(() => focusComment(focusId, panelOpen), 400);
    }
    subscribeLive();
  }
  load();
})();
