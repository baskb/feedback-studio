// Feedback Studio — the overlay's own light / dark theme.
//
// Light is the default. `data-kbf-theme` is ALWAYS set (light or dark) so a forced light
// theme overrides an OS dark preference — the prefers-color-scheme:dark rules are scoped to
// :not([data-kbf-theme="light"]), so they only ever apply if the attribute were absent.

import { S, LS } from '/__feedback/overlay/state.mjs';
import { $, I, host } from '/__feedback/overlay/ui.mjs';

const THEME_CYCLE = { light: 'dark', dark: 'light' };
const THEME_ICON = { light: I.sun, dark: I.moon };

function applyTheme(t) {
  S.theme = t === 'dark' ? 'dark' : 'light';
  host.setAttribute('data-kbf-theme', S.theme);
  LS.set('kbf-theme', S.theme);
  const themeBtn = $('kbf-theme-toggle');
  themeBtn.innerHTML = THEME_ICON[S.theme];
  const label = 'Theme: ' + S.theme;
  themeBtn.title = label + ' — click to switch';
  themeBtn.setAttribute('aria-label', label);
}

export function initTheme() {
  $('kbf-theme-toggle').addEventListener('click', () => applyTheme(THEME_CYCLE[S.theme]));
  applyTheme(S.theme);
}
