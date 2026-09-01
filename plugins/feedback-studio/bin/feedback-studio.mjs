#!/usr/bin/env node
// Feedback Studio — a local commenting overlay for any website.
//
// Serves a static build directory (or proxies a running dev server) and injects
// a commenting overlay into every HTML page. Comments (typed or spoken) attach
// to any DOM element or text selection and persist to .feedback/comments.json
// plus a readable FEEDBACK.md, ready for an agent to process.
//
// The flags live in the FLAGS list below, which is also what `--help` prints, so
// the two can never drift apart. Run `feedback-studio --help` to see them.
//
// HTTP needs zero dependencies. --https / --md fetch a tiny helper once.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, readdir, chmod, unlink, rename, utimes, mkdtemp, cp } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, watch, createReadStream, createWriteStream, unlinkSync, readdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED_TYPES, STATUSES, AUTONOMY, AUTHOR_HASH_RE, coerceRound,
  readComments, writeComments, writeJson, mutate, makeComment, makeReply, exportMarkdown,
  exportProcessInstructions, seedAgentsFile, sanitizeEdits, sanitizeTextEdit,
  coerceType, modeFor, schemeIsEvil, sanitizeImageReplace, sanitizeAnchor,
} from '../lib/store.mjs';
import { exportMarkers as stampMarkers } from '../lib/markers.mjs';
import {
  listVersions, readVersion as readHistoryVersion, diffVersions, recordSnapshot, latestVersion,
} from '../lib/history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- args ----------
// Every flag the server accepts, in one place: `--help` is printed from this
// list, an unknown flag is recognised against it, and the README table repeats
// the same names and the same one-line help.
const FLAGS = [
  { name: '--demo', arg: '', help: 'Serve the bundled sample page from a throwaway temp copy.' },
  { name: '--no-seed', arg: '', help: 'With --demo: start with no comments, so you add your own live.' },
  { name: '--dir', arg: '<path>', help: 'Serve a static build directory (auto-detected when left out).' },
  { name: '--proxy', arg: '<url>', help: 'Proxy a running dev server and inject the overlay (live reload).' },
  { name: '--spa', arg: '', help: 'Serve index.html for an unknown path that has no file extension.' },
  { name: '--md', arg: '<file|dir>', help: 'Render a Markdown file, or a folder of them, as pages you can review.' },
  { name: '--md-html', arg: '', help: 'With --md: render HTML written in the file (only for a document you trust).' },
  { name: '--label', arg: '<name>', help: 'Name this session, shown in the overlay so you can tell open tabs apart.' },
  { name: '--data-dir', arg: '<path>', help: "Where to store this session's .feedback data (default <cwd>/.feedback)." },
  { name: '--share', arg: '[strict]', help: 'Mint view / comment / admin links; "strict" asks this computer for a key too.' },
  { name: '--no-shots', arg: '', help: 'Turn off the element screenshot taken when you pin a comment.' },
  { name: '--port', arg: '<n>', help: 'Listen port (default 4444).' },
  { name: '--host', arg: '<addr>', help: 'Bind address (default 127.0.0.1; use 0.0.0.0 for your phone or LAN).' },
  { name: '--tunnel', arg: '', help: 'Public HTTPS address through a Cloudflare quick tunnel (real certificate).' },
  { name: '--https', arg: '', help: 'Serve over TLS with a self-signed certificate (voice on phones).' },
  { name: '--no-open', arg: '', help: "Don't open the browser automatically." },
  { name: '--seed-agents', arg: '', help: 'Append the processing workflow to ./CLAUDE.md and ./AGENTS.md, then exit.' },
  { name: '--stamp', arg: '', help: 'Write the open comments into their Markdown files as @FB markers, then exit.' },
  { name: '--help', arg: '', help: 'Show this help and exit.' },
  { name: '--version', arg: '', help: 'Print the version and exit.' },
];
const FLAG_NAMES = new Set(FLAGS.map((f) => f.name.slice(2)));

function usageText() {
  const label = (f) => f.name + (f.arg ? ' ' + f.arg : '');
  const width = Math.max(...FLAGS.map((f) => label(f).length));
  const lines = FLAGS.map((f) => '  ' + label(f).padEnd(width) + '  ' + f.help);
  return `\n  Usage: feedback-studio [options]\n\n${lines.join('\n')}\n`;
}

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
const rawArgv = process.argv.slice(2);
const args = parseArgs(rawArgv);

// The version comes from the plugin manifest, the same file the MCP server reads,
// so there is only ever one number to bump.
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

// --help and --version answer and leave: no server, no browser, no data dir.
// They run before every other check so they work from any folder.
if (rawArgv.includes('--help') || rawArgv.includes('-h')) { console.log(usageText()); process.exit(0); }
if (rawArgv.includes('--version') || rawArgv.includes('-v')) { console.log(readVersion()); process.exit(0); }
// A misspelled flag used to be accepted in silence and then ignored, so
// `--proxi http://localhost:5173` quietly served a static folder instead.
// Positional words are still fine; only unknown --flags stop us.
for (const key of Object.keys(args)) {
  if (key === '_' || FLAG_NAMES.has(key)) continue;
  console.error(`\n  unknown option --${key}`);
  console.error(usageText());
  process.exit(1);
}

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
if (DEMO && (args.proxy || args.md || args.dir || args['data-dir'])) {
  console.error('\n  --demo serves the bundled sample site in a throwaway temp dir; it cannot be combined with --dir, --proxy, --md or --data-dir.\n');
  process.exit(1);
}

// Markdown review mode: --md <file.md> or --md <dir-of-md>.
const MD_MODE = !!args.md;
// HTML written inside a .md is shown as text unless --md-html asks for it to be
// rendered. A file you were sent can carry a <script>, and the rendered page
// shares an address with the comment API, so text is the safer default.
const MD_HTML = !!args['md-html'];
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
// --data-dir: put THIS instance's data anywhere (default CWD/.feedback). Lets one
// repo run a feedback session per site, each with its own isolated .feedback dir.
if (args['data-dir'] && !args.demo) {
  DATA_DIR = path.resolve(CWD, String(args['data-dir']));
  DATA_FILE = path.join(DATA_DIR, 'comments.json');
  CERT_DIR = path.join(DATA_DIR, '.cert');
}
// --label: a human name for this instance ("Marketing"), shown in the overlay and
// written into the data dir + exports so the agent knows which site is which.
const LABEL = args.label ? String(args.label).replace(/[\r\n]+/g, ' ').slice(0, 60).trim() : '';
const GLOBAL_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.feedback-studio');
// Element screenshots at pin time (best-effort, lazy html-to-image). --no-shots turns them off.
const SHOTS = !args['no-shots'];

// ---------- share roles (capability links) ----------
// --share mints three capability keys at startup — view / comment / admin — and
// prints one link per role. Anyone opening a link gets that role via a cookie;
// the key itself is the capability (no accounts). Direct localhost requests
// keep full access so the solo loop and local agents stay frictionless;
// `--share strict` closes that bypass too (then even localhost needs a key —
// the auto-opened browser tab gets the admin one).
const SHARE = !!args.share;
const SHARE_STRICT = args.share === 'strict';
const SHARE_KEYS = SHARE ? {
  view: 'sv_' + crypto.randomBytes(15).toString('base64url'),
  comment: 'sc_' + crypto.randomBytes(15).toString('base64url'),
  admin: 'sa_' + crypto.randomBytes(15).toString('base64url'),
} : null;

function tokenRole(tok) {
  if (!SHARE || !tok) return null;
  for (const [role, key] of Object.entries(SHARE_KEYS)) {
    const a = Buffer.from(String(tok));
    const b = Buffer.from(key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return role;
  }
  return null;
}
function cookieKey(req) {
  const m = /(?:^|;\s*)kbf-key=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return '';
  // A malformed percent-escape must not 500 the whole feedback request — treat
  // an undecodable cookie as absent (no key).
  try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
}
// Remove the kbf-key capability from a Cookie header before it leaves for the
// upstream: the share key is OURS, never the proxied app's, and forwarding it
// would hand the (possibly admin) capability to the dev server (cf. the
// cookie-to-proxy leak class, CVE-2026-5119). Returns the remaining cookies.
function stripKbfCookie(cookie) {
  if (!cookie) return cookie;
  const kept = String(cookie).split(/;\s*/).filter((c) => c && !/^kbf-key=/i.test(c));
  return kept.join('; ');
}
// "Local direct" = loopback socket AND a loopback Host header. The Host check
// matters: tunnel traffic arrives via the local cloudflared daemon (loopback
// socket!) but carries the public tunnel hostname — it must NOT bypass auth.
function isLocalDirect(req) {
  const a = req.socket.remoteAddress || '';
  if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') return false;
  const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
}
// 'full' (share off, or trusted local), 'admin' | 'comment' | 'view', or null.
function roleFor(req, url) {
  if (!SHARE) return 'full';
  if (!SHARE_STRICT && isLocalDirect(req)) return 'full';
  return tokenRole((url && url.searchParams.get('key')) || cookieKey(req));
}

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
// --spa: a built single-page app routes /about in the browser, so there is no
// about.html on disk. With the flag on, a path with no file extension that
// matches no file gets index.html (and its overlay) instead of a 404.
const SPA = !!args.spa;

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

// The overlay is a set of ES modules (public/overlay/*.mjs); `type="module"`
// scripts run after the page is parsed, the same timing `defer` gave before.
const INJECT = `\n<script type="module" src="/__feedback/overlay.js"></script>\n`;
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

// ---------- element screenshots: lazy browser library (html-to-image) ----------
// Same lazy-dep pattern as selfsigned/marked, but the consumer is the BROWSER:
// the overlay dynamic-imports the package's ESM build through the /vendor route
// below. Nothing installs until the first capture is attempted, so tests/CI and
// users who never pin a comment pay nothing; failure just means no screenshots.
const HTI_DIR = path.join(GLOBAL_DATA, 'deps', 'node_modules', 'html-to-image');
let _htiInstall = null; // in-flight install (dedupes concurrent first requests)
function ensureHtmlToImage() {
  if (existsSync(path.join(HTI_DIR, 'package.json'))) return Promise.resolve(true);
  if (_htiInstall) return _htiInstall;
  const depsDir = path.join(GLOBAL_DATA, 'deps');
  _htiInstall = (async () => {
    console.log('  Setting up element screenshots (one-time download of html-to-image)...');
    await mkdir(depsDir, { recursive: true });
    if (!existsSync(path.join(depsDir, 'package.json'))) {
      await writeFile(path.join(depsDir, 'package.json'), '{"name":"feedback-studio-deps","private":true}');
    }
    await new Promise((resolve, reject) => {
      // --ignore-scripts blocks install-time lifecycle scripts (supply-chain hardening).
      exec('npm install html-to-image@^1 --no-audit --no-fund --ignore-scripts --loglevel=error',
        { cwd: depsDir, timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
    });
    return existsSync(path.join(HTI_DIR, 'package.json'));
  })().catch((e) => {
    console.log('  (element screenshots unavailable — npm install failed: ' + e.message + ')');
    _htiInstall = null; // allow a retry on a later request
    return false;
  });
  return _htiInstall;
}

// Serve files out of the installed html-to-image package (its ESM build uses
// relative imports, so the whole package dir is exposed — .js/.mjs only, path
// containment enforced).
async function serveVendorHti(res, url) {
  const notFound = (msg) => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  if (!SHOTS) return notFound('screenshots disabled (--no-shots)');
  if (!(await ensureHtmlToImage())) return notFound('html-to-image unavailable');
  const rel = decodeURIComponent(url.pathname.slice('/__feedback/vendor/html-to-image/'.length));
  let file = path.resolve(HTI_DIR, rel);
  // Containment BEFORE anything is added to the path, so the check can never be
  // read against a name we changed afterwards.
  if (!file.startsWith(HTI_DIR + path.sep)) return notFound('not found');
  // The package's ES build imports its own parts with no file extension
  // (`import { cloneNode } from './clone-node'`). A bundler fills that in; a
  // browser does not, so it asks us for the bare name and used to get a 404 —
  // which meant no element screenshots at all. Add the extension the bundler
  // would have added. Only for a path that has none: a request for a .json or a
  // .map is still refused by the check below.
  if (!path.extname(file)) file += '.js';
  if (!/\.(js|mjs)$/.test(file) || !existsSync(file) || !statSync(file).isFile()) {
    return notFound('not found');
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });
  res.end(readFileSync(file));
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

const BODY_LIMIT = 1_000_000; // 1 MB default
// The media route accepts up to 3 MB of DECODED image; its JSON body carries
// that as base64 (×4/3) plus envelope, so it needs its own higher cap.
const MEDIA_BODY_LIMIT = 5_000_000;
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
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
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
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

// Comment ids are `c_<uuid>` from newId(); anything else must never reach the
// filesystem as a shots/<id>.png path.
const SAFE_SHOT_ID = /^c_[A-Za-z0-9-]{8,64}$/;

// ---------- who left this comment (share links, no accounts) ----------
// A browser on a share link makes one random author token for itself and sends
// it as `X-Feedback-Author` on every write. We store only its SHA-256, so the
// file never holds the token, and we never send the hash back out — that pair is
// what lets a person fix a typo in their own comment without an account, and
// stops anyone else editing it. The token shape is fixed so a junk header can
// never become a hash that happens to match something.
const AUTHOR_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
function authorTokenHash(req) {
  const tok = String(req.headers['x-feedback-author'] || '');
  if (!AUTHOR_TOKEN_RE.test(tok)) return '';
  return crypto.createHash('sha256').update(tok).digest('hex');
}
// Compare in constant time. Both sides are checked for shape first: a stored
// value that is missing or malformed is simply not a match, and timingSafeEqual
// throws outright on a length mismatch.
function authorMatches(hash, stored) {
  if (!hash || typeof stored !== 'string' || !AUTHOR_HASH_RE.test(stored)) return false;
  const a = Buffer.from(hash);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// The shape of a comment as it leaves this process — over the API, over the SSE
// stream, anywhere. `authorHash` stays on disk and never travels: handing it
// back would let anyone holding a copy of the data claim a comment as theirs.
function publicComment(c) {
  if (!c || typeof c !== 'object') return c;
  const { authorHash, ...rest } = c;
  return rest;
}

// Staged replacement images (raster only). Stored as media/<id>.<ext>.
const MEDIA_EXTS = ['png', 'jpg', 'webp'];
const mediaMime = (f) => (f.endsWith('.webp') ? 'image/webp' : f.endsWith('.png') ? 'image/png' : 'image/jpeg');
// Remove any staged image for a comment id (only one ever exists, but the format
// can change between saves). SAFE_SHOT_ID-checked by every caller. keepExt lets a
// successful write drop only the OTHER-format leftovers, never its own new file.
async function gcMedia(id, keepExt) {
  for (const ext of MEDIA_EXTS) {
    if (ext === keepExt) continue;
    await unlink(path.join(DATA_DIR, 'media', id + '.' + ext)).catch(() => {});
  }
}
// Validate BOTH ends of the file, not just the leading magic bytes — a real
// header with attacker bytes appended (e.g. PNG + <script>) would otherwise ride
// to disk and be copied into the repo by the agent. The client always produces
// well-formed images (canvas.toBlob), so legitimate uploads pass.
function validImageBuffer(fmt, b) {
  const n = b.length;
  if (fmt === 'png') {
    if (n < 8 || b.readUInt32BE(0) !== 0x89504e47) return false;
    // must end with the IEND chunk: "IEND" + CRC 0xAE426082
    return n >= 12 && b.toString('latin1', n - 8) === 'IEND\xae\x42\x60\x82';
  }
  if (fmt === 'jpeg') {
    if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return false;
    return b[n - 2] === 0xff && b[n - 1] === 0xd9; // EOI, no trailing junk
  }
  if (fmt === 'webp') {
    if (n < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return false;
    return b.readUInt32LE(4) === n - 8; // declared RIFF size covers exactly the rest
  }
  return false;
}

// ---------- watching the reviewed Markdown source ----------
// In --md mode the reviewed file is a file on disk that the agent is about to
// edit. Keeping a copy of it every time it changes is what lets the reviewer see
// what the agent did to their document, and put it back if they do not like it.
// The store itself lives in lib/history.mjs; this is the watching and the
// telling-the-page part.
//
// One watch per directory, not per file (a directory watch is one handle and
// picks up a file that is created later), and not recursive: Node 18 on Linux
// has no recursive watch.
const SOURCE_DEBOUNCE_MS = 300;
const watchedSourceDirs = new Set();
const sourceTimers = new Map();

// The exact path form comments and history use: relative to the folder the
// server runs in, forward slashes.
const relFromCwd = (file) => path.relative(CWD, file).split(path.sep).join('/');

function broadcastSource(file, version) {
  const payload = 'event: source\ndata: ' + JSON.stringify({
    file, version: version.n, added: version.added, removed: version.removed,
  }) + '\n\n';
  for (const res of [...sseClients]) writeSse(res, payload);
}

async function onSourceChanged(rel, full) {
  try {
    const content = await readFile(full, 'utf-8');
    // Which comments were marked done since the last copy: that is what this
    // change is most likely to be about.
    const prev = await latestVersion(DATA_DIR, rel);
    const since = prev && prev.at ? Date.parse(prev.at) : 0;
    let resolved = [];
    try {
      resolved = (await readComments(DATA_DIR))
        .filter((c) => c.sourceFile === rel && c.status === 'resolved' && Date.parse(c.updatedAt || 0) > since)
        .map((c) => c.id);
    } catch (e) { /* unreadable comments must not stop us keeping the copy */ }
    const out = await recordSnapshot(DATA_DIR, rel, content, {
      reason: 'changed',
      commentId: agentStatus.state === 'working' ? agentStatus.commentId : '',
      resolved,
    });
    if (out.changed) broadcastSource(rel, out.version);
  } catch (e) { /* the file may be half-written or gone; the next event picks it up */ }
}

function watchSourceDir(dir) {
  if (!MD_MODE || watchedSourceDirs.has(dir)) return;
  watchedSourceDirs.add(dir);
  try {
    watch(dir, (ev, fn) => {
      const name = fn ? String(fn) : '';
      if (!/\.md$/i.test(name)) return;
      const full = path.join(dir, name);
      const rel = relFromCwd(full);
      // An editor saves in several steps; wait for it to settle.
      clearTimeout(sourceTimers.get(rel));
      sourceTimers.set(rel, setTimeout(() => { sourceTimers.delete(rel); onSourceChanged(rel, full); }, SOURCE_DEBOUNCE_MS));
    });
  } catch (e) { /* no watch on this platform; the history routes still work */ }
}

// Called for every .md page we serve: start watching its folder, and take the
// first copy if this file has no history yet, so there is always something to
// compare against.
async function noteSourceServed(rel, file, content) {
  watchSourceDir(path.dirname(file));
  try {
    const { versions } = await listVersions(DATA_DIR, rel);
    if (!versions.length) await recordSnapshot(DATA_DIR, rel, content, { reason: 'opened' });
  } catch (e) { /* history is a convenience — never let it stop a page being served */ }
}

// `file` as a request gives it, resolved against the folder the server runs in
// and refused unless it stays inside that folder or the --md root.
function resolveSourceFile(raw) {
  const rel = typeof raw === 'string' ? raw : '';
  if (!rel || rel.length > 500) return null;
  const full = path.normalize(path.resolve(CWD, rel));
  const roots = MD_ROOT ? [CWD, MD_ROOT] : [CWD];
  if (!roots.some((r) => within(r, full))) return null;
  return { rel: relFromCwd(full), full };
}

// ---------- review rounds ----------
// A review runs in rounds: the person comments, the agent applies, the person
// looks again. The current round is stamped on every new comment, so FEEDBACK.md
// and the panel can show what was asked this time apart from what came before.
// It belongs to the review, not to this process, so it lives in meta.json beside
// the comments and survives a restart.
let currentRound = 1;
let roundStartedAt = new Date().toISOString();
const metaFile = () => path.join(DATA_DIR, 'meta.json');

async function readMeta() {
  try { return JSON.parse(await readFile(metaFile(), 'utf-8')) || {}; }
  catch (e) { return {}; }
}
async function loadRound() {
  const m = await readMeta();
  if (m.round !== undefined) currentRound = coerceRound(m.round);
  roundStartedAt = isoOr(m.roundStartedAt, roundStartedAt);
}
// Read-modify-write, so bumping the round keeps everything else meta.json holds.
async function persistRound() {
  const prev = await readMeta();
  await writeJson(metaFile(), { ...prev, round: currentRound, roundStartedAt }).catch(() => {});
}

// ---------- trash (so a delete can be undone) ----------
// Deleting a comment used to remove its screenshot and its staged replacement
// image at once, which made the overlay's undo a half-undo: the comment came
// back, the pictures did not. They are moved here instead. The subfolder is
// kept — shots/<id>.png and media/<id>.png share a filename, and a flat trash
// would have one overwrite the other.
const TRASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const trashDir = (kind) => path.join(DATA_DIR, 'trash', kind);

async function moveAside(kind, name) {
  const from = path.join(DATA_DIR, kind, name);
  if (!existsSync(from)) return false;
  const to = path.join(trashDir(kind), name);
  await mkdir(trashDir(kind), { recursive: true });
  // A file we cannot move is removed, as before: leaving it in place would show
  // the picture of a comment that no longer exists.
  try { await rename(from, to); } catch (e) { await unlink(from).catch(() => {}); return false; }
  // Stamp it with the time it was thrown away. A rename keeps the original
  // timestamp, so without this a screenshot taken yesterday would be pruned by
  // the very same request that trashed it — losing the pictures of exactly the
  // comment the undo is for.
  const now = Date.now() / 1000;
  await utimes(to, now, now).catch(() => {});
  return true;
}
async function bringBack(kind, name) {
  const from = path.join(trashDir(kind), name);
  if (!existsSync(from)) return false;
  await mkdir(path.join(DATA_DIR, kind), { recursive: true });
  try { await rename(from, path.join(DATA_DIR, kind, name)); return true; }
  catch (e) { return false; }
}
// Undo is a matter of seconds, so a day is generous. Run on each delete, which
// is the only thing that puts files here.
async function pruneTrash() {
  for (const kind of ['shots', 'media']) {
    let names = [];
    try { names = await readdir(trashDir(kind)); } catch (e) { continue; }
    for (const n of names) {
      const f = path.join(trashDir(kind), n);
      try { if (Date.now() - (await stat(f)).mtimeMs > TRASH_MAX_AGE_MS) await unlink(f); } catch (e) {}
    }
  }
}

// ---------- restoring a comment (PUT) ----------
// A timestamp is kept only when it is really an ISO instant, byte for byte;
// anything else becomes the time of the restore.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoOr = (v, fallback) => (typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : fallback);
const REPLY_ID_RE = /^r_[A-Za-z0-9-]{8,64}$/;
const THREAD_MAX = 200;
// Every reply is rebuilt through makeReply, so a restore re-runs the same
// sanitizers a fresh reply goes through. Its id and time are kept when they are
// well-formed, so the conversation reads exactly as it did.
function restoreThread(thread) {
  if (!Array.isArray(thread)) return [];
  const out = [];
  for (const entry of thread.slice(0, THREAD_MAX)) {
    if (!entry || typeof entry !== 'object') continue;
    const r = makeReply(entry);
    if (REPLY_ID_RE.test(String(entry.id || ''))) r.id = entry.id;
    r.createdAt = isoOr(entry.createdAt, r.createdAt);
    out.push(r);
  }
  return out;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/__feedback\/api\/?/, '').split('/').filter(Boolean);
  const resource = parts[0] || '';
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && crossSite(req)) return sendJSON(res, 403, { error: 'cross-site request blocked' });
  // (The Host allowlist + share-key authentication are enforced for the whole
  // /__feedback surface in handler(), before this function is reached.)
  // Role authorization per route: view = read-only; comment = may add comments,
  // replies and shots; admin/full = everything (statuses, edits, deletes, exports).
  const role = req._kbfRole || 'full';
  const canComment = role !== 'view';
  const canManage = role === 'full' || role === 'admin';
  const deny = () => sendJSON(res, 403, { error: 'your share link does not allow this' });
  // The browser's own author token (share links only), hashed. Empty when the
  // header is absent or malformed.
  const authorHash = authorTokenHash(req);
  // A reviewer on a comment link may change their OWN comment, and only while it
  // is still open — once the host side has acted on it, it is part of the record.
  const ownsAndOpen = (c) => role === 'comment' && authorMatches(authorHash, c.authorHash) && c.status === 'open';
  // Implicit heartbeat: the agent's own calls (its poll loop, replies, PATCHes)
  // prove it is alive — no separate heartbeat discipline needed from an LLM.
  const fromAgent = canManage && isAgentRequest(req);
  if (fromAgent && resource !== 'agent-status' && resource !== 'activity') touchPresence();

  try {
    if (resource === 'comments') {
      const id = parts[1];
      if (req.method === 'GET') {
        return sendJSON(res, 200, { comments: (await readComments(DATA_DIR)).map(publicComment), round: currentRound });
      }

      // POST /comments/:id/reply — add a message to a comment's conversation thread
      if (req.method === 'POST' && id && parts[2] === 'reply') {
        if (!canComment) return deny();
        const body = await readJson(req);
        // Variants carry HTML that other viewers' overlays inject into the page:
        // proposing them is the host/agent side's privilege. Picking one is not.
        if (body.variants && !canManage) return deny();
        const out = await mutate(DATA_DIR, (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          if (!Array.isArray(c.thread)) c.thread = [];
          // The agent voice belongs to the host side (full/admin — the local
          // agent runs keyless as 'full'; MCP hard-codes it). A share-link
          // reviewer claiming author:"agent" would render with the agent's
          // visual authority and export "by agent" — downgrade, don't trust.
          const reply = makeReply({ author: canManage ? body.author : 'user', authorName: body.authorName, text: body.text, variants: body.variants, pick: body.pick });
          c.thread.push(reply);
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c, reply } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        if (fromAgent && out.reply.author === 'agent') {
          const t = String(out.reply.text || '');
          const line = out.reply.variants ? 'proposed variants' : 'replied: ' + t.slice(0, 120);
          // "Queued — I'll show you…" parks the item; any other answer finishes it.
          const finishes = !/\bqueued\b/i.test(t) && !out.reply.variants && agentStatus.state === 'working' && agentStatus.commentId === id;
          if (finishes) releasePresence(id, line, 'reply');
          else logActivity({ kind: 'reply', commentId: id, text: line });
        }
        return sendJSON(res, 201, { ...out, comment: publicComment(out.comment) });
      }

      if (req.method === 'POST' && !id) {
        if (!canComment) return deny();
        const body = await readJson(req);
        const comment = await mutate(DATA_DIR, (list) => {
          // Same rule as replies: only full/admin may author as the agent.
          const c = makeComment(canManage ? body : { ...body, author: 'user' });
          // Set here, never from the body: makeComment ignores an input
          // authorHash on purpose, so a client cannot claim someone else's.
          if (authorHash) c.authorHash = authorHash;
          c.round = currentRound; // a new comment always belongs to the round we are in

          list.push(c);
          return { comments: list, value: c };
        });
        broadcastSoon();
        return sendJSON(res, 201, { comment: publicComment(comment) });
      }

      if (req.method === 'PATCH' && id) {
        const body = await readJson(req);
        // Below admin: the only allowed PATCH is a person tidying up their own
        // still-open comment, and only its wording and type. Anything else in
        // the body is ignored rather than refused — the request is legitimate,
        // those fields simply are not theirs to set. Checked on a plain read
        // first so a refusal never rewrites the file.
        if (!canManage) {
          const found = (await readComments(DATA_DIR)).find((x) => x.id === id);
          if (!found) return sendJSON(res, 404, { error: 'not found' });
          if (!ownsAndOpen(found)) return deny();
          let refused = false;
          const own = await mutate(DATA_DIR, (list) => {
            const c = list.find((x) => x.id === id);
            if (!c) return { comments: list, value: { notFound: true } };
            // Re-checked under the lock: the status may have moved on since the read.
            if (!ownsAndOpen(c)) { refused = true; return { comments: list, value: {} }; }
            if (typeof body.text === 'string') c.text = body.text.trim().slice(0, 10000);
            if (ALLOWED_TYPES.includes(body.type)) c.type = coerceType(body.type, modeFor(c.sourceFile));
            c.updatedAt = new Date().toISOString();
            return { comments: list, value: { comment: c } };
          });
          if (refused) return deny();
          if (own.notFound) return sendJSON(res, 404, { error: 'not found' });
          broadcastSoon();
          return sendJSON(res, 200, { comment: publicComment(own.comment) });
        }
        let clearedMedia = false; // a cleared imageReplace orphans its staged file — GC it below
        const out = await mutate(DATA_DIR, (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          if (typeof body.text === 'string') c.text = body.text.trim().slice(0, 10000);
          if (Array.isArray(body.edits) && !c.sourceFile) c.edits = sanitizeEdits(body.edits);
          if ('textEdit' in body) c.textEdit = sanitizeTextEdit(body.textEdit);
          if ('imageReplace' in body && !c.sourceFile) {
            // preserve the server-set media path across a metadata re-save
            const media = c.imageReplace && c.imageReplace.media;
            c.imageReplace = sanitizeImageReplace(body.imageReplace);
            if (c.imageReplace && media) c.imageReplace.media = media;
            // clearing the replacement drops the pointer — GC the staged file too
            else if (!c.imageReplace && media) clearedMedia = true;
          }
          // Re-pin: the overlay rebuilds the anchor from a freshly clicked
          // element when the stored one resolves shakily (or not at all).
          if (body.anchor && typeof body.anchor === 'object') c.anchor = sanitizeAnchor(body.anchor);
          if (STATUSES.includes(body.status)) c.status = body.status;
          // Coerce a recognized type to the comment's own mode (web vs md) so a
          // PATCH can't put a Markdown verb on a web comment or vice-versa — the
          // same rule makeComment applies. Unknown types are ignored, as before.
          if (ALLOWED_TYPES.includes(body.type)) c.type = coerceType(body.type, modeFor(c.sourceFile));
          if (AUTONOMY.includes(body.autonomy)) c.autonomy = body.autonomy;
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        if (clearedMedia && SAFE_SHOT_ID.test(id)) await gcMedia(id); // drop the now-orphaned staged image
        broadcastSoon();
        if (fromAgent && STATUSES.includes(body.status) && body.status !== 'open') {
          if (body.status === 'resolved' || body.status === 'rejected') {
            // One line per event: the release logs "done · took 2m" for the
            // claimed comment; anything else gets a plain "resolved" line.
            if (agentStatus.state === 'working' && agentStatus.commentId === id) releasePresence(id, body.status);
            else logActivity({ kind: 'resolve', commentId: id, text: body.status });
          }
        }
        return sendJSON(res, 200, { ...out, comment: publicComment(out.comment) });
      }

      // PUT /comments/:id — put a deleted comment back the way it was (the
      // overlay's undo). The body is a comment this API handed out earlier, but
      // it has been out of our hands since, so it is rebuilt through makeComment
      // and only the fields that are safe to carry are copied over it. Every
      // field that names a file is set from what is actually on disk, never from
      // the body: a restore must not be able to point a comment at a file the
      // person sending it should not be able to read.
      if (req.method === 'PUT' && id) {
        if (!canManage) return deny();
        if (!SAFE_SHOT_ID.test(id)) return sendJSON(res, 400, { error: 'bad id' });
        const body = await readJson(req);
        // Its pictures are probably in the trash from the delete. Fetch them
        // back FIRST, so the checks below see the files they are asking about.
        await bringBack('shots', id + '.png');
        await bringBack('shots', id + '-after.png');
        for (const ext of MEDIA_EXTS) await bringBack('media', id + '.' + ext);

        const c = makeComment(body); // re-sanitizes text, anchor, type, edits, imageReplace, via
        c.id = id;
        c.createdAt = isoOr(body.createdAt, c.createdAt);
        c.updatedAt = isoOr(body.updatedAt, c.updatedAt);
        if (STATUSES.includes(body.status)) c.status = body.status;
        c.round = coerceRound(body.round);
        c.thread = restoreThread(body.thread);
        if (existsSync(path.join(DATA_DIR, 'shots', id + '.png'))) c.shot = 'shots/' + id + '.png';
        if (existsSync(path.join(DATA_DIR, 'shots', id + '-after.png'))) c.shotAfter = 'shots/' + id + '-after.png';
        // Only the format is read off the body; the name is always the comment id.
        const claimed = body.imageReplace && typeof body.imageReplace === 'object' ? String(body.imageReplace.media || '') : '';
        const ext = MEDIA_EXTS.find((e) => claimed === 'media/' + id + '.' + e);
        if (c.imageReplace && ext && existsSync(path.join(DATA_DIR, 'media', id + '.' + ext))) {
          c.imageReplace.media = 'media/' + id + '.' + ext;
        }
        const comment = await mutate(DATA_DIR, (list) => {
          const at = list.findIndex((x) => x.id === id);
          if (at >= 0) list[at] = c; else list.push(c);
          return { comments: list, value: c };
        });
        broadcastSoon();
        return sendJSON(res, 200, { comment: publicComment(comment) });
      }

      if (req.method === 'DELETE' && id) {
        // Same rule as PATCH: a reviewer may take back their own comment while
        // it is still open, nothing else.
        if (!canManage) {
          const found = (await readComments(DATA_DIR)).find((x) => x.id === id);
          if (!found) return sendJSON(res, 404, { error: 'not found' });
          if (!ownsAndOpen(found)) return deny();
        }
        let refusedDelete = false;
        const out = await mutate(DATA_DIR, (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          // Re-checked under the lock: the status may have moved on since the read.
          if (!canManage && !ownsAndOpen(c)) { refusedDelete = true; return { comments: list, value: {} }; }
          return { comments: list.filter((x) => x.id !== id), value: { ok: true } };
        });
        if (refusedDelete) return deny();
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        if (SAFE_SHOT_ID.test(id)) {
          // Moved aside rather than destroyed, so PUT can bring the whole
          // comment back — pictures included. Old trash is cleared as we go.
          await moveAside('shots', id + '.png');       // the pin-time screenshot
          await moveAside('shots', id + '-after.png'); // …and the "after" one
          for (const ext of MEDIA_EXTS) await moveAside('media', id + '.' + ext);
          await pruneTrash();
        }
        broadcastSoon();
        return sendJSON(res, 200, { ok: true });
      }
    }

    // Element screenshot captured at pin time — visual ground truth of what the
    // reviewer saw. Best-effort: nothing in the comment lifecycle depends on it.
    if (resource === 'shot' && parts[1]) {
      const id = parts[1];
      if (!SAFE_SHOT_ID.test(id)) return sendJSON(res, 400, { error: 'bad id' });
      // ?after=1 is the second picture: the same element once the change has
      // landed, so the two can be shown side by side. Same route, same checks,
      // its own file and its own field on the comment.
      const after = ['1', 'true'].includes(url.searchParams.get('after'));
      const shotPath = 'shots/' + id + (after ? '-after' : '') + '.png';
      const file = path.join(DATA_DIR, shotPath);
      if (req.method === 'GET') {
        if (!existsSync(file)) return sendJSON(res, 404, { error: 'no shot' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(file));
      }
      if (req.method === 'POST') {
        if (!canComment) return deny();
        if (!SHOTS) return sendJSON(res, 404, { error: 'screenshots disabled' });
        const body = await readJson(req);
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
        if (!m) return sendJSON(res, 400, { error: 'expected a PNG data URL' });
        const buf = Buffer.from(m[1], 'base64');
        // magic bytes: a real PNG, not something else wearing the MIME type
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return sendJSON(res, 400, { error: 'not a PNG' });
        if (buf.length > 600_000) return sendJSON(res, 413, { error: 'image too large' });
        const out = await mutate(DATA_DIR, async (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          await mkdir(path.join(DATA_DIR, 'shots'), { recursive: true });
          await writeFile(file, buf);
          if (after) c.shotAfter = shotPath; else c.shot = shotPath;
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        return sendJSON(res, 200, { ...out, comment: publicComment(out.comment) });
      }
    }

    // Replacement image staged for an <img>/background element — the reviewer's
    // chosen file, already downscaled client-side. Kept in .feedback/media/ until
    // the agent moves it into the repo's image folder. Raster only (no SVG: it
    // can carry script). Filename is the comment id, like screenshots.
    if (resource === 'media' && parts[1]) {
      const id = parts[1];
      if (!SAFE_SHOT_ID.test(id)) return sendJSON(res, 400, { error: 'bad id' });
      if (req.method === 'GET') {
        const found = MEDIA_EXTS.map((ext) => path.join(DATA_DIR, 'media', id + '.' + ext)).find((f) => existsSync(f));
        if (!found) return sendJSON(res, 404, { error: 'no media' });
        // nosniff: never let a browser second-guess the declared image type.
        res.writeHead(200, { 'Content-Type': mediaMime(found), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(found));
      }
      if (req.method === 'POST') {
        if (!canComment) return deny();
        const body = await readJson(req, MEDIA_BODY_LIMIT); // base64 of up to 3 MB decoded
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
        if (!m) return sendJSON(res, 400, { error: 'expected a png/jpeg/webp data URL' });
        const fmt = m[1];
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 3_000_000) return sendJSON(res, 413, { error: 'image too large' });
        // header AND trailer must match the declared format — no appended payload
        if (!validImageBuffer(fmt, buf)) return sendJSON(res, 400, { error: 'not a valid ' + fmt + ' image' });
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const file = path.join(DATA_DIR, 'media', id + '.' + ext);
        const out = await mutate(DATA_DIR, async (list) => {
          const c = list.find((x) => x.id === id);
          if (!c) return { comments: list, value: { notFound: true } };
          await mkdir(path.join(DATA_DIR, 'media'), { recursive: true });
          await writeFile(file, buf);       // write the new file first…
          await gcMedia(id, ext);           // …then drop only stale other-format leftovers
          c.imageReplace = c.imageReplace && typeof c.imageReplace === 'object' ? c.imageReplace : {};
          c.imageReplace.media = 'media/' + id + '.' + ext;
          c.updatedAt = new Date().toISOString();
          return { comments: list, value: { comment: c } };
        });
        if (out.notFound) return sendJSON(res, 404, { error: 'not found' });
        broadcastSoon();
        return sendJSON(res, 200, { ...out, comment: publicComment(out.comment) });
      }
    }
    // Watch-mode presence: an agent announces itself (online / working / offline)
    // so open overlays can show "agent is here" live. In-memory only — presence
    // is ephemeral by nature; the overlay ages it out if heartbeats stop.
    // Deliberately SINGLE-agent (last write wins): one watching agent per
    // session is the v1 model; a second watcher's heartbeat replaces the chip.
    if (resource === 'agent-status') {
      if (req.method === 'GET') return sendJSON(res, 200, { agent: agentStatus, activity: canManage ? activityLog : publicActivity(activityLog) });
      if (req.method === 'POST') {
        if (!canManage) return deny(); // presence is the host agent's voice, not a reviewer's
        const body = await readJson(req);
        setPresence(body);
        return sendJSON(res, 200, { agent: agentStatus });
      }
    }
    // A line in the activity log ("edited src/Header.jsx", "verifying…") —
    // posted by the plugin hooks after every file edit and by the agent at
    // natural steps. Untagged entries attach to the comment being worked on.
    if (resource === 'activity') {
      if (req.method === 'GET') return sendJSON(res, 200, { activity: canManage ? activityLog : publicActivity(activityLog) });
      if (req.method === 'POST') {
        if (!canManage) return deny();
        const body = await readJson(req);
        // A hook posts because a tool ran, not because the agent is here: it may
        // fire moments after the agent left (the edit hook still runs on the way
        // out). Its line is logged, but it never counts as a sign of life.
        if (body.source !== 'hook') touchPresence();
        // A hook's "turn ended" means the agent is between tasks, not gone.
        if (body.kind === 'idle' && agentStatus.state === 'working') releasePresence(agentStatus.commentId, 'turn ended', 'idle');
        const entry = body.kind === 'idle' ? null : logActivity(body);
        return sendJSON(res, 200, { entry, agent: agentStatus });
      }
    }
    // After applying a batch, the agent calls this so open overlays reload
    // themselves and show the edited page under the now-green pins — no manual
    // refresh. The overlay reloads only when it's safe (no composer / variant
    // preview / in-progress typing open); otherwise it surfaces a "reload" nudge.
    // The version history of a reviewed Markdown file: what it looked like when
    // it was opened, after each change, and what changed between any two copies.
    // Reading is open to everyone on the link (a version holds the document they
    // are already reading, nothing more); writing is the host side's.
    if (resource === 'history') {
      const sub = parts[1] || '';
      const isPost = req.method === 'POST';
      // Role first, before anything looks at the path: a 400 for a path outside
      // the project and a 403 for one inside it would tell a reviewer who may
      // not write here which files exist.
      if (isPost && !canManage) return deny();
      const body = isPost ? await readJson(req) : {};
      const target = resolveSourceFile(isPost ? body.file : url.searchParams.get('file'));
      if (!target) return sendJSON(res, 400, { error: 'file must be a path inside the project' });
      try {
        if (req.method === 'GET') {
          // Web mode keeps no history: there is no source file behind a page.
          if (!MD_MODE) {
            if (!sub) return sendJSON(res, 200, { file: target.rel, versions: [] });
            return sendJSON(res, 404, { error: 'no such version' });
          }
          if (!sub) return sendJSON(res, 200, await listVersions(DATA_DIR, target.rel));
          if (sub === 'diff') {
            const d = await diffVersions(DATA_DIR, target.rel, url.searchParams.get('from'), url.searchParams.get('to'));
            if (!d) return sendJSON(res, 404, { error: 'no such version' });
            // The flat op list is the same lines again; the hunks carry what a
            // reader needs and keep the answer small.
            const { ops, ...rest } = d;
            return sendJSON(res, 200, rest);
          }
          if (/^\d+$/.test(sub)) {
            const v = await readHistoryVersion(DATA_DIR, target.rel, Number(sub));
            if (!v) return sendJSON(res, 404, { error: 'no such version' });
            return sendJSON(res, 200, v);
          }
        }
        if (isPost && (sub === 'snapshot' || sub === 'restore')) {
          if (!canManage) return deny();
          if (!MD_MODE) return sendJSON(res, 404, { error: 'history is for --md sessions' });
          if (sub === 'snapshot') {
            // The processing skill calls this on either side of a batch, so the
            // whole batch reads as one change rather than a dozen saves.
            const reason = ['batch', 'manual'].includes(body.reason) ? body.reason : 'manual';
            const content = await readFile(target.full, 'utf-8').catch(() => null);
            if (content == null) return sendJSON(res, 404, { error: 'no such file' });
            const out = await recordSnapshot(DATA_DIR, target.rel, content, { reason });
            if (out.changed) broadcastSource(target.rel, out.version);
            return sendJSON(res, 200, { changed: out.changed, version: out.version });
          }
          const want = await readHistoryVersion(DATA_DIR, target.rel, body.n);
          if (!want) return sendJSON(res, 404, { error: 'no such version' });
          const current = await readFile(target.full, 'utf-8').catch(() => null);
          if (current == null) return sendJSON(res, 404, { error: 'no such file' });
          // Keep what is there now before overwriting it: going back must never
          // be the thing that loses work.
          await recordSnapshot(DATA_DIR, target.rel, current, { reason: 'restore' });
          await writeFile(target.full, want.content);
          const out = await recordSnapshot(DATA_DIR, target.rel, want.content, { reason: 'restore' });
          if (out.changed) broadcastSource(target.rel, out.version);
          return sendJSON(res, 200, { ok: true, version: out.version });
        }
      } catch (e) {
        if (e.code === 'ECORRUPT') return sendJSON(res, 500, { error: 'the version history for this file is unreadable — remove its folder under .feedback/history/' });
        throw e;
      }
      return sendJSON(res, 404, { error: 'unknown endpoint' });
    }

    // Which review round we are in, and when it started. Everyone on the link
    // may read it; starting a new one is the host side's call.
    if (resource === 'round') {
      if (req.method === 'GET') return sendJSON(res, 200, { round: currentRound, startedAt: roundStartedAt });
      if (req.method === 'POST') {
        if (!canManage) return deny();
        currentRound += 1;
        roundStartedAt = new Date().toISOString();
        await persistRound();
        broadcastRound();
        logActivity({ kind: 'round', text: 'round ' + currentRound + ' started' });
        return sendJSON(res, 200, { round: currentRound, startedAt: roundStartedAt });
      }
    }
    if (resource === 'reload' && req.method === 'POST') {
      if (!canManage) return deny();
      broadcastReload();
      return sendJSON(res, 200, { ok: true });
    }
    if (resource === 'export' && req.method === 'POST') {
      if (!canManage) return deny();
      await exportMarkdown(DATA_DIR, await readComments(DATA_DIR));
      return sendJSON(res, 200, { ok: true });
    }
    if (resource === 'md-export' && req.method === 'POST') {
      if (!canManage) return deny();
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
// Read one `Range: bytes=...` header. Returns the byte window to send, the
// string 'unsatisfiable' when the file cannot answer it (416), or null to send
// the whole file. Several ranges in one header, or anything malformed, count as
// null: RFC 9110 lets a server ignore a range it does not want to honour, and a
// full 200 is always a correct answer.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, from, to] = m;
  if (from === '' && to === '') return null;
  let start, end;
  if (from === '') {
    // "bytes=-500" means the last 500 bytes.
    const want = Number(to);
    if (!want) return 'unsatisfiable';
    start = Math.max(0, size - want);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

// Send a file (or a slice of it) without loading it into memory first. A read
// error after the headers went out can only be reported by cutting the
// connection, and a browser that navigates away mid-download must not leave the
// read running, hence the two handlers.
function streamFile(res, file, range) {
  const stream = createReadStream(file, range ? { start: range.start, end: range.end } : {});
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveStatic(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const headOnly = req.method === 'HEAD';
  if (ext === '.html') {
    // A page has to be read whole: the overlay tag is added before it goes out,
    // which changes its length, so a byte range could never line up with what is
    // on disk. Pages are small; everything else streams.
    const body = injectHtml(await readFile(file, 'utf-8'));
    res.writeHead(status, {
      'Content-Type': MIME[ext], 'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(headOnly ? undefined : body);
  }
  let size;
  try { size = (await stat(file)).size; }
  catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 — not found'); }

  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}`,
    });
    return res.end(headOnly ? undefined : '416 — range not satisfiable');
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Saying so is what makes a video scrub and a paused download resume.
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = size;
    res.writeHead(status, headers);
  }
  if (headOnly) return res.end();
  streamFile(res, file, range);
}

// ---------- proxy serving ----------
// Requests are pinned to the configured upstream origin: only the path+query of
// the incoming request is forwarded, never a host derived from the request line,
// so this can't be turned into an open proxy / SSRF pivot.
// A dev server that answers a redirect usually writes its own full address into
// Location. Followed as-is, the browser leaves the review server and the overlay
// is gone. Point the same path back through us instead. Only the configured
// upstream address is rewritten; a redirect to anywhere else is left alone.
function rewriteLocation(headers) {
  const loc = headers.location;
  if (typeof loc === 'string' && PROXY && loc.startsWith(PROXY)) {
    const rest = loc.slice(PROXY.length);
    headers.location = rest.startsWith('/') ? rest : '/' + rest;
  }
  return headers;
}

function proxyRequest(req, res) {
  const u = new URL(req.url, PROXY_URL);
  const fwd = { ...req.headers, host: PROXY_URL.host, 'accept-encoding': 'identity' };
  if (fwd.cookie) { const c = stripKbfCookie(fwd.cookie); if (c) fwd.cookie = c; else delete fwd.cookie; } // never leak the share key upstream
  const opts = {
    protocol: PROXY_URL.protocol, hostname: PROXY_URL.hostname, port: PROXY_PORT,
    path: u.pathname + u.search, method: req.method,
    headers: fwd,
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
        // Drop Permissions-Policy (and legacy Feature-Policy): an upstream
        // `microphone=()` would silently forbid the overlay's voice input —
        // the browser never shows a permission prompt at all.
        delete headers['permissions-policy'];
        delete headers['feature-policy'];
        headers['cache-control'] = 'no-store';
        res.writeHead(pres.statusCode || 200, rewriteLocation(headers));
        res.end(html);
      });
    } else {
      res.writeHead(pres.statusCode || 200, rewriteLocation({ ...pres.headers }));
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
  // Same DNS-rebinding guard as the HTTP routes — a forged Host can't open a
  // socket through us to the dev server.
  if (!hostAllowed(req)) { try { clientSocket.destroy(); } catch (e) {} return; }
  const onReady = (upstream) => {
    upstream.setTimeout(0); // connected: HMR sockets legitimately idle for minutes
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i], value = req.rawHeaders[i + 1];
      // Strip the share key from the forwarded Cookie (see stripKbfCookie).
      const out = /^cookie$/i.test(name) ? stripKbfCookie(value) : value;
      if (out) upstream.write(`${name}: ${out}\r\n`);
    }
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
  // Remember what this stream may see: below admin, activity lines lose the
  // edited file path, here and in every later broadcast (see publicActivity).
  const sseRole = req._kbfRole || 'full';
  res._kbfCanManage = sseRole === 'full' || sseRole === 'admin';
  // Late joiners see the current agent presence straight away.
  writeSse(res, 'event: agent-status\ndata: ' + JSON.stringify({ agent: agentStatus }) + '\n\n');
  writeSse(res, 'event: activity-log\ndata: ' + JSON.stringify({ activity: res._kbfCanManage ? activityLog : publicActivity(activityLog) }) + '\n\n');
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
  // Same rule as the API: the author hashes stay on disk (see publicComment).
  const payload = 'event: comments\ndata: ' + JSON.stringify({ comments: comments.map(publicComment) }) + '\n\n';
  // Skip if identical to the last payload (file-watch + our own write both fire).
  const h = crypto.createHash('sha1').update(payload).digest('hex');
  if (h === _lastBroadcast) return;
  _lastBroadcast = h;
  for (const res of [...sseClients]) writeSse(res, payload);
}
async function broadcastFromDisk() {
  try { broadcastComments(await readComments(DATA_DIR)); }
  catch (e) {
    // A transient partial write can momentarily parse as corrupt; but a real
    // ECORRUPT means open overlays would otherwise sit on stale data with no
    // hint. Tell them so they can surface it instead of silently going stale.
    if (e && e.code === 'ECORRUPT') {
      const payload = 'event: store-error\ndata: ' + JSON.stringify({ error: 'ECORRUPT', message: 'comments.json is unreadable' }) + '\n\n';
      for (const res of [...sseClients]) writeSse(res, payload);
    }
  }
}
// ---------- agent presence + activity ----------
// What the agent is doing right now, so open overlays can mirror the terminal:
// which comment it is on (`commentId`, since `since`), its latest `note`, what
// is queued, and when it was last heard from (`lastSeen`). In-memory only —
// presence is ephemeral by nature. Deliberately SINGLE-agent (last write
// wins): one working agent per session is the model; a second one's calls
// replace the chip. Fed by three sources: explicit POST /agent-status calls
// from the skill, implicit heartbeats (any non-browser manage call — the poll
// loop IS the heartbeat), and .feedback/presence.json for agents without HTTP.
const PRESENCE_STALE_MS = 10 * 60 * 1000; // no request at all for 10 min → offline
const HEARTBEAT_BROADCAST_MS = 5000;      // pure heartbeats rebroadcast at most this often
const ACTIVITY_MAX = 100;
// How long an explicit "I am offline" is respected. Inside this window a stray
// agent-looking request cannot put the chip back on — see touchPresence.
const OFFLINE_QUIET_MS = 60 * 1000;
let agentStatus = { state: 'offline', name: '', commentId: '', since: 0, note: '', lastSeen: 0, queue: [], ts: 0, offlineAt: 0 };
const activityLog = [];
let _presenceTimer = null;
let _lastHeartbeatBroadcast = 0;
function broadcastAgentStatus() {
  const payload = 'event: agent-status\ndata: ' + JSON.stringify({ agent: agentStatus }) + '\n\n';
  for (const res of [...sseClients]) writeSse(res, payload);
  _lastHeartbeatBroadcast = Date.now();
  clearTimeout(_presenceTimer);
  if (agentStatus.state !== 'offline') {
    _presenceTimer = setTimeout(() => {
      if (Date.now() - agentStatus.lastSeen < PRESENCE_STALE_MS) return;
      // `auto`: the agent went quiet, it did not say goodbye. Its next request
      // may bring it straight back (no quiet window, see setPresence).
      setPresence({ state: 'offline', auto: true });
    }, PRESENCE_STALE_MS + 500);
    _presenceTimer.unref();
  }
}
// A browser's fetch carries Sec-Fetch-* headers AND a Mozilla user-agent;
// curl, node (whose fetch also sends sec-fetch-mode, but as "node"), and the
// hooks don't look like that. That is how a reviewer's overlay (also role
// "full" when keyless) is told apart from the agent — only the agent's own
// calls count as heartbeats. `X-Feedback-Agent: 1` says so explicitly.
function isAgentRequest(req) {
  // `X-Feedback-Agent: 0` is the opposite claim: a non-browser client that is
  // not the agent (a desktop widget polling counts) and must not read as one.
  const claim = req.headers['x-feedback-agent'];
  if (claim !== undefined) return !(claim === '0' || claim === 'false' || claim === 'no');
  const ua = String(req.headers['user-agent'] || '');
  return !(req.headers['sec-fetch-mode'] && /^Mozilla\//.test(ua));
}
function touchPresence() {
  const now = Date.now();
  agentStatus.lastSeen = now;
  if (agentStatus.state === 'offline') {
    // The agent said it was leaving moments ago. A late request that merely
    // looks like it (an edit hook firing after /clear) must not raise it from
    // offline — the overlay would show someone at work who is not there.
    // Only an explicit {state:"online"|"working"} POST wins inside this window.
    if (now - (agentStatus.offlineAt || 0) < OFFLINE_QUIET_MS) return;
    agentStatus = { ...agentStatus, state: 'online', offlineAt: 0, ts: now };
    broadcastAgentStatus();
  } else if (now - _lastHeartbeatBroadcast > HEARTBEAT_BROADCAST_MS) {
    broadcastAgentStatus();
  }
}
const cleanId = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
function setPresence(body) {
  const now = Date.now();
  // No `state` at all = a note/queue-only update that keeps the current state;
  // an unknown state is junk and coerces to offline (never invent presence).
  const state = body.state == null ? agentStatus.state : (['online', 'working', 'offline'].includes(body.state) ? body.state : 'offline');
  const commentId = state === 'working' ? (cleanId(body.commentId) || agentStatus.commentId) : (state === 'offline' ? '' : cleanId(body.commentId));
  const next = {
    state,
    name: body.name == null ? agentStatus.name : String(body.name).slice(0, 60),
    commentId,
    // `since` = when work on THIS comment started; a re-claim of the same id keeps it.
    since: state === 'working' ? (commentId && commentId === agentStatus.commentId && agentStatus.since ? agentStatus.since : now) : 0,
    note: body.note == null ? (state === 'working' && commentId === agentStatus.commentId ? agentStatus.note : '') : String(body.note).slice(0, 120),
    lastSeen: state === 'offline' ? agentStatus.lastSeen : now,
    queue: Array.isArray(body.queue) ? body.queue.map(cleanId).filter(Boolean).slice(0, 20) : (state === 'offline' ? [] : agentStatus.queue),
    // When the agent SAID it was leaving. touchPresence reads it and stays
    // offline for a minute afterwards, so a hook that fires after the agent
    // left cannot bring the chip back. Any other state clears it, and so does
    // the silence timer's own offline (`auto`): an agent that merely went quiet
    // shows up again with its very next request.
    offlineAt: state === 'offline' && !body.auto ? now : 0,
    ts: now,
  };
  const claimed = next.state === 'working' && next.commentId && (agentStatus.state !== 'working' || agentStatus.commentId !== next.commentId);
  agentStatus = next;
  if (claimed) logActivity({ kind: 'claim', commentId: next.commentId, text: next.note || 'started on this comment' });
  else if (state === 'offline' && agentStatus.ts) logActivity({ kind: 'idle', text: 'agent left the session' });
  broadcastAgentStatus();
}
// The agent finished (resolved / rejected / answered) the comment it had
// claimed: drop back to "online" so a forgotten `{state:"online"}` can never
// leave a stale "working on #3" behind.
function releasePresence(commentId, text, kind = 'done') {
  if (agentStatus.state !== 'working' || agentStatus.commentId !== commentId) return;
  const took = agentStatus.since ? Date.now() - agentStatus.since : 0;
  logActivity({ kind, commentId, text: text || 'done', took });
  agentStatus = { ...agentStatus, state: 'online', offlineAt: 0, commentId: '', since: 0, note: '', lastSeen: Date.now(), queue: agentStatus.queue.filter((q) => q !== commentId), ts: Date.now() };
  broadcastAgentStatus();
}
// The activity log for anyone who is not the host: same lines, without the
// `file` field. Under --share a view or comment link may go to someone outside
// the team, and the edited paths are a map of the private source tree. The
// wording of each line ("edited the header") is what the reviewer needs.
function publicActivity(entries) {
  return entries.map(({ file, ...rest }) => rest);
}
let _activitySeq = 0;
function logActivity(entry) {
  const e = {
    id: 'a' + (++_activitySeq),
    at: Date.now(),
    kind: ['edit', 'note', 'reply', 'resolve', 'claim', 'done', 'idle', 'round'].includes(entry.kind) ? entry.kind : 'note',
    text: String(entry.text == null ? '' : entry.text).slice(0, 200),
    file: entry.file ? String(entry.file).slice(0, 200) : '',
    // An untagged entry (a hook's "edited file X") belongs to whatever is being worked on now.
    commentId: cleanId(entry.commentId) || (agentStatus.state === 'working' ? agentStatus.commentId : ''),
    took: entry.took > 0 ? Math.round(entry.took) : undefined,
  };
  activityLog.push(e);
  if (activityLog.length > ACTIVITY_MAX) activityLog.splice(0, activityLog.length - ACTIVITY_MAX);
  const payload = 'event: activity\ndata: ' + JSON.stringify({ entry: e }) + '\n\n';
  // Shared reviewers get the same line without the edited path (see publicActivity).
  const publicPayload = 'event: activity\ndata: ' + JSON.stringify({ entry: publicActivity([e])[0] }) + '\n\n';
  for (const res of [...sseClients]) writeSse(res, res._kbfCanManage === false ? publicPayload : payload);
  return e;
}
// Agents without HTTP (an MCP-only client) write .feedback/presence.json;
// the data-dir watch merges it as if it had been POSTed.
async function applyPresenceFile() {
  try {
    const raw = await readFile(path.join(DATA_DIR, 'presence.json'), 'utf8');
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return;
    if (p.activity && typeof p.activity === 'object') logActivity(p.activity);
    if (p.state) setPresence(p);
    else touchPresence();
  } catch (e) { /* missing or half-written — the next write will land */ }
}
// A new review round has started: open overlays retitle themselves and start
// separating what comes in now from what came before.
function broadcastRound() {
  const payload = 'event: round\ndata: ' + JSON.stringify({ round: currentRound, startedAt: roundStartedAt }) + '\n\n';
  for (const res of [...sseClients]) writeSse(res, payload);
}
function broadcastReload() {
  const payload = 'event: reload\ndata: ' + JSON.stringify({ at: Date.now() }) + '\n\n';
  for (const res of [...sseClients]) writeSse(res, payload);
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
    let ptimer = null;
    watch(DATA_DIR, (ev, fn) => {
      const name = fn ? String(fn) : '';
      if (name === 'presence.json') { clearTimeout(ptimer); ptimer = setTimeout(applyPresenceFile, 120); return; }
      if (name && name !== 'comments.json') return; // ignore .tmp / .lock / FEEDBACK.md
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

// `sourceRel` is the cwd-relative path stored on comments (`window.__kbfSource` →
// comment.sourceFile — the agent resolves it against the cwd, so it must stay
// exact even when ugly). `sourceDisplay` is only what the header SHOWS; callers
// pass something short when the real path is a ../../ chain outside the cwd.
function mdDocShell(title, sourceRel, sourceDisplay, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlAttr(title)}</title>
<style>
  :root { --ink:#1f1e1c; --soft:#565449; --muted:#8a8578; --paper:#faf9f5; --rule:#e7e4db; --clay:#c4623f; --code:#f2efe6; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.7 ui-serif, Georgia, "Times New Roman", serif; -webkit-font-smoothing:antialiased; }
  .doc { max-width: 46rem; margin: 0 auto; padding: 56px 24px 160px; }
  /* The overlay sets html.kbf-panel-open while its List panel (392px, see
     overlay.css .kbf-panel - keep the two widths equal) is open: body gets a
     matching right padding so .doc re-centres in the space beside the panel.
     kbf-shift-instant skips the slide on a reload with the panel already open.
     Under 768px the panel keeps overlaying (at 480px it is full-width anyway). */
  body { transition: padding-right .28s cubic-bezier(.32,.72,0,1); }
  html.kbf-shift-instant body { transition: none; }
  @media (min-width: 768px) { html.kbf-panel-open body { padding-right: 392px; } }
  .doc-source { font:600 12px/1 ui-monospace,"Fira Mono",monospace; color:var(--muted);
    letter-spacing:.04em; text-transform:uppercase; margin-bottom:28px; padding-bottom:14px; border-bottom:1px solid var(--rule); }
  h1,h2,h3,h4 { font-family: ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; line-height:1.25; letter-spacing:-0.01em; margin:1.8em 0 .6em; }
  h1 { font-size:2em; margin-top:0; } h2 { font-size:1.5em; } h3 { font-size:1.22em; } h4 { font-size:1.05em; }
  p, li { color:var(--ink); } a { color:var(--clay); }
  ul,ol { padding-left:1.4em; } li { margin:.25em 0; }
  blockquote { margin:1.2em 0; padding:.4em 1.1em; border-left:3px solid var(--clay); color:var(--soft); background:rgba(196,98,63,.05); border-radius:0 8px 8px 0; }
  code { font:0.88em ui-monospace,"Fira Mono",monospace; background:var(--code); padding:.12em .4em; border-radius:5px; }
  pre { background:var(--code); padding:14px 16px; border-radius:10px; overflow:auto; } pre code { background:none; padding:0; }
  /* A wide table scrolls INSIDE its own box — page-level horizontal overflow on
     a phone strands the fixed overlay buttons off to the side. */
  table { border-collapse:collapse; display:block; width:max-content; max-width:100%; overflow-x:auto; margin:1.3em 0; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  th,td { border:1px solid var(--rule); padding:8px 11px; text-align:left; } th { background:#f1eee6; font-weight:650; }
  img { max-width:100%; border-radius:8px; } hr { border:none; border-top:1px solid var(--rule); margin:2.4em 0; }
  /* Collapsible chapters (H1–H3). Folding only sets [hidden] on the EXISTING
     sibling elements — nothing is wrapped or moved — so comment anchors
     (nth-of-type paths, XPath) keep pointing at the same nodes. */
  .doc > h1, .doc > h2, .doc > h3 { position:relative; cursor:pointer; }
  .doc > h1::before, .doc > h2::before, .doc > h3::before {
    content:'▸'; position:absolute; left:-1.15em; top:50%; transform:translateY(-50%) rotate(90deg);
    font-size:.62em; color:var(--muted); opacity:.45; transition:transform .15s ease, opacity .15s ease; }
  .doc > h1:hover::before, .doc > h2:hover::before, .doc > h3:hover::before { opacity:1; color:var(--clay); }
  .doc > h1.is-folded::before, .doc > h2.is-folded::before, .doc > h3.is-folded::before { transform:translateY(-50%) rotate(0); opacity:.85; }
  .doc > .is-folded::after { content:'…'; margin-left:.45em; font-size:.7em; font-weight:400; color:var(--muted); }
  /* The author-origin "table { display:block }" above outranks the browser's
     built-in [hidden] rule — restate it so folded tables actually hide. */
  .doc > [hidden] { display:none !important; }
</style></head>
<body>
  <article class="doc">
    <div class="doc-source">${htmlAttr(sourceDisplay || sourceRel || '')}</div>
    ${bodyHtml}
  </article>
  <script>window.__kbfMode="md";window.__kbfSource=${JSON.stringify(sourceRel || '').replace(/</g, '\\u003c')};</script>
  <script>
  // Collapsible chapters. Clicking an H1/H2/H3 hides everything below it up to
  // the next heading of the same or higher level, by toggling [hidden] on the
  // existing siblings — the DOM keeps its exact shape, so comment anchors stay
  // valid (a hidden target simply has no box; the overlay keeps its pin hidden
  // until the chapter reopens). The overlay announces 'kbf:reveal' before it
  // scrolls to a comment target; any folded chapter hiding that target reopens.
  (() => {
    const doc = document.querySelector('.doc');
    if (!doc) return;
    const isHead = (el) => /^H[1-3]$/.test(el.tagName);
    const level = (el) => +el.tagName[1];
    const heads = [...doc.children].filter(isHead);
    if (!heads.length) return;
    const KEY = 'kbf-md-fold:' + (window.__kbfSource || location.pathname);
    const folded = new Set();
    try { for (const i of JSON.parse(sessionStorage.getItem(KEY) || '[]')) if (heads[i]) folded.add(heads[i]); } catch (e) {}

    function apply() {
      let hideAt = Infinity; // level of the folded heading whose chapter we're inside
      for (const el of doc.children) {
        if (isHead(el) && level(el) <= hideAt) {
          el.hidden = false;
          el.classList.toggle('is-folded', folded.has(el));
          hideAt = folded.has(el) ? level(el) : Infinity;
        } else {
          el.hidden = hideAt !== Infinity;
        }
      }
      try { sessionStorage.setItem(KEY, JSON.stringify(heads.flatMap((h, i) => (folded.has(h) ? [i] : [])))); } catch (e) {}
      window.dispatchEvent(new Event('resize')); // overlay re-measures pins now, not on the next scroll
    }

    doc.addEventListener('click', (e) => {
      const h = e.target.closest && e.target.closest('h1,h2,h3');
      if (!h || h.parentElement !== doc) return;
      if (e.target.closest('a')) return; // a link inside a heading still navigates
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) return; // selecting heading text, not toggling
      if (folded.has(h)) folded.delete(h); else folded.add(h);
      apply();
    });

    function chapterHas(h, node) {
      let top = node;
      while (top && top.parentElement !== doc) top = top.parentElement;
      if (!top) return false;
      for (let sib = h.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (isHead(sib) && level(sib) <= level(h)) return false;
        if (sib === top) return true;
      }
      return false;
    }
    document.addEventListener('kbf:reveal', (e) => {
      const t = e.detail && e.detail.el;
      if (!t || !folded.size) return;
      let changed = false;
      for (const h of heads) if (folded.has(h) && chapterHas(h, t)) { folded.delete(h); changed = true; }
      if (changed) apply();
    });

    if (folded.size) apply(); // restore this tab's fold state from before a reload
  })();
  </script>
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
    // SVG animation elements can rewrite another element's href while the page
    // is open, which would put back a link we just neutralised. Drop them.
    .replace(/<\/?(animate|animateMotion|animateTransform|set)\b[^>]*>/gi, '')
    // strip inline event handlers:  onclick="…"  onerror='…'  onload=foo
    // ('/' counts as attribute whitespace in HTML5, so <img/onerror=…> too)
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, '')
    // neutralise script-ish URLs in href/src — checked ENTITY-DECODED (via the
    // shared schemeIsEvil), so an encoded/split scheme like `&#106;avascript:`
    // or `java&Tab;script:` can't slip past the way a literal-substring match would.
    // The SVG link attributes and the form ones count too: `xlink:href` on an
    // <svg><a> and `formaction`/`action` on a button or form run the same scheme.
    .replace(/\b(href|src|xlink:href|formaction|action)\s*=\s*"([^"]*)"/gi, (m, attr, val) => (schemeIsEvil(val) ? attr + '="#"' : m))
    .replace(/\b(href|src|xlink:href|formaction|action)\s*=\s*'([^']*)'/gi, (m, attr, val) => (schemeIsEvil(val) ? attr + "='#'" : m))
    // …and the same attributes written WITHOUT quotes (href=javascript:alert(1)),
    // which the two branches above never see. Runs after them, so a value they
    // already replaced with "#" is quoted by then and is left alone.
    .replace(/\b(href|src|xlink:href|formaction|action)\s*=\s*([^\s"'>]+)/gi, (m, attr, val) => (schemeIsEvil(val) ? attr + '="#"' : m));
}

// Links in a reviewed document open in a NEW tab: following a reference must
// not replace the review page (losing scroll position, fold state, and any
// half-written comment). In-page #anchors keep jumping within the doc, and the
// file-index page is untouched — that's the app's own navigation, not content.
// rel="noopener noreferrer" cuts the opened page's window.opener handle back to
// the review tab. Any target=/rel= already present (raw HTML in the .md) is
// replaced, not doubled.
function linksOpenNewTab(html) {
  return String(html).replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = href ? (href[2] != null ? href[2] : href[3]) : '';
    if (!url || url.startsWith('#')) return m;
    const cleaned = attrs.replace(/\s+(target|rel)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return '<a' + cleaned + ' target="_blank" rel="noopener noreferrer">';
  });
}

// HTML written inside a .md is shown as text, not rendered. This is the default
// because a document you were sent is not code you reviewed, and the rendered
// page shares an address with the comment API. `marked` hands every raw HTML
// piece to renderer.html, both a block on its own and a tag inside a sentence,
// so escaping there is enough. Fenced code and tables never pass through it and
// are unaffected. --md-html turns this off and renders the HTML instead, which
// then goes through sanitizeRenderedHtml as it always did.
function escapeAsText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function textOnlyRenderer(marked) {
  if (typeof marked.Renderer !== 'function') {
    throw new Error('this version of the Markdown renderer has no Renderer to build on. Re-run with --md-html, or reinstall marked in ' + path.join(GLOBAL_DATA, 'deps'));
  }
  const renderer = new marked.Renderer();
  // A block sits between paragraphs, so give it a paragraph of its own; a tag
  // inside a sentence stays inline where it was written.
  renderer.html = (text, block) => (block ? '<p class="kbf-raw">' + escapeAsText(text).trim() + '</p>\n' : escapeAsText(text));
  return renderer;
}

async function renderMd(file) {
  const marked = await ensureMarked();
  const src = await readFile(file, 'utf-8');
  const opts = { gfm: true, breaks: false };
  if (!MD_HTML) opts.renderer = textOnlyRenderer(marked);
  // sanitizeRenderedHtml runs in BOTH modes: `marked` does not clean link
  // addresses, so a plain Markdown link can still point at a javascript:
  // address with no raw HTML involved anywhere.
  const body = linksOpenNewTab(sanitizeRenderedHtml(marked.parse(src, opts)));
  const rel = relFromCwd(file);
  // Start watching this document for changes, and keep the copy it opened with.
  await noteSourceServed(rel, file, src);
  // Header display: a file outside the cwd would show a ../../../ chain of
  // machine internals — show it relative to the --md root instead (which for a
  // single file is just its name). The STORED sourceFile stays `rel`, exact.
  const disp = rel.startsWith('..') ? (path.relative(MD_ROOT, file).split(path.sep).join('/') || path.basename(file)) : rel;
  return mdDocShell(path.basename(file), rel, disp, body);
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
  const rel = path.relative(CWD, MD_ROOT).split(path.sep).join('/') || '.';
  return mdDocShell('Markdown files', rel, rel.startsWith('..') ? path.basename(MD_ROOT) : rel, body);
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
    // A share link (?key=...) on a page URL: validate, move the key into a
    // cookie, and redirect to the clean URL so the capability doesn't linger in
    // the address bar / history / copy-pasted screenshots.
    if (SHARE && (req.method === 'GET' || req.method === 'HEAD')
        && !url.pathname.startsWith('/__feedback/') && url.searchParams.has('key')) {
      const key = url.searchParams.get('key');
      if (!tokenRole(key)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 — invalid share link (ask for a fresh one; keys change each server start)');
      }
      url.searchParams.delete('key');
      const loc = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
      // Path=/__feedback: every role-dependent read (overlay.js, /events, /api)
      // lives under it, and page routes don't check role — so the browser never
      // attaches the key to ordinary page/asset requests, and in --proxy mode it
      // is never forwarded to the upstream dev server. (Known RFC 6265 limitation:
      // cookies scope by hostname, not port, so other local dev servers on the
      // same host still receive it — the __Host- prefix would fix that but
      // requires HTTPS, which --share doesn't mandate; keys rotate every start.)
      res.writeHead(302, {
        Location: loc,
        'Set-Cookie': 'kbf-key=' + encodeURIComponent(key) + '; Path=/__feedback; SameSite=Lax; HttpOnly',
      });
      return res.end();
    }

    if (url.pathname === '/__feedback/overlay.js') {
      // Config is prefixed into this same file (an inline <script> could be
      // blocked by a site's CSP): the --no-shots flag, and under --share the
      // requester's role so the overlay renders view/comment-appropriately.
      let prefix = '';
      if (!SHOTS) prefix += 'window.__kbfShots=false;\n';
      if (SHARE) prefix += 'window.__kbfRole=' + JSON.stringify(roleFor(req, url) || 'none') + ';\n';
      if (LABEL) prefix += 'window.__kbfLabel=' + JSON.stringify(LABEL) + ';\n'; // site name (multi-site)
      // The URL stays /__feedback/overlay.js for compatibility; the file behind
      // it is the entry module of the split overlay. The prefix lines are plain
      // statements, valid at the top of a module.
      if (prefix) {
        const src = prefix + readFileSync(path.join(PUBLIC_DIR, 'overlay', 'main.mjs'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(src);
      }
      return serveAsset(res, path.join(PUBLIC_DIR, 'overlay', 'main.mjs'));
    }
    if (url.pathname === '/__feedback/overlay.css') return serveAsset(res, path.join(PUBLIC_DIR, 'overlay.css'));
    // The overlay's own modules (/__feedback/overlay/<name>.mjs) and the shared
    // modules it imports from lib/ (/__feedback/lib/<name>.mjs: anchoring,
    // narration, the schema constants). One file name each, .mjs only, no
    // path parts, so nothing outside those two folders can be reached.
    const modRoute = /^\/__feedback\/(overlay|lib)\/([A-Za-z0-9_-]+\.mjs)$/.exec(url.pathname);
    if (modRoute) {
      const dir = modRoute[1] === 'overlay' ? path.join(PUBLIC_DIR, 'overlay') : path.join(__dirname, '..', 'lib');
      return serveAsset(res, path.join(dir, modRoute[2]));
    }
    // DNS-rebinding guard for the whole comment surface, reads included — a
    // rebound page could otherwise read the review data (API GETs, SSE stream).
    // The static overlay assets above stay public; they contain no data.
    if (url.pathname === '/__feedback/events' || url.pathname.startsWith('/__feedback/api') || url.pathname.startsWith('/__feedback/vendor/')) {
      if (!hostAllowed(req)) return sendJSON(res, 403, { error: 'host not allowed' });
      // Share roles gate the whole feedback surface (reads included — the
      // review data is what a view link grants). No/invalid key = no access.
      if (SHARE) {
        const role = roleFor(req, url);
        if (!role) return sendJSON(res, 401, { error: 'missing or invalid share key' });
        req._kbfRole = role;
      }
    }
    if (url.pathname === '/__feedback/events') return handleSSE(req, res);
    if (url.pathname.startsWith('/__feedback/api')) return handleApi(req, res, url);
    if (url.pathname.startsWith('/__feedback/vendor/html-to-image/')) return serveVendorHti(res, url);

    // DNS-rebinding guard for the served SITE too, not just the data surface: a
    // rebound hostile origin must not read the local page content or pivot
    // through --proxy to the dev server. Legit access always uses an allowed
    // host (loopback / LAN IPs / machine name / tunnel are all in ALLOWED_HOSTS);
    // only a forged Host is refused. (The inert overlay.js/.css assets above stay
    // host-agnostic — they carry no site data.)
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 — host not allowed');
    }

    if (MD_MODE) {
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return serveMd(req, res, url);
    }
    if (PROXY) return proxyRequest(req, res);

    const file = await resolveStaticFile(url.pathname);
    if (!file) {
      // --spa: /about and /orders/42 are routes the app draws in the browser,
      // not files. A path with no file extension gets index.html and the overlay
      // with it. A missing /app.js keeps its 404, so a broken asset still shows.
      if (SPA && !path.extname(url.pathname)) {
        const index = path.join(STATIC_DIR, 'index.html');
        if (existsSync(index)) return serveStatic(req, res, index, 200);
      }
      const notFound = path.join(STATIC_DIR, '404.html');
      // Pass the status explicitly: writeHead()'s code wins over res.statusCode,
      // so setting the property here would still send the custom page as a 200.
      if (existsSync(notFound)) return serveStatic(req, res, notFound, 404);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — not found');
    }
    return serveStatic(req, res, file);
  } catch (err) {
    console.error('Request error:', err);
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — internal error');
  }
}

// Screenshots raise the stakes of an accidentally-committed .feedback/ (a shot
// can capture logged-in dashboards or on-screen PII, not just comment text), so
// don't leave the "gitignore it" instruction buried in docs: check and WARN at
// startup. Warn-only by design — auto-editing a user-owned .gitignore on start
// would break the same convention that keeps --seed-agents opt-in.
function warnIfFeedbackCommittable() {
  if (!SHOTS) return;
  const rel = path.relative(CWD, DATA_DIR);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return; // demo/temp dir — not in this repo
  if (!existsSync(path.join(CWD, '.git'))) return;
  try {
    execSync(`git check-ignore -q "${rel.split(path.sep).join('/')}"`, { cwd: CWD, stdio: 'ignore' });
  } catch (e) {
    console.log('\n  ! ' + rel + '/ is NOT gitignored. Comments — and element screenshots,');
    console.log('    which can capture whatever was on screen — would be committed with your');
    console.log('    code. Add "**/.feedback/" to .gitignore (or run with --no-shots).');
  }
}

// The reviewed source can live anywhere (--dir ../other-project/dist, --md
// ../report.md), but the data dir defaults to the folder the command RUNS in.
// Run from the wrong folder and the comments land away from the project, with
// nothing saying so — the agent then processes an empty file while the real
// comments sit elsewhere. When the source is outside the cwd and no --data-dir
// was given, say where the data goes and how to keep it with the project.
function warnIfDataFarFromSource() {
  if (DEMO || PROXY || args['data-dir']) return;
  const src = MD_MODE ? (MD_SINGLE ? path.dirname(MD_SINGLE) : MD_ROOT) : STATIC_DIR;
  if (!src) return;
  const rel = path.relative(CWD, src);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return; // source inside the cwd — fine
  console.log(`\n  ! The reviewed ${MD_MODE ? 'markdown' : 'site'} is outside this folder; comments will be stored`);
  console.log(`    HERE, in ${path.relative(CWD, DATA_DIR).split(path.sep).join('/') || '.feedback'}/ — not next to what you're reviewing. If you meant to`);
  console.log(`    keep them with that project, re-run from its root, or pass`);
  console.log(`    --data-dir <that-project>/.feedback`);
}

// ---------- banner ----------
// Read first, then write: this file also carries the review round, which belongs
// to the review rather than to this run. Overwriting the whole file on every
// start would silently put a round-3 review back to round 1.
async function writeSiteMeta(url) {
  const prev = await readMeta();
  if (prev.round !== undefined) currentRound = coerceRound(prev.round);
  roundStartedAt = isoOr(prev.roundStartedAt, roundStartedAt);
  await writeJson(metaFile(), {
    ...prev,
    label: LABEL || undefined,
    url,
    served: PROXY || (MD_MODE ? String(args.md) : (STATIC_DIR ? path.relative(CWD, STATIC_DIR).split(path.sep).join('/') : '')) || undefined,
    mode: PROXY ? 'proxy' : (MD_MODE ? 'md' : 'static'),
    port: PORT,
    startedAt: new Date().toISOString(),
    round: currentRound,
    roundStartedAt,
  }).catch(() => {});
}

// How the plugin hooks and the skill find this server without guessing a
// port: `.feedback/session.json` lives while the process runs (removed on a
// clean exit; readers also check `pid` is alive so a crash can't leave a lie).
const SESSION_FILE = () => path.join(DATA_DIR, 'session.json');
// The same record, once more in a per-user registry, so desktop integrations
// (the Omarchy bar plugin, a future `feedback-studio ls`) can list every review
// server on the machine without knowing any project path. One file per pid;
// stale files (dead pid) are swept on every start.
const SESSIONS_DIR = () => path.join(GLOBAL_DATA, 'sessions');
const REGISTRY_FILE = () => path.join(SESSIONS_DIR(), process.pid + '.json');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function sweepSessionRegistry() {
  let names = [];
  try { names = readdirSync(SESSIONS_DIR()); } catch (e) { return; }
  for (const name of names) {
    // `<pid>.json`, or a `<pid>.json.tmp-*` left by a process killed mid-write.
    const m = /^(\d+)\.json(\.tmp-.*)?$/.exec(name);
    if (!m) continue;
    const f = path.join(SESSIONS_DIR(), name);
    let pid = Number(m[1]);
    if (!m[2]) { try { pid = Number(JSON.parse(readFileSync(f, 'utf8')).pid) || pid; } catch (e) { /* junk: sweep it */ } }
    if (!pidAlive(pid)) { try { unlinkSync(f); } catch (e) {} }
  }
}
async function writeSessionFile(scheme, publicUrl, ips) {
  const session = {
    pid: process.pid,
    port: PORT,
    // 127.0.0.1, not "localhost": on Node 18 "localhost" resolves to ::1 first
    // and the server binds IPv4 only — the hook's request would be refused.
    apiBase: `${scheme}://127.0.0.1:${PORT}/__feedback/api`,
    adminKey: SHARE ? SHARE_KEYS.admin : undefined,
    cwd: CWD,
    dataDir: DATA_DIR,
    startedAt: new Date().toISOString(),
  };
  await writeJson(SESSION_FILE(), session).catch(() => {});
  sweepSessionRegistry();
  await writeJson(REGISTRY_FILE(), {
    ...session,
    label: LABEL || undefined,
    mode: DEMO ? 'demo' : (PROXY ? 'proxy' : (MD_MODE ? 'md' : 'static')),
    served: DEMO ? undefined : (PROXY || (MD_MODE ? String(args.md) : (STATIC_DIR ? path.relative(CWD, STATIC_DIR).split(path.sep).join('/') : '')) || undefined),
    url: `${scheme}://localhost:${PORT}/`,
    // Where a phone can reach this session, if anywhere: the tunnel, else the
    // LAN address when the server was started on a non-loopback host.
    phoneUrl: publicUrl ? publicUrl + '/' : (EXPOSE_LAN && ips && ips.length ? `${scheme}://${ips[0]}:${PORT}/` : undefined),
    tunnel: !!publicUrl,
    share: SHARE ? (SHARE_STRICT ? 'strict' : 'on') : undefined,
  }).catch(() => {});
  // The registry may carry the admin key; keep it to this user.
  try { chmodSync(REGISTRY_FILE(), 0o600); } catch (e) {}
}
function removeSessionFile() {
  try { if (existsSync(SESSION_FILE())) unlinkSync(SESSION_FILE()); } catch (e) {}
  try { if (existsSync(REGISTRY_FILE())) unlinkSync(REGISTRY_FILE()); } catch (e) {}
}

function banner(scheme, ips, publicUrl) {
  const src = DEMO ? `demo site (throwaway copy: ${STATIC_DIR})`
    : MD_MODE ? `reviewing markdown: ${path.relative(CWD, MD_SINGLE || MD_ROOT) || '.'}`
    : PROXY ? `proxying ${PROXY}`
    : `serving ${path.relative(CWD, STATIC_DIR) || '.'}/`;
  const shareBase = publicUrl || (EXPOSE_LAN && ips.length ? `${scheme}://${ips[0]}:${PORT}` : `${scheme}://localhost:${PORT}`);
  const tag = publicUrl ? '  (secure tunnel — voice works anywhere)' : USE_HTTPS ? '  (HTTPS — voice works on phones)' : '';
  console.log(`\n  Feedback Studio${LABEL ? ` — ${LABEL}` : ''}${tag}`);
  console.log(`  ------------------------------------------`);
  if (LABEL) console.log(`  Site             ->  ${LABEL}`);
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
  console.log(`  Comments         ->  ${DEMO ? DATA_FILE : ((path.relative(CWD, DATA_DIR).split(path.sep).join('/') || '.feedback') + '/comments.json')}  (+ FEEDBACK.md, HOW-TO-PROCESS.md)`);
  if (!DEMO) {
    console.log(`  Agent setup      ->  optional: re-run with --seed-agents to teach CLAUDE.md / AGENTS.md the flow.`);
  }
  if (DEMO && args['no-seed']) {
    console.log(`\n  Starting empty — no comments yet. Press P, click anything, leave a comment;`);
    console.log(`  then let your agent process ${path.join(DATA_DIR, 'comments.json')}.`);
  } else if (DEMO) {
    console.log(`\n  3 comments are pre-seeded (one fix, one change, one improve) — and the page`);
    console.log(`  hides a couple more flaws to find. Press P, click anything, leave a comment;`);
    console.log(`  then let your agent process ${path.join(DATA_DIR, 'comments.json')}.`);
  }
  if (SHARE) {
    console.log(`\n  Share links (a link IS its role — anyone holding one can act while this server runs;`);
    console.log(`  keys change every start):`);
    console.log(`    View only  ->  ${shareBase}/?key=${SHARE_KEYS.view}`);
    console.log(`    Comment    ->  ${shareBase}/?key=${SHARE_KEYS.comment}`);
    console.log(`    Admin      ->  ${shareBase}/?key=${SHARE_KEYS.admin}`);
    if (SHARE_STRICT) console.log(`    Strict: localhost needs a key too — your own tab opens with the admin key.`);
    else console.log(`    This computer keeps full access without a key (use "--share strict" to require one).`);
  }
  if (publicUrl) {
    if (SHARE) {
      console.log(`\n  The tunnel is live while the server runs; without a share key it serves the`);
      console.log(`  page but no feedback data. Ctrl+C closes it.`);
    } else {
      console.log(`\n  The tunnel URL is public while the server runs — anyone with the link can`);
      console.log(`  view and comment (add --share for per-role links). Ctrl+C closes it.`);
    }
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

// ---------- stamp markers and stop (--stamp) ----------
// The same work POST /md-export does, without a server or a browser: useful in a
// script, or when the review session is already closed. --md may be given
// alongside so a document outside this folder counts as an allowed target, and
// --data-dir picks a different set of comments.
async function stampAndExit() {
  if (!existsSync(DATA_FILE)) {
    const where = path.relative(CWD, DATA_FILE).split(path.sep).join('/') || DATA_FILE;
    console.error(`\n  No comments to stamp: ${where} does not exist.`);
    console.error(`  Run a review session first, or point --data-dir at the folder that holds them.\n`);
    process.exit(1);
  }
  const roots = MD_ROOT ? [CWD, MD_ROOT] : [CWD];
  const r = await stampMarkers(DATA_DIR, CWD, roots);
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const extra = [];
  if (r.updated) extra.push(`${plural(r.updated, 'marker')} updated`);
  if (r.notFound) extra.push(`${r.notFound} skipped: no unique matching line`);
  console.log(`Stamped ${plural(r.stamped, 'marker')} into ${plural(r.files, 'file')}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  process.exit(0);
}

// ---------- main ----------
async function main() {
  if (args['seed-agents']) { await seedAgents(); return; }
  // Before the build-directory check below: stamping needs no site to serve.
  if (args.stamp) { await stampAndExit(); return; }
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
  // Pick the review back up where it was left: which round we are in is read
  // before the first request can arrive.
  await loadRound();
  // Drop the self-contained processing guide next to the data (regenerated each run,
  // like FEEDBACK.md) so any agent — plugin or not — has the workflow on hand.
  await exportProcessInstructions(DATA_DIR, LABEL).catch(() => {});

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
    removeSessionFile();
    for (const res of sseClients) { try { res.end(); } catch (e) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // don't hang on a stuck socket
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', removeSessionFile);

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
    // Self-identify this data dir (multi-site: one repo, a session + data dir per
    // site) — written now so `url` reflects the real tunnel URL, `served` the
    // resolved static dir (correct even when --dir was autodetected).
    await writeSiteMeta(publicUrl ? publicUrl + '/' : `${scheme}://localhost:${PORT}/`);
    await writeSessionFile(scheme, publicUrl, ips);
    warnIfFeedbackCommittable();
    warnIfDataFarFromSource();
    // Under strict share even localhost needs a key — open our own tab as admin.
    const openUrl = `${scheme}://localhost:${PORT}/` + (SHARE_STRICT ? `?key=${SHARE_KEYS.admin}` : '');
    if (!args['no-open']) openBrowser(openUrl);
  });
}

main();
