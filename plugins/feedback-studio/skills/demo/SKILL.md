---
name: demo
description: Instant Feedback Studio playground — serves a bundled sample landing page (a throwaway temp-dir copy) for you to comment on, with a few flaws to find. Starts empty by default (you add the comments); pass --seeded for three worked examples, one per type (fix / change / improve). The fastest way to experience the click-comment-process loop without needing a site of your own.
when_to_use: Use when the user wants to try, demo, learn, or show off Feedback Studio without pointing it at a real project — "try the demo", "show me how this works", "feedback studio demo", "I don't have a site to test on". Also the right starting point when recording a demo video or GIF.
argument-hint: [--seeded | --tunnel | --https | --port <n>]
user-invocable: true
allowed-tools: Bash Read Edit Glob Grep
---

# Feedback Studio — demo playground

Serves a bundled, deliberately imperfect landing page ("Roastly") from a **throwaway
temp-dir copy**. By default it starts **empty** — no comments — so the user adds their own
(ideal for a clean walkthrough or recording). The page hides a couple of flaws (a bland
headline, a stale footer year) as ready targets. If the user wants worked examples instead,
the **`--seeded`** option loads three open comments — one `change` (a button label), one
`improve` (a lorem-ipsum paragraph), one `fix` (a typo). Either way, processing edits the
throwaway copy, never the user's project.

## Start it

Run in the **background**, then open the printed URL yourself. Pass `--no-open` so the server
doesn't also auto-open a tab; two opens cause a visible page flash (bad on a demo video). The
demo starts **empty by default** (`--no-seed`):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs" --demo --no-seed --no-open
```

Only if the user wants the three worked example comments (they said `--seeded`, "with
examples", or "seed it") drop `--no-seed`:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/feedback-studio.mjs" --demo --no-open
```

Pass through any extra flags the user asked for (`--tunnel` for phone voice, `--port`).
**Capture two paths from the server output** — you need them for processing:

- `Source -> demo site (throwaway copy: <DEMO_DIR>)`
- `Comments -> <DEMO_DIR>/.feedback/comments.json`

Open the URL (`start <url>` Windows / `open <url>` macOS / `xdg-open <url>` Linux), then
tell the user, briefly:

1. The page starts empty — press **P** (or the Point button), then click any element or
   select text to leave a comment; the **mic** dictates. (If they ran `--seeded`, three
   example pins are already there to click and read.)
2. Two flaws are hidden on the page — a bland say-nothing headline and a stale footer year —
   good targets to find and pin. Try one of each type (fix / change / improve) to show the model.
3. When they're ready, the cue is **PPF** — *Please Process Feedback* (or just "process the
   feedback"). The *please* is intentional: we're nice to our agents. ;-)

## Process the demo feedback

Follow the standard processing workflow from the `feedback` skill, with two overrides:

- Read comments from **`<DEMO_DIR>/.feedback/comments.json`** (not the project's).
- Edit **`<DEMO_DIR>/index.html`** (the throwaway copy) — never files in the user's repo.

Statuses still update live: PATCH `http://localhost:<port>/__feedback/api/comments/<id>`
with `{"status":"resolved"}` so the user watches the pins flip green. Process whatever
comments are present — the user's own, or (with `--seeded`) the worked examples: a `fix` is a
typo to patch, a `change` is near-verbatim, an `improve` wants your judgement (replace the
lorem-ipsum with real copy, offer options).

## After the loop

Point the user at the real thing: `/feedback-studio:feedback start` on their own site or
Markdown file. If they enjoyed the phone flow, mention `--tunnel`. The demo dir lives in
the system temp folder — safe to delete, nothing in the project to undo.
