// Feedback Studio — Point mode: aiming at what you want to comment on.
// The hover highlight, sentence-level aiming in --md, the pointer handlers that
// open the composer, and the touch picker that walks up and down the DOM.

import { S, MODE, CAN_COMMENT, SS } from '/__feedback/overlay/state.mjs';
import {
  hlTag, host, picker, pickerTag, modeBtn,
  hideHighlight, showHighlightFor, showSentence, clearSentence, isInUI, toast,
} from '/__feedback/overlay/ui.mjs';
import { norm, buildElementAnchor, buildRangeAnchor, buildRangeAnchorFromRange } from '/__feedback/overlay/dom.mjs';
import { openComposer, closeComposer } from '/__feedback/overlay/composer.mjs';

// How far a pointer may travel and still count as a tap rather than a scroll,
// swipe or drag. (The FAB uses its own, smaller threshold — see fab.mjs.)
const TAP_SLOP = 10;

export function setMode(on, announce) {
  if (!CAN_COMMENT) on = false; // view links never enter comment mode
  if (on && (S.narrating || S.walkState)) return; // don't enter Point mode mid-narration/walkthrough
  const was = S.mode;
  S.mode = on;
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

// ---------- sentence-level aiming (md mode) ----------
// In --md review the natural unit is often ONE sentence inside a paragraph.
// Hovering a text block keeps the whole-block outline, but the sentence under
// the cursor gets its own soft fill and a click anchors the comment to just
// that sentence — the same range anchor a manual text selection produces, so
// resolution and .md stamping need no new machinery. Aiming at the block's
// padding (or past the end of a line) still comments on the whole block, and
// a block that IS a single sentence stays a plain element anchor.
const SENT_BLOCKS = 'p, li, blockquote, dd, dt, td, th, figcaption, h1, h2, h3, h4, h5, h6';

function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

// The block's text as one flat string plus the text nodes that make it up.
// Text belonging to a NESTED block (li > ul > li) or to a pre is that block's
// text, not this one's — skip it so offsets line up with what the user reads.
function sentTextMap(block) {
  const pieces = [];
  let len = 0;
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest('pre') || p.closest(SENT_BLOCKS) !== block) continue;
    pieces.push({ node: n, start: len, end: len + n.data.length });
    len += n.data.length;
  }
  return { pieces, text: pieces.map((x) => x.node.data).join('') };
}

function sentSegments(text) {
  const raw = [];
  if (window.Intl && Intl.Segmenter) {
    for (const s of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)) {
      raw.push({ start: s.index, end: s.index + s.segment.length });
    }
  } else {
    const re = /[^.!?…]+[.!?…]*['")\]]*\s*/g;
    let m;
    while ((m = re.exec(text))) raw.push({ start: m.index, end: m.index + m[0].length });
  }
  const segs = [];
  for (const s of raw) {
    let a = s.start, b = s.end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) segs.push({ start: a, end: b });
  }
  return segs;
}

// The sentence under (x, y) as a live Range — or null when whole-block
// behaviour should apply (not md mode, not a text block, cursor off the
// text, or the block is a single sentence anyway).
function sentenceRangeAt(x, y, target) {
  if (MODE !== 'md') return null;
  const block = target instanceof Element ? target.closest(SENT_BLOCKS) : null;
  if (!block || block.closest('pre, code')) return null;
  const caret = caretFromPoint(x, y);
  if (!caret || !caret.node || caret.node.nodeType !== 3) return null;
  let data = S.sentCache;
  if (!data || data.block !== block || !block.isConnected) {
    const { pieces, text } = sentTextMap(block);
    data = S.sentCache = { block, pieces, text, segs: sentSegments(text) };
  }
  if (data.segs.length < 2) return null;
  const piece = data.pieces.find((p) => p.node === caret.node);
  if (!piece) return null;
  const off = piece.start + Math.min(caret.offset, caret.node.data.length);
  const seg = data.segs.find((s) => off >= s.start && off <= s.end);
  if (!seg) return null;
  const sp = data.pieces.find((p) => seg.start >= p.start && seg.start < p.end);
  const ep = data.pieces.find((p) => seg.end > p.start && seg.end <= p.end);
  if (!sp || !ep) return null;
  const range = document.createRange();
  range.setStart(sp.node, seg.start - sp.start);
  range.setEnd(ep.node, seg.end - ep.start);
  // Only when the cursor is really over the sentence's own line boxes: the
  // caret snaps to the NEAREST text, so without this check, hovering the
  // block's padding would steal the whole-block click.
  const hit = [...range.getClientRects()].some((r) => x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3);
  return hit ? range : null;
}

// Aim the hover highlight at whatever sits under (x, y) — shared by mousemove
// and the scroll re-aim, so the preview always matches what a click would pick.
function aimHoverAt(el, x, y) {
  if (el && el instanceof Element && el !== document.documentElement && el !== document.body) {
    showHighlightFor(el);
    const sent = sentenceRangeAt(x, y, el);
    if (sent) { showSentence(sent); hlTag.textContent += ' · sentence'; }
    else clearSentence();
  } else hideHighlight();
}

// Scrolling moves the page under a stationary cursor without firing mousemove,
// so the fixed-position highlight used to stay glued to the screen and ride
// over content it never belonged to. Re-aim from the last known cursor
// position instead — but only while plain Point-mode hovering owns the
// highlight (not the touch picker or the walkthrough, which place it
// deliberately), and never from a touch point (no cursor to re-aim from).
function reaimHover() {
  if (!S.mode || S.activeComposer || !S.lastMouse || S.walkState) return;
  if (S.pickChain.length && picker.style.display !== 'none') return;
  const el = document.elementFromPoint(S.lastMouse.x, S.lastMouse.y);
  if (!el || el === host || host.contains(el)) { hideHighlight(); return; }
  aimHoverAt(el, S.lastMouse.x, S.lastMouse.y);
}

// What Point mode contributes to a scheduled re-measure (see pins.schedulePos).
export function repositionAim() {
  reaimHover();
  if (S.pickChain.length && picker.style.display !== 'none') renderPick();
}

// ---------- touch element picker ----------
function startPick(el) {
  if (!el || el === document.body || el === document.documentElement) return;
  S.pickChain = [el];
  S.pickIdx = 0;
  renderPick();
}
function pickWider() {
  const cur = S.pickChain[S.pickIdx];
  const par = cur && cur.parentElement;
  if (!par || par === document.body || par === document.documentElement) return;
  if (S.pickIdx === S.pickChain.length - 1) S.pickChain.push(par);
  else S.pickChain[S.pickIdx + 1] = par;
  S.pickIdx++;
  renderPick();
}
function pickNarrower() {
  if (S.pickIdx > 0) { S.pickIdx--; renderPick(); }
}
function renderPick() {
  const el = S.pickChain[S.pickIdx];
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
  picker.querySelector('[data-pick="narrower"]').disabled = S.pickIdx === 0;
}
export function clearPick() {
  S.pickChain = [];
  S.pickIdx = 0;
  picker.style.display = 'none';
  hideHighlight();
}

// ---------- point once at an element ----------
// Used by "re-pin this comment" and by "point to it" on a spoken draft: take
// over the page for one click, highlighting whatever is under the cursor.
// `onPick` gets the clicked element, or null when the reviewer pressed Escape;
// the listeners and the crosshair are already cleaned up by then.
export function pickElement(onPick) {
  const done = (el) => { cleanup(); onPick(el); };
  const onClick = (e) => {
    if (isInUI(e)) return;
    e.preventDefault(); e.stopPropagation();
    done(e.target);
  };
  const onMove = (e) => { if (!isInUI(e) && e.target instanceof Element) showHighlightFor(e.target); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
  function cleanup() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.cursor = ''; // restore the page cursor
    hideHighlight();
  }
  document.documentElement.style.cursor = 'crosshair';
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('keydown', onKey, true);
}

// ---------- listeners ----------
export function initMode() {
  // Console hook (like __kbfBuildAnchor): the sentence a point would anchor to.
  window.__kbfSentenceAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const r = el && sentenceRangeAt(x, y, el);
    return r ? r.toString() : null;
  };

  document.addEventListener('mousemove', (e) => {
    S.lastMouse = { x: e.clientX, y: e.clientY };
    if (!S.mode || S.activeComposer) return;
    if (isInUI(e)) { hideHighlight(); return; }
    if (S.rafHover) return;
    S.rafHover = requestAnimationFrame(() => {
      S.rafHover = 0;
      aimHoverAt(e.target, e.clientX, e.clientY);
    });
  }, true);

  document.addEventListener('click', (e) => {
    if (!S.mode || isInUI(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Pointer-based selection. Mouse opens the composer straight away (with the
  // live hover highlight to aim). Touch/pen taps a candidate element and shows a
  // picker to walk up/down the DOM, because phones have no hover to preview with.
  let pdown = null;
  document.addEventListener('pointerdown', (e) => {
    // A touch has no resting cursor — forget the mouse point so a touch scroll
    // can't resurrect a hover highlight at a stale position.
    if (e.pointerType && e.pointerType !== 'mouse') S.lastMouse = null;
    if (!S.mode || isInUI(e)) return;
    pdown = { x: e.clientX, y: e.clientY, type: e.pointerType };
  }, true);

  document.addEventListener('pointerup', (e) => {
    if (!S.mode || isInUI(e) || S.activeComposer) return;
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
      if (moved > TAP_SLOP) return; // a scroll / swipe / drag, not a tap
      if (!(target instanceof Element) || target === document.body || target === document.documentElement) return;
      // never anchor a comment to a variant-preview candidate — it's throwaway DOM
      if (target.closest('[data-kbf-variant]')) return;
      if (type === 'mouse') {
        const sent = sentenceRangeAt(e.clientX, e.clientY, target);
        if (sent) openComposer({ kind: 'new', anchor: buildRangeAnchorFromRange(sent), rect: sent.getBoundingClientRect(), range: sent });
        else openComposer({ kind: 'new', anchor: buildElementAnchor(target), rect: target.getBoundingClientRect(), el: target });
      } else {
        startPick(target); // touch / pen: confirm + adjust with the picker
      }
    }, 0);
  }, true);

  // Double-click on the commented element = jump straight into editing its text
  // (the first click of the pair already opened the composer via pointerup).
  document.addEventListener('dblclick', (e) => {
    if (!S.mode || isInUI(e)) return;
    e.preventDefault();
    const a = S.activeComposer;
    if (a && a.textEditApi && a.el && (a.el === e.target || a.el.contains(e.target))) a.textEditApi.start();
  }, true);

  picker.addEventListener('click', (e) => {
    const act = e.target.closest('[data-pick]')?.dataset.pick;
    if (act === 'wider') pickWider();
    else if (act === 'narrower') pickNarrower();
    else if (act === 'cancel') clearPick();
    else if (act === 'comment') {
      const el = S.pickChain[S.pickIdx];
      picker.style.display = 'none';
      if (el) openComposer({ kind: 'new', anchor: buildElementAnchor(el), rect: el.getBoundingClientRect(), el });
    }
  });
}
