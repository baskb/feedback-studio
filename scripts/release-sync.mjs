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

console.log('release-sync: version ' + version + ' written to plugin.json, marketplace.json, CHANGELOG.md');
