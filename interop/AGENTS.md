# (snippet) Paste into your project's AGENTS.md or CLAUDE.md

`feedback-studio --seed-agents` writes the block below into your `CLAUDE.md`
(Claude Code) and `AGENTS.md` (Codex / Cursor / Cline / Windsurf) automatically,
guarded by a marker so it is never duplicated. You can also paste it by hand.

## Feedback Studio

Visual review comments for this project live in `.feedback/comments.json` (readable mirror:
`.feedback/FEEDBACK.md`; full how-to: `.feedback/HOW-TO-PROCESS.md`). They come from a local
overlay where a human clicks/taps an element, or selects Markdown text, and leaves a typed or
spoken note.

When the user says **PPF** (*Please Process Feedback*) — or just "process the feedback":

- **Read** the open comments — use the `feedback-studio` MCP tools (`list_comments`,
  `get_comment`) if configured, else read `.feedback/comments.json` (the source of truth;
  never act off `FEEDBACK.md`).
- **Locate** each comment's target by its quoted anchor text, cross-checked with the selector,
  and **refuse rather than edit the wrong element.** Act per its `type` (web: `fix` / `change`
  / `improve`; Markdown: edit the `sourceFile`, not the rendered HTML). Present a diff.
- **Resolve** when done: `set_status` (MCP), else PATCH `/__feedback/api/comments/<id>`
  `{"status":"resolved"}`, else edit the JSON. Use `reply` to ask/explain, `add_comment` to
  leave your own pins for the human to approve.

(The *please* in PPF is deliberate — we're courteous to our coding agents. ;-)
