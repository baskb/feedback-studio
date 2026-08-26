// Live smoke test for the MCP stdio server. Run: node test/mcp-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'fbs-mcp-'));
const bin = path.join(__dirname, '..', 'bin', 'feedback-studio-mcp.mjs');
const srv = spawn(process.execPath, [bin], { env: { ...process.env, FEEDBACK_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'] });

let buf = '';
const pending = [];
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) { const r = pending.shift(); if (r) r(JSON.parse(line)); }
  }
});
function rpc(msg) { return new Promise((res) => { pending.push(res); srv.stdin.write(JSON.stringify(msg) + '\n'); }); }

let failures = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failures++; };

try {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  check('initialize negotiates version', init.result.protocolVersion === '2025-06-18');
  check('serverInfo has a real version', /^\d+\.\d+\.\d+$/.test(init.result.serverInfo.version));

  const unsupported = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'bogus' } });
  check('unsupported protocol falls back, not echoed', unsupported.result.protocolVersion !== 'bogus');

  const tools = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  check('lists 6 tools', tools.result.tools.length === 6);
  const pres = await rpc({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'set_presence', arguments: { state: 'working', commentId: 'c1', name: 'Codex', note: 'looking' } } });
  let presFile = null;
  try { presFile = JSON.parse(readFileSync(path.join(dir, 'presence.json'), 'utf8')); } catch (e) {}
  check('set_presence writes presence.json', !pres.result.isError && presFile && presFile.state === 'working' && presFile.commentId === 'c1' && presFile.activity && presFile.activity.text === 'looking');

  const add = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_comment', arguments: { page: '/', text: 'from agent' } } });
  const added = JSON.parse(add.result.content[0].text);
  check('add_comment ok, web default type=change', !add.result.isError && added.comment.type === 'change');

  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add_comment', arguments: { page: '/' } } });
  check('missing required arg => tool error', bad.result.isError === true);

  const unknown = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  check('unknown tool => tool error', unknown.result.isError === true);

  const list = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_comments', arguments: {} } });
  const listed = JSON.parse(list.result.content[0].text);
  check('list_comments shows the added one', listed.count === 1);
  check('list_comments summary carries autonomy', listed.comments[0].autonomy === 'review');

  const notFound = await rpc({ jsonrpc: '2.0', id: 8, method: 'frobnicate' });
  check('unknown method => -32601', notFound.error && notFound.error.code === -32601);

  // the MCP server drops the processing guide next to the data on startup, so an
  // agent driving it without the plugin still has the workflow on hand
  check('writes HOW-TO-PROCESS.md on startup', existsSync(path.join(dir, 'HOW-TO-PROCESS.md')));
} catch (e) {
  console.log('FAIL  exception:', e.message); failures++;
} finally {
  srv.stdin.end();
  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(failures ? `\n${failures} MCP smoke check(s) failed` : '\nall MCP smoke checks passed');
  process.exit(failures ? 1 : 0);
}
