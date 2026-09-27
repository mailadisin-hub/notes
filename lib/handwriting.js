/**
 * Reading handwriting, so a handwritten page can be searched.
 *
 * A page of writing is a list of strokes with no idea of words or lines in it.
 * Handing all of them to a recogniser at once gives a poor result, because it
 * has no reason to think the top of the page and the bottom are separate
 * thoughts. So the strokes are grouped into lines here first - which is
 * arithmetic, and testable - and each line is recognised on its own.
 *
 * The recogniser itself is Android's, on the device, through `InkPlugin.kt`.
 * There is no web equivalent worth having, so elsewhere this reports that it is
 * unavailable and the rest of the app carries on without it.
 *
 * What comes back is kept, because recognising a page takes seconds and the
 * strokes rarely change. The kept text is what search reads.
 */

import { boxOf } from './ink.js';

const DB_NAME = 'notes.inktext';
const STORE = 'text';
let dbPromise = null;

/* Two strokes belong to the same line when their middles are within this much
   of each other, measured against how tall the writing is. Generous enough for
   a dotted i and a comma, tight enough to keep two lines apart. */
const SAME_LINE = 0.72;

/* ------------------------------------------------------------- grouping */

/**
 * Strokes grouped into lines of writing, each line ordered left to right.
 *
 * Returns [[stroke, ...], ...], top line first. Strokes with no points, and
 * anything so wide it is plainly a rule or an underline rather than writing,
 * are left out.
 */
export function groupIntoLines(strokes) {
  const items = [];
  for (const stroke of strokes) {
    if (!stroke || !stroke.pts || stroke.pts.length < 3) continue;
    const [x0, y0, x1, y1] = boxOf(stroke);
    items.push({ stroke, x0, y0, x1, y1, mid: (y0 + y1) / 2, height: Math.max(1, y1 - y0) });
  }
  if (!items.length) return [];

  /* The height of ordinary writing on this page: the middle of the range, so
     one enormous title does not decide it for everything else. */
  const heights = items.map((i) => i.height).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || 1;

  items.sort((a, b) => a.mid - b.mid || a.x0 - b.x0);

  const lines = [];
  let current = null;
  for (const item of items) {
    if (!current) {
      current = { items: [item], mid: item.mid };
      lines.push(current);
      continue;
    }
    const apart = Math.abs(item.mid - current.mid);
    if (apart <= typical * SAME_LINE) {
      current.items.push(item);
      /* The line's middle follows its strokes, so a line that drifts downwards
         across the page stays one line. */
      current.mid = current.items.reduce((sum, i) => sum + i.mid, 0) / current.items.length;
    } else {
      current = { items: [item], mid: item.mid };
      lines.push(current);
    }
  }

  return lines.map((line) => line.items.sort((a, b) => a.x0 - b.x0).map((i) => i.stroke));
}

/** One line of strokes as the plain points a recogniser wants. */
export function lineToPoints(strokes) {
  return strokes.map((stroke) => {
    const points = [];
    for (let i = 0; i < stroke.pts.length; i += 3) {
      points.push({ x: Math.round(stroke.pts[i] * 10) / 10, y: Math.round(stroke.pts[i + 1] * 10) / 10 });
    }
    return points;
  });
}

/* --------------------------------------------------------- kept results */

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) return resolve(null);
      db.onversionchange = () => { db.close(); dbPromise = null; };
      return resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function act(mode, work) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const out = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }).catch(() => null);
}

/** What was read from a page last time, or null. */
export async function readingOf(noteId) {
  return act('readonly', (os) => ({ __req: os.get(noteId) }));
}

export async function forgetReading(noteId) {
  await act('readwrite', (os) => os.delete(noteId));
}

/** Every page that has been read, for search. */
export async function allReadings() {
  const keys = await act('readonly', (os) => ({ __req: os.getAllKeys() }));
  const values = await act('readonly', (os) => ({ __req: os.getAll() }));
  const out = new Map();
  (keys || []).forEach((k, i) => out.set(k, (values || [])[i]));
  return out;
}

/* ------------------------------------------------------------ the reader */

const core = () => (window.__TAURI__ && window.__TAURI__.core) || null;
const invoke = (command, args) => core().invoke(command, args);

/** Whether this device can read handwriting at all. */
export const canRead = () => !!core();

/** Whether the language model has been downloaded yet. */
export async function modelReady(language = 'en') {
  if (!canRead()) return false;
  try {
    const out = await invoke('ink_ready', { language });
    return !!(out && out.ready);
  } catch {
    return false;
  }
}

/** Fetches the language model, over wifi. About twenty megabytes, once. */
export async function prepareModel(language = 'en') {
  if (!canRead()) throw new Error('Handwriting can only be read on Android');
  return invoke('ink_prepare', { language });
}

/**
 * Reads a page and keeps what it says.
 *
 * [onProgress] is called with (line, total) as it goes, because a full page is
 * several seconds of work and silence for that long reads as broken.
 *
 * Returns { text, lines, at } or null when the device cannot do it.
 */
export async function readPage(noteId, strokes, { onProgress, language = 'en' } = {}) {
  if (!canRead()) return null;
  const lines = groupIntoLines(strokes);
  if (!lines.length) {
    await act('readwrite', (os) => os.put({ text: '', lines: 0, at: Date.now(), strokes: 0 }, noteId));
    return { text: '', lines: 0, at: Date.now() };
  }

  const said = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (onProgress) onProgress(i + 1, lines.length);
    try {
      const text = await invoke('ink_recognise', { strokes: lineToPoints(lines[i]), language });
      if (text && text.trim()) said.push(text.trim());
    } catch (err) {
      /* One line failing is not the page failing - a scribble in the margin
         may simply not be words. */
      if (String(err).includes('model')) throw err;
    }
  }

  const reading = { text: said.join('\n'), lines: lines.length, at: Date.now(), strokes: strokes.length };
  await act('readwrite', (os) => os.put(reading, noteId));
  return reading;
}

/** True when the page has changed since it was last read. */
export function needsReading(reading, strokes) {
  if (!reading) return true;
  return reading.strokes !== strokes.length;
}
