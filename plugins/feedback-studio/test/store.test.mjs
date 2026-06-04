// Tests for the shared store. Run with: node --test
// Zero dependencies — uses the built-in node:test runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEB_TYPES, MD_TYPES, ALLOWED_TYPES, STATUSES,
  makeComment, makeReply, coerceType, sanitizeAnchor,
  readComments, writeComments, mutate, exportMarkdown,
} from '../lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function freshDir() { return mkdtempSync(path.join(tmpdir(), 'fbs-')); }

test('makeComment: web default type is "change", md default is "comment"', () => {
  assert.equal(makeComment({ text: 'x' }).type, 'change');
  assert.equal(makeComment({ text: 'x', sourceFile: 'doc.md' }).type, 'comment');
});

test('makeComment: a type from the wrong mode is coerced to the mode default', () => {
  // "delete" is a Markdown verb; on a web page it must not be stored.
  assert.equal(makeComment({ text: 'x', type: 'delete' }).type, 'change');
  // "fix" is a web verb; on a .md it must not be stored.
  assert.equal(makeComment({ text: 'x', type: 'fix', sourceFile: 'a.md' }).type, 'comment');
  // a valid in-mode type is kept
  assert.equal(makeComment({ text: 'x', type: 'improve' }).type, 'improve');
});

test('coerceType respects the mode', () => {
  assert.equal(coerceType('rephrase', 'md'), 'rephrase');
  assert.equal(coerceType('rephrase', 'web'), 'change');
  assert.equal(coerceType(undefined, 'md'), 'comment');
});

test('makeComment has a stable, complete schema and unique ids', () => {
  const c = makeComment({ page: '/p', text: '  hi  ', author: 'agent', authorName: 'bot' });
  assert.equal(c.schemaVersion, 3);
  assert.equal(c.text, 'hi');
  assert.equal(c.author, 'agent');
  assert.equal(c.status, 'open');
  assert.ok(Array.isArray(c.thread));
  assert.notEqual(makeComment({ text: 'a' }).id, makeComment({ text: 'a' }).id);
});

test('sanitizeAnchor whitelists keys and caps lengths', () => {
  const a = sanitizeAnchor({ selector: 'a', evil: 'x', snippet: 'y'.repeat(2000) });
  assert.equal(a.evil, undefined);
  assert.equal(a.type, 'element');
  assert.ok(a.snippet.length <= 500);
});

test('readComments: missing file is empty, corrupt file throws (never silently empty)', async () => {
  const dir = freshDir();
  try {
    assert.deepEqual(await readComments(dir), []);
    writeFileSync(path.join(dir, 'comments.json'), '{ this is not json');
    await assert.rejects(() => readComments(dir), (e) => e.code === 'ECORRUPT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeComments is atomic and round-trips', async () => {
  const dir = freshDir();
  try {
    const c = makeComment({ text: 'hello' });
    await writeComments(dir, [c]);
    const back = await readComments(dir);
    assert.equal(back.length, 1);
    assert.equal(back[0].text, 'hello');
    // a readable mirror is written too
    assert.ok(readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf-8').includes('Feedback export'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mutate: concurrent appends do not lose updates (lock works)', async () => {
  const dir = freshDir();
  try {
    const N = 40;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      mutate(dir, (list) => { list.push(makeComment({ text: 'c' + i })); return { comments: list, value: null }; })
    ));
    assert.equal((await readComments(dir)).length, N);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exportMarkdown escapes backticks so comment text cannot break the table', async () => {
  const dir = freshDir();
  try {
    await exportMarkdown(dir, [makeComment({ text: 'use `code` here', anchor: { selector: 'a`b' } })]);
    const md = readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf-8');
    assert.ok(!md.includes('`a`b`')); // the raw backtick in the selector must be neutralised
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('makeReply trims and defaults author', () => {
  assert.equal(makeReply({ text: ' hi ' }).author, 'user');
  assert.equal(makeReply({ text: 'x', author: 'agent' }).author, 'agent');
  assert.equal(makeReply({ text: ' hi ' }).text, 'hi');
});

test('the overlay type set matches the shared constants (no drift)', () => {
  const src = readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf-8');
  // Pull the { id: 'x' } entries out of the TYPE_SETS block.
  const block = src.slice(src.indexOf('TYPE_SETS'), src.indexOf('const TYPES'));
  const ids = new Set([...block.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]));
  for (const t of ALLOWED_TYPES) assert.ok(ids.has(t), 'overlay is missing type "' + t + '"');
  assert.equal(ids.size, ALLOWED_TYPES.length, 'overlay has an extra/unknown type');
});

test('status + type constant invariants', () => {
  assert.deepEqual(ALLOWED_TYPES, [...WEB_TYPES, ...MD_TYPES]);
  assert.deepEqual(STATUSES, ['open', 'approved', 'rejected', 'resolved']);
});
