// Tests for the Markdown marker stamper. Run with: node --test
// This is the riskiest code in the tool — it writes into the user's source
// files — so the refuse-to-guess contract is pinned down here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportMarkers, fbMarker } from '../lib/markers.mjs';
import { makeComment, writeComments } from '../lib/store.mjs';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'fbs-mk-'));
  const dataDir = path.join(root, '.feedback');
  mkdirSync(dataDir);
  return { root, dataDir };
}

function mdComment(root, file, snippet, extra = {}) {
  return makeComment({
    sourceFile: file, page: '/' + file.replace(/\.md$/i, ''),
    text: extra.text || 'note', type: extra.type || 'comment',
    anchor: { snippet }, ...extra,
  });
}

test('stamps the single line holding the quoted text', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), '# Title\n\nAlpha paragraph here.\n\nOmega paragraph.\n');
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'Alpha paragraph here.')]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ files: r.files, stamped: r.stamped, notFound: r.notFound }, { files: 1, stamped: 1, notFound: 0 });
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8').split('\n');
    assert.match(out[2], /^Alpha paragraph here\. <!-- @FB#c_[\w-]+: note -->$/);
    assert.ok(existsSync(path.join(root, 'doc.md.bak')), 'a .bak is saved before writing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses to stamp when the snippet matches several lines (ambiguous)', async () => {
  const { root, dataDir } = setup();
  try {
    const body = 'Repeated heading\n\ntext\n\nRepeated heading\n';
    writeFileSync(path.join(root, 'doc.md'), body);
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'Repeated heading')]);
    const r = await exportMarkers(dataDir, root);
    assert.equal(r.stamped, 0);
    assert.equal(r.notFound, 1);
    assert.equal(readFileSync(path.join(root, 'doc.md'), 'utf-8'), body, 'file untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses to stamp when the snippet matches nothing (no EOF append)', async () => {
  const { root, dataDir } = setup();
  try {
    const body = '# Title\n\nSome text.\n';
    writeFileSync(path.join(root, 'doc.md'), body);
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'this text no longer exists')]);
    const r = await exportMarkers(dataDir, root);
    assert.equal(r.stamped, 0);
    assert.equal(r.notFound, 1);
    assert.equal(readFileSync(path.join(root, 'doc.md'), 'utf-8'), body, 'nothing appended');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skips resolved AND rejected comments (rejected means do-not-implement)', async () => {
  const { root, dataDir } = setup();
  try {
    const body = 'Alpha line.\n\nBeta line.\n';
    writeFileSync(path.join(root, 'doc.md'), body);
    const a = mdComment(root, 'doc.md', 'Alpha line.'); a.status = 'rejected';
    const b = mdComment(root, 'doc.md', 'Beta line.'); b.status = 'resolved';
    await writeComments(dataDir, [a, b]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, files: r.files }, { stamped: 0, files: 0 });
    assert.equal(readFileSync(path.join(root, 'doc.md'), 'utf-8'), body, 'file untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved comments ARE stamped', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line.\n');
    const a = mdComment(root, 'doc.md', 'Alpha line.'); a.status = 'approved';
    await writeComments(dataDir, [a]);
    assert.equal((await exportMarkers(dataDir, root)).stamped, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('is idempotent: stamping twice writes the marker once', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line.\n');
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'Alpha line.')]);
    await exportMarkers(dataDir, root);
    const r2 = await exportMarkers(dataDir, root);
    assert.equal(r2.stamped, 0);
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8');
    assert.equal((out.match(/@FB/g) || []).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a CRLF file stays CRLF everywhere after stamping', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), '# Title\r\n\r\nAlpha paragraph here.\r\n\r\nOmega paragraph.\r\n');
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'Alpha paragraph here.')]);
    assert.equal((await exportMarkers(dataDir, root)).stamped, 1);
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8');
    assert.ok(!/(^|[^\r])\n/.test(out), 'no bare newline survives in a CRLF file');
    assert.match(out, /Alpha paragraph here\. <!-- @FB#c_[\w-]+: note -->\r\n/, 'the stamped line still ends CRLF');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an LF file stays LF (the marker adds no stray carriage return)', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), '# Title\n\nAlpha paragraph here.\n');
    await writeComments(dataDir, [mdComment(root, 'doc.md', 'Alpha paragraph here.')]);
    await exportMarkers(dataDir, root);
    assert.ok(!readFileSync(path.join(root, 'doc.md'), 'utf-8').includes('\r'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-stamping an edited comment replaces its marker instead of adding a second', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line.\n');
    const c = mdComment(root, 'doc.md', 'Alpha line.', { text: 'note' });
    await writeComments(dataDir, [c]);
    assert.equal((await exportMarkers(dataDir, root)).stamped, 1);
    c.text = 'sharper wording please';           // the reviewer edited the comment
    await writeComments(dataDir, [c]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, updated: r.updated }, { stamped: 0, updated: 1 }, 'updated in place, not stamped again');
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8');
    assert.equal(out.split('#' + c.id).length - 1, 1, 'exactly one marker for this id');
    assert.equal((out.match(/@FB/g) || []).length, 1);
    assert.ok(out.includes('sharper wording please'));
    assert.ok(!out.includes(': note -->'), 'the stale marker text is gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a marker stamped before ids existed is not stamped a second time', async () => {
  const { root, dataDir } = setup();
  try {
    const c = mdComment(root, 'doc.md', 'Alpha line.', { text: 'note' });
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line. <!-- @FB: note -->\n'); // the 1.0.0 format
    await writeComments(dataDir, [c]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, files: r.files }, { stamped: 0, files: 0 });
    assert.equal((readFileSync(path.join(root, 'doc.md'), 'utf-8').match(/@FB/g) || []).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an edited comment whose marker predates ids is updated, not duplicated', async () => {
  const { root, dataDir } = setup();
  try {
    const c = mdComment(root, 'doc.md', 'Alpha line.', { text: 'sharper wording please' });
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line. <!-- @FB: note -->\n'); // stamped by 1.0.0, text edited since
    await writeComments(dataDir, [c]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, updated: r.updated }, { stamped: 0, updated: 1 });
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8');
    assert.equal((out.match(/@FB/g) || []).length, 1, 'no twin marker beside the old one');
    assert.ok(out.includes('#' + c.id + ': sharper wording please'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('text inside an existing marker never matches another comment\'s snippet', async () => {
  const { root, dataDir } = setup();
  try {
    writeFileSync(path.join(root, 'doc.md'), 'Alpha line.\n\nBeta line.\n');
    // A's comment TEXT contains the phrase B is anchored to. Once A is stamped,
    // that phrase sits on line 0 inside a marker — it is not source text, so B
    // must find nothing and refuse, not stamp itself onto A's line.
    const a = mdComment(root, 'doc.md', 'Alpha line.', { text: 'zeta wording here' });
    const b = mdComment(root, 'doc.md', 'zeta wording here', { text: 'second note' });
    await writeComments(dataDir, [a, b]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, notFound: r.notFound }, { stamped: 1, notFound: 1 });
    const out = readFileSync(path.join(root, 'doc.md'), 'utf-8');
    assert.ok(!out.includes('second note'), 'the second comment was not stamped anywhere');
    assert.equal((out.match(/@FB/g) || []).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a sourceFile outside the root is never written (path traversal)', async () => {
  const { root, dataDir } = setup();
  try {
    const outside = path.join(tmpdir(), 'fbs-outside-' + process.pid + '.md');
    writeFileSync(outside, 'Alpha line.\n');
    try {
      const rel = path.relative(root, outside); // ../../fbs-outside-*.md
      await writeComments(dataDir, [mdComment(root, rel, 'Alpha line.')]);
      const r = await exportMarkers(dataDir, root);
      assert.equal(r.stamped, 0);
      assert.equal(r.notFound, 1, 'refused files are counted, not silently dropped');
      assert.equal(readFileSync(outside, 'utf-8'), 'Alpha line.\n', 'outside file untouched');
    } finally { rmSync(outside, { force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--md outside the cwd: stamping works once that root is explicitly allowed', async () => {
  const { root, dataDir } = setup(); // `root` plays the project cwd
  const mdRoot = mkdtempSync(path.join(tmpdir(), 'fbs-mdroot-'));
  try {
    writeFileSync(path.join(mdRoot, 'report.md'), '# R\n\nAlpha paragraph here.\n');
    // sourceFile is recorded cwd-relative, exactly as --md mode stores it
    const rel = path.relative(root, path.join(mdRoot, 'report.md')).split(path.sep).join('/');
    await writeComments(dataDir, [mdComment(root, rel, 'Alpha paragraph here.')]);
    // default containment (cwd only) refuses and counts it…
    const r1 = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r1.stamped, notFound: r1.notFound }, { stamped: 0, notFound: 1 });
    // …allowing the md root stamps it, still resolving against the cwd
    const r2 = await exportMarkers(dataDir, root, [root, mdRoot]);
    assert.equal(r2.stamped, 1);
    assert.match(readFileSync(path.join(mdRoot, 'report.md'), 'utf-8'), /Alpha paragraph here\. <!-- @FB#c_[\w-]+: note -->/);
  } finally {
    rmSync(mdRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing sourceFile is counted in notFound, not silently dropped', async () => {
  const { root, dataDir } = setup();
  try {
    await writeComments(dataDir, [mdComment(root, 'gone.md', 'whatever text')]);
    const r = await exportMarkers(dataDir, root);
    assert.deepEqual({ stamped: r.stamped, notFound: r.notFound }, { stamped: 0, notFound: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('marker text per type', () => {
  assert.equal(fbMarker({ type: 'delete', text: 'cut this' }), '<!-- @FB-DELETE: cut this -->');
  assert.equal(fbMarker({ type: 'question', text: 'why?' }), '<!-- @FB-Q: why? -->');
  assert.equal(fbMarker({ type: 'rephrase', text: 'better words' }), '<!-- @FB: rephrase as "better words" -->');
  assert.equal(fbMarker({ type: 'comment', text: 'a note' }), '<!-- @FB: a note -->');
  // comment text can never close the HTML comment early
  assert.ok(!fbMarker({ type: 'comment', text: 'evil --> breakout' }).slice(5, -3).includes('-->'));
  // the id rides right after the tag, so a marker traces back to comments.json
  assert.equal(fbMarker({ id: 'c_1', type: 'comment', text: 'a note' }), '<!-- @FB#c_1: a note -->');
  assert.equal(fbMarker({ id: 'c_1', type: 'delete', text: 'cut this' }), '<!-- @FB-DELETE#c_1: cut this -->');
  assert.equal(fbMarker({ id: 'c_1', type: 'rephrase', text: 'better words' }), '<!-- @FB#c_1: rephrase as "better words" -->');
});
