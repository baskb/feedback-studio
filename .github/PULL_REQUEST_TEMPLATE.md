## What this does

<!-- A short description of the change and why. Link any related issue. -->

## Checklist

- [ ] `node --test plugins/feedback-studio/test/store.test.mjs` passes
- [ ] `node plugins/feedback-studio/test/smoke.mjs` passes
- [ ] `node plugins/feedback-studio/test/mcp-smoke.mjs` passes
- [ ] No new runtime npm dependencies
- [ ] If the comment schema or `type` set changed, `lib/store.mjs` is the source
      of truth and `public/overlay/` (the overlay now imports the type sets and tweakable properties from `lib/schema.mjs`) was updated to match
- [ ] If anchoring/resolution changed, the load-bearing invariant still holds
      (no confident wrong resolves). See `HARNESS.md`
