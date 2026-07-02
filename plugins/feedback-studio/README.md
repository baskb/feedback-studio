# feedback-studio (plugin)

This is the Claude Code plugin package for Feedback Studio. It provides four
skills — `/feedback-studio:feedback` (start a session / process comments / watch
live), `:demo` (instant playground), `:verify` (prove processed comments
landed), and `:report` (shareable round digest) — plus the self-contained Node
server they drive (static / proxy / Markdown / demo modes, live style knobs and
edit-text-in-place, pin-time screenshots, share-role links, optional HTTPS or
tunnel).

```
plugins/feedback-studio/
├── .claude-plugin/plugin.json    # plugin manifest
├── skills/
│   ├── feedback/SKILL.md         # how Claude starts sessions and processes comments
│   ├── demo/SKILL.md             # the bundled sample-page playground
│   ├── verify/SKILL.md           # post-processing verification (reopens unconfirmed edits)
│   └── report/SKILL.md           # .feedback/REPORT.md digest of a round
├── bin/feedback-studio.mjs       # local server: static, proxy, markdown, demo, optional HTTPS
├── bin/feedback-studio-mcp.mjs   # optional MCP stdio server for other agents
├── demo/                         # sample site + seed comments for --demo
├── lib/
│   ├── store.mjs                 # shared data layer: schema, atomic + locked I/O
│   └── markers.mjs               # Markdown @FB marker stamping (unique-match, refuse-to-guess)
└── public/
    ├── overlay.js                # in-page commenting UI, mounted in a shadow root
    └── overlay.css               # Claude-flavoured styling
```

Collect comments in the overlay, then tell your agent **PPF** — *Please Process
Feedback* — and it works through them (plugin skill, or the bundled MCP server for
other agents). The *please* is intentional; we're courteous to our agents. ;-)

See the [repo README](../../README.md) for install and usage.
