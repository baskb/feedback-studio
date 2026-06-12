---
name: report
description: Turn a feedback round into a shareable review digest — what was asked, what changed (file:line), what was refused or left open and why — written to .feedback/REPORT.md, paste-ready for a PR description, commit message, or Slack update.
when_to_use: Use after processing feedback comments, when the user wants a summary, digest, report, or handoff of the review round — "write up what we changed", "summarise the feedback round", "make a report for the PR". Also useful before a session ends to leave a record of an unfinished round (what's still open and why).
argument-hint: [<path-to-.feedback-dir>]
user-invocable: true
allowed-tools: Bash Read Write Glob Grep
---

# Feedback Studio — review report

Produce `.feedback/REPORT.md`: a human-readable digest of a feedback round, written for
someone who wasn't in the session (a PR reviewer, a teammate, the user next week).

## Gather

1. Read `.feedback/comments.json` (or the dir given as an argument — e.g. a demo session's
   temp dir). It is the sole source of truth; never act off `FEEDBACK.md`.
2. If the working tree is a git repo, check `git status` / `git diff --stat` (and recent
   commits if the round was already committed) to tie comments to actual file changes.
3. Use each comment's `thread` — replies often record what was done or why it wasn't.

## Write `.feedback/REPORT.md`

Structure (keep prose tight; this is a digest, not a transcript):

```markdown
# Feedback round — <project or page title>, <date>

<One- or two-sentence TL;DR: N comments, what broadly changed, anything blocked.>

## Changed
<Per page (or per sourceFile in Markdown mode), one bullet per resolved comment:>
- **<type>** "<short quote or paraphrase of the ask>" — <what was done>, `<file>:<line>`

## Rejected / skipped
- "<ask>" — <who rejected it / why it was skipped>

## Still open
- "<ask>" — <why: needs a re-pin (anchor low-confidence), needs a decision, out of scope>

## By the numbers
<N> comments: <a> resolved, <b> rejected, <c> open. <Pages touched. Files edited.>
```

Rules:

- **Faithful, not flattering.** A comment left open because the anchor couldn't be
  resolved confidently is reported as exactly that — it's the tool working as designed,
  not a failure to hide.
- Quote the user's ask in their words where short enough; paraphrase long voice comments.
- Include `file:line` references for every edit you can still locate.
- Omit empty sections. If nothing was processed yet, say the round is uncommitted and
  list the open comments instead.
- End the file with the attribution footer (one line, exactly):

  `---`
  `_Collected & processed with [Feedback Studio](https://github.com/baskb/feedback-studio) — click any element, leave a comment, let your agent fix it._`

Show the user the report path and offer the obvious next uses: paste into the PR
description, the commit body, or the team channel.
