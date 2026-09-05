// Feedback Studio — the pins drawn over the page, and the shared "re-measure
// everything" scheduler.

import { S, pageComments, filtered, agentRepliedAfter, editsSummary } from '/__feedback/overlay/state.mjs';
import { I, pinsLayer } from '/__feedback/overlay/ui.mjs';
import { makePool, resolveWithConfidence, norm } from '/__feedback/overlay/dom.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';
import { makePinDraggable } from '/__feedback/overlay/drag.mjs';

export function renderPins() {
  pinsLayer.innerHTML = '';
  S.placed = [];
  const list = pageComments();
  const pool = makePool();
  S.pinConf.clear();
  list.forEach((c, idx) => {
    const { el, confidence } = resolveWithConfidence(c.anchor, pool);
    S.pinConf.set(c.id, el ? confidence : 'lost');
    if (!el) return;
    // The List filter (All / Open / Resolved) applies to the pins as well, so
    // "Open" clears a page full of green resolved pins. Numbering comes from
    // idx over the unfiltered page list, so the visible pins keep their numbers.
    if (!filtered([c]).length) return;
    // Same rule as the List cards: only comments still awaiting action warn.
    // A resolved comment's text USUALLY changed — that is the fix having
    // landed — so its pin stays green, never amber.
    const awaiting = c.status !== 'resolved' && c.status !== 'rejected';
    // The agent replied after the comment was made and the quoted text no
    // longer matches, but the element is still found by position: that is the
    // agent's own edit sitting where the pin is, not a pin that drifted. Draw
    // it as a normal pin; the card says "changed after reply" so the reviewer
    // can resolve it. (The agent still re-locates from the snippet before it
    // edits anything, so this never loosens the refuse-to-guess rule.)
    const changedAfterReply = awaiting && confidence !== 'high' && agentRepliedAfter(c);
    const shaky = awaiting && !changedAfterReply && (confidence === 'medium' || confidence === 'low');
    const pin = document.createElement('div');
    pin.className = 'kbf-pin'
      + (c.author === 'agent' ? ' is-agent' : '')
      + (c.status === 'resolved' ? ' is-resolved' : '')
      + (c.status === 'approved' ? ' is-approved' : '')
      + (c.status === 'rejected' ? ' is-rejected' : '')
      + (shaky ? ' is-shaky' : '')
      + (S.agent.state === 'working' && S.agent.commentId === c.id ? ' is-working' : '')
      + (S.agent.queue.includes(c.id) && S.agent.commentId !== c.id ? ' is-queued' : '')
      + (c.id === S.cursorId ? ' is-cursor' : '');
    pin.innerHTML = c.author === 'agent' ? I.bot : String(idx + 1);
    const gist = c.text || (c.textEdit && c.textEdit.after ? '“' + c.textEdit.after + '”' : editsSummary(c));
    pin.title = (changedAfterReply ? t('[text changed after the agent replied — resolve it in the List if the change is what you asked for] ') : shaky ? t('[pin may be off — re-pin from the List] ') : '') + (c.author === 'agent' ? t('[agent] ') : '') + gist;
    pin.setAttribute('role', 'button');
    pin.tabIndex = 0;
    // Hidden until positionPins() gives it real coordinates — a fixed-position
    // pin with no left/top paints at the top-left corner otherwise (the flash
    // seen when clicking through pages before the anchor is measured).
    pin.style.display = 'none';
    pin.setAttribute('aria-label', (c.author === 'agent' ? t('Agent comment: ') : t('Comment: ')) + norm(gist).slice(0, 80));
    // A click focuses the card; a drag (see drag.mjs) moves the pin instead and
    // marks the pin so the click that ends the drag is ignored.
    const activate = () => { if (pin._kbfDragged) { pin._kbfDragged = false; return; } emit('comment:focus', c.id); };
    makePinDraggable(pin, c);
    pin.addEventListener('click', activate);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    pinsLayer.appendChild(pin);
    S.placed.push({ comment: c, el, pinEl: pin });
  });
  positionPins();
  // A newly-navigated page may still be laying out (images/fonts/SPA DOM) when
  // this first pass runs, so some anchors measure 0×0 and stay hidden above.
  // Re-measure on the next frame to reveal them without waiting for a scroll.
  requestAnimationFrame(positionPins);
}

const PIN_OUTSIDE_TAGS = new Set(['TD', 'TH', 'LI']);

export function positionPins() {
  for (const p of S.placed) {
    const r = p.el.getBoundingClientRect();
    // No box yet (not laid out / display:none ancestor) — keep it hidden rather
    // than parking it at 0,0. A later pass reveals it once it has a real rect.
    if (!r.width && !r.height) { p.pinEl.style.display = 'none'; continue; }
    // The pin is centred on the element's top-left corner, tail pointing
    // down-left. On a table cell or a list item that puts it on top of the
    // very text it marks (and half over the column to the left). For those,
    // hang it just OUTSIDE the corner instead, flipped so the tail points
    // down-right into the cell — nothing covered, no doubt which cell.
    const outside = PIN_OUTSIDE_TAGS.has(p.el.tagName) || r.width < 160;
    p.pinEl.classList.toggle('is-outside', outside);
    // 7px out: the pin straddles the corner where all four boxes have only
    // padding, so it covers neither this cell's text nor a neighbour's.
    p.pinEl.style.left = (r.left - (outside ? 7 : 0)) + 'px';
    p.pinEl.style.top = (r.top - (outside ? 7 : 0)) + 'px';
    const off = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
    p.pinEl.style.display = off ? 'none' : 'flex';
  }
}

// One rAF-batched re-measure of everything that floats over the page. The pins
// are done here; the composer's target boxes, the hover highlight / touch
// picker and the variant switcher listen for 'reposition' (boot.mjs registers
// them in the order this function used to call them in).
export function schedulePos() {
  if (S.rafPos) return;
  S.rafPos = requestAnimationFrame(() => {
    S.rafPos = 0;
    positionPins();
    emit('reposition');
  });
}

export function initPins() {
  window.addEventListener('scroll', schedulePos, true);
  window.addEventListener('resize', schedulePos);
}
