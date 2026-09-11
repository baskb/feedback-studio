---
description: Launch Feedback Studio on this project, or process the collected review comments.
argument-hint: [start <dir | --md file | --proxy url> | process]
---

You are driving **Feedback Studio**, a local visual feedback tool. The reviewer comments, typed or spoken, on elements of a website or passages of a Markdown file. Comments live in `.feedback/comments.json`, and you act on them.

Request: $ARGUMENTS

## If asked to START a session

Run the server in the background and tell the user the URL it prints:

- Website build: `node <FBS>/bin/feedback-studio.mjs --dir dist`
- Dev server (live reload): `node <FBS>/bin/feedback-studio.mjs --proxy http://localhost:5173`
- Markdown file/folder: `node <FBS>/bin/feedback-studio.mjs --md report.md`

For phone + voice over the LAN add `--https --host 0.0.0.0`; or use `--tunnel`, which needs no extra flag; or, on a Tailscale tailnet, `--tailscale` (private, real certificate, nothing leaves the tailnet). (`<FBS>` = the feedback-studio plugin path.) `--help` lists every flag.

## If asked to PROCESS comments

Prefer the MCP tools if the `feedback-studio` MCP server is configured. There are six: `list_comments` (start here; defaults to the open and approved ones), `get_comment` (one comment in full, with its anchor and reply thread), `add_comment` (leave a pin of your own for the reviewer to approve), `reply` (add to a comment's thread; may carry design `variants`), `set_status` (`open` / `approved` / `rejected` / `resolved`), and `set_presence` (`online` / `working` with the comment id / `offline`, so the open page shows what you are doing). Otherwise read `.feedback/comments.json` directly. `.feedback/FEEDBACK.md` is a generated mirror: read it for a quick look, never act off it. `.feedback/HOW-TO-PROCESS.md` next to the data holds the full rules.

Before working on a comment call `set_presence` with `{"state":"working","commentId":"<id>"}`; call `{"state":"offline"}` when you leave.

For each open (or approved) comment:

- **Locate the target with confidence** using the anchor's quoted `snippet` (search the source), cross-checked with the `selector`. If you cannot identify the exact element, or in Markdown the exact source line, do not edit a guess. Leave it open, reply that it needs a re-pin, and move on. A confident wrong edit is the worst outcome. A comment with a `shot` field has a screenshot of the pinned element at `.feedback/<shot path>`: look at it when unsure.
- **Act per the comment `type`.** Web: `fix` (reproduce, then repair), `change` (apply near-verbatim, no redesign), `improve` (rewrite with judgement in the project's voice). Markdown: `comment` (address the note), `rephrase`, `expand`, `delete`. Edit the `sourceFile`, never the rendered HTML. `question` (valid in both modes) means the reviewer is asking, not requesting a change: answer in a `reply` with a `file:line` pointer, do not edit, then resolve.
- **Honour `autonomy`.** `review` (the default) means show the change first; `auto` means apply it directly.
- **Apply `edits[]` near-verbatim.** A web comment may carry `edits`: exact CSS deltas the reviewer dialled in live, such as `{"prop":"padding","from":"16px","to":"24px"}`. The target values are fixed; translate each into the project's styling idiom (a stylesheet rule, a utility class, a design token). A comment can be edits-only with empty `text`.
- **Apply `textEdit` verbatim.** `{before, after}` is the reviewer retyping the element's text in place. Find `before` at the anchored location (flexible whitespace; the source may wrap lines or hold inline markup) and apply the exact `after` wording. If `before` no longer matches there, do not guess: leave it open and ask for a re-pin.
- **Apply `imageReplace`.** A web comment may carry a staged image at `.feedback/<imageReplace.media>` plus framing (`target` is `img` or `background`, `fit`, `position`, `w`/`h`, `crop`, `alt`). Copy the file into the project's image folder, point the element at it (`src` plus `alt`, or the CSS `background-image`), and apply the framing as `object-fit`/`object-position` or `background-size`/`background-position`.
- **Variants.** For a vague `improve` you may `reply` with `variants`: two or three self-contained alternatives of the element's markup with styles inlined, `[{label, html, note}]`. The reviewer previews them on the page and picks one; the pick comes back as a reply with `pick: {of, index, label}` (often with status `approved`). Implement only a picked variant, in the project's idiom. Never apply one nobody picked.
- **A comment with `via: "narration"` was spoken**, so its wording may be loose; propose a concrete reading in your reply if it is unclear.
- Present changes as a diff. After applying, set the status to `resolved` (`set_status`, or by editing `comments.json` when the server is not running) and leave a one-sentence reply saying what you changed in plain words; the page can read it aloud. A reply is not a status: if you applied the change, resolve in the same step. A status of `approved` is the go-ahead to implement now.

Summarise what you changed grouped by page or file, and list anything left open and why (a re-pin needed, a decision needed).
