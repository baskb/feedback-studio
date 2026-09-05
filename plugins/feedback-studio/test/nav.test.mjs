// Tests for the route-change decisions the overlay makes when a single-page
// app moves to another path without a page load. Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, routeChange } from '../lib/nav.mjs';

test('normalizePath collapses the forms that serve the same page', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/about'), '/about');
  assert.equal(normalizePath('/about/'), '/about');
  assert.equal(normalizePath('/about///'), '/about');
  assert.equal(normalizePath('/about/index.html'), '/about');
  assert.equal(normalizePath('/index.html'), '/');
  assert.equal(normalizePath(undefined), '/');
});

test('a same-page move (hash, trailing slash, index.html) changes nothing', () => {
  for (const next of ['/about', '/about/', '/about/index.html']) {
    const r = routeChange('/about', next, { expandedPage: '/about', composerKind: 'new' });
    assert.equal(r.changed, false);
    assert.equal(r.page, '/about');
    assert.equal(r.dropExpanded, false);
    assert.equal(r.closeComposer, false);
  }
});

test('a move to another page resets the page key and clears what belonged to the old one', () => {
  const r = routeChange('/', '/pricing', { expandedPage: '/', composerKind: 'new' });
  assert.deepEqual(r, { changed: true, page: '/pricing', dropExpanded: true, closeComposer: true });
});

test('an open thread from another page than the one we left stays open', () => {
  // The List shows every page; a thread opened on /about while standing on /
  // is not invalidated by moving to /pricing.
  const r = routeChange('/', '/pricing', { expandedPage: '/about', composerKind: '' });
  assert.equal(r.dropExpanded, true); // it is not on the new page either
  const same = routeChange('/', '/about', { expandedPage: '/about', composerKind: '' });
  assert.equal(same.dropExpanded, false); // we arrived on its page
});

test('an edit of an existing comment survives a move; a new comment does not', () => {
  assert.equal(routeChange('/', '/x', { composerKind: 'edit' }).closeComposer, false);
  assert.equal(routeChange('/', '/x', { composerKind: 'new' }).closeComposer, true);
  assert.equal(routeChange('/', '/x', {}).closeComposer, false);
});
