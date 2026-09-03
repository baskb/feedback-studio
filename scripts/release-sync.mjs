#!/usr/bin/env node
// Keep every version surface in sync with package.json, and date the changelog.
// Run automatically by `npm version` (see the package.json "version" script), so a
// single `npm run release:patch` bumps all manifests together and can never drift.

import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const repo = 'https://github.com/baskb/feedback-studio';

function syncJson(path, mutate) {
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  mutate(obj);
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

// Plugin manifest (also what the MCP server reports as serverInfo.version).
syncJson('plugins/feedback-studio/.claude-plugin/plugin.json', (p) => { p.version = version; });
// Marketplace plugin entry.
syncJson('.claude-plugin/marketplace.json', (m) => { if (m.plugins && m.plugins[0]) m.plugins[0].version = version; });

// Roll the changelog: [Unreleased] -> [version] - today, leaving a fresh [Unreleased] on top.
try {
  const file = 'CHANGELOG.md';
  let c = readFileSync(file, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  if (c.includes('## [Unreleased]') && !c.includes(`## [${version}]`)) {
    c = c.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${date}`);
    if (c.includes('[Unreleased]:')) {
      c = c.replace(/^\[Unreleased\]:.*$/m,
        `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/releases/tag/v${version}`);
    }
    writeFileSync(file, c);
  }
} catch (e) {
  console.error('changelog roll skipped:', e.message);
}

// interop/AGENTS.md shows the exact block `--seed-agents` writes, so it is generated
// from the same source text (lib/store.mjs) instead of being kept in step by hand.
// test/interop.test.mjs fails when the two drift, so this also runs on every release.
await writeAgentsSnippetDoc();
async function writeAgentsSnippetDoc() {
  const { AGENTS_SNIPPET_BODY } = await import('../plugins/feedback-studio/lib/store.mjs');
  const head = `# (snippet) Paste into your project's AGENTS.md or CLAUDE.md

\`feedback-studio --seed-agents\` writes the block below into your \`CLAUDE.md\` (Claude Code) and \`AGENTS.md\` (Codex / Cursor / Cline / Windsurf) automatically, guarded by a marker so it is never duplicated. You can also paste it by hand. This file is generated from the same text the command writes (\`scripts/release-sync.mjs\`); edit \`AGENTS_SNIPPET_BODY\` in \`plugins/feedback-studio/lib/store.mjs\`, not this file.

`;
  writeFileSync('interop/AGENTS.md', head + AGENTS_SNIPPET_BODY + '\n');
}

console.log('release-sync: version ' + version + ' written to plugin.json, marketplace.json, CHANGELOG.md; interop/AGENTS.md regenerated');
