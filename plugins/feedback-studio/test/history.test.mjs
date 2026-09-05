// Tests for the Markdown version history and its line diff. Run with: node --test
//
// Two things matter most here. The diff must be replayable: the '=' and '+' lines
// have to rebuild the new text and the '=' and '-' lines the old one, or every
// change the reviewer is shown is wrong. And the store must never lose the first
// version, because that is the only copy of what the file looked like before the
// review started.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  slugFor, diffLines, diffStats, hunks,
  listVersions, recordSnapshot, readVersion, diffVersions, latestVersion,
} from '../lib/history.mjs';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'fbs-hist-'));
  return { root, dataDir: path.join(root, '.feedback') };
}

// Replaying the ops must rebuild both sides. Asserted in every diff test.
function assertReplays(ops, a, b) {
  const split = (s) => {
    if (s === '') return [];
    const p = s.split(/\r?\n/);
    if (p[p.length - 1] === '') p.pop();
    return p;
  };
  const toB = ops.filter((o) => o.op !== '-').map((o) => o.text);
  const toA = ops.filter((o) => o.op !== '+').map((o) => o.text);
  assert.deepEqual(toB, split(b), "'=' plus '+' must rebuild b");
  assert.deepEqual(toA, split(a), "'=' plus '-' must rebuild a");
}

const lines = (...xs) => xs.join('\n');

// ---------- diffLines ----------

test('identical text gives only unchanged lines', () => {
  const a = lines('one', 'two', 'three');
  const ops = diffLines(a, a);
  assert.ok(ops.every((o) => o.op === '='));
  assert.equal(ops.length, 3);
  assertReplays(ops, a, a);
});

test('a pure insert reports only additions', () => {
  const a = lines('one', 'two');
  const b = lines('one', 'inserted', 'two');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 1, removed: 0, same: 2 });
  assert.deepEqual(ops.filter((o) => o.op === '+').map((o) => o.text), ['inserted']);
  assertReplays(ops, a, b);
});

test('a pure delete reports only removals', () => {
  const a = lines('one', 'gone', 'two');
  const b = lines('one', 'two');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 0, removed: 1, same: 2 });
  assert.deepEqual(ops.filter((o) => o.op === '-').map((o) => o.text), ['gone']);
  assertReplays(ops, a, b);
});

test('a replaced middle line lists the removal before the addition', () => {
  const a = lines('one', 'old middle', 'three');
  const b = lines('one', 'new middle', 'three');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1, same: 2 });
  assert.deepEqual(ops.map((o) => o.op), ['=', '-', '+', '=']);
  assertReplays(ops, a, b);
});

test('empty a means every line of b was added', () => {
  const b = lines('one', 'two');
  const ops = diffLines('', b);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 0, same: 0 });
  assertReplays(ops, '', b);
});

test('empty b means every line of a was removed', () => {
  const a = lines('one', 'two');
  const ops = diffLines(a, '');
  assert.deepEqual(diffStats(ops), { added: 0, removed: 2, same: 0 });
  assertReplays(ops, a, '');
});

test('two empty texts diff to nothing', () => {
  assert.deepEqual(diffLines('', ''), []);
});

test('the same text with CRLF and with LF endings is unchanged', () => {
  const crlf = 'one\r\ntwo\r\nthree';
  const lf = 'one\ntwo\nthree';
  const ops = diffLines(crlf, lf);
  assert.ok(ops.every((o) => o.op === '='), 'line endings are not a change');
  assert.equal(ops.length, 3);
});

test('a trailing newline does not add an empty line', () => {
  const ops = diffLines('one\ntwo\n', 'one\ntwo');
  assert.deepEqual(ops.map((o) => o.op), ['=', '=']);
  const withCrlf = diffLines('one\r\ntwo\r\n', 'one\ntwo');
  assert.ok(withCrlf.every((o) => o.op === '='));
});

test('an empty line in the middle is a real line', () => {
  const a = lines('one', 'two', 'three');
  const b = lines('one', '', 'two', 'three');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 1, removed: 0, same: 3 });
  assert.deepEqual(ops.filter((o) => o.op === '+').map((o) => o.text), ['']);
  assertReplays(ops, a, b);
});

test('adding a trailing newline is not something the diff can report', () => {
  // Lines are split on /\r?\n/ with the trailing newline dropped, so these two
  // texts are the same three lines. The server should not offer "newline added"
  // as a change; it is a property of the file, not of the review.
  const ops = diffLines(lines('one', 'two', 'three'), lines('one', 'two', 'three') + '\n');
  assert.ok(ops.every((o) => o.op === '='));
});

test('a 5000-line file with 50 scattered edits diffs quickly and replays', () => {
  const a = [];
  for (let i = 0; i < 5000; i++) a.push('line ' + i + ' of the document');
  const b = a.slice();
  for (let i = 0; i < 50; i++) b[i * 97 + 3] = 'edited line ' + i;
  const aText = a.join('\n');
  const bText = b.join('\n');

  const started = Date.now();
  const ops = diffLines(aText, bText);
  const took = Date.now() - started;

  assert.deepEqual(diffStats(ops), { added: 50, removed: 50, same: 4950 });
  assertReplays(ops, aText, bText);
  assert.ok(took < 2000, 'diff of 5000 lines took ' + took + 'ms, expected well under a second');
});

test('two texts with nothing in common still replay', () => {
  // Far apart enough to go through the whole-block path rather than the shortest edit script.
  const a = [];
  const b = [];
  for (let i = 0; i < 3000; i++) { a.push('alpha ' + i); b.push('omega ' + i); }
  const aText = a.join('\n');
  const bText = b.join('\n');
  const ops = diffLines(aText, bText);
  assert.deepEqual(diffStats(ops), { added: 3000, removed: 3000, same: 0 });
  assertReplays(ops, aText, bText);
});

// ---------- hunks ----------

test('two far-apart edits give two hunks with three lines of context', () => {
  const a = [];
  for (let i = 1; i <= 40; i++) a.push('line ' + i);
  const b = a.slice();
  b[4] = 'changed five';
  b[29] = 'changed thirty';
  const ops = diffLines(a.join('\n'), b.join('\n'));
  const hs = hunks(ops, 3);

  assert.equal(hs.length, 2);
  // Line 5 changed, so the hunk opens on line 2 in both texts.
  assert.equal(hs[0].fromStart, 2);
  assert.equal(hs[0].toStart, 2);
  assert.deepEqual(hs[0].ops.map((o) => o.op), ['=', '=', '=', '-', '+', '=', '=', '=']);
  assert.equal(hs[1].fromStart, 27);
  assert.equal(hs[1].toStart, 27);
  assert.deepEqual(hs[1].ops.map((o) => o.op), ['=', '=', '=', '-', '+', '=', '=', '=']);
});

test('edits separated by exactly six unchanged lines merge into one hunk', () => {
  const a = [];
  for (let i = 1; i <= 30; i++) a.push('line ' + i);
  const b = a.slice();
  b[9] = 'changed ten';
  b[16] = 'changed seventeen'; // six unchanged lines between the two changes
  const ops = diffLines(a.join('\n'), b.join('\n'));
  const hs = hunks(ops, 3);

  assert.equal(hs.length, 1, 'the context of the two changes touches, so they are one hunk');
  assert.equal(hs[0].fromStart, 7);
  assert.equal(hs[0].toStart, 7);
  assert.equal(diffStats(hs[0].ops).added, 2);
  assert.equal(diffStats(hs[0].ops).removed, 2);
});

test('edits separated by seven unchanged lines stay two hunks', () => {
  const a = [];
  for (let i = 1; i <= 30; i++) a.push('line ' + i);
  const b = a.slice();
  b[9] = 'changed ten';
  b[17] = 'changed eighteen'; // seven unchanged lines between them
  const hs = hunks(diffLines(a.join('\n'), b.join('\n')), 3);
  assert.equal(hs.length, 2);
});

test('a hunk that opens with an addition still reports 1-based line numbers', () => {
  const a = lines('one', 'two', 'three');
  const b = lines('added at the top', 'one', 'two', 'three');
  const hs = hunks(diffLines(a, b), 3);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].fromStart, 1, 'the addition sits before line 1 of a');
  assert.equal(hs[0].toStart, 1);
  assert.equal(hs[0].ops[0].op, '+');
});

test('no changes means no hunks', () => {
  assert.deepEqual(hunks(diffLines('one\ntwo', 'one\ntwo'), 3), []);
});

test('zero context gives a hunk of only the changed lines', () => {
  const a = lines('one', 'two', 'three');
  const b = lines('one', 'TWO', 'three');
  const hs = hunks(diffLines(a, b), 0);
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0].ops.map((o) => o.op), ['-', '+']);
  assert.equal(hs[0].fromStart, 2);
  assert.equal(hs[0].toStart, 2);
});

// ---------- slugFor ----------

test('two paths that reduce to the same name get different folders', () => {
  const one = slugFor('docs/a.md');
  const two = slugFor('docs-a.md');
  assert.notEqual(one, two);
  assert.ok(one.startsWith('docs-a.md-'));
  assert.ok(two.startsWith('docs-a.md-'));
});

test('a slug never contains a path separator or a double dot', () => {
  for (const p of ['../../etc/passwd', 'a\\..\\b.md', 'C:\\Users\\me\\doc.md', './x/../y.md', '..', '...']) {
    const s = slugFor(p);
    assert.ok(!s.includes('..'), p + ' produced ' + s);
    assert.ok(!s.includes('/'), p + ' produced ' + s);
    assert.ok(!s.includes('\\'), p + ' produced ' + s);
    assert.ok(!s.startsWith('.') && !s.startsWith('-'), p + ' produced ' + s);
  }
});

test('a Windows-style path and its forward-slash twin share one folder', () => {
  assert.equal(slugFor('docs\\guide\\intro.md'), slugFor('docs/guide/intro.md'));
});

test('a long path is cut to a workable folder name', () => {
  const long = 'a/'.repeat(200) + 'end.md';
  const s = slugFor(long);
  assert.ok(s.length <= 89, 'got ' + s.length + ' characters');
  assert.match(s, /-[0-9a-f]{8}$/);
});

test('a path that reduces to nothing still gets a name', () => {
  const s = slugFor('///');
  assert.match(s, /^file-[0-9a-f]{8}$/);
});

// ---------- recordSnapshot ----------

test('the first snapshot is version 1 with no added or removed lines', async () => {
  const { root, dataDir } = setup();
  try {
    const r = await recordSnapshot(dataDir, 'doc.md', 'one\ntwo\nthree\n', { reason: 'opened' });
    assert.equal(r.changed, true);
    assert.equal(r.version.n, 1);
    assert.equal(r.version.reason, 'opened');
    assert.equal(r.version.added, 0);
    assert.equal(r.version.removed, 0);
    assert.equal(r.version.lines, 3);
    assert.equal(r.version.bytes, Buffer.byteLength('one\ntwo\nthree\n'));
    assert.equal(r.version.commentId, '');
    assert.deepEqual(r.version.resolved, []);
    assert.match(r.version.hash, /^[0-9a-f]{64}$/);
    assert.match(r.version.at, /^\d{4}-\d\d-\d\dT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the same content again writes nothing and reports no change', async () => {
  const { root, dataDir } = setup();
  try {
    const first = await recordSnapshot(dataDir, 'doc.md', 'same\n', { reason: 'opened' });
    const again = await recordSnapshot(dataDir, 'doc.md', 'same\n', { reason: 'changed' });
    assert.equal(again.changed, false);
    assert.deepEqual(again.version, first.version);
    const { versions } = await listVersions(dataDir, 'doc.md');
    assert.equal(versions.length, 1);
    assert.ok(!existsSync(path.join(dataDir, 'history', slugFor('doc.md'), '2.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed file records version 2 with the line counts and the resolved ids', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', lines('one', 'two', 'three'), { reason: 'opened' });
    const r = await recordSnapshot(dataDir, 'doc.md', lines('one', 'TWO', 'three', 'four'), {
      reason: 'changed', commentId: 'c_123', resolved: ['c_123', 'c_456'],
    });
    assert.equal(r.changed, true);
    assert.equal(r.version.n, 2);
    assert.equal(r.version.reason, 'changed');
    assert.equal(r.version.commentId, 'c_123');
    assert.deepEqual(r.version.resolved, ['c_123', 'c_456']);
    assert.equal(r.version.added, 2, 'the retyped line plus the new one');
    assert.equal(r.version.removed, 1);
    assert.equal(r.version.lines, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CRLF content comes back byte for byte', async () => {
  const { root, dataDir } = setup();
  try {
    const crlf = 'one\r\ntwo\r\nthree\r\n';
    await recordSnapshot(dataDir, 'win.md', crlf, { reason: 'opened' });
    const v = await readVersion(dataDir, 'win.md', 1);
    assert.equal(v.content, crlf);
    assert.equal(v.bytes, Buffer.byteLength(crlf));
    assert.equal(v.lines, 3);
    assert.equal(v.n, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('meta falls back to sensible values and rejects an unknown reason', async () => {
  const { root, dataDir } = setup();
  try {
    const bare = await recordSnapshot(dataDir, 'doc.md', 'a\n');
    assert.equal(bare.version.reason, 'manual');
    assert.equal(bare.version.commentId, '');
    assert.deepEqual(bare.version.resolved, []);
    const odd = await recordSnapshot(dataDir, 'doc.md', 'b\n', { reason: 'nonsense', resolved: 'not-an-array' });
    assert.equal(odd.version.reason, 'manual');
    assert.deepEqual(odd.version.resolved, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('going back to older content records a new version', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', 'first\n', { reason: 'opened' });
    await recordSnapshot(dataDir, 'doc.md', 'second\n', { reason: 'changed' });
    const back = await recordSnapshot(dataDir, 'doc.md', 'first\n', { reason: 'restore' });
    assert.equal(back.changed, true, 'only the last version is compared, so a revert is a new version');
    assert.equal(back.version.n, 3);
    assert.equal(back.version.reason, 'restore');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Windows-style path writes into the same history as its forward-slash twin', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'docs/a.md', 'one\n', { reason: 'opened' });
    const r = await recordSnapshot(dataDir, 'docs\\a.md', 'two\n', { reason: 'changed' });
    assert.equal(r.version.n, 2);
    const { file, versions } = await listVersions(dataDir, 'docs/a.md');
    assert.equal(versions.length, 2);
    assert.equal(file, 'docs/a.md', 'the index records forward slashes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- pruning ----------

test('205 snapshots leave 200 versions, keep version 1 and drop the old files', async () => {
  const { root, dataDir } = setup();
  try {
    for (let i = 1; i <= 205; i++) {
      await recordSnapshot(dataDir, 'big.md', 'revision ' + i + '\n', { reason: i === 1 ? 'opened' : 'changed' });
    }
    const { versions } = await listVersions(dataDir, 'big.md');
    assert.equal(versions.length, 200);
    assert.equal(versions[0].n, 1, 'the first version is never dropped');
    assert.equal(versions[1].n, 7, 'versions 2 to 6 were pruned');
    assert.equal(versions[versions.length - 1].n, 205, 'numbers keep counting up');

    const dir = path.join(dataDir, 'history', slugFor('big.md'));
    assert.ok(existsSync(path.join(dir, '1.md')));
    for (let n = 2; n <= 6; n++) {
      assert.ok(!existsSync(path.join(dir, n + '.md')), 'version ' + n + ' file should be gone');
    }
    assert.ok(existsSync(path.join(dir, '7.md')));
    assert.ok(existsSync(path.join(dir, '205.md')));

    const one = await readVersion(dataDir, 'big.md', 1);
    assert.equal(one.content, 'revision 1\n');
    assert.equal(await readVersion(dataDir, 'big.md', 3), null, 'a pruned version is gone from the index too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- listing, reading, corrupt data ----------

test('a file with no history lists nothing', async () => {
  const { root, dataDir } = setup();
  try {
    assert.deepEqual(await listVersions(dataDir, 'never-seen.md'), { file: 'never-seen.md', versions: [] });
    assert.equal(await latestVersion(dataDir, 'never-seen.md'), null);
    assert.equal(await readVersion(dataDir, 'never-seen.md', 1), null);
    assert.equal(await diffVersions(dataDir, 'never-seen.md', 1, 2), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reading a version that does not exist returns null', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', 'one\n', { reason: 'opened' });
    assert.equal(await readVersion(dataDir, 'doc.md', 2), null);
    assert.equal(await readVersion(dataDir, 'doc.md', 0), null);
    assert.equal(await readVersion(dataDir, 'doc.md', 'nope'), null);
    assert.ok(await readVersion(dataDir, 'doc.md', 1));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('latestVersion reports the newest entry', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', 'one\n', { reason: 'opened' });
    await recordSnapshot(dataDir, 'doc.md', 'two\n', { reason: 'changed' });
    const latest = await latestVersion(dataDir, 'doc.md');
    assert.equal(latest.n, 2);
    assert.equal(latest.reason, 'changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt index.json throws ECORRUPT rather than reporting no history', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', 'one\n', { reason: 'opened' });
    const idx = path.join(dataDir, 'history', slugFor('doc.md'), 'index.json');

    writeFileSync(idx, '{ not json at all');
    await assert.rejects(() => listVersions(dataDir, 'doc.md'), (e) => e.code === 'ECORRUPT');

    writeFileSync(idx, '{"file":"doc.md"}');
    await assert.rejects(() => listVersions(dataDir, 'doc.md'), (e) => e.code === 'ECORRUPT');
    await assert.rejects(() => recordSnapshot(dataDir, 'doc.md', 'two\n'), (e) => e.code === 'ECORRUPT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an index that names a version whose file was deleted reads as missing', async () => {
  const { root, dataDir } = setup();
  try {
    await recordSnapshot(dataDir, 'doc.md', 'one\n', { reason: 'opened' });
    rmSync(path.join(dataDir, 'history', slugFor('doc.md'), '1.md'));
    assert.equal(await readVersion(dataDir, 'doc.md', 1), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- diffVersions ----------

test('diffVersions returns both entries with the ops, stats and hunks', async () => {
  const { root, dataDir } = setup();
  try {
    const base = [];
    for (let i = 1; i <= 20; i++) base.push('line ' + i);
    await recordSnapshot(dataDir, 'doc.md', base.join('\n'), { reason: 'opened' });

    const two = base.slice();
    two[4] = 'edited five';
    await recordSnapshot(dataDir, 'doc.md', two.join('\n'), { reason: 'changed', commentId: 'c_1' });

    const three = two.slice();
    three[14] = 'edited fifteen';
    three.push('a new last line');
    await recordSnapshot(dataDir, 'doc.md', three.join('\n'), { reason: 'batch', resolved: ['c_1'] });

    const d = await diffVersions(dataDir, 'doc.md', 1, 3);
    assert.equal(d.from.n, 1);
    assert.equal(d.from.reason, 'opened');
    assert.equal(d.to.n, 3);
    assert.equal(d.to.reason, 'batch');
    assert.deepEqual(d.to.resolved, ['c_1']);
    assert.equal(d.from.content, undefined, 'the entries carry no content');

    assert.deepEqual(d.stats, { added: 3, removed: 2, same: 18 });
    assertReplays(d.ops, base.join('\n'), three.join('\n'));
    assert.equal(d.hunks.length, 2, 'the two edits are far enough apart');
    assert.equal(d.hunks[0].fromStart, 2);

    const missing = await diffVersions(dataDir, 'doc.md', 1, 99);
    assert.equal(missing, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('history sits under the data dir even when the data dir already has content', async () => {
  const { root, dataDir } = setup();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'comments.json'), '{"version":1,"comments":[]}');
    await recordSnapshot(dataDir, 'doc.md', 'one\n', { reason: 'opened' });
    assert.ok(existsSync(path.join(dataDir, 'history', slugFor('doc.md'), 'index.json')));
    assert.ok(existsSync(path.join(dataDir, 'comments.json')), 'nothing else in the data dir is touched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
