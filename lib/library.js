/**
 * The heavy things: handwritten pages, ink written on PDFs, and imported files.
 *
 * All IndexedDB. The notes themselves live in one localStorage blob that caps
 * out near 5MB in an Android WebView (lib/store.js); a single past paper is
 * bigger than that, and a few dense handwritten pages would fill it. A note
 * only ever carries a reference into here.
 *
 *   ink     - one record per handwritten note: its strokes, paper style and
 *             pictures. A picture is only its place on the page; the photo
 *             itself is an attachment (lib/attachments.js), so it syncs and
 *             shows in the attachments browser like any other.
 *   pdfink  - one record per written-on PDF page, keyed by the PDF's own
 *             fingerprint rather than by file, so the same paper opened on the
 *             phone and on the tablet shows the same ink.
 *   files   - imported files as Blobs. These stay on the device they were
 *             added on: the free Firebase plan cannot hold them, and vault
 *             folders synced by Syncthing are the way to have a file on both.
 *   vaultfiles - the account's copy of each vault's Markdown and text files,
 *             so a device without the folder can still read them
 *             (lib/vault.js fills it, lib/sync.js syncs it).
 */

import { encodeStrokes, decodeStrokes } from './ink.js';

const DB_NAME = 'notes.library';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ink')) {
        db.createObjectStore('ink', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('pdfink')) {
        const os = db.createObjectStore('pdfink', { keyPath: 'id' });
        os.createIndex('fp', 'fp');
        os.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('vaultfiles')) {
        const os = db.createObjectStore('vaultfiles', { keyPath: 'id' });
        os.createIndex('vault', 'vault');
        os.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const os = t.objectStore(storeName);
    let result;
    const req = fn(os);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const now = () => Date.now();

/* ------------------------------------------------------------ handwriting */

/** A handwritten note's page, decoded. Never null: a new note is a blank page. */
export async function getInk(noteId) {
  const rec = await run('ink', 'readonly', (os) => os.get(noteId));
  return {
    strokes: decodeStrokes(rec && rec.strokes),
    paper: (rec && rec.paper) || 'plain',
    images: cleanImages(rec && rec.images),
    board: !!(rec && rec.board),
    updatedAt: (rec && rec.updatedAt) || 0,
  };
}

export async function putInk(noteId, { strokes, paper, images, board }, updatedAt = now()) {
  await run('ink', 'readwrite', (os) => os.put({
    id: noteId,
    strokes: encodeStrokes(strokes),
    paper: paper || 'plain',
    images: cleanImages(images),
    board: !!board,
    updatedAt,
  }));
  return updatedAt;
}

/** Pictures as stored: where each sits, and the attachment holding it. */
export function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  const round = (v) => Math.round(Number(v) * 10) / 10;
  return list
    .filter((im) => im && im.att && Number(im.w) > 0 && Number(im.h) > 0)
    .map((im) => ({ id: String(im.id || im.att), att: String(im.att), x: round(im.x), y: round(im.y), w: round(im.w), h: round(im.h) }));
}

/** Every attachment a handwritten page shows, so a clean-up keeps them. */
export async function inkImageAttachments() {
  const all = await run('ink', 'readonly', (os) => os.getAll());
  const ids = new Set();
  for (const rec of all || []) for (const im of cleanImages(rec.images)) ids.add(im.att);
  return ids;
}

/** Raw (still-encoded) records changed since [since], for sync. */
export async function inkChangedSince(since) {
  const all = await run('ink', 'readonly', (os) => os.getAll());
  return (all || []).filter((r) => (r.updatedAt || 0) > since);
}

export async function putRawInk(record) {
  await run('ink', 'readwrite', (os) => os.put(record));
}

export async function getRawInk(noteId) {
  return run('ink', 'readonly', (os) => os.get(noteId));
}

export async function deleteInk(noteId) {
  await run('ink', 'readwrite', (os) => os.delete(noteId));
}

/* --------------------------------------------------------------- PDF ink */

const pdfKey = (fp, page) => `${fp}:${page}`;

/** Every written-on page of one PDF, as a map of page index to strokes. */
export async function getPdfInk(fp) {
  const rows = await run('pdfink', 'readonly', (os) => os.index('fp').getAll(fp));
  const out = new Map();
  for (const r of rows || []) out.set(r.page, decodeStrokes(r.strokes));
  return out;
}

export async function putPdfInk(fp, page, strokes, updatedAt = now()) {
  await run('pdfink', 'readwrite', (os) => os.put({
    id: pdfKey(fp, page),
    fp,
    page,
    strokes: encodeStrokes(strokes),
    updatedAt,
  }));
}

export async function pdfInkChangedSince(since) {
  const all = await run('pdfink', 'readonly', (os) => os.getAll());
  return (all || []).filter((r) => (r.updatedAt || 0) > since);
}

export async function getRawPdfInk(id) {
  return run('pdfink', 'readonly', (os) => os.get(id));
}

export async function putRawPdfInk(record) {
  await run('pdfink', 'readwrite', (os) => os.put(record));
}

/* ------------------------------------------------------------ vault copies */

/** Every copied file of one vault, tombstones included. */
export async function getVaultFiles(vaultId) {
  return (await run('vaultfiles', 'readonly', (os) => os.index('vault').getAll(vaultId))) || [];
}

export async function getVaultFile(id) {
  return run('vaultfiles', 'readonly', (os) => os.get(id));
}

/** Writes many records in one transaction. */
export async function putVaultFiles(records) {
  if (!records.length) return;
  await run('vaultfiles', 'readwrite', (os) => {
    let last = null;
    for (const r of records) last = os.put(r);
    return last;
  });
}

export async function vaultFilesChangedSince(since) {
  return (await run('vaultfiles', 'readonly', (os) => os.index('updatedAt').getAll(IDBKeyRange.lowerBound(since, true)))) || [];
}

/* ------------------------------------------------------------------ files */

export async function putFile(id, file) {
  const record = {
    id,
    name: file.name || 'Untitled',
    type: file.type || guessType(file.name),
    size: file.size || 0,
    blob: file,
    createdAt: now(),
  };
  await run('files', 'readwrite', (os) => os.put(record));
  return record;
}

export async function getFile(id) {
  return run('files', 'readonly', (os) => os.get(id));
}

export async function deleteFile(id) {
  await run('files', 'readwrite', (os) => os.delete(id));
}

/* ------------------------------------------------------------------ types */

const EXT_TYPES = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const extOf = (name) => (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

export function guessType(name) {
  return EXT_TYPES[extOf(name)] || 'application/octet-stream';
}

/** What the app can do with a file: 'pdf', 'markdown', 'text', 'image' or 'other'. */
export function kindOf(name, type) {
  const ext = extOf(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'markdown';
  if (ext === 'txt' || String(type).startsWith('text/')) return 'text';
  if (String(type).startsWith('image/')) return 'image';
  return 'other';
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
