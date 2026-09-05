// Feedback Studio — element screenshots (pin-time visual ground truth).
//
// Captured AFTER save + preview-revert, so the image shows the page as the
// reviewer saw it (not our temporary tweaks). Entirely best-effort: the
// library is lazy-vendored by the server; any failure just means no shot.

import { ROOT } from '/__feedback/overlay/state.mjs';
import { resolveWithConfidence } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { cssColorToHex, isTranslucent } from '/__feedback/overlay/tweaks.mjs';

let _hti = null;
let _htiLoading = null;

function loadHti() {
  if (window.__kbfShots === false) return Promise.resolve(null); // --no-shots: don't even try
  if (_hti) return Promise.resolve(_hti);
  if (_htiLoading) return _htiLoading;
  _htiLoading = (async () => {
    // The package's ES build; its extensionless imports are completed by the server.
    try { _hti = await import(ROOT + '/vendor/html-to-image/es/index.js'); } catch (e) {}
    return _hti; // null = disabled/unavailable; we don't retry per save
  })();
  return _htiLoading;
}

function shotBackground() {
  for (const el of [document.body, document.documentElement]) {
    try {
      const bg = getComputedStyle(el).backgroundColor;
      if (cssColorToHex(bg) || isTranslucent(bg)) return bg;
    } catch (e) {}
  }
  return '#ffffff';
}

export async function captureShot(commentId, opts) {
  try {
    // Same confidence bar as Tweak Mode / edit-in-place: if the clicked node
    // is gone (SPA re-render between click and save), NEVER screenshot a
    // low-confidence guess — a wrong image sold as "visual ground truth" is
    // worse than none. getTargetEl covers element anchors; ranges re-resolve
    // their container here with the identical gate.
    let target = null;
    if (opts.getTargetEl) target = opts.getTargetEl();
    else if (opts.el && opts.el.isConnected) target = opts.el;
    else {
      const { el, confidence } = resolveWithConfidence(opts.anchor);
      if (el && confidence === 'high') target = el; // never screenshot a guessed element as "ground truth"
    }
    if (!target) return;
    const hti = await loadHti();
    if (!hti || !hti.toPng) return;
    // tiny targets (an icon, a short link) get their parent for visual context
    let node = target;
    const tr = target.getBoundingClientRect();
    if ((tr.width < 48 || tr.height < 24) && target.parentElement && target.parentElement !== document.body) {
      node = target.parentElement;
    }
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height || r.width * r.height > 4_000_000) return; // nothing, or absurdly large
    const dataUrl = await hti.toPng(node, {
      pixelRatio: Math.min(1.5, Math.max(0.4, 1000 / r.width)), // ~1000px wide max
      backgroundColor: shotBackground(),
    });
    if (!dataUrl || dataUrl.length > 780000) return; // keep under the server's cap
    // `after: true` stores the picture as the "after" half of a before/after pair.
    await api('/shot/' + commentId + (opts.after ? '?after=1' : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }),
    });
  } catch (e) { /* best-effort by design */ }
}
