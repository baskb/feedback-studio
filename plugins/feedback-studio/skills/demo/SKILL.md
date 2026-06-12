---
name: demo
description: Instant Feedback Studio playground — serves a bundled sample landing page (a throwaway copy in a temp dir) pre-seeded with three comments, one per type (fix / change / improve), plus a few flaws left to find. The fastest way to experience the click-comment-process loop without needing a site of your own.
when_to_use: Use when the user wants to try, demo, learn, or show off Feedback Studio without pointing it at a real project — "try the demo", "show me how this works", "feedback studio demo", "I don't have a site to test on". Also the right starting point when recording a demo video or GIF.
argument-hint: [--tunnel | --https | --port <n>]
user-invocable: true
allowed-tools: Bash Read Edit Glob Grep
---

# Feedback Studio — demo playground

Serves a bundled, deliberately imperfect landing page ("Roastly") from a **throwaway
temp-dir copy**, pre-seeded with three open comments — one `fix` (a typo), one `change`
(a button label), one `improve` (a bland headline). Processing them edits the copy,
never the user's project. The page also hides a couple of un-pinned flaws (a lorem-ipsum
leftover, a stale footer year) for the user to find and pin themselves.

## Start it

Run in the **background**, then open the printed URL:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs" --demo
```

Pass through any extra flags the user asked for (`--tunnel` for phone voice, `--port`).
**Capture two paths from the server output** — you need them for processing:

- `Source -> demo site (throwaway copy: <DEMO_DIR>)`
- `Comments -> <DEMO_DIR>/.feedback/comments.json`

Open the URL (`start <url>` Windows / `open <url>` macOS / `xdg-open <url>` Linux), then
tell the user, briefly:

1. The numbered pins are the three pre-seeded comments — click one to read it.
2. Press **C** (or the Comment button), then click any element or select text, to add
   their own; the **mic** dictates. Two more flaws are hidden on the page — try to spot
   and pin them.
3. When they're ready, say **"process the feedback"**.

## Process the demo feedback

Follow the standard processing workflow from the `feedback` skill, with two overrides:

- Read comments from **`<DEMO_DIR>/.feedback/comments.json`** (not the project's).
- Edit **`<DEMO_DIR>/index.html`** (the throwaway copy) — never files in the user's repo.

Statuses still update live: PATCH `http://localhost:<port>/__feedback/api/comments/<id>`
with `{"status":"resolved"}` so the user watches the pins flip green. The seeded comments
are real examples of each type's latitude: the `fix` is a typo to patch, the `change` is
near-verbatim, the `improve` wants your judgement (propose a headline, offer options).

## After the loop

Point the user at the real thing: `/feedback-studio:feedback start` on their own site or
Markdown file. If they enjoyed the phone flow, mention `--tunnel`. The demo dir is a temp
folder; the OS cleans it up, nothing to undo.
