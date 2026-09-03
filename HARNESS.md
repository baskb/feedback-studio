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

One more rule keeps duplicates honest. When the quoted text is found on more than one element of the tag the anchor recorded, a match on text alone earns at most `medium`, never `high`. Two identical table rows, two bullets with the same sentence, a repeated heading: picking the first one would be a guess, so the comment asks for a re-check instead.

`low` and `none` are the refuse-and-re-pin cases. The key invariant the family
grouping protects: a selector and xpath that have rotted to the same wrong
element can no longer be mistaken for two strategies agreeing, so they cannot
produce a confident wrong edit.

## The same scenarios run in CI

Since 1.1.0 the anchoring code lives in `plugins/feedback-studio/lib/anchor.mjs`, a module without a DOM of its own: the page comes in through a small adapter, so the browser overlay and the Node test suite run the very same code. `test/anchor.test.mjs` builds a sample page from literals (`test/fake-dom.mjs`) and replays the scenarios below: an identical page, typical edits, the harsh case with shifted siblings and replaced headings, duplicated elements, placeholder snippets, sentence ranges, and the id and attribute rules. Every scenario asserts the one property that matters: a result is either `high` at the right element, or it degrades. It is never `high` at a wrong element. The fake page understands only the selectors the module itself writes and refuses anything else, so a change to how anchors are built cannot pass the tests by accident.

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

## Presence and activity are not anchoring signals

Watch mode tells the page which comment the agent is on (`agent-status`) and what it just did (`activity`). Both are in-memory on the server, ephemeral, and purely informational: they never feed `resolveWithConfidence`, never change a comment's stored anchor, and never move a comment's status. A "working on #3" claim that is left behind by a crashed agent is released by the server's 10-minute silence timer; a wrong claim can at worst light the wrong pin, never edit the wrong element.
