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
//   --port <n>       listen port (default 4444)
//   --https          serve over TLS with a self-signed cert (voice on phones)
//
// HTTP needs zero dependencies. --https fetches a tiny cert helper once.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const USE_HTTPS = !!args.https || process.env.HTTPS === '1';
const PROXY = args.proxy ? String(args.proxy).replace(/\/+$/, '') : null;

const CWD = process.cwd();
const DATA_DIR = path.join(CWD, '.feedback');
const DATA_FILE = path.join(DATA_DIR, 'comments.json');
const MD_FILE = path.join(DATA_DIR, 'FEEDBACK.md');
const CERT_DIR = path.join(DATA_DIR, '.cert');
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
const STATIC_DIR = PROXY ? null : resolveStaticDir();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

const INJECT = `\n<script src="/__feedback/overlay.js" defer></script>\n`;
function injectHtml(html) {
  if (html.includes('</body>')) return html.replace('</body>', INJECT + '</body>');
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
  execSync('npm install selfsigned@^5 --no-audit --no-fund --loglevel=error', { cwd: depsDir, stdio: 'inherit' });
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

// ---------- data ----------
async function loadComments() {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf-8'));
    return Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch (e) { return []; }
}
async function saveComments(comments) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), comments }, null, 2));
  await exportMarkdown(comments).catch((e) => console.error('MD export failed:', e.message));
}
function esc(s) { return String(s == null ? '' : s); }
async function exportMarkdown(comments) {
  const byPage = new Map();
  for (const c of comments) {
    const key = c.page || '/';
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(c);
  }
  const open = comments.filter((c) => c.status !== 'resolved').length;
  let md = `# Feedback export\n\n`;
  md += `_Generated ${new Date().toISOString()} — ${comments.length} comment(s): ${open} open, ${comments.length - open} resolved._\n\n`;
  md += `> Each comment has a TYPE that sets how much latitude you have: \`fix\` = reproduce and patch what is broken; \`change\` = apply near-verbatim, do not redesign; \`improve\` = rewrite or redesign with judgement. Each anchor carries a css selector, an attr/xpath fallback, and a quoted snippet so the element can be re-found. Resolve the element with confidence; if you cannot locate it confidently, do NOT edit a guess — flag it for a re-pin. Work the open items, then mark them resolved.\n\n`;
  for (const page of [...byPage.keys()].sort()) {
    const items = byPage.get(page).slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    md += `## \`${page}\`${items[0]?.pageTitle ? ` — ${items[0].pageTitle}` : ''}\n\n`;
    let i = 0;
    for (const c of items) {
      i++;
      const kind = c.anchor?.type === 'range' ? 'text selection' : (c.anchor?.tag || 'element');
      const type = ['fix', 'change', 'improve'].includes(c.type) ? c.type : 'change';
      md += `- ${c.status === 'resolved' ? '[x]' : '[ ]'} **#${i}** \`${type}\` — on a ${kind}\n`;
      const quote = (c.anchor?.snippet || c.anchor?.rangeText || '').trim().replace(/\s+/g, ' ');
      if (quote) md += `  - anchor text: "${esc(quote).slice(0, 200)}"\n`;
      if (c.anchor?.selector) md += `  - css: \`${esc(c.anchor.selector)}\`\n`;
      if (c.anchor?.attrSelector) md += `  - attr: \`${esc(c.anchor.attrSelector)}\`\n`;
      if (c.anchor?.xpath) md += `  - xpath: \`${esc(c.anchor.xpath)}\`\n`;
      md += `  - comment:\n${esc(c.text).trim().split('\n').map((l) => `    ${l}`).join('\n')}\n\n`;
    }
  }
  if (!comments.length) md += `_No comments yet._\n`;
  await writeFile(MD_FILE, md);
}

// ---------- helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function newId() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function safeJoin(root, urlPath) {
  const resolved = path.normalize(path.join(root, decodeURIComponent(urlPath.split('?')[0])));
  return resolved.startsWith(root) ? resolved : null;
}
async function resolveStaticFile(urlPath) {
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

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/__feedback\/api\/?/, '').split('/').filter(Boolean);
  const resource = parts[0] || '';
  if (resource === 'comments') {
    const id = parts[1];
    if (req.method === 'GET') return sendJSON(res, 200, { comments: await loadComments() });
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const comments = await loadComments();
      const now = new Date().toISOString();
      const type = ['fix', 'change', 'improve'].includes(body.type) ? body.type : 'change';
      const c = {
        id: newId(),
        schemaVersion: 2,
        page: body.page || '/',
        pageTitle: body.pageTitle || '',
        url: body.url || '',
        anchor: body.anchor || {},
        type,
        text: (body.text || '').trim(),
        autonomy: ['auto', 'review'].includes(body.autonomy) ? body.autonomy : 'review',
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      comments.push(c);
      await saveComments(comments);
      return sendJSON(res, 201, { comment: c });
    }
    if (req.method === 'PATCH' && id) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const comments = await loadComments();
      const c = comments.find((x) => x.id === id);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      if (typeof body.text === 'string') c.text = body.text.trim();
      if (typeof body.status === 'string') c.status = body.status;
      if (['fix', 'change', 'improve'].includes(body.type)) c.type = body.type;
      if (['auto', 'review'].includes(body.autonomy)) c.autonomy = body.autonomy;
      c.updatedAt = new Date().toISOString();
      await saveComments(comments);
      return sendJSON(res, 200, { comment: c });
    }
    if (req.method === 'DELETE' && id) {
      let comments = await loadComments();
      const before = comments.length;
      comments = comments.filter((x) => x.id !== id);
      if (comments.length === before) return sendJSON(res, 404, { error: 'not found' });
      await saveComments(comments);
      return sendJSON(res, 200, { ok: true });
    }
  }
  if (resource === 'export' && req.method === 'POST') {
    await exportMarkdown(await loadComments());
    return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

// ---------- asset + static serving ----------
async function serveAsset(res, file) {
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}
async function serveStatic(res, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(injectHtml(await readFile(file, 'utf-8')));
  } else {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  }
}

// ---------- proxy serving ----------
function proxyRequest(req, res) {
  const u = new URL(req.url, PROXY);
  const opts = {
    hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method,
    headers: { ...req.headers, host: u.host, 'accept-encoding': 'identity' },
  };
  const preq = http.request(opts, (pres) => {
    const ct = pres.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        // Route absolute upstream-origin URLs back through us, then inject the overlay.
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
  preq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Upstream error: ' + e.message + '\nIs the dev server running at ' + PROXY + ' ?'); });
  req.pipe(preq);
}

// Pass HMR / live-reload websockets straight through to the upstream dev server.
function proxyUpgrade(req, clientSocket, head) {
  const u = new URL(PROXY);
  const upstream = net.connect(Number(u.port) || 80, u.hostname, () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    upstream.write('\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
}

// ---------- live updates (Server-Sent Events) ----------
const sseClients = new Set();
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
}
function broadcastComments(comments) {
  const payload = 'event: comments\ndata: ' + JSON.stringify({ comments }) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
}
// Watch the data dir so external edits (the AI agent marking comments resolved)
// push live to any open overlay. Our own API writes hit the same file, so the
// overlay re-syncs after every change too.
function watchComments() {
  let timer = null;
  try {
    watch(DATA_DIR, (ev, fn) => {
      if (fn && !String(fn).startsWith('comments.json')) return;
      clearTimeout(timer);
      timer = setTimeout(async () => broadcastComments(await loadComments()), 120);
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

// ---------- request handler ----------
async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/__feedback/overlay.js') return serveAsset(res, path.join(PUBLIC_DIR, 'overlay.js'));
    if (url.pathname === '/__feedback/overlay.css') return serveAsset(res, path.join(PUBLIC_DIR, 'overlay.css'));
    if (url.pathname === '/__feedback/events') return handleSSE(req, res);
    if (url.pathname.startsWith('/__feedback/api')) return handleApi(req, res, url);

    if (PROXY) return proxyRequest(req, res);

    const file = await resolveStaticFile(url.pathname);
    if (!file) {
      const notFound = path.join(STATIC_DIR, '404.html');
      if (existsSync(notFound)) { res.statusCode = 404; return serveStatic(res, notFound); }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — not found in ' + STATIC_DIR);
    }
    return serveStatic(res, file);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 — ' + err.message);
  }
}

// ---------- banner ----------
function banner(scheme, ips) {
  const src = PROXY ? `proxying ${PROXY}` : `serving ${path.relative(CWD, STATIC_DIR) || '.'}/`;
  console.log(`\n  Feedback Studio${USE_HTTPS ? '  (HTTPS — voice works on phones)' : ''}`);
  console.log(`  ------------------------------------------`);
  console.log(`  Source           ->  ${src}`);
  console.log(`  On this computer ->  ${scheme}://localhost:${PORT}/`);
  if (ips.length) {
    console.log(`  On your phone    ->  ${scheme}://${ips[0]}:${PORT}/   (same Wi-Fi)`);
    ips.slice(1).forEach((ip) => console.log(`                       ${scheme}://${ip}:${PORT}/`));
  }
  console.log(`  Comments         ->  .feedback/comments.json  (+ FEEDBACK.md)`);
  if (USE_HTTPS) {
    console.log(`\n  Phone: the browser will warn the certificate isn't trusted (self-signed).`);
    console.log(`  Tap Advanced -> Proceed, then the mic / voice-to-text works.`);
  } else {
    console.log(`\n  Phone can view + type + click over http. For VOICE on a phone add --https.`);
  }
  console.log(`  Ctrl+C to stop.\n`);
}

// ---------- main ----------
async function main() {
  if (!PROXY && !STATIC_DIR) {
    console.error(`\n  No build directory found. Tried: ${AUTODETECT.join(', ')}.`);
    console.error(`  Build your site first, then pass --dir <folder>, or proxy a dev server with --proxy <url>.`);
    console.error(`  e.g.  feedback-studio --dir dist`);
    console.error(`        feedback-studio --proxy http://localhost:5173\n`);
    process.exit(1);
  }
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) await saveComments([]);

  const ips = lanIPs();
  let server;
  if (USE_HTTPS) server = https.createServer(await getTlsOptions(ips), handler);
  else server = http.createServer(handler);

  if (PROXY) server.on('upgrade', proxyUpgrade);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Stop the other server or pass --port <n>.\n`);
    else console.error(err);
    process.exit(1);
  });
  // Omit host so Node binds dual-stack (IPv6 + IPv4-mapped): covers localhost and LAN.
  server.listen(PORT, () => {
    banner(USE_HTTPS ? 'https' : 'http', ips);
    watchComments();
    if (!args['no-open']) openBrowser(`${USE_HTTPS ? 'https' : 'http'}://localhost:${PORT}/`);
  });
}

main();
