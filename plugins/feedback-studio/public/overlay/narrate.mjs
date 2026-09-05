// Feedback Studio — talking instead of typing, in both directions.
//
//  1. "Talk me through it": the reviewer speaks while moving the cursor; we
//     capture two timestamped streams (what was SAID, what was POINTED AT) and
//     hand them to the pure correlation engine (lib/narration.mjs), which
//     grounds each utterance on the element under the cursor (Put-That-There).
//     Draft comments come back for the reviewer to confirm — nothing is
//     committed without a glance, and an unconfident target asks for a pin
//     rather than guessing.
//  2. The mirror: after the agent processes feedback and leaves a reply on each
//     comment, "walk me through the changes" plays a tour — each element is
//     scrolled into view and highlighted while the agent's own words are read
//     aloud (native SpeechSynthesis — zero-dep).

import {
  S, MODE, ROOT, ROLE, LS, CAN_COMMENT, SR, LANGS,
  langName, langShort, walkComments, lastAgentReply,
} from '/__feedback/overlay/state.mjs';
import {
  $, root, I, escapeHtml, autoGrow, isInUI, toast, toastError,
  showHighlightFor, hideHighlight, flashEl, revealEl, setChromeHidden, setFabRaised,
} from '/__feedback/overlay/ui.mjs';
import { norm, buildElementAnchor, resolveAnchor } from '/__feedback/overlay/dom.mjs';
import { api } from '/__feedback/overlay/api.mjs';
import { captureShot } from '/__feedback/overlay/shots.mjs';
import { setMode, pickElement } from '/__feedback/overlay/mode.mjs';
import { closeComposer } from '/__feedback/overlay/composer.mjs';
import { setPanel, refresh } from '/__feedback/overlay/panel.mjs';

let _narrEngine = null;
async function loadNarrEngine() {
  if (_narrEngine) return _narrEngine;
  try { _narrEngine = await import(ROOT + '/lib/narration.mjs'); } catch (e) { _narrEngine = null; }
  return _narrEngine;
}

const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function narrKeyFor(el) {
  const a = buildElementAnchor(el);
  return { key: a.selector || a.xpath || a.tag, text: a.snippet || '', anchor: a };
}
function narrCloseHover(t) { if (S.narrCur) { S.narrCur.t1 = t; S.narrHovers.push(S.narrCur); S.narrCur = null; } }

const narrMove = (e) => {
  if (!S.narrating || isInUI(e)) return;
  const el = e.target;
  if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
  if (S.narrCur && S.narrCur.el === el) return; // same element — skip the (costly) anchor build
  const k = narrKeyFor(el);
  const now = Date.now();
  narrCloseHover(now);
  S.narrCur = { el, key: k.key, text: k.text, anchor: k.anchor, t0: now, t1: now };
  showHighlightFor(el);
  updateNarrPointing(k.text || el.nodeName.toLowerCase());
};
const narrClick = (e) => {
  if (!S.narrating || isInUI(e)) return;
  const el = e.target;
  if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
  // A click is a "this one" signal, not an interaction — suppress it so the
  // page can't navigate away (losing the session) or fire side effects.
  e.preventDefault(); e.stopPropagation();
  const k = narrKeyFor(el);
  S.narrClicks.push({ t: Date.now(), key: k.key, text: k.text, anchor: k.anchor });
};

function updateNarrPointing(text) {
  if (!S.narrBar) return;
  const p = S.narrBar.querySelector('.kbf-narr-point');
  if (p) p.textContent = text ? ('pointing at: ' + text.slice(0, 40)) : '';
}
function updateNarrTicker(text) {
  if (!S.narrBar) return;
  const t = S.narrBar.querySelector('.kbf-narr-ticker');
  if (t) t.textContent = text || '';
}

function showNarrBar() {
  S.narrBar = document.createElement('div');
  S.narrBar.className = 'kbf-narr-bar';
  S.narrBar.innerHTML = `
    <span class="kbf-narr-dot"></span>
    <span class="kbf-narr-live">
      <span class="kbf-narr-ticker">Listening… talk me through the page.</span>
      <span class="kbf-narr-point"></span>
    </span>
    <label class="kbf-langwrap kbf-narr-lang" title="Voice language: ${escapeHtml(langName(S.speechLang))}">
      <span class="kbf-lang" aria-hidden="true">${escapeHtml(langShort(S.speechLang))}</span>
      <select class="kbf-langselect" aria-label="Voice language">
        ${LANGS.map((l) => `<option value="${l.code}"${l.code === S.speechLang ? ' selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
      </select>
    </label>
    <button type="button" class="kbf-narr-stop" data-narr="stop">${I.stop}<span>Stop &amp; review</span></button>`;
  root.appendChild(S.narrBar);
  S.narrBar.querySelector('[data-narr="stop"]').addEventListener('click', stopNarrate);
  // Blur after picking so the <select> doesn't keep focus — otherwise pressing
  // T to stop would type-ahead the dropdown (e.g. jump to "Turkish") instead.
  S.narrBar.querySelector('.kbf-langselect').addEventListener('change', (e) => { setNarrLang(e.target.value); e.target.blur(); });
}
function setNarrLang(code) {
  if (!LANGS.some((l) => l.code === code)) return;
  S.speechLang = code;
  LS.set('kbf-voicelang', code);
  if (S.narrBar) {
    const chip = S.narrBar.querySelector('.kbf-narr-lang .kbf-lang'); if (chip) chip.textContent = langShort(code);
    const w = S.narrBar.querySelector('.kbf-narr-lang'); if (w) w.title = 'Voice language: ' + langName(code);
  }
  // switch the running recogniser to the new language mid-session (onend restarts it)
  if (S.narrating && S.narrRec) { S.narrRec.lang = code; try { S.narrRec.stop(); } catch (e) {} }
  toast('Voice language: ' + langName(code));
}
function hideNarrBar() { if (S.narrBar) { try { S.narrBar.remove(); } catch (e) {} S.narrBar = null; } }

export function startNarrate() {
  if (!CAN_COMMENT) return;
  if (S.narrating) { stopNarrate(); return; }
  if (!SR) { toastError('Voice needs Chrome or Edge over a secure connection'); return; }
  // narration is its own mode; make sure comment mode / composer / walkthrough
  // are off (a live walkthrough speaks aloud — the mic would hear the agent).
  if (S.mode) setMode(false);
  closeComposer();
  closeWalkthrough();
  closeDraftTray();                 // any leftover review tray from a prior session
  if (S.panelOpen) setPanel(false); // clear the feedback overview: more room to point, and the draft tray won't land on top of it
  S.narrating = true;
  const session = ++S.narrSession; // this run's id; stale recognizer events check against it
  S.narrTranscript = []; S.narrHovers = []; S.narrClicks = []; S.narrCur = null;
  document.documentElement.style.cursor = 'crosshair';
  const nb = $('kbf-narrate'); if (nb) { nb.classList.add('is-live'); nb.setAttribute('aria-pressed', 'true'); }
  setFabRaised(true); // keep the buttons visible, just lift them above the bar
  showNarrBar();
  loadNarrEngine();
  document.addEventListener('pointermove', narrMove, true);
  document.addEventListener('click', narrClick, true);
  // speech
  const narrRec = new SR();
  S.narrRec = narrRec;
  narrRec.lang = S.speechLang; narrRec.interimResults = true; narrRec.continuous = true;
  narrRec.onresult = (e) => {
    if (session !== S.narrSession) return; // event from a superseded/stopped session
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        const txt = norm(seg);
        if (!txt) continue;
        const now = Date.now();
        const last = S.narrTranscript[S.narrTranscript.length - 1];
        // Mobile Web Speech re-emits a GROWING cumulative final ("so" →
        // "so explain" → "so explain me"…) in quick succession. Collapse a
        // prefix chain ONLY when the finals arrive close together — otherwise a
        // genuine repeat ("make this bigger" … later …) would be wrongly merged.
        if (last && (now - last.t) < 1400 && (txt.startsWith(last.text) || last.text.startsWith(txt))) {
          if (txt.length >= last.text.length) { last.text = txt; last.t = now; }
        } else {
          S.narrTranscript.push({ t: now, text: txt });
        }
      } else interim += seg;
    }
    updateNarrTicker(norm(interim) || (S.narrTranscript.length ? '“' + S.narrTranscript[S.narrTranscript.length - 1].text + '”' : 'Listening…'));
  };
  narrRec.onerror = (ev) => { if (session === S.narrSession && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) { toastError('Microphone blocked — allow mic access'); stopNarrate(); } };
  narrRec.onend = () => { if (session === S.narrSession && S.narrating) { try { S.narrRec.start(); } catch (e) {} } };
  try { narrRec.start(); } catch (e) {}
  clearTimeout(S.narrTimeout);
  S.narrTimeout = setTimeout(() => { if (S.narrating) { toast('Narration auto-stopped after 10 min'); stopNarrate(); } }, 600000);
  // One-time privacy note: continuous capture routes audio through the
  // browser's cloud speech recognizer (shown once per browser).
  if (!LS.get('kbf-narr-privacy')) { LS.set('kbf-narr-privacy', '1'); toast('Narrating — talk and point. (Voice is transcribed by your browser’s speech service.) Hit Stop when done.', { duration: 5000 }); }
  else toast('Narrating — talk and point. Hit Stop when done.');
}

export async function stopNarrate() {
  if (!S.narrating) return;
  S.narrating = false;
  S.narrSession++; // invalidate the recognizer's queued events immediately
  clearTimeout(S.narrTimeout);
  document.documentElement.style.cursor = '';
  const nb = $('kbf-narrate'); if (nb) { nb.classList.remove('is-live'); nb.setAttribute('aria-pressed', 'false'); }
  narrCloseHover(Date.now());
  document.removeEventListener('pointermove', narrMove, true);
  document.removeEventListener('click', narrClick, true);
  if (S.narrRec) { try { S.narrRec.stop(); } catch (e) {} S.narrRec = null; }
  hideHighlight(); hideNarrBar();
  setFabRaised(false); // drop the cluster back down (draft tray, if it opens, will hide it)
  // Snapshot the timelines BEFORE the await, so a start-during-await (which
  // resets these arrays) can't make us correlate the wrong session's data.
  const transcript = S.narrTranscript.slice(), hovers = S.narrHovers.slice(), clicks = S.narrClicks.slice();
  const eng = await loadNarrEngine();
  if (!eng) { toastError('Could not load the narration engine'); return; }
  // `mode` picks the verb set: a spoken note on a document becomes rephrase / expand / delete / comment, not fix / change.
  const drafts = eng.correlate(transcript, { hovers, clicks }, { mode: MODE }).filter((d) => (d.text || '').trim());
  if (!drafts.length) { toast('No feedback caught — nothing to review'); return; }
  // Confident ones behave exactly like a manual comment: they're pinned right
  // away and PPF picks them up — no accept step. Only the ones we couldn't
  // confidently place ask the reviewer to point at the element.
  const confident = drafts.filter((d) => !d.needsPin);
  const needPin = drafts.filter((d) => d.needsPin);
  let saved = 0;
  const failed = [];
  for (const d of confident) { try { if (await saveNarrationComment(d)) saved++; else failed.push(d); } catch (e) { failed.push(d); } }
  if (saved) { refresh(); toast(saved + ' spoken comment' + (saved === 1 ? '' : 's') + ' pinned'); }
  if (failed.length) toastError(failed.length + ' comment' + (failed.length === 1 ? "" : 's') + " couldn't save — review below");
  const review = needPin.concat(failed); // don't drop failed saves — surface them for retry/pin
  if (review.length) openDraftTray(review);
  else if (!saved) toast('No feedback caught — nothing to review');
}

// POST one narration draft as a real comment (the confident path + the "placed
// it" path both call this). Behaves like a manual save: pin appears, PPF sees it.
async function saveNarrationComment(d) {
  const text = (d.text || '').trim();
  if (!text) return null;
  const data = await api('/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: S.page, pageTitle: document.title, url: location.href, anchor: d.anchor || {}, text, type: d.type, via: 'narration', authorName: ROLE === 'comment' ? (LS.get('kbf-name') || '') : '' }),
  });
  S.comments.push(data.comment);
  if (d.anchor) captureShot(data.comment.id, { anchor: d.anchor });
  return data.comment;
}

// ---------- draft tray — ONLY for spoken comments we couldn't confidently place ----------
function openDraftTray(drafts) {
  closeDraftTray();
  const n = drafts.length;
  S.draftTray = document.createElement('div');
  S.draftTray.className = 'kbf-drafts';
  S.draftTray.innerHTML = `
    <div class="kbf-drafts-head">
      <b>${n} spoken comment${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a spot</b>
      <span class="kbf-drafts-sub">I heard ${n === 1 ? 'this' : 'these'} but wasn’t sure where — point at the element</span>
      <button type="button" class="kbf-x" data-dr="close" title="Dismiss">${I.close}</button>
    </div>
    <div class="kbf-drafts-list"></div>
    <div class="kbf-drafts-foot">
      <button type="button" class="kbf-btn kbf-btn--ghost" data-dr="discardall">Discard all</button>
      <div class="kbf-spacer"></div>
      <button type="button" class="kbf-btn kbf-btn--ghost" data-dr="saveall">Save all without pins</button>
    </div>`;
  root.appendChild(S.draftTray);
  setChromeHidden(true);
  const list = S.draftTray.querySelector('.kbf-drafts-list');
  drafts.forEach((d, i) => list.appendChild(renderDraftRow(d, i)));
  S.draftTray.addEventListener('click', (e) => {
    const act = e.target.closest('[data-dr]')?.dataset.dr;
    if (act === 'close' || act === 'discardall') { closeDraftTray(); return; }
    if (act === 'saveall') { saveAllUnpinned(); return; }
  });
}
function renderDraftRow(d, i) {
  // Two kinds land in the tray: ones we couldn't confidently place (no anchor —
  // "Point to it"), and ones that were anchored fine but whose save FAILED
  // (already have a good spot — just "Retry"). Render each accurately.
  const needsSpot = d.needsPin || !d.anchor;
  const row = document.createElement('div');
  row.className = 'kbf-draft' + (needsSpot ? ' needs-pin' : '');
  row.dataset.i = i;
  row._draft = d;
  row.innerHTML = `
    <div class="kbf-draft-top">
      <span class="kbf-draft-conf kbf-conf-${d.confidence}" title="anchor confidence: ${d.confidence}"></span>
      <span class="kbf-draft-type-tag kbf-type-${d.type}">${d.type}</span>
      <span class="kbf-draft-nopin">${needsSpot ? 'unsure where' : 'couldn’t save'}</span>
    </div>
    <textarea class="kbf-draft-text" rows="1">${escapeHtml(d.text)}</textarea>
    <div class="kbf-draft-foot">
      ${needsSpot ? '<button type="button" class="kbf-chip-btn kbf-draft-pin" data-d="pin">' + I.jump + ' Point to it</button>' : ''}
      <div class="kbf-spacer"></div>
      <button type="button" class="kbf-chip-btn kbf-draft-discard" data-d="discard">${I.reject} Discard</button>
      <button type="button" class="kbf-chip-btn kbf-draft-accept" data-d="accept">${I.check} ${needsSpot ? 'Save anyway' : 'Retry'}</button>
    </div>`;
  const ta = row.querySelector('.kbf-draft-text');
  ta.addEventListener('input', () => { d.text = ta.value; autoGrow(ta, 120); });
  setTimeout(() => autoGrow(ta, 120), 0);
  row.addEventListener('click', (e) => {
    const act = e.target.closest('[data-d]')?.dataset.d;
    // (No "show me" here — needs-a-spot drafts have no anchor yet; the user
    // places one with "Point to it".)
    if (act === 'discard') { row.remove(); updateDraftCount(); return; }
    if (act === 'pin') { startDraftPin(d, row); return; }
    if (act === 'accept') { acceptDraft(d, row); return; }
  });
  return row;
}
function startDraftPin(d, row) {
  if (S.draftTray) S.draftTray.style.display = 'none';
  toast('Click the element this is about', { duration: 4000 });
  pickElement(async (el) => {
    if (S.draftTray) S.draftTray.style.display = '';
    if (el instanceof Element && el !== document.body) {
      d.anchor = buildElementAnchor(el); d.needsPin = false; d.confidence = 'high';
      await acceptDraft(d, row); // placed → save it immediately, like a confident one
    }
  });
}
async function acceptDraft(d, row) {
  if (d._saving) return; // idempotent: ignore repeat clicks while the POST is in flight
  if (!(d.text || '').trim()) { toastError('Add a note or discard this'); return; }
  d._saving = true;
  if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await saveNarrationComment(d);
    if (row) row.remove();
    refresh();
    toast('Comment added');
    updateDraftCount();
  } catch (e) {
    d._saving = false; // let them retry
    if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    toastError('Save failed — ' + e.message);
  }
}
async function saveAllUnpinned() {
  if (!S.draftTray) return;
  const rows = [...S.draftTray.querySelectorAll('.kbf-draft')];
  for (const r of rows) await acceptDraft(r._draft, r);
  updateDraftCount();
}
// Recompute the header count whenever a draft is discarded/accepted/pinned; close
// the tray once the last one is gone.
function updateDraftCount() {
  if (!S.draftTray) return;
  const n = S.draftTray.querySelectorAll('.kbf-draft').length;
  if (!n) { closeDraftTray(); return; }
  const b = S.draftTray.querySelector('.kbf-drafts-head b');
  if (b) b.textContent = n + ' spoken comment' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') + ' a spot';
  const sub = S.draftTray.querySelector('.kbf-drafts-sub');
  if (sub) sub.textContent = 'I heard ' + (n === 1 ? 'this' : 'these') + ' but wasn’t sure where — point at the element';
}
export function closeDraftTray() { if (S.draftTray) { try { S.draftTray.remove(); } catch (e) {} S.draftTray = null; setChromeHidden(false); } }

// ---------- "Agent narrates back" — a guided walkthrough of what the agent changed ----------
const TTS = window.speechSynthesis || null;

// Epoch guard: every stop/step/speak bumps walkState.epoch, and each utterance's
// onend/onerror (or the no-TTS timer) only fires its callback if the epoch it was
// created under is still current. This neutralises the `onend` that the browser
// fires when TTS.cancel() aborts an in-flight utterance — otherwise a cancelled
// step could spuriously auto-advance the new one.
// ---------- read a reply in ITS language, not the mic's ----------
// The agent's reply may be written in a different language than the one the mic
// was set to. Detect it — the browser's built-in LanguageDetector when present
// (Chrome, zero-dep), else a small stopword heuristic — so the walkthrough reads
// it in the right accent. Falls back to the selected voice language.
let _langDet = null, _langDetTried = false;
async function getLangDetector() {
  if (_langDetTried) return _langDet;
  _langDetTried = true;
  try {
    if (self.LanguageDetector?.create) _langDet = await self.LanguageDetector.create();
    else if (self.translation?.createDetector) _langDet = await self.translation.createDetector();
    else if (self.ai?.languageDetector?.create) _langDet = await self.ai.languageDetector.create();
  } catch (e) { _langDet = null; }
  return _langDet;
}
const LANG_HINTS = {
  nl: /\b(de|het|een|en|is|dat|niet|van|ik|je|op|te|voor|met|aan|maar|deze|moet|naar|zijn)\b/gi,
  de: /\b(der|die|das|und|ist|nicht|von|ich|ein|zu|auf|mit|für|aber|sich|werden|nach|sind)\b/gi,
  fr: /\b(le|la|les|un|une|et|est|ne|pas|de|je|vous|pour|avec|mais|ce|que|dans|sur)\b/gi,
  es: /\b(el|la|los|un|una|y|es|no|de|que|para|con|pero|este|más|se|por|como)\b/gi,
  it: /\b(il|la|le|un|una|e|è|non|di|che|per|con|ma|questo|come|sono|del)\b/gi,
  en: /\b(the|a|is|and|to|of|it|this|that|you|for|with|but|should|what|here|your)\b/gi,
};
function heuristicLang(text) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  let best = null, bestN = 1; // need at least 2 hits to claim a language
  for (const k in LANG_HINTS) { const n = (t.match(LANG_HINTS[k]) || []).length; if (n > bestN) { bestN = n; best = k; } }
  return best;
}
async function detectLang(text) {
  const d = await getLangDetector();
  if (d) { try { const r = await d.detect(text); if (r && r[0] && r[0].detectedLanguage && (r[0].confidence == null || r[0].confidence > 0.5)) return r[0].detectedLanguage; } catch (e) {} }
  return heuristicLang(text);
}
function voiceForLang(code) {
  try { return ((TTS.getVoices && TTS.getVoices()) || []).find((v) => v.lang && v.lang.toLowerCase().slice(0, 2) === code.slice(0, 2)) || null; }
  catch (e) { return null; }
}
// Make a reply readable ALOUD: markup, code, file paths, URLs and code-ish
// punctuation would otherwise be spelled out ("less-than section id equals…").
// Strip them to plain, ear-friendly prose before handing it to the synthesiser.
function speakableText(text) {
  return String(text == null ? '' : text)
    .replace(/[\uFFFD\u0000-\u001F]/g, ' ')                                          // replacement / control chars
    .replace(/<[^>]*>/g, ' ')                                                   // HTML tags
    .replace(/`[^`]*`/g, ' ')                                                   // `inline code`
    .replace(/https?:\/\/\S+/gi, ' link ')                                      // URLs
    .replace(/\b[\w./-]+\.(?:html?|css|jsx?|mjs|tsx?|json|md|py|rb|go|svg|png|jpe?g|webp|gif)\b/gi, ' ') // filenames
    .replace(/[~#*_>{}()[\]|\\/=<>]+/g, ' ')                                     // code punctuation
    .replace(/\s+([.,;:!?])/g, '$1')                                            // tidy space-before-punct
    .replace(/\s+/g, ' ')
    .trim();
}
async function speakWalk(text, onDone) {
  if (!S.walkState) return;
  S.walkState.epoch = (S.walkState.epoch || 0) + 1;
  const myEpoch = S.walkState.epoch;
  const fire = () => { if (S.walkState && S.walkState.epoch === myEpoch && onDone) onDone(); };
  const spoken = speakableText(text);
  if (!TTS || !spoken) { S.walkState._t = setTimeout(fire, 1400); return; }
  const detected = await detectLang(spoken);                   // read it in the reply's own language
  if (!S.walkState || S.walkState.epoch !== myEpoch) return;   // a newer step started during detection
  try {
    TTS.cancel();
    const u = new SpeechSynthesisUtterance(spoken.slice(0, 500));
    u.lang = detected || S.speechLang || 'en-US';
    const v = voiceForLang(u.lang);
    if (v) u.voice = v;
    u.onend = fire;
    u.onerror = fire;
    TTS.speak(u);
  } catch (e) { S.walkState._t = setTimeout(fire, 1400); }
}
function stopWalkSpeak() {
  if (S.walkState) S.walkState.epoch = (S.walkState.epoch || 0) + 1; // invalidate any in-flight callback
  if (TTS) { try { TTS.cancel(); } catch (e) {} }
  if (S.walkState && S.walkState._t) { clearTimeout(S.walkState._t); S.walkState._t = 0; }
}

export function startWalkthrough() {
  if (S.narrating) { toast('Stop narrating first'); return; }
  const list = walkComments();
  if (!list.length) { toast('No changes to walk through yet — run “Please process feedback” first.'); return; }
  getLangDetector(); // warm up the language detector so the first step isn't laggy
  closeWalkthrough();
  closeDraftTray(); // mutually exclusive bottom surfaces
  if (S.mode) setMode(false);
  S.walkState = { list, i: 0, playing: true, _t: 0, epoch: 0 };
  setFabRaised(true); // keep buttons visible above the walk bar
  S.walkBar = document.createElement('div');
  S.walkBar.className = 'kbf-walk-bar';
  S.walkBar.setAttribute('role', 'group');
  S.walkBar.setAttribute('aria-label', 'Walkthrough of changes');
  S.walkBar.innerHTML = `
    <div class="kbf-walk-body">
      <span class="kbf-walk-step"></span>
      <span class="kbf-walk-text"></span>
    </div>
    <div class="kbf-walk-ctrls">
      <button type="button" data-walk="prev" title="Previous" aria-label="Previous">${I.prev}</button>
      <button type="button" data-walk="playpause" title="Play / pause" aria-label="Play or pause">${I.pause}</button>
      <button type="button" data-walk="next" title="Next" aria-label="Next">${I.next}</button>
      <button type="button" class="kbf-walk-x" data-walk="close" title="Close" aria-label="Close walkthrough">${I.close}</button>
    </div>`;
  root.appendChild(S.walkBar);
  S.walkBar.addEventListener('click', (e) => {
    const a = e.target.closest('[data-walk]')?.dataset.walk;
    if (a === 'prev') walkGo(S.walkState.i - 1);
    else if (a === 'next') walkGo(S.walkState.i + 1); // epoch guard makes this safe while playing
    else if (a === 'playpause') walkTogglePlay();
    else if (a === 'close') closeWalkthrough();
  });
  walkGo(0);
}
function walkGo(i) {
  if (!S.walkState) return;
  stopWalkSpeak();
  if (i >= S.walkState.list.length) { closeWalkthrough(); toast('That’s everything I changed.'); return; }
  if (i < 0) i = 0;
  S.walkState.i = i;
  const c = S.walkState.list[i];
  const text = lastAgentReply(c);
  S.walkBar.querySelector('.kbf-walk-step').textContent = (i + 1) + ' / ' + S.walkState.list.length;
  S.walkBar.querySelector('.kbf-walk-text').textContent = text;
  const el = resolveAnchor(c.anchor);
  if (el) { revealEl(el); try { el.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' }); } catch (e) {} showHighlightFor(el); flashEl(el); }
  else hideHighlight();
  updateWalkIcon();
  if (S.walkState.playing) speakWalk(text, () => { if (S.walkState && S.walkState.playing) walkGo(S.walkState.i + 1); });
}
function walkTogglePlay() {
  if (!S.walkState) return;
  S.walkState.playing = !S.walkState.playing;
  updateWalkIcon();
  if (S.walkState.playing) speakWalk(lastAgentReply(S.walkState.list[S.walkState.i]), () => { if (S.walkState && S.walkState.playing) walkGo(S.walkState.i + 1); });
  else stopWalkSpeak();
}
function updateWalkIcon() {
  const b = S.walkBar && S.walkBar.querySelector('[data-walk="playpause"]');
  if (b) b.innerHTML = S.walkState && S.walkState.playing ? I.pause : I.play;
}
export function closeWalkthrough() {
  stopWalkSpeak();
  hideHighlight();
  if (S.walkBar) { try { S.walkBar.remove(); } catch (e) {} S.walkBar = null; }
  S.walkState = null;
  setFabRaised(false);
}
