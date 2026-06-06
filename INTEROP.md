# Using Feedback Studio with other agents (Codex, Cursor, ChatGPT, ...)

Feedback Studio is agent-agnostic by design. The review server, overlay, voice
dictation, and Markdown rendering do not depend on Claude Code. The data is plain
files:

- `.feedback/comments.json`: structured source of truth (page, anchor, type, author, status, thread).
- `.feedback/FEEDBACK.md`: readable digest grouped by page.
- inline `<!-- @FB ... -->` markers in Markdown mode, after **Stamp .md**.

What changes by agent is how it reads and acts on the feedback. Use the lightest
level that fits.

## Level 0: any agent, zero setup

Point any coding agent at the files. The review server is a plain Node script,
so any agent that can run a shell command and read files can use it:

```
node /path/to/feedback-studio/plugins/feedback-studio/bin/feedback-studio.mjs --dir dist
# or --proxy http://localhost:5173   or   --md report.md
```

Then tell the agent: *"Read `.feedback/FEEDBACK.md` and apply the open comments;
mark each resolved in `.feedback/comments.json` when done."* That works in Codex,
Cursor, Cline, Windsurf, or ChatGPT if you paste the file.

> **Editing `comments.json` directly:** prefer the MCP tools in Level 1 for
> writes. They are atomic and locked, so they are safe while the overlay is open.
> If you hand-edit the file, do it when nothing else is writing, and keep it valid
> JSON. A malformed or wrong-shaped file is refused, never silently treated as
> empty, so a bad edit cannot wipe your comments, but it will block writes until
> you fix it.

## Level 1: the MCP server (recommended; one integration, every agent)

`bin/feedback-studio-mcp.mjs` is an MCP **stdio** server over the project's
`.feedback/comments.json`. It does not need the review server to be running. If
the review server is running, MCP writes appear live in the open overlay.

Tools: `list_comments`, `get_comment`, `add_comment` (agents pin their own
comments), `reply`, `set_status`.

**It ships with the plugin but is not auto-activated.** A running MCP server keeps
its tool definitions in the agent's context every turn, so Feedback Studio does
not start one for you. Opt in per agent with the config below. In Claude Code,
the plugin's skill already reads the files, so you usually do not need the MCP
server there.

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

Use the same stdio server in each tool's MCP config:

```json
{ "command": "node", "args": ["/ABS/PATH/.../feedback-studio-mcp.mjs"] }
```

### Claude Code (optional; the plugin's skill already covers this)

You normally do not need the MCP server in Claude Code. The installed plugin's
skill reads `.feedback/comments.json` directly, and skipping the extra MCP server
keeps token use low. Add it only if you specifically want these tools callable:

```json
// .mcp.json
{ "mcpServers": { "feedback-studio": { "command": "node", "args": ["/ABS/PATH/.../feedback-studio-mcp.mjs"] } } }
```

## Level 2: ChatGPT (cloud)

ChatGPT Developer Mode can connect to remote MCP servers over SSE or Streamable
HTTP. Feedback Studio's MCP server is local stdio by design, so the practical
ChatGPT path is **Level 0**: paste `FEEDBACK.md` into the chat and let it work
from there.

If you specifically want a live MCP connection in ChatGPT, put a remote HTTPS MCP
endpoint in front of the data, for example a Streamable-HTTP bridge behind a
tunnel, with auth. Then point ChatGPT at `https://<your-endpoint>/mcp` via
Settings -> Apps -> Advanced -> Developer mode. That bridge sits outside
Feedback Studio's local-only scope.

## Codex prompt + AGENTS.md

`interop/codex/feedback.md` -> drop in `~/.codex/prompts/` to get a
`/prompts:feedback` command.

`interop/AGENTS.md` -> paste into a project's `AGENTS.md` so Codex knows the
workflow without being told each time.

## Why this is enough

The capture side is the same for everyone: overlay, voice, anchors, and Markdown
review. The consume side is either MCP for local agents, or open files for any
agent. ChatGPT cloud needs extra plumbing only because it cannot use a local
stdio server directly.
