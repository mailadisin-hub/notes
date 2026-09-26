/**
 * Shared pages: one handwritten page that several people write on at once.
 * Each stroke reaches everyone else's screen the moment its pen lifts.
 *
 * This is Firebase's Realtime Database, reached over its REST API with no SDK
 * - the same trade sync.js makes for Firestore. Changes arrive over a
 * Server-Sent Events stream (EventSource), so they are pushed, not polled.
 * Writes are plain fetches. Firestore's REST API cannot push at all, which is
 * why shared pages live in a second database in the same Firebase project,
 * behind the same accounts.
 *
 * A board, in the database:
 *   boards/{id}/meta            title, background, owner
 *   boards/{id}/invite          the secret an invite link carries
 *   boards/{id}/members/{uid}   who can read and write it
 *   boards/{id}/strokes/{sid}   one stroke each, encoded as lib/ink.js does
 *   boards/{id}/images/{iid}    pictures: where they sit, and the JPEG
 *   boards/{id}/presence/{uid}  who has it open right now
 *   userBoards/{uid}/{id}       each person's own list of their boards
 *
 * database.rules.json, beside the app, holds the rules that make all of that
 * members-only. Without them published, every call here is refused.
 */

import * as sync from './sync.js';
import { store } from './store.js';

/* The Firebase console names the database after the project and the region
   picked when it was created. Europe first - the region to choose - then the
   others, so a different choice in the console still works. */
const CANDIDATES = [
  'https://adi-study-default-rtdb.europe-west1.firebasedatabase.app',
  'https://adi-study-default-rtdb.firebaseio.com',
  'https://adi-study-default-rtdb.asia-southeast1.firebasedatabase.app',
];

/** Where invite links point: the web version, which anyone can open. */
export const JOIN_BASE = 'https://mailadisin-hub.github.io/notes/';

const DB_KEY = 'notes.sharedDb';
const LIST_KEY = 'notes.shared';
const SERVER_TIME = { '.sv': 'timestamp' };

export class SharedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* Ids and invite secrets from a 32-letter alphabet with no 0/o or 1/l, so a
   code read aloud or retyped still works. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomId(length = 20) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % 32]).join('');
}

/* ------------------------------------------------------------ the database */

let dbUrl = null;

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full; only a cache */ }
}

/**
 * Finds the database. Locked rules answer an unauthenticated read with
 * "Permission denied" - which proves it exists - while a name with no
 * database behind it answers differently or not at all.
 */
async function findDatabase() {
  if (dbUrl) return dbUrl;
  const known = readLocal(DB_KEY);
  if (known) {
    dbUrl = known;
    return dbUrl;
  }
  for (const url of CANDIDATES) {
    try {
      const res = await fetch(`${url}/.json?shallow=true`);
      const body = await res.json().catch(() => ({}));
      if (res.ok || /permission denied/i.test(String(body.error || ''))) {
        dbUrl = url;
        writeLocal(DB_KEY, url);
        return url;
      }
    } catch {
      // Unreachable - not this one, or not online.
    }
  }
  throw new SharedError(0, navigator.onLine === false
    ? 'You are offline'
    : 'Shared pages are not set up yet: the Realtime Database has not been created');
}

async function request(method, path, body) {
  const base = await findDatabase();
  const token = await sync.idToken();
  let res;
  try {
    res = await fetch(`${base}/${path}.json?auth=${encodeURIComponent(token)}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SharedError(0, 'You are offline');
  }
  if (!res.ok) {
    let message = '';
    try { message = (await res.json()).error || ''; } catch { /* not JSON */ }
    throw new SharedError(res.status, message || `The server said ${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------- who */

export function signedIn() {
  return !!sync.account();
}

/** The name other people see on a shared page. */
export function myName() {
  const named = String(store.settings.displayName || '').trim();
  if (named) return named.slice(0, 40);
  const email = (sync.account() && sync.account().email) || '';
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim() || 'Someone';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/* ------------------------------------------------------------ the list */

/** The boards last seen, for showing something before the network answers. */
export function cachedBoards() {
  const list = readLocal(LIST_KEY);
  return Array.isArray(list) ? list : [];
}

function cacheBoards(list) {
  writeLocal(LIST_KEY, list.map(({ id, title, mine, members }) => ({ id, title, mine, members })));
}

function uncache(id) {
  cacheBoards(cachedBoards().filter((b) => b.id !== id));
}

/** Every board this account belongs to, newest first. */
export async function listBoards() {
  const me = sync.account();
  if (!me) return [];
  const index = (await request('GET', `userBoards/${me.uid}`)) || {};
  const rows = await Promise.all(Object.entries(index).map(async ([id, entry]) => {
    try {
      const [meta, members] = await Promise.all([
        request('GET', `boards/${id}/meta`),
        request('GET', `boards/${id}/members`),
      ]);
      if (!meta) return null;
      return {
        id,
        title: meta.title || '',
        mine: meta.owner === me.uid,
        members: Object.entries(members || {}).map(([uid, m]) => ({ uid, name: (m && m.name) || 'Someone' })),
        joinedAt: (entry && entry.joinedAt) || 0,
      };
    } catch (err) {
      // Refused: removed from it, or it was deleted. Tidy the list.
      if (err.status === 401 || err.status === 403) {
        request('DELETE', `userBoards/${me.uid}/${id}`).catch(() => {});
        return null;
      }
      throw err;
    }
  }));
  const boards = rows.filter(Boolean).sort((a, b) => b.joinedAt - a.joinedAt);
  cacheBoards(boards);
  return boards;
}

/** Starts a new shared page with this account as its owner. */
export async function createBoard(title = '') {
  const me = sync.account();
  const id = randomId(20);
  await request('PUT', `boards/${id}`, {
    meta: { title, paper: 'plain', owner: me.uid, createdAt: SERVER_TIME },
    invite: randomId(12),
    members: { [me.uid]: { name: myName(), joinedAt: SERVER_TIME } },
  });
  await request('PUT', `userBoards/${me.uid}/${id}`, { joinedAt: SERVER_TIME });
  cacheBoards([{ id, title, mine: true, members: [{ uid: me.uid, name: myName() }] }, ...cachedBoards()]);
  return id;
}

/** A board id and invite secret, from an invite link or a pasted code. */
export function parseInvite(text) {
  const m = /([a-km-np-z2-9]{20})[.\-_ ]+([a-km-np-z2-9]{12})/i.exec(String(text || ''));
  return m ? { id: m[1].toLowerCase(), code: m[2].toLowerCase() } : null;
}

export function inviteLink(id, code) {
  return `${JOIN_BASE}#join=${id}.${code}`;
}

/** Joins from an invite; resolves to the board id. */
export async function joinBoard(text) {
  const invite = parseInvite(text);
  if (!invite) throw new SharedError(400, 'That is not an invite link');
  const me = sync.account();
  try {
    await request('PUT', `boards/${invite.id}/members/${me.uid}`, {
      name: myName(),
      code: invite.code,
      joinedAt: SERVER_TIME,
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new SharedError(err.status, 'That invite does not work - the page may have been deleted');
    }
    throw err;
  }
  await request('PUT', `userBoards/${me.uid}/${invite.id}`, { joinedAt: SERVER_TIME });
  return invite.id;
}

export async function leaveBoard(id) {
  const me = sync.account();
  await request('DELETE', `boards/${id}/presence/${me.uid}`).catch(() => {});
  await request('DELETE', `boards/${id}/members/${me.uid}`);
  await request('DELETE', `userBoards/${me.uid}/${id}`);
  uncache(id);
}

/** Deletes the page for everyone. Only its owner can. */
export async function deleteBoard(id) {
  const me = sync.account();
  await request('DELETE', `boards/${id}`);
  await request('DELETE', `userBoards/${me.uid}/${id}`).catch(() => {});
  uncache(id);
}

/* ------------------------------------------------------------ live pages */

/**
 * Adds multi-path updates to a pending set. Firebase refuses an update that
 * names both a path and one of its ancestors, so a path replaces whatever is
 * pending beneath it, and folds into whatever is pending above it.
 */
export function mergeInto(pending, updates) {
  for (const [key, value] of Object.entries(updates)) {
    for (const k of Object.keys(pending)) if (k.startsWith(`${key}/`)) delete pending[k];
    const parent = Object.keys(pending).find((k) => key.startsWith(`${k}/`));
    if (!parent) {
      pending[key] = value;
      continue;
    }
    // Beneath something being deleted, a change has nothing left to change.
    if (!pending[parent] || typeof pending[parent] !== 'object') continue;
    const rest = key.slice(parent.length + 1).split('/');
    let node = pending[parent];
    for (let i = 0; i < rest.length - 1; i += 1) {
      if (!node[rest[i]] || typeof node[rest[i]] !== 'object') node[rest[i]] = {};
      node = node[rest[i]];
    }
    const last = rest[rest.length - 1];
    if (value === null) delete node[last];
    else node[last] = value;
  }
  return pending;
}

/** Applies a stream event to the local copy of a board. */
function applyAt(root, path, data) {
  const keys = path.split('/').filter(Boolean);
  if (!keys.length) return data;
  let node = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (data === null) delete node[last];
  else node[last] = data;
  return root;
}

/**
 * Opens a board and keeps it live. [on] hears about:
 *   ready(board)       the whole board - on connecting, and again after any
 *                      reconnect, so the caller can reconcile what it holds
 *   change(sections)   later changes; sections says which parts: a Set of
 *                      'strokes', 'images', 'meta', 'members', 'presence',
 *                      'live'
 *   status(online, error)   error says why, when it is known
 *   gone()             access lost: removed from the board, or it was deleted
 *
 * Returns { board, write(updates), live(updates), close() }. live() is for
 * what is being written this second - see it below. write() takes paths relative to
 * the board ({ 'strokes/abc': {...}, 'images/xyz': null }), sends them as one
 * atomic update, and keeps them for another try if the network drops.
 */
export function openBoard(id, on) {
  let es = null;
  let closed = false;
  let retryMs = 1000;
  let retryTimer = 0;
  let online = false;
  let pending = {};
  let inFlight = false;
  const session = { board: null, write, live, close };

  const setOnline = (value) => {
    if (online === value) return;
    online = value;
    if (on.status) on.status(value);
  };

  async function open() {
    if (closed) return;
    let url;
    try {
      const base = await findDatabase();
      const token = await sync.idToken();
      url = `${base}/boards/${id}.json?auth=${encodeURIComponent(token)}`;
    } catch (err) {
      if (on.status) on.status(false, err);
      reconnect();
      return;
    }
    if (closed) return;
    es = new EventSource(url);
    es.addEventListener('put', (e) => receive(e.data, false));
    es.addEventListener('patch', (e) => receive(e.data, true));
    // Refused: this account is no longer a member, or the board is gone.
    es.addEventListener('cancel', () => {
      shutdown();
      if (on.gone) on.gone();
    });
    // The token in the URL expired; a new connection carries a fresh one.
    es.addEventListener('auth_revoked', () => reconnect(0));
    es.onerror = () => {
      setOnline(false);
      reconnect();
    };
  }

  function receive(raw, patch) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    retryMs = 1000;
    const path = msg.path || '/';
    if (!patch && path === '/') {
      if (msg.data === null) {
        shutdown();
        if (on.gone) on.gone();
        return;
      }
      session.board = msg.data;
      setOnline(true);
      if (on.ready) on.ready(session.board);
      flush();
      return;
    }
    if (!session.board) return;
    const sections = new Set();
    if (patch) {
      // Each key of a patch is its own path under the event's path.
      for (const [key, value] of Object.entries(msg.data || {})) {
        const full = `${path.replace(/\/$/, '')}/${key}`;
        session.board = applyAt(session.board, full, value);
        sections.add(full.split('/').filter(Boolean)[0]);
      }
    } else {
      session.board = applyAt(session.board, path, msg.data);
      sections.add(path.split('/').filter(Boolean)[0]);
    }
    if (on.change) on.change(sections);
  }

  function reconnect(delay = retryMs) {
    if (es) {
      es.close();
      es = null;
    }
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
    retryMs = Math.min(30000, retryMs * 2);
  }

  function shutdown() {
    closed = true;
    clearTimeout(retryTimer);
    if (es) es.close();
    es = null;
    setOnline(false);
  }

  function write(updates) {
    mergeInto(pending, updates);
    flush();
  }

  /**
   * A separate channel for what someone is writing this second. It never joins
   * the retry queue - half a stroke is worth nothing a minute later - and a
   * refusal must not take the page down the way an ordinary write does, so it
   * answers false instead and lets the caller give up on it.
   */
  async function live(updates) {
    if (closed) return false;
    try {
      await request('PATCH', `boards/${id}`, updates);
      return true;
    } catch (err) {
      return !(err.status === 401 || err.status === 403);
    }
  }

  async function flush() {
    if (inFlight || closed || !Object.keys(pending).length) return;
    const batch = pending;
    pending = {};
    inFlight = true;
    try {
      await request('PATCH', `boards/${id}`, batch);
    } catch (err) {
      if (err.status === 0) {
        // Offline: keep the batch under anything newer, and try again when
        // the stream is back (ready() calls flush) or in a little while.
        const newer = pending;
        pending = {};
        mergeInto(pending, batch);
        mergeInto(pending, newer);
        setTimeout(flush, 5000);
      } else if (err.status === 401 || err.status === 403) {
        if (on.gone) on.gone();
      } else if (on.error) {
        on.error(err);
      }
    } finally {
      inFlight = false;
    }
    if (Object.keys(pending).length) flush();
  }

  function close() {
    const lastWrite = pending;
    pending = {};
    shutdown();
    // Whatever was still waiting goes out anyway; nobody is left to retry it.
    if (Object.keys(lastWrite).length) request('PATCH', `boards/${id}`, lastWrite).catch(() => {});
  }

  open();
  return session;
}

/**
 * Tells everyone else on the board that this account has it open, every half
 * minute until stopped. Returns stop().
 */
export function announce(boardId) {
  const me = sync.account();
  const path = `boards/${boardId}/presence/${me.uid}`;
  const beat = () => request('PUT', path, { name: myName(), at: SERVER_TIME }).catch(() => {});
  beat();
  const timer = setInterval(beat, 30000);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') request('DELETE', path).catch(() => {});
    else beat();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    request('DELETE', path).catch(() => {});
  };
}
