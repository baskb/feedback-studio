---
description: Launch Feedback Studio on this project, or process the collected review comments.
argument-hint: [start <dir | --md file | --proxy url> | process]
---

You are driving **Feedback Studio**, a local visual feedback tool. The reviewer
comments (typed or spoken) on elements of a website or passages of a Markdown
file; comments live in `.feedback/comments.json` and you act on them.

Request: $ARGUMENTS

## If asked to START a session
Run the server in the background and tell the user the URL it prints:
- Website build: `node <FBS>/bin/feedback-studio.mjs --dir dist`
- Dev server (live reload): `node <FBS>/bin/feedback-studio.mjs --proxy http://localhost:5173`
- Markdown file/folder: `node <FBS>/bin/feedback-studio.mjs --md report.md`
Add `--https` for phone + voice. (`<FBS>` = the feedback-studio plugin path.)

## If asked to PROCESS comments
Prefer the MCP tools if the `feedback-studio` MCP server is configured
(`list_comments`, `get_comment`, `reply`, `set_status`); otherwise read
`.feedback/comments.json` / `.feedback/FEEDBACK.md` directly.

For each open comment:
- Locate the target with confidence using the anchor's quoted text (search the
  source) cross-checked with the selector. If you cannot identify it confidently,
  do NOT edit a guess. Leave it open and say it needs a re-pin.
- Act per the comment `type`: web: `fix` (repair), `change` (apply verbatim),
  `improve` (rewrite with judgement); markdown: `comment`/`rephrase`/`expand`/
  `delete`/`question`. For markdown, edit the `sourceFile`, not the rendered HTML.
- Present changes as a diff for the user. After applying, set the comment's status
  to `resolved` (via `set_status` or by editing comments.json). Honour `approved`
  vs `open`; implement `approved` items.

Summarise what you changed grouped by page/file, and list anything left open.
