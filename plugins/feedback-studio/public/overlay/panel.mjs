// Feedback Studio — the review panel (the "List"): every comment on every page,
// its conversation thread, and the actions on it.

import {
  S, MODE, API, ROLE, CAN_COMMENT, CAN_MANAGE, SS, LS,
  normalizePath, isOpenC, lastTouch, filtered, agentRepliedAfter,
  agentName, fmtDur, activityText, walkComments,
} from '/__feedback/overlay/state.mjs';
import {
  I, root, host, panel, listEl, subEl, countEl, readyEl,
  escapeHtml, timeAgo, autoGrow, panelIsFullScreen, revealEl, flashEl, flashCard, toast, toastError, $, trapFocus,
} from '/__feedback/overlay/ui.mjs';
import { norm, resolveAnchor, buildElementAnchor } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { renderPins, schedulePos } from '/__feedback/overlay/pins.mjs';
import { setMode, pickElement } from '/__feedback/overlay/mode.mjs';
import { openComposer } from '/__feedback/overlay/composer.mjs';
import { TWEAK_STYLE_ID } from '/__feedback/overlay/tweaks.mjs';

export function setPanel(open) {
  const was = S.panelOpen;
  S.panelOpen = open;
  SS.set('kbf-panel', open ? '1' : '0');
  panel.classList.toggle('is-open', open);
  const tb = $('kbf-toggle-panel');
  if (tb) { tb.setAttribute('aria-expanded', open ? 'true' : 'false'); tb.classList.toggle('is-active', open); } // stay expanded while the panel is open
  if (open) renderPanel();
  applyPanelShift(open, false);
  // Keyboard focus: on a phone the panel covers the page, so Tab stays inside
  // it while it is open; on a desktop it sits beside the page and only takes
  // focus (the region itself, no ring) so a screen reader announces it. On
  // close, focus goes back to the button that opened it.
  if (open && !was) {
    if (S.panelRelease) S.panelRelease();
    S.panelRelease = panelIsFullScreen() ? trapFocus(panel) : null;
    try { panel.focus({ preventScroll: true }); } catch (e) {}
  } else if (!open && was) {
    const cur = root.activeElement;
    const inside = cur && panel.contains(cur);
    if (S.panelRelease) { S.panelRelease(); S.panelRelease = null; }
    else if (inside && tb) { try { tb.focus({ preventScroll: true }); } catch (e) {} }
  }
}

// --md only: the doc shell re-centres the article beside the open panel
// (html.kbf-panel-open -> body padding-right). Web pages are never touched.
export function applyPanelShift(open, instant) {
  if (MODE !== 'md') return;
  const de = document.documentElement;
  if (instant) de.classList.add('kbf-shift-instant');
  de.classList.toggle('kbf-panel-open', open);
  // A timer, not rAF: a tab opened in the background gets no frames, and the
  // class must not stay on (it would turn every later toggle into a jump).
  if (instant) { setTimeout(() => de.classList.remove('kbf-shift-instant'), 100); return; }
  // The padding animates for 280ms and fires neither scroll nor resize, so
  // pump the positioner across the move instead of letting pins jump at the
  // end. A background tab freezes the transition clock (it runs later, when
  // the tab is shown), so transitionend re-measures once more to be sure.
  const until = performance.now() + 340;
  (function pump() { schedulePos(); if (performance.now() < until) requestAnimationFrame(pump); })();
  if (!applyPanelShift._bound) {
    applyPanelShift._bound = true;
    document.body.addEventListener('transitionend', (e) => { if (e.target === document.body && e.propertyName === 'padding-right') schedulePos(); });
  }
}

export function setFilter(f) {
  S.filter = f;
  SS.set('kbf-filter', f);
  renderPanel();
  renderPins();
}

export function renderPanel() {
  root.querySelectorAll('.kbf-filter').forEach((b) => {
    const on = b.dataset.filter === S.filter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const open = S.comments.filter(isOpenC).length;
  const agentOpen = S.comments.filter((c) => c.author === 'agent' && c.status === 'open').length;
  subEl.textContent = `${S.comments.length} comment${S.comments.length === 1 ? '' : 's'} · ${open} open`
    + (agentOpen ? ` · ${agentOpen} from your agent to review` : '');

  // Newest activity first: a fresh comment OR a fresh reply/status change
  // floats its card to the top, so a long list never needs scrolling to find
  // what just happened. Sorts a copy — the `comments` array keeps creation
  // order because pin numbers (pageIndex below) are derived from it.
  const view = filtered(S.comments).slice().sort((a, b) => lastTouch(b).localeCompare(lastTouch(a)));
  if (!view.length) {
    listEl.innerHTML = `<div class="kbf-empty">${I.empty}<p>${S.comments.length ? 'Nothing in this filter.' : 'No comments yet.<br>Turn on Point mode and click anything on the page.<br><span class="kbf-empty-kbd">Press <kbd>P</kbd> to toggle Point mode.</span>'}</p></div>`;
    return;
  }

  // group by page, current page first
  const groups = new Map();
  for (const c of view) {
    const key = normalizePath(c.page);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  // Current page first; other pages by their newest activity (each group's
  // first card is its newest, because `view` is already sorted).
  const keys = [...groups.keys()].sort((a, b) => (a === S.page ? -1 : b === S.page ? 1
    : lastTouch(groups.get(b)[0]).localeCompare(lastTouch(groups.get(a)[0]))));

  // index map per page for pin numbers (based on full page list, not filtered)
  const pageIndex = new Map();
  for (const c of S.comments) {
    const k = normalizePath(c.page);
    if (!pageIndex.has(k)) pageIndex.set(k, []);
    pageIndex.get(k).push(c.id);
  }

  let html = '';
  for (const key of keys) {
    const here = key === S.page;
    html += `<div class="kbf-group-label">${escapeHtml(key)}${here ? '<span class="kbf-here">this page</span>' : ''}</div>`;
    for (const c of groups.get(key)) {
      const num = (pageIndex.get(key).indexOf(c.id)) + 1;
      const anchorTxt = norm(c.anchor && (c.anchor.snippet || c.anchor.rangeText)) || ('<' + (c.anchor?.tag || 'element') + '>');
      const st = c.status || 'open';
      const ct = c.type || 'comment';
      const isAgent = c.author === 'agent';
      // Unnamed user comments read "you" ONLY in the single-viewer (full) case;
      // on shared panels they're the host's — labelling them "you" for every
      // viewer would misattribute them.
      const who = isAgent ? (c.authorName || 'agent') : (c.authorName || (ROLE === 'full' ? 'you' : 'host'));
      const thread = Array.isArray(c.thread) ? c.thread : [];
      const expanded = c.id === S.expandedId;
      // Anchor health, from the last pin pass (current page only — other
      // pages' anchors can't be resolved from here). Only comments still
      // awaiting action warn: a resolved comment's element USUALLY changed —
      // that's the fix having landed, not a bad pin.
      const pc = here && (st === 'open' || st === 'approved') ? S.pinConf.get(c.id) : undefined;
      const pinState = pc === 'lost' ? 'lost' : (pc === 'medium' || pc === 'low') ? 'shaky' : null;
      // The agent replied after the comment and the pinned text no longer
      // matches, but the element is still found by position: almost always
      // an applied change that was never resolved. A LOST pin is never
      // explained away like this: it stays "pin lost".
      const changedAfterReply = pinState === 'shaky' && agentRepliedAfter(c);
      // Live agent state for this card: being worked on now, queued next, or
      // just finished (the "done" entry stays visible for a few minutes).
      const working = S.agent.state === 'working' && S.agent.commentId === c.id;
      const queued = !working && S.agent.queue.includes(c.id);
      const doneEntry = !working ? S.activity.slice().reverse().find((e) => e.commentId === c.id && (e.kind === 'done' || e.kind === 'idle') && Date.now() - e.at < 5 * 60000) : null;
      const lastAct = working ? S.activity.slice().reverse().find((e) => e.commentId === c.id && e.kind !== 'claim') : null;
      const stateClass = [
        st === 'resolved' ? 'is-resolved' : '', st === 'approved' ? 'is-approved' : '',
        st === 'rejected' ? 'is-rejected' : '', isAgent ? 'is-agent' : '', expanded ? 'is-expanded' : '',
        working ? 'is-working' : '', queued ? 'is-queued' : '',
      ].filter(Boolean).join(' ');
      html += `
        <div class="kbf-card ${stateClass}" data-id="${c.id}" data-page="${escapeHtml(key)}" data-url="${escapeHtml(c.url || '')}">
          <div class="kbf-card-top">
            <span class="kbf-badge">${isAgent ? I.bot : num}</span>
            <span class="kbf-type-tag kbf-type-${ct}">${ct}</span>
            <span class="kbf-author ${isAgent ? 'is-agent' : ''}">${escapeHtml(who)}</span>
            ${st === 'approved' || st === 'rejected' ? `<span class="kbf-status kbf-status-${st}">${st}</span>` : ''}
            ${changedAfterReply ? `<span class="kbf-pinstate is-changed" title="The pinned text changed after the agent replied. If the change is what you asked for, resolve the comment (✓) and the pin turns green; otherwise re-pin it.">changed after reply</span>` : pinState ? `<span class="kbf-pinstate is-${pinState}" title="${pinState === 'lost' ? 'The pinned element could not be found on this page.' : 'The pinned element was only found with weak confidence — the agent will refuse to edit it.'}">${pinState === 'lost' ? 'pin lost' : 'pin unsure'}</span>` : ''}
            <span class="kbf-card-anchor" title="${escapeHtml(anchorTxt)}">${escapeHtml(anchorTxt)}</span>
          </div>
          ${working ? `<div class="kbf-card-work"><span class="kbf-agent-dot"></span><span>${escapeHtml(agentName())} is on this · <span class="kbf-elapsed" data-since="${Number(S.agent.since) || Date.now()}">${fmtDur(Date.now() - (Number(S.agent.since) || Date.now()))}</span>${S.agent.note ? ' · ' + escapeHtml(S.agent.note) : (lastAct ? ' · ' + escapeHtml(activityText(lastAct)) : '')}</span></div>` : ''}
          ${queued ? `<div class="kbf-card-work is-queued"><span class="kbf-agent-dot"></span><span>next up for ${escapeHtml(agentName())}</span></div>` : ''}
          ${doneEntry ? `<div class="kbf-card-work is-done"><span class="kbf-agent-dot"></span><span>${escapeHtml(agentName())}: ${escapeHtml(activityText(doneEntry))}</span></div>` : ''}
          ${c.text ? `<div class="kbf-card-text">${escapeHtml(c.text)}</div>` : ''}
          ${c.textEdit && c.textEdit.after ? `<div class="kbf-card-textedit" title="${escapeHtml((c.textEdit.before || '') + ' → ' + c.textEdit.after)}"><del>${escapeHtml(c.textEdit.before || '')}</del><ins>${escapeHtml(c.textEdit.after)}</ins></div>` : ''}
          ${Array.isArray(c.edits) && c.edits.length ? `<div class="kbf-card-edits">${c.edits.map((ed) => `
            <span class="kbf-edit-chip" title="${escapeHtml(ed.prop + ': ' + (ed.from || '?') + ' → ' + ed.to)}"><b>${escapeHtml(ed.prop)}</b>${/^#[0-9a-f]{6}$/i.test(ed.to) ? `<i class="kbf-edit-dot" style="background:${escapeHtml(ed.to)}"></i>` : ''}<span>${escapeHtml((ed.from || '?') + ' → ' + ed.to)}</span></span>`).join('')}</div>` : ''}
          ${c.imageReplace && c.imageReplace.media ? `<div class="kbf-card-imgrep"><img class="kbf-card-newimg" data-act="newimg" tabindex="0" role="button" src="${API}/media/${c.id}" alt="Replacement image — open full size" title="New image — click to open" loading="lazy"><span class="kbf-card-imglabel">${I.image} replaces the ${c.imageReplace.target === 'background' ? 'background' : 'image'}${c.imageReplace.fit ? ` · ${escapeHtml(c.imageReplace.fit)}` : ''}</span></div>` : ''}
          ${expanded ? `
            ${c.shot ? `<img class="kbf-card-shot" data-act="shot" tabindex="0" role="button" src="${API}/shot/${c.id}" alt="Element screenshot at pin time — open full size" title="What this looked like when pinned — click to open" loading="lazy">` : ''}
            ${thread.length ? `<div class="kbf-thread">${thread.map((r) => `
              <div class="kbf-reply ${r.author === 'agent' ? 'is-agent' : ''}">
                <span class="kbf-reply-who">${escapeHtml(r.author === 'agent' ? (r.authorName || 'agent') : (r.authorName || (ROLE === 'full' ? 'you' : 'host')))}</span>
                <span class="kbf-reply-text">${escapeHtml(r.text)}</span>
                ${Array.isArray(r.variants) && r.variants.length ? `
                  <button type="button" class="kbf-vpreview" data-act="variants" data-reply="${escapeHtml(r.id)}">${I.eye}<span>Try ${r.variants.length} option${r.variants.length === 1 ? '' : 's'} on the page</span></button>` : ''}
                ${r.pick ? `<span class="kbf-vpicked">${I.check} Picked: ${escapeHtml(r.pick.label || ('#' + (r.pick.index + 1)))}</span>` : ''}
              </div>`).join('')}</div>` : ''}
            ${CAN_COMMENT ? `<div class="kbf-replybox">
              <textarea class="kbf-reply-input" placeholder="Reply to this thread…" rows="1"></textarea>
              <button class="kbf-reply-send" data-act="send" title="Send reply">${I.send}</button>
            </div>` : ''}
            ${CAN_MANAGE ? `<div class="kbf-approvals">
              ${st !== 'approved' ? `<button class="kbf-chip-btn kbf-approve" data-act="approve">${I.check} Approve</button>` : ''}
              ${st !== 'rejected' ? `<button class="kbf-chip-btn kbf-rejectb" data-act="reject">${I.reject} Reject</button>` : ''}
            </div>` : ''}
          ` : (thread.length ? `<button class="kbf-thread-toggle" data-act="thread">${I.comment}<span>${thread.length} repl${thread.length === 1 ? 'y' : 'ies'}</span></button>` : '')}
          ${pinState && CAN_MANAGE ? `<button type="button" class="kbf-chip-btn kbf-repin" data-act="repin">${I.jump}<span>Re-pin on the page</span></button>` : ''}
          <div class="kbf-card-foot">
            <span class="kbf-time">${timeAgo(c.createdAt)}</span>
            <button class="kbf-mini" data-act="jump" title="Go to element">${I.jump}</button>
            ${CAN_MANAGE ? `
            <button class="kbf-mini" data-act="edit" title="Edit">${I.edit}</button>
            <button class="kbf-mini kbf-mini--ok ${st === 'resolved' ? 'is-done' : ''}" data-act="resolve" title="${st === 'resolved' ? 'Reopen' : 'Resolve'}">${I.check}</button>
            <button class="kbf-mini kbf-mini--danger" data-act="delete" title="Delete">${I.trash}</button>` : ''}
          </div>
        </div>`;
    }
  }
  // Preserve reply-box focus + caret across the re-render (an SSE push or a
  // reply sent elsewhere shouldn't yank the cursor out mid-sentence).
  const active = root.activeElement;
  let restore = null;
  if (active && active.classList && active.classList.contains('kbf-reply-input')) {
    const card = active.closest('.kbf-card');
    restore = { id: card && card.dataset.id, start: active.selectionStart, end: active.selectionEnd };
  }

  listEl.innerHTML = html;

  // restore an in-progress reply draft for the expanded card
  if (S.expandedId) {
    const ta = root.querySelector('.kbf-card[data-id="' + S.expandedId + '"] .kbf-reply-input');
    if (ta && S.replyDrafts[S.expandedId]) {
      ta.value = S.replyDrafts[S.expandedId];
      autoGrow(ta, 120);
    }
  }
  // restore focus + caret if a reply box was focused before this re-render…
  if (restore && restore.id) {
    const ta = root.querySelector('.kbf-card[data-id="' + restore.id + '"] .kbf-reply-input');
    if (ta) { ta.focus(); try { ta.setSelectionRange(restore.start, restore.end); } catch (e) {} }
  } else if (S.focusReplyNext && S.expandedId) {
    // …or focus it once, right after an explicit expand
    const ta = root.querySelector('.kbf-card[data-id="' + S.expandedId + '"] .kbf-reply-input');
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
  }
  S.focusReplyNext = false;
}

function toggleExpand(c) {
  S.expandedId = S.expandedId === c.id ? null : c.id;
  S.focusReplyNext = !!S.expandedId;
  renderPanel();
  if (S.expandedId && normalizePath(c.page) === S.page) {
    // Say so when there is nothing to scroll to, instead of silently staying
    // put: a resolved "delete" comment's text is gone by design.
    if (!focusComment(c.id, false)) toast(c.status === 'resolved' || c.status === 'rejected'
      ? 'That text is no longer in the document — nothing to scroll to.'
      : "Couldn't locate this element on the page — it may need a re-pin.");
  }
}

// A comment's stored `url` comes from the API and could be anything; only ever
// navigate to a SAME-ORIGIN http(s) target, so a `javascript:`/`data:` url (or
// an off-origin link, e.g. a tunnel-era URL clicked from localhost) can't turn
// "Go to element" into script execution or an unexpected origin hop. Anything
// else falls back to the same-origin page path.
function safeNavUrl(url, fallback) {
  if (!url) return fallback;
  try {
    const u = new URL(url, location.href);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin) return u.href;
  } catch (e) {}
  return fallback;
}
function goToComment(c) {
  const key = normalizePath(c.page);
  if (key === S.page) {
    if (panelIsFullScreen()) setPanel(false);
    const found = focusComment(c.id, false);
    if (!found) toast("Couldn't locate this element on the page — it may need a re-pin.");
  } else {
    SS.set('kbf-focus', c.id);
    SS.set('kbf-panel', panelIsFullScreen() ? '0' : '1');
    location.href = safeNavUrl(c.url, location.origin + key);
  }
}

export function focusComment(id, openPanel) {
  const p = S.placed.find((x) => x.comment.id === id);
  if (openPanel) setPanel(true);
  // The card first: scrolling the List is instant, and doing it AFTER the
  // page's smooth scroll would cancel that animation mid-way.
  const card = root.querySelector('.kbf-card[data-id="' + id + '"]');
  if (card) { card.scrollIntoView({ block: 'nearest' }); flashCard(card); }
  if (p) {
    revealEl(p.el);
    p.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashEl(p.el);
    root.querySelectorAll('.kbf-pin').forEach((pin) => pin.classList.remove('is-active'));
    p.pinEl.classList.add('is-active');
    setTimeout(() => p.pinEl.classList.remove('is-active'), 1600);
  }
  return !!p; // whether the element was found on the page
}

// Jump to a comment on this page, or open the page that has it.
export function focusOrOpen(id) {
  if (focusComment(id, true)) return;
  const c = S.comments.find((x) => x.id === id);
  if (c && c.url && normalizePath(c.page) !== S.page) location.href = c.url;
}

function editFromCard(c) {
  const el = resolveAnchor(c.anchor);
  const rect = el ? el.getBoundingClientRect() : { left: window.innerWidth / 2 - 170, right: 0, top: 120, bottom: 140 };
  if (el) { revealEl(el); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  setTimeout(() => openComposer({ kind: 'edit', anchor: c.anchor, rect: (el ? el.getBoundingClientRect() : rect), comment: c, el }), el ? 260 : 0);
}

async function toggleResolve(c) {
  await setStatus(c, c.status === 'resolved' ? 'open' : 'resolved');
}

// Re-anchor an existing comment on a freshly clicked element. This is the
// fix for a 'shaky'/'lost' pin: the REVIEWER points again, the anchor is
// rebuilt from scratch (same path a new comment takes), and the agent gets a
// trustworthy target instead of hitting a refuse-and-ask later.
function startRepin(c) {
  // Point mode's own pointerup handler would open a NEW composer on the very
  // element the reviewer just re-pinned (it runs a tick later than our click
  // listener). Leave Point mode for the duration and come back to it after.
  const wasMode = S.mode;
  if (wasMode) setMode(false);
  setPanel(false);
  toast('Click the element this comment is about (Esc cancels)', { duration: 5000 });
  pickElement(async (el) => {
    if (wasMode) setMode(true); // restores Point mode and its crosshair cursor
    if (el instanceof Element && el !== document.body) {
      try {
        const data = await api('/comments/' + c.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor: buildElementAnchor(el) }),
        });
        const i = S.comments.findIndex((x) => x.id === c.id);
        if (i >= 0) S.comments[i] = data.comment;
        renderPins();
        toast('Pin moved.');
      } catch (err) { toastError('Could not move the pin — ' + err.message); }
    }
    setPanel(true);
  });
}

async function setStatus(c, status) {
  try {
    const data = await api('/comments/' + c.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    });
    const i = S.comments.findIndex((x) => x.id === c.id);
    if (i >= 0) S.comments[i] = data.comment;
    refresh();
    toast(status === 'resolved' ? 'Marked resolved' : status === 'open' ? 'Reopened'
      : status === 'approved' ? 'Approved — your agent can implement it' : 'Rejected');
  } catch (e) { toastError('Update failed — ' + e.message); }
}

async function sendReply(id) {
  const text = (S.replyDrafts[id] || '').trim();
  if (!text) return;
  try {
    const data = await api('/comments/' + id + '/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', text, authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '' }),
    });
    const i = S.comments.findIndex((c) => c.id === id);
    if (i >= 0) S.comments[i] = data.comment;
    delete S.replyDrafts[id];
    S.expandedId = id;
    refresh();
    toast('Reply sent');
  } catch (e) { toastError('Reply failed — ' + e.message); }
}

function deleteComment(id) {
  const idx = S.comments.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const removed = S.comments[idx];
  // Optimistic: drop locally now, defer the server delete so Undo can cancel it.
  S.comments.splice(idx, 1);
  S.pendingDeletes.add(id);
  if (S.expandedId === id) S.expandedId = null;
  refresh();
  const timer = setTimeout(async () => {
    try { await api('/comments/' + id, { method: 'DELETE' }); }
    catch (e) {
      // Server delete failed — restore so we don't silently lose data.
      // (A 404 means it's already gone server-side; restoring would resurrect
      // a phantom, so only restore on other failures.)
      if (!/not found/i.test(e.message) && !S.comments.some((c) => c.id === id)) {
        S.comments.splice(Math.min(idx, S.comments.length), 0, removed); refresh();
        toastError('Delete failed — ' + e.message);
      }
    } finally { S.pendingDeletes.delete(id); }
  }, 5000);
  toast('Comment deleted', { actionLabel: 'Undo', duration: 5000, onAction: () => {
    clearTimeout(timer);
    S.pendingDeletes.delete(id);
    if (!S.comments.some((c) => c.id === id)) { S.comments.splice(Math.min(idx, S.comments.length), 0, removed); refresh(); }
  } });
}

function updateCount() {
  const open = S.comments.filter(isOpenC).length;
  countEl.textContent = open ? String(open) : '';
  if (readyEl) {
    readyEl.textContent = !S.comments.length ? 'No comments yet'
      : open ? `${open} comment${open === 1 ? '' : 's'} ready for your agent`
      : 'All resolved';
  }
}

export function refresh() {
  renderPins();
  if (S.panelOpen) renderPanel();
  updateCount();
  // Offer the "walk me through the changes" tour only once the agent has
  // actually replied to something (i.e. there's a walkthrough to narrate).
  const wb = $('kbf-walk');
  if (wb) wb.style.display = walkComments().length ? '' : 'none';
}

// In proxied SPAs / HMR the host page swaps its DOM on route changes: anchored
// elements detach and pins read zeros with no recovery until a full reload.
// Re-resolve (debounced) when the page mutates, and re-attach our host if the
// host page removed it. Shadow-DOM mutations are encapsulated, so our own pin
// updates don't trigger this.
export function startDomObserver() {
  if (typeof MutationObserver === 'undefined') return;
  // Our own tweak-preview <style> writes (insert/remove in <head>, textContent
  // swaps on the tag) are not page mutations — ignoring them keeps every knob
  // change from scheduling a pointless full pin re-resolve.
  const isTweakNoise = (m) => (m.target && m.target.id === TWEAK_STYLE_ID)
    || (m.target === document.head
      && [...m.addedNodes, ...m.removedNodes].every((n) => n && n.id === TWEAK_STYLE_ID));
  const obs = new MutationObserver((muts) => {
    if (!muts.some((m) => !host.contains(m.target) && !isTweakNoise(m))) return; // all ours
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    clearTimeout(S.moTimer);
    S.moTimer = setTimeout(() => { renderPins(); if (S.panelOpen) renderPanel(); }, 200);
  });
  try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
}

export function initPanel() {
  listEl.addEventListener('input', (e) => {
    if (e.target.classList.contains('kbf-reply-input')) {
      const card = e.target.closest('.kbf-card'); // the draft belongs to ITS card, whichever is expanded
      S.replyDrafts[(card && card.dataset.id) || S.expandedId] = e.target.value;
      autoGrow(e.target, 120);
    }
  });
  listEl.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('kbf-reply-input') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const card = e.target.closest('.kbf-card');
      if (card) sendReply(card.dataset.id);
      return;
    }
    if (e.target.dataset && e.target.dataset.act === 'shot' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const card = e.target.closest('.kbf-card');
      if (card) window.open(API + '/shot/' + card.dataset.id, '_blank', 'noopener');
    }
  });

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.kbf-card');
    if (!card) return;
    const id = card.dataset.id;
    const c = S.comments.find((x) => x.id === id);
    if (!c) return;
    if (e.target.closest('.kbf-reply-input')) return;
    const actBtn = e.target.closest('[data-act]');
    const act = actBtn && actBtn.dataset.act;
    if (act === 'delete') return deleteComment(id);
    if (act === 'resolve') return toggleResolve(c);
    if (act === 'edit') return editFromCard(c);
    if (act === 'thread') return toggleExpand(c);
    if (act === 'send') return sendReply(id);
    if (act === 'approve') return setStatus(c, 'approved');
    if (act === 'reject') return setStatus(c, 'rejected');
    if (act === 'jump') return goToComment(c);
    if (act === 'repin') return startRepin(c);
    if (act === 'shot') { window.open(API + '/shot/' + c.id, '_blank', 'noopener'); return; }
    if (act === 'newimg') { window.open(API + '/media/' + c.id, '_blank', 'noopener'); return; }
    if (act === 'variants') {
      const r = (c.thread || []).find((x) => x.id === actBtn.dataset.reply);
      if (r && Array.isArray(r.variants) && r.variants.length) emit('variants:open', { comment: c, reply: r });
      return;
    }
    // default: click on the card body toggles the conversation thread
    toggleExpand(c);
  });
}
