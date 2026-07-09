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

import { readFile, writeFile, mkdir, rename, open, unlink, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- schema constants (the contract) ----------
export const SCHEMA_VERSION = 6;
export const FILE_VERSION = 1;

// Comment types decide how much latitude the agent gets. Web pages and Markdown
// documents use different verbs; `question` is UNIVERSAL — valid in either mode
// ("Ask the page": the agent answers, doesn't edit). The union (deduped) is what
// the file may legally contain.
export const WEB_TYPES = ['fix', 'change', 'improve'];
export const MD_TYPES = ['comment', 'rephrase', 'expand', 'delete', 'question'];
export const UNIVERSAL_TYPES = ['question'];
export const ALLOWED_TYPES = [...new Set([...WEB_TYPES, ...MD_TYPES, ...UNIVERSAL_TYPES])];
export const STATUSES = ['open', 'approved', 'rejected', 'resolved'];
export const AUTONOMY = ['auto', 'review'];

const ANCHOR_KEYS = ['type', 'selector', 'attrSelector', 'xpath', 'tag', 'id', 'snippet', 'rangeText'];
const TEXT_MAX = 10000;

// Tweak Mode (web only): properties a comment's `edits[]` may carry. The overlay
// exposes a subset as live knobs; the whitelist is slightly wider so agents can
// author edits too. Values are opaque CSS values ("16px", "#0f766e", "16px 24px") —
// they are DATA for the processing agent, never re-injected as live CSS by us.
export const TWEAKABLE_PROPS = [
  'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'color', 'background-color', 'padding', 'margin', 'border-radius', 'opacity', 'gap',
];
const EDITS_MAX = 16;

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
// `question` is UNIVERSAL — a reviewer can ask about any element or line in either
// mode ("Ask the page"), and the agent answers in a thread reply rather than editing.
export function coerceType(type, mode) {
  if (UNIVERSAL_TYPES.includes(type)) return type;
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

// Edit-in-place text: the user retyped the element's text directly on the page;
// {before, after} is the exact wording change. Whitespace is collapsed on both
// sides (HTML rendering already collapsed it), an unchanged or empty result is
// no edit at all.
export function sanitizeTextEdit(t) {
  if (!t || typeof t !== 'object') return null;
  const collapse = (v) => str(v, 2000).replace(/\s+/g, ' ').trim();
  const before = collapse(t.before);
  const after = collapse(t.after);
  if (!after || after === before) return null;
  return { before, after };
}

// Image replacement (web only): the reviewer picked an <img> (or a background-
// image element) and chose a new local file, framed live on the page. This is
// the METADATA — target kind, fit/position/size, optional crop, alt. The actual
// image bytes are staged separately via the media upload route, which sets
// `.media` server-side (never client-trusted). Numbers are clamped and the
// position string is char-blacklisted so nothing breaks out of FEEDBACK.md or a
// CSS value the agent copies.
const IMG_FITS = ['cover', 'contain', 'fill', 'none', 'scale-down'];
export function sanitizeImageReplace(input) {
  if (!input || typeof input !== 'object') return null;
  const target = input.target === 'background' ? 'background' : 'img';
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : undefined;
  };
  const out = { target };
  if (IMG_FITS.includes(input.fit)) out.fit = input.fit;
  // e.g. "50% 20%", "center", "left top" — short, no CSS-breaking characters
  const pos = str(input.position, 40).trim();
  if (pos && !/[;{}<>"'`\\()]/.test(pos)) out.position = pos;
  const w = num(input.w, 1, 20000); if (w !== undefined) out.w = w;
  const h = num(input.h, 1, 20000); if (h !== undefined) out.h = h;
  const nw = num(input.natW, 1, 100000); if (nw !== undefined) out.natW = nw;
  const nh = num(input.natH, 1, 100000); if (nh !== undefined) out.natH = nh;
  if (input.crop && typeof input.crop === 'object') {
    const c = input.crop;
    const cx = num(c.x, 0, 100000), cy = num(c.y, 0, 100000), cw = num(c.w, 1, 100000), ch = num(c.h, 1, 100000);
    if (cx !== undefined && cy !== undefined && cw !== undefined && ch !== undefined) out.crop = { x: cx, y: cy, w: cw, h: ch };
  }
  // alt is written verbatim into an <img alt="…"> by the agent, so strip the
  // characters that could break out of the attribute or inject a tag/handler
  // (the same reason `position` is blacklisted above).
  const alt = str(input.alt, 300).replace(/[\r\n]+/g, ' ').replace(/["'<>`\\]/g, '').trim();
  if (alt) out.alt = alt;
  // `media` is set only by the server upload route; ignore any client value here.
  return out;
}

// Keep only well-formed {prop, from, to} deltas on whitelisted properties.
// One entry per property, no unchanged/empty targets, and no characters that
// could break out of the contexts the values are rendered into (FEEDBACK.md
// code spans, HTML-escaped panel chips).
export function sanitizeEdits(edits) {
  if (!Array.isArray(edits)) return [];
  const out = [];
  const seen = new Set();
  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    const prop = String(e.prop || '').toLowerCase().trim();
    if (!TWEAKABLE_PROPS.includes(prop) || seen.has(prop)) continue;
    const from = str(e.from, 60).trim();
    const to = str(e.to, 60).trim();
    if (!to || to === from) continue;
    if (/[;{}<>`\\]/.test(from + to)) continue;
    seen.add(prop);
    out.push({ prop, from, to });
    if (out.length >= EDITS_MAX) break;
  }
  return out;
}

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
    // Tweak Mode deltas are a web concept (live CSS knobs); md comments never carry them.
    edits: mode === 'web' ? sanitizeEdits(input.edits) : [],
    // Edit-in-place text works in BOTH modes (in md it's the killer feature:
    // the agent applies the exact wording to the sourceFile).
    textEdit: sanitizeTextEdit(input.textEdit),
    // Image replacement is a web concept (swap an <img>/background); the media
    // path is attached later by the upload route (like `shot`).
    imageReplace: mode === 'web' ? sanitizeImageReplace(input.imageReplace) : null,
    author: input.author === 'agent' ? 'agent' : 'user',
    authorName: str(input.authorName, 60),
    // Provenance: how the comment was created. 'narration' = auto-drafted from a
    // "Talk me through it" session, so the agent can weight it (spoken, may be
    // looser wording) and a replay can link back. Absent for a normal comment.
    via: input.via === 'narration' ? 'narration' : undefined,
    thread: [],
    autonomy: AUTONOMY.includes(input.autonomy) ? input.autonomy : 'review',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------- variants (agent-proposed alternatives, previewed on the page) ----------
// A reply may carry up to VARIANTS_MAX design alternatives for the pinned
// element. Their html is INJECTED INTO THE HOST PAGE by the overlay's preview
// switcher, so it is sanitized here, at write time, for every writer (HTTP
// server and MCP alike) — stricter than the md renderer's pass because the
// destination is a live DOM, not an isolated document.
const VARIANTS_MAX = 4;
const VARIANT_HTML_MAX = 20000;

// HTML-entity-decode + strip control/whitespace characters, so an encoded or
// split scheme (`&#106;avascript:`, `java\tscript:`) can't hide from the check —
// the browser's parser would decode it at render time, so WE must decode it at
// test time. Named subset covers the entities usable inside a URL scheme.
const NAMED_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', tab: '\t', newline: '\n', colon: ':', sol: '/' };
export function decodeEntities(v) {
  return String(v)
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#(\d+);?/g, (m, d) => { const c = parseInt(d, 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED_ENT[n.toLowerCase()] != null ? NAMED_ENT[n.toLowerCase()] : m));
}
// True if an attribute value resolves (after entity-decode + whitespace strip)
// to a script-ish scheme. Exported so the Markdown renderer defends against
// encoded/split `javascript:` the same way the variant sanitizer does.
export function schemeIsEvil(rawAttrValue) {
  const v = decodeEntities(rawAttrValue).replace(/[\u0000-\u0020\u00a0]+/g, '').toLowerCase();
  return /(?:javascript|vbscript|data:text\/html)/.test(v);
}
// Strip external url(...) from an (entity-decoded) inline style: a background
// image is an eager-loading exfil beacon for anyone who merely PREVIEWS the
// variant. Fragment refs and inline data:image stay; expression()/@import go.
function stripCssBeacons(css) {
  return String(css)
    .replace(/url\s*\(\s*(['"]?)\s*(?!#|data:image\/)[^)]*\)/gi, 'none')
    .replace(/@import/gi, '')
    .replace(/expression\s*\(/gi, 'none(');
}

export function sanitizeVariantHtml(html) {
  return String(html == null ? '' : html)
    .slice(0, VARIANT_HTML_MAX)
    // drop script/style/svg-script containers with their contents
    .replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // drop anything that can execute, frame, redirect, or submit
    .replace(/<\/?(script|style|iframe|object|embed|base|meta|form|link|frame|frameset)\b[^>]*>/gi, '')
    // strip inline event handlers ('/' counts as attribute whitespace in HTML5)
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, '')
    // neutralise script-ish URLs (checked entity-decoded + whitespace-stripped)
    .replace(/\b(href|src|xlink:href|formaction|action|srcdoc)\s*=\s*"([^"]*)"/gi, (m, attr, val) =>
      schemeIsEvil(val) || attr.toLowerCase() === 'srcdoc' ? attr + '="#"' : m)
    .replace(/\b(href|src|xlink:href|formaction|action|srcdoc)\s*=\s*'([^']*)'/gi, (m, attr, val) =>
      schemeIsEvil(val) || attr.toLowerCase() === 'srcdoc' ? attr + "='#'" : m)
    // inline styles are kept (variants need them) minus network beacons
    .replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, q, dq, sq) => {
      const cleaned = stripCssBeacons(decodeEntities(dq != null ? dq : sq));
      return 'style="' + cleaned.replace(/"/g, '&quot;') + '"';
    })
    // eager-loading resource attributes with an ABSOLUTE (external) URL are
    // preview-time beacons — blank them. Relative + data: stay. The overlay's
    // parser scrub is the authoritative layer; this is write-time defense in depth.
    .replace(/\b(src|poster|srcset)\s*=\s*"([^"]*)"/gi, (m, attr, val) =>
      /(?:^|,|\s)\s*(?:https?:)?\/\//i.test(val) ? attr + '=""' : m)
    .replace(/\b(src|poster|srcset)\s*=\s*'([^']*)'/gi, (m, attr, val) =>
      /(?:^|,|\s)\s*(?:https?:)?\/\//i.test(val) ? attr + "=''" : m);
}
// NOTE: this write-time pass is one of TWO independent layers — the overlay
// re-scrubs through a real HTML parser (inert <template>, decoded attributes)
// immediately before injection. Regexes over raw markup cannot fully reason
// about encoding; the parser-side scrub is the authoritative gate.

export function sanitizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  const out = [];
  for (const v of variants) {
    if (!v || typeof v !== 'object') continue;
    const html = sanitizeVariantHtml(v.html).trim();
    if (!html) continue;
    out.push({
      label: str(v.label, 40).trim() || String.fromCharCode(65 + out.length), // A, B, C…
      html,
      note: str(v.note, 300).trim(),
    });
    if (out.length >= VARIANTS_MAX) break;
  }
  return out;
}

// The user's choice among a reply's variants: {of: <replyId>, index, label}.
export function sanitizePick(p) {
  if (!p || typeof p !== 'object') return null;
  const index = Number(p.index);
  if (!Number.isInteger(index) || index < 0 || index >= VARIANTS_MAX) return null;
  return { of: str(p.of, 80), index, label: str(p.label, 40) };
}

export function makeReply(input = {}) {
  const variants = sanitizeVariants(input.variants);
  const pick = sanitizePick(input.pick);
  return {
    id: newId('r'),
    author: input.author === 'agent' ? 'agent' : 'user',
    authorName: str(input.authorName, 60),
    text: str(input.text, TEXT_MAX).trim(),
    ...(variants.length ? { variants } : {}),
    ...(pick ? { pick } : {}),
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

// Atomic replace with a short retry: on Windows, rename() over a file an
// antivirus scanner / OneDrive sync / directory watcher briefly holds open
// fails with EPERM (or EACCES/EBUSY) even though nothing is wrong — retrying a
// beat later succeeds. Non-transient errors still throw immediately.
async function renameReplace(from, to) {
  for (let i = 0; ; i++) {
    try { return await rename(from, to); }
    catch (e) {
      if (i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await sleep(30 * (i + 1));
    }
  }
}

// Atomic JSON write (temp file + rename) for any file — reused by writeComments
// and by the per-site meta.json. No lock: callers that need read-modify-write use
// `mutate`; meta.json is a whole-file overwrite owned by one server instance.
export async function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + (_writeSeq++);
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  try {
    await renameReplace(tmp, filePath); // atomic replace
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function writeComments(dir, comments, opts = {}) {
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify({ version: FILE_VERSION, updatedAt: new Date().toISOString(), comments }, null, 2);
  const tmp = path.join(dir, 'comments.json.tmp-' + process.pid + '-' + (_writeSeq++));
  await writeFile(tmp, body);
  try {
    await renameReplace(tmp, dataFile(dir)); // atomic replace
  } catch (e) {
    await unlink(tmp).catch(() => {}); // don't leave orphan tmp files behind
    throw e;
  }
  if (opts.exportMd !== false) {
    await exportMarkdown(dir, comments).catch(() => {}); // a readable mirror; best-effort
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A held lock is only "stale" (stealable) after LOCK_STALE_MS with no mtime
// bump. mutate() refreshes the mtime every LOCK_STALE_MS/2 while it works, so a
// legitimately slow write (large file, OneDrive stall, long export) can't have
// its LIVE lock stolen by a waiter — only a genuinely abandoned one is.
const LOCK_STALE_MS = 15000;

async function acquireLock(dir, { retries = 100, wait = 50, staleMs = LOCK_STALE_MS } = {}) {
  const lp = lockFile(dir);
  // Unique per acquisition (not just the pid): release compares this before
  // unlinking, so a process resumed after a long OS sleep — whose "stale" lock a
  // waiter legitimately stole and re-created — can't delete the new holder's lock.
  const token = process.pid + ':' + crypto.randomUUID();
  for (let i = 0; i < retries; i++) {
    try {
      const fh = await open(lp, 'wx');
      await fh.writeFile(token);
      await fh.close();
      return { lp, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Steal an abandoned lock (a process that crashed mid-write). Steal by
      // RENAME, not unlink: two waiters can both see the lock as stale, but only
      // one rename succeeds — with unlink, the loser could delete a fresh lock
      // the winner had already re-created, letting both proceed.
      try {
        const st = await stat(lp);
        if (Date.now() - st.mtimeMs > staleMs) {
          const stale = lp + '.stale-' + process.pid;
          try { await rename(lp, stale); await unlink(stale).catch(() => {}); } catch (_) { /* another waiter won the steal */ }
          continue;
        }
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
  const { lp, token } = await acquireLock(dir);
  // Heartbeat: keep the lock's mtime fresh so a slow hold isn't judged stale and
  // stolen. Best-effort (a missed bump never crashes — cf. proper-lockfile's
  // onCompromised, which misfires after sleep); unref'd so it can't hold the
  // process open.
  const beat = setInterval(() => { const t = Date.now() / 1000; utimes(lp, t, t).catch(() => {}); }, LOCK_STALE_MS / 2);
  if (beat.unref) beat.unref();
  try {
    const current = await readComments(dir);
    const out = await fn(current);
    const next = out && Array.isArray(out.comments) ? out.comments : current;
    await writeComments(dir, next);
    return out ? out.value : undefined;
  } finally {
    clearInterval(beat);
    // Release only OUR lock: after an OS sleep the lock may have been (rightly)
    // stolen and re-created by a waiter — deleting that one would let a third
    // writer in alongside them.
    try { if (await readFile(lp, 'utf-8') === token) await unlink(lp); } catch (e) {}
  }
}

// ---------- FEEDBACK.md (readable mirror) ----------
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Escape a value for use inside an inline `code span` (backticks would break it).
const code = (s) => '`' + String(s == null ? '' : s).replace(/`/g, 'ˋ') + '`';

export async function exportMarkdown(dir, comments) {
  const d = dataDirDisplay(dir); // real data-dir path (e.g. sites/marketing/.feedback), not a literal
  const byPage = new Map();
  for (const c of comments) {
    const key = c.page || '/';
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(c);
  }
  const open = comments.filter((c) => c.status !== 'resolved').length;
  let md = `# Feedback export\n\n`;
  md += `_Generated from \`${d}/comments.json\` (the source of truth). Read-only, human-glance mirror: do not edit or act off this file, act off \`comments.json\` (or the MCP tools)._\n\n`;
  md += `_Generated ${new Date().toISOString()} — ${comments.length} comment(s): ${open} open, ${comments.length - open} resolved._\n\n`;
  md += `> Each comment has a TYPE that sets how much latitude you have: \`fix\` = reproduce and patch what is broken; \`change\` = apply near-verbatim, do not redesign; \`improve\` = rewrite or redesign with judgement. Each anchor carries a css selector, an attr/xpath fallback, and a quoted snippet so the element can be re-found. Resolve the element with confidence; if you cannot locate it confidently, do NOT edit a guess — flag it for a re-pin.\n>\n> \`tweak\` lines are exact CSS deltas the user dialled in live on the element (Tweak Mode). Apply them near-verbatim, translated to the project's styling idiom (stylesheet rule, utility class, or design token) — the target values are not suggestions, the *representation* is yours to choose. \`text edit\` lines are the user retyping the element's text in place: apply the exact after-wording at the anchored location (whitespace-flexible match on the before-text; in Markdown edit the \`sourceFile\`). If the before-text no longer matches, do NOT guess — leave it open for a re-pin.\n>\n> Comments are a two-way conversation. Some are authored \`by user\`, some \`by agent\` (a proposal/annotation you or another skill left on a component). Each can have a reply thread (lines marked \`↳\`). Statuses: \`open\` (needs work/decision), \`approved\` (the user said go ahead — implement it), \`rejected\` (do not), \`resolved\` (done). Implement approved items, reply to ask questions, and set the status as you go.\n\n`;
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
      md += `- ${box} **#${i}** ${code(type)} — on a ${kind} · by ${who}${c.via === 'narration' ? ' · spoken' : ''}${st}\n`;
      if (c.id) md += `  - id: ${code(c.id)}\n`;
      if (c.sourceFile) md += `  - file: ${code(c.sourceFile)}\n`;
      const quote = collapse(c.anchor?.snippet || c.anchor?.rangeText || '');
      if (quote) md += `  - anchor text: "${quote.slice(0, 200).replace(/"/g, '”')}"\n`;
      if (c.anchor?.selector) md += `  - css: ${code(c.anchor.selector)}\n`;
      if (c.anchor?.attrSelector) md += `  - attr: ${code(c.anchor.attrSelector)}\n`;
      if (c.anchor?.xpath) md += `  - xpath: ${code(c.anchor.xpath)}\n`;
      for (const e of (Array.isArray(c.edits) ? c.edits : [])) {
        md += `  - tweak: ${code(e.prop)} ${code(e.from || '?')} → ${code(e.to)}\n`;
      }
      if (c.textEdit && c.textEdit.after) {
        md += `  - text edit: "${collapse(c.textEdit.before).replace(/"/g, '”')}" → "${collapse(c.textEdit.after).replace(/"/g, '”')}"\n`;
      }
      if (c.shot) md += `  - shot: ${code(c.shot)} (what the reviewer saw at pin time — view it before editing if unsure)\n`;
      if (c.imageReplace && c.imageReplace.media) {
        const ir = c.imageReplace;
        const bits = [ir.fit ? `fit: ${ir.fit}` : '', ir.position ? `pos: ${ir.position}` : '', ir.w ? `${ir.w}×${ir.h || '?'}` : '', ir.crop ? 'cropped' : '', ir.alt ? `alt: "${collapse(ir.alt)}"` : ''].filter(Boolean).join(', ');
        md += `  - image replace: ${ir.target === 'background' ? 'background of' : 'src of'} this element → new image at ${code(d + '/' + ir.media)}${bits ? ` (${bits})` : ''}\n`;
      }
      if (c.text || !((Array.isArray(c.edits) && c.edits.length) || (c.textEdit && c.textEdit.after) || (c.imageReplace && c.imageReplace.media))) {
        md += `  - ${who}:\n${String(c.text || '').trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`;
      }
      for (const r of c.thread || []) {
        const rwho = r.author === 'agent' ? `agent${r.authorName ? ' (' + collapse(r.authorName) + ')' : ''}` : 'user';
        md += `  - ↳ ${rwho}:\n${String(r.text || '').trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`;
        for (const v of r.variants || []) {
          md += `    - variant ${code(v.label)}${v.note ? ` — ${collapse(v.note)}` : ''} (html in comments.json)\n`;
        }
        if (r.pick) md += `    - PICKED: variant ${code(r.pick.label || String(r.pick.index))} of reply ${code(r.pick.of)} — implement that one\n`;
      }
      md += `\n`;
    }
  }
  if (!comments.length) md += `_No comments yet._\n`;
  await writeFile(mdFile(dir), md);
}

// ---------- HOW-TO-PROCESS.md (agent instructions, written beside the data) ----------
// A self-contained, agent-ready guide for processing the comments. It exists so an
// agent WITHOUT the Claude Code plugin (e.g. the MCP server wired into Claude/Codex,
// no skill installed) still has the workflow next to the data. Resolve paths are
// MCP-first to match that setup. Regenerated on each server start, like FEEDBACK.md.
const processFile = (dir) => path.join(dir, 'HOW-TO-PROCESS.md');

// Display path for THIS data dir, relative to the agent's cwd (the repo root), so
// the guide points at the real location — `.feedback` for the default single site,
// `sites/marketing/.feedback` for a multi-site setup. Falls back to the absolute
// path if the dir sits outside cwd.
function dataDirDisplay(dir) {
  let rel = path.relative(process.cwd(), dir);
  if (!rel || rel.startsWith('..')) rel = dir;
  return rel.split(path.sep).join('/');
}

function buildProcessInstructions(dir, label) {
  const d = dataDirDisplay(dir);
  return `# How to process this feedback

_Generated by Feedback Studio. It explains how to apply the review comments in
\`${d}/comments.json\`. Safe to read; regenerated each run._
${label ? `\n**This is the _${label}_ site.** Its feedback lives in \`${d}/\`. In a repo with several
sites, each site has its OWN data dir like this one (with its own \`meta.json\` label) — a comment,
screenshot or replacement image belongs to the site whose dir it lives in. Never mix them across
sites; process each site against its own \`${d}/comments.json\` and resolve there.\n` : ''}

**Trigger — PPF:** when the user says **PPF** (*Please Process Feedback*) — or plainly
"process the feedback" — do the following. (And yes, the *please* is on purpose: Feedback
Studio is polite to its agents. Be nice to the bots and they'll be nice to your codebase. ;-)

## 1. Read the comments

\`${d}/comments.json\` is the single source of truth. (\`${d}/FEEDBACK.md\` is a
read-only mirror — never act off it.) Prefer the **\`feedback-studio\` MCP tools** if they are
configured: \`list_comments\` to read them all, \`get_comment\` for one. Otherwise read the JSON
file directly.

Each comment has: \`page\`, \`type\`, \`anchor\` (a quoted \`snippet\` plus css \`selector\` /
\`attr\` / \`xpath\`), \`text\`, a reply \`thread\`, \`autonomy\`, and \`status\`. In Markdown mode it
also carries a \`sourceFile\`.

## 2. For each OPEN (or APPROVED) comment, grouped by page

**Locate the target with confidence.** Find the element by its quoted \`snippet\`, cross-checked
with the \`selector\`. **If you cannot identify the exact element (or, in Markdown, the exact
source line) with confidence, do NOT edit a guess** — leave the comment open and say it needs a
re-pin. A confident wrong edit is the worst outcome; silence beats it. A comment with a \`shot\`
field has a pin-time element screenshot at \`${d}/<shot path>\` — view the image when unsure;
it is exactly what the reviewer saw, and a mismatch with the element you located means re-pin.

**Act according to \`type\`:**
- Web — \`fix\`: reproduce the problem, then patch it. \`change\`: apply near-verbatim, no
  redesign. \`improve\`: rewrite/redesign with judgement, in the project's voice.
- Web comments may carry \`edits\` — exact CSS deltas from the overlay's live Tweak Mode
  (e.g. \`padding: 16px → 24px\`). The user already previewed these on the element: apply
  each delta near-verbatim, translated to the project's styling idiom (stylesheet rule,
  utility class, or design token).
- A comment may carry \`textEdit\` — \`{before, after}\` from the user retyping the element's
  text in place. Find \`before\` at the anchored location (match with flexible whitespace;
  the source may wrap lines or hold inline markup) and apply the exact \`after\` wording,
  preserving surrounding markup. In Markdown, edit the \`sourceFile\`. If \`before\` no longer
  matches there, do NOT guess — leave the comment open and ask for a re-pin.
- A web comment may carry \`imageReplace\` — a staged new image at \`${d}/<media path>\`
  (already downscaled) plus framing (\`target\`, \`fit\`, \`position\`, \`w\`/\`h\`, \`crop\`, \`alt\`).
  Copy the file into the project's image directory (infer from the element's current \`src\`,
  else \`public\`/\`assets\`/\`static\`/\`src\` under \`images\`/\`img\`/\`media\`), then repoint the
  element: \`target:"img"\` set \`src\` (+\`alt\`, drop stale \`srcset\`); \`target:"background"\`
  update the CSS \`background-image:url(...)\`. Apply \`fit\`/\`position\`/size as
  \`object-fit\`/\`object-position\`/width (or \`background-size\`/\`-position\`).
- For a vague \`improve\` ("make this pop", "give me options"), you may propose **variants**:
  reply with \`variants: [{label, html, note}]\` (2–3 self-contained alternatives of the
  element's markup, styles inlined). The user previews them ON the page and picks; the pick
  arrives as a reply with \`pick: {of, index, label}\` (and often status \`approved\`).
  Implement the picked variant with judgement — translate its inline styles into the
  project's idiom — then resolve. Never auto-apply a variant nobody picked.
- \`question\` (valid on web elements too, not only Markdown) — the reviewer is ASKING, not
  requesting a change ("what does this do?", "where's this defined?"). Answer in a thread
  reply, with a \`file:line\` source pointer when they ask where/why; don't edit, then resolve.
- Markdown — \`comment\` (address the note), \`rephrase\`, \`expand\`, \`delete\`, \`question\`
  (answer in a reply). Edit the **\`sourceFile\`**, never the throwaway rendered HTML.

Honour \`autonomy\`: \`review\` (default) = show the change first; \`auto\` = apply directly.

## 3. Record the outcome (keep the file the audit trail)

- **Resolve:** set the comment's status to \`resolved\` — MCP \`set_status\`; else, if the HTTP
  review server is running, \`PATCH /__feedback/api/comments/<id>\` with \`{"status":"resolved"}\`;
  else edit \`comments.json\` directly (keep it valid JSON, only when nothing else is writing).
- **Ask or explain:** add a \`reply\` to the comment's thread (MCP \`reply\`, or
  \`POST /__feedback/api/comments/<id>/reply\`).
- **Leave your own notes:** \`add_comment\` pins a comment for the user to approve.

## 4. Refresh, then summarise

After applying the batch, if the HTTP review server is running, \`POST /__feedback/api/reload\`
so open overlays reload themselves and show the edited page under the now-green pins (they
reload only when it's safe — a composer or in-progress edit defers it to a one-tap nudge).
Rebuild a static \`--dir\` first if the project has a build step. No server? Tell the user to reload.

Then report what changed, grouped by page (with \`file:line\` where you can), and list anything
left open and why (low-confidence anchor → needs a re-pin, or needs a decision).
`;
}

export async function exportProcessInstructions(dir, label = '') {
  await mkdir(dir, { recursive: true });
  await writeFile(processFile(dir), buildProcessInstructions(dir, label));
}

// ---------- AGENTS.md / CLAUDE.md seeding (opt-in, idempotent) ----------
// The short version of the workflow, appended to a project's agent-memory file so an
// agent that auto-reads it (Claude Code reads CLAUDE.md; Codex/Cursor read AGENTS.md)
// knows what to do without being pointed at HOW-TO-PROCESS.md each time. Guarded by a
// marker so re-running never duplicates it.
export const AGENTS_SNIPPET_MARKER = '<!-- feedback-studio:agents-snippet -->';
const AGENTS_SNIPPET_END = '<!-- /feedback-studio:agents-snippet -->';

export const AGENTS_SNIPPET_BODY = `## Feedback Studio

Visual review comments for this project's site(s) live under a \`.feedback/\` dir —
\`.feedback/comments.json\` is the source of truth (readable mirror \`.feedback/FEEDBACK.md\`; full
how-to \`.feedback/HOW-TO-PROCESS.md\`). They come from a local overlay where a human clicks/taps
an element, or selects Markdown text, and leaves a typed or spoken note.

**Multi-site repos:** if this repo has several sites, each runs its own session and keeps its own
\`.feedback/\` dir (one beside each site, each with a \`meta.json\` naming the site). Scan the repo
for \`.feedback/\` dirs, read each \`meta.json\` label, and process each site against its OWN
\`comments.json\` — a comment / screenshot / replacement image belongs to the site whose dir it
lives in; image paths resolve relative to that dir. Never mix them across sites.

When the user says **PPF** (*Please Process Feedback*) — or just "process the feedback":

- **Read** the open comments — use the \`feedback-studio\` MCP tools (\`list_comments\`,
  \`get_comment\`) if configured, else read the \`.feedback/comments.json\` for each site (the
  source of truth; never act off \`FEEDBACK.md\`).
- **Locate** each comment's target by its quoted anchor text, cross-checked with the selector,
  and **refuse rather than edit the wrong element.** Act per its \`type\` (web: \`fix\` / \`change\`
  / \`improve\`; Markdown: edit the \`sourceFile\`, not the rendered HTML). A \`question\` (either
  mode) is the user ASKING — **answer it in a reply with a \`file:line\` pointer, don't edit.**
  A comment with \`via:"narration"\` was spoken (wording may be looser). Present a diff.
- **Resolve** when done, and **leave a short reply** on each saying what you changed (plain,
  one sentence — the overlay's "walk me through the changes" reads it aloud): \`set_status\`
  (MCP), else PATCH \`/__feedback/api/comments/<id>\` \`{"status":"resolved"}\`, else edit the
  JSON. Use \`reply\` to answer/explain, \`add_comment\` to leave your own pins to approve.

(The *please* in PPF is deliberate — we're courteous to our coding agents. ;-)`;

// Append the snippet to `filePath` (creating it if absent) unless it's already there.
// Returns { seeded, created }: seeded=false means the marker was already present.
export async function seedAgentsFile(filePath) {
  let existing = '';
  let created = true;
  try { existing = await readFile(filePath, 'utf-8'); created = false; } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (existing.includes(AGENTS_SNIPPET_MARKER)) return { seeded: false, created: false };
  const block = `${AGENTS_SNIPPET_MARKER}\n${AGENTS_SNIPPET_BODY}\n${AGENTS_SNIPPET_END}\n`;
  const sep = existing.length && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  await writeFile(filePath, existing + sep + block);
  return { seeded: true, created };
}
