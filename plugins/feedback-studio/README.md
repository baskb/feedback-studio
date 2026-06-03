# feedback-studio (plugin)

The Claude Code plugin. Provides the `/feedback-studio:feedback` skill and the
self-contained server it drives.

```
plugins/feedback-studio/
├── .claude-plugin/plugin.json   # plugin manifest
├── skills/feedback/SKILL.md      # how Claude starts a session + processes comments
├── bin/feedback-studio.mjs       # the local server (static + proxy, optional HTTPS)
└── public/
    ├── overlay.js                # the in-page commenting UI (mounted in a shadow root)
    └── overlay.css               # Claude-flavoured styling
```

See the [repo README](../../README.md) for install and usage.
