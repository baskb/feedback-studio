// Feedback Studio — boot: wire the modules together and start the overlay.
//
// Everything that used to run top-to-bottom inside the old single-file IIFE
// happens here, in the same order: mount the shadow UI, install the console
// test hooks, attach each module's listeners, then load the comments.

import {
  S, SS, ROLE, MODE, CAN_COMMENT, SR, scopeComments, pageComments, runTeardown,
} from '/__feedback/overlay/state.mjs';
import { on } from '/__feedback/overlay/events.mjs';
import {
  $, root, host, panel, modeBtn, mountUI, toast, toastError,
} from '/__feedback/overlay/ui.mjs';
import { makePool, resolveWithConfidence, textRel, buildElementAnchor } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { initPins } from '/__feedback/overlay/pins.mjs';
import { initMode, setMode, clearPick, repositionAim } from '/__feedback/overlay/mode.mjs';
import { initComposer, closeComposer, positionTarget } from '/__feedback/overlay/composer.mjs';
import { initPanel, setPanel, setFilter, renderPanel, applyPanelShift, refresh, focusComment, startDomObserver } from '/__feedback/overlay/panel.mjs';
import { openVariantPreview, closeVariantPreview, repositionVariantBar } from '/__feedback/overlay/variants.mjs';
import { startNarrate, stopNarrate, closeDraftTray, startWalkthrough, closeWalkthrough } from '/__feedback/overlay/narrate.mjs';
import { initPresence } from '/__feedback/overlay/presence.mjs';
import { subscribeLive } from '/__feedback/overlay/live.mjs';
import { initTheme } from '/__feedback/overlay/theme.mjs';
import { initFab } from '/__feedback/overlay/fab.mjs';

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
        toast(`Stamped ${r.stamped} marker${r.stamped === 1 ? '' : 's'} into ${r.files} file${r.files === 1 ? '' : 's'}`
          + (r.notFound ? ` (${r.notFound} skipped — no unique matching line/file; re-pin those)` : ''));
      } catch (e) { toastError('Stamp failed — ' + e.message); }
    });
  }
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = e.target && /^(input|textarea|select)$/i.test(e.target.nodeName) || (e.target && e.target.isContentEditable);
    const inComposer = e.composedPath && e.composedPath().includes(host);
    if (e.key === 'Escape') {
      if (S.walkState) { closeWalkthrough(); return; } // Stop the walkthrough tour
      if (S.narrating) { stopNarrate(); return; } // Stop narration → draft tray
      if (S.draftTray) { closeDraftTray(); return; }
      if (runTeardown('crop')) return; // crop modal is topmost — close it first, keep the composer
      if (S.variantPreview) { closeVariantPreview(); return; }
      if (S.pickChain.length) { clearPick(); return; }
      if (S.activeComposer) { closeComposer(); return; }
      if (S.panelOpen) { setPanel(false); return; }
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
  });
}

// ---------- boot ----------
async function load() {
  try {
    const data = await api('/comments');
    S.comments = scopeComments(data.comments || []);
  } catch (e) {
    S.comments = [];
    // A server-side error (e.g. a corrupt comments.json) must not look like
    // "no comments yet" — say so. A plain network failure stays quiet.
    if (!e.network) toastError('Could not load comments — ' + e.message);
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
  wireKeys();
  load();
}
