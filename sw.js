/**
 * Offline shell for the web build.
 *
 * Network-first, not cache-first. A cache-first shell with a fixed cache name
 * never updates: every request is answered from the cache, so a new deploy is
 * only picked up if the cache name happens to change, and `cache: 'no-store'`
 * on the page cannot get past a service worker. That left the web build
 * permanently stuck on whatever version loaded first.
 *
 * So: try the network, fall back to the cache when offline, and refresh the
 * cached copy on every success. The cost is one request per file on a fast
 * connection; the benefit is that shipping an update actually ships it.
 */

const CACHE = 'notes-v10';
/* The reader's fonts (KaTeX, PDF.js) are not listed: the fetch handler below
   caches them the first time a document needs them. */
const SHELL = [
  './', './index.html', './styles.css', './app.js',
  './boot-guard.js', './manifest.webmanifest',
  './fonts/Inter.woff2', './fonts/Inter-Italic.woff2',
  './lib/store.js', './lib/ui.js', './lib/router.js', './lib/theme.js',
  './lib/haptics.js', './lib/share.js', './lib/attachments.js',
  './lib/crypto.js', './lib/sync.js', './lib/ink.js', './lib/inkview.js',
  './lib/library.js', './lib/markdown.js', './lib/vault.js', './lib/shared.js',
  './views/folders.js', './views/list.js', './views/editor.js',
  './views/settings.js', './views/attachments.js', './views/markup.js',
  './views/lock.js', './views/inknote.js', './views/inkchrome.js',
  './views/pdfview.js', './views/mdview.js', './views/files.js', './views/vault.js',
  './views/shared.js', './views/account.js', './views/background.js', './views/pictures.js', './views/whatsnew.js', './lib/gestures.js',
  './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js',
  './vendor/marked.esm.js', './vendor/katex/katex.module.js', './vendor/katex/katex.min.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* One bad URL must not fail the whole install. */
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        /* Only cache real responses; an opaque or error response would poison
           the offline copy. */
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || Response.error())),
  );
});

/* Lets the page force an update without waiting for a tab close. */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
