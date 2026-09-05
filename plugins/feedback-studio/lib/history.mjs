// Feedback Studio — version history for a reviewed Markdown file, plus a line diff.
//
// In --md mode the server keeps a copy of the reviewed .md file every time it
// changes on disk: when it is first served, when an agent edits it while the
// reviewer watches, and at the end of a processing batch. The reviewer can then
// list the versions, see what changed between any two of them, and put an older
// one back. This module owns that on-disk store and the diff it reports.
//
// It has no DOM and knows nothing about HTTP, so both the server and the tests
// use the same code.
//
// On disk, under <dataDir>/history/<slug>/:
//   index.json  { file, versions: [ { n, at, hash, bytes, lines, reason,
//                                     commentId, resolved, added, removed } ] }
//   <n>.md      the content of version n, byte for byte as it was given
//
// Notes on the rules this module keeps:
//   - A version number is never reused. Pruning drops old entries; the counter
//     keeps going up from the highest number ever written.
//   - Version 1 (the copy taken when the file was first served) is never pruned,
//     so there is always something to compare the current file against.
//   - Content files are written first, the index second. If the process stops in
//     between, the extra .md file is unused but nothing in the index points at a
//     file that is missing.
//   - A missing history folder is not an error: listing returns an empty list and
//     reading a version returns null. A corrupt index.json IS an error and throws
//     with code ECORRUPT, the same way readComments does in store.mjs — treating
//     it as empty would let the next write throw away real history.
//   - There is no lockfile. Like meta.json in store.mjs, the history of one file
//     is written by one server process at a time.
//
// Lines are split on /\r?\n/ and a trailing newline does not count as an extra
// empty line. So the same text saved with CRLF and with LF diffs as unchanged,
// and a diff cannot express "a trailing newline was added". That is on purpose:
// line endings are a property of the file, not of the review.

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJson } from './store.mjs';

// At most this many versions are kept per file. Version 1 does not count against
// the pruning order — it is kept whatever happens.
const MAX_VERSIONS = 200;

// Why a copy was taken. Anything else a caller passes becomes 'manual'.
export const REASONS = ['opened', 'changed', 'batch', 'restore', 'manual'];

// Above this many edit steps the diff stops looking for the shortest answer and
// reports the changed part as "all of these lines went, all of those arrived".
// Real documents never come close; this only bounds the work on two files that
// have nothing in common.
const MAX_EDIT_STEPS = 2000;

// ---------- small helpers ----------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Path separators are written as forward slashes, so the same file reached as
// "docs\a.md" and as "docs/a.md" keeps one history folder.
const normFile = (file) => String(file == null ? '' : file).replace(/\\/g, '/');

const toBuffer = (content) =>
  Buffer.isBuffer(content) ? content : Buffer.from(String(content == null ? '' : content), 'utf-8');

export function splitLines(text) {
  const s = String(text == null ? '' : text);
  if (s === '') return [];
  const parts = s.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop(); // a trailing newline is not a line
  return parts;
}

export const countLines = (text) => splitLines(text).length;

function corrupt(message) {
  const err = new Error(message);
  err.code = 'ECORRUPT';
  return err;
}

// ---------- where the files live ----------

// A folder name derived from the file path: lower case, anything outside
// [a-z0-9._-] becomes a dash, runs collapsed, trimmed, cut to 80 characters, and
// the first 8 characters of the path's sha256 appended so two different paths
// that reduce to the same name still get their own folder. Never contains ".."
// or a path separator, so it cannot point outside the history folder.
export function slugFor(file) {
  const norm = normFile(file);
  const hash = sha256(Buffer.from(norm, 'utf-8')).slice(0, 8);
  const body = norm
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 80)
    .replace(/[-.]+$/, '');
  return (body || 'file') + '-' + hash;
}

const folderFor = (dataDir, file) => path.join(dataDir, 'history', slugFor(file));
const indexPath = (dataDir, file) => path.join(folderFor(dataDir, file), 'index.json');
const versionPath = (dataDir, file, n) => path.join(folderFor(dataDir, file), n + '.md');

// ---------- diff ----------

// Give every distinct line a number, so the inner loop compares integers.
function intern(a, b) {
  const ids = new Map();
  const map = (arr) => {
    const out = new Int32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let id = ids.get(arr[i]);
      if (id === undefined) { id = ids.size; ids.set(arr[i], id); }
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

// Myers' O(ND) diff over the two interned line arrays. Returns the edit script in
// order, or null when it needs more than MAX_EDIT_STEPS steps.
function myers(ia, ib, a, b) {
  const n = ia.length, m = ib.length;
  const maxD = Math.min(n + m, MAX_EDIT_STEPS);
  const off = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace = [];
  let found = -1;

  outer:
  for (let d = 0; d <= maxD; d++) {
    // The state before this step. Only |k| <= d-1 is filled in, so the slice
    // covering [-d, d] is enough; inside it, k sits at index k + d.
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && ia[x] === ib[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found < 0) return null;

  // Walk the trace back from the end, collecting the moves in reverse.
  const rev = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const row = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && row[k - 1 + d] < row[k + 1 + d])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = row[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; rev.push({ op: '=', text: a[x] }); }
    if (x === prevX) { y--; rev.push({ op: '+', text: b[y] }); }
    else { x--; rev.push({ op: '-', text: a[x] }); }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; rev.push({ op: '=', text: a[x] }); }
  rev.reverse();
  return rev;
}

// Inside one changed block, list the removed lines before the added ones.
function orderBlocks(ops) {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op === '=') { out.push(ops[i]); continue; }
    let j = i;
    while (j < ops.length && ops[j].op !== '=') j++;
    for (let k = i; k < j; k++) if (ops[k].op === '-') out.push(ops[k]);
    for (let k = i; k < j; k++) if (ops[k].op === '+') out.push(ops[k]);
    i = j - 1;
  }
  return out;
}

// The part of the diff between the shared start and the shared end.
function diffMiddle(a, b) {
  if (!a.length && !b.length) return [];
  if (!a.length) return b.map((text) => ({ op: '+', text }));
  if (!b.length) return a.map((text) => ({ op: '-', text }));
  const [ia, ib] = intern(a, b);
  const script = myers(ia, ib, a, b);
  if (script) return orderBlocks(script);
  // Too far apart to be worth the shortest answer: report the whole block.
  return a.map((text) => ({ op: '-', text })).concat(b.map((text) => ({ op: '+', text })));
}

// Line diff of two strings. Unchanged lines come back as '=', removed as '-' and
// added as '+', in one merged sequence; inside a changed block the removals come
// first. Replaying '=' plus '+' rebuilds b, replaying '=' plus '-' rebuilds a.
export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  const shortest = Math.min(A.length, B.length);
  let start = 0;
  while (start < shortest && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: '=', text: A[i] });
  for (const o of diffMiddle(A.slice(start, endA), B.slice(start, endB))) ops.push(o);
  for (let i = endA; i < A.length; i++) ops.push({ op: '=', text: A[i] });
  return ops;
}

export function diffStats(ops) {
  let added = 0, removed = 0, same = 0;
  for (const o of ops || []) {
    if (o.op === '+') added++;
    else if (o.op === '-') removed++;
    else same++;
  }
  return { added, removed, same };
}

// Group the flat op list the way a unified diff does: each run of changes plus
// `context` unchanged lines on either side. Runs that touch or overlap after
// their context is added become one hunk. fromStart and toStart are 1-based line
// numbers in a and b of the first line of the hunk; when a hunk opens with an
// added line, fromStart is the line in a the addition sits before.
export function hunks(ops, context = 3) {
  const list = Array.isArray(ops) ? ops : [];
  const ctx = Number.isFinite(Number(context)) ? Math.max(0, Math.floor(Number(context))) : 3;
  const aAt = new Array(list.length);
  const bAt = new Array(list.length);
  let ai = 1, bi = 1;
  for (let i = 0; i < list.length; i++) {
    aAt[i] = ai; bAt[i] = bi;
    if (list[i].op !== '+') ai++;
    if (list[i].op !== '-') bi++;
  }
  const groups = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].op === '=') continue;
    let j = i;
    while (j + 1 < list.length && list[j + 1].op !== '=') j++;
    const s = Math.max(0, i - ctx);
    const e = Math.min(list.length - 1, j + ctx);
    const last = groups.length ? groups[groups.length - 1] : null;
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else groups.push([s, e]);
    i = j;
  }
  return groups.map(([s, e]) => ({
    fromStart: aAt[s],
    toStart: bAt[s],
    ops: list.slice(s, e + 1),
  }));
}

// ---------- reading the store ----------

export async function listVersions(dataDir, file) {
  const name = normFile(file);
  let raw;
  try {
    raw = await readFile(indexPath(dataDir, file), 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { file: name, versions: [] };
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw corrupt('history index.json is not valid JSON (' + e.message + ')');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.versions)) {
    throw corrupt('history index.json parses but has no "versions" array — refusing to treat it as empty');
  }
  return { file: typeof parsed.file === 'string' && parsed.file ? parsed.file : name, versions: parsed.versions };
}

async function readContent(dataDir, file, n) {
  try {
    return await readFile(versionPath(dataDir, file, n), 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

export async function readVersion(dataDir, file, n) {
  const num = Number(n);
  if (!Number.isInteger(num)) return null;
  const { versions } = await listVersions(dataDir, file);
  const entry = versions.find((v) => v && Number(v.n) === num);
  if (!entry) return null;
  const content = await readContent(dataDir, file, num);
  if (content == null) return null;
  return { ...entry, content };
}

export async function latestVersion(dataDir, file) {
  const { versions } = await listVersions(dataDir, file);
  return versions.length ? versions[versions.length - 1] : null;
}

export async function diffVersions(dataDir, file, from, to) {
  const a = await readVersion(dataDir, file, from);
  const b = await readVersion(dataDir, file, to);
  if (!a || !b) return null;
  const ops = diffLines(a.content, b.content);
  const strip = (v) => { const { content, ...rest } = v; return rest; };
  return { from: strip(a), to: strip(b), ops, stats: diffStats(ops), hunks: hunks(ops) };
}

// ---------- writing a snapshot ----------

// Renaming over a file that OneDrive, a virus scanner or a folder watcher holds
// open fails on Windows with EPERM even though nothing is wrong. Retry a few
// times, the same way store.mjs does.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function renameReplace(from, to) {
  for (let i = 0; ; i++) {
    try { return await rename(from, to); }
    catch (e) {
      if (i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await sleep(30 * (i + 1));
    }
  }
}

async function writeAtomic(filePath, buf) {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, buf);
  try {
    await renameReplace(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const capped = (v, n) => String(v == null ? '' : v).slice(0, n);

function cleanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    reason: REASONS.includes(m.reason) ? m.reason : 'manual',
    commentId: capped(m.commentId, 120),
    resolved: Array.isArray(m.resolved)
      ? m.resolved.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => capped(x, 120)).slice(0, 200)
      : [],
  };
}

// Keep a copy of the file's current content. When the content is the same as the
// last version, nothing is written and the last version comes back with
// changed:false — note that this compares against the LAST version only, so going
// back to older content does record a new version.
export async function recordSnapshot(dataDir, file, content, meta = {}) {
  const buf = toBuffer(content);
  const text = buf.toString('utf-8');
  const hash = sha256(buf);
  const { versions } = await listVersions(dataDir, file); // throws ECORRUPT on a broken index
  const last = versions.length ? versions[versions.length - 1] : null;
  if (last && last.hash === hash) return { changed: false, version: last };

  let added = 0, removed = 0;
  if (last) {
    const prev = await readContent(dataDir, file, last.n);
    if (prev != null) {
      const s = diffStats(diffLines(prev, text));
      added = s.added;
      removed = s.removed;
    }
  }

  const { reason, commentId, resolved } = cleanMeta(meta);
  // One past the highest number ever used, not one past the last entry, so a
  // hand-edited or reordered index still gets a number that was never taken.
  let highest = 0;
  for (const v of versions) {
    const num = v && Number(v.n);
    if (Number.isInteger(num) && num > highest) highest = num;
  }
  const n = highest + 1;
  const entry = {
    n,
    at: new Date().toISOString(),
    hash,
    bytes: buf.length,
    lines: countLines(text),
    reason,
    commentId,
    resolved,
    added,
    removed,
  };

  const dir = folderFor(dataDir, file);
  await mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, n + '.md'), buf);

  const next = versions.concat([entry]);
  const dropped = [];
  while (next.length > MAX_VERSIONS) {
    const at = next.findIndex((v) => Number(v.n) !== 1);
    if (at < 0) break;
    dropped.push(Number(next[at].n));
    next.splice(at, 1);
  }
  // The index goes down after the content file and before the old files are
  // removed, so the index never names a version whose file is already gone.
  await writeJson(path.join(dir, 'index.json'), { file: normFile(file), versions: next });
  for (const dn of dropped) await unlink(path.join(dir, dn + '.md')).catch(() => {});

  return { changed: true, version: entry };
}
