# Feedback Studio — Final Plan

> Produced by a multi-agent workflow: 5 persona brainstorms (creative marketer,
> website builder/UX, productivity expert, developer/architect, and the AI agent
> that consumes the comments) → two adversarial critique rounds → synthesis.
> Status: planning only. Repo stays private until the v1 core is proven.

## TL;DR

1. **Build one thing perfectly: the local `npx` visual-review loop for sites *you* build with an AI agent.** No extension, no store, no signup, no cloud. Comments land as files in your repo; your coding agent reads them and ships the fixes.
2. **The differentiator is voice review from the couch, supervised batch-resolve.** Capture comments by speaking; then paste one command and watch the agent propose diffs you approve in seconds. Not autonomous overnight editing. That framing is a trust landmine and is killed.
3. **The existential risk is the agent editing the wrong element.** Before any marketing, build an anchor-rot test harness against a real re-rendering site and publish the resolve-rate. No marketing survives a tool that confidently edits the wrong node.
4. **Ship desktop voice in v1** so the first launch already carries the differentiator. Phone voice comes in Wave 2 over a tunnel, never a self-signed cert stack.
5. **Three comment types, three roadmap phases, one hero demo video.** Win a small vocal core of solo agentic devs who use it every build. Everyone else arrives sideways through the `FEEDBACK.md` that shows up in a repo they share.

---

## 1. Vision and positioning

**Vision:** the shortest path from "this looks off" to "the agent fixed it," for sites you build with an AI coding agent. Visual human feedback in, code and content changes out, as plain files in your repo.

**One-line positioning:**
> Review your site by voice, then paste one command and watch your AI agent ship each fix as a diff you approve. No extension, no signup. Just `npx`, and comments that land as files in your repo.

**What it actually is:** the no-install visual review loop for sites you build with an AI agent.

**Two differentiators, baked into every asset:**
- **No extension, no store, no signup** (the incumbents all require an extension or an account).
- **Voice capture** (nobody else has it).

**Wedge audience:** solo agentic developers and one-to-three-person studios who build sites *with* Claude Code or Cursor. Start in the Dutch and EU "ik bouw met Claude Code" crowd Bastiaan already swims in. They own their dev server, trust `npx`, and review their AI's output daily. Designers, PMs, agencies and QA arrive later, sideways, through the `FEEDBACK.md` that lands in a shared repo. They are not a v1 target.

**The disciplined scope limit, stated out loud as a trust signal:** *for sites you build, not sites you browse.* The brand win is the solo architect who ships sharp, finished, opinionated dev tools.

---

## 2. Architecture: the firm call

**Primary path: the local `npx` proxy/static server. This is the product and the moat. Everything is built around it.** No browser extension, no bookmarklet, no hosted SaaS, no third-party-site support in v1, and it is said loudly in the README.

| Option | Verdict |
|---|---|
| **Local proxy / `npx` (current)** | **PRIMARY.** Owns the full loop for sites you build: zero install, live-reload, the agent owns the codebase so the loop actually closes. |
| **Bookmarklet** | **Kill.** Modern CSP makes `javascript:` injection unreliable and ugly; it generates "doesn't work on site X" issues one person cannot fix. |
| **Browser extension (MV3)** | **Kill for v1, defer indefinitely.** Store-review tax, `<all_urls>` scrutiny, anchor rot on third-party sites, and no agent owns that codebase so the loop has no other end. It collapses into plain annotation, a market already owned by Marker.io and BugHerd. |
| **Hybrid (proxy + thin MV3)** | Elegant on paper, but the recurring store-review and per-site-breakage tax sinks solo projects. No. |

**Why this is the right call for the three goals (share knowledge, help agentic devs, improve the brand):** third-party-site commenting serves none of them and multiplies the maintenance and legal surface for one person. Scope discipline *is* the brand asset.

**MCP server:** the right *eventual* canonical interface (one integration reaches Cursor, Windsurf, Cline, Zed), but **descoped to Next.** The open file format already delivers "any agent can read it." Launch on the Claude Code plugin plus `npx`; add MCP once the loop is proven. Keep the schema and storage stable and boring so any front-end or agent client stays thin and replaceable.

**Proxy correctness is a first-class concern, not a freebie.** Injecting an overlay into a proxied dev server collides with the site's own CSP (`script-src`/`style-src` blocking the injected shadow-root assets), absolute-URL assets, HMR WebSockets (Vite and Astro run their own live-reload socket the proxy must pass through), and cookie/SameSite rewriting. **Decision: support a narrow, tested set of dev servers in v1 (Vite, Astro, Next), each verified by hand. Narrow and reliable beats universal and flaky for a solo maintainer.** The proxy strips/rewrites CSP, passes HMR sockets through, and rewrites absolute asset URLs.

---

## 3. Comment-type taxonomy

Three types in v1. The organizing question is "does the agent edit code, and how much judgement does it get?" Type is a one-tap pill that appears *after* you click an element, defaults to last-used, sticky per session. `ask` and `comment` are multiplayer affordances and move to Next; a solo dev reviewing their own site does not leave "no action, just noting" pins for an audience of one.

| Type | What the human means | How the AI agent acts | Example |
|---|---|---|---|
| **fix** | "this is broken or wrong" | Reproduce, then patch as a reviewable diff. Lowest judgement, highest certainty. | "This button overlaps the footer on mobile." |
| **change** | "make it say or be exactly this" | Apply near-verbatim to the anchored element or text. Do not redesign around it. | "Change this heading to 'Werkwijze'." |
| **improve** | "this is weak, use your judgement" | Rewrite or redesign the anchored thing with judgement, keeping brand voice. Highest autonomy. | "This intro paragraph is flat, make it land harder." |

Each type prepends a distinct instruction to the agent. The schema also carries a per-comment **autonomy field** ("just do it" vs "show me first"). **Ship the field now, build its UI in Next.** Same discipline applies to the agent contract (see §5).

---

## 4. Stupid-simple adoption and the 60-second first run

**Principles:** one command, zero config. No account, no API key, no backend. Opinionated defaults carry 95% of users to their first pin. Sticky last-used type and language so a 20-edit pass is one decision, not twenty.

**The 60-second desktop first run (v1, no phone required):**
1. `npx feedback-studio ./dist` or `--proxy localhost:4321`. **[~10s]** No install, no flags needed.
2. Browser opens automatically, overlay live, a pulsing "Start commenting" pill. The side-panel empty state teaches by doing: *"Click any element to leave your first comment,"* with one animated cursor demo. **[~20s]**
3. Click the broken thing, speak the comment (desktop mic, Web Speech API works on localhost over plain http in Chrome). Pin drops. **[~25s]**
4. Panel shows an **"N comments ready for your agent"** badge and a copy button for the literal next action: *paste `/feedback` into Claude Code.* **[~5s]**

**Closing the loop on screen.** When the agent writes its resolutions back, pins flip to green live. This is load-bearing magic and it is **real engineering, not "just UX": the running server watches `.feedback/comments.json` and pushes status changes to the open overlay over SSE.** That file-watch → SSE → overlay channel is a **named v1 deliverable** (see §6). If it slips, the honest v1 fallback is "re-open the overlay to see resolved pins," and the live-green moment is not marketed until it exists.

---

## 5. The agent loop (deliberately minimal in v1)

The agent is an LLM and is the least controllable part of the system. Over-specifying its contract invites "it didn't do what the README said" issues. **V1 agent contract, and nothing more:**

- Read all open comments.
- Resolve each anchor with a confidence score.
- Group proposed diffs by page; present them for the human to apply.
- Mark resolved on apply; the pin flips green over SSE.
- **Below the confidence threshold, refuse to auto-resolve the anchor and flag the comment for a re-pin rather than edit the wrong node.**

**Moved to Next:** changelog-on-resolve, automated `needs-info` re-pin requests, autonomy-dial UI. The *schema fields* for all of these ship in v1; only the behaviour is deferred.

**Anchors** use multiple strategies: CSS selector, `nth-of-type`, normalized quoted text snippet, tag, nearest stable id or data-attribute, and an XPath fallback. The confidence score combines how many strategies agree. The threshold is not hand-waved: it is **calibrated against the test harness in §9** and the measured resolve rate is published.

---

## 6. Phased roadmap

### NOW — the smallest valuable release (the daily wedge)
This is the launchable core. Mark this as the first release.
- `npx` zero-config proxy/static boot, browser auto-open, shadow-root overlay live. Comment mode is a toggle; with mode off the page behaves 100% normally.
- Narrow, tested proxy support: Vite, Astro, Next (CSP rewrite + HMR pass-through + absolute-URL handling).
- Click-element and select-text capture; mobile DOM walk (tap, then up/down to pick the block).
- **Desktop voice capture (Web Speech API, NL/EN auto-detect + toggle).** This is what makes Wave 1 differentiated.
- Three comment types (fix / change / improve) as a sticky one-tap post-click pill.
- Frozen, versioned `comment` schema; `comments.json` ↔ `FEEDBACK.md` deterministic round-trip.
- Pins + side panel (filter, jump-to, edit, resolve, delete); "N ready" badge + copy-paste `/feedback`.
- **File-watch → SSE → overlay live-status channel** (pins flip green when the agent resolves).
- Minimal `/feedback` slash command per §5 (propose grouped diffs, human applies, refuse-when-uncertain).
- One polished resolve animation (pin → checkmark → fade). Warm-paper, clay/coral aesthetic.
- README with hero GIF + the 45-second demo video. Claude Code plugin + npm published.
- **Published anchor resolve-rate from the §9 harness, in the README, as a credibility flex.**

### NEXT — the phone/voice escalation and reach (Wave 2)
- **Phone handoff over a tunnel** (`--tunnel` shells out to a trusted tunnel giving a real HTTPS URL + QR). Mic just works, no cert-trust hell, no LAN-security surface. The couch-review launch.
- MCP server + one-click "Add to Claude Code / Cursor / Windsurf" config block.
- `ask` and `comment` comment types, alongside the client-handoff use cases where they earn their place.
- Agent-contract richness: changelog-on-resolve, automated `needs-info` re-pin, autonomy-dial UI.
- Cropped screenshot + computed-style capture per comment, opt-in (privacy framed as *no egress*, see §9).

### LATER — only if there is real pull
- Additional comment types (`a11y`, `design`) once they demonstrably branch agent behaviour.
- Framework-aware component-to-source mapping beyond sourcemaps.
- Multi-reviewer / client-handoff niceties (assignment, mentions), still local-file, never accounts or cloud.
- Browser extension, only if users beg, and even then a secondary door, never the headline.

---

## 7. Marketing and personal-branding plan

**The one asset that does the most work: a single 45-second demo video, shot on a real phone, beautifully.** Warm-paper UI, a real spoken comment, real diffs appearing as pins flip green. The honest, contradiction-free hero narrative:

> *"I reviewed my whole site by voice from the couch. Then I pasted one command and watched the pins go green as Claude shipped each fix. I just skimmed the diffs."*

This is the README hero, the Show HN link, and the X/LinkedIn post. The magic is voice capture plus supervised batch-resolve, **not** autonomous overnight editing. That reframe removes the credibility landmine an HN commenter would find in thirty seconds.

**Channels, named and concrete:**
- **Show HN:** "Show HN: Feedback Studio — review your site by voice, your AI agent ships the fix (no extension)." Link to the video-first README. **Fire this only at the differentiated build that includes voice**, not the bare proxy.
- **Plugin-marketplace SEO:** title and description target real searches: "visual feedback," "review," "comment to code," "screenshot feedback." One-PR entry, keyworded.
- **Bastiaan's existing channels:** the Dutch and EU Claude-Code communities, LinkedIn (his architect-brand audience), X dev-tool threads. Post the video, not a blog.
- **The organic engine:** every shared `FEEDBACK.md` carries the tool name into someone else's repo, PR, or tweet. Free and compounding.

**Launch in two waves:**
- **Wave 1:** the airtight desktop loop *with desktop voice*. README + video, Show HN, marketplace entry, Dutch-community posts.
- **Wave 2:** the phone/couch-review video over the tunnel. Same product, second spike.

**Branding angle:** the solo architect who ships sharp, opinionated, finished tools. The scope limit ("for sites you build") is part of the voice. Being one person is a feature, not an apology.

**Naming, decoupled.** Marketplace SEO and a viral ritual phrase pull in opposite directions, so split them. The **package/marketplace name is findable and keyworded** so the SEO bet works (something in the `visual-feedback` / `feedback-loop` family). The **ritual phrase is a tagline you popularize** ("the couch-review tool"), not the package name. **"Vibe Review" is cut** because it collides with the incumbent Vibe Annotations and is actively confusing.

---

## 8. Broader use cases (reached sideways, never built as v1 features)

- **Solo agentic devs reviewing their own AI's output** — the hero, daily, single-player, zero-coordination. This *is* the wedge.
- **Tiny agencies / freelancers collecting client feedback** — the dev boots the proxy, hands the client a URL; the client sees only a page + overlay. The dev gets a clean `FEEDBACK.md` brief.
- **Designers / PMs / content reviewers** — they comment; the readable `FEEDBACK.md` *is* their deliverable. No "designer mode" gets built.
- **QA, accessibility, technical writers, no-code builders** — "also works for" copy, never v1 features.

The rule: widen the funnel by marketing the artifact, not by building per-persona UI.

---

## 9. Risks and mitigations

1. **The agent edits the wrong element and the user reverts forever (existential).** Visual feedback is where AI is most confidently wrong. *Mitigation:* multi-strategy anchors + confidence score; below threshold the agent **refuses and requests a re-pin** rather than guessing; every change is a reviewable diff. **Decisive proof, not a promise: build a 20-page anchor-rot test harness against a real re-rendering site (the KB365 v3 site is ideal — canvas scenes, scoped CSS, dynamic content), measure the resolved-vs-flagged rate, and publish it. If it is below ~85% on a real site, the product is not ready and no marketing fixes that.** This is "test on ONE before replicating to N" at its hardest.
2. **The "pins go green live" promise is real plumbing.** *Mitigation:* the file-watch → SSE → overlay channel is a named NOW deliverable (§6). If it slips, downgrade the promise honestly to "re-open to see resolved pins" and do not market the live moment until it ships.
3. **Proxy correctness (CSP / HMR / absolute URLs).** The second-most-likely "doesn't work on my site" source after anchor rot. *Mitigation:* support a narrow, hand-tested list of dev servers (Vite, Astro, Next); rewrite CSP, pass HMR sockets through, handle absolute asset URLs. Narrow and reliable over universal and flaky.
4. **Phone/voice security and support burden.** Self-signed certs on phones are a UX nightmare (scare screens, manual iOS trust) and the #1 future issue-tracker sinkhole for one person. *Mitigation:* **cut the self-signed cert stack entirely.** Use `--tunnel` for a real HTTPS URL so the mic just works and there is no LAN-security surface to defend. Phone *text* over plain LAN http is the fallback if a tunnel is unavailable.
5. **Privacy.** *Mitigation:* anchor the story on the true invariant — **everything stays in `.feedback/` on your machine, local-only, no network egress.** This survives the Next-phase screenshot/computed-style feature (a screenshot is page capture, but it never leaves the machine). Do not sell "we only capture the snippet," which the roadmap breaks.
6. **One-person maintainability.** *Mitigation:* no backend, no accounts, no extension, no cert stack. Keep schema and storage stable and boring; front-ends and agent clients are thin and replaceable. A sharp finished tool *is* the brand goal; a sprawling half-maintained one hurts it.
7. **"Just another Vibe Annotations" silence.** *Mitigation:* never lead with the incumbent's line. Lead with the two things they lack — no extension and voice. Ship voice in Wave 1 so Show HN fires at a genuinely differentiated build.

---

## 10. Success signals

**Activation (is it stupid-simple?)**
- Time from `npx` to first pin under 60 seconds for a new user.
- North-star activation event: % of first sessions that reach "agent resolved at least one comment." The loop closing once is the magic moment.

**Retention (is the single-player loop real?)**
- Day-2 and week-2 return rate of solo devs.
- Comments-per-session and sessions-per-week.
- Ratio of resolved to flagged-for-re-pin (anchor-precision proxy; a rising flag rate means anchors are rotting and trust is leaking).

**Trust (does the agent get it right?)**
- % of agent-applied diffs accepted vs reverted (the one trust number that matters; track it, do not hope for it).
- The published anchor resolve-rate from the §9 harness, re-run per release.

**Reach and brand (the three goals)**
- npm weekly downloads + plugin-marketplace installs.
- GitHub stars, and more meaningfully, **`FEEDBACK.md` files appearing in public repos, PRs, and tweets** (the organic-ad signal).
- Show HN front-page placement and inbound from the Dutch/EU Claude-Code community.
- One concrete brand signal: **inbound that names Bastiaan specifically** — a creator mention, a "built by the KB365 guy" reference, a podcast or newsletter invite.

**The metric that matters most:** repeated, unprompted use by the wedge — a solo dev who reviews their AI's output with it *every build*, without being asked. If that habit is real, everything else follows.

---

## First two weeks — concrete starting checklist

**Week 1 — prove the risky core before any polish.**
- [ ] Stand up the `npx` server: serve `./dist` and `--proxy localhost:4321` against the KB365 v3 Astro site; get CSP rewrite + HMR pass-through working.
- [ ] Inject the shadow-root overlay; implement comment-mode toggle (page is 100% normal when off).
- [ ] Implement the multi-strategy anchor (selector + nth-of-type + text snippet + tag + nearest stable id + XPath) and the confidence score.
- [ ] **Build the 20-page anchor-rot harness against the KB365 site. Measure and write down the resolve rate. Gate everything else on ~85%.**

**Week 2 — close the loop end-to-end once, ugly is fine.**
- [ ] Freeze the versioned `comment` schema (include the autonomy field, unused for now); implement `comments.json` ↔ `FEEDBACK.md` round-trip.
- [ ] Click + select-text capture; three-type sticky pill (fix / change / improve); desktop voice via Web Speech API.
- [ ] Minimal `/feedback` slash command: read open comments → grouped diffs → human applies → mark resolved.
- [ ] File-watch → SSE → overlay so one pin visibly flips green when resolved.
- [ ] Record a rough version of the 45-second demo to confirm the loop *feels* like magic. If it doesn't, fix the loop before writing a word of marketing.

Relevant harness target: the KB365 v3 site (canvas scenes, scoped CSS, dynamic content make it a hard, realistic anchor-rot test).
