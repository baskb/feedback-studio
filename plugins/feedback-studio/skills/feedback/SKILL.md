---
name: feedback
description: Visual feedback overlay for a local website or Markdown file. The user clicks or selects anything and leaves a typed or spoken comment (even from their phone); you later process those comments, and you can also pin your OWN review comments to elements for the user to approve. Use to review a site or `.md`, start it phone/mobile-ready, process the feedback, or leave AI review comments on a page.
when_to_use: Use when the user wants to visually review or comment on a local website or a Markdown file (optionally from their phone, by voice); OR to process the comments they collected and apply them; OR when you (or another skill, e.g. a design/copy/accessibility reviewer) should leave review comments pinned to specific elements for the user to approve. Trigger phrases include "review/open my site", "give feedback on this .md", "start it mobile-ready", "process the feedback", and "leave review comments on this page".
argument-hint: [start | process | --dir <path> | --proxy <url> | --md <file> | --https | --tunnel]
user-invocable: true
allowed-tools: Bash Read Edit Write Glob Grep
---

# Feedback Studio

A local overlay where the user clicks any element (or selects text) and leaves a typed or
spoken comment; everything saves to `.feedback/comments.json` (plus a readable
`.feedback/FEEDBACK.md`). You either **start a session** or **process the comments**.

Set `FBS=${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs` (the Node tool; zero-dep for HTTP),
and use `"$FBS"` below. Intent: *start / open / review / serve* means start a session;
*process / apply / work through* means process. If unclear and there are open comments, ask which.

## Start a session

Run the server in the **background**, then open the URL it prints.

- **Dev server already running** (live reload): `node "$FBS" --proxy http://localhost:<devport>`
- **Static build** (auto-detects `dist/ build/ out/ _site/ public/ .output/public/`): `node "$FBS"` (or `--dir <folder>`). Build first if needed (check `package.json`).
- **Markdown** (a `.md` file, or a folder of them): `node "$FBS" --md <file|dir>`.
- **Phone with voice:** add `--tunnel` (real-cert public URL, easiest) or `--https --host 0.0.0.0` (self-signed, same Wi-Fi; without `--host` the phone can't reach it). Plain http is fine for laptop, or for typing on a phone.

Open it: `start <url>` (Windows) / `open <url>` (macOS) / `xdg-open <url>` (Linux). Tell the
user: press **C** or hit **Comment** (bottom-right), click an element (on a phone, tap then
▲/▼ to pick), or select text; the **mic** dictates. Comment mode persists across pages.
Ensure `.feedback/` is gitignored.

## Markdown mode

Types become document verbs: `comment` / `rephrase` / `expand` / `delete` / `question`
(websites use `fix` / `change` / `improve`). Each comment carries its **`sourceFile`** (the
`.md`); edit that file, not the throwaway rendered HTML. The panel's **Stamp .md** button can
also write inline `<!-- @FB[-VERB]: ... -->` markers onto the source line (saving a `.bak`).
Processing from markers: `grep -n "@FB"`, edit each line, then delete the marker you handled.

## Process comments

1. Read `.feedback/comments.json` (the SOLE source of truth; `FEEDBACK.md` is a generated,
   possibly-stale mirror, never act off it). Each comment has `page`, `type`, `anchor`
   (selector / attr / xpath / quoted `snippet` / `tag`), `text`, `autonomy`, `status`.
2. **Put the batch on your task list** (TaskCreate / TodoWrite, whichever you have; skip if
   there's only one comment): one task per open comment, subject `<page>: <short summary>`.
   Mark it in_progress when you start that comment and completed the moment you set the
   comment resolved, so the user watches the list tick down as the pins turn green. A comment
   that needs a re-pin keeps its task open.
3. For each `open` comment, grouped by page:
   - **Locate it with confidence** using the quoted snippet first, cross-checked with the
     selector. **If you cannot identify the exact element (or, in Markdown, the exact source
     line), do NOT edit a guess.** Leave it open and say it needs a re-pin. A confident wrong
     edit is the worst outcome; silence beats it.
   - **Act per `type`:** `fix` = reproduce then patch; `change` = apply near-verbatim, no
     redesign; `improve` = rewrite with judgement in the project's voice. If a (spoken) comment
     is vague, propose a concrete interpretation; for `improve`, offer options. Keep the
     project's conventions (read any CLAUDE.md).
4. Present changes as **diffs grouped by page**. Honour `autonomy`: `review` (default) = show
   first; `auto` = apply directly. Mark each resolved when applied (the pin flips green live):
   PATCH `/__feedback/api/comments/<id>` with `{"status":"resolved"}` if the server is running,
   else set `"status":"resolved"` in the file.
5. Summarise by page, and list anything left open (low-confidence anchors, decisions needed).

## Author your own comments (optional)

You can pin your own comments for the user to review or approve, anchored by visible text (no
DOM needed). With the server running:

```
POST /__feedback/api/comments
{"page":"/","author":"agent","authorName":"<your role>","type":"improve",
 "anchor":{"snippet":"<exact visible text of the element>"},"text":"..."}
```

On a web page use a web type (`fix` / `change` / `improve`); `comment` is a Markdown
type and would be coerced to `change`. Add `"sourceFile":"<file.md>"` in Markdown mode,
where `"type":"comment"` is correct. Reply with `POST /__feedback/api/comments/<id>/reply`.
Leave proposals `open` so they surface as "to review"; a clear `authorName` labels the pin.

## Notes

- Anchors use several strategies (attr/id, selector, xpath, quoted text); resolve by the most
  agreement, and expect them to survive a rebuild while the content is still recognisable.
- The overlay injects one `<script>` and lives in a shadow root; it never alters the site's
  DOM, styles, or source files.
- An **MCP server** ships with the plugin (`bin/feedback-studio-mcp.mjs`) but is **not activated
  by default** in Claude Code: reading the comment files is enough, and skipping it keeps token
  use low. It exists for other agents (Codex, Cursor, Windsurf, Cline) via their own MCP config.
  See INTEROP.md.
