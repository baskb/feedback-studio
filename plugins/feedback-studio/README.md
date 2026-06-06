# feedback-studio (plugin)

This is the Claude Code plugin package for Feedback Studio. It provides the
`/feedback-studio:feedback` skill and the self-contained Node server that the
skill starts.

```
plugins/feedback-studio/
├── .claude-plugin/plugin.json    # plugin manifest
├── skills/feedback/SKILL.md      # how Claude starts sessions and processes comments
├── bin/feedback-studio.mjs       # local server: static, proxy, markdown, optional HTTPS
├── bin/feedback-studio-mcp.mjs   # optional MCP stdio server for other agents
├── lib/
│   ├── store.mjs                 # shared data layer: schema, atomic + locked I/O
│   └── markers.mjs               # Markdown @FB marker stamping (unique-match, refuse-to-guess)
└── public/
    ├── overlay.js                # in-page commenting UI, mounted in a shadow root
    └── overlay.css               # Claude-flavoured styling
```

See the [repo README](../../README.md) for install and usage.
