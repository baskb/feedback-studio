# Feedback Studio

A local visual feedback overlay for any website. Turn on comment mode, then
**click or tap any element** (or select any text) on any page and leave a comment,
**typed or spoken**. Comments persist to `.feedback/comments.json` (plus a readable
`FEEDBACK.md`) so your coding agent can process them on your signal.

Built as a [Claude Code](https://claude.com/claude-code) plugin: a skill that
launches the tool against your project and works through the collected comments,
plus a self-contained Node server that does the serving and injection.

![comment on any element, typed or spoken, then let your agent process it](#)

## Highlights

- **Comment on anything** — element, heading, image, table, card, section, or an exact
  text selection. A numbered pin marks each spot.
- **Comment types** — tag each note `fix` (it's broken), `change` (make it exactly this),
  or `improve` (use your judgement); the type tells the agent how much latitude it has.
- **Voice-to-text in 18 languages** — dictate feedback; English by default, pick your language from a one-tap menu (English, Spanish, Mandarin, Hindi, Arabic, Portuguese, French, German, Japanese, Korean, Russian, Italian, Dutch, Turkish, Polish, Indonesian, and more). The interface is English.
- **Live status** — when the agent resolves a comment, its pin flips green in your open
  browser instantly (file-watch → SSE), and a "N ready for your agent" badge + a
  copy-`/feedback` button keep the loop one paste away.
- **Works on your phone** — serves on your LAN; `--https` enables the mic off-localhost.
- **Touch-friendly** — tap then walk the DOM with ▲/▼ to pick the right element (no hover needed).
- **Any framework** — serve a static build (`dist/ build/ out/ …`, auto-detected) or
  **proxy a running dev server** (Vite, Next, Astro, …) with live reload (CSP stripped, HMR passed through).
- **Non-invasive** — injects one `<script>` and mounts its UI in a shadow root; never
  touches your site's DOM, styles, or source.
- **Agent-ready & robust** — every comment stores the page, the comment type, a
  multi-strategy anchor (stable attr/id, CSS selector, XPath, quoted text) and your note.
  Anchors re-resolve with a confidence score; when they can't, the agent is told to ask
  for a re-pin rather than edit the wrong element. See [HARNESS.md](HARNESS.md) for the numbers.

## Install (Claude Code)

```
/plugin marketplace add Bastiaan-K/feedback-studio
/plugin install feedback-studio@feedback-studio
```

(Replace `Bastiaan-K/feedback-studio` with wherever you host this repo.)

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
node plugins/feedback-studio/bin/feedback-studio.mjs --proxy http://localhost:5173 --https
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | Serve a static build directory. |
| `--proxy <url>` | Proxy a running dev server and inject the overlay (live reload). |
| `--port <n>` | Listen port (default `4444`). |
| `--https` | Serve over TLS with a self-signed cert (needed for phone voice-to-text). Fetches a small cert helper once. |

Open the printed URL (use **Chrome or Edge** for voice). Hit **Comment** (bottom-right,
or press `C`), and start clicking. On a phone, tap an element then use ▲/▼ to pick the
right one. The mic dictates.

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
