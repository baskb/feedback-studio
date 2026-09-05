---
name: verify
description: Close the loop after processing feedback — re-open the page and prove each resolved comment's change actually landed on the right element. Verified comments get a verdict reply on their thread; failed ones are reopened with an explanation instead of staying silently "resolved".
when_to_use: Use after a feedback round was processed, when the user wants the changes checked, proven, or trusted — "verify the feedback was applied", "did the edits land?", "check your work on those comments". Especially worth running when many comments were processed at once or the edits were applied with autonomy=auto.
argument-hint: [<path-to-.feedback-dir>] [--again]
user-invocable: true
allowed-tools: Bash Read Glob Grep ToolSearch mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__tabs_create_mcp mcp__claude-in-chrome__tabs_close_mcp mcp__claude-in-chrome__navigate mcp__claude-in-chrome__javascript_tool mcp__claude-in-chrome__computer mcp__claude-in-chrome__get_page_text
---

# Feedback Studio — verify a processed round

The tool's whole promise is that the agent edited the **right** element. This skill
extends that promise past the edit: for each `resolved` comment, confirm the requested
change is actually present in the served page — and **reopen** any comment whose change
can't be confirmed, rather than leaving a false "resolved".

## The one rule that prevents false verdicts

Derive what to check from the **comment text + thread (the requested END state)** — not
from whether the old anchor still resolves. A correct fix often invalidates its own
anchor (the typo'd snippet no longer exists; a deleted element resolves to nothing).
An anchor that fails to re-resolve is only suspicious when the comment did NOT ask for
that element's text/existence to change.

A `question` is the exception to "check for a change": it was answered, not edited, so
nothing in the page or the file should differ. It is verified when its thread holds a
reply from the agent. Looking for changed wording there would reopen every answered
question.

## Steps

1. Read `.feedback/comments.json` (or the dir passed as argument). Collect the
   `resolved` comments — they are the verification targets. Note each one's `page`,
   `anchor` (snippet = the OLD state), `text`/`thread` (the asked-for NEW state), and
   `shot` if present (`.feedback/shots/<id>.png` — the pin-time BEFORE image; view it
   to ground what the element looked like when the reviewer pinned it) and `shotAfter`
   if present (`.feedback/shots/<id>-after.png` — the same element photographed after the
   reviewer's page reloaded with the change; view both side by side, the pair is the
   fastest visual verdict there is, and a `shotAfter` that looks identical to `shot` for
   a visual ask is a reason to look closer).
   **Skip what a previous run already settled:** a comment whose thread holds a reply
   whose text starts with `Verified:` was checked before and is left alone. Say how many
   you skipped. Run with `--again` (or when the user asks to check it all again) to
   re-check those too. A `Needs human eyes:` reply is not a verdict, so those come round
   again on every run.
2. **Question comments** (`type` is `question`): verified if the thread has a reply from
   the agent (`author: "agent"`) that answers it. That answer is the whole change the
   comment asked for. No reply means it was resolved without an answer: reopen it. Never
   judge a question by whether wording changed; it is not supposed to have changed.
3. **Markdown comments** (`sourceFile` set, and not a question): verify in the source — read the
   file, confirm the requested edit is present at the right spot (`grep -n` the new
   wording; confirm the old wording is gone). No browser needed.
4. **Web comments:** ensure the page is being served (start the server in the background
   as the `feedback` skill does — same `--dir`/`--proxy` source the round used — if it
   isn't already). Then, per page:
   - **With browser tools** (load the chrome MCP tools via ToolSearch in ONE call;
     skip this path entirely if they're unavailable): open the page, and for each
     comment check the new state — page text via `get_page_text`/`javascript_tool`
     for wording changes; a screenshot judged against the ask for visual changes
     (scroll the element into view first). `window.__kbfSelfTest()` is a useful secondary
     signal for elements whose anchors should have survived (a styling-only `improve`).
   - **Without browser tools:** fetch the served HTML (`curl`) and check the new
     wording is present and the old is gone. Purely visual asks ("make this stand
     out more") can't be machine-verified this way — mark them *needs human eyes*,
     don't guess a verdict.
5. **Record every verdict on the comment itself** so the file stays the audit trail.
   With the server running:
   - Confirmed: `POST /__feedback/api/comments/<id>/reply` with
     `{"author":"agent","authorName":"verifier","text":"Verified: <what was checked and found>"}`.
     The text must start with `Verified:`. That word is how the next run knows this one
     is done, so do not reword the opening.
   - Not confirmed (change absent, or the WRONG element was changed): reply with what
     you found instead, then `PATCH /__feedback/api/comments/<id>` with
     `{"status":"open"}` — the pin flips back live and the comment re-enters the queue.
   - Unverifiable by machine: reply `Needs human eyes: <why>` and leave it resolved.
   (No server running: make the same edits in the JSON file directly.)
6. Summarise for the user: ✅ verified / ❌ reopened (with what was found) / 👀 needs
   human eyes — grouped by page, with counts, plus how many were skipped as already
   verified. Be faithful: a reopened comment is the
   skill doing its job, not an embarrassment to soften.
