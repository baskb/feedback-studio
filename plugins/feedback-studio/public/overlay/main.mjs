// Feedback Studio — overlay client, entry point.
// Mounted on every page via the local feedback server. Lets you attach
// comments (typed or spoken) to any element or text selection, persists them
// server-side, and renders pins + a cross-page review panel.
//
// This file is served AS /__feedback/overlay.js, with the server's config lines
// (window.__kbfShots / __kbfRole / __kbfLabel) prefixed onto it. That is why it
// has no static imports: a static import is hoisted and evaluated BEFORE any
// statement of this file, config lines included, so the modules would read the
// role and the mode before they were set. The dynamic import below runs after
// them. Everything else lives in boot.mjs and the modules under overlay/.

// A module that fails to load does so silently — say so in the console instead.
window.addEventListener('error', (e) => {
  if (e.filename && e.filename.includes('/__feedback/')) console.error('Feedback Studio failed to load', e.filename, e.message);
}, { once: true });

if (window.__kbfMounted) {
  // already mounted on this page
} else {
  window.__kbfMounted = true;
  // Share role (injected by the server under --share): 'full' when absent.
  // 'none' = no valid key, mount nothing.
  if ((window.__kbfRole || 'full') !== 'none') {
    import('/__feedback/overlay/boot.mjs')
      .then((m) => m.boot())
      .catch((e) => console.error('Feedback Studio failed to load', e));
  }
}
