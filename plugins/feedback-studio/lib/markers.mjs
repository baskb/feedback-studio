// Feedback Studio — Markdown marker stamping.
//
// Writes comments into their source .md files as inline <!-- @FB ... --> markers,
// the portable+greppable convention from the original review tool. Each type maps
// to a verb; the marker lands on the source line holding the quoted text.
//
// Extracted from the HTTP server so it can be unit-tested: the riskiest thing
// this tool does is write into a user's source file, so the refuse-to-guess
// rules here are covered by test/markers.test.mjs.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readComments } from './store.mjs';

const mdNorm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Every marker this file ever writes, so a line can be read without them. The
// text inside a marker is escaped by `fbMarker` so it can never contain `-->`,
// which makes the lazy match exact. Used with `match`/`replace` only (both reset
// `lastIndex`), never with the stateful `test`/`exec`.
const MARKER_G = /<!--\s*@FB[\s\S]*?-->/g;

// Read the tag off one marker: its verb suffix ('' | '-DELETE' | '-EXPAND' | '-Q')
// and the comment id it carries, if any. Markers written before 1.0.1 have no id.
function parseMarker(m) {
  const hit = /^<!--\s*@FB(-[A-Z]+)?(#[^\s:]+)?/.exec(m);
  return hit ? { verb: hit[1] || '', id: hit[2] ? hit[2].slice(1) : '' } : null;
}

// A file written on Windows is usually CRLF throughout. Joining its lines with
// bare "\n" would rewrite every line ending in the user's source file and make
// the diff of one stamped marker look like the whole file changed.
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length; // includes the CRLF ones
  return crlf * 2 > lf ? '\r\n' : '\n';        // more CRLF than bare LF
}

// A path that stays inside `root` (no traversal escape via ..).
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// The marker carries the comment's id right after the @FB tag, so a stamped line
// can be traced back to `comments.json` and so re-stamping an edited comment can
// find and replace its own marker instead of adding a second one. A comment
// without an id (older data, or a hand-built object) simply gets no `#` part.
export function fbMarker(c) {
  const t = mdNorm(c.text).replace(/--+>/g, '--&gt;').replace(/--/g, '–');
  const id = c && c.id ? '#' + c.id : '';
  switch (c.type) {
    case 'delete': return `<!-- @FB-DELETE${id}${t ? ': ' + t : ''} -->`;
    case 'expand': return `<!-- @FB-EXPAND${id}${t ? ': ' + t : ''} -->`;
    case 'question': return `<!-- @FB-Q${id}${t ? ': ' + t : ''} -->`;
    case 'rephrase': return `<!-- @FB${id}: rephrase as "${t.replace(/"/g, '\\"')}" -->`;
    default: return `<!-- @FB${id}${t ? ': ' + t : ''} -->`; // comment + any web type
  }
}

// Stamp every still-actionable Markdown comment into its source file.
// Refuse-to-guess rules (the contract):
//   - only `open` / `approved` comments are stamped — `resolved` is done and
//     `rejected` means "do not implement", so neither belongs in the source;
//   - the quoted snippet must match exactly ONE source line. Zero matches or
//     several matches → the comment is skipped (counted in `notFound`), never
//     appended at EOF and never stamped onto a first-of-many guess;
//   - already-stamped markers are left alone (idempotent). "Already stamped" is
//     decided by the comment's id: if its own marker is on a line and the text
//     has since been edited, that marker is REPLACED, so one comment never ends
//     up with two markers. A replacement counts in `updated`, not in `stamped`,
//     which stays the number of markers newly written;
//   - the text inside existing markers is ignored when looking for the quoted
//     snippet, so one comment's marker text can never match another comment's
//     snippet;
//   - the file's own line endings are kept: a CRLF file stays CRLF;
//   - a `.bak` of the file's pre-run content is saved before this run writes it
//     (each stamping run refreshes the `.bak` — it is the previous state, not
//     the state before the first-ever run);
//   - a sourceFile that is missing, or that resolves outside every allowed
//     root, is counted in `notFound` — never written, never silently dropped.
// `roots` lists the directories comments may legitimately write into (the
// project cwd, plus the --md root when that lives outside the cwd). Paths are
// still RESOLVED against `rootDir` — sourceFile is recorded cwd-relative —
// `roots` only widens the containment check, never the resolution base.
export async function exportMarkers(dataDir, rootDir, roots = [rootDir]) {
  const comments = await readComments(dataDir);
  const byFile = new Map();
  for (const c of comments) {
    if (!c.sourceFile || c.status === 'resolved' || c.status === 'rejected') continue;
    if (!byFile.has(c.sourceFile)) byFile.set(c.sourceFile, []);
    byFile.get(c.sourceFile).push(c);
  }
  let files = 0, stamped = 0, updated = 0, notFound = 0;
  for (const [rel, list] of byFile) {
    const file = path.normalize(path.join(rootDir, rel));
    if (!roots.some((r) => within(r, file)) || !existsSync(file)) { notFound += list.length; continue; }
    let text = await readFile(file, 'utf-8');
    const eol = dominantEol(text);
    const lines = text.split(/\r?\n/);
    let changed = false;
    for (const c of list) {
      const marker = fbMarker(c);
      const idTag = c.id ? '#' + c.id : '';
      // This comment's own marker, wherever it already sits.
      let at = -1, old = '';
      if (idTag) {
        for (let i = 0; i < lines.length && at < 0; i++) {
          for (const m of lines[i].match(MARKER_G) || []) {
            if (m.includes(idTag)) { at = i; old = m; break; }
          }
        }
      }
      if (at >= 0) {
        if (old === marker) continue;              // unchanged: nothing to do
        // A function replacement, so a `$` in the comment text stays literal.
        lines[at] = lines[at].replace(old, () => marker); // the comment text was edited
        updated++; changed = true;
        continue;
      }
      // Markers stamped before ids were written carry no id, so look for the
      // id-less form too rather than stamping the same comment a second time.
      const idless = idTag ? fbMarker({ ...c, id: '' }) : marker;
      if (lines.some((l) => l.includes(idless))) continue;
      const snip = mdNorm(c.anchor && (c.anchor.snippet || c.anchor.rangeText)).slice(0, 40).toLowerCase();
      if (!snip) { notFound++; continue; }
      const matches = [];
      lines.forEach((l, i) => {
        const bare = l.replace(MARKER_G, ' '); // another comment's marker is not source text
        if (!bare.trimStart().startsWith('<!--') && mdNorm(bare).toLowerCase().includes(snip)) matches.push(i);
      });
      if (matches.length !== 1) { notFound++; continue; } // zero or ambiguous: refuse to guess
      const idx = matches[0];
      // The comment may have been stamped before markers carried ids, and its
      // text edited since. Its old marker is the one id-less marker of this same
      // verb on the line the snippet points at: update that instead of leaving a
      // twin beside it. (If two old markers of one verb share the line we cannot
      // tell them apart, so we append and leave both alone.)
      const verb = (parseMarker(marker) || {}).verb || '';
      const older = (lines[idx].match(MARKER_G) || []).filter((m) => {
        const p = parseMarker(m);
        return p && !p.id && p.verb === verb;
      });
      if (older.length === 1) {
        lines[idx] = lines[idx].replace(older[0], () => marker);
        updated++; changed = true;
        continue;
      }
      lines[idx] = lines[idx].replace(/[ \t]+$/, '') + ' ' + marker;
      stamped++; changed = true;
    }
    if (changed) {
      await writeFile(file + '.bak', text);
      await writeFile(file, lines.join(eol));
      files++;
    }
  }
  return { files, stamped, updated, notFound };
}
