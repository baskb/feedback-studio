// Feedback Studio — bring back what was being typed when the page reloaded.
//
// composer.mjs keeps the open comment box in this tab's sessionStorage on every
// change, and panel.mjs does the same for half-written replies. After a load,
// this module puts them back (lib/drafts.mjs holds the rules):
//
//   - a new comment whose spot is found again with HIGH confidence: the
//     comment box reopens there, with its words, type and photos;
//   - one whose spot is not found that surely (the agent may just have changed
//     the very thing it was about): the "needs a spot" tray, never a guess;
//   - an edit: the edit box reopens while that comment still exists;
//   - a reply: its card opens again in the List, text in the reply box.

import { S, SS, SOURCE } from '/__feedback/overlay/state.mjs';
import { DRAFT_KEY, HELD_KEY, readDraft, restoreRoute, readHeld, packHeld } from '/__feedback/lib/drafts.mjs';
import { makePool, resolveWithConfidence } from '/__feedback/overlay/dom.mjs';
import { toast, revealEl } from '/__feedback/overlay/ui.mjs';
import { openComposer } from '/__feedback/overlay/composer.mjs';
import { openDraftTray } from '/__feedback/overlay/narrate.mjs';
import { renderPanel } from '/__feedback/overlay/panel.mjs';
import { t, tn } from '/__feedback/overlay/i18n.mjs';

// A dev server's page may still be filling in just after the load: look again
// a few times before deciding a spot is gone.
const TRIES_MS = [0, 400, 1200, 2500];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Something the reviewer started since the load: never open a box over it.
const busy = () => !!(S.activeComposer || S.narrating || S.draftTray || S.walkState || S.pickChain.length || S.variantPreview);

function resolveNow(anchor) {
  try { return resolveWithConfidence(anchor, makePool()); } catch (e) { return { el: null, confidence: null }; }
}

async function findSpot(anchor) {
  let found = { el: null, confidence: null };
  let prev = 0;
  for (const ms of TRIES_MS) {
    await wait(ms - prev);
    prev = ms;
    found = resolveNow(anchor);
    if (found.el && found.confidence === 'high') break;
  }
  return found;
}

const restoreOf = (d) => ({ text: d.text, type: d.type, typePicked: d.typePicked, photos: d.photos });

function backToast(d) {
  const lost = d.lost || {};
  toast(lost.tweaks || lost.textEdit || lost.image
    ? t('Your unsent comment is back. Changes you made on the page itself (style, text, image) could not be kept; make them again.')
    : t('Your unsent comment is back'), { duration: 4500 });
}

function reopen(d, anchor, el, extra) {
  let rect = { left: window.innerWidth / 2 - 170, right: 0, top: 120, bottom: 140 };
  if (el) {
    revealEl(el);
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    rect = el.getBoundingClientRect();
  }
  openComposer({ kind: d.kind, anchor, rect, el: el || undefined, restore: restoreOf(d), ...extra });
  backToast(d);
}

// ---------- the tray of drafts that need a spot ----------
const trayWords = {
  heading: (n) => tn('{n} unsent comment needs a spot', '{n} unsent comments need a spot', n),
  sub: (n) => tn('The page changed while you typed and its spot was not found again — point at the element',
    'The page changed while you typed and their spots were not found again — point at the element', n),
};

function openTray(drafts, others) {
  if (!drafts.length) return;
  const alive = new Set(drafts);
  const write = () => {
    const raw = packHeld([...others, ...alive]);
    if (raw) SS.set(HELD_KEY, raw); else SS.remove(HELD_KEY);
  };
  write();
  const rows = drafts.map((d) => {
    const row = {
      restored: true,
      text: d.text, type: d.type, typePicked: d.typePicked, photos: d.photos,
      anchor: d.anchor || {},
      confidence: d._confidence || 'none',
      needsPin: true,
    };
    row.onEdit = () => { d.text = row.text; write(); };
    row.onDone = () => { alive.delete(d); write(); };
    return row;
  });
  openDraftTray(rows, trayWords); // its heading says what happened; a toast would cover its buttons
}

// ---------- replies ----------
// The draft only shows in an open card: open the one that has it.
function restoreReply() {
  const c = S.comments.find((x) => (S.replyDrafts[x.id] || '').trim());
  if (!c) return;
  if (S.panelOpen && !S.expandedId) {
    S.expandedId = c.id;
    renderPanel();
    toast(t('Your unsent reply is back'), { duration: 3000 });
  }
}

export async function restoreDrafts() {
  restoreReply();
  const ctx = { page: S.page, source: SOURCE };
  const held = readHeld(SS.get(HELD_KEY), ctx);
  const r = readDraft(SS.get(DRAFT_KEY), ctx);
  if (r.status === 'drop') SS.remove(DRAFT_KEY);
  const d = r.status === 'ok' ? r.draft : null;
  const tray = held.here.slice();

  if (d) {
    let route, anchor = d.anchor, el = null, extra = {};
    if (d.kind === 'edit') {
      const c = S.comments.find((x) => x.id === d.commentId);
      route = restoreRoute(d, { commentExists: !!c });
      if (c) {
        anchor = c.anchor;
        extra = { comment: c };
        // Only a sure spot gets the box placed on it; the edit itself is saved
        // by the comment's id either way.
        const f = resolveNow(c.anchor);
        if (f.el && f.confidence === 'high') el = f.el;
      } else {
        d.kind = 'new'; // the comment is gone: what was typed can still become a new one
        d._confidence = 'none';
      }
    } else {
      const f = await findSpot(d.anchor);
      route = restoreRoute(d, { confidence: f.confidence });
      d._confidence = f.confidence || 'none';
      if (route === 'composer') el = f.el;
    }
    // The reviewer started something else while we looked: the tray, not a box over it.
    if (route === 'composer' && busy()) route = 'tray';
    if (route === 'composer') reopen(d, anchor, el, extra);
    else {
      if (!d.anchor) d.anchor = anchor || {};
      if (d.kind === 'edit') d.kind = 'new';
      SS.remove(DRAFT_KEY);
      tray.push(d);
    }
  }
  if (!tray.length) return;
  if (S.draftTray) {
    // The spoken-draft tray is up already: keep ours stored for the next load.
    SS.set(HELD_KEY, packHeld([...held.others, ...tray]));
    return;
  }
  openTray(tray, held.others);
}
