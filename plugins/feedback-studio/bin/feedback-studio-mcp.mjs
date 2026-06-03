#!/usr/bin/env node
// Feedback Studio — MCP server (stdio).
//
// Exposes the collected comments to ANY MCP-capable agent (Codex CLI, Cursor,
// Windsurf, Cline, Claude Code, or ChatGPT via a tunnel). It reads and writes
// the same .feedback/comments.json the overlay uses, so it works whether or not
// the review server is running — and when it IS running, the overlay updates
// live (its file-watch picks up these writes).
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
// All diagnostics go to stderr; stdout carries protocol messages only.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const FEEDBACK_DIR = process.env.FEEDBACK_DIR
  ? path.resolve(process.env.FEEDBACK_DIR)
  : path.join(process.cwd(), '.feedback');
const DATA_FILE = path.join(FEEDBACK_DIR, 'comments.json');

const ALLOWED_TYPES = ['fix', 'change', 'improve', 'comment', 'rephrase', 'expand', 'delete', 'question'];
const STATUSES = ['open', 'approved', 'rejected', 'resolved'];

// ---------- data ----------
async function loadComments() {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf-8'));
    return Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch (e) { return []; }
}
async function saveComments(comments) {
  await mkdir(FEEDBACK_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), comments }, null, 2));
}
function newId(p = 'c') { return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
const isOpen = (c) => c.status !== 'resolved' && c.status !== 'rejected';

function summarize(c) {
  return {
    id: c.id,
    page: c.page,
    sourceFile: c.sourceFile || undefined,
    type: c.type,
    author: c.author || 'user',
    authorName: c.authorName || undefined,
    status: c.status,
    text: c.text,
    anchor: { snippet: c.anchor && (c.anchor.snippet || c.anchor.rangeText), selector: c.anchor && c.anchor.selector },
    replies: Array.isArray(c.thread) ? c.thread.length : 0,
  };
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'list_comments',
    description: 'List feedback comments. Defaults to actionable (open/approved) items. Use status="all" for everything. Optionally filter by page path.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...STATUSES, 'all', 'actionable'], description: 'Filter by status. "actionable" (default) = not resolved/rejected.' },
        page: { type: 'string', description: 'Only comments on this page path (e.g. "/pricing").' },
      },
    },
  },
  {
    name: 'get_comment',
    description: 'Get one comment in full, including its anchor (css/xpath/snippet) and the whole reply thread.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'add_comment',
    description: 'Leave a NEW agent-authored comment pinned to a page element. Anchor by a CSS selector or a quoted snippet of the visible text (snippet is safest). Shows up in the reviewer\'s overlay for them to reply to or approve.',
    inputSchema: {
      type: 'object',
      required: ['page', 'text'],
      properties: {
        page: { type: 'string', description: 'Page path the comment is on (e.g. "/" or "/report").' },
        text: { type: 'string' },
        type: { type: 'string', enum: ALLOWED_TYPES, description: 'Defaults to "comment".' },
        anchor: {
          type: 'object',
          properties: { selector: { type: 'string' }, snippet: { type: 'string', description: 'Exact visible text of the element.' } },
        },
        authorName: { type: 'string', description: 'Who is speaking, e.g. "frontend-skill". Defaults to "agent".' },
        sourceFile: { type: 'string', description: 'For markdown review: the .md file path this refers to.' },
      },
    },
  },
  {
    name: 'reply',
    description: 'Add a reply to a comment\'s conversation thread (as the agent).',
    inputSchema: {
      type: 'object', required: ['id', 'text'],
      properties: { id: { type: 'string' }, text: { type: 'string' }, authorName: { type: 'string' } },
    },
  },
  {
    name: 'set_status',
    description: 'Set a comment status: open, approved, rejected, or resolved. Mark resolved after you implement it.',
    inputSchema: {
      type: 'object', required: ['id', 'status'],
      properties: { id: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
    },
  },
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'list_comments') {
    let list = await loadComments();
    const status = args.status || 'actionable';
    if (status === 'actionable') list = list.filter(isOpen);
    else if (status !== 'all') list = list.filter((c) => c.status === status);
    if (args.page) list = list.filter((c) => c.page === args.page);
    return { count: list.length, comments: list.map(summarize) };
  }
  if (name === 'get_comment') {
    const c = (await loadComments()).find((x) => x.id === args.id);
    if (!c) throw new Error('no comment with id ' + args.id);
    return c;
  }
  if (name === 'add_comment') {
    const comments = await loadComments();
    const now = new Date().toISOString();
    const c = {
      id: newId(), schemaVersion: 3,
      page: args.page || '/', pageTitle: '', url: '',
      sourceFile: (args.sourceFile || '').toString().slice(0, 300),
      anchor: { type: 'element', selector: (args.anchor && args.anchor.selector) || '', snippet: (args.anchor && args.anchor.snippet) || '', tag: '' },
      type: ALLOWED_TYPES.includes(args.type) ? args.type : 'comment',
      text: (args.text || '').trim(),
      author: 'agent', authorName: (args.authorName || 'agent').toString().slice(0, 60),
      thread: [], autonomy: 'review', status: 'open', createdAt: now, updatedAt: now,
    };
    comments.push(c);
    await saveComments(comments);
    return { ok: true, id: c.id, comment: summarize(c) };
  }
  if (name === 'reply') {
    const comments = await loadComments();
    const c = comments.find((x) => x.id === args.id);
    if (!c) throw new Error('no comment with id ' + args.id);
    if (!Array.isArray(c.thread)) c.thread = [];
    c.thread.push({ id: newId('r'), author: 'agent', authorName: (args.authorName || 'agent').toString().slice(0, 60), text: (args.text || '').trim(), createdAt: new Date().toISOString() });
    c.updatedAt = new Date().toISOString();
    await saveComments(comments);
    return { ok: true, replies: c.thread.length };
  }
  if (name === 'set_status') {
    if (!STATUSES.includes(args.status)) throw new Error('status must be one of ' + STATUSES.join(', '));
    const comments = await loadComments();
    const c = comments.find((x) => x.id === args.id);
    if (!c) throw new Error('no comment with id ' + args.id);
    c.status = args.status;
    c.updatedAt = new Date().toISOString();
    await saveComments(comments);
    return { ok: true, id: c.id, status: c.status };
  }
  throw new Error('unknown tool: ' + name);
}

// ---------- JSON-RPC over stdio ----------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'feedback-studio', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const toolName = params && params.name;
    try {
      const result = await callTool(toolName, params && params.arguments);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
    }
  }
  if (isRequest) replyError(id, -32601, 'Method not found: ' + method);
}

// Serialize handling so message order is preserved and in-flight file writes
// finish before the next message (and before shutdown).
let buf = '';
let queue = Promise.resolve();
function enqueue(msg) {
  queue = queue.then(() => handleMessage(msg)).catch((e) => process.stderr.write('handler error: ' + e.message + '\n'));
}
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    enqueue(msg);
  }
});
process.stdin.on('end', () => { queue.then(() => process.exit(0)); });
process.stderr.write(`feedback-studio MCP server ready (data: ${DATA_FILE})\n`);
