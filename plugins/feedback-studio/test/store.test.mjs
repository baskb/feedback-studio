// Tests for the shared store. Run with: node --test
// Zero dependencies — uses the built-in node:test runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEB_TYPES, MD_TYPES, ALLOWED_TYPES, STATUSES, TWEAKABLE_PROPS,
  makeComment, makeReply, coerceType, sanitizeAnchor, sanitizeEdits, sanitizeTextEdit,
  sanitizeVariants, sanitizeVariantHtml, sanitizePick, decodeEntities, schemeIsEvil,
  readComments, writeComments, mutate, exportMarkdown,
  exportProcessInstructions, seedAgentsFile, AGENTS_SNIPPET_MARKER,
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
  assert.equal(c.schemaVersion, 4);
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

test('readComments: valid JSON with the wrong shape also throws ECORRUPT', async () => {
  // Treating a wrong-shaped file as empty would let the next write clobber it.
  const dir = freshDir();
  try {
    for (const body of ['{"comments": {}}', '"a string"', '[]', '{"version":1}']) {
      writeFileSync(path.join(dir, 'comments.json'), body);
      await assert.rejects(() => readComments(dir), (e) => e.code === 'ECORRUPT', 'should reject: ' + body);
    }
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

test('exportProcessInstructions writes a self-contained, MCP-first guide', async () => {
  const dir = freshDir();
  try {
    await exportProcessInstructions(dir);
    const md = readFileSync(path.join(dir, 'HOW-TO-PROCESS.md'), 'utf-8');
    assert.ok(md.includes('comments.json'));        // names the source of truth
    assert.ok(md.includes('do NOT edit a guess'));  // the load-bearing refuse-to-guess rule
    assert.ok(md.includes('set_status'));           // MCP-first resolve path
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seedAgentsFile creates-if-absent, appends, and is idempotent', async () => {
  const dir = freshDir();
  try {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const fp = path.join(dir, name);
      const r1 = await seedAgentsFile(fp);
      assert.deepEqual(r1, { seeded: true, created: true });
      const r2 = await seedAgentsFile(fp); // marker present → no-op
      assert.equal(r2.seeded, false);
      const body = readFileSync(fp, 'utf-8');
      assert.equal(body.split(AGENTS_SNIPPET_MARKER).length - 1, 1, name + ': exactly one snippet');
    }
    // appends to an existing file without clobbering its content
    const fp = path.join(dir, 'HAS_CONTENT.md');
    writeFileSync(fp, '# My project\n\nExisting notes.\n');
    await seedAgentsFile(fp);
    const body = readFileSync(fp, 'utf-8');
    assert.ok(body.includes('Existing notes.') && body.includes('Feedback Studio'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status + type constant invariants', () => {
  assert.deepEqual(ALLOWED_TYPES, [...WEB_TYPES, ...MD_TYPES]);
  assert.deepEqual(STATUSES, ['open', 'approved', 'rejected', 'resolved']);
});

test('sanitizeEdits: whitelists props, dedupes, drops no-ops and breakout characters', () => {
  const out = sanitizeEdits([
    { prop: 'padding', from: '16px', to: '24px' },
    { prop: 'padding', from: '16px', to: '32px' },          // dupe prop → dropped
    { prop: 'position', from: 'static', to: 'fixed' },      // not whitelisted
    { prop: 'color', from: '#111111', to: '#111111' },      // unchanged → dropped
    { prop: 'margin', from: '0px', to: '8px; } body { x' }, // ';{}' breakout → dropped
    { prop: 'font-size', to: '18px' },                      // missing from is fine
    'garbage', null,
  ]);
  assert.deepEqual(out, [
    { prop: 'padding', from: '16px', to: '24px' },
    { prop: 'font-size', from: '', to: '18px' },
  ]);
});

test('sanitizeEdits caps the list and value lengths', () => {
  const many = TWEAKABLE_PROPS.map((p) => ({ prop: p, from: 'a', to: 'b'.repeat(200) }));
  const out = sanitizeEdits(many);
  assert.ok(out.length <= 16);
  for (const e of out) assert.ok(e.to.length <= 60);
});

test('makeComment: edits kept on web comments, stripped in md mode', () => {
  const edits = [{ prop: 'padding', from: '16px', to: '24px' }];
  assert.deepEqual(makeComment({ text: 'x', edits }).edits, edits);
  assert.deepEqual(makeComment({ text: 'x', edits, sourceFile: 'doc.md' }).edits, []);
  // edits-only comments (no text) are legal — the deltas ARE the request
  assert.equal(makeComment({ edits }).text, '');
});

test('exportMarkdown renders tweak lines for edits', async () => {
  const dir = freshDir();
  try {
    await exportMarkdown(dir, [makeComment({ edits: [{ prop: 'padding', from: '16px', to: '24px' }] })]);
    const md = readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf-8');
    assert.ok(md.includes('tweak: `padding` `16px` → `24px`'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sanitizeTextEdit: collapses whitespace, drops empty/unchanged/garbage', () => {
  assert.deepEqual(sanitizeTextEdit({ before: 'Best  coffee\nbeens', after: 'Best coffee beans' }),
    { before: 'Best coffee beens', after: 'Best coffee beans' });
  assert.equal(sanitizeTextEdit({ before: 'same', after: '  same ' }), null); // unchanged
  assert.equal(sanitizeTextEdit({ before: 'x', after: '' }), null);           // empty target
  assert.equal(sanitizeTextEdit('garbage'), null);
  assert.equal(sanitizeTextEdit(null), null);
  assert.ok(sanitizeTextEdit({ before: '', after: 'brand new' }));            // pure insertion is fine
  assert.ok(sanitizeTextEdit({ before: 'a'.repeat(5000), after: 'b' }).before.length <= 2000);
});

test('makeComment: textEdit survives in BOTH modes (md is the headline use)', () => {
  const textEdit = { before: 'teh', after: 'the' };
  assert.deepEqual(makeComment({ text: 'x', textEdit }).textEdit, textEdit);
  assert.deepEqual(makeComment({ text: 'x', textEdit, sourceFile: 'doc.md' }).textEdit, textEdit);
  // a textEdit-only comment (no text) is legal — the diff IS the request
  assert.equal(makeComment({ textEdit }).text, '');
  assert.equal(makeComment({ text: 'x' }).textEdit, null);
});

test('exportMarkdown renders shot lines', async () => {
  const dir = freshDir();
  try {
    const c = makeComment({ text: 'x' });
    c.shot = 'shots/' + c.id + '.png';
    await exportMarkdown(dir, [c]);
    const md = readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf-8');
    assert.ok(md.includes('shot: `shots/' + c.id + '.png`'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exportMarkdown renders text-edit lines', async () => {
  const dir = freshDir();
  try {
    await exportMarkdown(dir, [makeComment({ textEdit: { before: 'beens', after: 'beans' } })]);
    const md = readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf-8');
    assert.ok(md.includes('text edit: "beens" → "beans"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sanitizeVariantHtml strips everything executable (it is injected into the host page)', () => {
  const dirty = `<div class="hero"><script>alert(1)</script><style>*{}</style>
    <img src="x" onerror="alert(1)"><img/onerror='alert(1)' src=x>
    <a href="javascript:alert(1)">x</a><a href='JAVASCRIPT:alert(1)'>y</a>
    <iframe src="https://evil"></iframe><form action="https://evil"><input formaction="javascript:x"></form>
    <a href="https://ok.example">fine</a><b style="color:red">bold ok</b></div>`;
  const clean = sanitizeVariantHtml(dirty);
  assert.ok(!/script|<style|<iframe|<form|onerror/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  assert.ok(clean.includes('https://ok.example'));       // safe href kept
  assert.ok(clean.includes('style="color:red"'));        // inline styles kept (variants need them)
});

test('sanitizeVariantHtml defeats encoding-evasion vectors (the confirmed bypass class)', () => {
  // entity-encoded scheme: browser decodes &#106; to "j" at render time
  const a = sanitizeVariantHtml('<a href="&#106;avascript:alert(1)">x</a>');
  assert.ok(!/javascript|&#106;avascript/i.test(a) || a.includes('href="#"'), 'entity-encoded javascript: must be neutralised: ' + a);
  assert.ok(a.includes('href="#"'));
  // hex entities + missing semicolons
  assert.ok(sanitizeVariantHtml('<a href="&#x6A;avascript:alert(1)">x</a>').includes('href="#"'));
  assert.ok(sanitizeVariantHtml('<a href="&#106avascript:alert(1)">x</a>').includes('href="#"'));
  // whitespace/control-split scheme
  assert.ok(sanitizeVariantHtml('<a href="java\tscript:alert(1)">x</a>').includes('href="#"'));
  assert.ok(sanitizeVariantHtml('<a href="jav\nascript:alert(1)">x</a>').includes('href="#"'));
  // named-entity colon
  assert.ok(sanitizeVariantHtml('<a href="javascript&colon;alert(1)">x</a>').includes('href="#"'));
  // srcdoc always dropped, even when innocuous-looking
  assert.ok(sanitizeVariantHtml('<iframe srcdoc="<b>x</b>"></iframe>') === '' || !/srcdoc/i.test(sanitizeVariantHtml('<div srcdoc="x">y</div>')) || sanitizeVariantHtml('<div srcdoc="x">y</div>').includes('srcdoc="#"'));
  // CSS url() exfil beacons stripped from kept style attributes…
  const s1 = sanitizeVariantHtml('<div style="background:url(https://evil.example/x.png);color:red">hi</div>');
  assert.ok(!s1.includes('evil.example') && s1.includes('color:red'));
  // …including entity-encoded url( in the attribute value
  const s2 = sanitizeVariantHtml('<div style="background:&#117;rl(https://evil.example/x)">hi</div>');
  assert.ok(!s2.includes('evil.example'));
  // fragment + data:image survive (legitimate variant styling)
  const s3 = sanitizeVariantHtml('<div style="background:url(#grad);cursor:url(data:image/png;base64,AA==),auto">hi</div>');
  assert.ok(s3.includes('url(#grad)'));
  // nested-tag evasion still collapses to nothing executable
  assert.ok(!/script/i.test(sanitizeVariantHtml('<scr<script>ipt>alert(1)</scr</script>ipt>')));
});

test('the overlay re-scrubs variants through a real parser before injection (no drift)', () => {
  const src = readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf-8');
  // the injection site must go through the parser-based scrub, never raw html
  assert.ok(src.includes('scrubVariantHtml('), 'overlay must define/use scrubVariantHtml');
  assert.ok(!/container\.innerHTML\s*=\s*v\.reply\.variants/.test(src), 'variants must never be injected unscrubbed');
  // and the scrub must use an inert template (parser-decoded attributes)
  assert.ok(src.includes("createElement('template')"));
});

test('schemeIsEvil decodes entities + strips control chars before the scheme check', () => {
  assert.ok(schemeIsEvil('javascript:alert(1)'));
  assert.ok(schemeIsEvil('&#106;avascript:alert(1)'));   // decimal entity
  assert.ok(schemeIsEvil('&#x6A;avascript:alert(1)'));   // hex entity
  assert.ok(schemeIsEvil('java\tscript:alert(1)'));      // control-split
  assert.ok(schemeIsEvil('javascript&colon;alert(1)'));  // named-entity colon
  assert.ok(schemeIsEvil('data:text/html,<b>'));
  assert.ok(!schemeIsEvil('https://example.com/x'));     // real links pass
  assert.ok(!schemeIsEvil('/relative/path'));
  assert.ok(!schemeIsEvil('#frag'));
  assert.equal(decodeEntities('&#106;&#x6a;'), 'jj');
});

test('sanitizeVariantHtml strips external eager-resource URLs (preview beacons)', () => {
  // external img src / poster / srcset → neutralised; relative + data:image kept
  assert.ok(!/evil\.example/.test(sanitizeVariantHtml('<img src="https://evil.example/x.png">')));
  assert.ok(!/evil\.example/.test(sanitizeVariantHtml('<video poster="//evil.example/p.jpg"></video>')));
  assert.ok(!/evil\.example/.test(sanitizeVariantHtml('<img srcset="https://evil.example/x.png 2x">')));
  const rel = sanitizeVariantHtml('<img src="/logo.png">');
  assert.ok(rel.includes('/logo.png'));
  const data = sanitizeVariantHtml('<img src="data:image/png;base64,AAAA">');
  assert.ok(data.includes('data:image/png'));
});

test('sanitizeVariants: caps count + label/note lengths, auto-labels, drops empty html', () => {
  const out = sanitizeVariants([
    { html: '<p>a</p>' },                                 // auto label "A"
    { label: 'x'.repeat(100), html: '<p>b</p>', note: 'n'.repeat(500) },
    { html: '<script>only</script>' },                    // sanitizes to empty → dropped
    { html: '<p>c</p>' }, { html: '<p>d</p>' }, { html: '<p>e</p>' }, // over the cap
    'junk', null,
  ]);
  assert.equal(out.length, 4); // VARIANTS_MAX
  assert.equal(out[0].label, 'A');
  assert.ok(out[1].label.length <= 40 && out[1].note.length <= 300);
});

test('makeReply carries sanitized variants and pick; junk pick is dropped', () => {
  const r = makeReply({ text: '3 options', author: 'agent', variants: [{ label: 'Bold', html: '<p onclick="x()">hi</p>' }] });
  assert.equal(r.variants.length, 1);
  assert.ok(!r.variants[0].html.includes('onclick'));
  const p = makeReply({ text: 'Picked: Bold', pick: { of: 'r_1', index: 0, label: 'Bold' } });
  assert.deepEqual(p.pick, { of: 'r_1', index: 0, label: 'Bold' });
  assert.equal(makeReply({ text: 'x', pick: { index: 99 } }).pick, undefined);
  assert.equal(makeReply({ text: 'x' }).variants, undefined); // plain replies stay lean
});

test('the overlay tweak controls are a subset of TWEAKABLE_PROPS (no drift)', () => {
  const src = readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf-8');
  const block = src.slice(src.indexOf('TWEAK_CONTROLS'), src.indexOf('function clearTweakPreview'));
  const props = [...block.matchAll(/prop:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(props.length >= 5, 'expected the overlay to declare tweak controls');
  for (const p of props) assert.ok(TWEAKABLE_PROPS.includes(p), `overlay tweak prop "${p}" is not in TWEAKABLE_PROPS`);
});
