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

// A path that stays inside `root` (no traversal escape via ..).
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export function fbMarker(c) {
  const t = mdNorm(c.text).replace(/--+>/g, '--&gt;').replace(/--/g, '–');
  switch (c.type) {
    case 'delete': return `<!-- @FB-DELETE${t ? ': ' + t : ''} -->`;
    case 'expand': return `<!-- @FB-EXPAND${t ? ': ' + t : ''} -->`;
    case 'question': return `<!-- @FB-Q${t ? ': ' + t : ''} -->`;
    case 'rephrase': return `<!-- @FB: rephrase as "${t.replace(/"/g, '\\"')}" -->`;
    default: return `<!-- @FB${t ? ': ' + t : ''} -->`; // comment + any web type
  }
}

// Stamp every still-actionable Markdown comment into its source file.
// Refuse-to-guess rules (the contract):
//   - only `open` / `approved` comments are stamped — `resolved` is done and
//     `rejected` means "do not implement", so neither belongs in the source;
//   - the quoted snippet must match exactly ONE source line. Zero matches or
//     several matches → the comment is skipped (counted in `notFound`), never
//     appended at EOF and never stamped onto a first-of-many guess;
//   - already-stamped markers are left alone (idempotent);
//   - a `.bak` of the original file is saved before the first write;
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
  let files = 0, stamped = 0, notFound = 0;
  for (const [rel, list] of byFile) {
    const file = path.normalize(path.join(rootDir, rel));
    if (!roots.some((r) => within(r, file)) || !existsSync(file)) { notFound += list.length; continue; }
    let text = await readFile(file, 'utf-8');
    const lines = text.split('\n');
    let changed = false;
    for (const c of list) {
      const marker = fbMarker(c);
      if (lines.some((l) => l.includes(marker))) continue; // idempotent
      const snip = mdNorm(c.anchor && (c.anchor.snippet || c.anchor.rangeText)).slice(0, 40).toLowerCase();
      if (!snip) { notFound++; continue; }
      const matches = [];
      lines.forEach((l, i) => {
        if (!l.trimStart().startsWith('<!--') && mdNorm(l).toLowerCase().includes(snip)) matches.push(i);
      });
      if (matches.length !== 1) { notFound++; continue; } // zero or ambiguous: refuse to guess
      const idx = matches[0];
      lines[idx] = lines[idx].replace(/\s+$/, '') + ' ' + marker;
      stamped++; changed = true;
    }
    if (changed) {
      await writeFile(file + '.bak', text);
      await writeFile(file, lines.join('\n'));
      files++;
    }
  }
  return { files, stamped, notFound };
}
