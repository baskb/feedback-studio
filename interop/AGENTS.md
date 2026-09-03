# (snippet) Paste into your project's AGENTS.md or CLAUDE.md

`feedback-studio --seed-agents` writes the block below into your `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex / Cursor / Cline / Windsurf) automatically, guarded by a marker so it is never duplicated. You can also paste it by hand. This file is generated from the same text the command writes (`scripts/release-sync.mjs`); edit `AGENTS_SNIPPET_BODY` in `plugins/feedback-studio/lib/store.mjs`, not this file.

## Feedback Studio

Visual review comments for this project's site(s) live under a `.feedback/` dir —
`.feedback/comments.json` is the source of truth (readable mirror `.feedback/FEEDBACK.md`; full
how-to `.feedback/HOW-TO-PROCESS.md`). They come from a local overlay where a human clicks/taps
an element, or selects Markdown text, and leaves a typed or spoken note.

**Multi-site repos:** if this repo has several sites, each runs its own session and keeps its own
`.feedback/` dir (one beside each site, each with a `meta.json` naming the site). Scan the repo
for `.feedback/` dirs, read each `meta.json` label, and process each site against its OWN
`comments.json` — a comment / screenshot / replacement image belongs to the site whose dir it
lives in; image paths resolve relative to that dir. Never mix them across sites.

When the user says **PPF** (*Please Process Feedback*) — or just "process the feedback":

- **Read** the open comments — use the `feedback-studio` MCP tools (`list_comments`,
  `get_comment`) if configured, else read the `.feedback/comments.json` for each site (the
  source of truth; never act off `FEEDBACK.md`).
- **Locate** each comment's target by its quoted anchor text, cross-checked with the selector,
  and **refuse rather than edit the wrong element.** Act per its `type` (web: `fix` / `change`
  / `improve`; Markdown: edit the `sourceFile`, not the rendered HTML). A `question` (either
  mode) is the user ASKING — **answer it in a reply with a `file:line` pointer, don't edit.**
  A comment with `via:"narration"` was spoken (wording may be looser). Present a diff.
- **Resolve** when done, and **leave a short reply** on each saying what you changed (plain,
  one sentence — the overlay's "walk me through the changes" reads it aloud): `set_status`
  (MCP), else PATCH `/__feedback/api/comments/<id>` `{"status":"resolved"}`, else edit the
  JSON. Use `reply` to answer/explain, `add_comment` to leave your own pins to approve.

(The *please* in PPF is deliberate — we're courteous to our coding agents. ;-)
