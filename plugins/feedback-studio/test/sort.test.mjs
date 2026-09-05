// Tests for the List's sort orders and the search box. Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lastTouch, sortComments, comparator, matchesQuery, attentionRank, defaultDir, isSortKey, SORT_KEYS,
} from '../lib/sort.mjs';

const T = (h) => `2026-09-05T${String(h).padStart(2, '0')}:00:00.000Z`;
const mk = (id, over = {}) => ({
  id, page: '/', type: 'change', status: 'open', author: 'user', text: 'text ' + id,
  anchor: { tag: 'p', snippet: 'snippet ' + id }, thread: [], createdAt: T(1), updatedAt: T(1), ...over,
});
const ids = (l) => l.map((c) => c.id).join(',');

test('lastTouch is the newest of created, updated and any reply', () => {
  assert.equal(lastTouch(mk('a')), T(1));
  assert.equal(lastTouch(mk('a', { updatedAt: T(5) })), T(5));
  assert.equal(lastTouch(mk('a', { updatedAt: T(5), thread: [{ createdAt: T(9) }] })), T(9));
  assert.equal(lastTouch(mk('a', { createdAt: T(7), updatedAt: T(3) })), T(7));
});

test('every sort key has a starting direction and unknown keys fall back', () => {
  for (const s of SORT_KEYS) { assert.ok(isSortKey(s.key)); assert.ok(['asc', 'desc'].includes(defaultDir(s.key))); }
  assert.equal(isSortKey('bogus'), false);
  assert.equal(defaultDir('bogus'), 'desc');
  const l = [mk('a', { createdAt: T(1) }), mk('b', { createdAt: T(2) })];
  assert.equal(ids(sortComments(l, { key: 'bogus', dir: 'desc' })), 'b,a'); // treated as activity
});

test('activity and created, both directions', () => {
  const l = [
    mk('old', { createdAt: T(1), updatedAt: T(1) }),
    mk('replied', { createdAt: T(2), updatedAt: T(2), thread: [{ createdAt: T(9) }] }),
    mk('new', { createdAt: T(5), updatedAt: T(5) }),
  ];
  assert.equal(ids(sortComments(l, { key: 'activity', dir: 'desc' })), 'replied,new,old');
  assert.equal(ids(sortComments(l, { key: 'activity', dir: 'asc' })), 'old,new,replied');
  assert.equal(ids(sortComments(l, { key: 'created', dir: 'desc' })), 'new,replied,old');
  assert.equal(ids(sortComments(l, { key: 'created', dir: 'asc' })), 'old,replied,new');
});

test('position follows the page; comments with no position go last, ordered by creation', () => {
  const l = [mk('c', { createdAt: T(3) }), mk('a', { createdAt: T(1) }), mk('b', { createdAt: T(2) }), mk('elsewhere', { createdAt: T(0) })];
  const positionOf = (c) => ({ a: 10, b: 20, c: 5 }[c.id] ?? null);
  assert.equal(ids(sortComments(l, { key: 'position', dir: 'asc' }, { positionOf })), 'c,a,b,elsewhere');
  assert.equal(ids(sortComments(l, { key: 'position', dir: 'desc' }, { positionOf })), 'elsewhere,b,a,c');
});

test('status groups open, approved, rejected, resolved; ties show the latest activity first', () => {
  const l = [
    mk('res', { status: 'resolved', updatedAt: T(9) }),
    mk('open1', { status: 'open', updatedAt: T(2) }),
    mk('rej', { status: 'rejected', updatedAt: T(8) }),
    mk('appr', { status: 'approved', updatedAt: T(4) }),
    mk('open2', { status: 'open', updatedAt: T(6) }),
  ];
  assert.equal(ids(sortComments(l, { key: 'status', dir: 'asc' })), 'open2,open1,appr,rej,res');
  assert.equal(ids(sortComments(l, { key: 'status', dir: 'desc' })), 'res,rej,appr,open2,open1');
});

test('type is alphabetical and replies counts the thread', () => {
  const l = [mk('i', { type: 'improve' }), mk('f', { type: 'fix' }), mk('c', { type: 'change' })];
  assert.equal(ids(sortComments(l, { key: 'type', dir: 'asc' })), 'c,f,i');
  const r = [mk('none'), mk('two', { thread: [{}, {}] }), mk('one', { thread: [{}] })];
  assert.equal(ids(sortComments(r, { key: 'replies', dir: 'desc' })), 'two,one,none');
  assert.equal(ids(sortComments(r, { key: 'replies', dir: 'asc' })), 'none,one,two');
});

test('attention puts what blocks a person first, resolved work last', () => {
  const pinConf = (c) => ({ lost: 'lost', shaky: 'medium' }[c.id]);
  const l = [
    mk('resolved', { status: 'resolved' }),
    mk('plain'),
    mk('answered', { thread: [{ author: 'agent', text: 'done' }] }),
    mk('question', { type: 'question' }),
    mk('proposal', { author: 'agent' }),
    mk('shaky'),
    mk('lost'),
    mk('approved', { status: 'approved' }),
    mk('rejected', { status: 'rejected' }),
  ];
  assert.equal(ids(sortComments(l, { key: 'attention', dir: 'asc' }, { pinConf })),
    'lost,shaky,proposal,question,plain,approved,answered,rejected,resolved');
  // A resolved comment with a lost pin is not a problem: the element usually changed on purpose.
  assert.equal(attentionRank(mk('lost', { status: 'resolved' }), { pinConf }), 8);
});

test('the comparator never mutates and sortComments returns a copy', () => {
  const l = [mk('b', { createdAt: T(2) }), mk('a', { createdAt: T(1) })];
  const out = sortComments(l, { key: 'created', dir: 'asc' });
  assert.equal(ids(l), 'b,a');
  assert.equal(ids(out), 'a,b');
  assert.equal(typeof comparator(), 'function');
});

test('search matches every word, case-insensitively, across text, anchor, author, page, replies and id', () => {
  const c = mk('c_abc123', {
    text: 'Make the Button bigger', authorName: 'Eva', page: '/pricing', type: 'improve',
    anchor: { tag: 'button', snippet: 'Start free trial' },
    thread: [{ author: 'agent', authorName: 'Claude', text: 'Applied a larger padding' }],
    textEdit: { before: 'old words', after: 'new words' },
  });
  assert.equal(matchesQuery(c, ''), true);
  assert.equal(matchesQuery(c, '   '), true);
  assert.equal(matchesQuery(c, 'button'), true);
  assert.equal(matchesQuery(c, 'BUTTON bigger'), true);
  assert.equal(matchesQuery(c, 'trial'), true);           // anchor snippet
  assert.equal(matchesQuery(c, 'eva'), true);             // author name
  assert.equal(matchesQuery(c, 'pricing'), true);         // page
  assert.equal(matchesQuery(c, 'improve'), true);         // type
  assert.equal(matchesQuery(c, 'padding claude'), true);  // reply text and reply author
  assert.equal(matchesQuery(c, 'new words'), true);       // retyped wording
  assert.equal(matchesQuery(c, 'c_abc123'), true);        // id
  assert.equal(matchesQuery(c, 'button footer'), false);  // one word missing
  assert.equal(matchesQuery(mk('x', { anchor: null, thread: null }), 'text'), true); // tolerant of missing fields
});
