---
name: feedback
description: Launch a local visual feedback overlay on this project's website so the user can comment (typed or spoken) on any element of any page, and later process those comments. Use when the user wants to review a site, leave UI/content feedback, asks to "open the site to review", or says "process the feedback".
when_to_use: The user wants to visually review or comment on a local website, or asks to process the feedback/comments that were collected.
argument-hint: [start | process | --dir <path> | --proxy <url> | --https | --port <n>]
user-invocable: true
allowed-tools: Bash Read Edit Write Glob Grep
---

# Feedback Studio

A local commenting overlay for the project's website. The user clicks any element
(or selects text) on any page and leaves a typed or spoken comment; everything is
stored in `.feedback/comments.json` (plus a readable `.feedback/FEEDBACK.md`) for
you to process on their signal.

The tool lives at `${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs` (Node, no install
needed for HTTP). There are two things you do: **start a review session** and
**process the collected comments**.

## Decide the intent

- Words like *start, open, review, serve, let me comment, feedback session* → **Start a session**.
- Words like *process, apply, work through, handle the feedback/comments* → **Process comments**.
- If ambiguous and `.feedback/comments.json` has open comments, ask which they want.

## Start a review session

1. **Pick how to serve the site.** Prefer a proxy if a dev server is already running
   (gives live reload); otherwise serve a static build.
   - **Proxy mode** (any framework, live reload): if the user has a dev server up, or
     mentions one (Vite, Next, Astro dev, etc.), use its URL:
     `node "${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs" --proxy http://localhost:<devport>`
   - **Static mode**: build the site if needed (check `package.json` scripts for
     `build`), then point at the output. Auto-detection covers `dist/ build/ out/
     _site/ public/ .output/public/`, so often no `--dir` is needed:
     `node "${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs"` (auto-detect)
     or `... --dir <folder>` to be explicit.
2. **Add `--https`** if the user wants to comment from their **phone with voice**
   (the mic only works in a secure context off-localhost). Plain HTTP is fine for
   laptop use and for typing on a phone.
3. **Run it in the background** so the session continues, e.g. a background Bash task.
   Read the printed banner for the exact URLs (it prints a `localhost` URL and a LAN
   URL for the phone).
4. **Open it** for the user: `start <url>` on Windows, `open <url>` on macOS,
   `xdg-open <url>` on Linux. Then tell them: turn on **Comment** (bottom-right, or
   press `C`), click any element (on a phone, tap then use ▲/▼ to pick the right
   element), or select text; the **mic** dictates. They can sweep all pages; comment
   mode persists across navigation.
5. Make sure `.feedback/` is gitignored (add it if a `.gitignore` exists and lacks it).

## Process comments

1. Read `.feedback/comments.json` (source of truth) — or `.feedback/FEEDBACK.md`
   for a readable grouped view. Each comment has: `page` (path), `type`
   (`fix`/`change`/`improve`), `anchor` (a css `selector` + `attrSelector` + `xpath`
   + a quoted `snippet`/`rangeText` + `tag`), the `text`, `autonomy`, and `status`.
2. Work through every comment whose `status` is `open`, grouped by page. For each:
   - **Locate the element with confidence.** Resolve the anchor in the source using
     the snippet text first (grep the rendered words), cross-checked against the
     selector/attr/xpath. **If you cannot confidently identify the one element the
     comment refers to, do NOT edit a guess.** Leave it open, and tell the user it
     needs a re-pin. Editing the wrong node is the worst outcome — silence beats a
     confident wrong edit.
   - **Act according to the `type`:**
     - `fix` — reproduce the problem, then patch it. Lowest latitude, highest certainty.
     - `change` — apply near-verbatim to the anchored element/text. Do not redesign around it.
     - `improve` — rewrite or redesign the anchored thing with judgement, keeping the project's voice.
   - If the comment text is vague (spoken comments can be garbled), propose a concrete
     interpretation rather than guessing silently; for `improve`, offer options.
   - Keep the project's own conventions and voice (read any CLAUDE.md / style rules).
3. **Present the work as reviewable diffs grouped by page for the user to approve.**
   Honour `autonomy`: `review` (default) = show the diff and let them apply/accept;
   `auto` = apply directly. When in doubt, show the diff.
4. After a comment's change is applied, mark it resolved (the pin flips green live):
   - PATCH it if the server is running:
     `curl -s -X PATCH http://localhost:<port>/__feedback/api/comments/<id> -H "Content-Type: application/json" -d "{\"status\":\"resolved\"}"`, or
   - edit `.feedback/comments.json` directly (set `"status": "resolved"`).
5. Summarise what you changed, grouped by page, and explicitly list anything you left
   open (low-confidence anchors needing a re-pin, or decisions you need from the user).

## Notes

- **Anchors** carry several strategies (stable attribute/id, css selector, xpath, and
  a quoted text snippet). The overlay resolves with the most agreement and survives a
  rebuild as long as the content is still recognisable; you should do the same in source.
- **Spoken comments** can be slightly garbled (speech-to-text). Read for intent; if a
  rewrite request lacks direction, offer options.
- The tool injects only a `<script>` into each page and mounts its UI in a shadow root,
  so it never alters the site's own DOM/styles or its source files.
- Dynamic backends (PHP, API routes) won't run in static mode; proxy mode forwards them
  to the dev server. For pure content/UI review, static mode is usually enough.
