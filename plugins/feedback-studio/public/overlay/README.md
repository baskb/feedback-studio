# The overlay, module by module

This folder is the browser half of Feedback Studio: the commenting UI injected into every page the server serves. It used to be one 4000-line file (`public/overlay.js`); it is now native ES modules with no build step and no dependencies.

## How it is loaded

The server serves `main.mjs` at the URL `/__feedback/overlay.js`, and the page loads it with `<script type="module">`. Every other file here is served at `/__feedback/overlay/<name>.mjs`, and the shared modules it imports from `lib/` at `/__feedback/lib/<name>.mjs`. **Every import uses that absolute URL path, never a relative one** — the same specifier has to work in the browser and in the Node checks, which map those paths onto disk.

`main.mjs` is deliberately a shim with no static imports of its own. The server prefixes a few configuration statements onto the file it serves (`window.__kbfShots`, `__kbfRole`, `__kbfLabel`), and a static import would be hoisted above them: the modules would read the share role and the mode before either was set. The dynamic `import()` of `boot.mjs` runs after those lines instead.

## The layers

A module never imports one listed below it. The few calls that do run upward go through `events.mjs`, which is why the import graph has no cycles.

| Module | Lines | What it owns |
| --- | ---: | --- |
| `main.mjs` | 29 | Entry shim: the mounted-once guard, the load-failure console message, the dynamic import of `boot`. |
| `boot.mjs` | 165 | Event wiring, the console test hooks, every module's `init`, and `load()`. The only place that knows the startup order. |
| `state.mjs` | 321 | Configuration read from the page, the `S` object holding all shared mutable state, and pure helpers over it. Imports only the schema and `norm`. |
| `events.mjs` | 21 | `on` / `emit`. Synchronous, in registration order. |
| `api.mjs` | 17 | `api()` — fetch plus the error contract. |
| `dom.mjs` | 53 | The browser adapter for `lib/anchor.mjs`, plus the two Range wrappers. All anchoring logic lives in `lib/`. |
| `ui.mjs` | 400 | Icons, the shadow host and its markup, the element references, toasts, the hover highlight, `escapeHtml`. Also where the host stays reachable when the page shows a popup: it is a manual popover (top layer), moves inside an open modal dialog and back (`keepOverlayOnTop`), and stops its own clicks, taps and keys at the host so the page never sees them as "outside". |
| `pins.mjs` | 107 | The pins over the page, and `schedulePos` — one rAF-batched re-measure for everything that floats. |
| `mode.mjs` | 313 | Point mode: hover aiming, sentence aiming in `--md`, the pointer handlers, the touch picker, and `pickElement`. |
| `tweaks.mjs` | 421 | Tweak Mode: live style knobs, and `makeTrustedGetEl` (the confidence gate every on-page action shares). |
| `textedit.mjs` | 130 | Edit-in-place text on the page. |
| `image.mjs` | 328 | Image replacement and the crop modal. |
| `shots.mjs` | 72 | Element screenshots at pin time. |
| `voice.mjs` | 109 | Composer dictation (Web Speech). |
| `composer.mjs` | 352 | The composer dialog, its target highlight, and `doSave`. |
| `variants.mjs` | 210 | Agent-proposed alternatives previewed on the page, and their second sanitation pass. |
| `narrate.mjs` | 490 | "Talk me through it", the spoken-draft tray, and the walkthrough that reads the agent's replies aloud. |
| `panel.mjs` | 473 | The review list: rendering, card actions, re-pinning, `refresh`, the DOM observer. |
| `presence.mjs` | 158 | What the agent is doing: chip, activity drawer, tab title and favicon. |
| `live.mjs` | 114 | The server-sent event stream and the agent-requested reload. |
| `theme.mjs` | 27 | Light / dark. |
| `fab.mjs` | 90 | The floating button cluster and its drag-to-a-corner. |

## The four upward calls

Everything else is a direct import.

| Event | Emitted by | Handled by |
| --- | --- | --- |
| `refresh` | `composer` after a save | `panel.refresh` |
| `comment:focus` | `pins` when a pin is clicked | `panel.focusComment` |
| `variants:open` | `panel` from a reply's "try these options" | `variants.openVariantPreview` |
| `reposition` | `pins.schedulePos`, once per frame | `composer.positionTarget`, then `mode.repositionAim`, then `variants.repositionVariantBar` — in that order, which is the order the old `schedulePos` ran them in |

## Two rules to keep

**Import-safety.** Importing a module must not touch the page. Anything that used to run at load time inside the old IIFE lives in an exported `init*()` that `boot.mjs` calls, in the original order. Reading `window.__kbfMode` and friends at module top level is fine — the server sets them before the script runs.

**Shared state goes in `S`.** A module-level `let` that another module needs to see does not work across modules. Put it on `S` in `state.mjs`. Module-private state (a cached lazy import, a pointer-down position) stays local.
