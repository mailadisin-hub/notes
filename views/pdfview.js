/**
 * Reading a PDF, and writing on it.
 *
 * Pages are drawn by PDF.js into bitmaps at the current zoom and laid out in
 * the same ink view handwritten notes use, so the pen, the tools and the
 * gestures are identical. Ink never touches the PDF: it is stored per page
 * against the document's own fingerprint, which means the original file is
 * never changed, the ink can be cleared, and the same paper opened on the phone
 * and on the tablet shows the same working.
 */

import * as pdfjs from '../vendor/pdfjs/pdf.min.js';
import { el, actionSheet, toast, alert2 } from '../lib/ui.js';
import { pop } from '../lib/router.js';
import { store } from '../lib/store.js';
import { getPdfInk, putPdfInk } from '../lib/library.js';
import { inkView } from '../lib/inkview.js';
import { inkChrome } from './inkchrome.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
const FONTS = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href;

/* Bitmaps are rendered at one of these pixel scales, never in between, so
   zooming reuses a bitmap until it would look soft and then renders once. */
const STEPS = [0.75, 1, 1.5, 2, 3, 4, 6];
const MAX_PIXELS = 16e6;
const KEEP_AROUND = 3;

export function pdfScreen({ blob, title, backLabel }) {
  const screen = el('section', { class: 'screen ink-screen' });
  screen.dataset.pane = 'detail';
  const status = el('div', { class: 'pdf-status', text: 'Opening...' });
  const early = el('button', { class: 'pdf-early-back', text: backLabel || 'Back' });
  early.addEventListener('click', () => pop());
  const stage = el('div', { class: 'ink-stage' }, status, early);
  screen.append(stage);

  let view = null;
  let doc = null;
  let task = null;
  let fp = null;
  let pages = [];
  let chrome = null;
  let destroyed = false;
  const bitmaps = new Map();
  const dirtyPages = new Set();
  let queue = Promise.resolve();

  function syncHistory() {
    if (chrome) chrome.sync();
  }

  /* ------------------------------------------------------------ bitmaps */

  function stepFor(pixelScale, page) {
    let s = STEPS[STEPS.length - 1];
    for (const step of STEPS) {
      if (step >= pixelScale) { s = step; break; }
    }
    // Keep a single page bitmap under the canvas memory ceiling.
    while (s > STEPS[0] && page.width * page.height * s * s > MAX_PIXELS) {
      s = STEPS[STEPS.indexOf(s) - 1];
    }
    return s;
  }

  function requestRender(i, scale) {
    const entry = bitmaps.get(i) || {};
    if (entry.pending === scale || entry.scale === scale) return;
    entry.pending = scale;
    bitmaps.set(i, entry);
    queue = queue.then(async () => {
      if (destroyed || entry.pending !== scale) return;
      try {
        const page = await doc.getPage(i + 1);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
        if (destroyed) return;
        const old = entry.canvas;
        entry.canvas = canvas;
        entry.scale = scale;
        entry.pending = null;
        if (old) old.width = 0;
        view.redraw();
      } catch {
        entry.pending = null;
      }
      evict();
    });
  }

  /* Only pages near the screen keep a bitmap; a 60-page paper at 3x would
     otherwise hold a gigabyte of pixels. */
  function evict() {
    if (!view) return;
    const visible = view.visiblePages();
    if (!visible.length) return;
    const lo = visible[0] - KEEP_AROUND;
    const hi = visible[visible.length - 1] + KEEP_AROUND;
    for (const [i, entry] of bitmaps) {
      if ((i < lo || i > hi) && entry.canvas) {
        entry.canvas.width = 0;
        bitmaps.delete(i);
      }
    }
  }

  function background(ctx, page, i, pixelScale) {
    const entry = bitmaps.get(i);
    const want = stepFor(pixelScale, page);
    if (!entry || !entry.canvas) {
      requestRender(i, want);
      return false;
    }
    ctx.drawImage(entry.canvas, 0, 0, page.width, page.height);
    if (entry.scale < want) requestRender(i, want);
    return true;
  }

  /* ---------------------------------------------------------------- ink */

  let saveTimer = null;

  function flushInk() {
    clearTimeout(saveTimer);
    const todo = [...dirtyPages];
    dirtyPages.clear();
    return Promise.all(todo.map((i) => putPdfInk(fp, i, pages[i].strokes)));
  }

  /* --------------------------------------------------------------- open */

  (async () => {
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      task = pdfjs.getDocument({ data, standardFontDataUrl: FONTS, isEvalSupported: false });
      doc = await task.promise;
      if (destroyed) return;
      fp = (doc.fingerprints && doc.fingerprints[0]) || `size-${blob.size}`;
      const ink = await getPdfInk(fp);
      pages = [];
      for (let i = 0; i < doc.numPages; i += 1) {
        const page = await doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        pages.push({ key: i, width: vp.width, height: vp.height, pdf: true, strokes: ink.get(i) || [] });
      }
      if (destroyed) return;

      view = inkView({
        pages,
        gap: 16,
        sidePad: 12,
        topPad: 72,
        bottomPad: 120,
        // The theme sets the desk; PDF pages are always white (see inkview).
        dark: () => {
          const t = document.documentElement.getAttribute('data-theme');
          return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        },
        background,
        fingerDraws: () => !!store.settings.fingerDraws,
        onChange: (_page, i) => {
          dirtyPages.add(i);
          clearTimeout(saveTimer);
          saveTimer = setTimeout(flushInk, 700);
        },
        onHistory: syncHistory,
        onView: (v) => chrome && chrome.setView(v),
      });
      chrome = inkChrome(view, {
        titleEl: el('span', { class: 'pill-name', text: title }),
        onBack: () => pop(),
        onMenu: openMenu,
        pages: true,
        lightPage: true,
      });
      status.remove();
      early.remove();
      stage.append(view.el, chrome.el);
      view.layout();
      syncHistory();
    } catch (err) {
      status.textContent = 'This PDF could not be opened.';
      status.classList.add('error');
    }
  })();

  /* -------------------------------------------------------------- menus */

  function openMenu() {
    actionSheet(null, [
      pages.length > 1 ? { label: 'Go to Page...', icon: 'arrows', onPick: goToPage } : null,
      {
        label: store.settings.fingerDraws ? 'Finger Scrolls' : 'Finger Draws',
        icon: 'markup',
        sub: 'Only when no stylus has been used',
        onPick: () => {
          store.settings.fingerDraws = !store.settings.fingerDraws;
          toast(store.settings.fingerDraws ? 'Your finger draws until a stylus is used' : 'Your finger scrolls');
        },
      },
      pages.some((p) => p.strokes.length) ? {
        label: 'Clear All Ink',
        icon: 'eraser',
        destructive: true,
        onPick: () => alert2('Clear all ink on this PDF?', 'The PDF itself is not changed.', [
          { label: 'Cancel' },
          {
            label: 'Clear',
            destructive: true,
            onPick: () => {
              pages.forEach((p, i) => { if (p.strokes.length) { p.strokes = []; dirtyPages.add(i); } });
              flushInk();
              view.redraw();
            },
          },
        ]),
      } : null,
    ]);
  }

  function goToPage() {
    alert2('Go to page', `1 to ${pages.length}`, [
      { label: 'Cancel' },
      {
        label: 'Go',
        strong: true,
        onPick: (value) => {
          const n = parseInt(value, 10);
          if (n >= 1 && n <= pages.length) view.scrollToPage(n - 1);
          return true;
        },
      },
    ], { input: '', inputType: 'number', placeholder: 'Page' });
  }

  screen.onShow = () => view && view.layout();
  screen.onReturn = () => view && view.layout();
  screen.onLeave = () => {
    destroyed = true;
    if (fp && dirtyPages.size) flushInk();
    if (view) view.destroy();
    if (chrome) chrome.destroy();
    for (const entry of bitmaps.values()) if (entry.canvas) entry.canvas.width = 0;
    bitmaps.clear();
    // The loading task owns the worker-side document; destroying it frees both.
    if (task) task.destroy();
  };

  return screen;
}
