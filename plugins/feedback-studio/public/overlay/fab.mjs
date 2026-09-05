// Feedback Studio — the floating button cluster: drag it to any corner
// (persisted; works on mouse, touch and pen).
//
// A plain click still toggles comment mode / the panel; only a real drag moves the
// cluster, then it snaps to the nearest corner.

import { S, LS } from '/__feedback/overlay/state.mjs';
import { root, toast } from '/__feedback/overlay/ui.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

// How far the pointer must travel before a press becomes a drag. Separates tap
// from drag on touch, and click from drag on desktop — the same idea as the
// element-pick threshold in mode.mjs, but tighter: the FAB is a small target.
const FAB_DRAG_SLOP = 8;

const FAB_CORNERS = ['br', 'bl', 'tr', 'tl'];
// Literal-per-case (not a plain lookup table) so each Dutch string stays a
// static, greppable translation call.
function cornerLabel(c) {
  switch (c) {
    case 'br': return t('bottom-right');
    case 'bl': return t('bottom-left');
    case 'tr': return t('top-right');
    case 'tl': return t('top-left');
    default: return c;
  }
}

export function initFab() {
  const fabWrap = root.querySelector('.kbf-fab-wrap');
  function applyFabCorner(corner) {
    const c = FAB_CORNERS.includes(corner) ? corner : 'br';
    FAB_CORNERS.forEach((k) => fabWrap.classList.toggle('kbf-fab-wrap--' + k, k === c));
  }
  applyFabCorner(LS.get('kbf-fab-corner') || 'br');

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
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > FAB_DRAG_SLOP) {
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
      toast(t('Buttons moved to {corner}', { corner: cornerLabel(corner) }));
      S.justDraggedFab = true; // swallow the click that fires right after this pointerup
      setTimeout(() => { S.justDraggedFab = false; }, 0);
    }
    start = grab = null; dragging = false;
  }
  fabWrap.addEventListener('pointerup', endDrag);
  fabWrap.addEventListener('pointercancel', endDrag);
}
