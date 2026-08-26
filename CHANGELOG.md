# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.6] - 2026-08-26

### Fixed
- **Resolved pins stay green.** Since 0.9.4 a pin whose element re-resolved with weak confidence turned amber — including resolved comments, whose text has usually been changed by the very fix that resolved them. In `--md` review that made most processed comments look like warnings. Pins now follow the same rule the List cards already did: only comments still awaiting action warn.
- **Clicking a comment in the List scrolls to it reliably.** The List used to scroll its own card *after* starting the page's smooth scroll, which could cancel that animation part-way; the order is now reversed. And when there is nothing to scroll to (a resolved "delete" comment's text is gone by design), the click now says so instead of silently doing nothing.
- **Pins on table cells sit inside the cell.** A pin is centred on its element's top-left corner, which on a narrow box — a table cell, a short list item — left half of it hanging over the column to the left, so it looked pinned to the wrong column. Pins on `td`/`th` and on any box narrower than 160px are now tucked just inside the box. Wide elements are unchanged.
- **Hooks reach the server on Node 18.** `session.json` pointed at `localhost`, which Node 18 resolves to IPv6 first while the server listens on IPv4 only; it now says `127.0.0.1`.

## [0.9.5] - 2026-08-26

### Added
- **The page now shows what the agent is actually doing.** Watch mode used to rely on the agent sending a heartbeat every 60 seconds; while it was busy editing files it sent nothing, so the "agent online" light went dark exactly when the most work was happening — and it never said *which* comment was being worked on. Now the agent claims a comment before working on it: that pin pulses amber, its card reads "Claude is on this · 1m 20s · edited src/Header.jsx", comments queued behind it read "next up", the panel chip says "Claude · working on #3", and the browser tab title reads `⚙ #3` (with `✓` when something finished while you were in another tab). A new **Activity** drawer in the panel keeps the history (claimed, edited file, replied, resolved, with how long each took) and every line jumps to its pin. Presence no longer decays on a timer: every call the agent makes counts as a heartbeat, resolving or answering the claimed comment releases it by itself, and silence is shown as "quiet for 3m" rather than guessed as offline.
- **Plugin hooks report file edits to the page.** The Claude Code plugin now registers three small hooks (after a file edit, on a new message, at the end of a turn) that find the running server through the new `.feedback/session.json` and post a one-line activity entry. Without a session file they exit immediately. See *What the plugin's hooks do* in the README.
- **`set_presence` MCP tool + `presence.json`.** Agents without HTTP (Codex, Cursor, …) can show up on the page too: the tool writes `.feedback/presence.json`, which the server's file-watch merges live.
- New API: `POST /__feedback/api/activity`; `POST /agent-status` accepts `commentId`, `note`, `queue`; the SSE stream sends `activity` and `activity-log` events.

## [0.9.4] - 2026-08-19

### Added
- **Weak pins are now visible — and fixable — before the agent trips over them.** The tool's core rule is that the agent refuses to edit an element it can't confidently re-find; until now you only learned a pin had gone weak when the agent refused. A pin whose element re-resolves with weak confidence now shows amber with a dashed ring, its List card gets a "pin unsure" tag (or "pin lost" when the element can't be found at all), and the card offers **Re-pin on the page**: click it, click the right element, done — the anchor is rebuilt exactly like a fresh comment's. Resolved and rejected comments never warn (their element changing is usually the fix having landed). The API now accepts an anchor update on PATCH to carry this.

## [0.9.3] - 2026-08-19

### Added
- **A warning when comments would land away from the project.** Serving a site or Markdown file that lives outside the folder you ran the command from (`--dir ../other-project/dist`) keeps the `.feedback/` data in the folder you ran from — which is easy to miss: the agent then processes an empty comments file while the real comments sit elsewhere. The startup banner now says so explicitly and shows the fix (run from the project's root, or pass `--data-dir <that-project>/.feedback`). The `--data-dir` flag itself already existed; the trap was that nothing told you when you needed it.

## [0.9.2] - 2026-08-18

### Changed
- **Links in a reviewed Markdown document now open in a new tab.** Clicking a link in a `--md` document used to navigate the review tab itself, losing your scroll position, folded chapters, and any half-written comment. External links and links to other documents now open in a new tab (with `rel="noopener noreferrer"`); in-page `#anchor` links still jump within the document, and the file-index page keeps its normal same-tab navigation.

## [0.9.1] - 2026-08-18

### Changed
- **The List panel now shows the newest activity on top.** Comments used to appear in the order they were created, so a new comment — or an agent reply on an old one — landed at the bottom of a long list and took a lot of scrolling to find. The list is now sorted by last activity (created, edited, replied to, or status changed), newest first, and a fresh reply floats its comment back to the top. Pages other than the current one are ordered the same way, by their newest activity. Pin numbers on the page are untouched: they keep the stable creation order, so sorting the list never renumbers a pin.

## [0.9.0] - 2026-08-12

### Fixed
- **A spoken comment can no longer auto-anchor on a cursor graze.** In "Talk me through it", any hover overlap — even a millisecond of the cursor passing through an element — counted as a "dwell", and a dwell plus a common pointing word ("this", "that", "it") on a single candidate earned high confidence with no score check, silently pinning the comment to an element the reviewer never meant. A hover now has to last at least 250ms to count as pointing; anything shorter asks for a pin instead of guessing. Deliberate brief points (speak-then-point) still anchor as before. (Found by ultra review.)
- **Share links can no longer post as the agent.** The HTTP API accepted a client-supplied `author: "agent"` on comments and replies, so anyone with a comment-role share link could post notes that rendered with the agent's bot pin and blue styling and exported as "by agent" — spoofed agent authority on a shared review. The agent author is now reserved for the host side (the keyless local session and admin links); a share reviewer claiming it is recorded as a normal user comment. The real agent workflow is unchanged. (Found by ultra review.)
- **Onboarding text no longer says "Press C".** The demo banner, the README, the demo skill, and the overlay's own empty-state hint all still referenced the old C shortcut and "Comment button" — the shortcut is P and the button is labeled Point. All six spots now match the product. (Found by ultra review.)

## [0.8.0] - 2026-08-12

### Changed
- **Every new comment starts at the default type again** (web: `fix`, md: `comment`) instead of remembering the type you picked last time. A leftover "delete" or "improve" from a previous note silently changing what the agent is allowed to do to the next one was an error waiting to happen.

### Added
- **Collapsible chapters in `--md` review.** Click any H1–H3 heading to fold everything below it up to the next heading of the same or higher level; click again to expand. A chevron next to the heading shows the state, a folded heading gets a trailing "…", and fold state survives a reload of that tab (per file). Folding never touches the document structure — it only hides the existing elements — so every comment anchor keeps pointing at the same nodes, and pins on folded content simply hide until the chapter reopens. A fold can also never hide a comment from you: jumping to a comment (from the List, the walkthrough, or editing from a card) automatically reopens any folded chapter containing its target.

## [0.7.6] - 2026-08-11

### Fixed
- **The Point highlight no longer stays behind on screen when you scroll.** The hover outline (and, in `--md` review, the sentence fill) was drawn at a fixed screen position, and a scroll fires no mouse event — so after scrolling, the highlight sat over whatever content had moved underneath it, and a click would comment on something other than what looked selected. The overlay now re-aims the highlight from the cursor's last known position on every scroll, so it always shows exactly what a click would pick. On touch screens (where there is no resting cursor) the stale highlight is cleared instead.

## [0.7.5] - 2026-08-05

### Added
- **Sentence-level aiming in `--md` review.** In Point mode, hovering a paragraph now softly highlights the sentence under your cursor (label shows `p · sentence`); clicking anchors the comment to exactly that sentence instead of the whole block. Works in paragraphs, list items, quotes, and table cells — including sentences that wrap across lines or contain `inline code`. Whole-block commenting is still there: aim at the block's edge (off the text), or use a block that is a single sentence anyway; code blocks never get sentence targeting. Sentence comments are stored as the same text-range anchors a manual selection produces, so agent processing and "Stamp .md" work unchanged. New console helper: `window.__kbfSentenceAt(x, y)`.

## [0.7.4] - 2026-07-18

### Fixed
- **Voice input works again on proxied sites that send a `Permissions-Policy` header.** Many
  hardened sites (and PHP/nginx hardening templates) send `Permissions-Policy: microphone=()`,
  which forbids the browser from even *showing* the mic permission prompt — the overlay's mic
  button then failed with "Microphone blocked" and no popup, regardless of browser settings.
  Proxy mode now strips `Permissions-Policy` (and legacy `Feature-Policy`) from injected HTML,
  exactly as it already stripped `Content-Security-Policy`, so voice comments work on any
  proxied site.

## [0.7.3] - 2026-07-14

### Fixed
- **`--md` review no longer shows comments from a different file.** When several Markdown files
  were reviewed from the same project, they share one `.feedback/comments.json` — and in
  single-file `--md` mode every file is served at the same path (`/`), so the overlay (which
  scoped pins and the List by page only) showed every file's comments regardless of which file
  was on screen. The overlay now scopes its whole view to the served source file, so a
  single-file `--md` session shows only that file's comments; the others stay on disk, untouched.
  (The comment API stays unfiltered — a processing agent still sees every file's comments.)

## [0.7.2] - 2026-07-09

### Fixed
- **Mobile dictation no longer repeats your words.** The composer mic appended every final
  result, but mobile Web Speech re-emits a growing cumulative final ("so" → "so explain" →
  "so explain me"…), producing long chains of repeated words. The composer now uses the same
  collapse rule the narration recognizer got in 0.7.0: a final arriving shortly after the
  previous one that extends it replaces it instead of appending (case-insensitive — phones
  re-capitalise the re-emit). Manual edits typed mid-dictation are still preserved.
- **The composer stays above the phone keyboard.** It was clamped against the layout viewport
  (`window.innerHeight`); opening the on-screen keyboard shrinks only the *visual* viewport, so
  the Save button could sit unreachable behind the keyboard (fixed position — scrolling can't
  help). Positioning now clamps against `window.visualViewport`, and keyboard open/close
  re-clamps the open composer live.
- **Wide tables in `--md` mode scroll inside their own box** instead of making the whole page
  scroll sideways — page-level horizontal overflow on a phone stranded the fixed
  Point/Talk/List buttons off to the side.
- **No more flash-and-slide on load over a slow link.** Over a tunnel the overlay stylesheet
  lands after first paint: the raw panel markup flashed unstyled, then the panel's closed-state
  transform visibly slid off-screen. The overlay now boots invisible with transitions frozen and
  reveals itself one frame after the stylesheet applies (2 s safety net if it never loads).
- **Composer type pills no longer overflow on narrow screens.** The five Markdown types can't
  shrink below their labels, so "Question" jammed against the composer border on phones — the
  row now wraps.
- **`--md` header shows a readable source path.** Reviewing a file outside the working
  directory showed a `../../../…` chain of machine internals; the header now shows the path
  relative to the `--md` root (the stored `sourceFile` on comments is unchanged — still exact).
- **Large image replacements no longer fail.** The global 1 MB request-body cap made the media
  route's 3 MB image limit unreachable — any bigger upload died with "request body too large",
  and the overlay exempted PNGs from its size budget entirely. The media route now accepts a
  5 MB body (3 MB decoded image, as always intended); the overlay re-encodes an oversized PNG
  to WebP (keeps transparency) and fails fast with a clear message above 3 MB.
- **Clearing an image replacement deletes its staged file** — previously the file under
  `.feedback/media/` was orphaned until the comment itself was deleted.
- **Undoable delete no longer flickers.** During the 5-second Undo window, a live update from
  the server could briefly resurrect the just-deleted comment's card and pin.
- **Cross-process lock survives laptop sleep.** If the OS slept mid-write long enough for a
  waiter to legitimately steal the "stale" lock, the resumed process could delete the new
  holder's lock on release. The lockfile now carries a per-acquisition token and release only
  removes its own.
- **Atomic writes retry transient Windows errors.** `rename()` over a file briefly held open by
  antivirus/OneDrive/a watcher fails with EPERM even though nothing is wrong — the store now
  retries a few times before giving up.

## [0.7.1] - 2026-07-03

### Changed
- **README refresh** — a prominent "newest" section showcasing the 0.7.0 headline features
  (Talk me through it / Ask the page / it narrates back / swap an image / several sites in one
  repo), plus matching Highlights. Docs only.

## [0.7.0] - 2026-07-03

### Added
- **Multiple sites in one repo.** New `--label <name>` and `--data-dir <path>` flags let you run
  a separate feedback session per site — each on its own port, with its own isolated `.feedback/`
  beside the site (comments + screenshots + replacement images + a `meta.json` naming it). The
  overlay shows the site **label** (panel header + an always-visible chip on the FAB cluster) so
  several open tabs are told apart. The processing agent scans the repo for `.feedback/` dirs,
  reads each `meta.json` label, and handles each site against its own data — a comment/image
  belongs to the site whose dir it lives in, and image paths resolve relative to that dir. The
  MCP `list_comments` output and startup line now name the site too. (Also fixes a latent bug:
  `FEEDBACK.md` / `HOW-TO-PROCESS.md` and the startup banner previously hard-coded `.feedback/`
  in their paths, which was wrong for any non-default data dir.)

- **"Ask the page"** — the composer now offers an **Ask** type on web elements (not just
  Markdown): pin a question on anything ("what does this do?", "why is this here?", "where's
  this defined?") and the agent **answers in a thread reply** — with a `file:line` source
  pointer when you ask where/why — instead of changing code. In watch mode the answer comes
  back within seconds. (`question` is now a universal comment type.)
- **"Walk me through the changes" (agent narrates back)** — after the agent processes your
  feedback and leaves a note on each comment, a button in the panel plays a **guided tour**:
  it scrolls to each changed element, highlights it, and **reads the agent's explanation
  aloud** (native browser speech synthesis — **no new dependency**). The review becomes a
  two-way conversation. Play/pause, previous/next, Escape to exit.
- **"Talk me through it" (Narrate mode)** — hit the 🎙 Narrate button and walk the page by
  voice while moving the cursor ("this hero's too quiet… make this button orange…"). Feedback
  Studio timestamps the speech and the pointer together and, on Stop, **pins each spoken
  comment to the element you were pointing at** — the "Put-That-There" grounding model (deictic
  words like "this"/"that"/"here" are resolved by *where you point*). Confident ones save right
  away just like a manual comment (PPF picks them up, no extra step, marked `via:"narration"`);
  only the ones it can't confidently place pop up in a small tray asking you to point at the
  element (or save without a pin). The correlation runs on-device in a pure, unit-tested
  module (native Web Speech + pointer events, **no new dependency**); an utterance it can't
  confidently ground asks for a pin rather than guessing. `schemaVersion` → 6 (new optional
  `via` field). *(Phase 2 — desktop screen/audio recording, replay, and agent multimodal
  refine — is planned separately.)*

## [0.6.0] - 2026-07-03

### Added
- **Replace an image** — pick an `<img>` (or an element with a CSS `background-image`) and the
  composer offers **Replace image**: choose a local file, and it's decoded, **auto-downscaled**
  (longest side ≤ 2048px, ~1.5 MB budget, quality-preserving stepped resample), and re-encoded
  entirely in-browser (native canvas — **no new dependency**). Frame it live on the page with
  object-fit (Cover/Contain/Fill), a 3×3 alignment grid, and width/height, or open the **crop**
  modal to trim the source with a draggable box. On save the processed image is staged to
  `.feedback/media/<id>` and the comment records `imageReplace` metadata; your agent copies the
  file into the project's image folder and repoints the element (`src` or CSS `background`),
  applying the framing in the project's idiom. Panel cards show the new-image thumbnail; the
  on-page preview reverts on close like every other. Uploads are raster-only (PNG/JPEG/WebP —
  **SVG rejected**), magic-byte validated, size-capped, role-gated, and GC'd with the comment.
- Comment `schemaVersion` bumped to 5 (new optional `imageReplace` field; backward-compatible).

## [0.5.1] - 2026-07-03

### Security
- **Share keys no longer leak to a proxied dev server.** Under `--proxy --share`, the
  `kbf-key` capability cookie was scoped to `/` and forwarded to the upstream on every
  request (handing it the host tab's admin key). It is now scoped to `Path=/__feedback` and
  stripped from the `Cookie` header forwarded to the upstream in both the HTTP and
  websocket-upgrade paths (other cookies are preserved).
- **DNS-rebinding guard now covers the served site, not just `/__feedback/*`.** A forged
  `Host` is refused on page / static / `--md` / `--proxy` routes and the websocket upgrade,
  so a rebound origin can't read local page content or pivot through the proxy. Legitimate
  loopback / LAN / tunnel access is unaffected (all already in the host allowlist).
- **Markdown rendering hardened against encoded scheme bypasses.** `sanitizeRenderedHtml`
  now entity-decodes attribute values (shared `schemeIsEvil` helper) before the
  `javascript:`/`vbscript:`/`data:text/html` check, so `&#106;avascript:` and control-split
  schemes can't survive in a rendered `.md`.
- **Variant previews can't beacon out.** Agent-proposed variants now have external
  eager-loading resources stripped (`img src`, `srcset`, `poster`, SVG `image href`) at both
  the write-time and the authoritative parser scrub — relative and `data:image` are kept — so
  previewing a variant (incl. over a share link) fires no third-party request.

### Changed
- **Anchor confidence is now `high`-only for load-bearing actions.** Recording tweak/text
  edits, capturing a screenshot, and previewing a variant require a high-confidence anchor
  re-resolve; a `medium` (weak/buried-text) match asks for a re-pin instead of acting on a
  possibly-wrong element. Fresh direct clicks are unaffected.
- The file-store lock now **refreshes its mtime on a heartbeat while held**, so a slow write
  (large file / network FS stall / long export) can't have its live lock stolen.

### Fixed
- The comment `PATCH` endpoint coerces `type` to the comment's own web/Markdown mode
  (a web comment can no longer be given a Markdown verb, or vice-versa).
- A corrupt `comments.json` now pushes a `store-error` SSE event so open overlays surface it
  instead of silently showing stale data.
- A malformed `kbf-key` cookie no longer 500s a feedback request (treated as absent).
- Pins and the variant switcher no longer flash briefly at the top-left corner before they
  are positioned (hidden until they have coordinates).

## [0.5.0] - 2026-07-03

### Added
- **Variant picker** — for a vague `improve` ("make this pop"), the agent can reply with 2–4
  design alternatives of the pinned element (`variants: [{label, html, note}]`). The user
  flips **Original / A / B / C live on the page** via a floating switcher and taps **Use
  this**; the choice is recorded as a `pick: {of, index, label}` reply (auto-approved for the
  host) and the agent implements only the chosen one, translating its inline styles into the
  project's idiom. Panel cards show a "Try N options on the page" button and a "Picked: …"
  badge; the MCP `reply` tool and the process docs gained the propose/pick workflow.
- **Automatic page refresh after processing** — the agent calls `POST /__feedback/api/reload`
  once a batch is applied and every open overlay reloads itself to show the edited page under
  its now-green pins. It reloads only when safe: if a composer, variant preview, or text field
  is open it defers to a one-tap "Reload" nudge instead of interrupting. Panel/mode/filter
  state survives the reload. Admin-only under `--share strict`.

### Security
- Variant HTML is injected into the live host page, so it is sanitized at **two independent
  layers**: a write-time pass in `store.mjs` (now entity-decodes attribute values before the
  scheme check, closing encoded-`javascript:` bypasses, and strips external `url()` beacons
  from inline styles), and an **authoritative parser-based scrub** in the overlay immediately
  before injection (an inert `<template>` where the browser has already decoded entities, then
  a real tree-walk removing executable tags, event handlers, script-ish URLs, and CSS beacons).
  Proposing variants requires the admin/host role; picking one stays open to the comment role.

## [0.4.0] - 2026-07-02

### Added
- **Tweak Mode** — a collapsible "Tweak style" section in the composer (web pages,
  element anchors): live knobs for text size, weight, alignment, text/background
  color, line height, padding, margin, corners, gap, and opacity. Changes preview
  live on the element and are saved as exact `edits[]` deltas
  (`padding: 16px → 24px`) for the agent to translate into the project's styling
  idiom. Knobs are relevance-gated per element (no text knobs on an image; `gap`
  only on flex/grid; setting a background reveals Corners), previews always revert
  on close, and the whole section animates Apple-sheet style.
- **Edit text on page** — double-click any text element (or use the composer row)
  and retype it in place; the exact `{before, after}` diff is saved as `textEdit`
  and applied verbatim by the agent — in `--md` mode, straight into the source
  `.md`. Enter commits, Esc cancels, click-away commits too; the on-page edit
  reverts when the composer closes. The panel card shows a strikethrough → new
  diff.
- **Watch mode** — say "watch the feedback" and the agent stays live during the
  review: an agent-presence chip (plus a green dot on the list button) shows
  online/working states over SSE, questions get answered on their threads within
  seconds, `auto` comments are applied as they arrive, `review` ones queue for
  approval. Powered by a new `agent-status` endpoint with heartbeat aging.
- **Pin-time element screenshots** — saving a comment captures a PNG of the
  element as the reviewer saw it (after previews revert). Agents view it as
  ground truth when an anchor is uncertain; verify/report treat it as the BEFORE
  image; expanded panel cards show a thumbnail. Lazy-vendored `html-to-image`
  (installs on first capture only), strict upload validation, screenshots are
  GC'd with their comment, `--no-shots` disables.
- **Share links with roles** — `--share` mints view / comment / admin capability
  links (great with `--tunnel`): view is read-only, comment can pin + reply
  (signed via a "Your name" field), admin manages everything. A link IS its
  role; keys rotate every start; the whole feedback surface (reads and SSE
  included) requires a key while the site pages stay public. Your own machine
  keeps keyless access unless `--share strict`.
- The server now **warns at startup when `.feedback/` is committable** (git
  check-ignore), since screenshots raise the stakes of an accidental commit.

### Changed
- Comment `schemaVersion` bumped to 4: new optional `edits[]`, `textEdit`, and
  `shot` fields (all backward-compatible; older comments simply lack them).
- MCP `list_comments` summaries now carry `edits`, `textEdit`, and `shot`, so
  agents see the load-bearing change data without extra `get_comment` calls.
- `FEEDBACK.md` renders `tweak:`, `text edit:`, and `shot:` lines; the processing
  rules (SKILL.md / HOW-TO-PROCESS.md) explain how to apply each near-verbatim,
  with the refuse-and-re-pin rule extended to all of them.
- Every capture surface (tweak values, text edits, screenshots) goes through one
  shared confidence-gated element resolver — data is never read off a
  low-confidence guessed element.

### Fixed
- `[hidden]` now always wins inside the overlay (a `display:` on a class could
  override it and leak hidden UI — the tweak body, count badge, and undo button
  all did before this).
- The collapsed Tweak section can no longer show a padding/scrollbar sliver on
  mobile; number inputs no longer fight mid-keystroke clamping; the composer can
  no longer grow its Save button off short viewports (internal scrolling).
- Text-edit commits are never silently lost on click-away, and a live host page
  mutating the element while the composer is open can no longer be misattributed
  as the reviewer's edit (the before-snapshot is taken at edit start).
- Editing a comment after its tweak already landed in source preserves the
  stored `edits[]` history (per-prop merge instead of wholesale replace).
- While editing text in place, the pointer shows the text (I-beam) cursor
  instead of the comment-mode crosshair.

## [0.3.4] - 2026-07-02

### Fixed
- **Ctrl/Cmd+C no longer toggles comment mode** — the `C` shortcut now ignores every modifier,
  so copying page text can't flip the mode (Alt included, for AltGr layouts).
- **A custom `404.html` is now served with a real HTTP 404** (it was sent as 200).
- **"Stamp .md" works when `--md` points outside the project cwd** — the out-of-cwd Markdown
  root is now an allowed stamping target. Missing or out-of-root source files are **counted in
  the skipped total** instead of being silently dropped, and the panel toast says so.
- Markdown index links are percent-encoded, so filenames containing `#`, spaces, or `%` open.
- Pins no longer fragment between `/page` and `/page/` — the overlay treats both URL forms
  (which serve the same content) as one page.
- The demo skill's worked-example descriptions and the README demo recipe now match the actual
  seeded comments (change: button label · improve: lorem-ipsum paragraph · fix: typo), and the
  README no longer claims the overlay follows the OS theme (light is the default since 0.3.3).
- The demo seed comments were realigned to the published demo video (order and improve target).

### Security
- The **Host allowlist now covers reads too** (API GETs and the SSE stream, not only writes),
  closing the read side of the DNS-rebinding surface. The machine's hostname and its `.local`
  mDNS form are recognised, so `http://<hostname>.local:4444` keeps working on the LAN.
- Rendered-Markdown sanitizing also strips slash-separated inline handlers (`<img/onerror=…>`),
  and the md page shell escapes `<` in its inline source-path JSON so no path can form a
  premature `</script>`.
- "Go to element" only ever navigates to a **same-origin** http(s) URL.

### Changed
- MCP `list_comments` summaries now include each comment's `autonomy`, so agents can honour
  `review`/`auto` without fetching every comment.
- The processing workflow gained an explicit step: **refresh the page** after applying a batch,
  so the user sees the updated content under the now-green pins.
- The "no build directory found" error now suggests the instant demo (`feedback-studio --demo`).
- README: published the measured anchor resolve-rate (with the HARNESS.md method link) and an
  honest note that voice dictation uses the browser's cloud speech engine.
- Internal robustness: the comments file is created under the cross-process lock at startup; a
  stale write-lock is stolen by rename (a racing waiter can't delete a fresh lock); failed
  atomic writes clean up their temp file; a tunnel that never yields a URL is killed on timeout.

## [0.3.3] - 2026-06-14

### Changed
- The overlay now **defaults to light** (it no longer follows the OS theme by default), and the
  panel's theme button is a simple **light ↔ dark toggle** (the three-way auto/light/dark cycle
  was removed).

### Fixed
- Theme toggle could appear **stuck on dark**: on a machine whose OS prefers dark, the old
  `auto` state rendered dark, so toggling off `dark` flipped the icon but not the colours (two of
  the three states looked identical). With `auto` gone, every toggle flips the actual palette.

## [0.3.2] - 2026-06-13

### Added
- **`--no-seed`** flag for `feedback-studio --demo`: serve the sample page with no comments, so
  you add your own (great for a clean walkthrough or recording).

### Changed
- **`/feedback-studio:demo` now starts empty by default** — you add the comments yourself. Ask
  for `--seeded` (or "with examples") to load the three worked example comments (one fix /
  change / improve). The standalone `feedback-studio --demo` CLI still seeds by default; use
  `--no-seed` there for an empty page.

### Fixed
- Starting the demo (or a review session) no longer flashes/refreshes the page from a double
  browser-open: the `demo` and `feedback` skills now launch the server with `--no-open` and open
  the URL once themselves.

## [0.3.1] - 2026-06-13

### Fixed
- The Comment button's drag wobble + corner snap now play even when the OS "reduce motion"
  setting is on (a global reduced-motion reset was calming them). Scoped exception for that
  one deliberate affordance; every other overlay animation still respects reduced-motion.
- README "Recipes" now leads with **PPF** (the post-0.3.0 docs missed this one spot, which
  still framed processing as `/feedback-studio:feedback process`).

## [0.3.0] - 2026-06-13

### Added
- **Move the Comment button.** Drag the floating button to any corner; it snaps to the
  nearest one and remembers it (per browser). Works on desktop and mobile — handy when it
  overlaps your site's own bottom-right widgets.
- **Drag the comment composer** (desktop) by its header, so it no longer covers the content
  you're commenting on.
- **Dark mode.** The overlay follows your OS theme automatically; a toggle in the feedback
  panel header cycles auto → light → dark and is remembered.
- **`.feedback/HOW-TO-PROCESS.md`** — a self-contained guide for processing the comments,
  written next to the data by both the review server and the MCP server (MCP-first, so an
  agent without the plugin still has the workflow). New **`--seed-agents`** flag appends a
  short version to your `CLAUDE.md` and `AGENTS.md` (idempotent) so the agent knows the flow
  every session.

### Changed
- **"PPF" — *Please Process Feedback*** is now the signature phrase for handing a round
  to your agent, woven through the overlay panel hint, the skills, the generated
  `HOW-TO-PROCESS.md` / `--seed-agents` snippet, the MCP server's `initialize` instructions,
  and the npm / Claude-marketplace descriptions. The panel's old "Copy /feedback" button is
  gone (it pasted a slash command that didn't resolve for non-plugin users); the footer now
  reads *Tell your agent: "Please process feedback" (PPF)*. And yes — the *please* is on
  purpose; we're courteous to our coding agents. ;-)

### Fixed
- Docs: the server's header flag list now includes `--demo`, `--tunnel` and
  `--no-open`; the verify skill no longer references a non-existent `scroll_to`
  tool; the demo skill no longer claims the OS cleans up the temp copy (it
  doesn't on Windows — the dir is simply safe to delete).

## [0.2.0] - 2026-06-12

### Added
- **`--demo` / `/feedback-studio:demo`** — an instant playground: serves a bundled
  sample landing page from a throwaway temp copy, pre-seeded with one comment per
  web type (`fix` / `change` / `improve`) and a couple of flaws left to find.
  Processing the demo edits the copy, never your project. Works standalone too:
  `npx feedback-studio --demo`.
- **`/feedback-studio:verify`** — closes the loop after processing: re-checks each
  resolved comment against the served page (or the Markdown source), records a
  verdict reply on the comment's thread, and **reopens** any comment whose change
  can't be confirmed instead of leaving a false "resolved".
- **`/feedback-studio:report`** — writes `.feedback/REPORT.md`, a shareable digest
  of the round (what was asked, what changed with `file:line`, what was refused or
  left open and why), paste-ready for a PR description or team channel.

## [0.1.5] - 2026-06-12

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

[Unreleased]: https://github.com/baskb/feedback-studio/compare/v0.9.6...HEAD
[0.9.6]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.6
[0.9.5]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.5
[0.9.4]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.4
[0.9.3]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.3
[0.9.2]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.2
[0.9.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.1
[0.9.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.9.0
[0.8.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.8.0
[0.7.6]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.6
[0.7.5]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.5
[0.7.4]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.4
[0.7.3]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.3
[0.7.2]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.2
[0.7.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.1
[0.7.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.7.0
[0.6.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.6.0
[0.5.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.5.1
[0.5.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.5.0
[0.4.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.4.0
[0.3.4]: https://github.com/baskb/feedback-studio/releases/tag/v0.3.4
[0.3.3]: https://github.com/baskb/feedback-studio/releases/tag/v0.3.3
[0.3.2]: https://github.com/baskb/feedback-studio/releases/tag/v0.3.2
[0.3.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.3.1
[0.3.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.3.0
[0.2.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.2.0
[0.1.5]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.5
[0.1.4]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.4
[0.1.3]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.3
[0.1.2]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.2
[0.1.1]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.1
[0.1.0]: https://github.com/baskb/feedback-studio/releases/tag/v0.1.0
