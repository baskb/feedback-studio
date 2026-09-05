// Feedback Studio — keyboard navigation over the pins, and the shortcut sheet.
//
// j / k move a highlight from pin to pin in page order, Enter opens that
// comment's thread in the List, r puts the caret in its reply box, x resolves
// it, / focuses the search box, l shows or hides the List, Ctrl+Z undoes the
// last change, ? shows this sheet. None of it fires while typing in a text
// field, and none of it uses Ctrl/Alt/Cmd (except Ctrl+Z), so the page's own
// shortcuts are left alone. P and T (Point, Talk) and Esc live in boot.mjs.

import { S, CAN_MANAGE } from '/__feedback/overlay/state.mjs';
import { $, root, helpEl, revealEl, flashEl, toast } from '/__feedback/overlay/ui.mjs';
import { setPanel, openThread, toggleResolve } from '/__feedback/overlay/panel.mjs';
import { undo } from '/__feedback/overlay/undo.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

// The pins on this page, top to bottom (then left to right).
function orderedPins() {
  return S.placed.slice().sort((a, b) => {
    const ra = a.el.getBoundingClientRect();
    const rb = b.el.getBoundingClientRect();
    return (ra.top + window.scrollY) - (rb.top + window.scrollY) || ra.left - rb.left;
  });
}

function setCursor(id) {
  S.cursorId = id;
  root.querySelectorAll('.kbf-pin').forEach((p) => p.classList.remove('is-cursor'));
  root.querySelectorAll('.kbf-card').forEach((c) => c.classList.toggle('is-cursor', c.dataset.id === id));
  const p = S.placed.find((x) => x.comment.id === id);
  if (!p) return;
  p.pinEl.classList.add('is-cursor');
  revealEl(p.el);
  p.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashEl(p.el);
  const card = root.querySelector('.kbf-card[data-id="' + id + '"]');
  if (card) card.scrollIntoView({ block: 'nearest' });
}

function move(step) {
  const pins = orderedPins();
  if (!pins.length) { toast(t('No pins on this page to move between.'), { duration: 1500 }); return; }
  let i = pins.findIndex((p) => p.comment.id === S.cursorId);
  if (i < 0) i = step > 0 ? -1 : pins.length;
  i = (i + step + pins.length) % pins.length;
  setCursor(pins[i].comment.id);
}

const cursorComment = () => S.comments.find((c) => c.id === S.cursorId) || null;

// ---------- the shortcut sheet ----------
const ROWS = () => [
  ['j', t('Next pin')], ['k', t('Previous pin')],
  ['Enter', t('Open the highlighted comment')], ['r', t('Reply to the highlighted comment')],
  ...(CAN_MANAGE ? [['x', t('Resolve the highlighted comment')]] : []),
  ['/', t('Search the List')], ['l', t('Show or hide the List')],
  ['p', t('Point mode on / off')], ['t', t('Talk: narrate the page')],
  ['Ctrl+Z', t('Undo the last change')], ['Esc', t('Close what is open')], ['?', t('This help')],
];
export function toggleHelp(force) {
  const show = force != null ? force : helpEl.hidden;
  if (!show) { helpEl.hidden = true; helpEl.innerHTML = ''; return; }
  helpEl.innerHTML = `<div class="kbf-help-box">
    <div class="kbf-help-head"><strong>${t('Keyboard shortcuts')}</strong><button type="button" class="kbf-x" data-act="close" aria-label="${t('Close')}">×</button></div>
    <dl class="kbf-help-list">${ROWS().map(([k, d]) => `<div><dt><kbd>${k}</kbd></dt><dd>${d}</dd></div>`).join('')}</dl>
    <p class="kbf-help-note">${t('Never while typing in a text field.')}</p>
  </div>`;
  helpEl.hidden = false;
  const btn = helpEl.querySelector('[data-act="close"]');
  if (btn) { btn.addEventListener('click', () => toggleHelp(false)); btn.focus(); }
}

export function initKeys() {
  helpEl.addEventListener('click', (e) => { if (e.target === helpEl) toggleHelp(false); });
  document.addEventListener('keydown', (e) => {
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    const typing = target && (/^(input|textarea|select)$/i.test(target.nodeName) || target.isContentEditable);
    // Ctrl+Z / Cmd+Z: undo — even from inside our own List, but never while a
    // text field is being edited (that is the field's own undo).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (typing) return;
      e.preventDefault();
      undo();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') return; // boot.mjs owns Escape (it closes the sheet first)
    // Anything below is a bare key on the page or in our own UI, not a
    // shortcut while the composer or the narration bar is open.
    if (S.activeComposer || S.narrating || S.draftTray || S.walkState) return;
    switch (e.key) {
      case 'j': e.preventDefault(); move(1); break;
      case 'k': e.preventDefault(); move(-1); break;
      case 'Enter': {
        const c = cursorComment();
        // Only when nothing else owns Enter: a page button or link, or one of
        // ours, keeps its own behaviour.
        if (c && (target === document || target === document.body || target === document.documentElement)) { e.preventDefault(); openThread(c.id, false); }
        break;
      }
      case 'r': { const c = cursorComment(); if (c) { e.preventDefault(); openThread(c.id, true); } break; }
      case 'x': { const c = cursorComment(); if (c && CAN_MANAGE) { e.preventDefault(); toggleResolve(c); } break; }
      case '/': {
        e.preventDefault();
        if (!S.panelOpen) setPanel(true);
        const q = $('kbf-search');
        if (q) { q.focus(); q.select(); }
        break;
      }
      case 'l': case 'L': e.preventDefault(); setPanel(!S.panelOpen); break;
      case '?': e.preventDefault(); toggleHelp(); break;
      default: break;
    }
  });
  const help = $('kbf-help-btn');
  if (help) help.addEventListener('click', () => toggleHelp());
}
