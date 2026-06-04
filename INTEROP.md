# Using Feedback Studio with other agents (Codex, Cursor, ChatGPT, …)

Feedback Studio is agent-agnostic by design. The **tool** (the review server,
overlay, voice, markdown rendering) has nothing Claude-specific in it, and the
**data** is plain files:

- `.feedback/comments.json` — structured source of truth (page, anchor, type, author, status, thread).
- `.feedback/FEEDBACK.md` — a readable digest grouped by page.
- inline `<!-- @FB ... -->` markers (markdown mode, after "Stamp .md").

So the only thing that differs per agent is **how the agent reads/acts on the
feedback**. There are three levels, cheapest first.

## Level 0 — any agent, zero setup

Point any coding agent at the files. The review server is a plain Node script,
so any agent that can run a shell command and read files can use it:

```
node /path/to/feedback-studio/plugins/feedback-studio/bin/feedback-studio.mjs --dir dist
# or --proxy http://localhost:5173   or   --md report.md
```

Then: *"read `.feedback/FEEDBACK.md` and apply the open comments; mark each resolved in `.feedback/comments.json` when done."* That already works in Codex, Cursor, Cline, Windsurf, or ChatGPT (paste the file).

> **Editing `comments.json` directly:** prefer the MCP tools (Level 1) for writes —
> they're atomic and locked, so they're safe even while the overlay is open. If you
> *do* hand-edit the file, do it when nothing else is writing (the overlay/server
> and the MCP server each write it), and keep it valid JSON. A malformed file is
> refused (an error), never silently treated as empty, so a bad edit can't wipe
> your comments — but it will block writes until you fix it.

## Level 1 — the MCP server (recommended; one integration, every agent)

`bin/feedback-studio-mcp.mjs` is an MCP **stdio** server over the project's
`.feedback/comments.json`. It needs no other process running, and when the
review server *is* running, writes show up live in the open overlay.

Tools: `list_comments`, `get_comment`, `add_comment` (agents pin their own
comments), `reply`, `set_status`.

### Codex CLI

`~/.codex/config.toml` (or project `.codex/config.toml`):

```toml
[mcp_servers.feedback-studio]
command = "node"
args = ["/ABS/PATH/feedback-studio/plugins/feedback-studio/bin/feedback-studio-mcp.mjs"]
# If Codex doesn't spawn it in your project dir, pin the data dir:
# env = { FEEDBACK_DIR = "/ABS/PATH/your-project/.feedback" }
```

or: `codex mcp add feedback-studio -- node /ABS/PATH/.../feedback-studio-mcp.mjs`

### Cursor / Windsurf / Cline

Same stdio server, in each tool's MCP config (`command: node`, `args: [<abs path>]`).

### Claude Code (in addition to the plugin)

```json
// .mcp.json
{ "mcpServers": { "feedback-studio": { "command": "node", "args": ["/ABS/PATH/.../feedback-studio-mcp.mjs"] } } }
```

## Level 2 — ChatGPT (cloud)

ChatGPT's Developer Mode is a full MCP client, but it **only connects to remote
MCP servers over HTTPS — not local stdio**. So:

1. Expose the server over HTTPS with a tunnel (Secure MCP Tunnel / ngrok / Cloudflare).
2. Run an HTTP (Streamable-HTTP) MCP transport behind it with a bearer token. *(Not built yet — the stdio server above covers every local agent; the HTTP transport + auth is the remaining piece for ChatGPT-cloud, tracked as a follow-up.)*
3. In ChatGPT: Settings → Apps → Advanced → Developer mode → Create app → point at `https://<tunnel>/mcp`.

For now, the practical ChatGPT path is Level 0 (paste `FEEDBACK.md`).

## Codex prompt + AGENTS.md

`interop/codex/feedback.md` → drop in `~/.codex/prompts/` to get a `/prompts:feedback` command.
`interop/AGENTS.md` → paste into a project's `AGENTS.md` so Codex knows the workflow without being told each time.

## Why this is enough

The capture side (overlay, voice, anchors, markdown) is identical for everyone.
The consume side is MCP (every local agent) or the open files (literally anyone).
Only ChatGPT-cloud needs extra plumbing, because it can't reach your machine.
