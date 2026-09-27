/**
 * Boot. Loads state, applies the theme, mounts the navigation stack, and
 * seeds a welcome note on a genuinely first run so the app never opens as an
 * empty shell.
 */

import { store, load, save, relockAll } from './lib/store.js';
import * as sync from './lib/sync.js';
import { clearSessionKey } from './lib/crypto.js';
import { applyTheme, applyTextScale, watchSystemTheme } from './lib/theme.js';
import { setHapticsEnabled } from './lib/haptics.js';
import { mount, reset, push, openDetail, setSplitView } from './lib/router.js';
import { foldersScreen } from './views/folders.js';
import { showWhatsNew } from './views/whatsnew.js';
import { showWelcome, welcomeNote } from './views/welcome.js';

/* Reading the notes is the one thing that has to finish before anything is
   drawn; it comes from a database now, so the rest of the boot waits for it. */
await load();
applyTheme();
applyTextScale();
watchSystemTheme();
setHapticsEnabled(store.settings.haptics !== false);

setSplitView(store.settings.splitView === true);
mount(document.getElementById('stack'));
history.replaceState({ depth: 1 }, '');

const SEED_KEY = 'notes.seeded';
let seeded = true;
try {
  seeded = !!localStorage.getItem(SEED_KEY);
} catch {
  /* Storage blocked; skip seeding rather than seeding on every launch. */
}

/* A genuinely new library starts with one note, written to show what the app
   does rather than to describe it - the two colons that make a revision card
   are a thing you have to see once. */
if (!store.notes.length && !seeded) {
  try { localStorage.setItem(SEED_KEY, '1'); } catch { /* ignore */ }
  welcomeNote('default');
  save();
}

reset(foldersScreen());

/* A first run gets the four panels; every run after an update gets what is
   new. Never both at once - the panels already say all of it. */
const welcomed = showWelcome();

/* First launch after an update: say what is new, and offer to open it. A
   sideloaded app has no release notes anywhere else. */
if (!welcomed) showWhatsNew({
  onTry: (where) => {
    if (where === 'shared') {
      import('./views/shared.js').then((m) => push(m.sharedListScreen()));
    } else if (where === 'ink') {
      import('./views/inknote.js').then((m) => openDetail(m.inkNoteScreen(null, 'Notes', {})));
    } else if (where === 'search') {
      import('./views/search.js').then((m) => push(m.searchScreen('Folders')));
    } else if (where === 'revise') {
      import('./views/revise.js').then((m) => push(m.reviseScreen('Folders')));
    } else if (where === 'settings') {
      import('./views/settings.js').then((m) => push(m.settingsScreen()));
    }
  },
});

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
