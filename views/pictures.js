/**
 * Putting a picture on a page you write on: take one or choose one, then drop
 * it in the middle of what is on screen, sized to sit comfortably inside it.
 * Handwritten notes and shared pages both use this; each keeps the pixels its
 * own way.
 */

import { el, actionSheet, toast } from '../lib/ui.js';
import { compressImage } from '../lib/attachments.js';

function openPicker(camera, onPicked) {
  const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  if (camera) input.setAttribute('capture', 'environment');
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      await onPicked(await compressImage(file));
    } catch {
      toast('Could not add that picture');
    }
  });
  input.click();
}

/**
 * Asks camera or library, then hands over the picture already scaled down and
 * re-encoded as JPEG: onPicked({ blob, width, height }).
 */
export function pickPicture(onPicked) {
  actionSheet('Add a Picture', [
    { label: 'Take Photo', icon: 'camera', onPick: () => openPicker(true, onPicked) },
    { label: 'Choose Photo', icon: 'photo', onPick: () => openPicker(false, onPicked) },
  ]);
}

/**
 * Places [image] - anything with an id - in the middle of the screen at a
 * sensible size, and selects it so it can be moved straight away.
 */
export function placePicture(view, image, width, height) {
  const centre = view.viewCentre();
  /* A board is tens of thousands of units across; a page is eight hundred.
     Using the page's own width is what stops a picture added to a board
     landing in the far corner of it rather than where you are looking. */
  const pageWidth = centre.pageWidth || 800;
  const w = Math.max(48, Math.min(width, pageWidth * 0.8, centre.width * 0.72));
  const h = w * (height / width);
  view.addImage(centre.i, Object.assign(image, {
    x: Math.round(Math.max(0, Math.min(pageWidth - w, centre.x - w / 2))),
    y: Math.round(Math.max(0, centre.y - h / 2)),
    w: Math.round(w),
    h: Math.round(h),
  }));
}

/* How wide a rendered page is, in pixels. Enough to read at a comfortable zoom
   without making a file too big to share. */
const PAGE_PIXELS = 1400;
/* The gap left between pages laid down the board, in page units. */
const PAGE_GAP = 40;
/* As many pages as go on a board before it stops being a board. */
const MAX_PAGES = 60;

/**
 * Asks for a PDF and hands back its pages as pictures, one at a time.
 *
 * onPage({ blob, width, height, number, total }) is called for each, so a long
 * document appears as it is read rather than after it.
 */
export function pickPdf(onPage, { onProgress, onDone, onFail, maxPages = MAX_PAGES } = {}) {
  const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const pdfjs = await import('../vendor/pdfjs/pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      const data = new Uint8Array(await file.arrayBuffer());
      /* Without somewhere to fetch the standard fonts from, drawing a page
         that uses one - Helvetica, Times - waits for a font that never
         arrives, and the import hangs on page one. */
      const doc = await pdfjs.getDocument({
        data,
        isEvalSupported: false,
        standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
      }).promise;

      /* A textbook would be hundreds of pages and hundreds of pictures. The
         first stretch of it is almost always what was meant, and the rest can
         be added again from wherever it was left. */
      const upTo = Math.min(doc.numPages, maxPages);
      for (let n = 1; n <= upTo; n += 1) {
        if (onProgress) onProgress(n, doc.numPages);
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: PAGE_PIXELS / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        /* PDFs are drawn on white. Without this the page comes out with a
           transparent background, which is black on a dark board. */
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        /* This version of the reader wants the canvas itself as well as its
           context; given only the context it waits for ever. */
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        page.cleanup();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
        await onPage({ blob, width: canvas.width, height: canvas.height, number: n, total: upTo, name: file.name });
      }
      if (onDone) onDone(upTo, file.name, doc.numPages);
    } catch (err) {
      if (onFail) onFail(err);
      else toast(String((err && err.message) || err));
    }
  });
  input.click();
}

/**
 * Where the nth page of a document goes: a column down the board, starting
 * where you were looking, each page the same width as the one before.
 *
 * Returns the placement, which is what view.addImage wants.
 */
export function pdfPagePlacement(view, page, first) {
  const centre = view.viewCentre();
  const pageWidth = centre.pageWidth || 800;
  const start = first || {
    w: Math.max(200, Math.min(pageWidth * 0.86, centre.width * 0.8)),
    x: null,
    y: null,
  };
  const w = start.w;
  const h = w * (page.height / page.width);
  const x = start.x === null ? Math.round(Math.max(0, Math.min(pageWidth - w, centre.x - w / 2))) : start.x;
  const y = start.y === null ? Math.round(Math.max(0, centre.y - h / 2)) : start.y;
  return { x, y: Math.round(y), w: Math.round(w), h: Math.round(h), next: Math.round(y + h + PAGE_GAP) };
}

/** Draws the page as a PNG and hands it to the share sheet, or saves it. */
export async function sharePage(view, title) {
  await view.whenImagesReady();
  const canvas = view.renderPage(0, 2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const name = `${String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Page'}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      // Dismissed is fine; anything else falls back to saving the file.
      if (err && err.name === 'AbortError') return;
    }
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * A handwritten page as a PDF - the form work is handed in as, and the one
 * every device can open without being asked to trust a picture.
 */
export async function pagePdf(view, title) {
  await view.whenImagesReady();
  const canvas = view.renderPage(0, 2);
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const { imagePdf } = await import('../lib/pdf.js');
  const blob = imagePdf([{ bytes, width: canvas.width, height: canvas.height }]);
  saveBlob(blob, `${safeName(title)}.pdf`);
}

/** The name a saved file gets, with the characters a filesystem objects to gone. */
export function safeName(title) {
  return String(title || '').replace(/[\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Note';
}

/** Hands a file to the browser to save. */
export function saveBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
