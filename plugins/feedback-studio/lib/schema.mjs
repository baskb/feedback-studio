// Feedback Studio — the comment schema constants.
//
// These are the contract between the three processes: the HTTP server, the MCP
// server (both via lib/store.mjs, which re-exports everything here) and the
// browser overlay, which imports this file directly over /__feedback/lib/.
// Keeping the constants in a module with NO Node imports is what lets the
// overlay share them instead of keeping a hand-copied mirror that can drift.

export const SCHEMA_VERSION = 7;
export const FILE_VERSION = 1;

// ---------- review rounds ----------
// A review happens in rounds: the person comments, the agent applies, the person
// looks again. Each comment records the round that was current when it was made,
// so FEEDBACK.md and the panel can show "what I asked this time" apart from what
// came before. Comments written before rounds existed carry no `round` at all —
// readers treat those as round 1, which is what `coerceRound` returns for
// anything missing or malformed.
export const DEFAULT_ROUND = 1;
const ROUND_MAX = 1_000_000;
export function coerceRound(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= ROUND_MAX ? n : DEFAULT_ROUND;
}

// A comment made through a share link records who left it as a SHA-256 of the
// browser's own random author token — never the token itself, and never sent
// back out. It is what lets that same browser edit or delete its own comment
// while it is still open. 64 lowercase hex characters, or absent.
export const AUTHOR_HASH_RE = /^[0-9a-f]{64}$/;

// Comment types decide how much latitude the agent gets. Web pages and Markdown
// documents use different verbs; `question` is UNIVERSAL — valid in either mode
// ("Ask the page": the agent answers, doesn't edit). The union (deduped) is what
// the file may legally contain.
export const WEB_TYPES = ['fix', 'change', 'improve'];
export const MD_TYPES = ['comment', 'rephrase', 'expand', 'delete', 'question'];
export const UNIVERSAL_TYPES = ['question'];
export const ALLOWED_TYPES = [...new Set([...WEB_TYPES, ...MD_TYPES, ...UNIVERSAL_TYPES])];
export const STATUSES = ['open', 'approved', 'rejected', 'resolved'];
export const AUTONOMY = ['auto', 'review'];

// Tweak Mode (web only): properties a comment's `edits[]` may carry. The overlay
// exposes a subset as live knobs; the whitelist is slightly wider so agents can
// author edits too. Values are opaque CSS values ("16px", "#0f766e", "16px 24px") —
// they are DATA for the processing agent, never re-injected as live CSS by us.
export const TWEAKABLE_PROPS = [
  'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'color', 'background-color', 'padding', 'margin', 'border-radius', 'opacity', 'gap',
];
