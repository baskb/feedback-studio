// Feedback Studio — photos added to a comment or a reply.
//
// Three parts:
//   - the tray: the photos picked for a comment or reply that is being written.
//     Each one is shrunk in the browser (which also drops the camera's location
//     data) and uploaded on its own straight away, one at a time, so on a phone
//     the uploading happens while the person is still typing. Saving then sends
//     only the ids; the server moves those uploads into the comment.
//   - the thumbnails of saved photos, on a card and under a reply.
//   - the viewer: one photo at a time, with previous/next, swipe, and (host side)
//     delete.
//
// The tray renders from its own state (html()), because the List re-renders its
// cards on every live update and would otherwise wipe a half-finished upload.

import { S, API, CAN_MANAGE } from '/__feedback/overlay/state.mjs';
import { I, root, escapeHtml, toastError, trapFocus } from '/__feedback/overlay/ui.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { encodeImage } from '/__feedback/overlay/image.mjs';
import { t, tn } from '/__feedback/overlay/i18n.mjs';
import { ATTACH_MAX_PER_MESSAGE, ATTACH_MAX_BYTES } from '/__feedback/lib/schema.mjs';

// Big enough for a photo to be used on a website, small enough to send from a
// phone. Always JPEG (a PNG screenshot stays PNG unless it is too heavy).
const PHOTO_MAX_DIM = 2560;
const PHOTO_BUDGET = 2_500_000;
const THUMB_DIM = 240;
const FILE_RE = /^attachments\/(c_[A-Za-z0-9-]{8,64})\/(a_[A-Za-z0-9-]{8,64}\.(?:jpg|png|webp))$/;

// What went wrong, in words a person can act on.
function photoError(e) {
  if (e && e.code === 'type') return t('This file is not a photo.');
  if (e && e.code === 'decode') return t('This photo could not be read. Choose a JPEG or PNG photo.');
  if (e && e.code === 'huge') return t('This photo is too large (over 40 megapixels).');
  if (e && (e.code === 'size' || e.code === 'encode')) return t('This photo could not be made small enough to send.');
  if (e && e.network) return t('The photo could not be sent. Check the connection and try again.');
  return t('The photo could not be sent: {error}', { error: (e && e.message) || '?' });
}

let seq = 0;

// A tray for one comment or reply being written. onChange runs after every
// change (picked, ready, failed, removed) so the caller can redraw html().
export function createTray(onChange) {
  const items = []; // { key, name, status: 'working' | 'done' | 'failed', id, thumb, error }
  let queue = Promise.resolve();
  let alive = true;
  const changed = () => { if (alive) { try { onChange(); } catch (e) {} } };

  async function run(it, file) {
    if (!alive || !items.includes(it)) return; // removed before its turn came
    try {
      if (file.type && !/^image\//i.test(file.type)) { const e = new Error('not an image'); e.code = 'type'; throw e; }
      const p = await encodeImage(file, {
        maxDim: PHOTO_MAX_DIM, budget: PHOTO_BUDGET, hardCap: ATTACH_MAX_BYTES,
        lossy: 'jpeg', thumb: THUMB_DIM, dataUrl: false,
      });
      it.thumb = p.thumbUrl || '';
      changed();
      if (!alive || !items.includes(it)) return;
      const q = new URLSearchParams({ name: it.name, w: String(p.w), h: String(p.h) });
      const data = await api('/uploads?' + q.toString(), { method: 'POST', headers: { 'Content-Type': p.mime }, body: p.blob });
      it.id = data && data.upload ? data.upload.id : '';
      it.status = it.id ? 'done' : 'failed';
      if (!it.id) it.error = photoError(null);
    } catch (e) {
      it.status = 'failed';
      it.error = photoError(e);
      if (alive && items.includes(it)) toastError((it.name ? it.name + ': ' : '') + it.error);
    }
    changed();
  }

  return {
    add(files) {
      const list = [...(files || [])];
      let room = ATTACH_MAX_PER_MESSAGE - items.filter((i) => i.status !== 'failed').length;
      let left = 0;
      for (const file of list) {
        if (room <= 0) { left++; continue; }
        room--;
        const it = { key: 'p' + (++seq), name: String(file.name || '').slice(0, 120), status: 'working', id: '', thumb: '', error: '' };
        items.push(it);
        queue = queue.then(() => run(it, file));
      }
      if (left) toastError(tn('At most {max} photos per message; {n} photo was left out.', 'At most {max} photos per message; {n} photos were left out.', left, { max: ATTACH_MAX_PER_MESSAGE }));
      changed();
    },
    remove(key) {
      const i = items.findIndex((x) => x.key === key);
      if (i >= 0) { items.splice(i, 1); changed(); }
    },
    count: () => items.filter((i) => i.status !== 'failed').length,
    busy: () => items.some((i) => i.status === 'working'),
    failed: () => items.filter((i) => i.status === 'failed').length,
    ids: () => items.filter((i) => i.status === 'done').map((i) => i.id),
    // Resolves once every photo picked so far is uploaded or has failed.
    settled: () => queue,
    clear() { alive = false; items.length = 0; },
    html: () => trayHtml(items),
  };
}

function trayHtml(items) {
  if (!items.length) return '';
  const working = items.filter((i) => i.status === 'working').length;
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const status = working
    ? tn('Preparing {n} photo…', 'Preparing {n} photos…', working)
    : tn('{n} photo ready to send', '{n} photos ready to send', done) + (failed ? ' · ' + tn('{n} failed', '{n} failed', failed) : '');
  return `<div class="kbf-tray" role="list" aria-label="${escapeHtml(t('Photos to send'))}">${items.map((it) => `
    <div class="kbf-tray-item is-${it.status}" role="listitem" title="${escapeHtml(it.status === 'failed' ? it.error : it.name)}">
      ${it.thumb ? `<img src="${escapeHtml(it.thumb)}" alt="">` : ''}
      ${it.status === 'working' ? '<span class="kbf-tray-spin" aria-hidden="true"></span>' : ''}
      ${it.status === 'failed' ? `<span class="kbf-tray-bad" aria-hidden="true">${I.alert}</span>` : ''}
      <button type="button" class="kbf-tray-x" data-tray-remove="${it.key}" aria-label="${escapeHtml(t('Remove {name}', { name: it.name || t('photo') }))}">${I.close}</button>
    </div>`).join('')}</div>
    <div class="kbf-tray-status" aria-live="polite">${escapeHtml(status)}</div>`;
}

// ---------- saved photos ----------

// The photos of the comment itself (owner '') or of one reply (owner = its id),
// keeping only records that point where this comment's photos live.
function ownerPhotos(c, owner) {
  const src = owner ? ((Array.isArray(c.thread) ? c.thread : []).find((r) => r.id === owner) || {}) : c;
  return (Array.isArray(src.attachments) ? src.attachments : []).filter((a) => {
    const m = a && FILE_RE.exec(String(a.file || ''));
    return m && m[1] === c.id;
  });
}
const photoUrl = (a) => API + '/' + String(a.file); // attachments/<comment id>/<file>, checked by FILE_RE

// Every photo on a comment and its replies (for a count on a folded card).
export function photoCount(c) {
  let n = ownerPhotos(c, '').length;
  for (const r of Array.isArray(c.thread) ? c.thread : []) n += ownerPhotos(c, r.id).length;
  return n;
}

export function photosHtml(c, owner) {
  const list = ownerPhotos(c, owner);
  if (!list.length) return '';
  return `<div class="kbf-photos">${list.map((a, i) => `<button type="button" class="kbf-photo" data-act="photo" data-owner="${escapeHtml(owner)}" data-i="${i}" title="${escapeHtml(a.name || '')}" aria-label="${escapeHtml(t('Open photo {n} of {total}', { n: i + 1, total: list.length }))}"><img src="${escapeHtml(photoUrl(a))}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>`;
}

// ---------- viewer ----------

export function closePhotoViewer() {
  const v = S.photoViewer;
  if (!v) return false;
  S.photoViewer = null;
  v.close();
  return true;
}

export function openPhotoViewer(commentId, owner, index) {
  closePhotoViewer();
  const find = () => S.comments.find((x) => x.id === commentId);
  let c = find();
  if (!c) return;
  let list = ownerPhotos(c, owner);
  if (!list.length) return;
  let i = Math.max(0, Math.min(Number(index) || 0, list.length - 1));

  const el = document.createElement('div');
  el.className = 'kbf-viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="kbf-viewer-bar">
      <span class="kbf-viewer-count"></span>
      <span class="kbf-viewer-name"></span>
      <a class="kbf-viewer-open" target="_blank" rel="noopener">${t('Full size')}</a>
      ${CAN_MANAGE ? `<button type="button" class="kbf-viewer-del" data-v="del">${I.trash}<span>${t('Delete')}</span></button>` : ''}
      <button type="button" class="kbf-viewer-x" data-v="close" aria-label="${escapeHtml(t('Close'))}">${I.close}</button>
    </div>
    <div class="kbf-viewer-stage">
      <button type="button" class="kbf-viewer-nav is-prev" data-v="prev" aria-label="${escapeHtml(t('Previous photo'))}">‹</button>
      <img class="kbf-viewer-img" alt="">
      <button type="button" class="kbf-viewer-nav is-next" data-v="next" aria-label="${escapeHtml(t('Next photo'))}">›</button>
    </div>`;
  root.appendChild(el);
  const img = el.querySelector('.kbf-viewer-img');
  const count = el.querySelector('.kbf-viewer-count');
  const name = el.querySelector('.kbf-viewer-name');
  const open = el.querySelector('.kbf-viewer-open');
  const del = el.querySelector('.kbf-viewer-del');
  const navs = el.querySelectorAll('.kbf-viewer-nav');
  let armTimer = 0;

  function disarm() {
    clearTimeout(armTimer);
    if (del) { del.classList.remove('is-armed'); del.querySelector('span').textContent = t('Delete'); }
  }
  function show() {
    const a = list[i];
    img.src = photoUrl(a);
    img.alt = a.name || t('Photo {n}', { n: i + 1 });
    count.textContent = (i + 1) + ' / ' + list.length;
    name.textContent = a.name || '';
    open.href = photoUrl(a);
    el.setAttribute('aria-label', t('Photo {n} of {total}', { n: i + 1, total: list.length }));
    navs.forEach((b) => { b.hidden = list.length < 2; });
    disarm();
  }
  const go = (d) => { if (list.length > 1) { i = (i + d + list.length) % list.length; show(); } };

  async function remove() {
    // Two taps: the first arms the button, the second deletes. No browser
    // confirm() dialog, which would block the page.
    if (!del.classList.contains('is-armed')) {
      del.classList.add('is-armed');
      del.querySelector('span').textContent = t('Tap again to delete');
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    const a = list[i];
    try {
      const data = await api('/' + a.file, { method: 'DELETE' });
      const at = S.comments.findIndex((x) => x.id === commentId);
      if (at >= 0 && data && data.comment) S.comments[at] = data.comment;
      emit('refresh');
    } catch (e) { toastError(t('The photo could not be deleted: {error}', { error: e.message })); return; }
    c = find();
    list = c ? ownerPhotos(c, owner) : [];
    if (!list.length) { closePhotoViewer(); return; }
    i = Math.min(i, list.length - 1);
    show();
  }

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-v]')?.dataset.v;
    if (act === 'close' || e.target === el) { closePhotoViewer(); return; }
    if (act === 'prev') go(-1);
    else if (act === 'next') go(1);
    else if (act === 'del') remove();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePhotoViewer(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    // No overlay shortcut (resolve, next comment, …) acts behind the photo.
    e.stopPropagation();
  });
  // Swipe left / right on a phone.
  let sx = null;
  const stage = el.querySelector('.kbf-viewer-stage');
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') sx = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx;
    sx = null;
    if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { sx = null; });

  const release = trapFocus(el, { initial: el.querySelector('.kbf-viewer-x') });
  S.photoViewer = {
    close() {
      clearTimeout(armTimer);
      try { release(); } catch (e) {}
      try { el.remove(); } catch (e) {}
    },
  };
  show();
}
