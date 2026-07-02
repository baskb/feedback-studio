# Feedback Studio

https://github.com/user-attachments/assets/e76db2d8-4886-4824-93b2-49af158c92b6

Point, comment, done. Feedback Studio overlays a local website you're building —
or a Markdown file you're writing — so you can click any element, select any
sentence, and say what should change: typed or spoken, from your desk or your
couch. You can even **show** the change instead of describing it: dial the
padding until it looks right, or retype the headline directly on the page.
Everything lands in `.feedback/comments.json`, and your coding agent applies it
to the real source when you say the magic words.

> **PPF — "Please Process Feedback"** is the one phrase to remember. Say it and
> your agent picks up the comments, works through them, and the pins turn green.
> And yes, the *please* is on purpose — be nice to your coding agents and
> they'll be nice to your codebase. ;-)

It's for developers and agents working on **local** projects — not a browser
extension, and it never attaches to public sites you browse. It ships as a
[Claude Code](https://claude.com/claude-code) plugin plus a self-contained,
zero-dependency Node server that works with any agent (or none).

## Install (Claude Code)

```
/plugin marketplace add baskb/feedback-studio
/plugin install feedback-studio@feedback-studio
```

Then, in any project:

```
/feedback-studio:demo                   # try it on a bundled sample page — no site needed
/feedback-studio:feedback start         # launch the overlay on this project's site
/feedback-studio:feedback process       # work through the collected comments (= PPF)
/feedback-studio:feedback watch         # stay live: your agent reacts while you review
/feedback-studio:verify                 # prove each processed comment landed on the right element
/feedback-studio:report                 # write a shareable digest of the round (.feedback/REPORT.md)
```

No Claude Code required:

```bash
npx feedback-studio --demo                          # instant playground, zero setup
npx feedback-studio --dir dist                      # serve a static build
npx feedback-studio --proxy http://localhost:5173   # wrap a running dev server
npx feedback-studio --md report.md                  # review a Markdown file
```

## Nine ways people use it

Every story below is one sentence to your agent (or one `npx` line) away.

**1. The builder with a half-finished landing page.**
You squint at your dev build and see eleven small things wrong. Instead of
writing a novel in the chat box, you press **C**, click each thing, and type a
line: *"this should say beans, not beens"*, *"make this button do something"*.
Then: **PPF**. Your agent fixes each one at the exact element you pointed at,
shows you the diffs, and the pins flip green as it goes.
→ *"start Feedback Studio"* · `npx feedback-studio --dir dist`

**2. The "two pixels to the left" perfectionist.**
You know the card padding is wrong; you don't know if it's 20px or 24px wrong.
Open **Tweak style** in the composer and drag the knobs — padding, text size,
colors, corners, opacity — and watch the page respond **live** until it looks
right. Save, and the exact values (`padding: 16px → 24px`) travel to your agent,
which writes them into your real CSS, Tailwind classes, or design tokens. The
preview reverts; the source gets the truth. No more "a bit more air maybe?".
→ press **C**, click the element, open *Tweak style*

**3. The copy editor at heart.**
Why describe a wording change when you can just… type it? **Double-click** any
text on the page and retype it in place — the before/after diff is saved
verbatim, and your agent applies your exact words to the source. On a rendered
Markdown file this is the killer move: edit the sentence in the pretty view,
and the `.md` gets patched.
→ double-click text, or use *Edit text on page* in the composer

**4. The couch reviewer.**
It's 9pm. The build is on your machine upstairs; you are not. Open the tunnel
link on your phone, tap an element (▲/▼ picks the right nested one), hold the
mic, and *talk*. Eighteen dictation languages, real HTTPS, no cert warnings.
Tomorrow morning: **PPF**.
→ *"start Feedback Studio, mobile-ready"* · `npx feedback-studio --dir dist --tunnel`

**5. The writer with a 40-page draft.**
Reports, plans, research — Markdown renders as a clean page and every heading,
paragraph, and table cell is commentable: `rephrase`, `expand`, `delete`,
`question`. Comments carry the **source file path**, so the agent edits the
`.md`, never the throwaway HTML. The **Stamp .md** button can also write
portable `<!-- @FB ... -->` markers straight into the file for handoff through
git or a PR.
→ *"review report.md with Feedback Studio"* · `npx feedback-studio --md report.md`

**6. The pair-programmer who wants it now.**
Why batch? Say *"watch the feedback"* and your agent goes **live**: an "agent
online" chip appears in the panel, questions you pin get answered on the thread
within seconds, `auto` comments get applied while you watch, and `review` ones
queue politely for your approval. It's the closest thing to having the agent
sit next to you — because it is.
→ *"watch the feedback"* / *"go live"*

**7. The freelancer with a client.**
Friday, 4pm: *"can you send it over for feedback?"* Run with `--share --tunnel`
and hand out role-scoped links: **view** (look, don't touch), **comment** (pin
notes and reply, signed with their name — but no deleting your team's pins),
**admin** (the works). A link *is* its role; keys rotate every server start;
without one, the feedback layer simply isn't there.
→ *"start Feedback Studio with share links"* · `npx feedback-studio --dir dist --share --tunnel`

**8. The skeptic.**
*"But will the AI edit the right thing?"* Fair question — it's the whole design.
Every comment carries multiple independent anchors plus a **screenshot of the
element at pin time**, and everything re-resolves with a confidence score. When
confidence is low, the agent **refuses and asks for a re-pin** instead of
guessing — measured on a hard real-world page: 25/25 anchors re-resolved after
realistic rebuilds, and in a deliberately harsh worst case every lost anchor
degraded to a re-pin request, never a confident wrong edit
([method & numbers](HARNESS.md)). Afterwards, `/feedback-studio:verify` re-opens
the page and *proves* each resolved comment actually landed — reopening any that
didn't.

**9. The role reversal.**
Feedback flows both ways: say *"have a frontend reviewer leave comments on my
site"* (or copy, accessibility, marketing…) and the AI pins **its own**
suggestions to the exact elements it means. You reply, approve, or reject each
one on its thread before anything changes. Element-anchored code review, in
reverse.

## Highlights

- **Comment on the exact thing** — element, heading, image, card, or selected
  text; a numbered pin marks the spot, and threads keep the conversation on it.
- **Show, don't tell** — live style knobs (Tweak Mode) and edit-text-in-place
  record *exact* deltas; previews always revert, the agent edits the source.
- **Smart knobs** — only relevant controls appear (no text size on an image;
  `gap` only on flex/grid), and giving a box a background reveals the corner
  radius knob. The details are the product.
- **Typed or spoken** — dictation in 18 locales, one tap to switch.
- **Latitude per comment** — `fix` (repair it), `change` (apply near-verbatim),
  `improve` (use judgement); Markdown gets document verbs. Plus `review`/`auto`
  autonomy per comment.
- **Live everything** — pins flip green as comments resolve, an agent-presence
  chip shows who's working, no refresh needed.
- **Screenshots as ground truth** — each pin captures what you actually saw
  (auto-attached, gitignored, GC'd with the comment; `--no-shots` to disable).
- **Share with roles** — `--share` mints view / comment / admin capability
  links; your own machine stays frictionless.
- **Private by default** — binds to `127.0.0.1`; `--tunnel` (real-cert HTTPS)
  or `--https --host 0.0.0.0` only when *you* ask.
- **Zero dependencies** — plain Node 18+; optional helpers (`marked`,
  `selfsigned`, `cloudflared`, `html-to-image`) install once, lazily, only for
  the features that need them.

It works with any framework: serve a static build, proxy a Vite/Next/Astro dev
server with live reload, or review Markdown. The overlay lives in its own
shadow-DOM layer and never durably alters your site — every live preview
reverts on close; only your agent changes source, and only through your
comments.

## Use the server directly (without Claude Code)

```bash
npx feedback-studio --dir dist                      # serve a static build
npx feedback-studio --proxy http://localhost:5173   # proxy a running dev server
npx feedback-studio --md report.md                  # review one Markdown file
npx feedback-studio --md docs/ --tunnel             # a folder of docs, phone-ready
npx feedback-studio --dir dist --share --tunnel     # client review with role links
```

Or `npm i -g feedback-studio`, or run `node plugins/feedback-studio/bin/feedback-studio.mjs` from a clone.

| Flag | Meaning |
|---|---|
| `--demo` | Serve the bundled sample page from a throwaway temp copy, pre-seeded with example comments. The fastest first run; never touches your project. |
| `--no-seed` | With `--demo`: start with **no** comments, so you add your own live. |
| `--dir <path>` | Serve a static build directory. |
| `--proxy <url>` | Proxy a running dev server and inject the overlay (live reload). |
| `--md <file\|dir>` | Render a Markdown file or folder to reviewable pages. Fetches a small renderer once. |
| `--share` | Mint **view / comment / admin** capability links (printed at start; keys rotate every run). Your own machine keeps keyless access; `--share strict` requires a key even locally. |
| `--no-shots` | Disable pin-time element screenshots. |
| `--port <n>` | Listen port (default `4444`). |
| `--host <addr>` | Bind address (default `127.0.0.1`). Use `--host 0.0.0.0` to reach it from your phone or LAN. |
| `--tunnel` | Public HTTPS URL via a Cloudflare quick tunnel: real cert, no warning, mic works, any network. Fetches `cloudflared` once; no account needed. |
| `--https` | TLS with a self-signed cert for phone voice over the LAN (one-time "not private" tap-through). `--tunnel` avoids the warning. |
| `--no-open` | Don't auto-open the browser. |
| `--seed-agents` | Append the processing workflow to this project's `CLAUDE.md` + `AGENTS.md` (idempotent), then exit — so any agent knows the flow without the plugin. |

The overlay starts in **light theme** (panel toggle for dark, remembered per
browser). Drag the **Comment button** to any corner; on desktop, drag a composer
by its header. Use **Chrome or Edge** for voice.

> **Requires Node 18+.** Runtime HTTP has zero dependencies; `--https`, `--md`,
> `--tunnel`, and screenshots lazily install one helper each into
> `~/.feedback-studio/` on first use only.

## Use with other agents (Codex, Cursor, ChatGPT)

The capture side is agent-agnostic and the data is plain files: any agent can
read `.feedback/comments.json` or the human-readable `.feedback/FEEDBACK.md`
(a generated `.feedback/HOW-TO-PROCESS.md` explains the workflow to agents that
have never seen this tool).

There is also an **MCP server** (`bin/feedback-studio-mcp.mjs`) for local
MCP-capable agents such as Codex CLI, Cursor, Windsurf, and Cline — tools:
`list_comments`, `get_comment`, `add_comment`, `reply`, `set_status`. It ships
with the plugin but is **not activated by default in Claude Code** (the skill
reads the files directly; no always-on server in every turn). Full setup is in
[INTEROP.md](INTEROP.md).

## Where comments live

- `.feedback/comments.json` — structured source of truth (page, anchors, text,
  exact style/text deltas, thread, status, autonomy).
- `.feedback/FEEDBACK.md` — readable digest grouped by page.
- `.feedback/shots/` — pin-time element screenshots (visual ground truth).

Add `.feedback/` to your `.gitignore` — it's review data, not site content, and
screenshots can capture whatever was on screen. The server checks this at
startup and warns you if it's missing.

## Reviewing Markdown, and the `Stamp .md` button

In `--md` mode each comment records the **source `.md` path**. The rendered HTML
is throwaway; the agent edits the file. Two handoff paths:

- **`.feedback/comments.json`** — the rich record: threads, status, types, and
  exact `rephrase` wording from in-place edits.
- **Inline `<!-- @FB ... -->` markers** written into the `.md` by the
  **Stamp .md** panel button — invisible when rendered, greppable, and they
  travel with the file through git, a PR, or any tool that never heard of
  `.feedback/`.

| Type | Marker written onto the line |
|---|---|
| comment | `<!-- @FB: your note -->` |
| rephrase | `<!-- @FB: rephrase as "your note" -->` |
| expand | `<!-- @FB-EXPAND: your note -->` |
| delete | `<!-- @FB-DELETE: your note -->` |
| question | `<!-- @FB-Q: your note -->` |

Stamping is deliberate and careful: the marker lands only on a **uniquely**
matching line (zero or several matches → the comment stays open for a re-pin
instead of guessing), a `.bak` is saved first, and re-running never duplicates.

> **Trusted input:** the rendered page shares an origin with the comment API, so
> Feedback Studio strips active content (scripts, inline handlers, `javascript:`
> URLs) from rendered Markdown. That is defense in depth, not a full sanitizer —
> prefer local (loopback) mode when reviewing a `.md` you didn't write.

## Notes & limits

- **Easiest phone path: `--tunnel`.** Real cert, mic works, any network; Ctrl+C
  revokes the URL. **Tradeoff:** it's the one mode that sends data off your
  machine (through Cloudflare's servers, nothing stored). Anyone with the bare
  link can view the *page*; add `--share` so the *feedback layer* needs a
  role key. Prefer LAN or local mode for sensitive content.
- **Share links are capabilities.** A link is its role while the server runs;
  keys rotate every start; stopping the server revokes everything. They gate
  the feedback layer only — the site pages themselves are served to anyone
  with the URL. (And a browser quirk worth knowing: on localhost, cookies
  scope by hostname, not port.)
- **Voice** needs a Chromium browser over a secure context (`localhost` and
  `--tunnel` both count; plain `http://<lan-ip>` doesn't — use `--tunnel` or
  `--https`). One honest caveat: dictation uses the browser's speech engine,
  which sends audio to its cloud recognizer — so voice, unlike everything else
  here, is not purely local. Type when that matters.
- **Screenshots** are best-effort by design: the first capture downloads
  `html-to-image` once; if anything fails, the comment simply has no image.
  They live in gitignored `.feedback/shots/` and are deleted with their
  comment. `--no-shots` turns the feature off entirely.
- **Phone can't connect on the LAN?** Start with `--host 0.0.0.0` (and allow
  Node through the firewall), or skip all of it with `--tunnel`.
- **Static vs proxy**: static mode needs a rebuild to see content changes;
  proxy mode reflects live edits and forwards dynamic routes to the dev server.

## License

MIT. See [LICENSE](LICENSE).
