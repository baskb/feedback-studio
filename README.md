# Feedback Studio

A local visual feedback overlay for any website **or Markdown file**. Turn on comment
mode, then **click or tap any element** (or select any text) on any page — or any
heading, paragraph, or table in a rendered `.md` — and leave a comment, **typed or
spoken**. Comments persist to `.feedback/comments.json` (plus a readable `FEEDBACK.md`)
so your coding agent can process them on your signal.

Built as a [Claude Code](https://claude.com/claude-code) plugin: a skill that
launches the tool against your project and works through the collected comments,
plus a self-contained Node server that does the serving and injection.

![comment on any element, typed or spoken, then let your agent process it](#)

## Highlights

- **Comment on anything** — element, heading, image, table, card, section, or an exact
  text selection. A numbered pin marks each spot.
- **Comment types** — tag each note `fix` (it's broken), `change` (make it exactly this),
  or `improve` (use your judgement); the type tells the agent how much latitude it has.
- **Two-way conversation** — agents and other skills can leave their *own* comments pinned
  to a component (anchored by selector or visible text). You reply, approve, or reject in a
  threaded conversation tied to the element, so the context lives on the thing you're discussing.
- **Voice-to-text in 18 languages** — dictate feedback; English by default, pick your language from a one-tap menu (English, Spanish, Mandarin, Hindi, Arabic, Portuguese, French, German, Japanese, Korean, Russian, Italian, Dutch, Turkish, Polish, Indonesian, and more). The interface is English.
- **Live status** — when the agent resolves a comment, its pin flips green in your open
  browser instantly (file-watch → SSE), and a "N ready for your agent" badge + a
  copy-`/feedback` button keep the loop one paste away.
- **Works on your phone** — serves on your LAN; `--https` enables the mic off-localhost.
- **Touch-friendly** — tap then walk the DOM with ▲/▼ to pick the right element (no hover needed).
- **Any framework** — serve a static build (`dist/ build/ out/ …`, auto-detected) or
  **proxy a running dev server** (Vite, Next, Astro, …) with live reload (CSP stripped, HMR passed through).
- **Review Markdown too** — point it at a `.md` file or a folder of them; it renders them
  to clean pages you can comment on. Perfect for reviewing research docs an agent delivered.
  Each comment carries the source `.md` path, so the agent edits the file, not the HTML.
  Document-flavoured types (comment / rephrase / expand / delete / question), and a **Stamp .md**
  button that writes the comments back into the file as inline `<!-- @FB ... -->` markers —
  portable, greppable feedback that travels with the document.
- **Non-invasive** — injects one `<script>` and mounts its UI in a shadow root; never
  touches your site's DOM, styles, or source.
- **Agent-ready & robust** — every comment stores the page, the comment type, a
  multi-strategy anchor (stable attr/id, CSS selector, XPath, quoted text) and your note.
  Anchors re-resolve with a confidence score; when they can't, the agent is told to ask
  for a re-pin rather than edit the wrong element. See [HARNESS.md](HARNESS.md) for the numbers.

## Install (Claude Code)

```
/plugin marketplace add baskb/feedback-studio
/plugin install feedback-studio@feedback-studio
```

(The repo is currently private; make it public, or grant access, before others can add it.)

Then, in any project:

```
/feedback-studio:feedback start         # launch the overlay on this project's site
/feedback-studio:feedback process       # work through the collected comments
```

The skill picks how to serve your site (static build or dev-server proxy), opens it,
and tells you how to comment. When you're done, it reads `.feedback/comments.json` and
applies the feedback.

## Use the server directly (without Claude Code)

It's a plain Node script — usable by anyone:

```bash
node plugins/feedback-studio/bin/feedback-studio.mjs            # auto-detect a build dir
node plugins/feedback-studio/bin/feedback-studio.mjs --dir dist
node plugins/feedback-studio/bin/feedback-studio.mjs --proxy http://localhost:5173
node plugins/feedback-studio/bin/feedback-studio.mjs --md report.md          # review one markdown file
node plugins/feedback-studio/bin/feedback-studio.mjs --md research/ --https  # a folder of docs, phone voice
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | Serve a static build directory. |
| `--proxy <url>` | Proxy a running dev server and inject the overlay (live reload). |
| `--md <file\|dir>` | Render a Markdown file (or a folder of them) to reviewable pages. Fetches a small renderer once. |
| `--port <n>` | Listen port (default `4444`). |
| `--https` | Serve over TLS with a self-signed cert (needed for phone voice-to-text). Fetches a small cert helper once. |
| `--no-open` | Don't auto-open the browser. |

Open the printed URL (use **Chrome or Edge** for voice). Hit **Comment** (bottom-right,
or press `C`), and start clicking. On a phone, tap an element then use ▲/▼ to pick the
right one. The mic dictates.

## Use with other agents (Codex, Cursor, ChatGPT)

The capture side is agent-agnostic and the data is plain files, so any agent can
consume it. There's an **MCP server** (`bin/feedback-studio-mcp.mjs`, tools:
`list_comments` / `get_comment` / `add_comment` / `reply` / `set_status`) that
plugs into Codex CLI, Cursor, Windsurf, Cline, and Claude Code through one
integration. ChatGPT (cloud) needs a tunnel. Full setup, including Codex
`AGENTS.md` and a `/prompts:feedback` command, is in [INTEROP.md](INTEROP.md).

## Where comments live

- `.feedback/comments.json` — structured source of truth (page, anchor, text, status).
- `.feedback/FEEDBACK.md` — readable digest grouped by page.

Add `.feedback/` to your `.gitignore` — it's review data, not site content.

## Notes & limits

- **Voice** needs a Chromium browser and a secure context. `localhost` counts as secure;
  a phone over `http://<lan-ip>` does not, so use `--https` for phone voice.
- **HTTPS** uses a self-signed certificate: your browser warns once ("not private") —
  tap **Advanced → Proceed**. After that the origin is a secure context and the mic works.
- **Phone can't connect?** Both devices must share the network, and you may need to allow
  Node through the firewall on Private networks.
- **Static vs proxy**: static mode needs a rebuild to see content changes; proxy mode
  reflects live edits and forwards dynamic routes to the dev server.

## License

MIT — see [LICENSE](LICENSE).
