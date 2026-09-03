// Feedback Studio — agent presence + activity.
//
// The server tells us what the agent is doing (state, which comment, since
// when, latest note, queue, last heard from) and streams an activity log
// ("edited src/Header.jsx", "replied", "resolved"). This mirrors it: chip in
// the panel head, a pulsing ring on the pin being worked on, a strip on its
// card, an Activity drawer, and the tab title. Staleness is shown, never
// guessed: "working" stays "working" (marked quiet) until the server says
// otherwise — the old client-side 100s timeout is gone.

import { S, agentName, fmtDur, pinLabel, activityText } from '/__feedback/overlay/state.mjs';
import { $, root, escapeHtml } from '/__feedback/overlay/ui.mjs';
import { renderPanel, focusOrOpen } from '/__feedback/overlay/panel.mjs';

const QUIET_AFTER_MS = 90000;

function agentLine() {
  const st = S.agent.state;
  if (st === 'offline') return '';
  const quiet = S.agent.lastSeen ? Date.now() - S.agent.lastSeen : 0;
  let s = agentName();
  if (st === 'working') {
    const lbl = S.agent.commentId ? pinLabel(S.agent.commentId) : '';
    s += ' · working on ' + (lbl || 'a comment');
    if (S.agent.since) s += ' · ' + fmtDur(Date.now() - S.agent.since);
  } else s += ' is online';
  if (quiet > QUIET_AFTER_MS) s += ' · quiet for ' + fmtDur(quiet).replace(/ \d+s$/, '');
  return s;
}

export function applyAgentStatus(a) {
  S.agent = Object.assign({ state: 'offline', name: '', commentId: '', since: 0, note: '', lastSeen: 0, queue: [] }, a || {});
  if (!Array.isArray(S.agent.queue)) S.agent.queue = [];
  const on = S.agent.state === 'online' || S.agent.state === 'working';
  const row = $('kbf-agent-row');
  if (row) row.hidden = !on && !S.activity.length;
  const chip = $('kbf-agent-chip');
  if (chip) {
    chip.hidden = !on;
    chip.classList.toggle('is-working', S.agent.state === 'working');
    chip.title = S.agent.state === 'working' && S.agent.commentId ? 'Jump to the comment being worked on' : '';
  }
  const fw = root.querySelector('.kbf-fab-wrap');
  if (fw) {
    fw.classList.toggle('kbf-agent-live', on);
    fw.classList.toggle('kbf-agent-busy', S.agent.state === 'working');
  }
  renderAgentChip();
  clearInterval(S.agentTick);
  if (on) S.agentTick = setInterval(renderAgentChip, 1000);
  // Pins / cards only re-render when the thing being worked on changes —
  // not on every heartbeat.
  const key = S.agent.state + '|' + S.agent.commentId + '|' + S.agent.queue.join(',');
  if (key !== S.agentKey) { S.agentKey = key; syncWorkingPins(); renderPanel(); }
  setTabState();
}

export function renderAgentChip() {
  const txt = $('kbf-agent-text');
  if (txt) txt.textContent = agentLine();
  const chip = $('kbf-agent-chip');
  if (chip) chip.classList.toggle('is-quiet', !!S.agent.lastSeen && Date.now() - S.agent.lastSeen > QUIET_AFTER_MS);
  const note = $('kbf-agent-note');
  if (note) {
    const last = S.activity.length ? S.activity[S.activity.length - 1] : null;
    const line = S.agent.state === 'working' && S.agent.note ? S.agent.note : (last && S.agent.state !== 'offline' ? activityText(last) : '');
    note.hidden = !line;
    note.textContent = line;
  }
  root.querySelectorAll('.kbf-elapsed').forEach((el) => { el.textContent = fmtDur(Date.now() - Number(el.dataset.since || Date.now())); });
}

function syncWorkingPins() {
  for (const p of S.placed) {
    p.pinEl.classList.toggle('is-working', S.agent.state === 'working' && p.comment.id === S.agent.commentId);
    p.pinEl.classList.toggle('is-queued', S.agent.queue.includes(p.comment.id) && p.comment.id !== S.agent.commentId);
  }
}

const ACT_ICON = { edit: '✎', note: '…', reply: '↩', resolve: '✓', claim: '▶', done: '✓', idle: '⏸' };

export function pushActivity(e) {
  if (!e || !e.id) return;
  if (S.activity.some((x) => x.id === e.id)) return;
  S.activity.push(e);
  if (S.activity.length > 100) S.activity.splice(0, S.activity.length - 100);
  if (!S.activityOpen) S.activityUnread++;
  // The agent finished something while this tab was in the background: say so
  // in the tab title until the user comes back.
  if ((e.kind === 'done' || e.kind === 'resolve' || e.kind === 'reply') && document.hidden) S.tabDone = true;
  renderActivity();
  renderAgentChip();
  const row = $('kbf-agent-row');
  if (row) row.hidden = false;
  if (e.kind === 'done' || e.kind === 'idle') renderPanel();
  setTabState();
}

export function renderActivity() {
  const btn = $('kbf-activity-btn');
  const cnt = $('kbf-activity-count');
  if (cnt) { cnt.hidden = !S.activityUnread; cnt.textContent = String(S.activityUnread); }
  if (btn) btn.setAttribute('aria-expanded', S.activityOpen ? 'true' : 'false');
  const box = $('kbf-activity');
  if (!box) return;
  box.hidden = !S.activityOpen;
  if (!S.activityOpen) return;
  if (!S.activity.length) { box.innerHTML = '<div class="kbf-activity-empty">Nothing yet — activity shows up here while the agent works.</div>'; return; }
  box.innerHTML = S.activity.slice().reverse().map((e) => {
    const t = new Date(e.at);
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    const lbl = e.commentId ? pinLabel(e.commentId) : '';
    return `<div class="kbf-act is-${escapeHtml(e.kind)}"><span class="kbf-act-time">${hh}</span><span class="kbf-act-icon" aria-hidden="true">${ACT_ICON[e.kind] || '·'}</span><span class="kbf-act-text">${escapeHtml(activityText(e))}</span>${lbl ? `<button type="button" class="kbf-act-link" data-id="${escapeHtml(e.commentId)}">${escapeHtml(lbl)}</button>` : ''}</div>`;
  }).join('');
}

// Tab title + favicon: "⚙ #3 · Page" while working, "✓ Page" after the agent
// finished something while the tab was hidden. The host page owns its title;
// we only prefix it, and re-read the base whenever the host changes it.
const TAB_RE = /^(⚙ [^·]+ · |✓ )/;

function setTabState() {
  const cur = document.title;
  if (!TAB_RE.test(cur)) S.baseTitle = cur;
  const working = S.agent.state === 'working';
  let prefix = '';
  if (working) prefix = '⚙ ' + (S.agent.commentId ? (pinLabel(S.agent.commentId).split(' on ')[0] || '…') : '…') + ' · ';
  else if (S.tabDone) prefix = '✓ ';
  const want = prefix + S.baseTitle;
  if (document.title !== want) document.title = want;
  setFavicon(working ? 'amber' : S.tabDone ? 'green' : null);
}

function setFavicon(color) {
  let link = document.querySelector('link[rel~="icon"]');
  if (!color) {
    if (S.favOrig !== null && link) { if (S.favOrig) link.href = S.favOrig; else link.remove(); S.favOrig = null; }
    return;
  }
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); if (S.favOrig === null) S.favOrig = ''; }
  else if (S.favOrig === null) S.favOrig = link.getAttribute('href') || '';
  const fill = color === 'amber' ? '%23c98a2b' : '%232f9e6a';
  link.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='${fill}'/%3E%3C/svg%3E`;
}

export function initPresence() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tabDone) { S.tabDone = false; setTabState(); } });
  $('kbf-activity-btn').addEventListener('click', () => {
    S.activityOpen = !S.activityOpen;
    if (S.activityOpen) S.activityUnread = 0;
    renderActivity();
  });
  $('kbf-activity').addEventListener('click', (e) => {
    const b = e.target.closest('.kbf-act-link');
    if (b) focusOrOpen(b.dataset.id);
  });
  $('kbf-agent-chip').addEventListener('click', () => { if (S.agent.state === 'working' && S.agent.commentId) focusOrOpen(S.agent.commentId); });
}
