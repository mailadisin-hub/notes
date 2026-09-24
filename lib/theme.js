/**
 * Theme and text scale. Both are written onto the root element rather than
 * passed around, because every screen is rebuilt from scratch on return and a
 * root attribute survives that without any screen having to remember it.
 */

import { store } from './store.js';

export function applyTheme() {
  const t = store.settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);

  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#000000' : '#ffffff');
}

export function applyTextScale() {
  const scale = Number(store.settings.textScale) || 1;
  document.documentElement.style.setProperty('--text-scale', String(scale));
}

export function watchSystemTheme() {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}
