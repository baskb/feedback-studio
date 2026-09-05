// Feedback Studio — which page the overlay is on, and what to do when a
// single-page app changes it without a page load.
//
// A site built with client-side routing swaps its content and calls
// history.pushState instead of loading a new page. The overlay used to read the
// path once at load, so after such a move it kept drawing the previous page's
// pins and filed new comments under the previous path. This module holds the
// two pure decisions involved, so they can be tested in Node: how a path is
// normalised into a page key, and what has to be reset when the key changes.
// The browser wiring (wrapping pushState, listening to popstate) lives in
// public/overlay/boot.mjs.

// '/x', '/x/' and '/x/index.html' serve the same content, so they collapse to
// one key: pins made on one form still render when the page is visited via
// another.
export function normalizePath(p) {
  p = String(p || '');
  p = p.replace(/index\.html$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

// Decide what a route change means for the overlay's state.
//   prevPage      the page key the overlay currently believes it is on
//   nextPathname  location.pathname after the navigation
//   ctx.expandedPage  page key of the comment whose thread is open in the List, or ''
//   ctx.composerKind  'new' | 'edit' | '' — what the composer is doing, if open
// Returns { changed, page, dropExpanded, closeComposer }:
//   changed        false when the key is the same (a hash change, a query
//                  change, or a pushState to the same path): nothing to do.
//   dropExpanded   the open thread belonged to the page we left, so close it.
//   closeComposer  a NEW comment in progress was aimed at an element of the page
//                  we left; an edit of an existing comment keeps its target and
//                  survives (its card can still be found in the List).
export function routeChange(prevPage, nextPathname, ctx = {}) {
  const page = normalizePath(nextPathname);
  const prev = normalizePath(prevPage);
  if (page === prev) return { changed: false, page: prev, dropExpanded: false, closeComposer: false };
  const expandedPage = ctx.expandedPage ? normalizePath(ctx.expandedPage) : '';
  return {
    changed: true,
    page,
    dropExpanded: !!expandedPage && expandedPage !== page,
    closeComposer: ctx.composerKind === 'new',
  };
}
