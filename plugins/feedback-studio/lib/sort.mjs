// Feedback Studio — how the List orders comments, and how the search box
// matches them.
//
// No DOM here. Anything that needs the page (the position of a pinned element,
// how well its anchor resolved) comes in through `ctx` callbacks, so the same
// rules run in the browser overlay and in the Node test suite.

// Newest activity on a comment: created, updated (reply / status / edit), or
// its newest reply. ISO strings compare correctly as text.
export function lastTouch(c) {
  let t = (c.updatedAt && c.updatedAt > (c.createdAt || '')) ? c.updatedAt : (c.createdAt || '');
  for (const r of (Array.isArray(c.thread) ? c.thread : [])) if (r.createdAt && r.createdAt > t) t = r.createdAt;
  return t;
}

// The sort keys the List offers, in menu order, with the direction each one
// starts in when picked. 'desc' puts the largest first (newest, most replies);
// 'asc' the smallest (first on the page, open before resolved).
export const SORT_KEYS = [
  { key: 'activity', dir: 'desc' },   // latest activity: created, edited, replied, status changed
  { key: 'created', dir: 'desc' },    // when the comment was made
  { key: 'position', dir: 'asc' },    // where the pinned element sits on the page, top to bottom
  { key: 'attention', dir: 'asc' },   // what needs a person first: lost pins, proposals to approve, unanswered questions
  { key: 'status', dir: 'asc' },      // open, approved, rejected, resolved
  { key: 'type', dir: 'asc' },        // fix / change / improve / question, or the Markdown verbs
  { key: 'replies', dir: 'desc' },    // most discussed
];
export const SORT_DEFAULT = { key: 'activity', dir: 'desc' };
export function defaultDir(key) {
  const k = SORT_KEYS.find((s) => s.key === key);
  return k ? k.dir : 'desc';
}
export function isSortKey(key) { return SORT_KEYS.some((s) => s.key === key); }

const STATUS_RANK = { open: 0, approved: 1, rejected: 2, resolved: 3 };
const isOpen = (c) => c.status !== 'resolved' && c.status !== 'rejected';
const agentReplied = (c) => (Array.isArray(c.thread) ? c.thread : []).some((r) => r.author === 'agent');

// Lower = needs a person sooner. A pin that cannot be found blocks the agent
// entirely; an agent proposal waits for approval; a question waits for an
// answer; a plain open comment is next; resolved work is last.
export function attentionRank(c, ctx = {}) {
  const conf = ctx.pinConf ? ctx.pinConf(c) : undefined;
  if (isOpen(c) && conf === 'lost') return 0;
  if (isOpen(c) && (conf === 'low' || conf === 'medium')) return 1;
  if (c.status === 'open' && c.author === 'agent') return 2;
  if (c.status === 'open' && c.type === 'question' && !agentReplied(c)) return 3;
  if (c.status === 'open' && !agentReplied(c)) return 4;
  if (c.status === 'approved') return 5;
  if (c.status === 'open') return 6;
  if (c.status === 'rejected') return 7;
  return 8;
}

const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function primary(key, ctx) {
  switch (key) {
    case 'created': return (a, b) => cmpText(a.createdAt || '', b.createdAt || '');
    case 'position': {
      const pos = (c) => { const p = ctx.positionOf ? ctx.positionOf(c) : null; return p == null ? Infinity : p; };
      return (a, b) => (pos(a) - pos(b)) || cmpText(a.createdAt || '', b.createdAt || '');
    }
    case 'status': return (a, b) => (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0);
    case 'type': return (a, b) => cmpText(String(a.type || ''), String(b.type || ''));
    case 'attention': return (a, b) => attentionRank(a, ctx) - attentionRank(b, ctx);
    case 'replies': return (a, b) => (Array.isArray(a.thread) ? a.thread.length : 0) - (Array.isArray(b.thread) ? b.thread.length : 0);
    case 'activity':
    default: return (a, b) => cmpText(lastTouch(a), lastTouch(b));
  }
}

// A comparator for the chosen key and direction. Ties always fall back to the
// latest activity first, whatever the direction, so a list sorted by status
// still shows the freshest open comment at the top of its block.
export function comparator(sort = SORT_DEFAULT, ctx = {}) {
  const key = isSortKey(sort && sort.key) ? sort.key : 'activity';
  const sign = (sort && sort.dir) === 'asc' ? 1 : -1;
  const first = primary(key, ctx);
  return (a, b) => (first(a, b) * sign) || cmpText(lastTouch(b), lastTouch(a));
}

// Sorts a COPY; the stored list keeps creation order because pin numbers come from it.
export function sortComments(list, sort, ctx) {
  return list.slice().sort(comparator(sort, ctx));
}

// ---------- search ----------
// Every word typed must appear somewhere on the comment: its text, the quoted
// anchor text, the retyped wording, who wrote it, the page, the type, the
// status, a reply, or the id. Case does not matter.
export function commentHaystack(c) {
  const parts = [
    c.text, c.anchor && (c.anchor.snippet || c.anchor.rangeText), c.anchor && c.anchor.tag,
    c.textEdit && c.textEdit.after, c.textEdit && c.textEdit.before,
    c.author, c.authorName, c.page, c.pageTitle, c.sourceFile, c.type, c.status, c.id,
    ...(Array.isArray(c.edits) ? c.edits.map((e) => e.prop + ' ' + e.to) : []),
    ...(Array.isArray(c.thread) ? c.thread.map((r) => (r.authorName || r.author || '') + ' ' + (r.text || '')) : []),
  ];
  return parts.filter((p) => p != null && p !== '').join('\n').toLowerCase();
}

export function matchesQuery(c, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = commentHaystack(c);
  return words.every((w) => hay.includes(w));
}
