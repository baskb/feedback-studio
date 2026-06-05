# (snippet) Paste into your project's AGENTS.md

## Feedback Studio

Visual review comments for this project live in `.feedback/comments.json` (with a
readable `.feedback/FEEDBACK.md`). They come from a local overlay where the human
clicks/taps an element (or selects markdown text) and leaves a typed or spoken note.

- **Launch a review session:** `node <path>/feedback-studio/plugins/feedback-studio/bin/feedback-studio.mjs --dir dist` (or `--proxy <devurl>`, or `--md <file|dir>`; add `--https` for phone voice). Open the printed URL.
- **Process comments:** use the `feedback-studio` MCP tools (`list_comments`, `get_comment`, `reply`, `set_status`) if configured, else read `.feedback/comments.json`. For each open comment, locate the element by its quoted anchor text (refuse rather than edit the wrong one), act per its `type`, present a diff, then set status `resolved`. For markdown comments, edit the `sourceFile`, not the rendered HTML.
- You can also **leave your own comments** for the human to review/approve: `add_comment` (MCP) with an anchor (a CSS selector or the exact visible text); they appear in the overlay as agent pins.
