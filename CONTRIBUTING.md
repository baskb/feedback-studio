# Contributing to Feedback Studio

Thanks for taking the time to help. This is a small, dependency-light project; the
bar for contributions is "keep it simple and keep the invariants intact."

## Project shape

- **Runtime HTTP is zero-dependency.** Don't add npm dependencies to the server,
  the overlay, or the MCP server. The only deps allowed are the three helpers
  fetched lazily at runtime: the two npm packages `--https` / `--md` install
  (`selfsigned`, `marked`), plus the `cloudflared` binary that `--tunnel` downloads.
- There is **no build step** and no transpiler. The overlay ships as the
  hand-written `public/overlay.js`.
- The three processes coordinate through one file, `.feedback/comments.json`: the
  HTTP server (`bin/feedback-studio.mjs`), the browser overlay (`public/overlay.js`),
  and the MCP server (`bin/feedback-studio-mcp.mjs`). The schema and all reads/writes live in
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
  (the single source of truth). The test suite asserts the overlay's type set
  matches it, so update `public/overlay.js` too.
- Make sure `node --test` and both smoke scripts pass.

## Releasing (maintainer)

One command keeps GitHub and npm in sync. From a clean `main`:

```bash
npm run release:patch    # or release:minor / release:major
```

That bumps the version in all three manifests (`package.json`, the plugin manifest, the
marketplace entry), dates the `CHANGELOG.md` `[Unreleased]` section, commits, tags `vX.Y.Z`,
and pushes. Pushing the tag triggers `.github/workflows/release.yml`, which runs the tests,
publishes to npm, and creates the GitHub Release. The tag and the published version are
checked to match, so the two channels can't drift.

**One-time setup:** add an npm automation token as the repo secret `NPM_TOKEN` (npmjs.com ->
Access Tokens -> Generate -> Automation; then the GitHub repo -> Settings -> Secrets and
variables -> Actions -> New repository secret named `NPM_TOKEN`).

Plugin/marketplace users get changes as soon as they land on `main` (via `/plugin marketplace
update`); npm users get them on the next published version.

## Reporting bugs / ideas

Open an issue using the templates. For anything security-related, see
[SECURITY.md](SECURITY.md). Please don't file a public issue for vulnerabilities.
