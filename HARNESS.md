# Anchor reliability

The whole tool rests on one risky promise: when the agent acts on a comment, it
edits the **right** element. If anchors silently rot, the agent confidently edits
the wrong node — the existential risk in [PLAN.md](PLAN.md) §9. So anchors use
several independent strategies and a confidence tier, and when confidence is low
the contract is to **refuse and ask for a re-pin**, never to guess.

## How an anchor is stored and resolved

Each comment stores, in order of strength: a stable attribute/id selector, a CSS
`nth-of-type` path, an XPath, and a normalized quoted text snippet (`textContent`,
so the casing matches source and survives `text-transform`). On resolve, every
strategy runs; the element the most strategies agree on wins. Confidence:

- **high** — a stable attr/id resolves, or the css selector resolves and the text still matches.
- **medium** — only the text matches, or only structure matches.
- **low** — something resolved but the text no longer matches (probably the wrong node).
- **none** — nothing resolved.

`low`/`none` are the refuse-and-re-pin cases.

## Reproduce

With the overlay open on any page, in the dev console:

```js
window.__kbfSelfTest()   // re-resolves every comment on this page → { total, resolved, rate, detail }
window.__kbfBuildAnchor(el)   // the anchor a given element would get (used to seed the harness)
```

The harness seeds anchors on ~25 diverse elements (headings, paragraphs, links,
list items, spans, divs, sections, nav), then re-runs `__kbfSelfTest` after a
reload and after DOM perturbations.

## Measured (KB365 v3 homepage — a hard, real target: canvas hero, scoped CSS, mega-menu, scroll-reveal)

| Scenario | Resolved correctly | Confidence spread |
|---|---|---|
| Identical reload (deterministic rebuild) | **25 / 25 (100%)** | all high |
| Typical edits (text tweaks, different-tag insertions) | **25 / 25 (100%)** | all high |
| Harsh worst case (same-tag siblings shifting every index + 11 anchored headings' text fully replaced) | **20 / 25 (80%)** | 2 high, 18 medium, 4 low, 1 none |

The safety property holds: in the harsh case the 5 that could not be re-found
correctly degraded to `low`/`none` rather than resolving to a confident wrong
element. Those are exactly the comments the `/feedback` skill leaves open for a re-pin.

## Still to do (the full gate from PLAN.md §9)

This measures a single page under synthetic perturbation. The full pre-launch gate
is a multi-page harness that rebuilds the site after *real* content edits and reports
the rate per release, targeting ≥85% on a real site. The primitives above
(`__kbfSelfTest`, `__kbfBuildAnchor`) are what that harness is built on.
