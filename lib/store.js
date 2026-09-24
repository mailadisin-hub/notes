/**
 * All app state, and the only place that touches localStorage.
 *
 * Notes are kept as one JSON blob rather than a row per note: the whole set is
 * read on launch and rewritten on every mutation, which is fine at the scale a
 * phone notes app reaches and removes any chance of a half-written folder. The
 * expensive things - photos, sketches - are deliberately not in here; see
 * lib/attachments.js.
 */

import { deleteInk, deleteFile } from './library.js';

const STORE_KEY = 'notes.store.v1';
const TRASH_DAYS = 30;

export const ALL = '__all__';
export const TRASH = '__trash__';
export const TAG_PREFIX = 'tag:';
export const SMART_PREFIX = 'smart:';

export const defaultStore = () => ({
  version: 3,
  folders: [{ id: 'default', name: 'Notes', createdAt: Date.now() }],
  smartFolders: [],
  notes: [],
  /* Vault folders the account knows, synced; which folder each one is on a
     given device is kept per device (lib/vault.js). */
  vaults: [],
  settings: {
    theme: 'system',
    view: 'list',
    sort: 'edited',
    textScale: 1,
    haptics: true,
  },
  /* Account-level, synced. The salt must be shared or the same passcode would
     derive a different key on every device and nothing would decrypt. */
  lockSalt: null,
  lockVerifier: null,
  settingsUpdatedAt: 0,
});

export let store = defaultStore();

export function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    /* Private mode or blocked site data; run from defaults. */
  }
  try {
    store = raw ? { ...defaultStore(), ...JSON.parse(raw) } : defaultStore();
  } catch {
    store = defaultStore();
  }

  if (!Array.isArray(store.folders) || !store.folders.length) store.folders = defaultStore().folders;
  if (!Array.isArray(store.notes)) store.notes = [];
  if (!Array.isArray(store.smartFolders)) store.smartFolders = [];
  if (!Array.isArray(store.vaults)) store.vaults = [];
  store.settings = { ...defaultStore().settings, ...(store.settings || {}) };

  /* v1 notes predate locking and paper styles; v2 predates sync. */
  for (const note of store.notes) {
    if (note.locked === undefined) note.locked = false;
    if (note.paper === undefined) note.paper = 'plain';
    if (note.purged === undefined) note.purged = false;
    if (note.enc === undefined) note.enc = null;
  }
  if (store.settings && 'lockHash' in store.settings) {
    /* The old SHA-256 passcode hash is not a key and cannot become one.
       Dropping it turns the lock off rather than leaving a lock nothing can
       open; the notes themselves are untouched. */
    delete store.settings.lockHash;
    for (const note of store.notes) note.locked = false;
  }
  /* A brand-new note is a draft until something is written in it. The screen
     discards an empty one on the way out; a draft still here is one the app
     was closed on, so it goes the same way. */
  store.notes = store.notes.filter((n) => !n.draft);
  store.version = 3;

  purgeTrash();
  return store;
}

let saveError = false;

export function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    saveError = false;
    return true;
  } catch {
    saveError = true;
    return false;
  }
}

export const lastSaveFailed = () => saveError;

export function purgeTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  let changed = false;
  for (const note of store.notes) {
    if (note.purged || !note.deletedAt || note.deletedAt > cutoff) continue;
    purgeNote(note);
    changed = true;
  }
  /* Tombstones themselves are dropped long after every device has seen them. */
  const tombCutoff = Date.now() - 180 * 86400000;
  const before = store.notes.length;
  store.notes = store.notes.filter((n) => !n.purged || (n.updatedAt || 0) > tombCutoff);
  if (changed || store.notes.length !== before) save();
}

/**
 * A hard delete leaves a tombstone rather than removing the record. Without
 * one, the next pull from another device would happily restore the note it
 * still has, and deletions would never stick.
 */
export function purgeNote(note) {
  if (note.kind === 'ink') deleteInk(note.id).catch(() => {});
  if (note.fileId) deleteFile(note.fileId).catch(() => {});
  note.purged = true;
  note.html = '';
  note.enc = null;
  note.deletedAt = note.deletedAt || Date.now();
  note.updatedAt = Date.now();
}

export function purgeNoteById(id) {
  const note = store.notes.find((n) => n.id === id);
  if (note) { purgeNote(note); save(); }
}

/** Every note that still exists, tombstones excluded. */
export const allNotes = () => store.notes.filter((n) => !n.purged);

/** Marks account state as changed so the next sync pushes it. */
export function touchSettings() {
  store.settingsUpdatedAt = Date.now();
  save();
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------ note access */

export const firstRealFolder = () => (store.folders[0] ? store.folders[0].id : 'default');
export const noteById = (id) => store.notes.find((n) => n.id === id && !n.purged);
export const folderById = (id) => store.folders.find((f) => f.id === id);
export const smartById = (id) => store.smartFolders.find((f) => f.id === id);

export function newNote(folderId) {
  const now = Date.now();
  const target = isVirtual(folderId) ? firstRealFolder() : folderId;
  const note = {
    id: uid(),
    folderId: target,
    html: '',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    deletedAt: null,
    locked: false,
    paper: 'plain',
    enc: null,
    purged: false,
  };
  store.notes.unshift(note);
  save();
  return note;
}

export function reorderFolders(ids) {
  const byId = new Map(store.folders.map((f) => [f.id, f]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  /* Never drop a folder because the DOM and the store disagreed. */
  for (const f of store.folders) if (!next.includes(f)) next.push(f);
  store.folders = next;
  save();
}

export const isVirtual = (id) => id === ALL || id === TRASH
  || String(id).startsWith(TAG_PREFIX) || String(id).startsWith(SMART_PREFIX);

export function folderName(id) {
  if (id === ALL) return 'All Notes';
  if (id === TRASH) return 'Recently Deleted';
  if (String(id).startsWith(TAG_PREFIX)) return `#${String(id).slice(TAG_PREFIX.length)}`;
  if (String(id).startsWith(SMART_PREFIX)) {
    const smart = smartById(String(id).slice(SMART_PREFIX.length));
    return smart ? smart.name : 'Smart Folder';
  }
  const f = folderById(id);
  return f ? f.name : 'Notes';
}

export function notesIn(folderId) {
  const present = allNotes();
  if (folderId === TRASH) return present.filter((n) => n.deletedAt);
  const live = present.filter((n) => !n.deletedAt);
  if (folderId === ALL) return live;

  const key = String(folderId);
  if (key.startsWith(TAG_PREFIX)) {
    const tag = key.slice(TAG_PREFIX.length).toLowerCase();
    return live.filter((n) => tagsOf(n).includes(tag));
  }
  if (key.startsWith(SMART_PREFIX)) {
    const smart = smartById(key.slice(SMART_PREFIX.length));
    if (!smart || !smart.tags.length) return [];
    const wanted = smart.tags.map((t) => t.toLowerCase());
    return live.filter((n) => {
      const have = tagsOf(n);
      return smart.match === 'all'
        ? wanted.every((t) => have.includes(t))
        : wanted.some((t) => have.includes(t));
    });
  }
  return live.filter((n) => n.folderId === folderId);
}

/* ------------------------------------------------------- text extraction */

const scratch = document.createElement('div');

const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'TR', 'TABLE']);

/**
 * scratch is detached, so innerText collapses to textContent and loses every
 * line break. Block structure has to be walked by hand to get real lines.
 */
export function htmlToLines(html) {
  scratch.innerHTML = html || '';
  scratch.querySelectorAll('.box').forEach((b) => b.remove());

  const lines = [];
  let cur = '';
  const flush = () => { lines.push(cur.replace(/\u00a0/g, ' ').trim()); cur = ''; };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { cur += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      if (child.tagName === 'BR') { flush(); continue; }
      if (child.tagName === 'IMG') { cur += cur ? ' ' : ''; continue; }
      if (child.tagName === 'TD' || child.tagName === 'TH') { walk(child); cur += '  '; continue; }
      if (BLOCK_TAGS.has(child.tagName)) {
        if (cur) flush();
        walk(child);
        flush();
      } else {
        walk(child);
      }
    }
  };

  walk(scratch);
  if (cur) flush();
  return lines;
}

export const plainText = (html) => htmlToLines(html).join('\n');

/*
 * Three kinds of note share the list: typed (the default, no kind field),
 * handwritten ('ink', strokes in lib/library.js) and imported files ('file',
 * the blob in lib/library.js). Only typed notes have HTML to read a title from;
 * the others carry an explicit title.
 */
export const kindOfNote = (note) => note.kind || 'text';

export function titleOf(note) {
  if (kindOfNote(note) !== 'text') return (note.title || '').trim();
  for (const line of htmlToLines(note.html)) if (line) return line;
  return '';
}

export function snippetOf(note) {
  const kind = kindOfNote(note);
  if (kind === 'ink') return 'Handwritten';
  if (kind === 'file') return note.fileLabel || 'File';
  const lines = htmlToLines(note.html).filter(Boolean);
  return lines.slice(1).join(' ');
}

export function displayTitle(note) {
  const kind = kindOfNote(note);
  if (kind === 'ink') return titleOf(note) || 'Handwritten note';
  if (kind === 'file') return titleOf(note) || 'Untitled file';
  return titleOf(note) || 'New Note';
}

export function countsOf(note) {
  const text = plainText(note.html).trim();
  const words = text ? text.split(/\s+/).length : 0;
  return { words, characters: text.length };
}

export function attachmentCount(note) {
  scratch.innerHTML = note.html || '';
  return scratch.querySelectorAll('img[data-att]').length;
}

/* ------------------------------------------------------------------ tags */

/* Tags are written inline as #tag, the way iOS does it, so there is no
   separate tag field to drift out of sync with the text. */
const TAG_RE = /(^|[\s(\[])#([\p{L}\p{N}_-]{1,40})/gu;

export function tagsOf(note) {
  const text = plainText(note.html);
  const found = new Set();
  for (const m of text.matchAll(TAG_RE)) found.add(m[2].toLowerCase());
  return [...found];
}

export function allTags() {
  const counts = new Map();
  for (const note of allNotes()) {
    if (note.deletedAt) continue;
    for (const tag of tagsOf(note)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

/* ------------------------------------------------------------ date format */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const pad = (n) => String(n).padStart(2, '0');

export function shortStamp(ts) {
  const d = new Date(ts);
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (day === today - 86400000) return 'Yesterday';
  if (day > today - 7 * 86400000) return DAYS[d.getDay()];
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
}

export function longStamp(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sectionFor(ts) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Today';
  if (day === today - 86400000) return 'Yesterday';
  if (day > today - 7 * 86400000) return 'Previous 7 Days';
  if (day > today - 30 * 86400000) return 'Previous 30 Days';
  const d = new Date(ts);
  return d.getFullYear() === new Date().getFullYear() ? MONTHS[d.getMonth()] : String(d.getFullYear());
}

export function daysLeftInTrash(note) {
  const left = Math.ceil((note.deletedAt + TRASH_DAYS * 86400000 - Date.now()) / 86400000);
  return Math.max(0, left);
}

/* --------------------------------------------------------------- locking */

/**
 * The passcode is not stored in any form. It derives an AES key (lib/crypto.js)
 * and correctness is proved by decrypting a known verifier string, so the only
 * stored artefact is ciphertext the key already protects. A locked note's body
 * lives encrypted on disk and syncs as an opaque blob.
 */
export const hasPin = () => !!store.lockVerifier;

export const lockSalt = () => store.lockSalt;

export function setLockCredentials(salt, verifier) {
  store.lockSalt = salt;
  store.lockVerifier = verifier;
  touchSettings();
}

export function clearLockCredentials() {
  store.lockSalt = null;
  store.lockVerifier = null;
  touchSettings();
}

/* Unlocking is remembered for the session only, exactly like iOS: leaving the
   app re-locks everything. */
const unlocked = new Set();
export const isUnlocked = (id) => unlocked.has(id);
export const markUnlocked = (id) => unlocked.add(id);
export const relockAll = () => unlocked.clear();
