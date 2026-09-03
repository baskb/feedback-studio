// Feedback Studio — the composer: the little dialog that turns a pick into a
// saved comment, and everything that has to be undone when it closes.

import {
  S, MODE, ROLE, PAGE, SOURCE, LS, LANGS, SR, TYPES, TYPE_IDS,
  langName, langShort, placeholderFor, drainTeardown,
} from '/__feedback/overlay/state.mjs';
import {
  I, composerSlot, targetsLayer, picker,
  escapeHtml, hideHighlight, toast, toastError, autoGrow,
} from '/__feedback/overlay/ui.mjs';
import { norm, resolveAnchor } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { clearTweakPreview, setupTweaks, makeTrustedGetEl } from '/__feedback/overlay/tweaks.mjs';
import { setupTextEdit } from '/__feedback/overlay/textedit.mjs';
import { setupImageReplace } from '/__feedback/overlay/image.mjs';
import { captureShot } from '/__feedback/overlay/shots.mjs';
import { stopRecognition, toggleRecognition, setVoiceLang } from '/__feedback/overlay/voice.mjs';

export function closeComposer() {
  stopRecognition();
  clearTarget();
  clearTweakPreview();
  // Every live on-page preview registered an undo: the variant swap, the
  // retyped text, the replacement image, an open crop modal.
  drainTeardown();
  S.activeComposer = null;
  composerSlot.innerHTML = '';
  S.pickChain = [];
  S.pickIdx = 0;
  picker.style.display = 'none';
}

// Rainbow highlight over exactly what's being commented on, while the composer
// is open (the native text selection is lost once the textarea takes focus).
function clearTarget() {
  S.targetEls.forEach((e) => e.remove());
  S.targetEls = [];
}
function targetRects() {
  const a = S.activeComposer;
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
    S.targetEls.push(d);
  }
}
export function positionTarget() {
  if (!S.activeComposer || !S.targetEls.length) return;
  const rects = targetRects();
  if (rects.length !== S.targetEls.length) { showTarget(); return; }
  rects.forEach((r, i) => {
    const d = S.targetEls[i];
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
export function initComposer() {
  if (!window.visualViewport) return;
  let rafVV = 0;
  const onVV = () => {
    if (rafVV) return;
    rafVV = requestAnimationFrame(() => {
      rafVV = 0;
      if (!S.activeComposer) return;
      const box = composerSlot.querySelector('.kbf-composer');
      if (box) keepComposerInView(box);
    });
  };
  window.visualViewport.addEventListener('resize', onVV);
  window.visualViewport.addEventListener('scroll', onVV);
}

export function openComposer(opts) {
  closeComposer();
  S.activeComposer = opts;
  hideHighlight();
  const isEdit = opts.kind === 'edit';
  if (!isEdit) S.ctype = TYPES[0].id; // new comment: back to the mode default, never the previous pick
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
        ${TYPES.map((t) => `<button class="kbf-type${t.id === S.ctype ? ' is-active' : ''}" data-type="${t.id}" title="${escapeHtml(t.hint)}">${t.label}</button>`).join('')}
      </div>
      ${ROLE === 'comment' ? `<input class="kbf-name-input" maxlength="60" placeholder="Your name (shown with your comment)" value="${escapeHtml(LS.get('kbf-name') || '')}" aria-label="Your name">` : ''}
      <textarea class="kbf-textarea" placeholder="${escapeHtml(placeholderFor(S.ctype))}"></textarea>
      <div class="kbf-rec-hint" role="status" aria-live="polite"><span class="kbf-rec-dot"></span> <span class="kbf-rec-text">Listening…</span></div>
      <div class="kbf-composer-foot">
        <button class="kbf-mic" data-act="mic" aria-pressed="false" aria-label="Dictate (voice to text)" title="${SR ? 'Dictate (voice to text)' : 'Voice not supported in this browser'}">${I.mic}</button>
        <label class="kbf-langwrap" title="Voice language: ${escapeHtml(langName(S.speechLang))}">
          <span class="kbf-lang" aria-hidden="true">${escapeHtml(langShort(S.speechLang))}</span>
          <select class="kbf-langselect" aria-label="Voice language">
            ${LANGS.map((l) => `<option value="${l.code}"${l.code === S.speechLang ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
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
      S.ctype = opts.comment.type;
      box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === S.ctype));
    }
  }

  function validate() {
    saveBtn.disabled = !ta.value.trim()
      && !(opts.tweaks && opts.tweaks.count())
      && !(opts.textEditApi && opts.textEditApi.changed())
      && !(opts.imageReplace && opts.imageReplace.count());
  }
  const grow = () => autoGrow(ta, 240);
  ta.addEventListener('input', () => { validate(); grow(); });

  // A retyped text / dialled tweak implies a type; honour an explicit choice.
  let userPickedType = false;
  opts.suggestType = (t) => {
    if (userPickedType || !TYPE_IDS.includes(t)) return;
    S.ctype = t;
    box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === S.ctype));
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
      S.ctype = typeBtn.dataset.type;
      if (opts.markTypePicked) opts.markTypePicked();
      box.querySelectorAll('.kbf-type').forEach((b) => b.classList.toggle('is-active', b.dataset.type === S.ctype));
      const taEl = box.querySelector('.kbf-textarea'); // prompt matches the picked type
      if (taEl && !taEl.value) taEl.placeholder = placeholderFor(S.ctype);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeComposer();
    else if (act === 'mic') toggleRecognition(ta, micBtn, hint, hintText, validate, grow);
    else if (act === 'save') doSave(opts, ta.value.trim());
  });
  langSel.addEventListener('change', () => { setVoiceLang(langSel.value, box, micBtn, hintText); langSel.blur(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!saveBtn.disabled) doSave(opts, ta.value.trim()); }
  });

  positionComposer(box, opts.rect);
  validate(); grow();
  requestAnimationFrame(() => positionComposer(box, opts.rect));
  setTimeout(() => ta.focus(), 30);
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
      const body = { text, type: S.ctype };
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
      const i = S.comments.findIndex((c) => c.id === data.comment.id);
      if (i >= 0) S.comments[i] = data.comment;
      if (imageReplace && imageDataUrl) savedNew = data.comment; // upload the new bytes below
      toast('Comment updated');
    } else {
      // shared "comment" links attach the reviewer's name (persisted locally)
      const nameEl = composerSlot.querySelector('.kbf-name-input');
      const authorName = nameEl ? nameEl.value.trim().slice(0, 60) : '';
      if (nameEl) LS.set('kbf-name', authorName);
      const data = await api('/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: PAGE, pageTitle: document.title, url: location.href, anchor: opts.anchor, text, type: S.ctype, edits, textEdit, imageReplace, authorName, sourceFile: SOURCE }),
      });
      S.comments.push(data.comment);
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
        const i = S.comments.findIndex((c) => c.id === savedNew.id);
        if (i >= 0 && up.comment) S.comments[i] = up.comment;
      } catch (e) {
        // Upload failed — clear the dangling imageReplace so the comment doesn't
        // persist as a bare "image intended, none here" bullet.
        toastError('Image upload failed — ' + e.message);
        try {
          const cl = await api('/comments/' + savedNew.id, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageReplace: null }),
          });
          const i = S.comments.findIndex((c) => c.id === savedNew.id);
          if (i >= 0 && cl.comment) S.comments[i] = cl.comment;
        } catch (e2) {}
      }
    }
    closeComposer();
    emit('refresh');
    // capture AFTER previews reverted: the shot is the page as reviewed
    if (savedNew && !imageReplace) captureShot(savedNew.id, opts);
  } catch (e) {
    toastError('Save failed — ' + e.message);
  }
}
