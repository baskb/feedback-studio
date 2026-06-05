# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/baskb/feedback-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.0
