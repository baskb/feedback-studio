#!/usr/bin/env node
// Feedback Studio — a local commenting overlay for any website.
//
// Serves a static build directory (or proxies a running dev server) and injects
// a commenting overlay into every HTML page. Comments (typed or spoken) attach
// to any DOM element or text selection and persist to .feedback/comments.json
// plus a readable FEEDBACK.md, ready for an agent to process.
//
// Modes:
//   --dir <path>     serve a static build directory (auto-detected if omitted)
//   --proxy <url>    proxy a running dev server (e.g. http://localhost:5173)
//   --md <path>      review a Markdown file or a folder of them
//   --demo           serve the bundled sample page from a throwaway temp copy
//   --no-seed        with --demo: start with no comments (add your own live)
//   --port <n>       listen port (default 4444)
//   --host <addr>    bind address (default 127.0.0.1; use 0.0.0.0 for phone/LAN)
//   --https          serve over TLS with a self-signed cert (voice on phones)
//   --tunnel         public real-cert URL via a Cloudflare quick tunnel
//   --no-open        don't open the browser automatically
//   --seed-agents    append the processing workflow to ./CLAUDE.md + ./AGENTS.md, then exit
//
// HTTP needs zero dependencies. --https / --md fetch a tiny helper once.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir, chmod, unlink, mkdtemp, cp } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, watch, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED_TYPES, STATUSES, AUTONOMY,
  readComments, writeComments, mutate, makeComment, makeReply, exportMarkdown,
  exportProcessInstructions, seedAgentsFile,
} from '../lib/store.mjs';
import { exportMarkers as stampMarkers } from '../lib/markers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- args ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const PORT = Number(args.port || process.env.PORT || 4444);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`\n  Invalid port: ${args.port || process.env.PORT}. Use --port <1-65535>.\n`);
  process.exit(1);
}
// Bind to loopback by default so the mutating API isn't reachable from the LAN.
// Pass --host 0.0.0.0 to expose it (e.g. to comment from your phone).
const HOST = args.host ? String(args.host) : '127.0.0.1';
const EXPOSE_LAN = HOST === '0.0.0.0' || HOST === '::' || (args.host && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1');
// --tunnel routes the phone through a real-cert public URL (cloudflared), so we
// serve plain http locally and let the tunnel terminate TLS — no self-signed cert.
const TUNNEL = !!args.tunnel;
const USE_HTTPS = (!!args.https || process.env.HTTPS === '1') && !TUNNEL;

let PROXY_URL = null;
if (args.proxy) {
  try { PROXY_URL = new URL(String(args.proxy)); }
  catch (e) { console.error(`\n  Invalid --proxy URL: ${args.proxy}\n`); process.exit(1); }
}
const PROXY = PROXY_URL ? PROXY_URL.origin : null;
const PROXY_AGENT = PROXY_URL && PROXY_URL.protocol === 'https:' ? https : http;
const PROXY_PORT = PROXY_URL ? Number(PROXY_URL.port || (PROXY_URL.protocol === 'https:' ? 443 : 80)) : 0;

// Demo mode: serve a bundled sample page (copied to a throwaway temp dir, so
// processing the seeded comments edits the copy, never the user's project).
const DEMO = !!args.demo;
if (DEMO && (args.proxy || args.md || args.dir)) {
  console.error('\n  --demo serves the bundled sample site; it cannot be combined with --dir, --proxy or --md.\n');
  process.exit(1);
}

// Markdown review mode: --md <file.md> or --md <dir-of-md>.
const MD_MODE = !!args.md;
let MD_ROOT = null; // directory that md paths are resolved under
let MD_SINGLE = null; // the single .md file, when --md points at one file
if (MD_MODE) {
  const p = path.resolve(process.cwd(), String(args.md));
  try {
    if (statSync(p).isDirectory()) MD_ROOT = p;
    else { MD_ROOT = path.dirname(p); MD_SINGLE = p; }
  } catch (e) {
    // A typo'd path must not silently fall back to reviewing the whole cwd.
    console.error(`\n  --md path not found: ${p}\n`);
    process.exit(1);
  }
}

const CWD = process.cwd();
// `let`, not `const`: --demo repoints all of these at a throwaway temp dir
// (setupDemo, before the server starts) so the demo never touches the project.
let DATA_DIR = path.join(CWD, '.feedback');
let DATA_FILE = path.join(DATA_DIR, 'comments.json');
let CERT_DIR = path.join(DATA_DIR, '.cert');
const GLOBAL_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.feedback-studio');

// Static build directories we auto-detect when neither --dir nor --proxy given.
const AUTODETECT = ['dist', 'build', 'out', '_site', 'public', '.output/public', 'site'];

function resolveStaticDir() {
  if (args.dir) return path.resolve(CWD, String(args.dir));
  for (const d of AUTODETECT) {
    const p = path.join(CWD, d);
    if (existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}
let STATIC_DIR = DEMO ? null : (PROXY || MD_MODE ? null : resolveStaticDir());

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

const INJECT = `\n<script src="/__feedback/overlay.js" defer></script>\n`;
function injectHtml(html) {
  // Inject before the LAST </body> (an earlier one may live inside a <script>
  // or <template>); fall back to appending if there's no closing body tag.
  const i = html.lastIndexOf('</body>');
  if (i !== -1) return html.slice(0, i) + INJECT + html.slice(i);
  return html + INJECT;
}

// ---------- LAN + TLS ----------
function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function ensureSelfsigned() {
  try { return (await import('selfsigned')).default; } catch (e) {}
  const depsDir = path.join(GLOBAL_DATA, 'deps');
  const local = path.join(depsDir, 'node_modules', 'selfsigned', 'index.js');
  if (existsSync(local)) return (await import(pathToFileURL(local).href)).default;
  console.log('  Setting up the HTTPS certificate helper (one-time)...');
  await mkdir(depsDir, { recursive: true });
  await writeFile(path.join(depsDir, 'package.json'), '{"name":"feedback-studio-deps","private":true}');
  try {
    // --ignore-scripts blocks install-time lifecycle scripts (supply-chain hardening).
    execSync('npm install selfsigned@^5 --no-audit --no-fund --ignore-scripts --loglevel=error', { cwd: depsDir, stdio: 'inherit' });
  } catch (e) {
    throw new Error('could not install the HTTPS helper "selfsigned" (npm failed). Run without --https, or install it manually in ' + depsDir);
  }
  if (!existsSync(local)) throw new Error('the HTTPS helper "selfsigned" did not install correctly');
  return (await import(pathToFileURL(local).href)).default;
}

async function getTlsOptions(ips) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'ips.json');
  const wanted = JSON.stringify([...ips].sort());
  if (existsSync(keyFile) && existsSync(certFile) && existsSync(metaFile)) {
    try { if (readFileSync(metaFile, 'utf-8') === wanted) return { key: readFileSync(keyFile), cert: readFileSync(certFile) }; } catch (e) {}
  }
  const selfsigned = await ensureSelfsigned();
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }],
  });
  await mkdir(CERT_DIR, { recursive: true });
  await writeFile(keyFile, pems.private);
  await writeFile(certFile, pems.cert);
  await writeFile(metaFile, wanted);
  return { key: pems.private, cert: pems.cert };
}

// ---------- helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const BODY_LIMIT = 1_000_000; // 1 MB
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        const e = new Error('request body too large');
        e.statusCode = 413;
        // Pause (don't destroy) so the 413 response can still be written; Node
        // closes the connection after responding to a partially-read request.
        req.pause();
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (e) { const err = new Error('invalid JSON body'); err.statusCode = 400; throw err; }
}

// A path that stays inside `root`, by containment (not a string prefix), so `..`
// can't escape. Note: this checks the path, not the inode — a symlink inside
// `root` pointing outside it is not followed-up on here. That's acceptable for a
// local tool serving your own build dir; it is not hardened against a malicious
// symlink planted in the served tree.
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch (e) { return null; }
  const target = path.normalize(path.join(root, decoded));
  return within(root, target) ? target : null;
}
async function resolveStaticFile(urlPath) {
  // Mixes await stat() with existsSync on purpose: the fallbacks are quick
  // boolean probes on a local dir; nothing mutates between them.
  let target = safeJoin(STATIC_DIR, urlPath);
  if (!target) return null;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = path.join(target, 'index.html');
  } catch (e) {
    if (existsSync(target + '.html')) target = target + '.html';
    else if (existsSync(path.join(target, 'index.html'))) target = path.join(target, 'index.html');
  }
  return existsSync(target) ? target : null;
}

// Reject cross-site browser writes: a page on another origin can fire a fetch at
// us, but its Origin header won't match our Host. Same-origin (the overlay) and
// non-browser clients (no Origin header) are allowed. Omitting Origin to bypass
// this requires a non-browser client, i.e. code already running on this machine
// (or with LAN access when explicitly exposed) — outside the threat this guards.
function crossSite(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host !== req.headers.host; }
  catch (e) { return true; }
}

// Hostnames the mutating API will answer to. Defends against DNS rebinding: a
// page on attacker.com can rebind that name to 127.0.0.1, but the victim's
// browser still sends `Host: attacker.com`, which isn't in this set. Without
// this, the Origin/Host check above passes (both read attacker.com) and a
// drive-by page could POST comments an agent later acts on. Populated at
// startup with the loopback names, the LAN IPs, the bound host, and the tunnel
// hostname once it's known.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function populateAllowedHosts(ips = []) {
  for (const ip of ips) ALLOWED_HOSTS.add(String(ip).toLowerCase());
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') ALLOWED_HOSTS.add(HOST.toLowerCase());
  // The machine's own name (and its mDNS form) so `http://mypc.local:4444` works
  // on the LAN — a rebinding attacker can't use these, they resolve locally.
  try {
    const hn = os.hostname().toLowerCase();
    if (hn) { ALLOWED_HOSTS.add(hn); ALLOWED_HOSTS.add(hn + '.local'); }
  } catch (e) {}
}
// A non-browser client (curl, the MCP server, a script) sends no Host or one we
// don't recognise; those aren't the rebinding threat (they're code already on
// the machine), so only an unrecognised *browser-style* Host is refused. We key
// off the presence of a Host header, which every browser sends.
function hostAllowed(req) {
  const h = req.headers.host;
  if (!h) return true;
  const name = h.replace(/:\d+$/, '').toLowerCase();
  return ALLOWED_HOSTS.has(name);
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/__feedback\/api\/?/, '').split('/').filter(Boolean);
  const resource = parts[0] || '';
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && crossSite(req)) return sendJSON(res, 403, { error: 'cross-site request blocked' });
  // (The Host allowlist is enforced for the whole /__feedback surface — reads
  // included — in handler(), before this function is reached.)

  try {
    if (resource === 'comments') {
      const id = parts[1];
      if (req.method === 'GET') return sendJSON(res, 200, { comments: await readComments(DATA_DIR) });

      // POST /comments/:id/reply — add a message to a comment's conversation thread
      if (req.method === 'POST' && id && parts[2] === 'reply') {
        const body = await readJson(req);
        const out = await mutate(DATA_DIR, (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          if (!Array.isArray(c.thread)) c.thread = [];
          const reply = makeReply({ author: body.author, authorName: body.authorName, text: body.text });
          c.thread.push(reply);
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c, reply } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        return sendJSON(res, 201, out);
      }

      if (req.method === 'POST' && !id) {
        const body = await readJson(req);
        const comment = await mutate(DATA_DIR, (list) => {
          const c = makeComment(body);
          list.push(c);
          return { comments: list, value: c };
        });
        broadcastSoon();
        return sendJSON(res, 201, { comment });
      }

      if (req.method === 'PATCH' && id) {
        const body = await readJson(req);
        const out = await mutate(DATA_DIR, (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          if (typeof body.text === 'string') c.text = body.text.trim().slice(0, 10000);
          if (STATUSES.includes(body.status)) c.status = body.status;
          if (ALLOWED_TYPES.includes(body.type)) c.type = body.type;
          if (AUTONOMY.includes(body.autonomy)) c.autonomy = body.autonomy;
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        return sendJSON(res, 200, out);
      }

      if (req.method === 'DELETE' && id) {
        const out = await mutate(DATA_DIR, (list) => {
          const next = list.filter((x) => x.id !== id);
          if (next.length === list.length) return { comments: list, value: { notFound: true } };
          return { comments: next, value: { ok: true } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        return sendJSON(res, 200, { ok: true });
      }
    }
    if (resource === 'export' && req.method === 'POST') {
      await exportMarkdown(DATA_DIR, await readComments(DATA_DIR));
      return sendJSON(res, 200, { ok: true });
    }
    if (resource === 'md-export' && req.method === 'POST') {
      // sourceFile paths are recorded cwd-relative, so resolution stays rooted at
      // CWD — but when --md points outside the cwd, that tree is a legitimate
      // stamping target too, so it joins the containment allowlist.
      const roots = MD_ROOT ? [CWD, MD_ROOT] : [CWD];
      return sendJSON(res, 200, { ok: true, ...(await stampMarkers(DATA_DIR, CWD, roots)) });
    }
    return sendJSON(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    if (err.statusCode) return sendJSON(res, err.statusCode, { error: err.message });
    if (err.code === 'ECORRUPT') return sendJSON(res, 500, { error: 'comments.json is unreadable — fix or remove .feedback/comments.json' });
    console.error('API error:', err);
    return sendJSON(res, 500, { error: 'internal error' });
  }
}

// ---------- asset + static serving ----------
async function serveAsset(res, file) {
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}
async function serveStatic(res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    res.writeHead(status, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(injectHtml(await readFile(file, 'utf-8')));
  } else {
    res.writeHead(status, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  }
}

// ---------- proxy serving ----------
// Requests are pinned to the configured upstream origin: only the path+query of
// the incoming request is forwarded, never a host derived from the request line,
// so this can't be turned into an open proxy / SSRF pivot.
function proxyRequest(req, res) {
  const u = new URL(req.url, PROXY_URL);
  const opts = {
    protocol: PROXY_URL.protocol, hostname: PROXY_URL.hostname, port: PROXY_PORT,
    path: u.pathname + u.search, method: req.method,
    headers: { ...req.headers, host: PROXY_URL.host, 'accept-encoding': 'identity' },
  };
  const preq = PROXY_AGENT.request(opts, (pres) => {
    const ct = pres.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        // Route absolute upstream-origin URLs back through us, then inject the
        // overlay. Known trade-off: this replaces the origin EVERYWHERE in the
        // HTML, including inside inline <script> strings — an app that builds
        // URLs from a hardcoded absolute origin will see them relativised. In
        // practice dev servers emit relative URLs, so this stays the simple way.
        let html = Buffer.concat(chunks).toString('utf-8').split(PROXY).join('');
        html = injectHtml(html);
        const headers = { ...pres.headers };
        delete headers['content-length'];
        delete headers['content-encoding'];
        // Drop CSP so the injected overlay (shadow-root assets + inline) can load.
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        headers['cache-control'] = 'no-store';
        res.writeHead(pres.statusCode || 200, headers);
        res.end(html);
      });
    } else {
      res.writeHead(pres.statusCode || 200, pres.headers);
      pres.pipe(res);
    }
  });
  preq.on('error', (e) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Upstream not reachable. Is the dev server running at ' + PROXY + ' ?');
  });
  req.pipe(preq);
}

// Pass HMR / live-reload websockets straight through to the upstream dev server.
function proxyUpgrade(req, clientSocket, head) {
  const onReady = (upstream) => {
    upstream.setTimeout(0); // connected: HMR sockets legitimately idle for minutes
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    upstream.write('\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  };
  let upstream;
  if (PROXY_URL.protocol === 'https:') {
    upstream = tls.connect(PROXY_PORT, PROXY_URL.hostname, { servername: PROXY_URL.hostname }, () => onReady(upstream));
  } else {
    upstream = net.connect(PROXY_PORT, PROXY_URL.hostname, () => onReady(upstream));
  }
  // Connect-phase timeout only; cleared in onReady so idle websockets survive.
  upstream.setTimeout(10000, () => upstream.destroy());
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
}

// ---------- live updates (Server-Sent Events) ----------
const sseClients = new Set();
const MAX_SSE = 50;
const SSE_DRAIN_MS = 30000;
let _lastBroadcast = '';

function dropSse(res) {
  if (!res) return;
  if (res._kbfDrain) { clearTimeout(res._kbfDrain); res._kbfDrain = null; }
  sseClients.delete(res);
  try { res.end(); } catch (e) {}
}
// Write to one client with backpressure handling: if the socket buffer is full
// (a slow/stalled client), give it a grace window to drain, then drop it — a
// stuck client must not make broadcasts buffer in memory unboundedly.
function writeSse(res, payload) {
  let ok = false;
  try { ok = res.write(payload); } catch (e) { dropSse(res); return; }
  if (!ok && !res._kbfDrain) {
    res._kbfDrain = setTimeout(() => dropSse(res), SSE_DRAIN_MS);
    res.once('drain', () => { clearTimeout(res._kbfDrain); res._kbfDrain = null; });
  }
}
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  // Bound the client set: drop the oldest stream if we somehow accumulate many.
  if (sseClients.size >= MAX_SSE) dropSse(sseClients.values().next().value);
  sseClients.add(res);
  const ping = setInterval(() => writeSse(res, ': ping\n\n'), 25000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    if (res._kbfDrain) { clearTimeout(res._kbfDrain); res._kbfDrain = null; }
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}
function broadcastComments(comments) {
  const payload = 'event: comments\ndata: ' + JSON.stringify({ comments }) + '\n\n';
  // Skip if identical to the last payload (file-watch + our own write both fire).
  const h = crypto.createHash('sha1').update(payload).digest('hex');
  if (h === _lastBroadcast) return;
  _lastBroadcast = h;
  for (const res of [...sseClients]) writeSse(res, payload);
}
async function broadcastFromDisk() {
  try { broadcastComments(await readComments(DATA_DIR)); } catch (e) { /* corrupt mid-edit; ignore */ }
}
let _bcTimer = null;
function broadcastSoon() { clearTimeout(_bcTimer); _bcTimer = setTimeout(broadcastFromDisk, 30); }

// Watch the data dir so EXTERNAL edits (an agent marking comments resolved, or
// the MCP server writing) push live to any open overlay. Our own API writes
// broadcast directly via broadcastSoon(); the dedup in broadcastComments keeps
// the two paths from double-sending.
function watchComments() {
  let timer = null;
  try {
    watch(DATA_DIR, (ev, fn) => {
      if (fn && String(fn) !== 'comments.json') return; // ignore .tmp / .lock / FEEDBACK.md
      clearTimeout(timer);
      timer = setTimeout(broadcastFromDisk, 120);
    });
  } catch (e) { /* fs.watch unavailable on this platform; SSE still pushes on reconnect */ }
}

// ---------- open the default browser ----------
function openBrowser(url) {
  try {
    let cmd, cmdArgs;
    if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '', url]; }
    else if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [url]; }
    else { cmd = 'xdg-open'; cmdArgs = [url]; }
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch (e) {}
}

// ---------- secure tunnel (cloudflared quick tunnel) ----------
// Gives the phone a real-certificate https://<rand>.trycloudflare.com URL, so
// there's no self-signed warning and the mic works on any network. The helper
// binary is fetched once into ~/.feedback-studio/bin (same lazy pattern as the
// --https / --md helpers); no Cloudflare account is needed for a quick tunnel.
function cloudflaredAsset() {
  // Default to the latest release. Set FBS_CLOUDFLARED_VERSION (e.g. "2024.12.2")
  // to pin a specific tag so the downloaded artifact is deterministic and can be
  // checksum-verified — see verifyChecksum / FBS_CLOUDFLARED_SHA256 below.
  const ver = (process.env.FBS_CLOUDFLARED_VERSION || '').trim();
  const base = ver
    ? `https://github.com/cloudflare/cloudflared/releases/download/${ver}/`
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const a64 = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return { url: base + `cloudflared-windows-${a64}.exe`, kind: 'exe' };
  if (process.platform === 'darwin') return { url: base + `cloudflared-darwin-${a64}.tgz`, kind: 'tgz' };
  if (process.platform === 'linux') {
    const a = process.arch === 'arm64' ? 'arm64' : (process.arch === 'arm' ? 'arm' : 'amd64');
    return { url: base + `cloudflared-linux-${a}`, kind: 'bin' };
  }
  return null;
}
function httpDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = (u) => https.get(u, { headers: { 'User-Agent': 'feedback-studio' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(new URL(res.headers.location, u).href); }
      if (res.statusCode !== 200) { res.resume(); file.close(); return reject(new Error('download failed: HTTP ' + res.statusCode)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
    get(url);
  });
}
// Verify a downloaded artifact against an expected SHA-256 when the user has
// pinned one via FBS_CLOUDFLARED_SHA256. cloudflared is a ~50 MB executable we
// fetch and run, so a pin lets a security-conscious user guarantee they're
// running exactly the audited binary (publish a hash, set the env, done). No
// env set = no check (the default keeps the zero-config quick-tunnel working).
async function verifyChecksum(file, label) {
  const want = (process.env.FBS_CLOUDFLARED_SHA256 || '').trim().toLowerCase();
  if (!want) return;
  const got = crypto.createHash('sha256').update(await readFile(file)).digest('hex');
  if (got !== want) {
    await unlink(file).catch(() => {});
    throw new Error(`${label} failed checksum verification (expected ${want}, got ${got}). Refusing to run it.`);
  }
  console.log('  Verified ' + label + ' against FBS_CLOUDFLARED_SHA256.');
}
async function ensureCloudflared() {
  // 1) already on PATH?
  try {
    const probe = process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared';
    const out = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch (e) {}
  // 2) previously downloaded?
  const binDir = path.join(GLOBAL_DATA, 'bin');
  const exe = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(exe)) return exe;
  // 3) fetch it
  const asset = cloudflaredAsset();
  if (!asset) throw new Error('no prebuilt cloudflared for ' + process.platform + '/' + process.arch + ' — install cloudflared manually, then re-run with --tunnel');
  console.log('  Setting up the secure tunnel helper (one-time, ~50 MB)...');
  await mkdir(binDir, { recursive: true });
  if (asset.kind === 'tgz') {
    const tgz = exe + '.tgz';
    await httpDownload(asset.url, tgz);
    await verifyChecksum(tgz, 'cloudflared archive');
    execSync(`tar -xzf "${tgz}" -C "${binDir}"`); // extracts a `cloudflared` binary
    await chmod(exe, 0o755).catch(() => {});
  } else {
    await httpDownload(asset.url, exe);
    await verifyChecksum(exe, 'cloudflared binary');
    if (process.platform !== 'win32') await chmod(exe, 0o755).catch(() => {});
  }
  if (!existsSync(exe)) throw new Error('cloudflared did not install correctly');
  return exe;
}
let tunnelProc = null;
function startTunnel(cfPath, port) {
  return new Promise((resolve, reject) => {
    const cf = spawn(cfPath, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProc = cf;
    let url = null;
    const scan = (b) => {
      const m = b.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !url) { url = m[0]; resolve(url); }
    };
    cf.stdout.on('data', scan);
    cf.stderr.on('data', scan);
    cf.on('error', (e) => { if (!url) reject(e); });
    cf.on('exit', (code) => { if (!url) reject(new Error('cloudflared exited (code ' + code + ') before a tunnel URL appeared')); });
    // On timeout, kill the child too — otherwise a cloudflared that never
    // prints a URL lingers invisibly until server shutdown.
    setTimeout(() => { if (!url) { try { cf.kill(); } catch (e) {} reject(new Error('timed out waiting for the tunnel URL')); } }, 30000);
  });
}

// ---------- markdown review mode ----------
let _marked = null;
async function ensureMarked() {
  if (_marked) return _marked;
  const depsDir = path.join(GLOBAL_DATA, 'deps');
  const pkgDir = path.join(depsDir, 'node_modules', 'marked');
  // Load via ESM dynamic import of the resolved entry file (avoids the CJS
  // negative-resolution cache that bites when we install during this process).
  const load = async () => {
    if (!existsSync(pkgDir)) return null;
    let cands = ['lib/marked.esm.js', 'lib/marked.cjs'];
    try {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
      const exp = pkg.exports && pkg.exports['.'];
      cands = [exp && exp.import, exp && exp.default, pkg.module, pkg.main, ...cands].filter(Boolean);
    } catch (e) {}
    for (const c of cands) {
      try {
        const m = await import(pathToFileURL(path.join(pkgDir, c)).href);
        const mk = m.marked || m.default || m;
        if (mk && typeof mk.parse === 'function') return mk;
      } catch (e) {}
    }
    return null;
  };
  _marked = await load();
  if (_marked) return _marked;
  console.log('  Setting up the Markdown renderer (one-time)...');
  await mkdir(depsDir, { recursive: true });
  if (!existsSync(path.join(depsDir, 'package.json'))) await writeFile(path.join(depsDir, 'package.json'), '{"name":"feedback-studio-deps","private":true}');
  try {
    execSync('npm install marked@^12 --no-audit --no-fund --ignore-scripts --loglevel=error', { cwd: depsDir, stdio: 'inherit' });
  } catch (e) {
    throw new Error('could not install the Markdown renderer "marked" (npm failed). Install it manually in ' + depsDir);
  }
  _marked = await load();
  if (!_marked) throw new Error('could not load the Markdown renderer (marked)');
  return _marked;
}

function htmlAttr(s) { return String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m])); }

function mdDocShell(title, sourceRel, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlAttr(title)}</title>
<style>
  :root { --ink:#1f1e1c; --soft:#565449; --muted:#8a8578; --paper:#faf9f5; --rule:#e7e4db; --clay:#c4623f; --code:#f2efe6; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.7 ui-serif, Georgia, "Times New Roman", serif; -webkit-font-smoothing:antialiased; }
  .doc { max-width: 46rem; margin: 0 auto; padding: 56px 24px 160px; }
  .doc-source { font:600 12px/1 ui-monospace,"Fira Mono",monospace; color:var(--muted);
    letter-spacing:.04em; text-transform:uppercase; margin-bottom:28px; padding-bottom:14px; border-bottom:1px solid var(--rule); }
  h1,h2,h3,h4 { font-family: ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; line-height:1.25; letter-spacing:-0.01em; margin:1.8em 0 .6em; }
  h1 { font-size:2em; margin-top:0; } h2 { font-size:1.5em; } h3 { font-size:1.22em; } h4 { font-size:1.05em; }
  p, li { color:var(--ink); } a { color:var(--clay); }
  ul,ol { padding-left:1.4em; } li { margin:.25em 0; }
  blockquote { margin:1.2em 0; padding:.4em 1.1em; border-left:3px solid var(--clay); color:var(--soft); background:rgba(196,98,63,.05); border-radius:0 8px 8px 0; }
  code { font:0.88em ui-monospace,"Fira Mono",monospace; background:var(--code); padding:.12em .4em; border-radius:5px; }
  pre { background:var(--code); padding:14px 16px; border-radius:10px; overflow:auto; } pre code { background:none; padding:0; }
  table { border-collapse:collapse; width:100%; margin:1.3em 0; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  th,td { border:1px solid var(--rule); padding:8px 11px; text-align:left; } th { background:#f1eee6; font-weight:650; }
  img { max-width:100%; border-radius:8px; } hr { border:none; border-top:1px solid var(--rule); margin:2.4em 0; }
</style></head>
<body>
  <article class="doc">
    <div class="doc-source">${htmlAttr(sourceRel || '')}</div>
    ${bodyHtml}
  </article>
  <script>window.__kbfMode="md";window.__kbfSource=${JSON.stringify(sourceRel || '').replace(/</g, '\\u003c')};</script>
</body></html>`;
}

// Strip active content from rendered Markdown. `--md` is often pointed at a file
// you didn't write (a report someone sent, a doc an agent generated), and the
// rendered page shares an origin with the comment API — so a <script> in the .md
// could silently POST comments an agent later implements. This removes the script
// execution vectors while leaving benign formatting HTML (<details>, <sub>,
// tables, links) intact. It is a defense-in-depth strip, not a full HTML
// sanitizer: still only open Markdown you broadly trust. Fenced/inline code is
// already escaped by `marked` (it renders as &lt;script&gt;), so these patterns
// only ever match real emitted tags, never quoted code samples.
function sanitizeRenderedHtml(html) {
  return String(html)
    // drop <script>/<style> elements and everything they contain
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // drop tags that can execute, frame, or redirect the page
    .replace(/<\/?(iframe|object|embed|base|meta|form|link)\b[^>]*>/gi, '')
    // strip inline event handlers:  onclick="…"  onerror='…'  onload=foo
    // ('/' counts as attribute whitespace in HTML5, so <img/onerror=…> too)
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, '')
    // neutralise javascript:/vbscript: URLs in href/src
    .replace(/\b(href|src)\s*=\s*"\s*(?:javascript|vbscript):[^"]*"/gi, '$1="#"')
    .replace(/\b(href|src)\s*=\s*'\s*(?:javascript|vbscript):[^']*'/gi, "$1='#'");
}

async function renderMd(file) {
  const marked = await ensureMarked();
  const src = await readFile(file, 'utf-8');
  const body = sanitizeRenderedHtml(marked.parse(src, { gfm: true, breaks: false }));
  return mdDocShell(path.basename(file), path.relative(CWD, file).split(path.sep).join('/'), body);
}

async function listMdFiles(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMdFiles(full, base)));
    else if (/\.md$/i.test(e.name)) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function renderMdIndex() {
  const files = await listMdFiles(MD_ROOT);
  // Percent-encode each segment so filenames with '#', '?' or '%' survive as
  // links (serveMd decodes the pathname back).
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const items = files.map((rel) => `<li><a href="/${htmlAttr(encPath(rel.replace(/\.md$/i, '')))}">${htmlAttr(rel)}</a></li>`).join('\n');
  const body = `<h1>Markdown files</h1><p>${files.length} document${files.length === 1 ? '' : 's'} to review.</p><ul>${items || '<li>(none found)</li>'}</ul>`;
  return mdDocShell('Markdown files', path.relative(CWD, MD_ROOT).split(path.sep).join('/') || '.', body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(injectHtml(html));
}

async function serveMd(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('400 — bad path'); }
  if (pathname === '/' || pathname === '') {
    if (MD_SINGLE) return sendHtml(res, await renderMd(MD_SINGLE));
    return sendHtml(res, await renderMdIndex());
  }
  let rel = pathname.replace(/^\/+/, '');
  if (!/\.md$/i.test(rel)) rel += '.md';
  const file = path.normalize(path.join(MD_ROOT, rel));
  if (!within(MD_ROOT, file) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — no such markdown file');
  }
  return sendHtml(res, await renderMd(file));
}

// Markdown marker stamping lives in lib/markers.mjs (unit-tested there:
// refuse-to-guess on zero/ambiguous matches, skip resolved+rejected, idempotent).

// ---------- request handler ----------
async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/__feedback/overlay.js') return serveAsset(res, path.join(PUBLIC_DIR, 'overlay.js'));
    if (url.pathname === '/__feedback/overlay.css') return serveAsset(res, path.join(PUBLIC_DIR, 'overlay.css'));
    // DNS-rebinding guard for the whole comment surface, reads included — a
    // rebound page could otherwise read the review data (API GETs, SSE stream).
    // The static overlay assets above stay public; they contain no data.
    if (url.pathname === '/__feedback/events' || url.pathname.startsWith('/__feedback/api')) {
      if (!hostAllowed(req)) return sendJSON(res, 403, { error: 'host not allowed' });
    }
    if (url.pathname === '/__feedback/events') return handleSSE(req, res);
    if (url.pathname.startsWith('/__feedback/api')) return handleApi(req, res, url);

    if (MD_MODE) {
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return serveMd(req, res, url);
    }
    if (PROXY) return proxyRequest(req, res);

    const file = await resolveStaticFile(url.pathname);
    if (!file) {
      const notFound = path.join(STATIC_DIR, '404.html');
      // Pass the status explicitly: writeHead()'s code wins over res.statusCode,
      // so setting the property here would still send the custom page as a 200.
      if (existsSync(notFound)) return serveStatic(res, notFound, 404);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — not found');
    }
    return serveStatic(res, file);
  } catch (err) {
    console.error('Request error:', err);
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — internal error');
  }
}

// ---------- banner ----------
function banner(scheme, ips, publicUrl) {
  const src = DEMO ? `demo site (throwaway copy: ${STATIC_DIR})`
    : MD_MODE ? `reviewing markdown: ${path.relative(CWD, MD_SINGLE || MD_ROOT) || '.'}`
    : PROXY ? `proxying ${PROXY}`
    : `serving ${path.relative(CWD, STATIC_DIR) || '.'}/`;
  const tag = publicUrl ? '  (secure tunnel — voice works anywhere)' : USE_HTTPS ? '  (HTTPS — voice works on phones)' : '';
  console.log(`\n  Feedback Studio${tag}`);
  console.log(`  ------------------------------------------`);
  console.log(`  Source           ->  ${src}`);
  console.log(`  On this computer ->  ${scheme}://localhost:${PORT}/`);
  if (publicUrl) {
    console.log(`  On your phone    ->  ${publicUrl}/   (any network — real cert, no warning)`);
  } else if (EXPOSE_LAN && ips.length) {
    console.log(`  On your phone    ->  ${scheme}://${ips[0]}:${PORT}/   (same Wi-Fi)`);
    ips.slice(1).forEach((ip) => console.log(`                       ${scheme}://${ip}:${PORT}/`));
  } else if (ips.length) {
    console.log(`  Phone/LAN        ->  off by default. Re-run with --tunnel (recommended) or --host 0.0.0.0.`);
  }
  console.log(`  Comments         ->  ${DEMO ? DATA_FILE : '.feedback/comments.json'}  (+ FEEDBACK.md, HOW-TO-PROCESS.md)`);
  if (!DEMO) {
    console.log(`  Agent setup      ->  optional: re-run with --seed-agents to teach CLAUDE.md / AGENTS.md the flow.`);
  }
  if (DEMO && args['no-seed']) {
    console.log(`\n  Starting empty — no comments yet. Press C, click anything, leave a comment;`);
    console.log(`  then let your agent process ${path.join(DATA_DIR, 'comments.json')}.`);
  } else if (DEMO) {
    console.log(`\n  3 comments are pre-seeded (one fix, one change, one improve) — and the page`);
    console.log(`  hides a couple more flaws to find. Press C, click anything, leave a comment;`);
    console.log(`  then let your agent process ${path.join(DATA_DIR, 'comments.json')}.`);
  }
  if (publicUrl) {
    console.log(`\n  The tunnel URL is public while the server runs — anyone with the link can`);
    console.log(`  view and comment. Ctrl+C closes it.`);
  } else if (USE_HTTPS) {
    console.log(`\n  Phone: the browser will warn the certificate isn't trusted (self-signed).`);
    console.log(`  Tap Advanced -> Proceed, then the mic / voice-to-text works.`);
    console.log(`  (Tip: --tunnel gives a real cert with no warning at all.)`);
  } else if (EXPOSE_LAN) {
    console.log(`\n  Phone can view + type + click over http. For VOICE on a phone use --tunnel (or --https).`);
  }
  console.log(`  Ctrl+C to stop.\n`);
}

// ---------- demo mode ----------
// Copy the bundled sample site into a temp dir, seed it with example comments
// (one per web type: fix / change / improve), and serve THAT. Everything —
// the page, .feedback/, any edits an agent makes while processing — lives in
// the throwaway copy, so the demo is safe to run inside any project.
async function setupDemo() {
  const src = path.join(__dirname, '..', 'demo');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'feedback-studio-demo-'));
  await cp(path.join(src, 'site'), tmp, { recursive: true });
  STATIC_DIR = tmp;
  DATA_DIR = path.join(tmp, '.feedback');
  DATA_FILE = path.join(DATA_DIR, 'comments.json');
  CERT_DIR = path.join(DATA_DIR, '.cert');
  // --no-seed serves the sample page with NO comments, for demoing the
  // "add your own" flow from scratch (e.g. recording a clean walkthrough).
  let seed = [];
  if (!args['no-seed']) {
    seed = JSON.parse(await readFile(path.join(src, 'seed-comments.json'), 'utf-8'));
    const now = new Date().toISOString();
    for (const c of seed) { c.createdAt = now; c.updatedAt = now; }
  }
  await writeComments(DATA_DIR, seed); // also generates the FEEDBACK.md mirror
  return tmp;
}

// ---------- agent-memory seeding (opt-in: --seed-agents) ----------
// Append the short processing workflow to the project's CLAUDE.md (Claude Code
// auto-loads it) and AGENTS.md (Codex/Cursor/Cline/Windsurf), idempotently. This
// edits user-owned files, so it only runs when explicitly asked, never on startup.
async function seedAgents() {
  console.log('');
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const fp = path.join(CWD, name);
    try {
      const { seeded, created } = await seedAgentsFile(fp);
      if (!seeded) console.log(`  ${name}  already has the Feedback Studio snippet — left as is.`);
      else console.log(`  ${name}  ${created ? 'created' : 'updated'} with the processing guide.`);
    } catch (e) {
      console.error(`  ${name}  could not be written: ${e.message}`);
    }
  }
  console.log(`\n  Your agent now knows to process .feedback/ comments on "process the feedback" (or PPF).\n`);
}

// ---------- main ----------
async function main() {
  if (args['seed-agents']) { await seedAgents(); return; }
  if (DEMO) await setupDemo();
  if (!PROXY && !MD_MODE && !STATIC_DIR) {
    console.error(`\n  No build directory found. Tried: ${AUTODETECT.join(', ')}.`);
    console.error(`  Build your site first, then pass --dir <folder>, or proxy a dev server with --proxy <url>.`);
    console.error(`  e.g.  feedback-studio --dir dist`);
    console.error(`        feedback-studio --proxy http://localhost:5173`);
    console.error(`  No site yet? Try the instant demo:  feedback-studio --demo\n`);
    process.exit(1);
  }
  await mkdir(DATA_DIR, { recursive: true });
  // Create the data file under the cross-process lock: a bare writeComments([])
  // here could clobber a concurrent MCP write between the existence check and
  // the write. The no-op mutate re-reads under the lock, so it creates-if-absent
  // and preserves whatever another process just wrote.
  if (!existsSync(DATA_FILE)) await mutate(DATA_DIR, (list) => ({ comments: list }));
  // Drop the self-contained processing guide next to the data (regenerated each run,
  // like FEEDBACK.md) so any agent — plugin or not — has the workflow on hand.
  await exportProcessInstructions(DATA_DIR).catch(() => {});

  const ips = lanIPs();
  populateAllowedHosts(ips);
  let server;
  if (USE_HTTPS) server = https.createServer(await getTlsOptions(ips), handler);
  else server = http.createServer(handler);

  if (PROXY) server.on('upgrade', proxyUpgrade);

  // Listen errors are fatal; connection-level errors are not.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Stop the other server or pass --port <n>.\n`);
    else console.error(err);
    process.exit(1);
  });
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} }
    for (const res of sseClients) { try { res.end(); } catch (e) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // don't hang on a stuck socket
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const scheme = USE_HTTPS ? 'https' : 'http';
  server.listen(PORT, HOST, async () => {
    watchComments();
    let publicUrl = null;
    if (TUNNEL) {
      try {
        const cf = await ensureCloudflared();
        console.log('  Opening a secure tunnel (real HTTPS, works on any network)...');
        publicUrl = await startTunnel(cf, PORT);
        try { ALLOWED_HOSTS.add(new URL(publicUrl).hostname.toLowerCase()); } catch (e) {}
      } catch (e) {
        console.error('\n  Tunnel failed: ' + e.message);
        console.error('  Serving locally instead. For phone voice without a tunnel: --https --host 0.0.0.0\n');
      }
    }
    banner(scheme, ips, publicUrl);
    if (!args['no-open']) openBrowser(`${scheme}://localhost:${PORT}/`);
  });
}

main();
