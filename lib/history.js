/**
 * Earlier versions of a note.
 *
 * Undo only reaches back as far as the screen has been open. The thing people
 * actually lose is a paragraph deleted yesterday, or a note they rewrote and
 * wish they had not - and for that, undo is already gone. So a copy is kept
 * every so often while a note is being edited, and the last few weeks of those
 * copies stay around.
 *
 * Kept in its own database, apart from the notes themselves: history is the
 * one thing that must never make saving a note fail, so if it runs out of room
 * or cannot be opened, nothing else notices.
 */

const DB_NAME = 'notes.history';
const STORE = 'versions';
const DB_VERSION = 1;

/* A copy at most this often per note: a version every few seconds would be a
   record of keystrokes, not of drafts. */
const EVERY_MS = 4 * 60 * 1000;
/* How many to keep, and for how long. Enough to cover "what did I cut out of
   this last week", not enough to become a second library. */
const KEEP_PER_NOTE = 25;
const KEEP_DAYS = 45;

let dbPromise = null;
const lastKept = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('note', 'noteId');
        os.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        resolve(null);
        return;
      }
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run(mode, work) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const result = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }).catch(() => null);
}

/**
 * Keeps a copy of a note, if one is due.
 *
 * Called on every save, and quietly does nothing most of the time: the same
 * text twice over is not a version, and neither is a change four seconds after
 * the last one.
 */
export async function keepVersion(note, { force = false } = {}) {
  if (!note || note.locked) return false;      // a locked note's copy would be readable
  const html = String(note.html || '');
  if (!html.trim()) return false;

  const now = Date.now();
  const since = now - (lastKept.get(note.id) || 0);
  if (!force && since < EVERY_MS) return false;

  const latest = await newestVersion(note.id);
  if (latest && latest.html === html) {
    lastKept.set(note.id, now);
    return false;
  }

  lastKept.set(note.id, now);
  await run('readwrite', (os) => os.put({
    key: `${note.id}:${now}`,
    noteId: note.id,
    at: now,
    title: note.title || '',
    html,
    words: html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length,
  }));
  await prune(note.id);
  return true;
}

async function newestVersion(noteId) {
  const all = await versionsOf(noteId);
  return all[0] || null;
}

/** Every kept version of a note, newest first. */
export async function versionsOf(noteId) {
  const rows = await run('readonly', (os) => ({ __req: os.index('note').getAll(noteId) }));
  return (rows || []).sort((a, b) => b.at - a.at);
}

export async function versionAt(key) {
  return run('readonly', (os) => ({ __req: os.get(key) }));
}

/** Drops the oldest and the long-expired, so history cannot grow for ever. */
async function prune(noteId) {
  const rows = await versionsOf(noteId);
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const doomed = rows.filter((r, i) => i >= KEEP_PER_NOTE || r.at < cutoff);
  if (!doomed.length) return;
  await run('readwrite', (os) => {
    for (const r of doomed) os.delete(r.key);
  });
}

/** Everything kept for a note, for when the note itself is gone for good. */
export async function forgetNote(noteId) {
  const rows = await versionsOf(noteId);
  if (!rows.length) return;
  await run('readwrite', (os) => {
    for (const r of rows) os.delete(r.key);
  });
}

/** How much history there is, for the storage figures in Settings. */
export async function historySize() {
  const rows = await run('readonly', (os) => ({ __req: os.getAll() }));
  if (!rows) return { versions: 0, bytes: 0 };
  let bytes = 0;
  for (const r of rows) bytes += (r.html || '').length;
  return { versions: rows.length, bytes };
}
