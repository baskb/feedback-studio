# Contributing to Feedback Studio

Thanks for taking the time to help. This is a small, dependency-light project; the
bar for contributions is "keep it simple and keep the invariants intact."

## Project shape

- **Runtime HTTP is zero-dependency.** Don't add npm dependencies to the server,
  the overlay, or the MCP server. The only deps allowed are the two helpers that
  `--https` / `--md` lazily install at runtime (`selfsigned`, `marked`).
- There is **no build step** and no transpiler. The overlay ships as the
  hand-written `public/overlay.js`.
- The three processes — `bin/feedback-studio.mjs` (HTTP), `public/overlay.js`
  (browser), `bin/feedback-studio-mcp.mjs` (MCP) — coordinate through one file,
  `.feedback/comments.json`. The schema and all reads/writes live in
  `lib/store.mjs`; both servers import it so they produce identical objects.

## The load-bearing invariant

The overlay must **never confidently resolve a comment to the wrong element**. The
resolver (`resolveWithConfidence` in `public/overlay.js`) groups strategies into
independent families and only returns `high` when families that can't rot together
agree. If you touch anchoring, resolution, or the comment schema, preserve this
property and re-run the self-test (below). See `HARNESS.md`.

## Requirements

- Node 18 or newer. No global installs needed.

## Running it locally

```bash
node plugins/feedback-studio/bin/feedback-studio.mjs --dir <some-static-site>
node plugins/feedback-studio/bin/feedback-studio.mjs --proxy http://localhost:5173
node plugins/feedback-studio/bin/feedback-studio.mjs --md README.md
```

## Tests

```bash
# unit tests for the shared store (atomic writes, locking, schema, type parity)
node --test plugins/feedback-studio/test/store.test.mjs

# live HTTP smoke (injection, CSRF guard, path-traversal guard, persistence)
node plugins/feedback-studio/test/smoke.mjs

# live MCP stdio smoke (handshake, validation, tool calls)
node plugins/feedback-studio/test/mcp-smoke.mjs

# syntax check everything
node --check plugins/feedback-studio/lib/store.mjs
node --check plugins/feedback-studio/bin/feedback-studio.mjs
node --check plugins/feedback-studio/bin/feedback-studio-mcp.mjs
node --check plugins/feedback-studio/public/overlay.js
```

The browser-side anchor self-test runs against a live page in the dev console:

```js
window.__kbfSelfTest()      // re-resolve every comment on the page → { total, resolved, rate, detail }
window.__kbfBuildAnchor(el) // the anchor a given element would get
```

CI runs the unit + smoke tests and the syntax/manifest checks on every push and PR.

## Pull requests

- Keep changes focused; one concern per PR.
- Match the surrounding style (no formatter is enforced; just don't reformat
  unrelated lines).
- If you change the comment schema or the `type` set, update **`lib/store.mjs`**
  (the single source of truth) — the test suite asserts the overlay's type set
  matches it, so update `public/overlay.js` too.
- Make sure `node --test` and both smoke scripts pass.

## Reporting bugs / ideas

Open an issue using the templates. For anything security-related, see
[SECURITY.md](SECURITY.md) — please don't file a public issue for vulnerabilities.
