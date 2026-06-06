// Feedback Studio — shared data store.
//
// The single source of truth for the comment schema and for reading/writing
// .feedback/comments.json. Imported by BOTH the HTTP server and the MCP server
// so the two processes produce byte-identical comment objects and can write the
// same file concurrently without losing data or observing a half-written file.
//
// Concurrency model:
//   - Writes are atomic: serialise to a temp file, then rename() into place
//     (atomic on the same filesystem). Readers therefore never see a partial file.
//   - Cross-process writes are serialised by an advisory lockfile with a stale
//     timeout, so the overlay (via the HTTP server) and an agent (via MCP) can
//     both write and the last write does not silently clobber the previous one.
//   - A corrupt/unparseable file is NEVER silently treated as empty — that would
//     let one bad read overwrite good data with []. readComments() throws ECORRUPT.

import { readFile, writeFile, mkdir, rename, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- schema constants (the contract) ----------
export const SCHEMA_VERSION = 3;
export const FILE_VERSION = 1;

// Comment types decide how much latitude the agent gets. Web pages and Markdown
// documents use different verbs; the union is what the file may legally contain.
export const WEB_TYPES = ['fix', 'change', 'improve'];
export const MD_TYPES = ['comment', 'rephrase', 'expand', 'delete', 'question'];
export const ALLOWED_TYPES = [...WEB_TYPES, ...MD_TYPES];
export const STATUSES = ['open', 'approved', 'rejected', 'resolved'];
export const AUTONOMY = ['auto', 'review'];

const ANCHOR_KEYS = ['type', 'selector', 'attrSelector', 'xpath', 'tag', 'id', 'snippet', 'rangeText'];
const TEXT_MAX = 10000;

let _writeSeq = 0;

// ---------- ids ----------
export function newId(prefix = 'c') { return prefix + '_' + crypto.randomUUID(); }

// ---------- paths ----------
const dataFile = (dir) => path.join(dir, 'comments.json');
const lockFile = (dir) => path.join(dir, 'comments.json.lock');
const mdFile = (dir) => path.join(dir, 'FEEDBACK.md');

// ---------- type / shape helpers ----------
export function modeFor(sourceFile) { return sourceFile ? 'md' : 'web'; }

// Coerce a requested type to one valid for the mode; fall back to the mode default.
export function coerceType(type, mode) {
  const set = mode === 'md' ? MD_TYPES : WEB_TYPES;
  if (set.includes(type)) return type;
  return mode === 'md' ? 'comment' : 'change';
}

// Keep only known anchor keys and cap their length, so a client can't bloat the
// file with a giant or arbitrarily-shaped anchor blob.
export function sanitizeAnchor(a) {
  const out = {};
  if (a && typeof a === 'object') {
    for (const k of ANCHOR_KEYS) {
      if (a[k] == null) continue;
      const cap = (k === 'snippet' || k === 'rangeText') ? 500 : 1000;
      out[k] = String(a[k]).slice(0, cap);
    }
  }
  if (!out.type) out.type = 'element';
  return out;
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// The one place a comment object is constructed. Both servers call this so the
// stored shape (and the default type per mode) is identical regardless of author.
export function makeComment(input = {}) {
  const now = new Date().toISOString();
  const sourceFile = str(input.sourceFile, 300);
  const mode = modeFor(sourceFile);
  return {
    id: newId('c'),
    schemaVersion: SCHEMA_VERSION,
    page: str(input.page, 300) || '/',
    pageTitle: str(input.pageTitle, 300),
    url: str(input.url, 2000),
    sourceFile,
    anchor: sanitizeAnchor(input.anchor),
    type: coerceType(input.type, mode),
    text: str(input.text, TEXT_MAX).trim(),
    author: input.author === 'agent' ? 'agent' : 'user',
    authorName: str(input.authorName, 60),
    thread: [],
    autonomy: AUTONOMY.includes(input.autonomy) ? input.autonomy : 'review',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

export function makeReply(input = {}) {
  return {
    id: newId('r'),
    author: input.author === 'agent' ? 'agent' : 'user',
    authorName: str(input.authorName, 60),
    text: str(input.text, TEXT_MAX).trim(),
    createdAt: new Date().toISOString(),
  };
}

// ---------- read / write ----------
export async function readComments(dir) {
  let raw;
  try {
    raw = await readFile(dataFile(dir), 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error('comments.json is not valid JSON (' + e.message + ')');
    err.code = 'ECORRUPT';
    throw err;
  }
  // Valid JSON but the wrong shape (a hand-edit gone wrong) is just as corrupt:
  // treating it as empty would let the next write clobber the file with [].
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.comments)) {
    const err = new Error('comments.json parses but has no "comments" array — refusing to treat it as empty');
    err.code = 'ECORRUPT';
    throw err;
  }
  return parsed.comments;
}

export async function writeComments(dir, comments, opts = {}) {
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify({ version: FILE_VERSION, updatedAt: new Date().toISOString(), comments }, null, 2);
  const tmp = path.join(dir, 'comments.json.tmp-' + process.pid + '-' + (_writeSeq++));
  await writeFile(tmp, body);
  await rename(tmp, dataFile(dir)); // atomic replace
  if (opts.exportMd !== false) {
    await exportMarkdown(dir, comments).catch(() => {}); // a readable mirror; best-effort
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(dir, { retries = 100, wait = 50, staleMs = 15000 } = {}) {
  const lp = lockFile(dir);
  for (let i = 0; i < retries; i++) {
    try {
      const fh = await open(lp, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return lp;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Steal an abandoned lock (a process that crashed mid-write).
      try {
        const st = await stat(lp);
        if (Date.now() - st.mtimeMs > staleMs) { await unlink(lp).catch(() => {}); continue; }
      } catch (_) { /* lock vanished; retry immediately */ continue; }
      await sleep(wait);
    }
  }
  throw new Error('could not acquire the comments lock (timed out)');
}

// Read-modify-write under the cross-process lock. `fn(comments)` returns
// `{ comments, value }`: the array to persist and the value to return.
export async function mutate(dir, fn) {
  await mkdir(dir, { recursive: true });
  const lp = await acquireLock(dir);
  try {
    const current = await readComments(dir);
    const out = await fn(current);
    const next = out && Array.isArray(out.comments) ? out.comments : current;
    await writeComments(dir, next);
    return out ? out.value : undefined;
  } finally {
    await unlink(lp).catch(() => {});
  }
}

// ---------- FEEDBACK.md (readable mirror) ----------
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Escape a value for use inside an inline `code span` (backticks would break it).
const code = (s) => '`' + String(s == null ? '' : s).replace(/`/g, 'ˋ') + '`';

export async function exportMarkdown(dir, comments) {
  const byPage = new Map();
  for (const c of comments) {
    const key = c.page || '/';
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(c);
  }
  const open = comments.filter((c) => c.status !== 'resolved').length;
  let md = `# Feedback export\n\n`;
  md += `_Generated from \`.feedback/comments.json\` (the source of truth). Read-only, human-glance mirror: do not edit or act off this file, act off \`comments.json\` (or the MCP tools)._\n\n`;
  md += `_Generated ${new Date().toISOString()} — ${comments.length} comment(s): ${open} open, ${comments.length - open} resolved._\n\n`;
  md += `> Each comment has a TYPE that sets how much latitude you have: \`fix\` = reproduce and patch what is broken; \`change\` = apply near-verbatim, do not redesign; \`improve\` = rewrite or redesign with judgement. Each anchor carries a css selector, an attr/xpath fallback, and a quoted snippet so the element can be re-found. Resolve the element with confidence; if you cannot locate it confidently, do NOT edit a guess — flag it for a re-pin.\n>\n> Comments are a two-way conversation. Some are authored \`by user\`, some \`by agent\` (a proposal/annotation you or another skill left on a component). Each can have a reply thread (lines marked \`↳\`). Statuses: \`open\` (needs work/decision), \`approved\` (the user said go ahead — implement it), \`rejected\` (do not), \`resolved\` (done). Implement approved items, reply to ask questions, and set the status as you go.\n\n`;
  for (const page of [...byPage.keys()].sort()) {
    const items = byPage.get(page).slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    md += `## ${code(page)}${items[0]?.pageTitle ? ` — ${collapse(items[0].pageTitle)}` : ''}\n\n`;
    let i = 0;
    for (const c of items) {
      i++;
      const kind = c.anchor?.type === 'range' ? 'text selection' : (c.anchor?.tag || 'element');
      const type = ALLOWED_TYPES.includes(c.type) ? c.type : 'change';
      const who = c.author === 'agent' ? `agent${c.authorName ? ' (' + collapse(c.authorName) + ')' : ''}` : 'user';
      const st = c.status && c.status !== 'open' ? ` · ${c.status}` : '';
      const box = (c.status === 'resolved' || c.status === 'rejected') ? '[x]' : '[ ]';
      md += `- ${box} **#${i}** ${code(type)} — on a ${kind} · by ${who}${st}\n`;
      if (c.id) md += `  - id: ${code(c.id)}\n`;
      if (c.sourceFile) md += `  - file: ${code(c.sourceFile)}\n`;
      const quote = collapse(c.anchor?.snippet || c.anchor?.rangeText || '');
      if (quote) md += `  - anchor text: "${quote.slice(0, 200).replace(/"/g, '”')}"\n`;
      if (c.anchor?.selector) md += `  - css: ${code(c.anchor.selector)}\n`;
      if (c.anchor?.attrSelector) md += `  - attr: ${code(c.anchor.attrSelector)}\n`;
      if (c.anchor?.xpath) md += `  - xpath: ${code(c.anchor.xpath)}\n`;
      md += `  - ${who}:\n${String(c.text || '').trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`;
      for (const r of c.thread || []) {
        const rwho = r.author === 'agent' ? `agent${r.authorName ? ' (' + collapse(r.authorName) + ')' : ''}` : 'user';
        md += `  - ↳ ${rwho}:\n${String(r.text || '').trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`;
      }
      md += `\n`;
    }
  }
  if (!comments.length) md += `_No comments yet._\n`;
  await writeFile(mdFile(dir), md);
}
