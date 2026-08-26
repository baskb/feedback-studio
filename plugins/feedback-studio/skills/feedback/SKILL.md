---
name: feedback
description: Visual feedback overlay for a local website or Markdown file. The user clicks or selects anything and leaves a typed or spoken comment (even from their phone); you later process those comments, and you can also pin your OWN review comments to elements for the user to approve. Use to review a site or `.md`, start it phone/mobile-ready, process the feedback, or leave AI review comments on a page.
when_to_use: Use when the user wants to visually review or comment on a local website or a Markdown file (optionally from their phone, by voice); OR to process the comments they collected and apply them; OR to stay live during the review (watch mode - answer question pins in seconds, apply auto comments as they arrive); OR when you (or another skill, e.g. a design/copy/accessibility reviewer) should leave review comments pinned to specific elements for the user to approve. Trigger phrases include "review/open my site", "give feedback on this .md", "start it mobile-ready", "process the feedback", "watch the feedback / go live", and "leave review comments on this page".
argument-hint: [start | process | watch | --dir <path> | --proxy <url> | --md <file> | --https | --tunnel | --label <name> | --data-dir <path>]
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

Run the server in the **background** with `--no-open` (you open the URL yourself in the step
below; if the server auto-opens a tab too, you get a double-load flash), then open the URL it
prints.

- **Dev server already running** (live reload): `node "$FBS" --proxy http://localhost:<devport> --no-open`
- **Static build** (auto-detects `dist/ build/ out/ _site/ public/ .output/public/`): `node "$FBS" --no-open` (or `--dir <folder> --no-open`). Build first if needed (check `package.json`).
- **Markdown** (a `.md` file, or a folder of them): `node "$FBS" --md <file|dir> --no-open`.
- **Phone with voice:** add `--tunnel` (real-cert public URL, easiest) or `--https --host 0.0.0.0` (self-signed, same Wi-Fi; without `--host` the phone can't reach it). Plain http is fine for laptop, or for typing on a phone.

Open it: `start <url>` (Windows) / `open <url>` (macOS) / `xdg-open <url>` (Linux). Tell the
user (buttons are bottom-right): **Point** (shortcut **P**) to click an element and comment
(on a phone, tap then ▲/▼ to pick), or select text; **Talk** (shortcut **T**) to narrate by
voice; **List** for the overview. The **mic** also dictates inside the composer. Point mode
persists across pages. Ensure `.feedback/` is gitignored.

**Multiple sites in one repo.** Run one session per site — each on its own port, with a
`--label` (its name) and its own `--data-dir` beside the site so the data lives with it. From
the repo root:
- `node "$FBS" --dir sites/marketing/dist --data-dir sites/marketing/.feedback --label Marketing --port 4001 --no-open`
- `node "$FBS" --dir sites/docs/dist --data-dir sites/docs/.feedback --label Docs --port 4002 --no-open`
- `node "$FBS" --dir sites/app/dist --data-dir sites/app/.feedback --label App --port 4003 --no-open`

Each site gets its **own** `.feedback/` (comments + screenshots + replacement images + a
`meta.json` naming it); the overlay shows the label so open tabs are told apart. Gitignore
`**/.feedback/`. To **process**: handle each site against its own `.feedback/` (see below) — a
comment/image belongs to the site whose dir it lives in; never mix them.

**Or just talk: "Talk me through it".** Open the panel and hit the **🎙 Narrate** button, then
walk the page by voice while moving the cursor ("this hero's too quiet… make this button
orange… the footer year is wrong"). Feedback Studio times the speech and the pointer together
and, on Stop, **pins each spoken comment to the element you were pointing at** (the
"Put-That-There" idea) — just like a manual comment, so they appear immediately and PPF picks
them up (marked `via:"narration"`). Only the ones it *couldn't confidently place* pop up in a
small tray asking the user to point at the element (or save without a pin).
When you process these, treat the wording as spoken (looser, may need a light interpretation),
but honour the pinned element and the usual refuse-and-re-pin rule. **Privacy:** narration is a
continuous, multi-minute capture — like the mic dictation, the audio is transcribed by the
browser's cloud speech service (not local); only the resulting text + pointer data are kept
locally. No audio is recorded or stored in this phase. Tell the user if that matters to them.

**Sharing with a colleague or client:** add `--share` (pairs well with `--tunnel`). The
server prints three capability links — **view** (read-only pins/panel), **comment** (add
comments + replies; no resolve/edit/delete — named via a "Your name" field), **admin**
(everything). A link IS its role: anyone holding it can act while the server runs; keys
change every start, and this computer keeps keyless full access (use `--share strict` to
require the admin key locally too — agents calling the API then need `?key=<admin>`).
Give the user the link matching what the other person should be able to do. Two honest
caveats to relay: share keys gate the **feedback layer only** — the site pages themselves
are served to anyone with the URL; and on localhost the key cookie is hostname-scoped
(browser rule), so other local dev servers technically receive it — keys rotate every
start, so the exposure window is one session.

## Markdown mode

Types become document verbs: `comment` / `rephrase` / `expand` / `delete` / `question`
(websites use `fix` / `change` / `improve`). Each comment carries its **`sourceFile`** (the
`.md`); edit that file, not the throwaway rendered HTML. The panel's **Stamp .md** button can
also write inline `<!-- @FB[-VERB]: ... -->` markers onto the source line (saving a `.bak`).
Processing from markers: `grep -n "@FB"`, edit each line, then delete the marker you handled.

## Process comments

The user's cue to start is **PPF** — *Please Process Feedback* (or just "process the
feedback"). When you hear it, run the steps below. (The *please* is on purpose — Feedback
Studio is polite to its agents. ;-)

**Multi-site first:** if the repo has more than one `.feedback/` dir (one per site — check for
`sites/*/.feedback/` or scan the repo), process **each independently, one at a time.** Read each
dir's `meta.json` for the site's `label`, and run the steps below against that dir's
`comments.json`. A comment, screenshot (`shot`) or replacement image (`imageReplace.media`)
belongs to the site whose `.feedback/` it lives in, and its image paths resolve relative to
**that** dir. Never move a comment or image between sites. Report results grouped by site label.

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
   - **Use the screenshot when unsure.** A comment with a `shot` field has a pin-time element
     screenshot at `.feedback/<shot path>` — Read (view) the image; it is exactly what the
     reviewer saw. Compare it against the element you located before editing; a mismatch
     means re-pin, not guess. (A comment may likewise carry `imageReplace.media` — a staged
     replacement image at `.feedback/<media path>`; see the apply rule below.)
   - **Act per `type`:** `fix` = reproduce then patch; `change` = apply near-verbatim, no
     redesign; `improve` = rewrite with judgement in the project's voice. If a (spoken) comment
     is vague, propose a concrete interpretation. Keep the project's conventions (read any
     CLAUDE.md).
   - **`question` = answer, don't edit ("Ask the page").** A `question` comment (now valid on
     web elements too, not just Markdown) is the reviewer asking about the pinned thing — "what
     does this do?", "why is this here?", "where's this defined?". Locate the element, then
     **reply in its thread** (`POST /__feedback/api/comments/<id>/reply` or MCP `reply`) with a
     real answer and, when they're asking where/why, a **source pointer** (the `file:line` in
     the codebase that renders this element). Do NOT change code for a question; resolve it once
     answered. If watching (below), these get answered live within seconds.
   - **For a vague `improve`, propose variants the user can TRY on the page.** Reply with
     `variants`: 2–3 self-contained alternatives of the pinned element's markup (outer element,
     styles inlined, real content — the overlay injects them as-is next to the original):
     `POST /__feedback/api/comments/<id>/reply` with `{"author":"agent","text":"3 directions —
     try them on the page","variants":[{"label":"Bolder","html":"<div …>…</div>","note":"…"}]}`
     (or the MCP `reply` tool). The user flips Original/A/B/C live and taps **Use this**; the
     pick lands as a reply with `pick:{of,index,label}` (often + status `approved`). Implement
     ONLY the picked variant — translate its inline styles into the project's idiom — then
     resolve. Never apply an unpicked variant; no pick means the question is still open.
   - **Apply `edits[]` (Tweak Mode) near-verbatim.** Web comments may carry `edits`: exact CSS
     deltas the user dialled in live on the element (e.g. `{"prop":"padding","from":"16px",
     "to":"24px"}`). The *target values* are fixed — the user already saw them on screen — but
     the *representation* is yours: translate each delta to the project's styling idiom
     (stylesheet rule, utility class, or design token; e.g. `24px` → Tailwind `p-6`). A comment
     can be edits-only (empty `text`); the edits are then the whole request. The same
     confidence rule applies: wrong or unsure element ⇒ re-pin, don't guess.
   - **Apply `textEdit` verbatim.** A comment may carry `textEdit: {before, after}` — the user
     retyped the element's text in place. Find `before` at the anchored location (match with
     flexible whitespace; source may wrap lines or contain inline markup) and apply the exact
     `after` wording, preserving surrounding markup. In Markdown edit the `sourceFile`. If
     `before` no longer matches there, do NOT guess — leave it open and ask for a re-pin.
   - **Apply `imageReplace` (new image).** A web comment may carry `imageReplace` with a staged
     image at `.feedback/<media path>` (already downscaled for you) plus framing metadata
     (`target`, `fit`, `position`, `w`/`h`, `crop`, `alt`). Steps: (1) **place the file** —
     copy it from `.feedback/media/…` into the project's image directory (infer it from the
     target element's current `src`, else `public/` `assets/` `static/` `src/` under
     `images/` `img/` `media/`), with a descriptive filename + the staged extension. (2)
     **point the element at it** — `target: "img"` → set the `src` (drop or regenerate any
     stale `srcset`; set `alt` if provided); `target: "background"` → update the CSS
     `background-image: url(...)`. (3) **apply framing** in the project's idiom — `fit` →
     `object-fit` (or `background-size`), `position` → `object-position` (or
     `background-position`), `w`/`h` if the box should resize. Same confidence rule: if you
     can't confidently locate the element, leave it open and ask for a re-pin.
4. Present changes as **diffs grouped by page**. Honour `autonomy`: `review` (default) = show
   first; `auto` = apply directly. If the server is running, **claim each item before you
   touch it** — `POST /__feedback/api/agent-status` with `{"state":"working","commentId":"<id>"}`
   (one call; see *Watch mode* for the details) — so the person watching the page sees which
   pin you are on and how long it takes. Mark each resolved when applied (the pin flips green live):
   PATCH `/__feedback/api/comments/<id>` with `{"status":"resolved"}` if the server is running,
   else set `"status":"resolved"` in the file. (If the server runs with `--share strict`, API
   calls 401/403 without a key — append `?key=<admin key from the startup banner>`.)
   **Leave a short reply on each comment saying what you did** (one sentence, plain — "Bumped
   the headline to 32px and bold." — no file paths or code). This narrates back to the reviewer:
   the overlay's **"Walk me through the changes"** button plays a guided tour that scrolls to
   each element, highlights it, and **reads your reply aloud**. Written for the ear — keep it a
   human, spoken-sounding summary, not a changelog line.
5. **Auto-refresh the open overlays** once the batch is applied, so the user sees the *updated*
   page under its now-green pins (a stale page under green pins looks like the edits didn't land).
   The pins flip green live over SSE, but page content does not reload itself — so after the batch:
   - For a static `--dir`, rebuild first if the project has a build step.
   - Then `POST /__feedback/api/reload` (append `?key=<admin>` under `--share strict`). Every open
     overlay reloads itself — but only when it's safe: if the user has a composer, a variant
     preview, or a text field open, it waits and shows a one-tap **Reload** nudge instead of
     yanking the page. Panel/mode state survives the reload. `--proxy` with live reload already
     refreshes on save; the call is still harmless (belt-and-braces).
   - No server running (you edited `comments.json` on disk)? Then just tell the user to reload.
6. Summarise by page, and list anything left open (low-confidence anchors, decisions needed).

## Watch mode (live session)

Trigger: "watch the feedback", "go live", "feedback watch". Instead of a batch PPF, you stay
present while the user reviews — answering questions on pins within seconds and applying
`auto` comments as they arrive (pins flip green live). Set `S=http://localhost:<port>/__feedback/api`
— while the server runs, `.feedback/session.json` holds `apiBase` (and `adminKey` under
`--share`), so read it instead of guessing the port. (Under `--share strict`, append
`?key=<admin key>` to every call — without it the API answers 401/403.)

1. Ensure a session is running (see *Start a session*), then announce yourself once:
   `curl -s -X POST $S/agent-status -H "Content-Type: application/json" -d '{"state":"online","name":"<short role>"}'`
   The overlay shows an "agent online" chip + a green dot. No heartbeat discipline needed:
   every call you make (the poll below, replies, PATCHes) counts as one, and the plugin's
   hooks report your file edits by themselves. Presence is single-agent (last write wins):
   don't run two watchers on one session.
2. Loop until the user says stop (or ~15 min with no activity): `GET $S/comments` every ~5s
   and diff against what you've seen (new comments, new user replies, status → `approved`).
3. React per item. **Claim it first** so the page shows which pin you are on:
   `POST $S/agent-status` with `{"state":"working","commentId":"<id>","note":"locating the element"}`
   — the pin pulses, its card shows "<you> is on this · elapsed time · latest step", and the
   tab title reads `⚙ #3`. Several arrived at once? Add `"queue":["<id2>","<id3>"]` so those
   cards read "next up". Post a fresh `note` at natural steps ("editing src/Header.jsx",
   "verifying") — file edits are reported for you by the hooks, so this is optional.
   Finishing is automatic: resolving/rejecting the claimed comment, or answering it in a
   reply, drops you back to "online" and writes "done · took 2m" on the card. Only a
   "Queued …" reply parks the item — post `{"state":"online"}` yourself after that one.
   - **`question` (or any comment asking something):** answer in a thread reply
     (`POST $S/comments/<id>/reply`). Don't change code for a question.
   - **`autonomy:"auto"`:** locate with the usual confidence rule — if unsure, reply asking
     for a re-pin instead of editing — then apply, PATCH `{"status":"resolved"}`, and remind
     the user to reload if the page won't hot-reload itself.
   - **`autonomy:"review"`:** reply "Queued — I'll show you this change before applying it."
     and leave it open (batch it for PPF or an approval).
   - **status → `approved`:** that IS the go-ahead — implement it now, then resolve.
   - **A reply with `pick:{of,index,label}`:** the user chose a variant you proposed —
     implement that variant now, then resolve.
4. On exit: `POST $S/agent-status` with `{"state":"offline"}` and summarise the session
   (what was applied, answered, still open).

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
- A generated **`.feedback/HOW-TO-PROCESS.md`** mirrors this processing workflow next to the
  data, for any agent without this plugin. If the user wants their own agent memory to know it,
  run `node "$FBS" --seed-agents` once to append the short version to their `CLAUDE.md` /
  `AGENTS.md` (idempotent — safe to re-run).
