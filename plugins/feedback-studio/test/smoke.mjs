// Live smoke test: boots the server against a temp site and exercises the HTTP
// surface (injection, API, CSRF guard, path-traversal guard). Not part of the
// unit suite — run manually: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Send a raw HTTP request so we can set a Host header fetch() won't let us forge
// (used to exercise the DNS-rebinding guard). Resolves with the status line.
function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n')));
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); } });
    sock.on('error', reject);
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('raw request timeout')); });
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'fbs-smoke-'));
const site = path.join(root, 'site');
mkdirSync(site);
writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><body><h1 id="t">Hi</h1></body></html>');
writeFileSync(path.join(site, '404.html'), '<!doctype html><html><body><h1>custom not found</h1></body></html>');
writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
// A 1000-byte file with a repeating pattern, so a byte range can be compared
// against exactly the bytes that were asked for.
const RANGE_BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => 97 + (i % 26)));
writeFileSync(path.join(site, 'range.bin'), RANGE_BODY);

const PORT = 4567;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const bin = path.join(__dirname, '..', 'bin', 'feedback-studio.mjs');
const srv = spawn(process.execPath, [bin, '--dir', site, '--port', String(PORT), '--no-open'], { stdio: 'ignore', cwd: root });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; }

// The Markdown renderer is installed lazily on first use, so a machine with no
// network has none and the --md page checks have nothing to look at. That is a
// skip locally and a failure in CI, where a workflow step installs it first.
function mdRenderMissing(what) {
  if (process.env.CI) check(`${what} (the Markdown renderer must be installed in CI)`, false);
  else console.log(`SKIP  ${what} (marked renderer unavailable)`);
}

// Run the CLI once and wait for it to finish, collecting both output streams
// together, since which stream a message went to is not what these checks test.
function runCli(cliArgs, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...cliArgs], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

// Wait for a freshly spawned server to answer, instead of guessing how long it
// needs. Any answer counts, including a 401 under --share strict: this asks
// whether the port is listening, not whether the request was allowed.
async function waitForReady(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(`http://127.0.0.1:${port}/__feedback/api/comments`); return true; }
    catch (e) { await sleep(100); }
  }
  return false;
}

// Wait for every server a block needs. A port that never answers stops the run
// with one clear line instead of a pile of assertion failures against nothing.
async function ready(...ports) {
  for (const p of ports) {
    if (!(await waitForReady(p))) throw new Error(`no server answered on port ${p}`);
  }
}

try {
  await ready(PORT);

  // --help is generated from the FLAGS list in the CLI, so read the names out of
  // the source: a flag added there without a help line fails this check.
  const cliSrc = readFileSync(bin, 'utf8');
  const flagBlock = /const FLAGS = \[([\s\S]*?)\n\];/.exec(cliSrc);
  const flagNames = flagBlock ? [...flagBlock[1].matchAll(/name: '(--[a-z-]+)'/g)].map((m) => m[1]) : [];
  const helpRun = await runCli(['--help', 'a-positional-word'], root);
  check('--help lists every flag, exits 0, starts no server',
    flagNames.length >= 17 && helpRun.code === 0 && helpRun.out.includes('Usage: feedback-studio')
    && flagNames.every((f) => helpRun.out.includes(f)) && !helpRun.out.includes('Ctrl+C to stop'));
  const shortHelp = await runCli(['-h'], root);
  check('-h does the same as --help', shortHelp.code === 0 && shortHelp.out.includes('Usage: feedback-studio'));
  const pluginVersion = JSON.parse(readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const versionRun = await runCli(['--version'], root);
  const shortVersion = await runCli(['-v'], root);
  check('--version prints the plugin manifest version and exits 0',
    versionRun.code === 0 && versionRun.out.trim() === pluginVersion && shortVersion.out.trim() === pluginVersion);
  const unknownRun = await runCli(['--proxi', 'http://127.0.0.1:1'], root);
  check('a misspelled flag exits 1 and says which one',
    unknownRun.code === 1 && unknownRun.out.includes('unknown option --proxi') && unknownRun.out.includes('Usage: feedback-studio'));
  // "--share strict" and "--flag=value" must not read as unknown options. Run
  // them past the check with --seed-agents, which exits 0 without a server (in
  // its own folder, since it writes CLAUDE.md / AGENTS.md into the cwd).
  const seedCwd = mkdtempSync(path.join(tmpdir(), 'fbs-seed-'));
  const valueForms = await runCli(['--share', 'strict', '--port=4599', '--no-shots', '--seed-agents'], seedCwd);
  check('"--share strict" and --flag=value are not read as unknown options',
    valueForms.code === 0 && !valueForms.out.includes('unknown option'));
  rmSync(seedCwd, { recursive: true, force: true });

  const home = await fetch(ORIGIN + '/');
  const homeBody = await home.text();
  check('serves index', home.status === 200);
  check('injects overlay script', homeBody.includes('/__feedback/overlay.js'));

  // Byte ranges (a video scrubbing, a resumed download) and HEAD (a link check).
  const ranged = await fetch(ORIGIN + '/range.bin', { headers: { Range: 'bytes=100-199' } });
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  check('Range: bytes=100-199 returns 206 with exactly those 100 bytes',
    ranged.status === 206 && ranged.headers.get('accept-ranges') === 'bytes'
    && ranged.headers.get('content-range') === 'bytes 100-199/1000'
    && ranged.headers.get('content-length') === '100'
    && rangedBody.length === 100 && rangedBody.equals(RANGE_BODY.subarray(100, 200)));
  const tailRange = await fetch(ORIGIN + '/range.bin', { headers: { Range: 'bytes=-50' } });
  check('Range: bytes=-50 returns the last 50 bytes',
    tailRange.status === 206 && tailRange.headers.get('content-range') === 'bytes 950-999/1000');
  const badRange = await fetch(ORIGIN + '/range.bin', { headers: { Range: 'bytes=5000-6000' } });
  check('a range past the end of the file => 416',
    badRange.status === 416 && badRange.headers.get('content-range') === 'bytes */1000');
  const junkRange = await fetch(ORIGIN + '/range.bin', { headers: { Range: 'bytes=0-10, 20-30' } });
  check('a range header we do not honour falls back to the whole file (200)',
    junkRange.status === 200 && junkRange.headers.get('content-length') === '1000');
  const headFile = await fetch(ORIGIN + '/range.bin', { method: 'HEAD' });
  check('HEAD on a file returns the headers and no body',
    headFile.status === 200 && headFile.headers.get('content-length') === '1000'
    && headFile.headers.get('accept-ranges') === 'bytes'
    && (await headFile.arrayBuffer()).byteLength === 0);
  const headPage = await fetch(ORIGIN + '/', { method: 'HEAD' });
  check('HEAD on a page reports the length WITH the overlay added, and no body',
    headPage.status === 200
    && Number(headPage.headers.get('content-length')) === Buffer.byteLength(homeBody)
    && (await headPage.arrayBuffer()).byteLength === 0);

  // a custom 404.html must keep its 404 status (writeHead used to force 200)
  const miss = await fetch(ORIGIN + '/no-such-page');
  const missBody = await miss.text();
  check('custom 404.html served with status 404', miss.status === 404 && missBody.includes('custom not found'));
  check('404 page gets the overlay too', missBody.includes('/__feedback/overlay.js'));

  const list = await (await fetch(ORIGIN + '/__feedback/api/comments')).json();
  check('GET comments returns array', Array.isArray(list.comments));

  const good = await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ page: '/', text: 'same-origin works', anchor: { selector: '#t', snippet: 'Hi' } }),
  });
  check('same-origin POST accepted (201)', good.status === 201);

  const evil = await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ page: '/', text: 'cross-site' }),
  });
  check('cross-site POST blocked (403)', evil.status === 403);

  const bad = await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{ not json',
  });
  check('malformed JSON => 400', bad.status === 400);

  // DNS-rebinding guard: a forged Host the server doesn't recognise is refused
  // on a mutating request, even with no Origin header (so the cross-site check
  // alone would let it through). The loopback-Host accept path is already proven
  // by the same-origin fetch above (fetch sets Host: 127.0.0.1), so this only
  // asserts the negative — and a 403 writes nothing, leaving persistence intact.
  const rebindBody = JSON.stringify({ page: '/', text: 'rebinding' });
  const rebind = await rawRequest(PORT, [
    'POST /__feedback/api/comments HTTP/1.1', 'Host: evil.example',
    'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(rebindBody)}`,
    'Connection: close', '', rebindBody,
  ]);
  check('forged Host blocked (403)', rebind.includes('403'));

  // …and READS are gated against rebinding too (a rebound page could otherwise
  // read the review data via API GETs or the SSE stream).
  const rebindRead = await rawRequest(PORT, [
    'GET /__feedback/api/comments HTTP/1.1', 'Host: evil.example', 'Connection: close', '', '',
  ]);
  check('forged-Host read blocked (403)', rebindRead.includes('403'));

  // …and the SERVED SITE is guarded too (not just the /__feedback data surface):
  // a rebound origin must not read local page content or pivot through a proxy.
  const rebindPage = await rawRequest(PORT, [
    'GET / HTTP/1.1', 'Host: evil.example', 'Connection: close', '', '',
  ]);
  check('forged-Host page read blocked (403)', rebindPage.includes('403'));

  const trav = await fetch(ORIGIN + '/%2e%2e/%2e%2e/secret.txt');
  const travBody = await trav.text();
  check('path traversal blocked', trav.status === 404 && !travBody.includes('TOP SECRET'));

  const asset = await fetch(ORIGIN + '/__feedback/overlay.js');
  const assetBody = await asset.text();
  check('serves overlay entry module at the old URL', asset.status === 200 && /javascript/.test(asset.headers.get('content-type') || '') && /\bimport\b/.test(assetBody));
  check('overlay is injected as a module script', /<script type="module" src="\/__feedback\/overlay\.js"><\/script>/.test(homeBody));
  const part = await fetch(ORIGIN + '/__feedback/overlay/state.mjs');
  check('serves an overlay module part', part.status === 200 && /javascript/.test(part.headers.get('content-type') || ''));
  const anchorMod = await fetch(ORIGIN + '/__feedback/lib/anchor.mjs');
  check('serves the shared anchor module', anchorMod.status === 200 && (await anchorMod.text()).includes('export function createAnchoring'));
  const escapeMod = await fetch(ORIGIN + '/__feedback/lib/..%2Fbin%2Ffeedback-studio.mjs');
  const dotted = await fetch(ORIGIN + '/__feedback/overlay/nope.txt');
  check('module routes take one plain .mjs file name only', escapeMod.status === 404 && dotted.status === 404);

  // narration correlation engine is served as an ES module the overlay imports
  const narr = await fetch(ORIGIN + '/__feedback/lib/narration.mjs');
  const narrBody = await narr.text();
  check('serves narration engine module', narr.status === 200
    && /javascript/.test(narr.headers.get('content-type') || '')
    && narrBody.includes('export function correlate'));

  // the same-origin comment should have persisted
  const after = await (await fetch(ORIGIN + '/__feedback/api/comments')).json();
  check('comment persisted', after.comments.length === 1 && after.comments[0].text === 'same-origin works');

  // Tweak Mode: edits round-trip on POST (sanitized), and PATCH can rewrite them
  const tw = await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      page: '/', text: '', anchor: { selector: '#t', snippet: 'Hi' },
      edits: [{ prop: 'padding', from: '16px', to: '24px' }, { prop: 'position', from: 'static', to: 'fixed' }],
    }),
  });
  const twc = (await tw.json()).comment;
  check('edits-only comment accepted, whitelist enforced', tw.status === 201
    && twc.edits.length === 1 && twc.edits[0].prop === 'padding' && twc.edits[0].to === '24px');
  const twp = await fetch(ORIGIN + '/__feedback/api/comments/' + twc.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ edits: [{ prop: 'color', from: '#111111', to: '#0f766e' }] }),
  });
  const twp2 = (await twp.json()).comment;
  check('PATCH rewrites edits', twp.status === 200 && twp2.edits.length === 1 && twp2.edits[0].prop === 'color');
  // PATCH type is coerced to the comment's mode: a web comment can't take an md verb
  const twt = await fetch(ORIGIN + '/__feedback/api/comments/' + twc.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ type: 'delete' }), // 'delete' is a Markdown verb
  });
  check('PATCH type coerced to web mode', twt.status === 200 && (await twt.json()).comment.type === 'change');
  // Re-pin: PATCH anchor replaces the stored anchor, sanitized (whitelisted
  // keys only) — the overlay's shaky/lost re-pin flow depends on this.
  const twa = await fetch(ORIGIN + '/__feedback/api/comments/' + twc.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ anchor: { selector: '#new-spot', snippet: 'Repinned', evil: 'x' } }),
  });
  const twa2 = (await twa.json()).comment;
  check('PATCH anchor re-pins (sanitized)', twa.status === 200
    && twa2.anchor && twa2.anchor.selector === '#new-spot' && twa2.anchor.snippet === 'Repinned' && !('evil' in twa2.anchor));
  await fetch(ORIGIN + '/__feedback/api/comments/' + twc.id, { method: 'DELETE', headers: { Origin: ORIGIN } });

  // Edit-in-place: textEdit round-trips on POST (collapsed), PATCH null clears it
  const te = await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ page: '/', anchor: { snippet: 'Hi' }, textEdit: { before: 'coffee  beens', after: 'coffee beans' } }),
  });
  const tec = (await te.json()).comment;
  check('textEdit-only comment accepted + whitespace collapsed', te.status === 201
    && tec.textEdit && tec.textEdit.before === 'coffee beens' && tec.textEdit.after === 'coffee beans' && tec.text === '');
  const tep = await fetch(ORIGIN + '/__feedback/api/comments/' + tec.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ textEdit: null }),
  });
  check('PATCH textEdit:null clears it', tep.status === 200 && (await tep.json()).comment.textEdit === null);
  await fetch(ORIGIN + '/__feedback/api/comments/' + tec.id, { method: 'DELETE', headers: { Origin: ORIGIN } });

  // Variants: reply carries sanitized alternatives; pick round-trips
  const vOwner = (await (await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ page: '/', text: 'options?', type: 'improve', anchor: { snippet: 'Hi' } }),
  })).json()).comment;
  const vReply = await fetch(ORIGIN + '/__feedback/api/comments/' + vOwner.id + '/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ author: 'agent', text: '2 options', variants: [
      { label: 'Bold', html: '<h1 style="font-weight:800" onclick="pwn()">Hi</h1>', note: 'heavier' },
      { label: 'Soft', html: '<h1><script>x()</script>Hi</h1>' },
    ] }),
  });
  const vr = (await vReply.json()).comment.thread[0];
  check('variant reply stored + sanitized', vReply.status === 201 && vr.variants.length === 2
    && !vr.variants[0].html.includes('onclick') && !/script/i.test(vr.variants[1].html)
    && vr.variants[0].html.includes('font-weight:800'));
  const vPick = await fetch(ORIGIN + '/__feedback/api/comments/' + vOwner.id + '/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ author: 'user', text: 'Picked: Bold', pick: { of: vr.id, index: 0, label: 'Bold' } }),
  });
  const vp = (await vPick.json()).comment.thread[1];
  check('pick reply round-trips', vPick.status === 201 && vp.pick && vp.pick.of === vr.id && vp.pick.index === 0);
  await fetch(ORIGIN + '/__feedback/api/comments/' + vOwner.id, { method: 'DELETE', headers: { Origin: ORIGIN } });

  // Shots: PNG upload round-trips, junk is rejected, GC on comment delete
  const shotOwner = (await (await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ page: '/', text: 'shot me', anchor: { snippet: 'Hi' } }),
  })).json()).comment;
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const shotUp = await fetch(ORIGIN + '/__feedback/api/shot/' + shotOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + PNG_1PX }),
  });
  const shotC = (await shotUp.json()).comment;
  const shotGet = await fetch(ORIGIN + '/__feedback/api/shot/' + shotOwner.id);
  check('shot uploads + comment carries path + served as png', shotUp.status === 200
    && shotC.shot === 'shots/' + shotOwner.id + '.png'
    && shotGet.status === 200 && shotGet.headers.get('content-type') === 'image/png');
  const shotFile = path.join(root, '.feedback', 'shots', shotOwner.id + '.png');
  check('shot file exists on disk', existsSync(shotFile));
  const shotBad = await fetch(ORIGIN + '/__feedback/api/shot/' + shotOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }),
  });
  const shotEvil = await fetch(ORIGIN + '/__feedback/api/shot/..%2F..%2Fpwn', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + PNG_1PX }),
  });
  check('shot rejects fake PNG + traversal ids', shotBad.status === 400 && shotEvil.status === 400);
  await fetch(ORIGIN + '/__feedback/api/comments/' + shotOwner.id, { method: 'DELETE', headers: { Origin: ORIGIN } });
  check('deleting the comment GCs its shot', !existsSync(shotFile));

  // Image replace: media upload (jpeg) round-trips, format/id validated, GC on delete
  const irOwner = (await (await fetch(ORIGIN + '/__feedback/api/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ page: '/', text: 'new pic', anchor: { snippet: 'Hi' }, imageReplace: { target: 'img', fit: 'cover', w: 2, h: 2 } }),
  })).json()).comment;
  check('imageReplace metadata stored web-only', irOwner.imageReplace && irOwner.imageReplace.target === 'img' && irOwner.imageReplace.media === undefined);
  // PNG_1PX (declared above for the shot test) is a real 1×1 PNG ending in IEND.
  const irUp = await fetch(ORIGIN + '/__feedback/api/media/' + irOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + PNG_1PX }),
  });
  const irC = (await irUp.json()).comment;
  const irGet = await fetch(ORIGIN + '/__feedback/api/media/' + irOwner.id);
  check('media uploads (png) + comment carries path + served as png + nosniff', irUp.status === 200
    && irC.imageReplace.media === 'media/' + irOwner.id + '.png'
    && irGet.status === 200 && irGet.headers.get('content-type') === 'image/png'
    && irGet.headers.get('x-content-type-options') === 'nosniff');
  const irFile = path.join(root, '.feedback', 'media', irOwner.id + '.png');
  check('media file exists on disk', existsSync(irFile));
  const irSvg = await fetch(ORIGIN + '/__feedback/api/media/' + irOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="x()"/>').toString('base64') }),
  });
  const irFakePng = await fetch(ORIGIN + '/__feedback/api/media/' + irOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }),
  });
  const irEvilId = await fetch(ORIGIN + '/__feedback/api/media/..%2F..%2Fpwn', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + PNG_1PX }),
  });
  // valid PNG magic header but with attacker bytes appended past IEND → rejected (trailer check)
  const realPng = Buffer.from(PNG_1PX, 'base64');
  const pngPlusScript = Buffer.concat([realPng, Buffer.from('<script>alert(1)</script>')]);
  const irTail = await fetch(ORIGIN + '/__feedback/api/media/' + irOwner.id, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + pngPlusScript.toString('base64') }),
  });
  check('media rejects SVG + fake-magic + traversal ids + appended-payload PNG',
    irSvg.status === 400 && irFakePng.status === 400 && irEvilId.status === 400 && irTail.status === 400);
  await fetch(ORIGIN + '/__feedback/api/comments/' + irOwner.id, { method: 'DELETE', headers: { Origin: ORIGIN } });
  check('deleting the comment GCs its media', !existsSync(irFile));

  // The agent's own polling is its heartbeat: with no explicit state posted yet,
  // the calls this test has been making (node, not a browser) have already
  // promoted the chip from offline to online. Checked here, before anything
  // posts a state, because a later explicit goodbye starts a quiet minute in
  // which no implicit request may revive it (see the ghost check further down).
  await fetch(ORIGIN + '/__feedback/api/comments');
  check('the agent\'s own poll marks it present (offline → online at startup)',
    (await (await fetch(ORIGIN + '/__feedback/api/agent-status')).json()).agent.state === 'online');

  // Watch mode: agent presence round-trips and rejects junk states
  const as1 = await fetch(ORIGIN + '/__feedback/api/agent-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ state: 'working', name: 'copy reviewer' }),
  });
  const as1b = (await as1.json()).agent;
  const as2 = (await (await fetch(ORIGIN + '/__feedback/api/agent-status')).json()).agent;
  check('agent-status round-trips', as1.status === 200 && as1b.state === 'working' && as2.state === 'working' && as2.name === 'copy reviewer');
  const as3 = await fetch(ORIGIN + '/__feedback/api/agent-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ state: 'hacked' }),
  });
  check('agent-status coerces junk state to offline', (await as3.json()).agent.state === 'offline');

  // Presence + activity: what the browser mirrors while the agent works.
  const J = { 'Content-Type': 'application/json', Origin: ORIGIN };
  const postJ = (p, body, extra) => fetch(ORIGIN + '/__feedback/api/' + p, { method: 'POST', headers: { ...J, ...(extra || {}) }, body: JSON.stringify(body) });
  const getAgent = async () => (await (await fetch(ORIGIN + '/__feedback/api/agent-status')).json());
  // session.json lets hooks + the skill find this server without guessing the port
  let sess = null;
  try { sess = JSON.parse(readFileSync(path.join(root, '.feedback', 'session.json'), 'utf8')); } catch (e) {}
  check('writes session.json with pid + apiBase', !!sess && sess.pid === srv.pid && sess.apiBase === `http://127.0.0.1:${PORT}/__feedback/api`);
  // claim a comment: state working + since set; activity gets a "claim" line
  const claimTarget = (await (await postJ('comments', { page: '/', text: 'claim me', anchor: { selector: '#c', snippet: 'C' } })).json()).comment;
  const claimed = (await (await postJ('agent-status', { state: 'working', commentId: claimTarget.id, name: 'Claude', note: 'locating' })).json()).agent;
  check('claim sets working + commentId + since', claimed.state === 'working' && claimed.commentId === claimTarget.id && claimed.since > 0 && claimed.note === 'locating');
  const sinceBefore = claimed.since;
  const reclaimed = (await (await postJ('agent-status', { state: 'working', commentId: claimTarget.id, note: 'editing' })).json()).agent;
  check('re-claim of the same comment keeps since, updates note', reclaimed.since === sinceBefore && reclaimed.note === 'editing');
  // an untagged activity line (what a hook posts) attaches to the claimed comment
  const act = await (await postJ('activity', { kind: 'edit', file: 'src/Header.jsx' })).json();
  check('activity attaches to the comment being worked on', act.entry && act.entry.kind === 'edit' && act.entry.commentId === claimTarget.id);
  const log1 = (await getAgent()).activity;
  check('agent-status GET carries the activity log', Array.isArray(log1) && log1.some((e) => e.kind === 'claim') && log1.some((e) => e.kind === 'edit' && e.file === 'src/Header.jsx'));
  // late joiners on the SSE stream get presence + the activity log up front
  const sseRes = await fetch(ORIGIN + '/__feedback/events');
  const sseReader = sseRes.body.getReader();
  let sseText = '';
  for (let i = 0; i < 4 && !sseText.includes('event: activity-log'); i++) { const { value, done } = await sseReader.read(); if (done) break; sseText += Buffer.from(value).toString(); }
  check('SSE late joiner receives agent-status + activity-log', sseText.includes('event: agent-status') && sseText.includes('event: activity-log') && sseText.includes('src/Header.jsx'));
  sseReader.cancel().catch(() => {});
  // resolving the claimed comment (as the agent) releases presence by itself
  await fetch(ORIGIN + '/__feedback/api/comments/' + claimTarget.id, { method: 'PATCH', headers: J, body: JSON.stringify({ status: 'resolved' }) });
  const released = await getAgent();
  check('resolving the claimed comment auto-releases to online', released.agent.state === 'online' && released.agent.commentId === '' && released.activity.some((e) => e.kind === 'done' && e.commentId === claimTarget.id && e.took >= 0));
  // a normal answer on a claimed comment releases too; a "Queued" reply does not
  await postJ('agent-status', { state: 'working', commentId: claimTarget.id });
  await postJ('comments/' + claimTarget.id + '/reply', { author: 'agent', text: 'Queued — I will show you this first.' });
  const stillWorking = (await getAgent()).agent;
  await postJ('comments/' + claimTarget.id + '/reply', { author: 'agent', text: 'Done: bumped the size.' });
  const answered = (await getAgent()).agent;
  check('"Queued" reply keeps working; a real answer releases', stillWorking.state === 'working' && answered.state === 'online');
  // After an explicit goodbye nothing implicit brings the agent back for a
  // minute: not a reviewer's browser (which never counted), and no longer the
  // agent-looking poll either. Only a fresh {state:"online"} does, which is what
  // an agent that really is back sends. This is what keeps a ghost off the page.
  await postJ('agent-status', { state: 'offline' });
  await fetch(ORIGIN + '/__feedback/api/comments', { headers: { 'Sec-Fetch-Mode': 'cors', 'User-Agent': 'Mozilla/5.0 (test browser)' } });
  const afterBrowser = (await getAgent()).agent.state;
  await fetch(ORIGIN + '/__feedback/api/comments');
  const afterAgent = (await getAgent()).agent.state;
  check('after an explicit goodbye no implicit request revives presence', afterBrowser === 'offline' && afterAgent === 'offline');
  // presence.json (MCP-only agents) is merged by the data-dir watch
  writeFileSync(path.join(root, '.feedback', 'presence.json'), JSON.stringify({ state: 'working', name: 'Codex', commentId: claimTarget.id, note: 'via file', activity: { kind: 'note', text: 'via file' } }));
  let viaFile = null;
  for (let i = 0; i < 20; i++) { await sleep(150); viaFile = (await getAgent()).agent; if (viaFile.name === 'Codex') break; }
  check('presence.json is picked up live', viaFile && viaFile.name === 'Codex' && viaFile.state === 'working' && viaFile.commentId === claimTarget.id);
  // the plugin hook: finds the session file from the cwd and reports the edit
  const hook = path.join(__dirname, '..', 'hooks', 'report.mjs');
  const runHook = (arg, input, cwd) => new Promise((resolve) => {
    const h = spawn(process.execPath, [hook, arg], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    h.stdout.on('data', (d) => { out += d; });
    h.on('close', (code) => resolve({ code, out }));
    h.stdin.end(JSON.stringify(input));
  });
  const h1 = await runHook('edit', { cwd: root, tool_input: { file_path: path.join(site, 'index.html') } }, root);
  await sleep(200);
  const afterHook = await getAgent();
  check('hook reports the edit (relative path, exit 0, silent)', h1.code === 0 && h1.out === '' && afterHook.activity.some((e) => e.kind === 'edit' && e.file === 'site/index.html'));
  const h2 = await runHook('idle', { cwd: root }, root);
  const afterIdle = await getAgent();
  check('hook "idle" ends the working state', h2.code === 0 && afterIdle.agent.state === 'online' && afterIdle.agent.commentId === '');
  const noSess = mkdtempSync(path.join(tmpdir(), 'fbs-nosess-'));
  const h3 = await runHook('edit', { cwd: noSess, tool_input: { file_path: 'x.js' } }, noSess);
  check('hook without a session exits 0 silently', h3.code === 0 && h3.out === '');
  rmSync(noSess, { recursive: true, force: true });
  await postJ('agent-status', { state: 'offline' });

  // A hook can still fire once the session is over: the edit hook runs on the
  // way out, and /clear ends the turn. That used to flip the chip back to
  // "online" with nobody there. The line is still logged, but a hook is not a
  // sign of life — only an explicit online POST is, and that wins at once.
  await postJ('agent-status', { state: 'online', name: 'Claude' });
  const ghostWasOnline = (await getAgent()).agent.state;
  await postJ('agent-status', { state: 'offline' });
  const ghostWentOffline = (await getAgent()).agent.state;
  const ghostPost = await postJ('activity', { kind: 'edit', file: 'x.js', text: 'edited x.js', source: 'hook' });
  const ghostAfter = await getAgent();
  check('a hook firing after the agent left cannot put it back online',
    ghostWasOnline === 'online' && ghostWentOffline === 'offline' && ghostPost.status === 200
    && ghostAfter.agent.state === 'offline'
    && ghostAfter.activity.some((e) => e.text === 'edited x.js')); // the line is still logged
  await postJ('agent-status', { state: 'online' });
  check('an explicit online POST still wins straight away', (await getAgent()).agent.state === 'online');
  await postJ('agent-status', { state: 'offline' });

  // reload broadcast endpoint (agent refreshes open overlays after a batch)
  const reload = await fetch(ORIGIN + '/__feedback/api/reload', { method: 'POST', headers: { Origin: ORIGIN } });
  check('reload endpoint accepts POST', reload.status === 200 && (await reload.json()).ok === true);

  // The "after" screenshot: the same element once the change has landed, so the
  // two can be shown side by side. Same route with ?after=1, its own file.
  const twoShots = (await (await postJ('comments', { page: '/', text: 'before and after', anchor: { snippet: 'Hi' } })).json()).comment;
  const missingAfter = await fetch(ORIGIN + '/__feedback/api/shot/' + twoShots.id + '?after=1');
  await postJ('shot/' + twoShots.id, { dataUrl: 'data:image/png;base64,' + PNG_1PX });
  const afterUp = await postJ('shot/' + twoShots.id + '?after=1', { dataUrl: 'data:image/png;base64,' + PNG_1PX });
  const afterC = (await afterUp.json()).comment;
  const afterGet = await fetch(ORIGIN + '/__feedback/api/shot/' + twoShots.id + '?after=1');
  const beforeGet = await fetch(ORIGIN + '/__feedback/api/shot/' + twoShots.id);
  const beforeFile = path.join(root, '.feedback', 'shots', twoShots.id + '.png');
  const afterFile = path.join(root, '.feedback', 'shots', twoShots.id + '-after.png');
  check('an "after" shot is stored beside the pin-time one and served on its own',
    missingAfter.status === 404 && afterUp.status === 200
    && afterC.shotAfter === 'shots/' + twoShots.id + '-after.png' && afterC.shot === 'shots/' + twoShots.id + '.png'
    && afterGet.status === 200 && afterGet.headers.get('content-type') === 'image/png'
    && beforeGet.status === 200 && existsSync(beforeFile) && existsSync(afterFile));
  await fetch(ORIGIN + '/__feedback/api/comments/' + twoShots.id, { method: 'DELETE', headers: { Origin: ORIGIN } });
  check('deleting the comment moves both of its shots into trash/',
    !existsSync(beforeFile) && !existsSync(afterFile)
    && existsSync(path.join(root, '.feedback', 'trash', 'shots', twoShots.id + '.png'))
    && existsSync(path.join(root, '.feedback', 'trash', 'shots', twoShots.id + '-after.png')));

  // Undo a delete. DELETE moves a comment's pictures into trash/ instead of
  // destroying them, and PUT puts the whole comment back — same id, same
  // conversation, same timestamps, and the screenshot fetched back out of trash.
  const undo = (await (await postJ('comments', { page: '/', text: 'undo me', anchor: { selector: '#t', snippet: 'Hi' } })).json()).comment;
  await postJ('comments/' + undo.id + '/reply', { author: 'user', text: 'a second thought' });
  await postJ('shot/' + undo.id, { dataUrl: 'data:image/png;base64,' + PNG_1PX });
  await fetch(ORIGIN + '/__feedback/api/comments/' + undo.id, { method: 'PATCH', headers: J, body: JSON.stringify({ status: 'approved' }) });
  const snapshot = (await (await fetch(ORIGIN + '/__feedback/api/comments')).json()).comments.find((c) => c.id === undo.id);
  const undoShot = path.join(root, '.feedback', 'shots', undo.id + '.png');
  // Backdate the screenshot two days. Trash is pruned after a day, and a rename
  // keeps the original timestamp — so without a fresh stamp on the way in, the
  // delete would trash the picture and destroy it in the same breath, which is
  // precisely the long review session the undo exists for.
  const twoDaysAgo = Date.now() / 1000 - 48 * 3600;
  utimesSync(undoShot, twoDaysAgo, twoDaysAgo);
  await fetch(ORIGIN + '/__feedback/api/comments/' + undo.id, { method: 'DELETE', headers: { Origin: ORIGIN } });
  check('deleting a comment moves its screenshot into trash/ instead of destroying it',
    !existsSync(undoShot) && existsSync(path.join(root, '.feedback', 'trash', 'shots', undo.id + '.png')));
  const restored = await fetch(ORIGIN + '/__feedback/api/comments/' + undo.id, {
    method: 'PUT', headers: J,
    // Two forged file paths ride along: one naming a file that is not there,
    // one pointing outside the data dir entirely. Neither may be believed.
    body: JSON.stringify({ ...snapshot, shot: '../../secret.txt', shotAfter: 'shots/' + undo.id + '-after.png' }),
  });
  const back = (await restored.json()).comment;
  check('PUT restores the comment with its id, status, timestamps, thread and screenshot',
    restored.status === 200 && back.id === undo.id && back.createdAt === snapshot.createdAt
    && back.status === 'approved' && back.thread.length === 1
    && back.thread[0].text === 'a second thought' && back.thread[0].id === snapshot.thread[0].id
    && back.thread[0].createdAt === snapshot.thread[0].createdAt
    && back.shot === 'shots/' + undo.id + '.png' && existsSync(undoShot));
  check('PUT ignores a forged file path and drops one with no file behind it',
    back.shot !== '../../secret.txt' && back.shotAfter === undefined);
  const putList = (await (await fetch(ORIGIN + '/__feedback/api/comments')).json()).comments.filter((c) => c.id === undo.id);
  check('PUT replaces the comment in place rather than adding a second one', putList.length === 1);
  const putBadId = await fetch(ORIGIN + '/__feedback/api/comments/..%2F..%2Fpwn', { method: 'PUT', headers: J, body: JSON.stringify(snapshot) });
  check('PUT refuses an id that is not a comment id', putBadId.status === 400);
  await fetch(ORIGIN + '/__feedback/api/comments/' + undo.id, { method: 'DELETE', headers: { Origin: ORIGIN } });

  // Review rounds. A round is the unit of "what I asked this time": new comments
  // carry it, open pages hear about a new one over the stream, and it survives in
  // meta.json beside the comments.
  const round1 = await (await fetch(ORIGIN + '/__feedback/api/round')).json();
  check('GET round starts at 1 and says when it started',
    round1.round === 1 && typeof round1.startedAt === 'string' && !Number.isNaN(Date.parse(round1.startedAt)));
  const roundSse = await fetch(ORIGIN + '/__feedback/events');
  const roundReader = roundSse.body.getReader();
  const bumped = await (await postJ('round', {})).json();
  check('POST round moves to the next one', bumped.round === 2 && bumped.startedAt !== round1.startedAt);
  let roundText = '';
  for (let i = 0; i < 6 && !roundText.includes('event: round'); i++) {
    const { value, done } = await roundReader.read(); if (done) break; roundText += Buffer.from(value).toString();
  }
  check('an open page is told about the new round over the live stream',
    roundText.includes('event: round') && roundText.includes('"round":2'));
  roundReader.cancel().catch(() => {});
  const roundMeta = JSON.parse(readFileSync(path.join(root, '.feedback', 'meta.json'), 'utf8'));
  check('the round is written to meta.json so it survives a restart',
    roundMeta.round === 2 && roundMeta.roundStartedAt === bumped.startedAt && roundMeta.port === PORT);
  const roundLog = (await getAgent()).activity;
  check('starting a round is written to the activity log',
    roundLog.some((e) => e.kind === 'round' && e.text === 'round 2 started'));
  const inRound2 = (await (await postJ('comments', { page: '/', text: 'asked in round two', anchor: { snippet: 'Hi' } })).json()).comment;
  const listWithRound = await (await fetch(ORIGIN + '/__feedback/api/comments')).json();
  check('a new comment carries the current round, and the list reports it',
    inRound2.round === 2 && listWithRound.round === 2
    && listWithRound.comments.find((c) => c.id === inRound2.id).round === 2);
  const feedbackMd = readFileSync(path.join(root, '.feedback', 'FEEDBACK.md'), 'utf8');
  check('FEEDBACK.md separates the rounds once there is more than one',
    feedbackMd.includes('## Round 2') && feedbackMd.includes('## Round 1')
    && feedbackMd.indexOf('## Round 2') < feedbackMd.indexOf('## Round 1'));
  await fetch(ORIGIN + '/__feedback/api/comments/' + inRound2.id, { method: 'DELETE', headers: { Origin: ORIGIN } });

  // Element screenshots load a vendored copy of html-to-image through this
  // route. Its ES build imports its own parts with no file extension, which a
  // bundler fills in and a browser does not — so the browser asks for the bare
  // name. Answering 404 there meant no screenshots at all, and no before/after
  // pair either.
  const htiHome = process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), '.feedback-studio');
  const htiPkg = path.join(htiHome, 'deps', 'node_modules', 'html-to-image', 'package.json');
  if (existsSync(htiPkg)) {
    const entry = await fetch(ORIGIN + '/__feedback/vendor/html-to-image/es/index.js');
    const bare = await fetch(ORIGIN + '/__feedback/vendor/html-to-image/es/clone-node');
    const bareBody = await bare.text();
    const asJson = await fetch(ORIGIN + '/__feedback/vendor/html-to-image/package.json');
    const asDir = await fetch(ORIGIN + '/__feedback/vendor/html-to-image/es');
    const escape = await fetch(ORIGIN + '/__feedback/vendor/html-to-image/..%2F..%2Fpackage');
    check('the vendor route serves a part imported without a file extension',
      entry.status === 200 && bare.status === 200
      && /javascript/.test(bare.headers.get('content-type') || '')
      && bareBody.includes('cloneNode'));
    check('adding the extension does not open the route to anything else',
      asJson.status === 404 && asDir.status === 404 && escape.status === 404);
  } else if (process.env.CI) {
    check('the screenshot library is installed for the vendor-route checks in CI', false);
  } else {
    console.log('SKIP  vendor route: html-to-image is not installed (offline run)');
  }

  // A served site has no source file behind it, so there is no history to keep:
  // the list is empty and taking a version is refused rather than half-done.
  const webHist = await (await fetch(ORIGIN + '/__feedback/api/history?file=site/index.html')).json();
  const webSnap = await postJ('history/snapshot', { file: 'site/index.html', reason: 'manual' });
  check('a served site keeps no source history', webHist.versions.length === 0 && webSnap.status === 404);

  // the agent processing guide is written next to the data on startup
  check('writes HOW-TO-PROCESS.md', existsSync(path.join(root, '.feedback', 'HOW-TO-PROCESS.md')));

  // --demo: serves the bundled sample site from a temp copy, seeded with one
  // comment per web type — and must not create .feedback/ in the cwd it ran from.
  // --demo --no-seed: same page, but zero comments (add-your-own / recording demos).
  const DEMO_PORT = PORT + 1;
  const demoCwd = path.join(root, 'democwd');
  mkdirSync(demoCwd);
  const demoSrv = spawn(process.execPath, [bin, '--demo', '--port', String(DEMO_PORT), '--no-open'], { stdio: 'ignore', cwd: demoCwd });
  const EMPTY_PORT = PORT + 2;
  const emptyCwd = path.join(root, 'emptycwd');
  mkdirSync(emptyCwd);
  const emptySrv = spawn(process.execPath, [bin, '--demo', '--no-seed', '--port', String(EMPTY_PORT), '--no-open'], { stdio: 'ignore', cwd: emptyCwd });
  try {
    await ready(DEMO_PORT, EMPTY_PORT);
    const demoHome = await fetch(`http://127.0.0.1:${DEMO_PORT}/`);
    const demoBody = await demoHome.text();
    check('demo serves sample page', demoHome.status === 200 && demoBody.includes('Roastly'));
    const seeded = await (await fetch(`http://127.0.0.1:${DEMO_PORT}/__feedback/api/comments`)).json();
    const types = seeded.comments.map((c) => c.type).sort().join(',');
    check('demo seeds fix+change+improve', seeded.comments.length === 3 && types === 'change,fix,improve');
    check('demo keeps cwd clean', !existsSync(path.join(demoCwd, '.feedback')));
    const emptyHome = await fetch(`http://127.0.0.1:${EMPTY_PORT}/`);
    check('demo --no-seed serves sample page', emptyHome.status === 200 && (await emptyHome.text()).includes('Roastly'));
    const empty = await (await fetch(`http://127.0.0.1:${EMPTY_PORT}/__feedback/api/comments`)).json();
    check('demo --no-seed starts with zero comments', Array.isArray(empty.comments) && empty.comments.length === 0);
  } finally {
    demoSrv.kill();
    emptySrv.kill();
  }

  // --data-dir + --label: multi-site isolation. Data lands in the custom dir (not
  // cwd/.feedback), meta.json names the site, and the overlay carries the label.
  // NOTE: PORT+3 is used by the --no-shots check below; use +6 to avoid a bind
  // collision when this server's port hasn't been released yet on a slow runner.
  const MS_PORT = PORT + 6;
  const msCwd = path.join(root, 'mscwd');
  mkdirSync(msCwd);
  const msData = path.join(msCwd, 'sites', 'marketing', '.feedback');
  const msSrv = spawn(process.execPath, [bin, '--dir', site, '--data-dir', msData, '--label', 'Marketing', '--port', String(MS_PORT), '--no-open'], { stdio: 'ignore', cwd: msCwd });
  try {
    await ready(MS_PORT);
    const MS = `http://127.0.0.1:${MS_PORT}`;
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(msData, 'meta.json'), 'utf-8')); } catch (e) {}
    check('--label writes meta.json naming the site', meta.label === 'Marketing');
    const ov = await (await fetch(`${MS}/__feedback/overlay.js`)).text();
    check('--label injects window.__kbfLabel into the overlay', ov.includes('window.__kbfLabel="Marketing"'));
    await fetch(`${MS}/__feedback/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: MS }, body: JSON.stringify({ page: '/', anchor: { snippet: 'x' }, text: 'ms', type: 'change' }) });
    check('--data-dir isolates comments to the custom dir (not cwd/.feedback)',
      existsSync(path.join(msData, 'comments.json')) && !existsSync(path.join(msCwd, '.feedback')));
  } finally {
    msSrv.kill();
  }

  // Serving a source that lives OUTSIDE the cwd without --data-dir keeps the
  // data in the cwd — the banner must say so (the silent version of this cost a
  // real debugging session: agent processed an empty file, comments sat elsewhere).
  const FW_PORT = PORT + 9;
  const fwSrv = spawn(process.execPath, [bin, '--dir', site, '--port', String(FW_PORT), '--no-open'],
    { stdio: ['ignore', 'pipe', 'ignore'], cwd: msCwd });
  try {
    const fwOut = await new Promise((resolve) => {
      let out = '';
      const t = setTimeout(() => resolve(out), 6000);
      fwSrv.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('--data-dir')) { clearTimeout(t); resolve(out); }
      });
    });
    check('warns when the served source is outside the cwd and no --data-dir is given',
      fwOut.includes('outside this folder') && fwOut.includes('--data-dir'));
  } finally {
    fwSrv.kill();
  }

  // --share strict: role enforcement end-to-end. Strict mode disables the
  // localhost bypass, so these loopback requests exercise the real matrix.
  // Keys are parsed from the banner the server prints — the honest interface.
  const SH_PORT = PORT + 4;
  const shSrv = spawn(process.execPath, [bin, '--dir', site, '--share', 'strict', '--port', String(SH_PORT), '--no-open'],
    { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
  try {
    const keys = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('share banner not printed')), 8000);
      shSrv.stdout.on('data', (d) => {
        out += d.toString();
        const m = /\?key=(sv_[\w-]+)[\s\S]*?\?key=(sc_[\w-]+)[\s\S]*?\?key=(sa_[\w-]+)/.exec(out);
        if (m) { clearTimeout(t); resolve({ view: m[1], comment: m[2], admin: m[3] }); }
      });
    });
    const SH = `http://127.0.0.1:${SH_PORT}`;
    const J = { 'Content-Type': 'application/json', Origin: SH };
    const noKey = await fetch(SH + '/__feedback/api/comments');
    const badKey = await fetch(SH + '/__feedback/api/comments?key=sv_wrong');
    check('share: no/invalid key => 401 on reads', noKey.status === 401 && badKey.status === 401);
    const viewRead = await fetch(SH + `/__feedback/api/comments?key=${keys.view}`);
    const viewWrite = await fetch(SH + `/__feedback/api/comments?key=${keys.view}`, {
      method: 'POST', headers: J, body: JSON.stringify({ page: '/', text: 'nope', anchor: { snippet: 'Hi' } }),
    });
    check('share: view reads but cannot write', viewRead.status === 200 && viewWrite.status === 403);
    const cWrite = await fetch(SH + `/__feedback/api/comments?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ page: '/', text: 'from client', authorName: 'Pat', anchor: { snippet: 'Hi' } }),
    });
    const cc = (await cWrite.json()).comment;
    const cReply = await fetch(SH + `/__feedback/api/comments/${cc.id}/reply?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ author: 'user', text: 'ping', authorName: 'Pat' }),
    });
    const cPatch = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.comment}`, {
      method: 'PATCH', headers: J, body: JSON.stringify({ status: 'resolved' }),
    });
    const cDelete = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.comment}`, { method: 'DELETE', headers: J });
    check('share: comment adds comments+replies (named) but no status/delete',
      cWrite.status === 201 && cc.authorName === 'Pat' && cReply.status === 201 && cPatch.status === 403 && cDelete.status === 403);
    const cVar = await fetch(SH + `/__feedback/api/comments/${cc.id}/reply?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ author: 'user', text: 'try this', variants: [{ label: 'X', html: '<p>x</p>' }] }),
    });
    check('share: comment role cannot inject variants (host/agent privilege)', cVar.status === 403);
    const vRound = await fetch(SH + `/__feedback/api/round?key=${keys.view}`);
    const cRoundPost = await fetch(SH + `/__feedback/api/round?key=${keys.comment}`, { method: 'POST', headers: J });
    check('share: anyone on the link may read the round, only admin may start a new one',
      vRound.status === 200 && (await vRound.json()).round >= 1 && cRoundPost.status === 403);
    // This server shares the data dir with the one above, which moved the review
    // to round 2 — so a second process reading meta.json is the proof that a
    // round survives a restart instead of dropping back to 1.
    const restartRound = await (await fetch(SH + `/__feedback/api/round?key=${keys.admin}`)).json();
    check('share: a second server picks the review up in the round it was left in', restartRound.round === 2);
    const cReload = await fetch(SH + `/__feedback/api/reload?key=${keys.comment}`, { method: 'POST', headers: J });
    const aReload = await fetch(SH + `/__feedback/api/reload?key=${keys.admin}`, { method: 'POST', headers: J });
    check('share: reload is admin-only', cReload.status === 403 && aReload.status === 200);
    // md-export writes markers into the project's own source files — the one
    // route that touches the repo, so a reviewer's link must never reach it.
    const mdExpView = await fetch(SH + `/__feedback/api/md-export?key=${keys.view}`, { method: 'POST', headers: J });
    const mdExpComment = await fetch(SH + `/__feedback/api/md-export?key=${keys.comment}`, { method: 'POST', headers: J });
    check('share: md-export is admin-only (no share link may write into source files)',
      mdExpView.status === 403 && mdExpComment.status === 403);
    const aPatch = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.admin}`, {
      method: 'PATCH', headers: J, body: JSON.stringify({ status: 'resolved' }),
    });
    const aDelete = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.admin}`, { method: 'DELETE', headers: J });
    check('share: admin manages statuses + deletes', aPatch.status === 200 && aDelete.status === 200);
    const asDeny = await fetch(SH + `/__feedback/api/agent-status?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ state: 'online' }),
    });
    check('share: comment role cannot impersonate the agent', asDeny.status === 403);
    // The activity log goes to everyone on the link, but the edited paths are a
    // map of a private source tree — only the host side sees those. A shared
    // reviewer gets the same line without the `file` field.
    const actPost = await fetch(SH + `/__feedback/api/activity?key=${keys.admin}`, {
      method: 'POST', headers: J, body: JSON.stringify({ kind: 'edit', file: 'src/secret/Header.jsx', text: 'edited the header' }),
    });
    const findEntry = (list) => (list || []).find((e) => e.text === 'edited the header');
    const viewSeen = findEntry((await (await fetch(SH + `/__feedback/api/agent-status?key=${keys.view}`)).json()).activity);
    const adminSeen = findEntry((await (await fetch(SH + `/__feedback/api/agent-status?key=${keys.admin}`)).json()).activity);
    const viewLog = findEntry((await (await fetch(SH + `/__feedback/api/activity?key=${keys.view}`)).json()).activity);
    check('share: activity keeps the edited file path from anyone below admin',
      actPost.status === 200 && viewSeen && !('file' in viewSeen) && viewLog && !('file' in viewLog)
      && adminSeen && adminSeen.file === 'src/secret/Header.jsx');
    // The same on the live stream, not only on a fresh read: the log a view
    // client is handed when it joins, and every line pushed to it afterwards.
    const vSse = await fetch(SH + `/__feedback/events?key=${keys.view}`);
    const vReader = vSse.body.getReader();
    let vText = '';
    for (let i = 0; i < 4 && !vText.includes('event: activity-log'); i++) {
      const { value, done } = await vReader.read(); if (done) break; vText += Buffer.from(value).toString();
    }
    const joinedClean = vText.includes('edited the header') && !vText.includes('src/secret/');
    await fetch(SH + `/__feedback/api/activity?key=${keys.admin}`, {
      method: 'POST', headers: J, body: JSON.stringify({ kind: 'edit', file: 'src/secret/Other.jsx', text: 'edited another file' }),
    });
    for (let i = 0; i < 4 && !vText.includes('edited another file'); i++) {
      const { value, done } = await vReader.read(); if (done) break; vText += Buffer.from(value).toString();
    }
    check('share: the live activity stream hides the file path too',
      joinedClean && vText.includes('edited another file') && !vText.includes('src/secret/'));
    vReader.cancel().catch(() => {});
    // Author spoofing (ultrareview bug_001): a comment-role reviewer claiming
    // author:"agent" in the body must be downgraded to "user" (the agent voice
    // renders with visual authority and exports "by agent"); full/admin — the
    // host side, where the real agent posts over HTTP — keeps it.
    const spoofC = await (await fetch(SH + `/__feedback/api/comments?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ page: '/', text: 'spoofed', author: 'agent', authorName: 'Claude', anchor: { snippet: 'Hi' } }),
    })).json();
    const spoofR = await (await fetch(SH + `/__feedback/api/comments/${spoofC.comment.id}/reply?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ author: 'agent', authorName: 'Claude', text: 'approved' }),
    })).json();
    const realA = await (await fetch(SH + `/__feedback/api/comments/${spoofC.comment.id}/reply?key=${keys.admin}`, {
      method: 'POST', headers: J, body: JSON.stringify({ author: 'agent', authorName: 'agent', text: 'actual agent reply' }),
    })).json();
    check('share: comment role cannot spoof author:"agent" on comments or replies (admin can)',
      spoofC.comment.author === 'user' && spoofR.reply.author === 'user' && realA.reply.author === 'agent');
    // Own-comment edit and delete. A browser on a share link invents its own
    // random author token and sends it with every write; only that browser may
    // fix or take back the comment it left, and only while it is still open.
    const TOK_A = 'author-token-alpha-' + 'a'.repeat(21);
    const TOK_B = 'author-token-bravo-' + 'b'.repeat(21);
    const withTok = (tok) => ({ ...J, 'X-Feedback-Author': tok });
    const postAs = (tok, text) => fetch(SH + `/__feedback/api/comments?key=${keys.comment}`, {
      method: 'POST', headers: withTok(tok), body: JSON.stringify({ page: '/', text, anchor: { snippet: 'Hi' } }),
    });
    const mine = (await (await postAs(TOK_A, 'my typo')).json()).comment;
    const mineEdit = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, {
      method: 'PATCH', headers: withTok(TOK_A),
      // status and autonomy are in the body on purpose: they are not the
      // author's to set, and must be ignored rather than refused.
      body: JSON.stringify({ text: 'my typo, fixed', type: 'improve', status: 'resolved', autonomy: 'auto' }),
    });
    const mineEdited = (await mineEdit.json()).comment;
    check('share: a commenter may fix the wording and type of their own open comment, nothing else',
      mineEdit.status === 200 && mineEdited.text === 'my typo, fixed' && mineEdited.type === 'improve'
      && mineEdited.status === 'open' && mineEdited.autonomy === 'review');
    const otherEdit = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, {
      method: 'PATCH', headers: withTok(TOK_B), body: JSON.stringify({ text: 'not mine' }),
    });
    const otherDelete = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, { method: 'DELETE', headers: withTok(TOK_B) });
    const noTokEdit = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, {
      method: 'PATCH', headers: J, body: JSON.stringify({ text: 'no token at all' }),
    });
    const viewEdit = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.view}`, {
      method: 'PATCH', headers: withTok(TOK_A), body: JSON.stringify({ text: 'from a view link' }),
    });
    check('share: another browser, a missing token and a view link are all refused',
      otherEdit.status === 403 && otherDelete.status === 403 && noTokEdit.status === 403 && viewEdit.status === 403);
    // The author hash lives in the file, so the comment can still be recognised
    // as theirs after a restart — but it never travels back out.
    const onDisk = JSON.parse(readFileSync(path.join(root, '.feedback', 'comments.json'), 'utf8')).comments.find((c) => c.id === mine.id);
    const listedRaw = await (await fetch(SH + `/__feedback/api/comments?key=${keys.view}`)).text();
    check('share: the author hash is written to disk and never sent out',
      !!onDisk && /^[0-9a-f]{64}$/.test(onDisk.authorHash || '')
      && !('authorHash' in mine) && !('authorHash' in mineEdited) && !listedRaw.includes('authorHash'));
    // Once the host side has acted on it, the comment is part of the record.
    await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.admin}`, {
      method: 'PATCH', headers: J, body: JSON.stringify({ status: 'resolved' }),
    });
    const lateEdit = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, {
      method: 'PATCH', headers: withTok(TOK_A), body: JSON.stringify({ text: 'too late' }),
    });
    const lateDelete = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, { method: 'DELETE', headers: withTok(TOK_A) });
    check('share: a resolved comment can no longer be changed by its author',
      lateEdit.status === 403 && lateDelete.status === 403);
    const putDeny = await fetch(SH + `/__feedback/api/comments/${mine.id}?key=${keys.comment}`, {
      method: 'PUT', headers: withTok(TOK_A), body: JSON.stringify(mine),
    });
    check('share: restoring a deleted comment is admin-only', putDeny.status === 403);
    const histDeny = await fetch(SH + `/__feedback/api/history/snapshot?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ file: 'index.html', reason: 'manual' }),
    });
    const restoreDeny = await fetch(SH + `/__feedback/api/history/restore?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ file: 'index.html', n: 1 }),
    });
    const histProbe = await fetch(SH + `/__feedback/api/history/snapshot?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ file: '../../etc/passwd', reason: 'manual' }),
    });
    check('share: taking or restoring a version of a source file is admin-only',
      histDeny.status === 403 && restoreDeny.status === 403
      // Refused on the role alone: a different answer for a path outside the
      // project would tell a reviewer which files are inside it.
      && histProbe.status === 403);
    const mine2 = (await (await postAs(TOK_A, 'never mind this one')).json()).comment;
    const mineDelete = await fetch(SH + `/__feedback/api/comments/${mine2.id}?key=${keys.comment}`, { method: 'DELETE', headers: withTok(TOK_A) });
    const afterDelete = await (await fetch(SH + `/__feedback/api/comments?key=${keys.view}`)).json();
    check('share: a commenter can take back their own open comment',
      mineDelete.status === 200 && !afterDelete.comments.some((c) => c.id === mine2.id));

    const page = await fetch(SH + `/?key=${keys.view}`, { redirect: 'manual' });
    const cookie = page.headers.get('set-cookie') || '';
    check('share: page key exchanges into an HttpOnly cookie + clean redirect',
      page.status === 302 && cookie.includes('kbf-key=') && cookie.includes('HttpOnly') && !(page.headers.get('location') || '').includes('key='));
    // cookie scoped to /__feedback so it never rides ordinary page/asset (or proxied) requests
    check('share: key cookie scoped to Path=/__feedback', /path=\/__feedback/i.test(cookie));
    const ovl = await (await fetch(SH + '/__feedback/overlay.js', { headers: { Cookie: `kbf-key=${keys.view}` } })).text();
    check('share: overlay is served role-aware', ovl.startsWith('window.__kbfRole="view";'));
    // a malformed key cookie must not 500 — it's treated as absent (→ 401 under strict)
    const badCookie = await fetch(SH + '/__feedback/api/comments', { headers: { Cookie: 'kbf-key=%ZZ' } });
    check('share: malformed key cookie → 401, not 500', badCookie.status === 401);
  } finally {
    shSrv.kill();
  }

  // --proxy --share: the share key must NEVER be forwarded to the upstream app.
  // Stand up a mock upstream that echoes the Cookie header it received.
  const http = await import('node:http');
  let upstreamCookie = 'UNSET';
  const upstream = http.createServer((ureq, ures) => {
    // A redirect the dev server points at its own full address. Answered first
    // and without touching upstreamCookie, so the cookie check below still reads
    // what the page request sent.
    if (ureq.url === '/redirect') {
      ures.writeHead(302, { Location: `http://${ureq.headers.host}/landed` });
      return ures.end();
    }
    upstreamCookie = ureq.headers.cookie || '';
    ures.writeHead(200, {
      'Content-Type': 'text/html',
      // Hardened-upstream headers the proxy must strip: CSP blocks the injected
      // overlay; Permissions-Policy microphone=() silently forbids voice input
      // (the browser never even shows a mic permission prompt).
      'Content-Security-Policy': "default-src 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    ures.end('<html><body>up</body></html>');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const PX_PORT = PORT + 5;
  const pxSrv = spawn(process.execPath, [bin, '--proxy', `http://127.0.0.1:${upPort}`, '--share', 'strict', '--port', String(PX_PORT), '--no-open'],
    { stdio: ['ignore', 'pipe', 'ignore'], cwd: root });
  try {
    const pkeys = await new Promise((resolve, reject) => {
      let out = ''; const t = setTimeout(() => reject(new Error('proxy share banner not printed')), 8000);
      pxSrv.stdout.on('data', (d) => { out += d.toString(); const m = /\?key=(sa_[\w-]+)/.exec(out); if (m) { clearTimeout(t); resolve({ admin: m[1] }); } });
    });
    // request a page route carrying the admin key cookie; the upstream must not see kbf-key
    const pxRes = await fetch(`http://127.0.0.1:${PX_PORT}/`, { headers: { Cookie: `kbf-key=${pkeys.admin}; other=keepme` } });
    check('proxy: share key stripped from forwarded Cookie', !/kbf-key/.test(upstreamCookie) && /keepme/.test(upstreamCookie));
    // regression (2026-07-18): upstream CSP / Permissions-Policy must not reach
    // the browser on injected HTML — microphone=() would kill voice comments
    // with no permission prompt at all.
    check('proxy: upstream CSP + Permissions-Policy stripped from injected HTML',
      pxRes.headers.get('content-security-policy') === null && pxRes.headers.get('permissions-policy') === null);
    // A redirect carrying the dev server's own address would send the browser
    // off the review server and lose the overlay; it has to point back at us.
    const pxRedirect = await fetch(`http://127.0.0.1:${PX_PORT}/redirect`, { redirect: 'manual' });
    check('proxy: a redirect to the dev server\'s own address becomes a plain path',
      pxRedirect.status === 302 && pxRedirect.headers.get('location') === '/landed');
  } finally {
    pxSrv.kill(); upstream.close();
  }

  // --no-shots: shot uploads refused, and the served overlay carries the flag
  // so the browser never probes the vendor route.
  const NS_PORT = PORT + 3;
  const nsSrv = spawn(process.execPath, [bin, '--dir', site, '--no-shots', '--port', String(NS_PORT), '--no-open'], { stdio: 'ignore', cwd: root });
  try {
    await ready(NS_PORT);
    const NS = `http://127.0.0.1:${NS_PORT}`;
    const nsc = (await (await fetch(NS + '/__feedback/api/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: NS },
      body: JSON.stringify({ page: '/', text: 'no shots', anchor: { snippet: 'Hi' } }),
    })).json()).comment;
    const nsUp = await fetch(NS + '/__feedback/api/shot/' + nsc.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: NS },
      body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + PNG_1PX }),
    });
    const nsOverlay = await (await fetch(NS + '/__feedback/overlay.js')).text();
    const nsVendor = await fetch(NS + '/__feedback/vendor/html-to-image/es/index.js');
    check('--no-shots refuses uploads + flags the overlay + closes the vendor route',
      nsUp.status === 404 && nsOverlay.startsWith('window.__kbfShots=false;') && nsVendor.status === 404);
  } finally {
    nsSrv.kill();
  }

  // --spa: a built single-page app draws /some/route itself, so an unknown path
  // with no file extension gets index.html. Without the flag it stays a 404.
  const plainDeep = await fetch(ORIGIN + '/some/route');
  check('without --spa an unknown route is still a 404', plainDeep.status === 404);
  const SPA_PORT = PORT + 10;
  const spaSrv = spawn(process.execPath, [bin, '--dir', site, '--spa', '--port', String(SPA_PORT), '--no-open'], { stdio: 'ignore', cwd: root });
  try {
    await ready(SPA_PORT);
    const SPA = `http://127.0.0.1:${SPA_PORT}`;
    const spaDeep = await fetch(SPA + '/some/route');
    const spaBody = await spaDeep.text();
    check('--spa serves index.html (with the overlay) for an unknown route',
      spaDeep.status === 200 && spaBody.includes('<h1 id="t">Hi</h1>') && spaBody.includes('/__feedback/overlay.js'));
    const spaAsset = await fetch(SPA + '/missing.js');
    check('--spa still 404s a missing file that has an extension', spaAsset.status === 404);
    const spaReal = await fetch(SPA + '/');
    check('--spa leaves a path that does resolve alone', spaReal.status === 200 && (await spaReal.text()).includes('<h1 id="t">Hi</h1>'));
  } finally {
    spaSrv.kill();
  }

  // --md cross-file scoping (regression for the 2026-07-14 "cross-file bleed").
  // In single-file --md mode EVERY file serves at '/', so the overlay can't tell
  // one file's comments from another's by `page` — it scopes by the served
  // sourceFile (carried on each page as window.__kbfSource, and on each comment
  // as sourceFile). This proves the data contract that client-side scope relies
  // on: two files sharing ONE .feedback dir keep an identical `page` ('/') but a
  // DISTINCT sourceFile, and the shared API returns both (the API is deliberately
  // unfiltered — the agent needs every file's comments; the overlay does the
  // scoping). If page stopped colliding or sourceFile stopped distinguishing, the
  // overlay could not separate them and the bleed would be back.
  const mdCwd = path.join(root, 'mdcwd');
  mkdirSync(path.join(mdCwd, 'docs'), { recursive: true });
  writeFileSync(path.join(mdCwd, 'docs', 'a.md'), '# Alpha\n\nFirst doc paragraph.\n\nSee [the site](https://example.com/x), [chapter](#alpha), [doc B](b.md).\n');
  // b.md also carries two active-content payloads the renderer must neutralise:
  // an UNQUOTED javascript: href (the quoted checks never saw it), and an
  // <animate> that would point a link at that scheme after the sanitizer ran.
  writeFileSync(path.join(mdCwd, 'docs', 'b.md'),
    '# Bravo\n\nSecond doc paragraph.\n\n<a href=javascript:alert(1)>x</a>\n\n<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>c</text></a></svg>\n');
  const MDA_PORT = PORT + 7;
  const MDB_PORT = PORT + 8;
  // b.md runs with --md-html on purpose: those two payloads only reach the page
  // when HTML in the file is rendered, which is exactly the path the sanitizer
  // guards. The default (HTML shown as text) is checked further down with c.md.
  const mdaSrv = spawn(process.execPath, [bin, '--md', 'docs/a.md', '--port', String(MDA_PORT), '--no-open'], { stdio: 'ignore', cwd: mdCwd });
  const mdbSrv = spawn(process.execPath, [bin, '--md', 'docs/b.md', '--port', String(MDB_PORT), '--no-open', '--md-html'], { stdio: 'ignore', cwd: mdCwd });
  try {
    await ready(MDA_PORT, MDB_PORT);
    const MDA = `http://127.0.0.1:${MDA_PORT}`;
    const MDB = `http://127.0.0.1:${MDB_PORT}`;
    // Pin one comment from each session; both land in the SAME shared .feedback
    // (same cwd), both with page '/', distinguished only by sourceFile. (POST/GET
    // need no Markdown renderer, so this half runs even offline.)
    await fetch(MDA + '/__feedback/api/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: MDA },
      body: JSON.stringify({ page: '/', text: 'note on A', type: 'comment', anchor: { snippet: 'Alpha' }, sourceFile: 'docs/a.md' }),
    });
    await fetch(MDB + '/__feedback/api/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: MDB },
      body: JSON.stringify({ page: '/', text: 'note on B', type: 'comment', anchor: { snippet: 'Bravo' }, sourceFile: 'docs/b.md' }),
    });
    const shared = await (await fetch(MDA + '/__feedback/api/comments')).json();
    const bySrc = shared.comments.map((c) => c.sourceFile).sort().join(',');
    const pages = [...new Set(shared.comments.map((c) => c.page))];
    check('--md: two files share one data dir — page collides (/), sourceFile distinguishes',
      shared.comments.length === 2 && bySrc === 'docs/a.md,docs/b.md' && pages.length === 1 && pages[0] === '/');

    // The other half of the contract: each served page carries its OWN sourceFile
    // as window.__kbfSource, so the overlay can scope to it. Rendering needs the
    // lazily-installed `marked`; if it isn't available (offline runner), skip this
    // sub-check rather than fail — the data-layer assertion above still stands.
    const aRes = await fetch(MDA + '/');
    const aHtml = await aRes.text();
    if (aRes.status === 200 && aHtml.includes('Alpha')) {
      const bHtml = await (await fetch(MDB + '/')).text();
      check('--md: each page carries its own sourceFile as __kbfSource',
        aHtml.includes('window.__kbfSource="docs/a.md"') && bHtml.includes('window.__kbfSource="docs/b.md"'));
      // The unquoted href is rewritten to "#" and the animation element is gone,
      // while the harmless text beside it survives. A rendered .md shares an
      // origin with the comment API, so active content here could post comments
      // an agent later implements.
      check('--md: an unquoted javascript: href and an <animate> never reach the page',
        /<a href="#">x<\/a>/.test(bHtml)
        && !/href\s*=\s*["']?javascript/i.test(bHtml)
        && !/<animate/i.test(bHtml)
        && bHtml.includes('<text>c</text>'));
      // Collapsible chapters ship with the doc shell: the fold script (keyed
      // per file via sessionStorage), the reveal hook the overlay talks to, and
      // the CSS that makes [hidden] win over the table display override.
      check('--md: doc shell re-centres the article beside an open List panel',
    aHtml.includes('html.kbf-panel-open body') && aHtml.includes('kbf-shift-instant'));
  check('--md: doc shell includes the chapter-fold script and reveal hook',
        aHtml.includes('kbf-md-fold') && aHtml.includes('kbf:reveal') && aHtml.includes('.doc > [hidden]'));
      // Links in the doc body open in a new tab (external AND relative-to-
      // another-doc, so following a reference never replaces the review page);
      // in-page #anchors keep jumping within the doc. The folder-index page is
      // rendered by renderMdIndex, which deliberately skips this rewrite.
      const blank = (h, hrefPart) => new RegExp(`<a[^>]*href="[^"]*${hrefPart}[^"]*"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`).test(h);
      check('--md: doc links open in a new tab; in-page #anchors do not',
        blank(aHtml, 'example\\.com/x') && blank(aHtml, 'b\\.md')
        && !/<a[^>]*href="#alpha"[^>]*target=/.test(aHtml));
    } else {
      // Locally a missing renderer only means "offline, nothing was installed" —
      // the data-layer checks above still stand, so skip. In CI the renderer is
      // installed by a step before this run, so a page that does not render is a
      // real break and has to fail.
      mdRenderMissing('--md: __kbfSource render check');
    }
  } finally {
    mdaSrv.kill(); mdbSrv.kill();
  }

  // HTML written inside a .md is shown as text by default, and rendered only
  // with --md-html. c.md carries a block payload, an inline tag, a table and a
  // fenced block, plus a plain Markdown link to a script address (which `marked`
  // does not clean, so it proves the sanitizer still runs in the strict mode).
  writeFileSync(path.join(mdCwd, 'docs', 'c.md'),
    '# Charlie\n\nA sentence with <b>bold</b> inside it.\n\n<script>alert(1)</script>\n\nA [link](javascript:alert(1)) here.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```html\n<em>in a fence</em>\n```\n');
  const MDC_PORT = PORT + 11;
  const MDD_PORT = PORT + 12;
  const mdcSrv = spawn(process.execPath, [bin, '--md', 'docs/c.md', '--port', String(MDC_PORT), '--no-open'], { stdio: 'ignore', cwd: mdCwd });
  const mddSrv = spawn(process.execPath, [bin, '--md', 'docs/c.md', '--port', String(MDD_PORT), '--no-open', '--md-html'], { stdio: 'ignore', cwd: mdCwd });
  try {
    await ready(MDC_PORT, MDD_PORT);
    const strictRes = await fetch(`http://127.0.0.1:${MDC_PORT}/`);
    const strictHtml = await strictRes.text();
    // Same guard as above: without the lazily-installed renderer there is no
    // page to inspect, and an offline runner should skip rather than fail.
    if (strictRes.status === 200 && strictHtml.includes('Charlie')) {
      const loose = await (await fetch(`http://127.0.0.1:${MDD_PORT}/`)).text();
      // The page shell has scripts of its own, so look for THIS payload.
      check('--md: HTML in the file is shown as text by default, block and inline alike',
        strictHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !strictHtml.includes('<script>alert(1)')
        && strictHtml.includes('&lt;b&gt;bold&lt;/b&gt;') && !strictHtml.includes('<b>bold</b>'));
      check('--md: a Markdown link to a script address is neutralised in the default mode too',
        !/href\s*=\s*["']?javascript/i.test(strictHtml));
      check('--md: fenced code and tables are untouched in both modes',
        strictHtml.includes('&lt;em&gt;in a fence&lt;/em&gt;') && loose.includes('&lt;em&gt;in a fence&lt;/em&gt;')
        && /<table>[\s\S]*<th>a<\/th>/.test(strictHtml) && /<table>[\s\S]*<th>a<\/th>/.test(loose));
      check('--md-html: the HTML renders again and the script is stripped, as before',
        loose.includes('<b>bold</b>') && !loose.includes('<script>alert(1)') && !loose.includes('&lt;b&gt;bold&lt;/b&gt;'));
    } else {
      mdRenderMissing('--md: strict / --md-html render checks');
    }
  } finally {
    mdcSrv.kill(); mddSrv.kill();
  }

  // md-export stamps each open Markdown comment into its source file as an
  // <!-- @FB#<id> --> marker on the line holding the quoted text. It runs in its
  // own temp project: exportMarkers stamps EVERY open comment that has a
  // sourceFile, and the folder above already holds several from earlier checks.
  const stampCwd = mkdtempSync(path.join(tmpdir(), 'fbs-stamp-'));
  writeFileSync(path.join(stampCwd, 'notes.md'), '# Notes\n\nThe kettle boils at ninety degrees.\n\nAnother line entirely.\n');
  const ME_PORT = PORT + 13;
  const meSrv = spawn(process.execPath, [bin, '--md', 'notes.md', '--port', String(ME_PORT), '--no-open'], { stdio: 'ignore', cwd: stampCwd });
  try {
    await ready(ME_PORT);
    const ME = `http://127.0.0.1:${ME_PORT}`;
    const MEJ = { 'Content-Type': 'application/json', Origin: ME };
    await fetch(ME + '/__feedback/api/comments', {
      method: 'POST', headers: MEJ,
      body: JSON.stringify({
        page: '/', text: 'say why ninety', type: 'comment', sourceFile: 'notes.md',
        anchor: { type: 'range', rangeText: 'kettle boils at ninety' },
      }),
    });
    const stamp = await fetch(ME + '/__feedback/api/md-export', { method: 'POST', headers: MEJ });
    const stampBody = await stamp.json();
    const stampedLine = readFileSync(path.join(stampCwd, 'notes.md'), 'utf8')
      .split(/\r?\n/).find((l) => l.includes('<!-- @FB#'));
    check('md-export stamps one marker onto the line holding the quoted text',
      stamp.status === 200 && stampBody.stamped === 1 && stampBody.files === 1 && stampBody.notFound === 0
      && !!stampedLine && stampedLine.includes('kettle boils at ninety') && stampedLine.includes('say why ninety'));
  } finally {
    meSrv.kill();
    await sleep(200);
    try { rmSync(stampCwd, { recursive: true, force: true }); } catch (e) { /* temp dir, OS will reap */ }
  }

  // Version history for a reviewed Markdown file: the copy it opened with, a
  // copy each time it changes on disk, a diff between any two, and putting an
  // older one back. Its own temp project so the file is only touched here.
  const histCwd = mkdtempSync(path.join(tmpdir(), 'fbs-hist-'));
  const histMd = path.join(histCwd, 'report.md');
  writeFileSync(histMd, '# Report\n\nThe first paragraph.\n\nThe second paragraph.\n');
  const HI_PORT = PORT + 14;
  const hiSrv = spawn(process.execPath, [bin, '--md', 'report.md', '--port', String(HI_PORT), '--no-open'], { stdio: 'ignore', cwd: histCwd });
  try {
    await ready(HI_PORT);
    const HI = `http://127.0.0.1:${HI_PORT}`;
    const HIJ = { 'Content-Type': 'application/json', Origin: HI };
    const hist = (q) => fetch(HI + '/__feedback/api/history' + q).then((r) => r.json());
    const opened = await fetch(HI + '/');
    const openedHtml = await opened.text();
    if (opened.status === 200 && openedHtml.includes('Report')) {
      const v1 = await hist('?file=report.md');
      check('opening a Markdown file keeps the copy it started from',
        v1.file === 'report.md' && v1.versions.length === 1 && v1.versions[0].n === 1 && v1.versions[0].reason === 'opened');

      // Watch the live stream, then change the file the way an agent would.
      const hiSse = await fetch(HI + '/__feedback/events');
      const hiReader = hiSse.body.getReader();
      writeFileSync(histMd, '# Report\n\nThe first paragraph, rewritten.\n\nThe second paragraph.\n');
      let hiText = '';
      for (let i = 0; i < 8 && !hiText.includes('event: source'); i++) {
        const { value, done } = await hiReader.read(); if (done) break; hiText += Buffer.from(value).toString();
      }
      hiReader.cancel().catch(() => {});
      check('an edit on disk reaches the open page as a source event',
        hiText.includes('event: source') && hiText.includes('"file":"report.md"')
        && hiText.includes('"added":1') && hiText.includes('"removed":1'));
      const v2 = await hist('?file=report.md');
      check('the change is kept as a second version with what it added and removed',
        v2.versions.length === 2 && v2.versions[1].n === 2 && v2.versions[1].reason === 'changed'
        && v2.versions[1].added === 1 && v2.versions[1].removed === 1);
      const one = await hist('/1?file=report.md');
      check('a single version comes back with its content',
        one.n === 1 && one.content.includes('The first paragraph.') && !one.content.includes('rewritten'));
      const diff = await hist('/diff?file=report.md&from=1&to=2');
      check('the diff reports the changed line and no more',
        diff.from.n === 1 && diff.to.n === 2 && diff.stats.added === 1 && diff.stats.removed === 1
        && diff.hunks.length === 1 && diff.ops === undefined
        && JSON.stringify(diff.hunks[0].ops).includes('The first paragraph, rewritten.'));

      const same = await fetch(HI + '/__feedback/api/history/snapshot', {
        method: 'POST', headers: HIJ, body: JSON.stringify({ file: 'report.md', reason: 'batch' }),
      });
      const sameOut = await same.json();
      check('a snapshot of unchanged content adds nothing', same.status === 200 && sameOut.changed === false);

      const undoEdit = await fetch(HI + '/__feedback/api/history/restore', {
        method: 'POST', headers: HIJ, body: JSON.stringify({ file: 'report.md', n: 1 }),
      });
      const undoOut = await undoEdit.json();
      const restoredText = readFileSync(histMd, 'utf8');
      const v3 = await hist('?file=report.md');
      check('restoring an older version rewrites the file and is itself kept',
        undoEdit.status === 200 && undoOut.ok === true
        && restoredText.includes('The first paragraph.') && !restoredText.includes('rewritten')
        && v3.versions.length >= 3 && v3.versions[v3.versions.length - 1].reason === 'restore');

      const outside = await fetch(HI + '/__feedback/api/history?file=../../etc/passwd');
      check('a file outside the project is refused', outside.status === 400);
      const missingVersion = await hist('/99?file=report.md');
      check('an unknown version is a 404', missingVersion.error === 'no such version');
    } else {
      mdRenderMissing('--md: history checks');
    }
  } finally {
    hiSrv.kill();
    await sleep(200);
    try { rmSync(histCwd, { recursive: true, force: true }); } catch (e) { /* temp dir, OS will reap */ }
  }

  // --stamp does the same stamping from the command line, with no server at all.
  // Its own project again, so it stamps exactly the one comment put in front of it.
  const cliStampCwd = mkdtempSync(path.join(tmpdir(), 'fbs-cli-stamp-'));
  writeFileSync(path.join(cliStampCwd, 'plan.md'), '# Plan\n\nShip the widget on Friday.\n');
  const stampNoData = await runCli(['--stamp'], cliStampCwd);
  check('--stamp with no comments file exits 1 and says what is missing',
    stampNoData.code === 1 && stampNoData.out.includes('No comments to stamp'));
  mkdirSync(path.join(cliStampCwd, '.feedback'));
  writeFileSync(path.join(cliStampCwd, '.feedback', 'comments.json'), JSON.stringify({
    version: 1,
    comments: [{
      id: 'c_stamp-cli-0001', schemaVersion: 6, page: '/', sourceFile: 'plan.md',
      type: 'comment', text: 'name the widget', status: 'open', thread: [],
      anchor: { type: 'range', rangeText: 'Ship the widget on Friday' },
    }],
  }, null, 2));
  const stampCli = await runCli(['--stamp'], cliStampCwd);
  const planMd = readFileSync(path.join(cliStampCwd, 'plan.md'), 'utf8');
  check('--stamp writes the marker, reports one line, exits 0 and starts no server',
    stampCli.code === 0 && stampCli.out.trim() === 'Stamped 1 marker into 1 file'
    && !stampCli.out.includes('Ctrl+C to stop')
    && planMd.includes('<!-- @FB#c_stamp-cli-0001: name the widget -->'));
  const stampAgain = await runCli(['--stamp'], cliStampCwd);
  check('--stamp is idempotent (a second run adds nothing)',
    stampAgain.code === 0 && stampAgain.out.trim() === 'Stamped 0 markers into 0 files'
    && (readFileSync(path.join(cliStampCwd, 'plan.md'), 'utf8').match(/@FB#/g) || []).length === 1);
  try { rmSync(cliStampCwd, { recursive: true, force: true }); } catch (e) { /* temp dir, OS will reap */ }
} catch (e) {
  console.log('FAIL  exception:', e.message);
  failures++;
} finally {
  srv.kill();
  await sleep(400); // let the child release file handles before cleanup (Windows)
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp dir, OS will reap */ }
  console.log(failures ? `\n${failures} smoke check(s) failed` : '\nall smoke checks passed');
  process.exit(failures ? 1 : 0);
}
