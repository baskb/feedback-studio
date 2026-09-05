// Feedback Studio — Markdown mode: the reviewed document's versions, and what
// changed between any two of them.
//
// The server keeps a snapshot of the .md each time it changes on disk (the
// agent editing it live, an older version put back, a batch boundary marked by
// the processing skill). This pane replaces the List: pick two versions, read
// the diff line by line, and put an older version back if a change went wrong.

import { S, SOURCE, CAN_MANAGE, pinLabel } from '/__feedback/overlay/state.mjs';
import { I, $, listEl, historyEl, subEl, escapeHtml, timeAgo, toast, toastError } from '/__feedback/overlay/ui.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { setPanel, renderPanel } from '/__feedback/overlay/panel.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

let versions = [];          // newest last, as the server lists them
let sel = { from: 0, to: 0 };
let onlyChanges = true;

const reasonText = (v) => ({
  opened: t('opened'), changed: t('changed on disk'), batch: t('batch'), restore: t('restored'), manual: t('manual'),
}[v.reason] || v.reason || '');

// "after #2, #3 resolved" / "while on #4": which comments a version belongs to.
function contextText(v) {
  const bits = [];
  if (Array.isArray(v.resolved) && v.resolved.length) {
    const labels = v.resolved.map((id) => pinLabel(id)).filter(Boolean);
    if (labels.length) bits.push(t('after #{list} resolved', { list: labels.map((l) => l.replace(/^#/, '')).join(', #') }));
  }
  if (v.commentId) { const l = pinLabel(v.commentId); if (l) bits.push(t('while on #{n}', { n: l.replace(/^#/, '') })); }
  return bits.join(' · ');
}

export function isHistoryOpen() { return S.view === 'history'; }

export async function openHistory(opts = {}) {
  if (!SOURCE) return;
  S.view = 'history';
  if (!S.panelOpen) setPanel(true);
  listEl.hidden = true;
  historyEl.hidden = false;
  const bulk = $('kbf-bulk'); if (bulk) bulk.hidden = true;
  historyEl.innerHTML = `<div class="kbf-hist-head"><button type="button" class="kbf-x" data-act="back" title="${t('Back to the list')}" aria-label="${t('Back to the list')}">${I.back}</button><strong>${escapeHtml(t('Versions of {file}', { file: SOURCE }))}</strong></div>`;
  try {
    const data = await api('/history?file=' + encodeURIComponent(SOURCE));
    versions = Array.isArray(data.versions) ? data.versions : [];
  } catch (e) {
    versions = [];
    historyEl.insertAdjacentHTML('beforeend', `<p class="kbf-hist-empty">${escapeHtml(t('Could not load the history — {error}', { error: e.message }))}</p>`);
    return;
  }
  const last = versions.length ? versions[versions.length - 1].n : 0;
  const prev = versions.length > 1 ? versions[versions.length - 2].n : last;
  sel = { from: opts.from || prev, to: opts.to || last };
  if (!versions.some((v) => v.n === sel.from)) sel.from = prev;
  if (!versions.some((v) => v.n === sel.to)) sel.to = last;
  await render();
}

export function closeHistory() {
  S.view = 'list';
  historyEl.hidden = true;
  historyEl.innerHTML = '';
  listEl.hidden = false;
  renderPanel();
}

// Refresh the list of versions when the document changed while the pane is open.
export async function historyChanged(note) {
  if (S.view !== 'history') return;
  await openHistory({ from: note && note.n > 1 ? note.n - 1 : undefined, to: note && note.n });
}

async function render() {
  subEl.textContent = '';
  const head = historyEl.querySelector('.kbf-hist-head');
  historyEl.innerHTML = '';
  historyEl.appendChild(head);
  if (!versions.length) {
    historyEl.insertAdjacentHTML('beforeend', `<p class="kbf-hist-empty">${escapeHtml(t('No versions yet. The first one is taken when the document is opened; a new one each time the file changes on disk.'))}</p>`);
    return;
  }
  const opt = (v, cur) => `<option value="${v.n}"${v.n === cur ? ' selected' : ''}>v${v.n} · ${escapeHtml(timeAgo(v.at))}</option>`;
  const list = versions.slice().reverse().map((v) => `
    <li class="kbf-hist-item${v.n === sel.to ? ' is-to' : ''}${v.n === sel.from ? ' is-from' : ''}" data-n="${v.n}">
      <span class="kbf-hist-n">v${v.n}</span>
      <span class="kbf-hist-meta"><span class="kbf-hist-reason">${escapeHtml(reasonText(v))}</span> · <span title="${escapeHtml(v.at || '')}">${escapeHtml(timeAgo(v.at))}</span>${(v.added || v.removed) ? ` · <span class="kbf-hist-delta"><ins>+${v.added || 0}</ins> <del>−${v.removed || 0}</del></span>` : ''}${contextText(v) ? `<br><span class="kbf-hist-ctx">${escapeHtml(contextText(v))}</span>` : ''}</span>
      <span class="kbf-hist-acts">
        <button type="button" class="kbf-mini" data-act="from" data-n="${v.n}" title="${t('from')}">A</button>
        <button type="button" class="kbf-mini" data-act="to" data-n="${v.n}" title="${t('to')}">B</button>
        ${CAN_MANAGE && v.n !== versions[versions.length - 1].n ? `<button type="button" class="kbf-mini kbf-mini--danger" data-act="restore" data-n="${v.n}" title="${escapeHtml(t('Put the document back to this version (the current text is kept as a new version first)'))}">${I.undo}</button>` : ''}
      </span>
    </li>`).join('');
  historyEl.insertAdjacentHTML('beforeend', `
    <div class="kbf-hist-tools">
      <label>${t('from')} <select data-sel="from">${versions.map((v) => opt(v, sel.from)).join('')}</select></label>
      <label>${t('to')} <select data-sel="to">${versions.map((v) => opt(v, sel.to)).join('')}</select></label>
      <label class="kbf-hist-only"><input type="checkbox" data-act="only"${onlyChanges ? ' checked' : ''}> ${t('Only changes')}</label>
      ${CAN_MANAGE ? `<button type="button" class="kbf-chip-btn" data-act="snapshot" title="${t('Take a snapshot now')}">${I.plus}<span>${t('Take a snapshot now')}</span></button>` : ''}
    </div>
    <div class="kbf-hist-diff" id="kbf-hist-diff"></div>
    <ol class="kbf-hist-list">${list}</ol>`);
  await renderDiff();
}

async function renderDiff() {
  const box = $('kbf-hist-diff');
  if (!box) return;
  if (sel.from === sel.to) { box.innerHTML = `<p class="kbf-hist-empty">${escapeHtml(t('No differences between these two versions.'))}</p>`; return; }
  let d;
  try {
    d = await api(`/history/diff?file=${encodeURIComponent(SOURCE)}&from=${sel.from}&to=${sel.to}`);
  } catch (e) { box.innerHTML = `<p class="kbf-hist-empty">${escapeHtml(t('Could not load the history — {error}', { error: e.message }))}</p>`; return; }
  const hunks = Array.isArray(d.hunks) ? d.hunks : [];
  if (!hunks.length) { box.innerHTML = `<p class="kbf-hist-empty">${escapeHtml(t('No differences between these two versions.'))}</p>`; return; }
  let html = `<div class="kbf-hist-stats">v${sel.from} → v${sel.to} · <ins>+${d.stats ? d.stats.added : 0}</ins> <del>−${d.stats ? d.stats.removed : 0}</del></div>`;
  for (const h of hunks) {
    let a = h.fromStart;
    let b = h.toStart;
    html += `<div class="kbf-hunk"><div class="kbf-hunk-head">${escapeHtml(t('Line {n}', { n: b }))}</div>`;
    for (const op of h.ops) {
      const cls = op.op === '+' ? 'add' : op.op === '-' ? 'del' : 'same';
      if (cls === 'same' && onlyChanges && !h.ops.some((o) => o.op !== '=')) continue;
      const num = op.op === '+' ? b : op.op === '-' ? a : b;
      html += `<div class="kbf-line is-${cls}"><span class="kbf-line-n">${num}</span><span class="kbf-line-t">${escapeHtml(op.text) || '&nbsp;'}</span></div>`;
      if (op.op !== '+') a++;
      if (op.op !== '-') b++;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

async function restore(n) {
  try {
    const r = await api('/history/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: SOURCE, n }) });
    toast(t('Restored version {n} — the page reloads', { n }), { duration: 2500 });
    void r;
  } catch (e) { toastError(t('Restore failed — {error}', { error: e.message })); }
}

async function snapshot() {
  try {
    const r = await api('/history/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: SOURCE, reason: 'manual' }) });
    if (r.changed) { toast(t('Snapshot saved as v{n}', { n: r.version && r.version.n })); await openHistory({ to: r.version && r.version.n }); }
    else toast(t('No change since the last version.'));
  } catch (e) { toastError(t('Snapshot failed — {error}', { error: e.message })); }
}

export function initHistory() {
  if (!SOURCE) return;
  const btn = $('kbf-history-btn');
  if (btn) { btn.style.display = ''; btn.addEventListener('click', () => (S.view === 'history' ? closeHistory() : openHistory())); }
  historyEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const n = Number(b.dataset.n);
    if (b.dataset.act === 'back') return closeHistory();
    if (b.dataset.act === 'from') { sel.from = n; return render(); }
    if (b.dataset.act === 'to') { sel.to = n; return render(); }
    if (b.dataset.act === 'restore') return restore(n);
    if (b.dataset.act === 'snapshot') return snapshot();
    if (b.dataset.act === 'only') { onlyChanges = b.checked; return renderDiff(); }
  });
  historyEl.addEventListener('change', (e) => {
    const s = e.target.closest('[data-sel]');
    if (!s) return;
    sel[s.dataset.sel] = Number(s.value);
    render();
  });
}
