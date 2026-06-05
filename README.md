# Feedback Studio

A local visual feedback overlay for a website **you're building**, or any **Markdown
file**. Point it at your static build, your local dev server, or a `.md` file. (There's
no browser extension, so it never touches public sites you browse.) Turn on comment
mode, then **click or tap any element**, or select any text, on the page (or any
heading, paragraph, or table in a rendered `.md`), and leave a comment, **typed or
spoken**. Comments persist to `.feedback/comments.json` (plus a readable `FEEDBACK.md`)
so your coding agent can process them on your signal.

Built as a [Claude Code](https://claude.com/claude-code) plugin: a skill that
launches the tool against your project and works through the collected comments,
plus a self-contained Node server that does the serving and injection.

## Highlights

- **Comment on anything**: element, heading, image, table, card, section, or an exact
  text selection. A numbered pin marks each spot.
- **Comment types**: tag each note `fix` (it's broken), `change` (make it exactly this),
  or `improve` (use your judgement); the type tells the agent how much latitude it has.
- **Two-way conversation**: agents and other skills can leave their *own* comments pinned
  to a component (anchored by selector or visible text). You reply, approve, or reject in a
  threaded conversation tied to the element, so the context lives on the thing you're discussing.
- **Voice-to-text in 18 languages** (English default): dictate feedback and pick your language
  from a one-tap menu. The interface is English.
- **Live status**: when your agent resolves a comment, its pin turns green in your browser
  live, no refresh. A badge counts how many are ready, and a one-tap button copies the
  `/feedback` command so handing the batch to your agent is a single paste.
- **Works on your phone**: `--tunnel` opens a real-certificate HTTPS URL (no browser warning,
  mic works, on *any* network); or stay on your Wi-Fi with `--host 0.0.0.0` plus `--https`. By
  default the server binds to loopback only, so the comment API isn't reachable from the network.

It works with any framework: serve a static build (auto-detected) or proxy a Vite, Next, or Astro
dev server with live reload, and it reviews Markdown files too (see below). On touch, walk the DOM
with ▲/▼ to pick the right element. The UI mounts in a shadow root, so it never touches your site's
DOM or styles. Every anchor re-resolves with a confidence score and refuses to guess when it can't;
the numbers are in [HARNESS.md](HARNESS.md).

## Install (Claude Code)

```
/plugin marketplace add baskb/feedback-studio
/plugin install feedback-studio@feedback-studio
```

Then, in any project:

```
/feedback-studio:feedback start         # launch the overlay on this project's site
/feedback-studio:feedback process       # work through the collected comments
```

The skill picks how to serve your site (static build or dev-server proxy), opens it,
and tells you how to comment. When you're done, it reads `.feedback/comments.json` and
applies the feedback.

## Use the server directly (without Claude Code)

It's a zero-dependency Node script, usable by anyone. Quickest is `npx` (no clone, no install):

```bash
npx feedback-studio --dir dist                      # serve a static build
npx feedback-studio --proxy http://localhost:5173   # proxy a running dev server
npx feedback-studio --md report.md                  # review one Markdown file
npx feedback-studio --md report.md --tunnel         # review on your phone, real HTTPS, no cert warning
npx feedback-studio --md research/ --https          # a folder of docs, phone voice over the LAN
```

Or install it globally (`npm i -g feedback-studio`, then `feedback-studio --dir dist`), or run it from a clone:

```bash
node plugins/feedback-studio/bin/feedback-studio.mjs            # auto-detect a build dir
node plugins/feedback-studio/bin/feedback-studio.mjs --dir dist
node plugins/feedback-studio/bin/feedback-studio.mjs --proxy http://localhost:5173
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | Serve a static build directory. |
| `--proxy <url>` | Proxy a running dev server and inject the overlay (live reload). |
| `--md <file\|dir>` | Render a Markdown file (or a folder of them) to reviewable pages. Fetches a small renderer once. |
| `--port <n>` | Listen port (default `4444`). |
| `--host <addr>` | Bind address (default `127.0.0.1`). Use `--host 0.0.0.0` to reach it from your phone/LAN. |
| `--tunnel` | Open a public HTTPS URL via a Cloudflare quick tunnel, with a **real** cert, so no browser warning, the mic works, and it reaches your phone on any network. Fetches the `cloudflared` helper once; no account needed. |
| `--https` | Serve over TLS with a self-signed cert for phone voice over the LAN (one-time "not private" tap-through). Fetches a small cert helper once. `--tunnel` avoids the warning entirely. |
| `--no-open` | Don't auto-open the browser. |

> **Requires Node 18+.** Runtime HTTP has zero dependencies; `--https`, `--md`, and
> `--tunnel` lazily install a single helper (`selfsigned` / `marked` / `cloudflared`)
> into `~/.feedback-studio/` on first use only.

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

- `.feedback/comments.json`: structured source of truth (page, anchor, text, status).
- `.feedback/FEEDBACK.md`: readable digest grouped by page.

Add `.feedback/` to your `.gitignore`; it's review data, not site content.

## Reviewing Markdown, and the `Stamp .md` button

In `--md` mode each comment also records the **source `.md` path** it came from
(the rendered HTML is throwaway; the agent edits the file, not the HTML). That
gives you two ways to hand the feedback off:

- **`.feedback/comments.json`**: the rich source of truth (threads, status, types).
- **Inline `<!-- @FB ... -->` markers in the `.md` itself**, written by the
  **Stamp .md** button in the panel.

**What `Stamp .md` does:** it takes every *unresolved* comment and writes it into
its source `.md` as an HTML-comment marker on the line holding the text you
commented on. The marker depends on the comment type:

| Type | Marker written onto the line |
|---|---|
| comment | `<!-- @FB: your note -->` |
| rephrase | `<!-- @FB: rephrase as "your note" -->` |
| expand | `<!-- @FB-EXPAND: your note -->` |
| delete | `<!-- @FB-DELETE: your note -->` |
| question | `<!-- @FB-Q: your note -->` |

Details:

- It matches your pinned snippet to find the right line; if it can't locate one
  confidently, it **leaves that comment alone** rather than guessing (the toast
  reports how many couldn't be placed, so you can re-pin them).
- It saves a **`.bak`** copy of each file before changing it.
- It's **idempotent**: markers already present are skipped, so you can re-stamp safely.

**Why use it:** the markers are invisible when the Markdown renders, but they're
**greppable and travel with the file**, through git, a PR, or to a different
agent/tool that doesn't read your `.feedback/` folder. It's the portable,
hand-it-off path; `comments.json` stays the fuller record. Because it edits your
real source files, it's a deliberate action (hence the `.bak` backups).

## Notes & limits

- **Easiest phone path: `--tunnel`.** It opens a Cloudflare quick tunnel (the `cloudflared`
  helper is fetched once, no account needed) and prints a public `https://…trycloudflare.com`
  URL with a *real* certificate: no warning, the mic works, and it reaches your phone on any
  network, not just the same Wi-Fi. The URL is public while the server runs; stop the server
  (Ctrl+C) to close it. **Tradeoff:** this is the one mode that leaves your machine. To make
  the public link work, your page and comments are routed through Cloudflare's edge (nothing is
  stored there, but the session is no longer local-only/no-egress, and anyone with the link can
  view and comment). Treat the URL like a secret, prefer the LAN paths (or staying local) for
  sensitive content, and note that quick tunnels are for ad-hoc review, not a stable/production URL.
- **Voice** needs a Chromium browser and a secure context. `localhost` counts as secure, and
  so does the `--tunnel` URL; a phone over plain `http://<lan-ip>` does not, so use `--tunnel`
  (or `--https`) for phone voice. English is the default; the one-tap language menu also covers
  Spanish, Mandarin, Hindi, Arabic, Portuguese, French, German, Japanese, Korean, Russian,
  Italian, Dutch, Turkish, Polish, Indonesian, and more (18 in all). The interface stays English.
- **`--https` (LAN alternative to a tunnel)** uses a self-signed certificate: the phone warns
  once ("not private"): tap **Advanced → Proceed**. After that the origin is a secure context
  and the mic works. `--tunnel` avoids this step entirely.
- **Phone can't connect on the LAN?** Start the server with `--host 0.0.0.0` (it binds to
  loopback by default). Both devices must share the network, and you may need to allow Node
  through the firewall on Private networks. (`--tunnel` sidesteps all of this.)
- **Static vs proxy**: static mode needs a rebuild to see content changes; proxy mode
  reflects live edits and forwards dynamic routes to the dev server.

## License

MIT. See [LICENSE](LICENSE).
