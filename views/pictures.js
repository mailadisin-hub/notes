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
  const pageWidth = 800;
  const w = Math.max(48, Math.min(width, pageWidth * 0.8, centre.width * 0.72));
  const h = w * (height / width);
  view.addImage(centre.i, Object.assign(image, {
    x: Math.round(Math.max(0, Math.min(pageWidth - w, centre.x - w / 2))),
    y: Math.round(Math.max(0, centre.y - h / 2)),
    w: Math.round(w),
    h: Math.round(h),
  }));
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
