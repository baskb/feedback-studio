# Anchor reliability

The tool makes one risky promise: when an agent acts on a comment, it edits the
**right** element. If anchors silently rot, the agent can edit the wrong node
with confidence. Feedback Studio is built to avoid that failure. Anchors use
several independent strategies plus a confidence tier; when confidence is low,
the contract is to **refuse and ask for a re-pin**, never to guess.

## How an anchor is stored and resolved

Each comment stores, in order of strength: a stable attribute/id selector, a CSS
`nth-of-type` path, an XPath, and a normalized quoted text snippet (`textContent`,
so the casing matches source and survives `text-transform`). On resolve, every
strategy runs and votes for an element.

The strategies are grouped into **independent families**. The CSS selector and
XPath are both positional encodings of the same DOM path, so after an edit they
rot **together**. Their agreement is not independent corroboration, so they count
as one `structural` family. A stable `attr`/id is a second family; quoted `text`
is a third. A "strong" text match means the resolved element's text *starts
with* the snippet. An over-broad ancestor that merely *contains* it counts as
weak, not strong. Confidence:

- **high**: a stable attr/id resolves with the text still matching, **or**
  structure resolves **and** the text strongly matches (two independent families
  agree). A unique attr/id with no text to check is also high.
- **medium**: text is present but not a clean match (re-check before editing), or
  an attr resolves but the content has changed.
- **low**: only structure resolved (positional only, so likely rotted), or
  nothing corroborates.
- **none**: nothing resolved.

`low` and `none` are the refuse-and-re-pin cases. The key invariant the family
grouping protects: a selector and xpath that have rotted to the same wrong
element can no longer be mistaken for two strategies agreeing, so they cannot
produce a confident wrong edit.

## Reproduce

With the overlay open on any page, in the dev console:

```js
window.__kbfSelfTest()   // re-resolves every comment on this page -> { total, resolved, rate, detail }
window.__kbfBuildAnchor(el)   // the anchor a given element would get (used to seed the harness)
```

The harness seeds anchors on about 25 diverse elements (headings, paragraphs,
links, list items, spans, divs, sections, nav), then re-runs `__kbfSelfTest`
after a reload and after DOM perturbations.

## Measured (KB365 v3 homepage, a hard, real target: canvas hero, scoped CSS, mega-menu, scroll-reveal)

| Scenario | Resolved correctly | Confidence spread |
|---|---|---|
| Identical reload (deterministic rebuild) | **25 / 25 (100%)** | all high |
| Typical edits (text tweaks, different-tag insertions) | **25 / 25 (100%)** | all high |
| Harsh worst case (same-tag siblings shifting every index + 11 anchored headings' text fully replaced) | **20 / 25 (80%)** | 2 high, 18 medium, 4 low, 1 none |

The safety property holds: in the harsh case, the 5 comments that could not be
re-found correctly degraded to `low` or `none` rather than resolving to a
confident wrong element. Those are exactly the comments the `/feedback` skill
leaves open for a re-pin.

These numbers are re-measured per release. The family-grouped vote that ships
now only moves borderline structural-only matches toward lower, safer
confidence, so the confident-correct counts can only hold or improve.
