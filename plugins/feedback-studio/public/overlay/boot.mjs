// Feedback Studio — boot: wire the modules together and start the overlay.
//
// Everything that used to run top-to-bottom inside the old single-file IIFE
// happens here, in the same order: mount the shadow UI, install the console
// test hooks, attach each module's listeners, then load the comments.

import {
  S, SS, ROLE, MODE, CAN_COMMENT, SR, scopeComments, pageComments, runTeardown, normalizePath,
} from '/__feedback/overlay/state.mjs';
import { on } from '/__feedback/overlay/events.mjs';
import { routeChange } from '/__feedback/lib/nav.mjs';
import {
  $, root, host, panel, modeBtn, helpEl, mountUI, toast, toastError,
} from '/__feedback/overlay/ui.mjs';
import { makePool, resolveWithConfidence, textRel, buildElementAnchor } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { initPins } from '/__feedback/overlay/pins.mjs';
import { initMode, setMode, clearPick, repositionAim } from '/__feedback/overlay/mode.mjs';
import { initComposer, closeComposer, positionTarget } from '/__feedback/overlay/composer.mjs';
import { initPanel, setPanel, setFilter, renderPanel, applyPanelShift, refresh, focusComment, startDomObserver, scheduleRerender } from '/__feedback/overlay/panel.mjs';
import { openVariantPreview, closeVariantPreview, repositionVariantBar } from '/__feedback/overlay/variants.mjs';
import { startNarrate, stopNarrate, closeDraftTray, startWalkthrough, closeWalkthrough } from '/__feedback/overlay/narrate.mjs';
import { initPresence } from '/__feedback/overlay/presence.mjs';
import { subscribeLive } from '/__feedback/overlay/live.mjs';
import { initTheme } from '/__feedback/overlay/theme.mjs';
import { initFab } from '/__feedback/overlay/fab.mjs';
import { initKeys, toggleHelp } from '/__feedback/overlay/keys.mjs';
import { initHistory, openHistory, historyChanged } from '/__feedback/overlay/history.mjs';
import { applyRound, offerSourceChange } from '/__feedback/overlay/live.mjs';
import { captureShot } from '/__feedback/overlay/shots.mjs';
import { t, tn, getLang, setLang } from '/__feedback/overlay/i18n.mjs';

// ---------- the few upward calls, wired once ----------
// A lower-layer module emits; the module that owns the behaviour handles it.
function wireEvents() {
  on('refresh', refresh);                                  // composer saved something
  on('comment:focus', (id) => focusComment(id, true));     // a pin was clicked
  on('variants:open', ({ comment, reply }) => openVariantPreview(comment, reply));
  // One scheduled re-measure, in the order the old schedulePos ran them
  // (the pins themselves are done before this fires).
  on('reposition', positionTarget);
  on('reposition', repositionAim);
  on('reposition', repositionVariantBar);
  on('layer', () => scheduleRerender(60));                 // a popup, dialog or menu opened or closed
  // Markdown mode: the document changed on disk — offer the diff (and the
  // history pane refreshes itself when it is open).
  on('source:changed', (note) => {
    historyChanged(note);
    toast(t('The document changed on disk (v{n}: +{a} −{r})', { n: note.n, a: note.a, r: note.r }),
      { actionLabel: t('Show what changed'), duration: 8000, onAction: () => openHistory({ from: note.n > 1 ? note.n - 1 : note.n, to: note.n }) });
  });
  on('round:changed', (n) => toast(t('Round {n} started', { n }), { duration: 2500 }));
}

// ---------- console hooks (the anchor-rot harness uses these) ----------
function installTestHooks() {
  // The anchor an element would get.
  window.__kbfBuildAnchor = (el) => (el && el.nodeType === 1 ? buildElementAnchor(el) : null);

  // Reproducible anchor self-test: re-resolve every comment anchored on this page
  // and report the confidence + whether the resolved element still matches the text.
  window.__kbfSelfTest = function () {
    const pool = makePool();
    const out = pageComments().map((c) => {
      const { el, confidence, ambiguous } = resolveWithConfidence(c.anchor, pool);
      const snip = c.anchor && (c.anchor.snippet || c.anchor.rangeText);
      const textOk = el ? textRel(el, snip) !== 'none' : false;
      return { id: c.id, confidence, found: !!el, textOk, ambiguous: !!ambiguous };
    });
    const n = out.length;
    // "Resolved" = confidently re-found (high/medium); low/none are refuse-and-re-pin.
    const resolved = out.filter((o) => o.confidence === 'high' || o.confidence === 'medium').length;
    const ambiguous = out.filter((o) => o.ambiguous).length; // snippet matched several elements
    return { total: n, resolved, ambiguous, rate: n ? +(resolved / n).toFixed(3) : null, detail: out };
  };
}

// ---------- wiring ----------
function wireChrome() {
  // Role-appropriate chrome: view links get the pins + panel, not the tools.
  if (!CAN_COMMENT) modeBtn.style.display = 'none';
  if (ROLE !== 'full') {
    const cap = root.querySelector('.kbf-copyfb-caption');
    if (cap) cap.style.display = 'none'; // "tell your agent PPF" is host guidance
  }
  modeBtn.addEventListener('click', () => { if (S.justDraggedFab) return; setMode(!S.mode, true); });
  $('kbf-toggle-panel').addEventListener('click', () => { if (S.justDraggedFab) return; setPanel(!S.panelOpen); });
  $('kbf-panel-close').addEventListener('click', () => setPanel(false));
  // Narrate ("Talk me through it") — hidden when voice or the role can't support it.
  const narrateBtn = $('kbf-narrate');
  if (narrateBtn) {
    if (!SR || !CAN_COMMENT) narrateBtn.style.display = 'none';
    else narrateBtn.addEventListener('click', () => { if (S.justDraggedFab) return; startNarrate(); });
  }
  const walkBtn = $('kbf-walk');
  if (walkBtn) walkBtn.addEventListener('click', () => startWalkthrough());
}

function wireFilters() {
  root.querySelectorAll('.kbf-filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
  if (MODE === 'md') {
    const stampBtn = $('kbf-stamp');
    stampBtn.style.display = '';
    stampBtn.addEventListener('click', async () => {
      try {
        const r = await api('/md-export', { method: 'POST' });
        toast(tn('Stamped {n} marker into {files}', 'Stamped {n} markers into {files}', r.stamped, { files: tn('{n} file', '{n} files', r.files) })
          + (r.notFound ? t(' ({n} skipped — no unique matching line/file; re-pin those)', { n: r.notFound }) : ''));
      } catch (e) { toastError(t('Stamp failed — {error}', { error: e.message })); }
    });
  }
  // Review rounds: the host can start a new one; every comment made from then
  // on carries the new number, and the "This round" chip narrows to it.
  const roundBtn = $('kbf-round-new');
  if (roundBtn) {
    roundBtn.addEventListener('click', async () => {
      try { applyRound(await api('/round', { method: 'POST' })); }
      catch (e) { toastError(t('Could not start a new round — {error}', { error: e.message })); }
    });
  }
  // EN / NL: remembered per browser; the page reloads so every label redraws.
  const langBtn = $('kbf-lang-toggle');
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      const next = getLang() === 'nl' ? 'en' : 'nl';
      setLang(next);
      toast(next === 'nl' ? t('Language set to Dutch') : t('Language set to English'), { duration: 1200 });
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 400);
    });
  }
}

// Before / after: a comment resolved in the last day that has a pin-time
// screenshot but no "after" picture yet gets one now, from the page as it is
// after the agent's edits and reload. captureShot refuses an element it
// cannot find with confidence, so a moved or removed element gets no pair.
function captureAfterShots() {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const c of pageComments()) {
    if (c.status !== 'resolved' || !c.shot || c.shotAfter) continue;
    if (!(c.updatedAt && Date.parse(c.updatedAt) > dayAgo)) continue;
    setTimeout(() => captureShot(c.id, { anchor: c.anchor, after: true }), 800);
  }
}

// ---------- single-page apps: follow the URL without a page load ----------
// A site with client-side routing calls history.pushState and swaps its content.
// Wrap pushState/replaceState once (guarded, so a second overlay instance or a
// hot reload never double-wraps) to raise 'kbf:navigate' after the original
// call, and listen to the browser's own back/forward and hash events. On a real
// change of page key: forget the old page's pin resolutions, close a thread or
// a new-comment composer that belonged to it, and redraw. The DOM observer
// then re-resolves the pins once the app has swapped its content.
function wireRouting() {
  if (!window.__kbfHistoryWrapped) {
    window.__kbfHistoryWrapped = true;
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      if (typeof orig !== 'function') continue;
      history[k] = function () {
        const r = orig.apply(this, arguments);
        try { window.dispatchEvent(new Event('kbf:navigate')); } catch (e) {}
        return r;
      };
    }
  }
  const onNav = () => {
    const open = S.expandedId ? S.comments.find((c) => c.id === S.expandedId) : null;
    const r = routeChange(S.page, location.pathname, {
      expandedPage: open ? normalizePath(open.page) : '',
      composerKind: S.activeComposer ? S.activeComposer.kind : '',
    });
    if (!r.changed) return;
    S.page = r.page;
    S.pinConf.clear();
    if (r.dropExpanded) S.expandedId = null;
    if (r.closeComposer) closeComposer();
    clearPick();
    refresh();
    if (S.panelOpen) applyPanelShift(true, true);
  };
  window.addEventListener('kbf:navigate', onNav);
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);
}

// Escape closes the topmost thing of ours. True when something was closed.
function consumeEscape() {
  if (helpEl && !helpEl.hidden) { toggleHelp(false); return true; } // the shortcut sheet is topmost
  if (S.walkState) { closeWalkthrough(); return true; } // Stop the walkthrough tour
  if (S.narrating) { stopNarrate(); return true; } // Stop narration → draft tray
  if (S.draftTray) { closeDraftTray(); return true; }
  if (runTeardown('crop')) return true; // crop modal is topmost — close it first, keep the composer
  if (S.variantPreview) { closeVariantPreview(); return true; }
  if (S.pickChain.length) { clearPick(); return true; }
  if (S.activeComposer) { closeComposer(); return true; }
  if (S.panelOpen) { setPanel(false); return true; }
  return false;
}

function wireKeys() {
  const onKey = (e) => {
    const typing = e.target && /^(input|textarea|select)$/i.test(e.target.nodeName) || (e.target && e.target.isContentEditable);
    const inComposer = e.composedPath && e.composedPath().includes(host);
    if (e.key === 'Escape') {
      // An Escape that closed something of ours goes no further: the page's
      // own dialog or menu (a native <dialog> closes on Escape by itself, and
      // many menus listen on document) stays open for the next comment.
      if (consumeEscape()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    // Bare P: Point — toggle click-to-comment (P matches "Point", like T matches
    // "Talk"). Bare only, so Ctrl/Cmd+P (print) and Alt+P are left alone.
    if (!typing && !inComposer && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'P')) { setMode(!S.mode, true); }
    // Bare T: Talk — start / stop the mic. While narrating, T stops even if the
    // narrate-bar language <select> has focus (otherwise its native single-letter
    // type-ahead eats the key and jumps languages, e.g. to "Turkish").
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      const inRealText = e.target && (/^(input|textarea)$/i.test(e.target.nodeName) || e.target.isContentEditable);
      if (S.narrating && !inRealText) { e.preventDefault(); stopNarrate(); }
      else if (!S.narrating && !typing && !inComposer && SR && CAN_COMMENT) startNarrate();
    }
  };
  // Keys pressed inside our UI stop at the host (see shieldHostEvents in
  // ui.mjs), so listen on the shadow root for those and on document for the page's.
  root.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey);
}

// ---------- boot ----------
async function load() {
  try {
    const data = await api('/comments');
    S.comments = scopeComments(data.comments || []);
    if (data.round) applyRound({ round: data.round, startedAt: data.roundStartedAt });
  } catch (e) {
    S.comments = [];
    // A server-side error (e.g. a corrupt comments.json) must not look like
    // "no comments yet" — say so. A plain network failure stays quiet.
    if (!e.network) toastError(t('Could not load comments — {error}', { error: e.message }));
  }
  setMode(S.mode);
  refresh();
  if (S.panelOpen) { panel.classList.add('is-open'); renderPanel(); applyPanelShift(true, true); }
  const focusId = SS.get('kbf-focus');
  if (focusId) {
    SS.remove('kbf-focus');
    setTimeout(() => focusComment(focusId, S.panelOpen), 400);
  }
  subscribeLive();
  startDomObserver();
  captureAfterShots();
  offerSourceChange();
}

export function boot() {
  wireEvents();
  mountUI();
  installTestHooks();
  initMode();
  initComposer();
  initPins();
  initPanel();
  initPresence();
  wireChrome();
  initTheme();
  initFab();
  wireFilters();
  wireRouting();
  wireKeys();
  initKeys();
  initHistory();
  load();
}
