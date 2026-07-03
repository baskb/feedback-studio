// Feedback Studio — narration correlation engine.
//
// The pure, DOM-FREE heart of "Talk me through it": the reviewer narrates the
// page while moving the cursor, and this turns the two streams — what was SAID
// and what was POINTED AT — into draft comments, each anchored to the element
// they were pointing at (or flagged "needs a pin" when it can't be sure).
//
// It is deliberately DOM-free so it can be the single tested source of truth:
// the browser overlay dynamic-imports it (served at /__feedback/lib/narration.mjs)
// and the Node test suite imports it directly. All DOM work — sampling the
// pointer, building anchors, reading element text — happens in the overlay and
// arrives here as plain data.
//
// Grounding model (Bolt's "Put-That-There", MIT 1980): deictic words — "this",
// "that", "here" — are variables bound by where the cursor is. So when an
// utterance says "make THIS pop", we trust the pointer; when it names visible
// text ("the Submit button"), we trust the text match. Web Speech gives no
// word-level timestamps, so the overlay timestamps each transcript arrival and
// each hover/click itself, and we correlate over a time window.

// Deixis: the reviewer is pointing rather than naming. Weight pointer signals up.
export const DEIXIS_RE = /\b(this|that|these|those|it|here|there)\b/i;

// Filler-only utterances carry no feedback — drop them.
const FILLER = new Set([
  'um', 'uh', 'er', 'ah', 'okay', 'ok', 'so', 'well', 'hmm', 'mmm', 'yeah', 'yep',
  'right', 'next', 'and', 'but', 'like', 'you know', 'let me see', 'lets see', "let's see",
  'moving on', 'alright', 'anyway',
]);

// Type inference from the words: fix / improve / question / change. fix & improve
// are checked first so "what's BROKEN here" reads as a fix, not a question; a
// clearly interrogative phrasing (wh-word up front, a trailing "?", or "explain
// …") that isn't a fix/improve becomes a `question` the agent answers.
const FIX_RE = /\b(broken?|bug|error|typo|doesn'?t work|not working|wrong|crash|misspell|missing|404|fails?)\b/i;
const IMPROVE_RE = /\b(improve|better|nicer|pop|punch|weak|bland|boring|ugly|redesign|cleaner|modern|stronger|more \w+|too (?:plain|dull|quiet))\b/i;
const QUESTION_RE = /^\s*(what|why|where|when|who|which|how)\b|\?\s*$|\b(explain|what does|what is|why is|why does|how does|where is|where does)\b/i;
export function inferType(text) {
  const t = String(text || '');
  if (FIX_RE.test(t)) return 'fix';
  if (IMPROVE_RE.test(t)) return 'improve';
  if (QUESTION_RE.test(t)) return 'question';
  return 'change';
}

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isFiller = (text) => {
  const t = norm(text).toLowerCase().replace(/[.,!?;:]+$/g, '');
  if (!t) return true;
  if (FILLER.has(t)) return true;
  // one or two short filler-ish words with no content
  const words = t.split(' ').filter(Boolean);
  return words.length <= 1 && t.length < 3;
};

// Segment raw transcript arrivals ({ t, text }) into utterances. Web Speech
// already groups on pauses (each final result ≈ one phrase); we additionally
// split when arrivals are far apart and drop fillers. Each transcript arrival's
// `t` is the moment recognition finalised it — i.e. roughly when the phrase
// ENDED — so downstream windows look backward from it.
export function segmentUtterances(segments, { gapMs = 1500 } = {}) {
  const out = [];
  // Require a finite timestamp: a non-numeric `t` would make the comparator
  // return NaN and scramble the whole sort (V8 treats NaN as "no preference").
  const list = (segments || [])
    .filter((s) => s && norm(s.text) && Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);
  for (const s of list) {
    const text = norm(s.text);
    // Drop filler-only finals BEFORE joining, so "um / uh / okay / so" arriving
    // close together doesn't glue into a bogus multi-word utterance.
    if (isFiller(text)) continue;
    const last = out[out.length - 1];
    if (last && s.t - last.tEnd <= gapMs) {
      last.text = norm(last.text + ' ' + text);
      last.tEnd = s.t;
    } else {
      out.push({ text, tStart: s.t, tEnd: s.t });
    }
  }
  return out.filter((u) => !isFiller(u.text));
}

// Weights (deliberately readable; tuned by the unit tests, not magic numbers).
const W = {
  click: 5.0,        // a click/tap is a deliberate, unambiguous "this one"
  dwellPerSec: 1.33, // per hover-second on an element, capped (idle hover ≠ intent)
  dwellCapSec: 1.5,  // beyond this a hover is likely idle/background, not pointing
  deixisMult: 1.5,   // multiply pointer scores when the utterance is deictic
  textMatch: 3.0,    // element's visible text is named in the utterance
  cursorAtEnd: 0.6,  // where the cursor sat as the phrase finalised
};
const LOOKBACK_MS = 2600; // people point, THEN speak; the arrival marks the end
const LOOKAHEAD_MS = 600;  // …and sometimes point just after starting to speak

// Does the utterance name an element by its visible text? (">=3-char" tokens so
// "a"/"is" don't match everything.)
function textMatches(utterance, elText) {
  const el = norm(elText).toLowerCase();
  if (!el || el.length < 3) return false;
  const u = ' ' + norm(utterance).toLowerCase() + ' ';
  if (u.includes(' ' + el + ' ')) return true;               // exact phrase
  const toks = el.split(' ').filter((w) => w.length >= 3);
  if (!toks.length) return false;
  const hit = toks.filter((w) => u.includes(' ' + w + ' ')).length;
  return hit / toks.length >= 0.6;                            // most significant words present
}

// Correlate an utterance to an element key.
//   hovers: [{ key, text, t0, t1, anchor }]  cursor-over intervals
//   clicks: [{ t, key, text, anchor }]
// Returns { key, anchor, text, confidence, score, signals } or null.
function pickTarget(utterance, hovers, clicks, win) {
  const deictic = DEIXIS_RE.test(utterance);
  const cand = new Map(); // key -> { key, anchor, text, score, signals:Set }
  const bump = (rawKey, anchor, text, amt, sig) => {
    const key = String(rawKey || '');
    if (!key) return;
    let c = cand.get(key);
    if (!c) { c = { key, anchor, text: text || '', score: 0, signals: new Set() }; cand.set(key, c); }
    if (anchor && !c.anchor) c.anchor = anchor;
    if (text && !c.text) c.text = text;
    c.score += amt; c.signals.add(sig);
  };

  // Pointer signals first, so the deixis boost applies to POINTER evidence only:
  //  - `dwell` = real hover overlap with the window (capped; a long idle hover
  //    isn't stronger intent than a brief point).
  //  - `cursorEnd` = the cursor merely SAT on an element as the phrase finalised.
  //    This is the default when someone pauses to speak, so it is weak evidence
  //    of intent and — crucially — must never by itself earn 'high'.
  for (const h of hovers || []) {
    const overlap = Math.max(0, Math.min(h.t1, win.hi) - Math.max(h.t0, win.lo));
    if (overlap > 0) bump(h.key, h.anchor, h.text, Math.min(overlap / 1000, W.dwellCapSec) * W.dwellPerSec, 'dwell');
    if (win.end != null && h.t0 <= win.end && h.t1 >= win.end) bump(h.key, h.anchor, h.text, W.cursorAtEnd, 'cursorEnd');
  }
  if (deictic) for (const c of cand.values()) c.score *= W.deixisMult;
  // A click is a deliberate selection — added AFTER the deixis boost, unmultiplied.
  for (const cl of clicks || []) {
    if (cl.t >= win.lo && cl.t <= win.hi) bump(cl.key, cl.anchor, cl.text, W.click, 'click');
  }
  // text-match: element named by its visible text (independent of the pointer)
  for (const c of cand.values()) if (textMatches(utterance, c.text)) { c.score += W.textMatch; c.signals.add('text'); }

  if (!cand.size) return null;
  const ranked = [...cand.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const margin = best.score - (ranked[1] ? ranked[1].score : 0);
  const clearWinner = ranked.length === 1 || margin >= best.score * 0.35;
  // 'high' — confident enough to auto-anchor — requires GENUINE evidence of
  // intent, never coincidental cursor rest:
  //  - a click or a named-text match (strong, unambiguous), and no competing
  //    strong candidate is beating it; OR
  //  - a real hover DWELL while the reviewer was actually pointing (deictic
  //    "this/that/here"), and a clear winner (no coin-flip).
  // Everything else is 'medium'/'low' → the draft asks for a pin rather than
  // anchoring on where the cursor happened to be.
  const strong = best.signals.has('click') || best.signals.has('text');
  const contestedByStrong = ranked.slice(1).some((c) => c.signals.has('click') || c.signals.has('text'));
  const hasDwell = best.signals.has('dwell');
  let confidence;
  if (strong && (!contestedByStrong || clearWinner)) confidence = 'high';
  else if (hasDwell && deictic && clearWinner) confidence = 'high';
  else if (clearWinner && best.score >= 1.0) confidence = 'medium';
  else confidence = 'low';
  return { key: best.key, anchor: best.anchor || null, text: best.text, confidence, score: +best.score.toFixed(2), signals: [...best.signals] };
}

// The public entry point. Returns one draft per meaningful utterance:
//   { text, type, anchor|null, confidence, needsPin, tStart, tEnd, signals }
// A draft with confidence below 'high' has needsPin=true — the reviewer must
// place it rather than trust a guessed element (the load-bearing invariant).
export function correlate(transcript, pointer, opts = {}) {
  const lookback = opts.lookbackMs ?? LOOKBACK_MS;
  const lookahead = opts.lookaheadMs ?? LOOKAHEAD_MS;
  const hovers = (pointer && pointer.hovers) || [];
  const clicks = (pointer && pointer.clicks) || [];
  const utterances = segmentUtterances(transcript, opts);
  const drafts = [];
  for (const u of utterances) {
    const win = { lo: u.tStart - lookback, hi: u.tEnd + lookahead, end: u.tEnd };
    const target = pickTarget(u.text, hovers, clicks, win);
    const anchored = target && target.confidence === 'high';
    drafts.push({
      text: u.text,
      type: inferType(u.text),
      anchor: anchored ? target.anchor : null,
      confidence: target ? target.confidence : 'none',
      needsPin: !anchored,
      tStart: u.tStart,
      tEnd: u.tEnd,
      signals: target ? target.signals : [],
    });
  }
  return drafts;
}
