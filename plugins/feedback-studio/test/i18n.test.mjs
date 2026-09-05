// Every sentence the overlay shows through t('…') must have a Dutch entry, and
// the Dutch table must not carry sentences nobody shows any more. The scan
// reads the overlay modules as text, so a new label cannot ship untranslated.
// Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'overlay');

// The modules import each other by their served URL (/__feedback/…), which
// Node cannot resolve, so the tables are read out of the source text.
function tableKeys(file, exportName) {
  const src = readFileSync(path.join(dir, file), 'utf8');
  const start = src.indexOf(exportName);
  assert.ok(start >= 0, `${exportName} not found in ${file}`);
  const body = src.slice(start, src.indexOf('\n};', start));
  const keys = [];
  // A key is a quoted string at the start of a line followed by a colon.
  for (const m of body.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm)) {
    keys.push((m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return keys;
}

// Every literal first argument of t('…') / tn('…', '…', …) in the overlay.
function usedSentences() {
  const used = new Map(); // sentence -> [files]
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('i18n'))) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    const add = (s) => { const v = s.replace(/\\'/g, "'").replace(/\\"/g, '"'); if (!used.has(v)) used.set(v, []); used.get(v).push(f); };
    for (const m of src.matchAll(/\btn?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) add(m[1] ?? m[2]);
    for (const m of src.matchAll(/\btn\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) add(m[1] ?? m[2]);
  }
  return used;
}

const core = tableKeys('i18n.mjs', 'const NL_CORE = {');
const extra = tableKeys('i18n-extra.mjs', 'export const NL_EXTRA = {');
const all = new Set([...core, ...extra]);
const used = usedSentences();

test('the overlay shows sentences through t()', () => {
  assert.ok(used.size > 150, `only ${used.size} sentences found`);
});

test('every sentence shown has a Dutch entry', () => {
  const missing = [...used.keys()].filter((s) => !all.has(s));
  assert.deepEqual(missing.map((s) => `${s}  (${used.get(s).join(', ')})`), []);
});

test('no Dutch entry is unused, and none is defined twice', () => {
  const unused = [...all].filter((s) => !used.has(s));
  assert.deepEqual(unused, []);
  const dup = core.filter((s) => extra.includes(s));
  assert.deepEqual(dup, []);
});

test('placeholders in a translation match the English', () => {
  const src = readFileSync(path.join(dir, 'i18n.mjs'), 'utf8') + readFileSync(path.join(dir, 'i18n-extra.mjs'), 'utf8');
  const bad = [];
  for (const m of src.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/gm)) {
    const en = m[1] ?? m[2];
    const nl = m[3] ?? m[4];
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
    if (ph(en) !== ph(nl)) bad.push(en);
  }
  assert.deepEqual(bad, []);
});
