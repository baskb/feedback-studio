#!/usr/bin/env node
// Feedback Studio — Claude Code hook: tell the running review server what the
// agent just did, so the browser mirrors the terminal ("edited src/Header.jsx",
// turn ended) without the agent having to remember any heartbeat.
//
// Invoked by hooks.json as `report.mjs <edit|prompt|idle>` with the hook's JSON
// on stdin. Finds the server through `.feedback/session.json` (written by the
// server while it runs). No session file, dead server, or any error → exits 0
// silently and fast: this is the whole cost in a project without a review
// session. Never prints to stdout (that would land in the hook result).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const kind = process.argv[2] || 'note';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
// The session file sits in the data dir: `$FEEDBACK_DIR`, else `.feedback/` in
// the cwd or one of its parents (a `--data-dir` session belongs to the
// reviewed project, which may be a subfolder of where Claude runs — or the
// other way round).
function findSession(cwd) {
  const dirs = [];
  if (process.env.FEEDBACK_DIR) dirs.push(path.resolve(process.env.FEEDBACK_DIR));
  let d = cwd;
  for (let i = 0; i < 4 && d; i++) {
    dirs.push(path.join(d, '.feedback'));
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const dir of dirs) {
    const f = path.join(dir, 'session.json');
    if (!existsSync(f)) continue;
    try {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (s && s.apiBase && (!s.pid || alive(Number(s.pid)))) return s;
    } catch (e) { /* half-written or junk — treat as no session */ }
  }
  return null;
}

let input = {};
try { input = JSON.parse(readStdin() || '{}'); } catch (e) {}
const cwd = input.cwd || process.cwd();
const session = findSession(cwd);
if (!session) process.exit(0);

let body;
if (kind === 'edit') {
  const fp = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
  if (!fp) process.exit(0);
  // Show the path relative to the project, never the whole disk path.
  const base = session.cwd || cwd;
  let rel = path.relative(base, fp);
  if (!rel || rel.startsWith('..')) rel = path.basename(fp);
  body = { kind: 'edit', file: rel.split(path.sep).join('/'), text: 'edited ' + rel.split(path.sep).join('/') };
} else if (kind === 'idle') {
  body = { kind: 'idle', text: 'turn ended' };
} else if (kind === 'prompt') {
  body = { kind: 'note', text: 'reading your message' };
} else {
  body = { kind: 'note', text: String(kind).slice(0, 120) };
}

let url;
try { url = new URL(session.apiBase.replace(/\/$/, '') + '/activity' + (session.adminKey ? '?key=' + encodeURIComponent(session.adminKey) : '')); }
catch (e) { process.exit(0); }
const mod = url.protocol === 'https:' ? https : http;
const data = JSON.stringify(body);
const req = mod.request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  timeout: 800,
  rejectUnauthorized: false, // a --https session uses a self-signed certificate
}, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.on('error', () => process.exit(0));
req.end(data);
setTimeout(() => process.exit(0), 1500).unref();
