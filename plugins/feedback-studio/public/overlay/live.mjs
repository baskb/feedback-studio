// Feedback Studio — live updates: the server-sent event stream, and the
// agent-requested page reload.

import { S, API, ROOT, MODE, SOURCE, SS, normalizePath, scopeComments } from '/__feedback/overlay/state.mjs';
import { $, root, toast, toastError } from '/__feedback/overlay/ui.mjs';
import { refresh, renderPanel } from '/__feedback/overlay/panel.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { applyAgentStatus, pushActivity, renderActivity, renderAgentChip } from '/__feedback/overlay/presence.mjs';

function animateResolve(id) {
  const p = S.placed.find((x) => x.comment.id === id);
  if (p) { p.pinEl.classList.add('kbf-just-resolved'); setTimeout(() => p.pinEl.classList.remove('kbf-just-resolved'), 1000); }
}

export function applyComments(next) {
  next = scopeComments(next);
  const prev = new Map(S.comments.map((c) => [c.id, c.status]));
  S.comments = next;
  refresh();
  next.filter((c) => normalizePath(c.page) === S.page && c.status === 'resolved' && prev.get(c.id) && prev.get(c.id) !== 'resolved')
    .forEach((c) => animateResolve(c.id));
}

// The agent finished a batch and wants the page to show its edits under the
// now-green pins. Reload — but NEVER yank the page out from under in-progress
// work: if a composer, a variant preview, the touch picker, or a focused text
// field is open, defer and surface a one-tap "Reload" toast instead. The panel
// open/mode/filter state survives the reload (kept in sessionStorage), so it
// feels seamless. A brief delay lets the green-pin flip register first.
function reloadIsUnsafe() {
  // Never yank the page out from under an in-progress flow — narration, the
  // spoken-draft review tray, or a walkthrough would all lose unsaved state.
  if (S.activeComposer || S.variantPreview || S.pickChain.length) return true;
  if (S.narrating || S.draftTray || S.walkState) return true;
  const a = root.activeElement || document.activeElement;
  if (a && (/^(input|textarea|select)$/i.test(a.nodeName) || a.isContentEditable)) return true;
  return false;
}
function doReload() { S.reloadPending = false; try { location.reload(); } catch (e) {} }
function requestReload() {
  if (S.reloadPending) return;
  S.reloadPending = true;
  if (reloadIsUnsafe()) {
    // don't interrupt: offer it, and also auto-apply once the work is dismissed
    toast(t('Page updated by your agent'), { actionLabel: t('Reload now'), duration: 8000, onAction: doReload });
    const iv = setInterval(() => { if (!reloadIsUnsafe()) { clearInterval(iv); doReload(); } }, 1000);
    // Give up after a minute (the toast still stands), but let the NEXT reload
    // request from the agent start over instead of being ignored for good.
    setTimeout(() => { clearInterval(iv); S.reloadPending = false; }, 60000);
    return;
  }
  toast(t('Applying your agent’s edits — reloading…'), { duration: 1200 });
  setTimeout(doReload, 700);
}
export { requestReload };

// The round counter changed (someone started a new round): remember it and
// redraw so the "This round" chip and the round tags on cards follow.
export function applyRound(d) {
  if (!d || !Number.isFinite(Number(d.round))) return;
  const was = S.round;
  S.round = Number(d.round);
  S.roundStartedAt = d.startedAt || '';
  if (S.panelOpen) renderPanel();
  if (was !== S.round && was) emit('round:changed', S.round);
}

// Markdown mode: the reviewed .md changed on disk (the agent edited it, or an
// older version was put back). Say so, offer the diff, and reload the page
// when that is safe so the text on screen is the current text. The note
// survives the reload (sessionStorage) so the offer is still there after it.
function onSourceChanged(d) {
  if (MODE !== 'md' || !d || d.file !== SOURCE) return;
  const note = { n: d.version, a: d.added || 0, r: d.removed || 0 };
  SS.set('kbf-source-changed', JSON.stringify(note));
  emit('source:changed', note);
  requestReload();
}
// After a load: if the last reload was caused by a change on disk, offer the diff.
export function offerSourceChange() {
  let note = null;
  try { note = JSON.parse(SS.get('kbf-source-changed') || 'null'); } catch (e) {}
  if (!note) return;
  SS.remove('kbf-source-changed');
  emit('source:changed', note);
}

export function subscribeLive() {
  if (typeof EventSource === 'undefined') return;
  try { S.es = new EventSource(ROOT + '/events'); }
  catch (e) { scheduleResubscribe(); return; }
  const es = S.es;
  es.addEventListener('comments', (e) => {
    S.sseBackoff = 1000;
    try { const d = JSON.parse(e.data); if (d && Array.isArray(d.comments)) applyComments(d.comments); } catch (err) {}
  });
  es.addEventListener('agent-status', (e) => {
    try { const d = JSON.parse(e.data); if (d && d.agent) applyAgentStatus(d.agent); } catch (err) {}
  });
  es.addEventListener('activity-log', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d && Array.isArray(d.activity)) { S.activity = d.activity.slice(-100); S.activityUnread = 0; renderActivity(); renderAgentChip(); const row = $('kbf-agent-row'); if (row && S.activity.length) row.hidden = false; }
    } catch (err) {}
  });
  es.addEventListener('activity', (e) => {
    try { const d = JSON.parse(e.data); if (d && d.entry) pushActivity(d.entry); } catch (err) {}
  });
  es.addEventListener('reload', () => requestReload());
  es.addEventListener('round', (e) => { try { applyRound(JSON.parse(e.data)); } catch (err) {} });
  es.addEventListener('source', (e) => { try { onSourceChanged(JSON.parse(e.data)); } catch (err) {} });
  es.addEventListener('store-error', (e) => {
    // Server-sent application error (its own event name, so it never collides
    // with EventSource's built-in connection 'error') — e.g. the comments file
    // became unreadable. Surface it rather than letting the panel go stale.
    try { if (e && e.data && JSON.parse(e.data).error === 'ECORRUPT') toastError(t('Comments file unreadable — check .feedback/comments.json')); } catch (err) {}
  });
  es.onopen = () => { S.sseBackoff = 1000; resync(); };
  es.onerror = () => {
    // EventSource silently auto-retries transient blips; it does NOT recover
    // from a terminal close (proxy idle-timeout, dev-server restart). Handle
    // that ourselves with capped backoff and a full resync on reconnect.
    if (S.es && S.es.readyState === EventSource.CLOSED) {
      try { S.es.close(); } catch (e) {}
      S.es = null;
      // No stream = no truth about the agent. Say offline rather than keep a
      // stale "working on #3" on screen; the reconnect re-sends presence.
      if (S.agent.state !== 'offline') applyAgentStatus({ state: 'offline' });
      scheduleResubscribe();
    }
  };
}

function scheduleResubscribe() {
  const wait = Math.min(S.sseBackoff, 15000);
  S.sseBackoff = Math.min(S.sseBackoff * 2, 15000);
  setTimeout(subscribeLive, wait);
}

async function resync() {
  try {
    const res = await fetch(API + '/comments');
    const data = await res.json();
    if (data && Array.isArray(data.comments)) applyComments(data.comments);
    if (data && data.round) applyRound({ round: data.round, startedAt: data.roundStartedAt });
  } catch (e) {}
}
