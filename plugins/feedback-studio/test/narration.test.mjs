// Tests for the narration correlation engine — the pure heart of "Talk me
// through it". Feeds synthetic transcript + pointer timelines and asserts each
// utterance lands on the right element (or is correctly flagged needs-a-pin).
// Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { correlate, segmentUtterances, inferType, DEIXIS_RE } from '../lib/narration.mjs';

// helpers to build fake timelines (times in ms)
const seg = (t, text) => ({ t, text });
const hover = (key, text, t0, t1) => ({ key, text, t0, t1, anchor: { selector: key, snippet: text } });
const click = (t, key, text) => ({ t, key, text, anchor: { selector: key, snippet: text } });

test('segmentUtterances groups on pauses and drops filler', () => {
  const u = segmentUtterances([seg(1000, 'make this'), seg(1400, 'button orange'), seg(6000, 'okay'), seg(9000, 'the footer is broken')]);
  assert.equal(u.length, 2);
  assert.equal(u[0].text, 'make this button orange'); // joined (gap <= 1500)
  assert.equal(u[1].text, 'the footer is broken');    // "okay" filler dropped
});

test('inferType maps words to web verbs', () => {
  assert.equal(inferType('this is broken, the link 404s'), 'fix');
  assert.equal(inferType('make the hero pop more, it feels bland'), 'improve');
  assert.equal(inferType('change this to Start now'), 'change');
  assert.ok(DEIXIS_RE.test('make this bigger'));
  assert.ok(!DEIXIS_RE.test('the submit button is small'));
});

test('inferType detects spoken questions (but a fix/improve wins over question words)', () => {
  assert.equal(inferType('what does this button do here'), 'question');
  assert.equal(inferType('why is this section here'), 'question');
  assert.equal(inferType('how does the pricing work'), 'question');
  assert.equal(inferType('can you explain this bit'), 'question');
  assert.equal(inferType('is this thing meant to be here?'), 'question'); // trailing ?
  assert.equal(inferType('what is broken here'), 'fix');      // fix signal beats the wh-word
  assert.equal(inferType('how can we make this pop more'), 'improve'); // improve signal wins
  assert.equal(inferType('make this say Start'), 'change');   // plain imperative
});

test('deixis: "make THIS orange" anchors to the element under the cursor', () => {
  const transcript = [seg(3000, 'make this orange')];
  // cursor dwelled on #cta while speaking (utterance window looks back from 3000)
  const pointer = { hovers: [hover('#cta', 'Submit', 1200, 3200), hover('#hero', 'Welcome', 200, 1000)], clicks: [] };
  const [d] = correlate(transcript, pointer);
  assert.equal(d.needsPin, false);
  assert.equal(d.confidence, 'high');
  assert.equal(d.anchor.selector, '#cta');
  assert.equal(d.type, 'change');
});

test('a click is the strongest "this one" signal', () => {
  const transcript = [seg(2500, 'this should say Start')];
  const pointer = { hovers: [hover('#a', 'A', 0, 5000)], clicks: [click(2300, '#cta', 'Submit')] };
  const [d] = correlate(transcript, pointer);
  assert.equal(d.anchor.selector, '#cta'); // click beats a long ambient hover elsewhere
  assert.equal(d.confidence, 'high');
});

test('naming an element by its text resolves without deixis', () => {
  const transcript = [seg(2500, 'the Submit button feels too small')];
  // cursor was NOT on it, but its visible text is named
  const pointer = { hovers: [hover('#cta', 'Submit', 100, 900)], clicks: [] };
  const [d] = correlate(transcript, pointer);
  assert.equal(d.anchor && d.anchor.selector, '#cta');
});

test('asymmetric window catches point-then-speak AND speak-then-point', () => {
  // point-then-speak: dwell ends before the phrase finalises
  const a = correlate([seg(3000, 'this is wrong')], { hovers: [hover('#x', 'X', 600, 1400)], clicks: [] })[0];
  assert.equal(a.anchor && a.anchor.selector, '#x');
  // speak-then-point: dwell starts just after the phrase (within lookahead)
  const b = correlate([seg(3000, 'this here')], { hovers: [hover('#y', 'Y', 3100, 3500)], clicks: [] })[0];
  assert.equal(b.anchor && b.anchor.selector, '#y');
});

test('no pointer signal → needs a pin, never a confident guess', () => {
  const [d] = correlate([seg(3000, 'this whole section feels off')], { hovers: [], clicks: [] });
  assert.equal(d.needsPin, true);
  assert.equal(d.anchor, null);
  assert.equal(d.confidence, 'none');
});

test('an ambiguous coin-flip between two dwelt elements does not anchor high', () => {
  const pointer = { hovers: [hover('#a', 'A', 1000, 2000), hover('#b', 'B', 2000, 3000)], clicks: [] };
  const [d] = correlate([seg(3000, 'this bit')], pointer);
  // two similar dwell scores → margin small → not high → needs a pin
  assert.equal(d.needsPin, true);
});

test('ambient cursor rest never earns high (no deixis, no click, no text-match)', () => {
  // cursor merely sat on #panelC as the phrase finalised, plus ~1s idle dwell,
  // and the utterance neither points ("this") nor names the element — must NOT
  // confidently anchor (the load-bearing invariant).
  const transcript = [seg(3000, 'improve the overall flow of the page')];
  const pointer = { hovers: [hover('#panelC', 'some panel', 1940, 3000)], clicks: [] };
  const [d] = correlate(transcript, pointer);
  assert.notEqual(d.confidence, 'high');
  assert.equal(d.needsPin, true);
});

test('a click still wins over a long ambient hover on a different element', () => {
  // regression guard: the deixis/scoring reorder must not let an ambient dwell
  // block a deliberate click (a click is never "contested" by a mere hover).
  const transcript = [seg(4000, 'this should link to pricing')];
  const pointer = { hovers: [hover('#nav', 'Home About Contact', 0, 4000)], clicks: [click(3800, '#cta', 'Buy now')] };
  const [d] = correlate(transcript, pointer);
  assert.equal(d.anchor.selector, '#cta');
  assert.equal(d.confidence, 'high');
});

test('a run of short fillers is dropped, not glued into a bogus utterance', () => {
  const u = segmentUtterances([seg(100, 'um'), seg(300, 'uh'), seg(500, 'okay'), seg(700, 'so')]);
  assert.equal(u.length, 0);
});

test('malformed timestamps do not scramble ordering or throw', () => {
  const u = segmentUtterances([seg(5000, 'second'), { t: 'bad', text: 'junk' }, seg(500, 'first')]);
  assert.deepEqual(u.map((x) => x.text), ['first', 'second']); // bad-t dropped, order intact, far enough apart to not join
});

test('a full mixed session yields the right per-utterance targets', () => {
  const transcript = [
    seg(2000, 'okay'),                          // filler → dropped
    seg(4000, 'make this headline bigger'),     // dwell on #hero
    seg(8000, 'and the submit button is broken'), // text-match #cta
  ];
  const pointer = {
    hovers: [hover('#hero', 'Welcome to our site', 2200, 4200), hover('#cta', 'Submit', 6000, 7000)],
    clicks: [],
  };
  const drafts = correlate(transcript, pointer);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].anchor.selector, '#hero');
  assert.equal(drafts[0].type, 'change');
  assert.equal(drafts[1].anchor.selector, '#cta');
  assert.equal(drafts[1].type, 'fix');
});
