/**
 * Boot. Loads state, applies the theme, mounts the navigation stack, and
 * seeds a welcome note on a genuinely first run so the app never opens as an
 * empty shell.
 */

import { store, load, save, newNote, relockAll } from './lib/store.js';
import * as sync from './lib/sync.js';
import { clearSessionKey } from './lib/crypto.js';
import { applyTheme, applyTextScale, watchSystemTheme } from './lib/theme.js';
import { setHapticsEnabled } from './lib/haptics.js';
import { mount, reset } from './lib/router.js';
import { foldersScreen } from './views/folders.js';

load();
applyTheme();
applyTextScale();
watchSystemTheme();
setHapticsEnabled(store.settings.haptics !== false);

mount(document.getElementById('stack'));
history.replaceState({ depth: 1 }, '');

const SEED_KEY = 'notes.seeded';
let seeded = true;
try {
  seeded = !!localStorage.getItem(SEED_KEY);
} catch {
  /* Storage blocked; skip seeding rather than seeding on every launch. */
}

if (!store.notes.length && !seeded) {
  try { localStorage.setItem(SEED_KEY, '1'); } catch { /* ignore */ }
  const note = newNote('default');
  note.html = [
    '<h1>Welcome</h1>',
    '<div><br></div>',
    '<div>Swipe a note left to lock, move or delete it. Swipe right to pin.</div>',
    '<div>Press and hold a note for the full menu.</div>',
    '<div><br></div>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">Tap a circle to tick it off</span></div>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">Aa sets Title, Heading, bold and highlight</span></div>',
    '<div><br></div>',
    '<div>Type a hashtag - like #ideas - and it turns into a tag on the Folders screen.</div>',
  ].join('');
  note.updatedAt = Date.now();
  save();
}

reset(foldersScreen());

/* An invite link to a shared page opens the web app at #join=<board>.<code> -
   fresh, or in a tab that already had the app open. The hash is cleared at
   once so a reload does not ask again. */
function openInvite() {
  const invite = /^#join=(.+)$/.exec(location.hash);
  if (!invite) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  import('./views/shared.js').then((m) => m.joinFromLink(decodeURIComponent(invite[1])));
}
openInvite();
window.addEventListener('hashchange', openInvite);

/* Leaving the app re-locks every note and drops the encryption key from
   memory, the way iOS does. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    relockAll();
    clearSessionKey();
  }
});

/* Sync runs in the background; the app stays fully usable offline and the
   local store is always the source of truth for what is on screen. */
if (sync.restore()) sync.startAutoSync();

/* The service worker is for the web build only. Inside Tauri the assets are
   already local, and a second cache layer would only serve stale ones. */
if (!window.__TAURI__ && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
}

/* In a browser - Safari above all - site data can be cleared to free space.
   Asking for persistent storage keeps notes and handwriting that have not
   synced yet. The answer does not matter: a no leaves things as they were. */
if (!window.__TAURI__ && navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

/* Chrome would otherwise hand pasted rich text straight into a note. */
document.addEventListener('paste', (e) => {
  if (!e.target.closest || !e.target.closest('.editor-content')) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

/* A dropped file or a stray link would navigate the whole WebView away. */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
