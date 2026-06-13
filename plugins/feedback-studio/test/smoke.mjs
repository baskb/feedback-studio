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

  const trav = await fetch(ORIGIN + '/%2e%2e/%2e%2e/secret.txt');
  const travBody = await trav.text();
  check('path traversal blocked', trav.status === 404 && !travBody.includes('TOP SECRET'));

  const asset = await fetch(ORIGIN + '/__feedback/overlay.js');
  check('serves overlay asset', asset.status === 200);

  // the same-origin comment should have persisted
  const after = await (await fetch(ORIGIN + '/__feedback/api/comments')).json();
  check('comment persisted', after.comments.length === 1 && after.comments[0].text === 'same-origin works');

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
