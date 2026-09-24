/**
 * Photos and sketches live in IndexedDB, never in the note markup.
 *
 * localStorage holds the notes and caps out somewhere near 5MB in Android
 * WebView. A single phone photo as a data URL is bigger than that on its own,
 * so an attachment is stored as a Blob under an id and the note only ever
 * carries `<img class="att" data-att="ID">`. Object URLs are minted when a note
 * is opened and revoked when it closes, which also keeps the attachments
 * browser cheap - it reads the store directly rather than parsing every note.
 */

const DB_NAME = 'notes.attachments';
const DB_VERSION = 1;
const STORE = 'files';

/* Phone cameras produce 4000px JPEGs. Nothing in a phone-width note needs more
   than this, and the difference is ~6MB versus ~250KB per photo. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** Scales an image blob down and re-encodes it as JPEG. */
export async function compressImage(fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  return { blob: blob || fileOrBlob, width: w, height: h };
}

/** Stores a blob and returns its id. `meta.kind` is 'photo' or 'sketch'. */
export async function putAttachment(blob, meta = {}) {
  const record = {
    id: uid(),
    blob,
    type: blob.type || 'image/jpeg',
    kind: meta.kind || 'photo',
    noteId: meta.noteId || null,
    width: meta.width || 0,
    height: meta.height || 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await tx('readwrite', (store) => store.put(record));
  return record.id;
}

/** Stores a record that came from sync, keeping its original id and stamps. */
export async function putRawAttachment(record) {
  await tx('readwrite', (store) => store.put(record));
  return record.id;
}

export async function getAttachment(id) {
  return tx('readonly', (store) => {
    const req = store.get(id);
    return { __req: req };
  });
}

export async function listAttachments() {
  const all = await tx('readonly', (store) => {
    const req = store.getAll();
    return { __req: req };
  });
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteAttachment(id) {
  return tx('readwrite', (store) => store.delete(id));
}

/* Object URLs are process-wide; without this map a note opened five times
   leaks five URLs for the same photo. */
const urlCache = new Map();

export async function attachmentUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const record = await getAttachment(id);
  if (!record || !record.blob) return null;
  const url = URL.createObjectURL(record.blob);
  urlCache.set(id, url);
  return url;
}

export function releaseAttachmentUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** Fills in the src of every `<img data-att>` inside a container. */
export async function hydrateAttachments(root) {
  const imgs = [...root.querySelectorAll('img[data-att]')];
  await Promise.all(imgs.map(async (img) => {
    if (img.getAttribute('src')) return;
    const url = await attachmentUrl(img.dataset.att);
    if (url) img.setAttribute('src', url);
    else img.replaceWith(missingPlaceholder());
  }));
}

function missingPlaceholder() {
  const span = document.createElement('span');
  span.className = 'att-missing';
  span.textContent = 'Attachment unavailable';
  span.setAttribute('contenteditable', 'false');
  return span;
}

/** Object URLs must not reach storage - they are dead on the next launch. */
export function stripAttachmentUrls(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.querySelectorAll('img[data-att]').forEach((img) => img.removeAttribute('src'));
  holder.querySelectorAll('.att-missing').forEach((n) => n.remove());
  return holder.innerHTML;
}

/**
 * Ids still referenced by any note, used to sweep orphans after deletions.
 * [keep] holds ids used somewhere other than note markup - pictures placed
 * on handwritten pages.
 */
export async function pruneOrphans(allHtml, keep = new Set()) {
  const live = new Set(keep);
  const holder = document.createElement('div');
  for (const html of allHtml) {
    holder.innerHTML = html || '';
    holder.querySelectorAll('img[data-att]').forEach((img) => live.add(img.dataset.att));
  }
  const records = await listAttachments();
  const dead = records.filter((r) => !live.has(r.id));
  await Promise.all(dead.map((r) => deleteAttachment(r.id)));
  return dead.length;
}
