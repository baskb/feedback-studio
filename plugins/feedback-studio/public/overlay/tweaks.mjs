// Feedback Studio — Tweak Mode: live style knobs on the picked element.
//
// Lets the user *show* a style change instead of describing it: steppers and
// pickers preview live via ONE overlay-owned <style> tag in the host document
// (plus a marker attribute on the element), and Save records exact
// {prop, from, to} deltas on the comment for the agent to apply to source.
// The preview is temporary by design: everything reverts the moment the
// composer closes — the page itself is never durably altered.

import { TWEAKABLE_PROPS } from '/__feedback/lib/schema.mjs';
import { S, placeholderFor } from '/__feedback/overlay/state.mjs';
import { I } from '/__feedback/overlay/ui.mjs';
import { norm, resolveWithConfidence } from '/__feedback/overlay/dom.mjs';
import { schedulePos } from '/__feedback/overlay/pins.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

// Translate a TWEAK_CONTROLS label. Kept as a literal-per-case switch (rather
// than t(ctl.label)) so every Dutch string stays a static, greppable translation call.
function tLabel(en) {
  switch (en) {
    case 'Text size': return t('Text size');
    case 'Weight': return t('Weight');
    case 'Align': return t('Align');
    case 'Text color': return t('Text color');
    case 'Line height': return t('Line height');
    case 'Background color': return t('Background color');
    case 'Padding': return t('Padding');
    case 'Margin': return t('Margin');
    case 'Corners': return t('Corners');
    case 'Gap': return t('Gap');
    case 'Opacity': return t('Opacity');
    default: return en;
  }
}
const ALIGN_LABEL = { left: () => t('Align left'), center: () => t('Align center'), right: () => t('Align right') };

export const TWEAK_ATTR = 'data-kbf-tweak';
export const TWEAK_STYLE_ID = 'kbf-tweak-style';

// The knobs exposed here are a subset of TWEAKABLE_PROPS (the shared schema,
// imported above): the server accepts the wider list so an agent can author
// edits the overlay has no control for. Filtering against it means a property
// dropped from the whitelist can never stay a live knob.
// `when(info)` gates each knob on RELEVANCE for the picked element — a knob
// that can't visibly do anything (text size on an image, gap on a non-flex
// box) is hidden, not disabled: fewer rows, zero dead controls.
const TWEAK_CONTROLS = [
  { prop: 'font-size', label: 'Text size', kind: 'px', min: 6, max: 300, when: (i) => i.hasText },
  { prop: 'font-weight', label: 'Weight', kind: 'weight', when: (i) => i.hasText },
  { prop: 'text-align', label: 'Align', kind: 'align', when: (i) => i.hasText && !i.inline },
  { prop: 'color', label: 'Text color', kind: 'color', when: (i) => i.hasText },
  { prop: 'line-height', label: 'Line height', kind: 'px', min: 8, max: 400, when: (i) => i.hasText },
  { prop: 'background-color', label: 'Background color', kind: 'color' },
  { prop: 'padding', label: 'Padding', kind: 'px4', min: 0, max: 400 },
  { prop: 'margin', label: 'Margin', kind: 'px4', min: -200, max: 400 },
  // corners only make sense once there's something to round (bg / border /
  // replaced element) — but setting a Background color reveals this row live
  { prop: 'border-radius', label: 'Corners', kind: 'px4', min: 0, max: 300, when: (i) => i.hasBox },
  { prop: 'gap', label: 'Gap', kind: 'px', min: 0, max: 200, when: (i) => i.isFlexGrid },
  { prop: 'opacity', label: 'Opacity', kind: 'pct', min: 0, max: 100, step: 5 },
].filter((c) => TWEAKABLE_PROPS.includes(c.prop));

// Relevance facts about the picked element, computed once per composer.
function tweakInfo(el, cs) {
  const disp = cs.display;
  const replaced = /^(img|video|canvas|svg|picture|iframe|input|textarea|select|button)$/i.test(el.nodeName);
  const bg = cs.backgroundColor;
  return {
    hasText: !!norm(el.textContent) || /^(input|textarea|select|button)$/i.test(el.nodeName),
    inline: disp === 'inline',
    isFlexGrid: /(flex|grid)/.test(disp) && el.children.length > 1,
    hasBox: replaced || !!cssColorToHex(bg) || isTranslucent(bg) || parseFloat(cs.borderTopWidth) > 0,
  };
}

export function clearTweakPreview() {
  const s = document.getElementById(TWEAK_STYLE_ID);
  if (s) s.remove();
  try { document.querySelectorAll('[' + TWEAK_ATTR + ']').forEach((el) => el.removeAttribute(TWEAK_ATTR)); } catch (e) {}
}

// rgb()/rgba() → #rrggbb (color inputs only speak hex). '' = not representable
// as opaque hex: transparent, semi-transparent (alpha must not be silently
// flattened away — the raw rgba() is kept as the recorded value), or unknown.
export function cssColorToHex(v) {
  v = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(v);
  if (!m || (m[4] !== undefined && parseFloat(m[4]) < 1)) return '';
  const h = (n) => (+n < 256 ? +n : 255).toString(16).padStart(2, '0');
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}
// alpha strictly between 0 and 1 → a real translucent color (not just "none")
export function isTranslucent(v) {
  const m = /^rgba?\([^)]*,\s*([\d.]+)\s*\)$/.exec(String(v || '').trim());
  if (!m) return false;
  const a = parseFloat(m[1]);
  return a > 0 && a < 1;
}
const fmtPx = (n) => (Math.round(n * 10) / 10) + 'px';
// 4 side/corner values → the shortest CSS shorthand ("16px", "16px 24px", …).
function shorthand4(top, r, b, l) {
  if (top === r && r === b && b === l) return top;
  if (top === b && r === l) return top + ' ' + r;
  if (r === l) return top + ' ' + r + ' ' + b;
  return top + ' ' + r + ' ' + b + ' ' + l;
}

// Read the element's current computed values for every knob (the "from" side).
function readTweakState(el) {
  const cs = getComputedStyle(el);
  const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
  const state = {};
  for (const ctl of TWEAK_CONTROLS) {
    if (ctl.kind === 'px') {
      const raw = cs.getPropertyValue(ctl.prop).trim();
      let n = parseFloat(raw);
      if (isNaN(n)) {
        // line-height "normal" (and friends): show the effective px, but the
        // recorded "from" stays the honest keyword.
        n = ctl.prop === 'line-height' ? (px('font-size') || 16) * 1.2 : 0;
        state[ctl.prop] = { num: Math.round(n * 10) / 10, css: raw || 'normal', mixed: false };
      } else {
        state[ctl.prop] = { num: Math.round(n * 10) / 10, css: fmtPx(n), mixed: false };
      }
    } else if (ctl.kind === 'pct') {
      const v = parseFloat(cs.getPropertyValue(ctl.prop));
      const n = isNaN(v) ? 1 : v;
      state[ctl.prop] = { num: Math.round(n * 100), css: String(n), mixed: false };
    } else if (ctl.kind === 'align') {
      const raw = cs.getPropertyValue('text-align').trim();
      const phys = { start: 'left', end: 'right', '-webkit-left': 'left', '-webkit-right': 'right', '-webkit-center': 'center' }[raw] || raw;
      state[ctl.prop] = { val: ['left', 'center', 'right'].includes(phys) ? phys : '', css: raw, mixed: false };
    } else if (ctl.kind === 'weight') {
      const w = parseInt(cs.getPropertyValue('font-weight'), 10) || 400;
      state[ctl.prop] = { num: w, css: String(w), mixed: false };
    } else if (ctl.kind === 'color') {
      const raw = cs.getPropertyValue(ctl.prop).trim();
      const hex = cssColorToHex(raw);
      const translucent = !hex && isTranslucent(raw);
      // A translucent "from" is recorded as the honest rgba(), never a flattened hex.
      state[ctl.prop] = { hex, css: hex || (translucent ? raw : 'transparent'), raw, translucent, mixed: false };
    } else if (ctl.kind === 'px4') {
      const sides = ctl.prop === 'border-radius'
        ? ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']
        : [ctl.prop + '-top', ctl.prop + '-right', ctl.prop + '-bottom', ctl.prop + '-left'];
      const v = sides.map((s) => px(s));
      state[ctl.prop] = {
        num: Math.round(v[0] * 10) / 10,
        css: shorthand4(fmtPx(v[0]), fmtPx(v[1]), fmtPx(v[2]), fmtPx(v[3])),
        mixed: !(v[0] === v[1] && v[1] === v[2] && v[2] === v[3]),
      };
    }
  }
  return state;
}

// A direct fresh pick (kind 'new') is ground truth. ANY element that came from
// re-resolving a stored anchor — including the one editFromCard hands in via
// opts.el when reopening an existing comment — must clear the confidence bar
// before we read values off it (Tweak knobs, edit-in-place text): capturing
// authoritative before/after data off a low-confidence GUESSED element would
// hand the agent exactly the "confident wrong edit" the invariant forbids.
// One shared, per-composer cache: verified once, trusted for the session.
export function makeTrustedGetEl(opts) {
  let trusted = opts.kind !== 'edit';
  return () => {
    if (trusted && opts.el && opts.el.isConnected) return opts.el;
    const { el, confidence } = resolveWithConfidence(opts.anchor);
    // Only a HIGH-confidence re-resolve is trusted for recording source-changing
    // data — 'medium' means the snippet is present but not a clean match (a
    // possibly over-broad/wrong element), which is a re-pin, not a guess.
    if (!el || confidence !== 'high') return null;
    trusted = true;
    opts.el = el;
    return el;
  };
}

// Build the collapsible "Tweak style" section inside the composer. Returns
// { getEdits, count } or null when there is no live element to preview on.
export function setupTweaks(box, opts, hooks) {
  const getEl = opts.getTargetEl;
  const el = getEl();
  if (!el) return null;

  const base = readTweakState(el); // "from" values, captured once at open
  const tweaks = new Map();        // prop -> to (css string)
  const touched = new Set();       // props the USER changed this session (not primed)
  let dirty = false;               // any user touch at all?
  let priming = false;             // true while prefilling stored edits (not a user touch)

  const info = tweakInfo(el, getComputedStyle(el));
  const wrap = document.createElement('div');
  wrap.className = 'kbf-tweak';
  wrap.innerHTML = `
    <button type="button" class="kbf-tweak-toggle" aria-expanded="false">
      ${I.sliders}<span class="kbf-tweak-title">${t('Tweak style')}</span>
      <span class="kbf-tweak-count" hidden></span>
      <span class="kbf-tweak-chev">${I.down}</span>
    </button>
    <div class="kbf-tweak-body">
      <div class="kbf-tweak-rows">
      ${TWEAK_CONTROLS.map((ctl) => {
        const st = base[ctl.prop];
        const off = ctl.when && !ctl.when(info);
        const label = tLabel(ctl.label);
        let control = '';
        if (ctl.kind === 'px' || ctl.kind === 'px4' || ctl.kind === 'pct') {
          const unit = ctl.kind === 'pct' ? '%' : 'px';
          control = `
            <span class="kbf-tweak-num">
              <button type="button" class="kbf-tweak-step" data-step="-1" title="${t('Decrease (Shift: ±10)')}" aria-label="${t('Decrease {label}', { label })}">−</button>
              <input class="kbf-tweak-input" type="number" step="1" value="${st.num}" aria-label="${unit === '%' ? t('{label} in percent', { label }) : t('{label} in pixels', { label })}">
              <span class="kbf-tweak-unit">${unit}</span>
              <button type="button" class="kbf-tweak-step" data-step="1" title="${t('Increase (Shift: ±10)')}" aria-label="${t('Increase {label}', { label })}">+</button>
            </span>`;
        } else if (ctl.kind === 'weight') {
          const ws = [100, 200, 300, 400, 500, 600, 700, 800, 900];
          if (!ws.includes(st.num)) { ws.push(st.num); ws.sort((a, b) => a - b); }
          control = `<select class="kbf-tweak-select" aria-label="${label}">${ws.map((w) => `<option value="${w}"${w === st.num ? ' selected' : ''}>${w}</option>`).join('')}</select>`;
        } else if (ctl.kind === 'align') {
          control = `
            <span class="kbf-tweak-alignseg" role="group" aria-label="${label}">
              ${['left', 'center', 'right'].map((a) => `<button type="button" class="kbf-tweak-alignbtn${st.val === a ? ' is-active' : ''}" data-align="${a}" title="${ALIGN_LABEL[a]()}" aria-label="${ALIGN_LABEL[a]()}">${I['align' + a[0].toUpperCase()]}</button>`).join('')}
            </span>`;
        } else if (ctl.kind === 'color') {
          const bg = st.hex || (st.translucent ? st.raw : '');
          control = `
            <span class="kbf-tweak-colorwrap${bg ? '' : ' is-none'}" title="${label}${st.translucent ? ': ' + st.raw : ''}">
              <span class="kbf-tweak-swatch"${bg ? ` style="background:${bg}"` : ''}></span>
              <span class="kbf-tweak-hex">${st.hex || (st.translucent ? t('alpha') : t('none'))}</span>
              <input class="kbf-tweak-color" type="color" value="${st.hex || '#888888'}" aria-label="${label}">
            </span>`;
        }
        return `
          <div class="kbf-tweak-row${off ? ' kbf-tweak-row--off' : ''}" data-prop="${ctl.prop}" data-kind="${ctl.kind}"${st.mixed ? ` title="${t('Sides differ ({css}) — changing sets all sides', { css: st.css })}"` : ''}>
            <span class="kbf-tweak-label">${label}${st.mixed ? ' <em class="kbf-tweak-mixed">' + t('mixed') + '</em>' : ''}</span>
            ${control}
            <button type="button" class="kbf-tweak-undo" title="${t('Reset {label}', { label })}" aria-label="${t('Reset {label}', { label })}">${I.undo}</button>
          </div>`;
      }).join('')}
        <div class="kbf-tweak-foot">
          <button type="button" class="kbf-tweak-resetall" hidden>${t('Reset all')}</button>
        </div>
      </div>
    </div>`;
  const ta = box.querySelector('.kbf-textarea');
  ta.parentElement.insertBefore(wrap, ta);

  const toggle = wrap.querySelector('.kbf-tweak-toggle');
  const countBadge = wrap.querySelector('.kbf-tweak-count');
  const resetAllBtn = wrap.querySelector('.kbf-tweak-resetall');

  function applyPreview() {
    // Preview on the element the "from" values were read from; only look it
    // up again when the page replaced it (a live dev server re-rendering).
    const target = el.isConnected ? el : getEl();
    if (!tweaks.size || !target) { clearTweakPreview(); schedulePos(); return; }
    target.setAttribute(TWEAK_ATTR, '1');
    let s = document.getElementById(TWEAK_STYLE_ID);
    if (!s) { s = document.createElement('style'); s.id = TWEAK_STYLE_ID; document.head.appendChild(s); }
    s.textContent = '[' + TWEAK_ATTR + ']{' + [...tweaks].map(([p, v]) => p + ':' + v + ' !important;').join('') + '}';
    schedulePos(); // padding/margin moved things — track the highlight + pins
  }
  function setTweak(prop, toCss) {
    if (!priming) { dirty = true; touched.add(prop); }
    if (toCss === base[prop].css) tweaks.delete(prop);
    else tweaks.set(prop, toCss);
    const row = wrap.querySelector('.kbf-tweak-row[data-prop="' + prop + '"]');
    if (row) row.classList.toggle('is-changed', tweaks.has(prop));
    // giving a bare box a background makes Corners relevant — reveal it live
    if (prop === 'background-color' && tweaks.has(prop)) {
      const rr = wrap.querySelector('.kbf-tweak-row[data-prop="border-radius"]');
      if (rr) rr.classList.remove('kbf-tweak-row--off');
    }
    countBadge.hidden = !tweaks.size;
    countBadge.textContent = String(tweaks.size);
    resetAllBtn.hidden = !tweaks.size;
    ta.placeholder = tweaks.size ? t('Optional note — the tweaks above are the change') : placeholderFor(S.ctype);
    applyPreview();
    if (hooks.validate) hooks.validate();
  }
  const clamp = (ctl, n) => Math.max(ctl.min, Math.min(ctl.max, n));
  // writeBack=false while the user is mid-keystroke: clamp only the value we
  // preview/record, NEVER rewrite the field under their cursor (typing "16"
  // into a min-6 control must not become "6" → "66"). Blur/steppers write back.
  function commitRow(row, writeBack = true) {
    const prop = row.dataset.prop;
    const ctl = TWEAK_CONTROLS.find((c) => c.prop === prop);
    if (ctl.kind === 'px' || ctl.kind === 'px4' || ctl.kind === 'pct') {
      const input = row.querySelector('.kbf-tweak-input');
      let n = parseFloat(input.value);
      if (isNaN(n)) return;
      n = clamp(ctl, n);
      if (writeBack) input.value = n;
      setTweak(prop, ctl.kind === 'pct' ? String(Math.round(n) / 100) : fmtPx(n));
    } else if (ctl.kind === 'weight') {
      setTweak(prop, row.querySelector('.kbf-tweak-select').value);
    } else if (ctl.kind === 'color') {
      const hex = row.querySelector('.kbf-tweak-color').value;
      row.querySelector('.kbf-tweak-swatch').style.background = hex;
      row.querySelector('.kbf-tweak-hex').textContent = hex;
      row.querySelector('.kbf-tweak-colorwrap').classList.remove('is-none');
      setTweak(prop, hex);
    }
  }
  function resetRow(row) {
    const prop = row.dataset.prop;
    const st = base[prop];
    const kind = row.dataset.kind;
    if (kind === 'px' || kind === 'px4' || kind === 'pct') row.querySelector('.kbf-tweak-input').value = st.num;
    else if (kind === 'weight') row.querySelector('.kbf-tweak-select').value = String(st.num);
    else if (kind === 'align') {
      row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.align === st.val));
    }
    else if (kind === 'color') {
      const bg = st.hex || (st.translucent ? st.raw : '');
      row.querySelector('.kbf-tweak-color').value = st.hex || '#888888';
      row.querySelector('.kbf-tweak-swatch').style.background = bg;
      row.querySelector('.kbf-tweak-hex').textContent = st.hex || (st.translucent ? 'alpha' : 'none');
      row.querySelector('.kbf-tweak-colorwrap').classList.toggle('is-none', !bg);
    }
    setTweak(prop, st.css);
  }

  // Collapsed by default; expanding animates via grid-template-rows 0fr→1fr
  // (the CSS owns the motion). Reposition after the height settles.
  function setOpen(open) {
    wrap.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (hooks.reposition) setTimeout(hooks.reposition, 300);
  }
  toggle.addEventListener('click', () => setOpen(!wrap.classList.contains('is-open')));
  resetAllBtn.addEventListener('click', () => wrap.querySelectorAll('.kbf-tweak-row').forEach(resetRow));
  wrap.addEventListener('click', (e) => {
    const undo = e.target.closest('.kbf-tweak-undo');
    if (undo) { resetRow(undo.closest('.kbf-tweak-row')); return; }
    const alignBtn = e.target.closest('.kbf-tweak-alignbtn');
    if (alignBtn) {
      const row = alignBtn.closest('.kbf-tweak-row');
      if (alignBtn.classList.contains('is-active')) { resetRow(row); return; } // tap again = back to original
      row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b === alignBtn));
      setTweak(row.dataset.prop, alignBtn.dataset.align);
      return;
    }
    const stepBtn = e.target.closest('.kbf-tweak-step');
    if (stepBtn && !stepBtn.dataset.held) stepRow(stepBtn, e.shiftKey);
  });
  function stepRow(stepBtn, big) {
    const row = stepBtn.closest('.kbf-tweak-row');
    const ctl = TWEAK_CONTROLS.find((c) => c.prop === row.dataset.prop);
    const input = row.querySelector('.kbf-tweak-input');
    const cur = parseFloat(input.value) || 0;
    input.value = cur + Number(stepBtn.dataset.step) * (big ? 10 : (ctl.step || 1));
    commitRow(row);
  }
  // Press-and-hold on a stepper repeats (400ms delay, then ~14/s).
  wrap.addEventListener('pointerdown', (e) => {
    const stepBtn = e.target.closest('.kbf-tweak-step');
    if (!stepBtn) return;
    let fired = false;
    const t1 = setTimeout(() => {
      const t2 = setInterval(() => { fired = true; stepRow(stepBtn, e.shiftKey); }, 70);
      stepBtn._t2 = t2;
    }, 400);
    const stop = () => {
      clearTimeout(t1);
      if (stepBtn._t2) { clearInterval(stepBtn._t2); stepBtn._t2 = null; }
      if (fired) stepBtn.dataset.held = '1'; // swallow the trailing click
      setTimeout(() => delete stepBtn.dataset.held, 0);
      stepBtn.removeEventListener('pointerup', stop);
      stepBtn.removeEventListener('pointerleave', stop);
      stepBtn.removeEventListener('pointercancel', stop);
    };
    stepBtn.addEventListener('pointerup', stop);
    stepBtn.addEventListener('pointerleave', stop);
    stepBtn.addEventListener('pointercancel', stop);
  });
  wrap.addEventListener('input', (e) => {
    const row = e.target.closest('.kbf-tweak-row');
    if (!row) return;
    // number fields: preview without writing back (don't fight the keystroke)
    if (e.target.classList.contains('kbf-tweak-input')) commitRow(row, false);
    else if (e.target.classList.contains('kbf-tweak-color')) commitRow(row);
  });
  wrap.addEventListener('change', (e) => {
    const row = e.target.closest('.kbf-tweak-row');
    if (!row) return;
    // blur / Enter on a number field: NOW normalise + clamp the field itself
    if (e.target.classList.contains('kbf-tweak-input') || e.target.classList.contains('kbf-tweak-select')) commitRow(row);
  });

  // Editing a comment that already carries tweaks: prime the knobs with the
  // stored target values and preview them straight away. Priming is NOT a user
  // touch — if the page has since been updated (agent applied the tweak, dev
  // server reloaded), the stored "to" now equals the live value, the knobs show
  // no diff, and an untouched Save must NOT wipe the historical edits[].
  if (opts.kind === 'edit' && Array.isArray(opts.comment?.edits) && opts.comment.edits.length) {
    priming = true;
    for (const ed of opts.comment.edits) {
      const row = wrap.querySelector('.kbf-tweak-row[data-prop="' + ed.prop + '"]');
      if (!row) continue;
      row.classList.remove('kbf-tweak-row--off'); // a stored edit makes its row relevant
      const kind = row.dataset.kind;
      if (kind === 'px' || kind === 'px4') {
        const n = parseFloat(ed.to);
        if (!isNaN(n)) { row.querySelector('.kbf-tweak-input').value = n; commitRow(row); }
      } else if (kind === 'pct') {
        const n = parseFloat(ed.to);
        if (!isNaN(n)) { row.querySelector('.kbf-tweak-input').value = Math.round(n * 100); commitRow(row); }
      } else if (kind === 'align' && ['left', 'center', 'right'].includes(ed.to)) {
        row.querySelectorAll('.kbf-tweak-alignbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.align === ed.to));
        setTweak(ed.prop, ed.to);
      } else if (kind === 'weight') {
        const sel = row.querySelector('.kbf-tweak-select');
        if ([...sel.options].some((o) => o.value === ed.to)) { sel.value = ed.to; commitRow(row); }
      } else if (kind === 'color' && /^#[0-9a-f]{6}$/i.test(ed.to)) {
        row.querySelector('.kbf-tweak-color').value = ed.to;
        commitRow(row);
      }
    }
    priming = false;
    if (tweaks.size) setOpen(true);
  }

  return {
    count: () => tweaks.size,
    dirty: () => dirty,
    getEdits: () => [...tweaks].map(([prop, to]) => ({ prop, from: base[prop].css, to })),
    // Per-prop merge for re-saves of an existing comment: props the user did
    // NOT touch this session keep their stored (historical) entry — including
    // ones already applied to source, which show no live diff anymore — while
    // touched props take the current knob state (an intentional reset back to
    // base correctly drops that prop). Full replacement would silently erase
    // applied history the moment any unrelated knob was moved.
    mergeEdits: (stored) => {
      const kept = (Array.isArray(stored) ? stored : []).filter((e) => e && !touched.has(e.prop));
      const mine = [...tweaks].filter(([p]) => touched.has(p)).map(([prop, to]) => ({ prop, from: base[prop].css, to }));
      return [...kept, ...mine];
    },
  };
}
