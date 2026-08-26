// Live smoke test: boots the server against a temp site and exercises the HTTP
// surface (injection, API, CSRF guard, path-traversal guard). Not part of the
// unit suite — run manually: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const PORT = 4567;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const bin = path.join(__dirname, '..', 'bin', 'feedback-studio.mjs');
const srv = spawn(process.execPath, [bin, '--dir', site, '--port', String(PORT), '--no-open'], { stdio: 'ignore', cwd: root });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; }

try {
  await sleep(700);

  const home = await fetch(ORIGIN + '/');
  const homeBody = await home.text();
  check('serves index', home.status === 200);
  check('injects overlay script', homeBody.includes('/__feedback/overlay.js'));

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
  check('serves overlay asset', asset.status === 200);

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
  check('writes session.json with pid + apiBase', !!sess && sess.pid === srv.pid && sess.apiBase === `http://localhost:${PORT}/__feedback/api`);
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
  // implicit heartbeat: the agent's own poll promotes offline → online; a browser's does not
  await postJ('agent-status', { state: 'offline' });
  await fetch(ORIGIN + '/__feedback/api/comments', { headers: { 'Sec-Fetch-Mode': 'cors', 'User-Agent': 'Mozilla/5.0 (test browser)' } });
  const afterBrowser = (await getAgent()).agent.state;
  await fetch(ORIGIN + '/__feedback/api/comments');
  const afterAgent = (await getAgent()).agent.state;
  check('agent poll counts as heartbeat (browser fetch does not)', afterBrowser === 'offline' && afterAgent === 'online');
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

  // reload broadcast endpoint (agent refreshes open overlays after a batch)
  const reload = await fetch(ORIGIN + '/__feedback/api/reload', { method: 'POST', headers: { Origin: ORIGIN } });
  check('reload endpoint accepts POST', reload.status === 200 && (await reload.json()).ok === true);

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
    await sleep(700);
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
    await sleep(700);
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
    const cReload = await fetch(SH + `/__feedback/api/reload?key=${keys.comment}`, { method: 'POST', headers: J });
    const aReload = await fetch(SH + `/__feedback/api/reload?key=${keys.admin}`, { method: 'POST', headers: J });
    check('share: reload is admin-only', cReload.status === 403 && aReload.status === 200);
    const aPatch = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.admin}`, {
      method: 'PATCH', headers: J, body: JSON.stringify({ status: 'resolved' }),
    });
    const aDelete = await fetch(SH + `/__feedback/api/comments/${cc.id}?key=${keys.admin}`, { method: 'DELETE', headers: J });
    check('share: admin manages statuses + deletes', aPatch.status === 200 && aDelete.status === 200);
    const asDeny = await fetch(SH + `/__feedback/api/agent-status?key=${keys.comment}`, {
      method: 'POST', headers: J, body: JSON.stringify({ state: 'online' }),
    });
    check('share: comment role cannot impersonate the agent', asDeny.status === 403);
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
  } finally {
    pxSrv.kill(); upstream.close();
  }

  // --no-shots: shot uploads refused, and the served overlay carries the flag
  // so the browser never probes the vendor route.
  const NS_PORT = PORT + 3;
  const nsSrv = spawn(process.execPath, [bin, '--dir', site, '--no-shots', '--port', String(NS_PORT), '--no-open'], { stdio: 'ignore', cwd: root });
  try {
    await sleep(700);
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
  writeFileSync(path.join(mdCwd, 'docs', 'b.md'), '# Bravo\n\nSecond doc paragraph.\n');
  const MDA_PORT = PORT + 7;
  const MDB_PORT = PORT + 8;
  const mdaSrv = spawn(process.execPath, [bin, '--md', 'docs/a.md', '--port', String(MDA_PORT), '--no-open'], { stdio: 'ignore', cwd: mdCwd });
  const mdbSrv = spawn(process.execPath, [bin, '--md', 'docs/b.md', '--port', String(MDB_PORT), '--no-open'], { stdio: 'ignore', cwd: mdCwd });
  try {
    await sleep(700);
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
      // Collapsible chapters ship with the doc shell: the fold script (keyed
      // per file via sessionStorage), the reveal hook the overlay talks to, and
      // the CSS that makes [hidden] win over the table display override.
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
      console.log('SKIP  --md: __kbfSource render check (marked renderer unavailable)');
    }
  } finally {
    mdaSrv.kill(); mdbSrv.kill();
  }
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
