// Feedback Studio — the overlay's own light / dark theme.
//
// Light is the default. `data-kbf-theme` is ALWAYS set (light or dark) so a forced light
// theme overrides an OS dark preference — the prefers-color-scheme:dark rules are scoped to
// :not([data-kbf-theme="light"]), so they only ever apply if the attribute were absent.

import { S, LS } from '/__feedback/overlay/state.mjs';
import { $, I, host } from '/__feedback/overlay/ui.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

const THEME_CYCLE = { light: 'dark', dark: 'light' };
const THEME_ICON = { light: I.sun, dark: I.moon };

function applyTheme(mode) {
  S.theme = mode === 'dark' ? 'dark' : 'light';
  host.setAttribute('data-kbf-theme', S.theme);
  LS.set('kbf-theme', S.theme);
  const themeBtn = $('kbf-theme-toggle');
  themeBtn.innerHTML = THEME_ICON[S.theme];
  const label = t('Theme: {mode}', { mode: S.theme === 'dark' ? t('dark') : t('light') });
  themeBtn.title = t('{label} — click to switch', { label });
  themeBtn.setAttribute('aria-label', label);
}

export function initTheme() {
  $('kbf-theme-toggle').addEventListener('click', () => applyTheme(THEME_CYCLE[S.theme]));
  applyTheme(S.theme);
}
