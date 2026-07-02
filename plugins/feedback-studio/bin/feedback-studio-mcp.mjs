#!/usr/bin/env node
// Feedback Studio — MCP server (stdio).
//
// Exposes the collected comments to ANY MCP-capable agent (Codex CLI, Cursor,
// Windsurf, Cline, Claude Code, or ChatGPT via a tunnel). It reads and writes
// the same .feedback/comments.json the overlay uses, so it works whether or not
// the review server is running — and when it IS running, the overlay updates
// live (its file-watch picks up these writes). Writes go through the same
// atomic, cross-process-locked store the HTTP server uses, so the two can write
// concurrently without losing data.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
// All diagnostics go to stderr; stdout carries protocol messages only.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUSES, ALLOWED_TYPES, WEB_TYPES, MD_TYPES,
  readComments, mutate, makeComment, makeReply, exportProcessInstructions,
} from '../lib/store.mjs';

const FEEDBACK_DIR = process.env.FEEDBACK_DIR
  ? path.resolve(process.env.FEEDBACK_DIR)
  : path.join(process.cwd(), '.feedback');

// Single-source the version from the plugin manifest (don't hand-maintain it here).
const SERVER_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch (e) { return '0.0.0'; }
})();

// Protocol versions this server understands, newest first.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

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
    autonomy: c.autonomy || 'review', // agents must honour this without an extra get_comment
    text: c.text,
    // Tweak/text edits are load-bearing (they ARE the requested change) — surface
    // them in the summary so an agent needn't call get_comment to see them.
    edits: Array.isArray(c.edits) && c.edits.length ? c.edits : undefined,
    textEdit: c.textEdit && c.textEdit.after ? c.textEdit : undefined,
    shot: c.shot || undefined, // pin-time screenshot, relative to .feedback/ — view it when unsure

    anchor: { snippet: c.anchor && (c.anchor.snippet || c.anchor.rangeText), selector: c.anchor && c.anchor.selector },
    replies: Array.isArray(c.thread) ? c.thread.length : 0,
  };
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'list_comments',
    description: 'List feedback comments — your starting point on "PPF" (Please Process Feedback). Defaults to actionable (open/approved) items. Use status="all" for everything. Optionally filter by page path.',
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
    description: 'Leave a NEW agent-authored comment pinned to a page element. Anchor by a CSS selector or a quoted snippet of the visible text (snippet is safest). Comments authored here are text/selector-anchored only (an agent has no live DOM), so they resolve at best at "medium" confidence in the overlay. Type defaults to "change" for a web page, or "comment" when sourceFile (a .md) is given.',
    inputSchema: {
      type: 'object',
      required: ['page', 'text'],
      properties: {
        page: { type: 'string', description: 'Page path the comment is on (e.g. "/" or "/report").' },
        text: { type: 'string' },
        type: { type: 'string', enum: ALLOWED_TYPES, description: `Web: ${WEB_TYPES.join('/')}. Markdown: ${MD_TYPES.join('/')}. A type that doesn't fit the page kind is coerced to the default.` },
        anchor: {
          type: 'object',
          properties: { selector: { type: 'string' }, snippet: { type: 'string', description: 'Exact visible text of the element.' } },
        },
        authorName: { type: 'string', description: 'Who is speaking, e.g. "frontend-skill". Defaults to "agent".' },
        sourceFile: { type: 'string', description: 'For markdown review: the .md file path this refers to.' },
        pageTitle: { type: 'string', description: 'The page\'s title, shown in the panel\'s page grouping.' },
        url: { type: 'string', description: 'Full URL of the page (incl. query/hash) so "Go to element" can navigate to it exactly.' },
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
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Validate args against a tool's declared required fields + enums. Throws a
// clear Error (surfaced to the agent as a tool error) on the first problem.
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {};
  for (const req of schema.required || []) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      throw new Error(`missing required argument "${req}" for ${tool.name}`);
    }
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (args[key] === undefined || args[key] === null) continue;
    if (spec.enum && !spec.enum.includes(args[key])) {
      throw new Error(`"${key}" must be one of: ${spec.enum.join(', ')}`);
    }
  }
}

async function callTool(name, rawArgs) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error('unknown tool: ' + name);
  const args = rawArgs || {};
  validateArgs(tool, args);

  if (name === 'list_comments') {
    let list = await readComments(FEEDBACK_DIR);
    const status = args.status || 'actionable';
    if (status === 'actionable') list = list.filter(isOpen);
    else if (status !== 'all') list = list.filter((c) => c.status === status);
    if (args.page) list = list.filter((c) => c.page === args.page);
    const out = { count: list.length, comments: list.map(summarize) };
    if (!existsSync(path.join(FEEDBACK_DIR, 'comments.json'))) {
      out.note = `no comments.json found at ${FEEDBACK_DIR} — is FEEDBACK_DIR / the working directory correct?`;
    }
    return out;
  }
  if (name === 'get_comment') {
    const c = (await readComments(FEEDBACK_DIR)).find((x) => x.id === args.id);
    if (!c) throw new Error('no comment with id ' + args.id);
    return c;
  }
  if (name === 'add_comment') {
    const c = await mutate(FEEDBACK_DIR, (list) => {
      const comment = makeComment({
        page: args.page,
        pageTitle: args.pageTitle,
        url: args.url,
        text: args.text,
        type: args.type,
        sourceFile: args.sourceFile,
        anchor: { type: 'element', selector: args.anchor && args.anchor.selector, snippet: args.anchor && args.anchor.snippet },
        author: 'agent',
        authorName: args.authorName || 'agent',
      });
      list.push(comment);
      return { comments: list, value: comment };
    });
    return { ok: true, id: c.id, comment: summarize(c) };
  }
  if (name === 'reply') {
    const out = await mutate(FEEDBACK_DIR, (list) => {
      const c = list.find((x) => x.id === args.id);
      if (!c) return { comments: list, value: { notFound: true } };
      if (!Array.isArray(c.thread)) c.thread = [];
      c.thread.push(makeReply({ author: 'agent', authorName: args.authorName || 'agent', text: args.text }));
      c.updatedAt = new Date().toISOString();
      return { comments: list, value: { ok: true, replies: c.thread.length } };
    });
    if (out.notFound) throw new Error('no comment with id ' + args.id);
    return out;
  }
  if (name === 'set_status') {
    const out = await mutate(FEEDBACK_DIR, (list) => {
      const c = list.find((x) => x.id === args.id);
      if (!c) return { comments: list, value: { notFound: true } };
      c.status = args.status;
      c.updatedAt = new Date().toISOString();
      return { comments: list, value: { ok: true, id: c.id, status: c.status } };
    });
    if (out.notFound) throw new Error('no comment with id ' + args.id);
    return out;
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
    const want = params && params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0];
    return reply(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'feedback-studio', version: SERVER_VERSION },
      instructions:
        'Feedback Studio holds human review comments on a site or Markdown file in .feedback/. '
        + 'When the user says "PPF" (Please Process Feedback) — or "process the feedback" — call '
        + 'list_comments, then for each open comment locate its target by the quoted anchor snippet '
        + '(cross-checked with the selector) and REFUSE rather than edit the wrong element; act per '
        + 'its type, and set_status resolved when done (reply to ask/explain, add_comment to leave '
        + 'your own pins). The "please" in PPF is on purpose — we are courteous to our agents. ;-)',
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
      // Tool-level failures are reported as isError results per the MCP spec,
      // not as JSON-RPC protocol errors.
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
    try { msg = JSON.parse(line); }
    catch (e) { replyError(null, -32700, 'Parse error'); continue; }
    enqueue(msg);
  }
});
process.stdin.on('end', () => { queue.then(() => process.exit(0)); });
// Drop a self-contained processing guide next to the data, so an agent driving us
// without the Claude Code plugin (no skill) still has the workflow. Best-effort.
exportProcessInstructions(FEEDBACK_DIR).catch(() => {});
process.stderr.write(`feedback-studio MCP server ${SERVER_VERSION} ready (data: ${FEEDBACK_DIR})\n`);
