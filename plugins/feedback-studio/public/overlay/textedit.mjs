// Feedback Studio — edit-in-place text (retype the element's copy on the page).
//
// The user edits the element's text directly (contenteditable, temporary),
// and Save records the exact {before, after} wording as `textEdit` — the
// agent applies the after-wording to source verbatim. Like Tweak previews,
// the on-page edit reverts when the composer closes.

import { MODE, addTeardown } from '/__feedback/overlay/state.mjs';
import { I, toastError } from '/__feedback/overlay/ui.mjs';
import { norm } from '/__feedback/overlay/dom.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

const PHRASING_RE = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;

export function setupTextEdit(box, opts, hooks) {
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
    <button type="button" class="kbf-editext-btn">${I.edit}<span class="kbf-editext-label">${t('Edit text on page')}</span></button>
    <button type="button" class="kbf-editext-undo" title="${t('Restore the original text')}" aria-label="${t('Restore the original text')}" hidden>${I.undo}</button>`;
  const ta = box.querySelector('.kbf-textarea');
  ta.parentElement.insertBefore(row, ta);

  const btn = row.querySelector('.kbf-editext-btn');
  const label = row.querySelector('.kbf-editext-label');
  const undoBtn = row.querySelector('.kbf-editext-undo');

  const changed = () => !!baseline && norm(el.textContent) !== baseline.text;
  function refreshRow() {
    row.classList.toggle('is-editing', editing);
    row.classList.toggle('is-changed', changed());
    label.textContent = editing ? t('Editing… Enter = done · Esc = cancel')
      : changed() ? '“' + norm(el.textContent).slice(0, 42) + (norm(el.textContent).length > 42 ? '…' : '') + '”'
      : t('Edit text on page');
    undoBtn.hidden = !changed();
    if (hooks.validate) hooks.validate();
  }
  function start() {
    if (editing) { finish(); return; }
    if (!getEl() || !el.isConnected) { toastError(t('The element changed — re-pin to edit its text.')); return; }
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
    label.textContent = t('Saved: “{text}” — click to redo', {
      text: opts.comment.textEdit.after.slice(0, 38) + (opts.comment.textEdit.after.length > 38 ? '…' : ''),
    });
  }

  addTeardown('textEdit', () => {
    el.removeAttribute('contenteditable');
    if (editing) el.style.cursor = prevCursor; // composer closed mid-edit
    el.removeEventListener('keydown', onKey, true);
    el.removeEventListener('input', onInput);
    el.removeEventListener('blur', onBlur);
    // Only undo what the USER previewed — never stomp content the host page
    // itself changed while the composer was open.
    if (baseline && el.innerHTML !== baseline.html) el.innerHTML = baseline.html;
  });

  return {
    start,
    dirty: () => dirtyTE,
    changed,
    getTextEdit: () => (changed() ? { before: baseline.text, after: norm(el.textContent) } : null),
  };
}
