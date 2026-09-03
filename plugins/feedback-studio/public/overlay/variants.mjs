// Feedback Studio — variant preview (agent-proposed alternatives, tried ON the page).
//
// An agent reply can carry 2–4 `variants` (sanitized server-side at write
// time). "Preview on the page" hides the pinned element and shows each
// candidate in its place via an overlay-owned container; a floating switcher
// flips Original/A/B/C, and "Use this" records the pick on the thread. Like
// every preview here, it is temporary — the page reverts on close, the agent
// implements the picked variant in source.

import { S, ROLE, LS, CAN_MANAGE, addTeardown, removeTeardown } from '/__feedback/overlay/state.mjs';
import { I, root, escapeHtml, revealEl, panelIsFullScreen, toast, toastError } from '/__feedback/overlay/ui.mjs';
import { resolveWithConfidence } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { schedulePos } from '/__feedback/overlay/pins.mjs';
import { closeComposer } from '/__feedback/overlay/composer.mjs';
import { refresh, setPanel } from '/__feedback/overlay/panel.mjs';

// Second, AUTHORITATIVE sanitation layer, run immediately before injection.
// The server sanitizes at write time with regexes, but regexes over raw
// markup cannot fully reason about HTML entity encoding — this pass parses
// the fragment into an inert <template> (no script execution, no resource
// loads) where the browser has ALREADY decoded entities, then walks the real
// tree: executable elements out, on* handlers out, script-ish URLs (decoded!)
// neutralised, external url() beacons stripped from inline styles.
const SCRUB_BAD_TAG = /^(script|style|iframe|object|embed|base|meta|form|link|frame|frameset|title)$/i;
const SCRUB_URL_ATTRS = ['href', 'src', 'xlink:href', 'formaction', 'action'];
// Safe to EAGER-LOAD only if fragment, relative/same-origin, or inline
// data:image. An absolute cross-origin resource is a network beacon that fires
// the instant a variant is previewed (leaking viewer IP/referrer, worse over
// share links). Navigational href on <a> loads on click, not preview, so it's
// left alone — only resource attributes are gated.
function sameOriginOrData(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s || s[0] === '#') return true;
  if (/^data:image\//i.test(s)) return true;
  try { return new URL(s, location.href).origin === location.origin; } catch (e) { return false; }
}
function scrubVariantHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  for (const el of [...tpl.content.querySelectorAll('*')]) {
    if (SCRUB_BAD_TAG.test(el.tagName)) { el.remove(); continue; }
    const tag = el.tagName.toLowerCase();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') { el.removeAttribute(attr.name); continue; }
      if (SCRUB_URL_ATTRS.includes(name)) {
        const v = String(attr.value).replace(/[\u0000-\u0020\u00a0]+/g, '').toLowerCase();
        if (/^(javascript|vbscript|data:text\/html)/.test(v)) { el.setAttribute(attr.name, '#'); continue; }
      }
      // eager-loading resource attributes: drop external ones (beacons)
      const isEager = name === 'src' || name === 'poster'
        || ((name === 'href' || name === 'xlink:href') && (tag === 'image' || tag === 'use'));
      if (isEager && !sameOriginOrData(attr.value)) { el.removeAttribute(attr.name); continue; }
      if (name === 'srcset') {
        const kept = String(attr.value).split(',').map((s) => s.trim()).filter(Boolean)
          .filter((cand) => sameOriginOrData(cand.split(/\s+/)[0]));
        if (kept.length) el.setAttribute('srcset', kept.join(', ')); else el.removeAttribute('srcset');
        continue;
      }
      if (name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(attr.value)) {
        el.setAttribute('style', String(attr.value)
          .replace(/url\s*\(\s*(['"]?)\s*(?!#|data:image\/)[^)]*\)/gi, 'none')
          .replace(/@import/gi, '')
          .replace(/expression\s*\(/gi, 'none('));
      }
    }
  }
  return tpl.innerHTML;
}

export function closeVariantPreview() {
  const v = S.variantPreview;
  if (!v) return;
  removeTeardown('variant');
  S.variantPreview = null;
  try { v.container.remove(); } catch (e) {}
  try { v.el.style.display = v.prevDisplay; } catch (e) {}
  try { v.bar.remove(); } catch (e) {}
  schedulePos();
}

function positionVariantBar() {
  const v = S.variantPreview;
  if (!v) return;
  const target = v.index < 0 ? v.el : v.container;
  const r = target.getBoundingClientRect();
  const bw = v.bar.offsetWidth || 280, bh = v.bar.offsetHeight || 44;
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = r.top - bh - 10;
  if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - bh - 8);
  v.bar.style.left = left + 'px';
  v.bar.style.top = top + 'px';
  v.bar.style.visibility = 'visible'; // revealed only once it has coordinates
}

// What the variant switcher contributes to a scheduled re-measure.
export function repositionVariantBar() {
  if (S.variantPreview) positionVariantBar();
}

function showVariant(index) {
  const v = S.variantPreview;
  if (!v) return;
  v.index = index;
  if (index < 0) { // original
    v.container.style.display = 'none';
    v.el.style.display = v.prevDisplay;
  } else {
    v.el.style.display = 'none';
    v.container.style.display = '';
    // parser-based scrub right before injection (see scrubVariantHtml) — the
    // write-time sanitizer is only the first of two independent layers
    if (!v.scrubbed[index]) v.scrubbed[index] = scrubVariantHtml(v.reply.variants[index].html);
    v.container.innerHTML = v.scrubbed[index];
  }
  v.bar.querySelectorAll('.kbf-vchip').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === index));
  const use = v.bar.querySelector('.kbf-vuse');
  use.disabled = index < 0;
  const note = v.bar.querySelector('.kbf-vnote');
  note.textContent = index < 0 ? 'Original' : (v.reply.variants[index].note || v.reply.variants[index].label);
  requestAnimationFrame(positionVariantBar);
}

async function pickVariant() {
  const v = S.variantPreview;
  if (!v || v.index < 0) return;
  const chosen = v.reply.variants[v.index];
  try {
    const data = await api('/comments/' + v.comment.id + '/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'user',
        authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '',
        text: 'Picked: ' + chosen.label + (chosen.note ? ' — ' + chosen.note : ''),
        pick: { of: v.reply.id, index: v.index, label: chosen.label },
      }),
    });
    const i = S.comments.findIndex((c) => c.id === v.comment.id);
    if (i >= 0) S.comments[i] = data.comment;
    if (CAN_MANAGE) {
      try {
        const d2 = await api('/comments/' + v.comment.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }),
        });
        if (i >= 0) S.comments[i] = d2.comment;
      } catch (e) {}
    }
    closeVariantPreview();
    refresh();
    toast('Choice recorded — your agent implements “' + chosen.label + '”');
  } catch (e) {
    toastError('Could not record the pick — ' + e.message);
  }
}

export function openVariantPreview(comment, reply) {
  closeVariantPreview();
  closeComposer();
  // Same confidence bar as every other on-page action: swapping markup on a
  // GUESSED element would preview the wrong thing entirely. High only — a
  // 'medium' (buried-text) match is not trustworthy enough to replace.
  const { el, confidence } = resolveWithConfidence(comment.anchor);
  if (!el || confidence !== 'high') {
    toastError("Couldn't confidently locate this element — re-pin the comment first.");
    return;
  }
  if (panelIsFullScreen()) setPanel(false); // the page must be visible to compare
  const container = document.createElement('div');
  container.setAttribute('data-kbf-variant', '1');
  // In an explicitly-placed grid (grid-area/column/row on the original), a bare
  // sibling would auto-flow into the wrong cell — carry the placement over.
  // `order` keeps flex position honest too.
  try {
    const cs = getComputedStyle(el);
    for (const p of ['grid-area', 'grid-column', 'grid-row', 'justify-self', 'align-self', 'order']) {
      const val = cs.getPropertyValue(p);
      if (val && val !== 'auto' && val !== 'auto / auto / auto / auto' && val !== '0') container.style.setProperty(p, val);
    }
  } catch (e) {}
  el.parentNode.insertBefore(container, el.nextSibling);

  const bar = document.createElement('div');
  bar.className = 'kbf-vbar';
  bar.style.visibility = 'hidden'; // no top-left flash before positionVariantBar runs
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Try the proposed options');
  bar.innerHTML = `
    <button type="button" class="kbf-vchip is-active" data-v="-1">Original</button>
    ${reply.variants.map((vv, i) => `<button type="button" class="kbf-vchip" data-v="${i}" title="${escapeHtml(vv.note || '')}">${escapeHtml(vv.label)}</button>`).join('')}
    <span class="kbf-vnote">Original</span>
    <button type="button" class="kbf-vuse" disabled>${I.check} Use this</button>
    <button type="button" class="kbf-vx" title="Close (Esc)" aria-label="Close variant preview">${I.close}</button>`;
  root.appendChild(bar);
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.kbf-vchip');
    if (chip) { showVariant(Number(chip.dataset.v)); return; }
    if (e.target.closest('.kbf-vuse')) { pickVariant(); return; }
    if (e.target.closest('.kbf-vx')) closeVariantPreview();
  });

  S.variantPreview = { comment, reply, el, prevDisplay: el.style.display, container, bar, index: -1, scrubbed: [] };
  // Closing the composer must also drop a preview left standing.
  addTeardown('variant', closeVariantPreview);
  revealEl(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showVariant(-1);
  setTimeout(positionVariantBar, 300); // after the scroll settles
}
