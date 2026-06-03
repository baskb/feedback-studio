# Feedback Studio — Third-Party Path: Final Decision Memo

> Produced by a focused multi-agent workflow: 4 parallel explorers (loop architect,
> extension/injection engineer, market & audience strategist, risk/privacy/maintainability
> officer) → one adversarial critique → balanced decision memo. The workflow was tasked
> to try to *refute* the v1 plan's decision to kill third-party support, not to rubber-stamp it.

## Verdict: NO-GO for v1. CONDITIONAL for a post-traction experiment.

Kill third-party support and the browser extension for v1, but for the precise reason that matters: **the thing that makes this product worth existing is the mechanical comment-to-diff loop, and that loop cannot close on a site you do not own.** The moment it can produce a diff against a repo you control, you owned the repo, and it was never third-party. Every remaining third-party deliverable degrades into a document-based me-too in two already-saturated markets. The four conditions that flip this to a conditional go are listed at the end.

## The crux: does the loop close?

The honest answer to "what does the agent produce for a site you don't own": **a document, not a commit.** An audit, a teardown, a rewrite spec, a clone brief, or a pitch artifact.

That is the whole problem. The reason this product is interesting and not BugHerd is that comment-in produces code-out with no human in the middle of the execution. Replace the commit with a document a human must then read and act on, and you have rebuilt the exact category that is already crowded: Agentation and Vibe Annotations on the annotation side, UXAudit.Now and UX Pilot on the report/clone side. Those tools mostly need no annotation step at all, which makes the overlay-and-anchor machinery pure friction rather than the scarce input.

Two candidate "wins" were proposed and neither survives:

- **The consultant pitch artifact** closes commercially (a freelancer emails a PDF and wins work), not in the product. By that standard every report generator "closes a loop." It is the annotation trap wearing a blazer, and it is not the creator's loop. Bastiaan wins M365 engagements; he is not running a web-redesign teardown sales motion at volume.
- **The clone/redesign brief** is the only variant with a real technical loop (third-party page in, spec out, the user's *own* repo gets built). But "paste URL, get editable Next.js/Figma" already exists and wants zero human clicking. The claimed advantage ("anchors are the diff intent") is plausible but **unproven** — nobody has run the falsification test. Until URL+anchors is shown to beat URL-alone, it is a hope, not a finding.

The single question all four explorations dodged — "is a document a satisfying close, or does the magic only live in the diff against the user's repo?" — has an answer that kills the feature: **the magic is the diff.** Third-party structurally cannot produce one, unless the user owns the repo, in which case it collapses back into the owned-site case and needs no third-party framing at all.

## The deliverable taxonomy

| Review target | What the agent produces | Who wants it | How differentiated |
|---|---|---|---|
| Accessibility / WCAG | Element-keyed a11y findings | Owners, a11y reviewers | Weak. axe-core/Lighthouse discover most issues from a URL; anchors are not the scarce input. |
| Generic UX/heuristic audit | Narrative critique PDF | PMs, owners | Weak. A vision model generates this from screenshots; the human clicks earn nothing. |
| Prioritized ticket set | Tickets with anchor + repro + severity | Owners / teammates | None. This *is* BugHerd/Marker.io, with a worse integration story. |
| PR against the site's repo | Actual code change | Anyone with repo access | Strong — but this is the owned loop, not third-party. Near-zero marginal cost; treat as a continuum. |
| Redesign / clone brief | Implementation-ready rebuild spec | Devs rebuilding/migrating a site | Medium. Real technical loop, but me-too vs URL-cloners; anchor advantage unproven. |
| Content rewrite spec | Per-block old→new copy | Owners / copywriters | Medium. Strong only on your own content (= owned loop). |
| Competitor teardown | Anchored strategic analysis | Strategists | Medium. Insight, not action; does not close a loop standalone. Legal/ToS optics. |
| Consultant critique-to-pitch | Branded "18 located problems + fixes" doc | Freelancers/agencies | Differentiated, but closes commercially not in-product; not the creator's business. |

The only genuinely novel element across the entire investigation is **the bridge** ("teardown a site, generate a brief, the same toolchain builds it in owned-mode"). But that bridge's value lives entirely in the owned-mode build step that already exists in v1. The third-party front end is a slower, worse way to start a process v1 already does better when you start from your own intent.

## Recommended minimal credible path (if ever pursued)

Not a browser extension. The clean version is a local, one-shot, document-out mode of the existing tool:

- **Tech approach:** `npx feedback-studio teardown <url>` against **public, non-authenticated pages** through the existing local proxy/inject path. The current server already does the inject dance against your `dist/`; pointing it at a remote URL is a small change, not a new architecture. Comments anchor primarily by **text-quote** (content-based, survives DOM churn) with element selector as a secondary hint, stored locally exactly as today.
- **Explicitly NOT:** an `<all_urls>` content script, and not `activeTab` either — because `activeTab` still requires an extension, which reopens the entire Chrome Web Store dependency (review tax, reputational surface, unilateral delisting). The local proxy is the only version that keeps the no-store promise.
- **The one wedge use case:** "rebuild or audit a site you are responsible for" (a staging site, a client site you are migrating, your own old site). Not "comment on any site," not "competitor teardown."
- **Build first:** nothing, until the falsification test passes (see below).

## How it relates to the v1 npx plan

It is a **sequenced complement, never a co-equal launch pillar or a fork.** It reuses the same overlay, anchor schema, FEEDBACK.md, and plugin — so the marginal build cost is genuinely low. But the binding constraint is not build cost, it is focus. v1 has not shipped. A solo maintainer with no test runner, no linter, and a deploy that already flakes on IP-whitelist should run one product, not two. The owned-site loop is the crisp, demoable thing that serves all three stated goals (share knowledge, help agentic devs, raise profile) better than a fuzzy v1.x that invites "so it's just BugHerd / just another cloner?"

A solo person can technically carry both because they share an engine. They should not, until the first one has landed.

## The strongest steelman AGAINST killing it (kept intact)

There exists a narrow, genuinely safe path — local proxy, one-shot, document-out, public pages only, reusing the engine — that expands the addressable audience from "people building a site" to "people rebuilding, migrating, or auditing a site they are responsible for." That is a real adjacent group, reachable at near-zero marginal build cost and near-zero privacy/legal/store risk. If raw audience size is the literal goal, this nibbles at it without blowing anything up, and it does so while preserving the "everything stays on your machine" story for storage. Dismissing it as "just BugHerd" understates that the bridge into owned-mode build is something neither the annotators nor the URL-cloners connect end to end.

The counter that wins anyway: that adjacent audience is almost entirely captured by the owned-site mode the instant the user supplies a repo, and the incremental users who genuinely have no repo only ever get a document — which is the me-too. The steelman buys audience that does not advance the goals better than finishing v1 does.

## Risks and guardrails (only relevant if it is ever built)

- **Privacy / no-egress:** Storage stays local. But be honest about the asterisk every exploration glossed: the agent step itself sends third-party page content to the LLM (Claude via API/Claude Code). The README sentence must read "everything stays on your machine; page content you point me at is sent to your AI agent for processing" — not the cleaner "nothing is uploaded." If you cannot write the honest version, do not ship.
- **Authenticated/paywalled pages:** Must be technically refused, not left to user discretion. Reading a page behind session cookies is the worst ToS/CFAA/GDPR quadrant.
- **Store review:** Avoided entirely by staying off the extension path. The moment a CWS listing is required, abort.
- **Legal:** "Competitor teardown" must never appear in marketing — it is inducement to scrape. Frame strictly as auditing/rebuilding a site you are responsible for.
- **Maintenance:** No per-site adapters, ever. The instant the roadmap contains a list of "supported sites," it has become a maintenance product a solo dev cannot sustain. Text-quote anchoring on public pages keeps this bounded.

## What would change the verdict

Flip to a conditional GO only when **all four** hold, in order:

1. **v1 ships, demos cleanly, and gets real owned-site traction.** Non-negotiable gate. No second product before the first one lands.
2. **The falsification test passes:** generate the clone/redesign brief for ~5 real sites, URL-only vs URL+anchors, blind-judge whether the anchored version is *materially* better. If anchors do not measurably win, third-party is dead permanently — the clicking added nothing.
3. **It ships as `npx ... teardown <url>` through the local proxy, against public pages — not an extension.** No Chrome Web Store, no `activeTab`, no content script on arbitrary pages.
4. **The honest data-handling sentence stays true including the agent step,** authenticated pages are refused, and "competitor teardown" stays out of all marketing.

Drop it permanently if: v1 fails to find traction (you have bigger problems), or the falsification test shows anchors add nothing (the human input was theatre).

Until condition 1 is met, every hour on third-party is stolen from the only thing that makes this project matter. Finish v1.
