// Live smoke test for the MCP stdio server. Run: node test/mcp-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'feedback-studio-mcp.mjs');

// One server instance with its own line reader, so a test can start a second
// one (a different cwd, a different environment) without the two sharing state.
function startServer({ env, cwd } = {}) {
  const srv = spawn(process.execPath, [bin], { env: env || process.env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
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
  const rpc = (msg) => new Promise((res) => { pending.push(res); srv.stdin.write(JSON.stringify(msg) + '\n'); });
  return { srv, rpc };
}

const dir = mkdtempSync(path.join(tmpdir(), 'fbs-mcp-'));
const { srv, rpc } = startServer({ env: { ...process.env, FEEDBACK_DIR: dir } });

let failures = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failures++; };

// The second instance of the "writes nothing where it was merely started" test,
// declared here so the cleanup block can always reach it.
let bare = null;
let bareSrv = null;

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

  // The three tools every processing run ends with: read one in full, talk on
  // its thread, and mark it done.
  const one = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'get_comment', arguments: { id: added.id } } });
  const full = JSON.parse(one.result.content[0].text);
  check('get_comment returns the full comment with anchor and thread', !one.result.isError && full.id === added.id && full.anchor && Array.isArray(full.thread));
  const missing = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_comment', arguments: { id: 'c_nope' } } });
  check('get_comment on an unknown id => tool error', missing.result.isError === true);

  const rep = await rpc({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'reply', arguments: { id: added.id, text: 'Done: bumped the size.', authorName: 'Codex', variants: [{ label: 'A', html: '<div onclick="x()">a</div>' }] } } });
  const repOut = JSON.parse(rep.result.content[0].text);
  const afterReply = JSON.parse((await rpc({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'get_comment', arguments: { id: added.id } } })).result.content[0].text);
  check('reply lands on the thread as the agent', !rep.result.isError && repOut.replies === 1 && afterReply.thread[0].author === 'agent' && afterReply.thread[0].authorName === 'Codex');
  check('reply variants are sanitized (no inline handlers)', afterReply.thread[0].variants && afterReply.thread[0].variants.length === 1 && !/onclick/i.test(afterReply.thread[0].variants[0].html));

  const st = await rpc({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'set_status', arguments: { id: added.id, status: 'resolved' } } });
  const stOut = JSON.parse(st.result.content[0].text);
  const listAfter = JSON.parse((await rpc({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'list_comments', arguments: {} } })).result.content[0].text);
  check('set_status resolved is written and drops the comment from the actionable list', !st.result.isError && stOut.status === 'resolved' && listAfter.count === 0);
  const badStatus = await rpc({ jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'set_status', arguments: { id: added.id, status: 'done' } } });
  check('set_status refuses a status outside the enum', badStatus.result.isError === true);
  const listAll = JSON.parse((await rpc({ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'list_comments', arguments: { status: 'all' } } })).result.content[0].text);
  check('list_comments status=all still shows the resolved one', listAll.count === 1 && listAll.comments[0].status === 'resolved');

  // Review rounds. A comment made with no meta.json belongs to round 1; once the
  // review server has moved the review on, an agent's own pin has to land in the
  // round the person is looking at, not back at the start.
  const onDiskRound = JSON.parse(readFileSync(path.join(dir, 'comments.json'), 'utf8')).comments[0].round;
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ label: 'Marketing', round: 3, roundStartedAt: new Date().toISOString() }));
  const addR3 = await rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'add_comment', arguments: { page: '/', text: 'agent pin in round three' } } });
  const r3Id = JSON.parse(addR3.result.content[0].text).id;
  const r3 = JSON.parse(readFileSync(path.join(dir, 'comments.json'), 'utf8')).comments.find((c) => c.id === r3Id);
  check('add_comment stamps the round: 1 with no meta.json, the current one with it',
    onDiskRound === 1 && !addR3.result.isError && r3.round === 3);

  const notFound = await rpc({ jsonrpc: '2.0', id: 8, method: 'frobnicate' });
  check('unknown method => -32601', notFound.error && notFound.error.code === -32601);

  // the MCP server drops the processing guide next to the data on startup, so an
  // agent driving it without the plugin still has the workflow on hand. FEEDBACK_DIR
  // is set here, which is the client saying where the data belongs.
  check('writes HOW-TO-PROCESS.md on startup', existsSync(path.join(dir, 'HOW-TO-PROCESS.md')));

  // Started in a folder nobody pointed it at: an MCP client launches us wherever
  // it happens to be, so merely running must create nothing. The first write is
  // what makes the folder, and the guide goes in with it.
  bare = mkdtempSync(path.join(tmpdir(), 'fbs-mcp-bare-'));
  const bareEnv = { ...process.env };
  delete bareEnv.FEEDBACK_DIR;
  const second = startServer({ env: bareEnv, cwd: bare });
  bareSrv = second.srv;
  await second.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const bareTools = await second.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  check('starting in an unknown folder writes nothing there',
    bareTools.result.tools.length === 6 && !existsSync(path.join(bare, '.feedback')));
  const bareAdd = await second.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_comment', arguments: { page: '/', text: 'first note' } } });
  check('the first add_comment creates the folder with the data and the guide',
    !bareAdd.result.isError
    && existsSync(path.join(bare, '.feedback', 'comments.json'))
    && existsSync(path.join(bare, '.feedback', 'HOW-TO-PROCESS.md')));
} catch (e) {
  console.log('FAIL  exception:', e.message); failures++;
} finally {
  srv.stdin.end();
  srv.kill();
  if (bareSrv) { bareSrv.stdin.end(); bareSrv.kill(); }
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (bare) { try { rmSync(bare, { recursive: true, force: true }); } catch (e) {} }
  console.log(failures ? `\n${failures} MCP smoke check(s) failed` : '\nall MCP smoke checks passed');
  process.exit(failures ? 1 : 0);
}
