# Feedback Studio

A local visual feedback overlay for a website you're building, or for a Markdown
file you're editing. Point it at a static build, a running dev server, or a `.md`
file. Then click or tap an element, or select text, and leave a typed or spoken
comment at the exact spot.

Feedback Studio is for developers and agents working on local projects. It is
not a browser extension, and it does not attach to public sites you browse.
Comments are saved to `.feedback/comments.json` plus a readable
`.feedback/FEEDBACK.md`, so your coding agent can process them when you ask.

It ships as a [Claude Code](https://claude.com/claude-code) plugin plus a
self-contained Node server. The plugin adds `/feedback-studio:feedback`, which
starts the overlay and later works through the saved comments.

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

The 30-second path: install the plugin, run `start` in a project, open the URL it
prints, press **Comment**, and click the page. When you're done, run `process`.
The skill chooses static serving or a dev-server proxy, reads
`.feedback/comments.json`, applies the feedback, and shows you the diff.

No Claude Code required:

```bash
npx feedback-studio --dir dist
npx feedback-studio --proxy http://localhost:5173
npx feedback-studio --md report.md
```

## Recipes

Common ways to use it. In **Claude Code**, ask in plain English and the
`/feedback-studio:feedback` skill picks the flags. **Standalone**, run the `npx`
line.

**Review your site from your phone, by voice.**
Say *"start Feedback Studio, mobile-ready"*, or run `npx feedback-studio --dir dist --tunnel`.
Open the real-HTTPS link on your phone, tap any element, and speak your note.

**Give feedback on a Markdown file** (a draft, a research report, a plan).
Say *"review report.md with Feedback Studio"*, or run `npx feedback-studio --md report.md`.
The file renders as a clean page, and you can comment on any heading,
paragraph, list, or table.

**Review your running dev server** (Vite, Next, Astro), with live reload.
Say *"open my dev site to review"*, or run `npx feedback-studio --proxy http://localhost:5173`.
Comment while your app keeps hot-reloading underneath.

**Hand the comments to your agent.**
Say *"process the feedback"*, or run `/feedback-studio:feedback process` in Claude Code.
Your agent works through each comment, shows the diffs, and the pins turn green
as it resolves them.

**Have an AI reviewer leave comments for *you*.**
Say *"have a frontend reviewer leave comments on my site"* (or ask for copy,
marketing, or accessibility review). The agent pins its **own** notes to
specific elements. You reply, approve, or reject each one before anything
changes. This is the inverse of leaving your own comments: the AI points at the
thing it means instead of describing it in a paragraph.

**Share a link with a teammate or client.**
Say *"start Feedback Studio and give me a shareable link"*, or run `npx feedback-studio --dir dist --tunnel`.
They open the link in any browser and comment on the page; it all lands in your repo.
The link is public while the server runs: anyone who has it can view and write
comments, and those comments feed an agent that edits your files. Share it only
with people you trust. Stop the server to revoke the link.

## Highlights

- **Comment on the exact thing**: element, heading, image, table, card, section,
  or selected text. A numbered pin marks the spot.
- **Give the agent the right amount of latitude**: web comments use `fix`
  (repair what is broken), `change` (apply this closely), or `improve` (use
  judgement). Markdown comments use the document verbs described below.
- **Hold the conversation on the element**: agents and other skills can leave
  their own pinned comments by selector or visible text. You reply, approve, or
  reject in a thread tied to that target.
- **Dictate in 18 locales**: English is the default, the voice language is a
  one-tap choice, and the interface stays English.
- **See progress live**: resolved pins turn green without a refresh. A badge
  counts the ready comments, and a button copies the `/feedback` command.
- **Use your phone without exposing the server by default**: local mode binds to
  `127.0.0.1`. For phone review, use `--tunnel` for a real-certificate HTTPS URL
  on any network, or `--https --host 0.0.0.0` on your LAN.

It works with any framework: serve a static build, proxy a Vite, Next, or Astro
dev server with live reload, or review Markdown. On touch, step through nested
elements with ▲/▼ to pick the right one. The UI lives in its own isolated layer,
so it does not touch your site's markup or styles. Every anchor re-resolves with
a confidence score and refuses to guess when it cannot place a comment safely.
The anchor numbers are in [HARNESS.md](HARNESS.md).

## Use the server directly (without Claude Code)

It's a zero-dependency Node script, usable by anyone. Quickest is `npx`, with no
clone and no install:

```bash
npx feedback-studio --dir dist                      # serve a static build
npx feedback-studio --proxy http://localhost:5173   # proxy a running dev server
npx feedback-studio --md report.md                  # review one Markdown file
npx feedback-studio --md report.md --tunnel         # review on your phone, real HTTPS, no cert warning
npx feedback-studio --md research/ --https --host 0.0.0.0  # a folder of docs, phone voice over the LAN
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
| `--md <file\|dir>` | Render a Markdown file or folder to reviewable pages. Fetches a small renderer once. |
| `--port <n>` | Listen port (default `4444`). |
| `--host <addr>` | Bind address (default `127.0.0.1`). Use `--host 0.0.0.0` to reach it from your phone or LAN. |
| `--tunnel` | Open a public HTTPS URL through a Cloudflare quick tunnel, with a real cert, so there is no browser warning, the mic works, and it reaches your phone on any network. Fetches the `cloudflared` helper once; no account needed. |
| `--https` | Serve over TLS with a self-signed cert for phone voice over the LAN. The phone needs a one-time "not private" tap-through. Fetches a small cert helper once. `--tunnel` avoids the warning. |
| `--no-open` | Don't auto-open the browser. |

> **Requires Node 18+.** Runtime HTTP has zero dependencies; `--https`, `--md`, and
> `--tunnel` lazily install a single helper (`selfsigned` / `marked` / `cloudflared`)
> into `~/.feedback-studio/` on first use only.

Open the printed URL. Use **Chrome or Edge** for voice. Press **Comment**
(bottom-right, or `C`), then click the page. On a phone, tap an element and use
▲/▼ to pick the right nested target. The mic dictates.

## Use with other agents (Codex, Cursor, ChatGPT)

The capture side is agent-agnostic, and the data is plain files. Any agent can
read `.feedback/comments.json` or `.feedback/FEEDBACK.md`.

There is also an **MCP server** (`bin/feedback-studio-mcp.mjs`) for local
MCP-capable agents such as Codex CLI, Cursor, Windsurf, and Cline. Its tools are
`list_comments`, `get_comment`, `add_comment`, `reply`, and `set_status`.

It **ships with the plugin but is not activated by default in Claude Code.** The
Claude Code skill reads the comment files directly, so Feedback Studio does not
keep an always-on MCP server in every turn. Wire the MCP server only into agents
that need MCP tools. ChatGPT cloud needs a remote HTTPS MCP endpoint rather than
local stdio. Full setup, including the Codex `AGENTS.md`, is in
[INTEROP.md](INTEROP.md).

## Where comments live

- `.feedback/comments.json`: structured source of truth (page, anchor, text, status).
- `.feedback/FEEDBACK.md`: readable digest grouped by page.

Add `.feedback/` to your `.gitignore`; it's review data, not site content.

## Reviewing Markdown, and the `Stamp .md` button

In `--md` mode each comment also records the **source `.md` path** it came from.
The rendered HTML is throwaway; the agent edits the file, not the HTML. That
gives you two handoff paths:

- **`.feedback/comments.json`**: the rich source of truth, including threads,
  status, and types.
- **Inline `<!-- @FB ... -->` markers in the `.md` itself**, written by the
  **Stamp .md** button in the panel.

**What `Stamp .md` does:** it takes every unresolved comment and writes it into
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

- The marker lands on the single line containing the quoted text. If zero or
  several lines match, the comment is skipped and stays open for a re-pin rather
  than guessing. The toast reports how many could not be placed.
- It saves a `.bak` copy of each file before changing it.
- It is safe to re-run. Markers already present are skipped.

**Why use it:** the markers are invisible when the Markdown renders, but they are
searchable and travel with the file through git, a PR, or another agent/tool that
does not read `.feedback/`. It is the portable handoff path; `comments.json`
stays the fuller record. Because it edits your real source files, it is a
deliberate action, with `.bak` backups.

> **Trusted input:** the rendered page shares an origin with the comment API, so
> Feedback Studio strips active content (scripts, inline handlers, `javascript:`
> URLs) from rendered Markdown. That is defense in depth, not a full sanitizer —
> prefer local (loopback) mode when reviewing a `.md` you didn't write.

## Notes & limits

- **Easiest phone path: `--tunnel`.** It opens a Cloudflare quick tunnel, fetches
  `cloudflared` once, and prints a public `https://...trycloudflare.com` URL with
  a real certificate. There is no warning, the mic works, and your phone can
  reach it from any network. Stop the server with Ctrl+C to close the URL.
  **Tradeoff:** this is the one mode that sends data off your machine. To make
  the public link work, your page and comments pass through Cloudflare's servers.
  Nothing is stored there, but the session is no longer purely local, and anyone
  with the link can view and comment. Treat the URL like a secret, prefer LAN or
  local mode for sensitive content, and use quick tunnels for ad-hoc review, not
  as stable or production URLs.
- **Voice** needs a Chromium browser (Chrome or Edge) over a secure connection.
  `localhost` counts as secure, and so does the `--tunnel` URL. A phone over
  plain `http://<lan-ip>` does not, so use `--tunnel` or `--https` for phone
  voice. English is the default; the one-tap language menu also covers Spanish,
  Mandarin, Hindi, Arabic, Portuguese, French, German, Japanese, Korean, Russian,
  Italian, Dutch, Turkish, Polish, Indonesian, and more (18 locales in all). The
  interface stays English.
- **`--https` (LAN alternative to a tunnel)** uses a self-signed certificate. The
  phone warns once ("not private"): tap **Advanced -> Proceed**. After that the
  connection counts as secure and the mic works. `--tunnel` avoids this step.
- **Phone can't connect on the LAN?** Start the server with `--host 0.0.0.0`.
  By default it only listens on your own machine. Both devices must share the
  network, and you may need to allow Node through the firewall on Private
  networks. `--tunnel` sidesteps this.
- **Static vs proxy**: static mode needs a rebuild to see content changes; proxy
  mode reflects live edits and forwards dynamic routes to the dev server.

## License

MIT. See [LICENSE](LICENSE).
