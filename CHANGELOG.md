# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- The mutating API now also validates the `Host` header against an allowlist
  (loopback, the LAN IPs, the bound host, and the tunnel hostname), closing a
  DNS-rebinding path where a drive-by page could rebind its name to `127.0.0.1`
  and POST comments past the existing Origin/Host check.
- `--md` rendered output is stripped of active content (`<script>`/`<style>`,
  framing/redirecting tags, inline event handlers, and `javascript:` URLs) so a
  hostile Markdown file can't run script on the overlay's origin. It is a
  defense-in-depth strip, not a full sanitizer — still only open `.md` you trust.
- "Go to element" only navigates to `http(s)` targets, so a comment's stored
  `url` can't carry a `javascript:` payload.
- The `cloudflared` download can be pinned and verified: set
  `FBS_CLOUDFLARED_VERSION` for a deterministic release tag and
  `FBS_CLOUDFLARED_SHA256` to refuse any binary that doesn't match the hash.

### Changed
- The release workflow now runs the full test suite (unit + both smoke tests)
  before publishing, matching the per-PR CI gate, so a release can't ship a
  regression CI would have caught.

## [0.1.4] - 2026-06-06

### Added
- While processing a batch, the skill now mirrors the open comments onto the
  Claude Code task list — one task per comment, ticked off as each pin turns
  green — so the run's progress is visible in step with the overlay.

## [0.1.3] - 2026-06-06

### Documentation
- Rewrote all eight published docs for clarity (README, plugin README, SKILL,
  HARNESS, INTEROP, THIRD-PARTY, SECURITY, CONTRIBUTING), with factual
  corrections: the default branch is `master`, the marker test commands, and the
  `lib/` entry in the plugin README's tree.

## [0.1.2] - 2026-06-06

### Fixed
- A `comments.json` that parses as JSON but has the wrong shape (e.g. a hand-edit
  that lost the `comments` array) now throws `ECORRUPT` instead of being treated
  as empty — closing the path where the next write could clobber the file with `[]`.
- The overlay now checks every API response before using it: a server error
  (e.g. corrupt data file) surfaces as an error toast with the server's message
  instead of being mistaken for data and corrupting the in-browser list.
- "Stamp .md" now requires the quoted text to match exactly **one** source line;
  zero or several matches mean the comment is skipped and stays open for a re-pin
  (it could previously stamp the first of several matching lines). Rejected
  comments are no longer stamped (rejected means do-not-implement). The stamping
  logic moved to `lib/markers.mjs` and is covered by unit tests.
- Proxied HMR/live-reload websockets no longer drop after 10 seconds of idle;
  the timeout now only guards the connect phase.
- A typo'd `--md` path exits with a clear error instead of silently serving an
  index of the whole working directory.
- The "Copy /feedback" button now copies the full `/feedback-studio:feedback process`
  command (a bare `/feedback` doesn't resolve in Claude Code).
- Oversized request bodies now reliably get their `413` response (the socket was
  destroyed before the response could be written).
- Pins for elements scrolled out of view horizontally are now hidden, matching
  the vertical behaviour.
- MCP `add_comment` accepts optional `pageTitle` and `url`, so agent-authored
  comments group and navigate properly in the overlay panel.

### Documentation
- LAN phone-voice examples now include the required `--host 0.0.0.0`
  (README, skill, interop guides) — `--https` alone binds to localhost only.
- The share-a-link recipe states plainly that the tunnel URL is public and
  writable while the server runs, and that stopping the server revokes it.
- "18 languages" corrected to "18 locales"; CONTRIBUTING now lists all three
  lazily-fetched helpers (`selfsigned`, `marked`, `cloudflared`); the skill's
  agent-comment example uses a valid web type.

## [0.1.1] - 2026-06-05

### Added
- Release automation: a single `npm run release:patch` (or `release:minor` / `release:major`)
  bumps every manifest in sync, dates the changelog, tags, and pushes; the tag triggers a
  GitHub workflow that publishes to npm and cuts the GitHub Release, so the two channels stay
  in lockstep (the tag and the published version are checked to match).

### Changed
- Slimmed the `feedback` skill instructions by about half (~2,580 to ~1,270 tokens loaded
  per invocation) by deduplicating the tool path and tightening prose, without dropping the
  process steps or the refuse-to-guess invariant.

### Documentation
- Made it explicit that the MCP server ships with the plugin but is **not auto-activated**
  in Claude Code: the skill reads the comment files directly, so no always-on MCP server
  loads tool definitions into every turn (keeps token use low). Activate it per agent only
  where needed (README "Use with other agents", INTEROP.md).
- Added a **Recipes** section to the README (phone/voice review, Markdown feedback, dev-server
  review, processing comments, sharing a link, and AI-reviewer comments), and enriched the
  skill's `description`/`when_to_use` so Claude recognises those scenarios and activates on them.

## [0.1.0] - 2026-06-05

### Added
- npm packaging: `npx feedback-studio …` (no clone/install needed), a global install, and a
  `feedback-studio-mcp` bin for the MCP server. The package declares zero runtime dependencies.
- `--tunnel`: opens a public HTTPS URL via a Cloudflare quick tunnel (lazily fetches
  the `cloudflared` helper, no account needed). Phone review with a real certificate:
  no browser warning, the mic works, on any network. Nothing is exposed on the local network.
- Shared data store (`lib/store.mjs`) imported by both the HTTP and MCP servers:
  one comment factory, one set of type constants, one I/O path.
- Atomic, cross-process-locked writes to `comments.json` (temp file + `rename`,
  plus an advisory lockfile with stale-lock recovery), so the overlay and an
  agent can write concurrently without losing data or reading a half-written file.
- `--host <addr>` flag (defaults to `127.0.0.1`; use `0.0.0.0` for phone/LAN).
- Same-origin guard on all mutating API routes (blocks cross-site writes).
- The live-update stream (what flips pins green without a refresh) auto-reconnects with
  backoff and resyncs after a dropped connection.
- When a proxied single-page app rebuilds the page, the overlay re-resolves its
  pins and re-attaches itself.
- Test suite (`node --test`) plus live HTTP and MCP smoke scripts; CI workflow.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog, and issue/PR templates.
- Live-update streams: a stalled browser is given a grace window then dropped, so it can't make updates pile up in memory.
- Comment pins are slightly translucent (snap to full opacity on hover/keyboard focus/active), so the text underneath a pin stays readable.

### Changed
- **Anchor confidence vote** now groups the CSS selector and XPath into one
  "structural" family (they rot together) and requires an independent family to
  agree before returning `high`. Text corroboration uses a starts-with /
  containment check so an over-broad ancestor can't pass as a clean match. This
  closes the case where a co-rotted selector+xpath could certify a wrong element
  as high-confidence. See `HARNESS.md`.
- The MCP server and HTTP server now build identical comment objects; the default
  type is mode-aware (`change` for web, `comment` for Markdown) instead of
  differing between the two.
- Markdown comment types are validated against the page kind (a Markdown verb is
  no longer stored on a web page, and vice-versa).

### Fixed
- Path-traversal guard now uses a real containment check (`path.relative`)
  instead of a string prefix.
- Proxy mode is pinned to the configured upstream origin (no SSRF via the request
  line) and supports HTTPS upstreams and non-default ports.
- Request bodies are size-limited and the connection is destroyed on overflow;
  malformed JSON returns `400`, oversize returns `413`.
- Error responses no longer leak filesystem paths or internal messages.
- The overlay degrades gracefully when `localStorage`/`sessionStorage` throw
  (private mode / sandboxed iframes).
- Voice dictation no longer discards text typed while dictating, restarts after a
  silence, and surfaces permission/no-speech/network errors.
- Reply-box focus and caret are preserved across live re-renders.
- Mobile voice-language picker rebuilt as a native `<select>`. The custom dropdown
  opened upward into the composer's clipped area, so the top languages were
  unreachable and its inner scroll chained to the page; the native picker scrolls
  correctly and never clips or scrolls the page behind it. Panel list and textarea
  also get `overscroll-behavior: contain`.
- Graceful shutdown on `SIGINT`/`SIGTERM`; the server no longer exits on
  transient connection-level errors.
- Overlay injection targets the last `</body>`; corrupt `comments.json` is never
  silently treated as empty (which could overwrite good data).

### Security
- MCP `initialize` negotiates the protocol version against a supported list
  instead of echoing whatever the client sent.
- Lazy `npm install` of `selfsigned`/`marked` now runs with `--ignore-scripts`.

[Unreleased]: https://github.com/baskb/feedback-studio/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.4
[0.1.3]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.3
[0.1.2]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.2
[0.1.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.1
[0.1.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.0
