// Feedback Studio — drag a pin onto another element to move the comment there.
//
// Mouse: press on the pin and move a few pixels. Touch: hold the pin for half
// a second, then move. While dragging, the element under the pointer is
// highlighted the same way Point mode shows its target; releasing over it
// runs the ordinary re-pin (a fresh anchor, PATCHed, with undo). Esc cancels.
// Only the host (full / admin) can move pins, like the re-pin button.

import { S, CAN_MANAGE } from '/__feedback/overlay/state.mjs';
import { host, showHighlightFor, hideHighlight, toast } from '/__feedback/overlay/ui.mjs';
import { repinTo } from '/__feedback/overlay/panel.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

const DRAG_START_PX = 6;     // movement before a press becomes a drag (mouse / pen)
const LONG_PRESS_MS = 450;   // hold time before a touch may drag

// The page element under a point, ignoring our own overlay.
function pageElementAt(x, y) {
  const list = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (const el of list) {
    if (!el || el === host || host.contains(el)) continue;
    if (el === document.documentElement || el === document.body) return null;
    if (el.closest && el.closest('[data-kbf-variant]')) continue;
    return el;
  }
  return null;
}

export function makePinDraggable(pin, comment) {
  if (!CAN_MANAGE) return;
  pin.title = (pin.title ? pin.title + ' ' : '') + '· ' + t('Drag the pin onto another element to move it');
  let press = null;     // { x, y, id, type, timer, armed }
  let dragging = false;
  let over = null;

  const cleanup = () => {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
    if (dragging) {
      dragging = false;
      pin.classList.remove('is-dragging');
      pin.style.transform = '';
      document.documentElement.style.cursor = '';
      hideHighlight();
      S.dragging = false;
    }
    over = null;
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const begin = () => {
    dragging = true;
    S.dragging = true;
    pin._kbfDragged = true; // the click that ends the drag must not open the card
    pin.classList.add('is-dragging');
    document.documentElement.style.cursor = 'grabbing';
    toast(t('Drop on the element this comment is about (Esc cancels)'), { duration: 4000 });
  };
  const onMove = (e) => {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragging) {
      if (press.type === 'touch' && !press.armed) { if (Math.hypot(dx, dy) > DRAG_START_PX) cleanup(); return; } // a scroll, not a hold
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      begin();
    }
    e.preventDefault();
    pin.style.transform = `translate(${dx}px, ${dy}px)`;
    const el = pageElementAt(e.clientX, e.clientY);
    if (el !== over) { over = el; if (el) showHighlightFor(el); else hideHighlight(); }
  };
  const onUp = async (e) => {
    const was = dragging;
    const target = was ? pageElementAt(e.clientX, e.clientY) : null;
    cleanup();
    if (!was) return;
    e.preventDefault();
    if (target instanceof Element) await repinTo(comment, target);
  };
  const onCancel = () => cleanup();
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(); } };

  pin.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (S.activeComposer || S.narrating) return;
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType || 'mouse', timer: 0, armed: false };
    if (press.type === 'touch') {
      press.timer = setTimeout(() => { if (press) { press.armed = true; begin(); } }, LONG_PRESS_MS);
    }
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onKey, true);
  });
}
