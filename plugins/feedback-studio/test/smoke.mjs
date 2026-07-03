// Live smoke test: boots the server against a temp site and exercises the HTTP
// surface (injection, API, CSRF guard, path-traversal guard). Not part of the
// unit suite — run manually: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

  const trav = await fetch(ORIGIN + '/%2e%2e/%2e%2e/secret.txt');
  const travBody = await trav.text();
  check('path traversal blocked', trav.status === 404 && !travBody.includes('TOP SECRET'));

  const asset = await fetch(ORIGIN + '/__feedback/overlay.js');
  check('serves overlay asset', asset.status === 200);

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
    const page = await fetch(SH + `/?key=${keys.view}`, { redirect: 'manual' });
    const cookie = page.headers.get('set-cookie') || '';
    check('share: page key exchanges into an HttpOnly cookie + clean redirect',
      page.status === 302 && cookie.includes('kbf-key=') && cookie.includes('HttpOnly') && !(page.headers.get('location') || '').includes('key='));
    const ovl = await (await fetch(SH + '/__feedback/overlay.js', { headers: { Cookie: `kbf-key=${keys.view}` } })).text();
    check('share: overlay is served role-aware', ovl.startsWith('window.__kbfRole="view";'));
  } finally {
    shSrv.kill();
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
