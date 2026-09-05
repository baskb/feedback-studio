// Feedback Studio — image replacement (swap an <img>/background for a local file).
//
// Reviewer picks an image element, chooses a local file, frames/crops it live
// on the page. Everything is native (canvas + FileReader — no dependency): the
// file is decoded, auto-downscaled to keep it performant, re-encoded, and
// previewed in place. On save the processed blob is staged under .feedback/media
// and the agent later moves it into the repo. Preview reverts on close.

import { addTeardown, removeTeardown, hasTeardown } from '/__feedback/overlay/state.mjs';
import { I, root, toastError } from '/__feedback/overlay/ui.mjs';
import { schedulePos } from '/__feedback/overlay/pins.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

const IMG_MAX_DIM = 2048;             // longest side after downscale
const IMG_MAX_SRC_PIXELS = 40_000_000; // reject decompression bombs (~40 MP)
const IMG_BYTE_BUDGET = 1_500_000;    // ~1.5 MB target for lossy formats

// What kind of image (if any) the picked element carries.
function imageTargetOf(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.nodeName.toLowerCase();
  if (tag === 'img') return { kind: 'img', el };
  if (tag === 'picture') { const img = el.querySelector('img'); if (img) return { kind: 'img', el: img }; }
  try {
    const bg = getComputedStyle(el).backgroundImage || '';
    if (/url\(/i.test(bg) && !/^none$/i.test(bg)) return { kind: 'background', el };
  } catch (e) {}
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
function canvasToBlob(canvas, mime, q) {
  return new Promise((res) => canvas.toBlob((b) => res(b), mime, q));
}
let _webpOk = null;
function webpSupported() {
  if (_webpOk === null) { try { _webpOk = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); } catch (e) { _webpOk = false; } }
  return _webpOk;
}
// Draw a source region down to the target size WITHOUT ever allocating a
// full-native-resolution canvas (that's the DoS vector on a huge/bomb image):
// the first draw goes straight from the decoded <img> into a canvas no larger
// than 2× the target, then we step down by halves so the result stays crisp.
function drawScaled(img, sx, sy, sw, sh, tw, th) {
  let stepW = sw, stepH = sh;
  while (stepW > tw * 2 && stepH > th * 2) { stepW = Math.max(tw, Math.round(stepW / 2)); stepH = Math.max(th, Math.round(stepH / 2)); }
  let cur = document.createElement('canvas'); cur.width = stepW; cur.height = stepH;
  cur.getContext('2d').imageSmoothingQuality = 'high';
  cur.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, stepW, stepH);
  let cw = stepW, ch = stepH;
  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
    const tmp = document.createElement('canvas'); tmp.width = nw; tmp.height = nh;
    const tctx = tmp.getContext('2d'); tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = tmp; cw = nw; ch = nh;
  }
  if (cw === tw && ch === th) return cur;
  const out = document.createElement('canvas'); out.width = tw; out.height = th;
  const octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
  return out;
}
// Decode → (crop) → downscale → re-encode. cropRect is in natural-source pixels.
async function processImage(file, cropRect) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('could not read that image')); i.src = url; });
    const natW = img.naturalWidth || img.width, natH = img.naturalHeight || img.height;
    if (!natW || !natH) throw new Error('empty image');
    if (natW * natH > IMG_MAX_SRC_PIXELS) throw new Error('image is too large to process (over ~40 megapixels)');
    let sx = 0, sy = 0, sw = natW, sh = natH;
    if (cropRect) {
      sx = Math.max(0, Math.min(cropRect.x, natW - 1));
      sy = Math.max(0, Math.min(cropRect.y, natH - 1));
      sw = Math.max(1, Math.min(cropRect.w, natW - sx));
      sh = Math.max(1, Math.min(cropRect.h, natH - sy));
    }
    let tw = sw, th = sh;
    const longest = Math.max(sw, sh);
    if (longest > IMG_MAX_DIM) { const k = IMG_MAX_DIM / longest; tw = Math.max(1, Math.round(sw * k)); th = Math.max(1, Math.round(sh * k)); }
    const canvas = drawScaled(img, sx, sy, sw, sh, tw, th);
    const hasAlpha = file.type === 'image/png' || /\.png$/i.test(file.name || '');
    let mime = hasAlpha ? 'image/png' : (webpSupported() ? 'image/webp' : 'image/jpeg');
    let blob = await canvasToBlob(canvas, mime, 0.85);
    // Over budget: a detailed PNG at 2048px is routinely several MB. WebP keeps
    // the alpha channel, so an oversized PNG re-encodes to webp rather than
    // shipping a blob the server would reject; lossy formats step quality down.
    if (blob && blob.size > IMG_BYTE_BUDGET && mime === 'image/png' && webpSupported()) {
      mime = 'image/webp';
      blob = await canvasToBlob(canvas, mime, 0.85);
    }
    if (blob && blob.size > IMG_BYTE_BUDGET && mime !== 'image/png') blob = await canvasToBlob(canvas, mime, 0.72);
    if (!blob) throw new Error('could not encode the image');
    // Hard ceiling aligned with the server's media route (3 MB decoded): fail
    // here with a clear message instead of a doomed upload.
    if (blob.size > 3_000_000) throw new Error('still over 3 MB after downscaling — crop it or pick a smaller image');
    const dataUrl = await blobToDataUrl(blob);
    return { blob, dataUrl, mime, w: tw, h: th, natW, natH, cropRect: cropRect || null };
  } finally { URL.revokeObjectURL(url); }
}

const IMG_ALIGN = [ // 3×3 object-position grid
  ['0% 0%', '50% 0%', '100% 0%'],
  ['0% 50%', '50% 50%', '100% 50%'],
  ['0% 100%', '50% 100%', '100% 100%'],
];

export function setupImageReplace(box, opts, hooks) {
  const getEl = opts.getTargetEl;
  const el0 = getEl && getEl();
  const tgt = imageTargetOf(el0);
  if (!tgt) return null;
  const el = tgt.el;

  // originals for a clean revert
  const orig = tgt.kind === 'img'
    ? { src: el.getAttribute('src'), srcset: el.getAttribute('srcset'), of: el.style.objectFit, op: el.style.objectPosition, w: el.style.width, h: el.style.height }
    : { bi: el.style.backgroundImage, bs: el.style.backgroundSize, bp: el.style.backgroundPosition, w: el.style.width, h: el.style.height };

  let processed = null;   // { blob, dataUrl, mime, w, h, natW, natH, cropRect }
  let chosenFile = null;  // the raw File (kept so Crop can re-process a region)
  const state = { fit: '', position: '', w: undefined, h: undefined, crop: null, alt: (tgt.kind === 'img' ? (el.getAttribute('alt') || '') : '') };
  let dirtyIR = false;

  const wrap = document.createElement('div');
  wrap.className = 'kbf-imgrep';
  wrap.innerHTML = `
    <div class="kbf-imgrep-head">${I.image}<span>${t('Replace image')}</span><span class="kbf-imgrep-kind">${tgt.kind === 'background' ? t('background') : ''}</span></div>
    <input type="file" class="kbf-imgrep-file" accept="image/png,image/jpeg,image/webp" hidden>
    <button type="button" class="kbf-imgrep-choose" data-ir="choose">${t('Choose image…')}</button>
    <div class="kbf-imgrep-body" hidden>
      <div class="kbf-imgrep-info"><img class="kbf-imgrep-thumb" alt=""><span class="kbf-imgrep-meta"></span><button type="button" class="kbf-imgrep-redo" data-ir="choose" title="${t('Choose a different file')}">↺</button></div>
      <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">${t('Fit')}</span>
        <span class="kbf-imgrep-seg" data-ir-seg="fit">
          <button type="button" data-fit="cover">${t('Cover')}</button><button type="button" data-fit="contain">${t('Contain')}</button><button type="button" data-fit="fill">${t('Fill')}</button>
        </span></div>
      <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">${t('Align')}</span>
        <span class="kbf-imgrep-grid">${IMG_ALIGN.flat().map((p) => `<button type="button" class="kbf-imgrep-cell" data-pos="${p}" aria-label="${t('align {pos}', { pos: p })}"></button>`).join('')}</span></div>
      <div class="kbf-imgrep-row"><span class="kbf-imgrep-label">${t('Size')}</span>
        <span class="kbf-imgrep-size"><input type="number" class="kbf-imgrep-w" min="1" max="20000" aria-label="${t('width px')}"><span>×</span><input type="number" class="kbf-imgrep-h" min="1" max="20000" aria-label="${t('height px')}"><span class="kbf-imgrep-unit">px</span></span></div>
      <div class="kbf-imgrep-foot"><button type="button" class="kbf-imgrep-crop" data-ir="crop">${t('Crop…')}</button><button type="button" class="kbf-imgrep-reset" data-ir="reset">${t('Reset')}</button></div>
    </div>`;
  const ta = box.querySelector('.kbf-textarea');
  ta.parentElement.insertBefore(wrap, ta);

  const fileInput = wrap.querySelector('.kbf-imgrep-file');
  const body = wrap.querySelector('.kbf-imgrep-body');
  const thumb = wrap.querySelector('.kbf-imgrep-thumb');
  const metaEl = wrap.querySelector('.kbf-imgrep-meta');
  const wIn = wrap.querySelector('.kbf-imgrep-w'), hIn = wrap.querySelector('.kbf-imgrep-h');

  function markDirty() { dirtyIR = true; if (hooks.validate) hooks.validate(); }

  // apply the current processed image + framing to the element (live preview)
  function applyPreview() {
    if (!processed) return;
    if (!hasTeardown('image')) addTeardown('image', restore); // arm revert on first apply
    if (tgt.kind === 'img') {
      el.src = processed.dataUrl;
      el.removeAttribute('srcset');
      if (state.fit) el.style.objectFit = state.fit;
      if (state.position) el.style.objectPosition = state.position;
    } else {
      el.style.backgroundImage = 'url("' + processed.dataUrl + '")';
      if (state.fit) el.style.backgroundSize = state.fit === 'fill' ? '100% 100%' : state.fit;
      if (state.position) el.style.backgroundPosition = state.position;
    }
    if (state.w) el.style.width = state.w + 'px';
    if (state.h) el.style.height = state.h + 'px';
    schedulePos();
  }
  function restore() {
    try {
      if (tgt.kind === 'img') {
        if (orig.src != null) el.setAttribute('src', orig.src); else el.removeAttribute('src'); // fully undo the data: preview
        if (orig.srcset != null) el.setAttribute('srcset', orig.srcset); else el.removeAttribute('srcset');
        el.style.objectFit = orig.of || ''; el.style.objectPosition = orig.op || '';
      } else {
        el.style.backgroundImage = orig.bi || ''; el.style.backgroundSize = orig.bs || ''; el.style.backgroundPosition = orig.bp || '';
      }
      el.style.width = orig.w || ''; el.style.height = orig.h || '';
    } catch (e) {}
    schedulePos();
  }

  async function ingest(file, cropRect) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { toastError(t('Choose a PNG, JPEG or WebP image')); return; }
    try {
      processed = await processImage(file, cropRect);
      chosenFile = file;
      state.crop = processed.cropRect;
      // Don't force a pixel size — leave the element's own sizing (fluid/
      // responsive) intact. The current rendered size is only a placeholder;
      // width/height are applied ONLY if the user actually types one.
      const rr = el.getBoundingClientRect();
      wIn.placeholder = Math.round(rr.width) || ''; hIn.placeholder = Math.round(rr.height) || '';
      wIn.value = ''; hIn.value = '';
      thumb.src = processed.dataUrl;
      metaEl.textContent = `${processed.w}×${processed.h} · ${Math.round(processed.blob.size / 1024)} KB${processed.mime === 'image/webp' ? ' · webp' : processed.mime === 'image/png' ? ' · png' : ' · jpg'}`;
      body.hidden = false;
      wrap.classList.add('is-active');
      markDirty();
      applyPreview();
    } catch (e) { toastError(t('Image failed — {error}', { error: e.message })); }
  }

  wrap.addEventListener('click', (e) => {
    const act = e.target.closest('[data-ir]')?.dataset.ir;
    if (act === 'choose') { fileInput.click(); return; }
    if (act === 'reset') { restore(); processed = null; chosenFile = null; dirtyIR = true; body.hidden = true; wrap.classList.remove('is-active'); removeTeardown('image'); if (hooks.validate) hooks.validate(); return; }
    if (act === 'crop') { if (chosenFile) openCropModal(chosenFile, processed, (rect) => ingest(chosenFile, rect)); return; }
    const fitBtn = e.target.closest('[data-fit]');
    if (fitBtn) { state.fit = fitBtn.dataset.fit; wrap.querySelectorAll('[data-fit]').forEach((b) => b.classList.toggle('is-active', b === fitBtn)); markDirty(); applyPreview(); return; }
    const cell = e.target.closest('.kbf-imgrep-cell');
    if (cell) { state.position = cell.dataset.pos; wrap.querySelectorAll('.kbf-imgrep-cell').forEach((c) => c.classList.toggle('is-active', c === cell)); markDirty(); applyPreview(); return; }
  });
  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; ingest(f, null); });
  const onSize = () => { const w = parseInt(wIn.value, 10), h = parseInt(hIn.value, 10); state.w = Number.isFinite(w) ? w : undefined; state.h = Number.isFinite(h) ? h : undefined; markDirty(); applyPreview(); };
  wIn.addEventListener('input', onSize); hIn.addEventListener('input', onSize);

  return {
    count: () => (processed ? 1 : 0),
    dirty: () => dirtyIR,
    getMeta: () => (processed ? {
      target: tgt.kind, fit: state.fit || undefined, position: state.position || undefined,
      w: state.w, h: state.h, natW: processed.natW, natH: processed.natH,
      crop: processed.cropRect || undefined, alt: state.alt || undefined,
    } : null),
    getDataUrl: () => (processed ? processed.dataUrl : null),
  };
}

// ---------- crop modal (drag a rectangle over the source image) ----------
function openCropModal(file, processed, onApply) {
  const url = URL.createObjectURL(file);
  const modal = document.createElement('div');
  modal.className = 'kbf-crop';
  modal.innerHTML = `
    <div class="kbf-crop-panel">
      <div class="kbf-crop-stage"><img class="kbf-crop-img" alt=""><div class="kbf-crop-box"><span class="kbf-crop-handle" data-h="se"></span></div></div>
      <div class="kbf-crop-bar"><span class="kbf-crop-hint">${t('Drag to move · corner to resize')}</span><button type="button" class="kbf-btn kbf-btn--ghost" data-crop="cancel">${t('Cancel')}</button><button type="button" class="kbf-btn kbf-btn--primary" data-crop="apply">${t('Crop')}</button></div>
    </div>`;
  root.appendChild(modal);
  const imgEl = modal.querySelector('.kbf-crop-img');
  const boxEl = modal.querySelector('.kbf-crop-box');
  const stage = modal.querySelector('.kbf-crop-stage');
  let natW = 0, natH = 0, dispScale = 1, offX = 0, offY = 0; // display mapping
  const cbox = { x: 0, y: 0, w: 0, h: 0 }; // in displayed px within the image

  imgEl.onload = () => {
    natW = imgEl.naturalWidth; natH = imgEl.naturalHeight;
    const r = imgEl.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    dispScale = r.width / natW; offX = r.left - sr.left; offY = r.top - sr.top;
    // start with the current crop (mapped) or an inset 80%
    const c = processed && processed.cropRect;
    if (c) { cbox.x = c.x * dispScale; cbox.y = c.y * dispScale; cbox.w = c.w * dispScale; cbox.h = c.h * dispScale; }
    else { cbox.w = r.width * 0.8; cbox.h = r.height * 0.8; cbox.x = r.width * 0.1; cbox.y = r.height * 0.1; }
    drawBox();
  };
  imgEl.src = url;
  function drawBox() {
    boxEl.style.left = (offX + cbox.x) + 'px'; boxEl.style.top = (offY + cbox.y) + 'px';
    boxEl.style.width = cbox.w + 'px'; boxEl.style.height = cbox.h + 'px';
  }
  // drag move / resize (SE handle)
  let drag = null;
  let boxClick = false; // a drag that ends over the backdrop still fires a click there; that click must not close the modal
  modal.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.kbf-crop-handle');
    const inBox = e.target.closest('.kbf-crop-box');
    if (!handle && !inBox) return;
    boxClick = true;
    const r = imgEl.getBoundingClientRect();
    drag = { mode: handle ? 'resize' : 'move', x: e.clientX, y: e.clientY, bx: cbox.x, by: cbox.y, bw: cbox.w, bh: cbox.h, maxW: r.width, maxH: r.height };
    try { modal.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  modal.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.mode === 'move') {
      cbox.x = Math.max(0, Math.min(drag.bx + dx, drag.maxW - cbox.w));
      cbox.y = Math.max(0, Math.min(drag.by + dy, drag.maxH - cbox.h));
    } else {
      cbox.w = Math.max(16, Math.min(drag.bw + dx, drag.maxW - cbox.x));
      cbox.h = Math.max(16, Math.min(drag.bh + dy, drag.maxH - cbox.y));
    }
    drawBox();
  });
  const endDrag = (e) => { if (drag) { try { modal.releasePointerCapture(e.pointerId); } catch (_) {} drag = null; } };
  modal.addEventListener('pointerup', endDrag);
  modal.addEventListener('pointercancel', endDrag);
  function close() { removeTeardown('crop'); try { modal.remove(); } catch (e) {} URL.revokeObjectURL(url); }
  addTeardown('crop', close); // so closeComposer / Escape can tear it down
  function apply() {
    const rect = { x: Math.round(cbox.x / dispScale), y: Math.round(cbox.y / dispScale), w: Math.round(cbox.w / dispScale), h: Math.round(cbox.h / dispScale) };
    close(); onApply(rect);
  }
  modal.addEventListener('click', (e) => {
    if (boxClick) { boxClick = false; return; } // the tail end of a crop-box drag, not a backdrop click
    const act = e.target.closest('[data-crop]')?.dataset.crop;
    if (act === 'cancel' || e.target === modal) { close(); return; }
    if (act === 'apply') apply();
  });
  // Keyboard: arrows nudge / Shift+arrows resize the box, Enter applies, Esc cancels.
  boxEl.tabIndex = 0;
  boxEl.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const r = imgEl.getBoundingClientRect();
    if (e.key === 'Enter') { e.preventDefault(); apply(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!move) return;
    e.preventDefault();
    if (e.altKey) { // resize with Alt
      cbox.w = Math.max(16, Math.min(cbox.w + move[0], r.width - cbox.x));
      cbox.h = Math.max(16, Math.min(cbox.h + move[1], r.height - cbox.y));
    } else {
      cbox.x = Math.max(0, Math.min(cbox.x + move[0], r.width - cbox.w));
      cbox.y = Math.max(0, Math.min(cbox.y + move[1], r.height - cbox.h));
    }
    drawBox();
  });
  setTimeout(() => { try { boxEl.focus(); } catch (e) {} }, 30);
}
