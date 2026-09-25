/**
 * Cross-device sync over the Firestore REST API.
 *
 * No Firebase SDK. The modular SDK is hundreds of kilobytes and this app needs
 * four calls: sign in, refresh, query changed docs, commit a batch. Talking to
 * the REST endpoints directly keeps the app a plain static bundle that runs
 * from a WebView, a desktop shell or GitHub Pages with no build step.
 *
 * Storage is Firestore only, deliberately. Cloud Storage for Firebase needs a
 * billing plan; attachments are written as base64 into their own documents,
 * which keeps the whole thing on the free tier.
 *
 * Merge policy is last-write-wins on updatedAt, per document. For one person
 * on several devices that is correct and needs no history. Two devices editing
 * the same note while both offline will keep the later edit, which is the
 * behaviour anyone would predict.
 *
 * Handwriting and the ink written on PDFs sync too, a document per page.
 * So do the list of vault folders and the copy of their Markdown notes, which
 * lets a device without the folder still read them. Imported files do not:
 * they stay on the device they were added on.
 */

import { store, save } from './store.js';
import { listAttachments, putRawAttachment, getAttachment } from './attachments.js';
import {
  inkChangedSince, getRawInk, putRawInk, deleteInk, cleanImages,
  pdfInkChangedSince, getRawPdfInk, putRawPdfInk,
  getVaultFile, putVaultFiles, vaultFilesChangedSince,
} from './library.js';

/* Public by design: this identifies the project, it does not authenticate.
   Security comes from the Firestore rules, which scope every document to the
   signed-in user's own uid. */
export const FIREBASE = {
  apiKey: 'AIzaSyD1KJipusL5U4XKlA0dagrv-3r7rIB0jIE',
  projectId: 'adi-study',
};

const AUTH_KEY = 'notes.auth';
const SYNC_KEY = 'notes.sync';
const PARTS_KEY = 'notes.syncParts';

const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;

/* Firestore rejects a single document over 1 MiB; base64 inflates by a third,
   so anything past this is left on the device it was made on. */
const MAX_ATTACHMENT_BYTES = 700 * 1024;

let auth = null;      // { idToken, refreshToken, uid, email, expiresAt }
let syncing = false;
const listeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(status()); } catch { /* a bad listener must not break sync */ }
  }
}

/* ------------------------------------------------------------------ state */

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked; sync degrades to this session only */ }
}

export function restore() {
  auth = readJson(AUTH_KEY);
  return !!auth;
}

export function status() {
  const meta = readJson(SYNC_KEY) || {};
  return {
    signedIn: !!auth,
    email: auth ? auth.email : null,
    syncing,
    lastSyncAt: meta.lastSyncAt || 0,
    lastError: meta.lastError || null,
  };
}

function setMeta(patch) {
  writeJson(SYNC_KEY, { ...(readJson(SYNC_KEY) || {}), ...patch });
}

/* ------------------------------------------------------------------- auth */

export async function signIn(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(friendlyAuthError(body));

  auth = {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    uid: body.localId,
    email: body.email,
    expiresAt: Date.now() + Number(body.expiresIn || 3600) * 1000,
  };
  writeJson(AUTH_KEY, auth);
  emit();
  return auth;
}

/**
 * Makes a new account - for someone joining a shared page who has never used
 * Koino - and signs straight into it.
 */
export async function signUp(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(friendlyAuthError(body));
  auth = {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    uid: body.localId,
    email: body.email,
    expiresAt: Date.now() + Number(body.expiresIn || 3600) * 1000,
  };
  writeJson(AUTH_KEY, auth);
  emit();
  return auth;
}

/**
 * Asks Firebase to email a reset link. When Firebase says no account uses the
 * address, that is said plainly: in a personal app, a silent "check your
 * email" for a message that will never come is the worse failure. (With the
 * project's email-enumeration protection on, Firebase never says, and the
 * link simply does not arrive for an unknown address.)
 */
export async function sendPasswordReset(email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body && body.error && body.error.message;
    if (code === 'EMAIL_NOT_FOUND') throw new Error('No account uses that email');
    throw new Error(friendlyAuthError(body) || 'Could not send the reset email');
  }
}

/** Sets a new password for the signed-in account. */
export async function changePassword(password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: await freshToken(), password, returnSecureToken: true }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(friendlyAuthError(body));
  // A password change retires the old tokens; carry on with the new ones.
  auth = {
    ...auth,
    idToken: body.idToken || auth.idToken,
    refreshToken: body.refreshToken || auth.refreshToken,
    expiresAt: body.expiresIn ? Date.now() + Number(body.expiresIn) * 1000 : auth.expiresAt,
  };
  writeJson(AUTH_KEY, auth);
  return true;
}

export function signOut() {
  auth = null;
  writeJson(AUTH_KEY, null);
  writeJson(PARTS_KEY, null);
  setMeta({ lastSyncAt: 0 });
  emit();
}

function friendlyAuthError(body) {
  const code = body && body.error && body.error.message;
  return {
    EMAIL_NOT_FOUND: 'No account with that email',
    INVALID_PASSWORD: 'Wrong password',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password',
    USER_DISABLED: 'That account is disabled',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts - try later',
    EMAIL_EXISTS: 'That email already has an account - sign in instead',
    INVALID_EMAIL: 'That is not an email address',
    OPERATION_NOT_ALLOWED: 'New accounts are switched off for this app',
    CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'Sign in again, then try that once more',
    TOKEN_EXPIRED: 'Sign in again, then try that once more',
  }[code] || (String(code || '').startsWith('WEAK_PASSWORD') ? 'Use a password of at least 6 characters' : '')
    || code || 'Could not sign in';
}

/** Tokens last an hour; refresh a minute early rather than on a failure. */
async function freshToken() {
  if (!auth) throw new Error('Not signed in');
  if (Date.now() < auth.expiresAt - 60000) return auth.idToken;

  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
  });
  const body = await res.json();
  if (!res.ok) {
    signOut();
    throw new Error('Session expired - sign in again');
  }
  auth = {
    ...auth,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
  };
  writeJson(AUTH_KEY, auth);
  return auth.idToken;
}

/** A token for the signed-in account, refreshed when it is about to lapse. */
export const idToken = () => freshToken();

/** The signed-in account's id and email, or null. */
export const account = () => (auth ? { uid: auth.uid, email: auth.email } : null);

/* -------------------------------------------------- Firestore value codec */

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  return { mapValue: { fields: encodeFields(value) } };
}

function encodeFields(object) {
  const fields = {};
  for (const [k, v] of Object.entries(object)) fields[k] = encodeValue(v);
  return fields;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

/* --------------------------------------------------------- Firestore calls */

async function firestore(path, options = {}) {
  const token = await freshToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403) {
      throw new Error('Firebase is refusing sync: the Notes rule is not in the Firestore rules yet');
    }
    throw new Error(`Firestore ${res.status}: ${text.slice(0, 180)}`);
  }
  return res.json();
}

/**
 * Documents in `collection` changed since `since`. With a pageSize the query
 * is fetched in pages - a vault's copy can be hundreds of documents - with
 * the document name as a tiebreak, so a page boundary between two documents
 * stamped in the same millisecond loses neither.
 */
async function queryChanged(collection, since, { pageSize = 0 } = {}) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'updatedAt' },
        op: 'GREATER_THAN',
        value: { integerValue: String(since) },
      },
    },
    orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' }],
  };
  if (pageSize) {
    structuredQuery.orderBy.push({ field: { fieldPath: '__name__' }, direction: 'ASCENDING' });
    structuredQuery.limit = pageSize;
  }
  const out = [];
  for (;;) {
    const rows = await firestore(`/users/${auth.uid}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    const docs = (rows || []).filter((r) => r.document).map((r) => r.document);
    for (const d of docs) out.push({ id: d.name.split('/').pop(), ...decodeFields(d.fields) });
    if (!pageSize || docs.length < pageSize) break;
    const last = docs[docs.length - 1];
    structuredQuery.startAt = {
      values: [last.fields.updatedAt, { referenceValue: last.name }],
      before: false,
    };
  }
  return out;
}

/** Firestore caps a commit at 500 writes, so batches are chunked. */
async function commit(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const slice = writes.slice(i, i + 400);
    await firestore(':commit', {
      method: 'POST',
      body: JSON.stringify({ writes: slice }),
    });
  }
}

const docName = (collection, id) =>
  `projects/${FIREBASE.projectId}/databases/(default)/documents/users/${auth.uid}/${collection}/${id}`;

const docWrite = (collection, id, data) => ({
  update: { name: docName(collection, id), fields: encodeFields(data) },
});

/* ------------------------------------------------------------------- sync */

/**
 * One full pass: pull what changed remotely, then push what changed locally.
 * Pull happens first so a remote edit that is newer wins before we decide what
 * still needs pushing.
 */
/* Asked for while one is running (a vault copy refreshed mid-sync): run once
   more straight after, rather than leave the change for the next timer. */
let again = false;

export async function syncNow({ quiet = false } = {}) {
  if (!auth) return status();
  if (syncing) {
    again = true;
    return status();
  }
  syncing = true;
  if (!quiet) emit();

  const meta = readJson(SYNC_KEY) || {};
  const since = meta.lastSyncAt || 0;
  /* Stamped before the pull so an edit made mid-sync is not skipped next time. */
  const startedAt = Date.now();

  try {
    await pullSettings(since);
    const pulled = await pullNotes(since);
    await pullAttachments(since);
    const pulledInk = await pullInk(since);
    const pulledPdfInk = await pullPdfInk(since);
    const pulledVaults = await pullVaults(since);
    const pulledVaultFiles = await pullVaultFiles(since);

    await pushSettings(since);
    await pushNotes(since, pulled);
    await pushAttachments(since);
    await pushInk(since, pulledInk);
    await pushPdfInk(since, pulledPdfInk);
    await pushVaults(since, pulledVaults);
    await pushVaultFiles(since, pulledVaultFiles);

    setMeta({ lastSyncAt: startedAt, lastError: null });
  } catch (err) {
    setMeta({ lastError: String(err.message || err) });
    syncing = false;
    emit();
    throw err;
  }

  syncing = false;
  emit();
  if (again) {
    again = false;
    setTimeout(() => syncNow({ quiet: true }).catch(() => { /* surfaced through status() */ }), 0);
  }
  return status();
}

/* --- settings ----------------------------------------------------------- */

async function pullSettings(since) {
  const rows = await queryChanged('meta', since);
  const remote = rows.find((r) => r.id === 'app');
  if (!remote) return;

  const localAt = store.settingsUpdatedAt || 0;
  if ((remote.updatedAt || 0) <= localAt) return;

  if (Array.isArray(remote.folders)) store.folders = remote.folders;
  if (Array.isArray(remote.smartFolders)) store.smartFolders = remote.smartFolders;
  if (remote.settings && typeof remote.settings === 'object') {
    /* Theme and text size are per-device preferences, not account state. */
    const { theme, textScale, ...shared } = remote.settings;
    store.settings = { ...store.settings, ...shared };
  }
  if (remote.lockSalt) store.lockSalt = remote.lockSalt;
  if (remote.lockVerifier) store.lockVerifier = remote.lockVerifier;
  store.settingsUpdatedAt = remote.updatedAt;
  save();
}

async function pushSettings(since) {
  if ((store.settingsUpdatedAt || 0) <= since) return;
  await commit([docWrite('meta', 'app', {
    folders: store.folders,
    smartFolders: store.smartFolders,
    settings: store.settings,
    lockSalt: store.lockSalt || null,
    lockVerifier: store.lockVerifier || null,
    updatedAt: store.settingsUpdatedAt,
  })]);
}

/* --- notes --------------------------------------------------------------- */

async function pullNotes(since) {
  const pulled = new Set();
  const rows = await queryChanged('notes', since);
  if (!rows.length) return pulled;

  let changed = false;
  for (const remote of rows) {
    const local = store.notes.find((n) => n.id === remote.id);
    if (local && (local.updatedAt || 0) >= (remote.updatedAt || 0)) continue;

    const record = {
      id: remote.id,
      folderId: remote.folderId || 'default',
      html: remote.html || '',
      enc: remote.enc || null,
      createdAt: remote.createdAt || Date.now(),
      updatedAt: remote.updatedAt || Date.now(),
      pinned: !!remote.pinned,
      deletedAt: remote.deletedAt || null,
      locked: !!remote.locked,
      paper: remote.paper || 'plain',
      purged: !!remote.purged,
      kind: remote.kind || null,
      title: remote.title || '',
      inkAt: remote.inkAt || 0,
    };

    if (record.purged && record.kind === 'ink') await deleteInk(record.id).catch(() => {});
    if (local) Object.assign(local, record);
    else store.notes.push(record);
    pulled.add(remote.id);
    changed = true;
  }
  if (changed) save();
  return pulled;
}

async function pushNotes(since, skip = new Set()) {
  /* Anything that just arrived carries the server's own updatedAt, so without
     this it would be written straight back for no reason. */
  const dirty = store.notes.filter((n) => (n.updatedAt || 0) > since && !skip.has(n.id) && !n.localOnly && !n.draft);
  if (!dirty.length) return;
  const writes = dirty.map((n) => docWrite('notes', n.id, {
    folderId: n.folderId,
    html: n.enc ? '' : (n.html || ''),
    enc: n.enc || null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    pinned: !!n.pinned,
    deletedAt: n.deletedAt || null,
    locked: !!n.locked,
    paper: n.paper || 'plain',
    purged: !!n.purged,
    kind: n.kind || null,
    title: n.title || '',
    inkAt: n.inkAt || 0,
  }));
  // A handwritten note deleted for good takes its strokes off the server too.
  for (const n of dirty) {
    if (n.purged && n.kind === 'ink') writes.push(...inkDeletes('ink', n.id, partsSynced(`ink/${n.id}`) || PURGE_PARTS));
  }
  await commit(writes);
}

/* --- handwriting and PDF ink ---------------------------------------------- */

/* A page's strokes go up as JSON split into parts, because one long
   handwritten note outgrows Firestore's 1 MiB document limit. A header
   document per page says how many parts there are, and the header goes in the
   same commit as its parts - Firestore applies a commit all or nothing, so no
   device ever reads half of one version and half of another. */
const PART_CHARS = 900 * 1024;
const COMMIT_BYTES = 8 * 1024 * 1024;
const PURGE_PARTS = 16;

const partsSynced = (key) => (readJson(PARTS_KEY) || {})[key] || 0;

function rememberParts(entries) {
  if (!entries.length) return;
  const map = readJson(PARTS_KEY) || {};
  for (const [key, n] of entries) {
    if (n) map[key] = n;
    else delete map[key];
  }
  writeJson(PARTS_KEY, map);
}

/* With no [to], deletes the page outright - header and its first [from]
   parts. With one, deletes parts [from, to): the tail a shorter version left. */
function inkDeletes(collection, id, from, to = null) {
  const writes = [];
  if (to === null) writes.push({ delete: docName(collection, id) });
  for (let k = to === null ? 0 : from; k < (to === null ? from : to); k += 1) {
    writes.push({ delete: docName(`${collection}Part`, `${id}~${k}`) });
  }
  return writes;
}

function inkUpload(collection, id, strokes, fields) {
  const json = JSON.stringify(strokes || []);
  const parts = [];
  for (let i = 0; i < json.length; i += PART_CHARS) parts.push(json.slice(i, i + PART_CHARS));
  const writes = parts.map((data, k) => docWrite(`${collection}Part`, `${id}~${k}`, { data, updatedAt: fields.updatedAt }));
  writes.push(...inkDeletes(collection, id, parts.length, partsSynced(`${collection}/${id}`)));
  writes.push(docWrite(collection, id, { ...fields, parts: parts.length }));
  return { key: `${collection}/${id}`, parts: parts.length, bytes: json.length, writes };
}

/** Commits uploads in as few requests as fit, never splitting one page. */
async function commitUploads(uploads) {
  let batch = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await firestore(':commit', { method: 'POST', body: JSON.stringify({ writes: batch }) });
    batch = [];
    bytes = 0;
  };
  for (const u of uploads) {
    if (bytes + u.bytes > COMMIT_BYTES || batch.length + u.writes.length > 400) await flush();
    batch.push(...u.writes);
    bytes += u.bytes;
  }
  await flush();
  rememberParts(uploads.map((u) => [u.key, u.parts]));
}

class IncompleteInk extends Error {}

async function downloadStrokes(collection, id, parts) {
  if (!parts) return [];
  const names = Array.from({ length: parts }, (_, k) => docName(`${collection}Part`, `${id}~${k}`));
  const rows = await firestore(':batchGet', { method: 'POST', body: JSON.stringify({ documents: names }) });
  const found = new Map();
  for (const r of rows || []) {
    if (r.found) found.set(r.found.name, decodeFields(r.found.fields).data || '');
  }
  if (names.some((n) => !found.has(n))) throw new IncompleteInk();
  return JSON.parse(names.map((n) => found.get(n)).join(''));
}

/* A page whose parts are not all there is skipped rather than failing the
   whole sync; it cannot happen with atomic commits, but a half page must
   never overwrite a whole one. */
async function pullPages(collection, since, getLocal, putLocal) {
  const pulled = new Set();
  const synced = [];
  for (const remote of await queryChanged(collection, since)) {
    const local = await getLocal(remote.id);
    if (local && (local.updatedAt || 0) >= (remote.updatedAt || 0)) continue;
    let strokes;
    try {
      strokes = await downloadStrokes(collection, remote.id, remote.parts || 0);
    } catch (err) {
      if (err instanceof IncompleteInk) continue;
      throw err;
    }
    await putLocal(remote, strokes);
    synced.push([`${collection}/${remote.id}`, remote.parts || 0]);
    pulled.add(remote.id);
  }
  rememberParts(synced);
  return pulled;
}

async function pullInk(since) {
  const pulled = await pullPages('ink', since, getRawInk, (remote, strokes) => putRawInk({
    id: remote.id,
    strokes,
    paper: remote.paper || 'plain',
    images: cleanImages(remote.images),
    // Without this a whiteboard arrives as a page, with its writing at
    // coordinates a page has no room for - so invisible.
    board: !!remote.board,
    updatedAt: remote.updatedAt || Date.now(),
  }));
  // An open page shows what arrived (views/inknote.js).
  if (pulled.size) window.dispatchEvent(new CustomEvent('notes:ink-pulled', { detail: { ids: [...pulled] } }));
  return pulled;
}

async function pushInk(since, skip) {
  const uploads = [];
  for (const r of await inkChangedSince(since)) {
    if (skip.has(r.id)) continue;
    // Strokes whose note is gone, or never became a note, stay put.
    const note = store.notes.find((n) => n.id === r.id);
    if (!note || note.purged) continue;
    uploads.push(inkUpload('ink', r.id, r.strokes, {
      paper: r.paper || 'plain', images: cleanImages(r.images), board: !!r.board, updatedAt: r.updatedAt,
    }));
  }
  await commitUploads(uploads);
}

async function pullPdfInk(since) {
  return pullPages('pdfInk', since, getRawPdfInk, (remote, strokes) => putRawPdfInk({
    id: remote.id,
    fp: remote.fp,
    page: remote.page,
    strokes,
    updatedAt: remote.updatedAt || Date.now(),
  }));
}

async function pushPdfInk(since, skip) {
  const uploads = [];
  for (const r of await pdfInkChangedSince(since)) {
    if (skip.has(r.id)) continue;
    uploads.push(inkUpload('pdfInk', r.id, r.strokes, { fp: r.fp, page: r.page, updatedAt: r.updatedAt }));
  }
  await commitUploads(uploads);
}

/* --- vault folders and their copies ----------------------------------------- */

/* The list: one small record per vault. Which folder it is on each device
   never leaves that device (lib/vault.js). */
async function pullVaults(since) {
  const pulled = new Set();
  for (const remote of await queryChanged('vaults', since)) {
    const local = store.vaults.find((v) => v.id === remote.id);
    if (local && (local.updatedAt || 0) >= (remote.updatedAt || 0)) continue;
    const record = {
      id: remote.id,
      name: remote.name || 'Folder',
      hint: remote.hint || '',
      cloud: remote.cloud !== false,
      addedAt: remote.addedAt || Date.now(),
      updatedAt: remote.updatedAt || Date.now(),
      deleted: !!remote.deleted,
    };
    if (local) Object.assign(local, record);
    else store.vaults.push(record);
    pulled.add(remote.id);
  }
  if (pulled.size) save();
  return pulled;
}

async function pushVaults(since, skip) {
  const dirty = store.vaults.filter((v) => (v.updatedAt || 0) > since && !skip.has(v.id));
  if (!dirty.length) return;
  await commit(dirty.map((v) => docWrite('vaults', v.id, {
    name: v.name || 'Folder',
    hint: v.hint || '',
    cloud: v.cloud !== false,
    addedAt: v.addedAt || v.updatedAt,
    updatedAt: v.updatedAt,
    deleted: !!v.deleted,
  })));
}

/* The copy: one document per note, text inline (each is under 900 KB). */
async function pullVaultFiles(since) {
  const pulled = new Set();
  const batch = [];
  for (const remote of await queryChanged('vaultFiles', since, { pageSize: 200 })) {
    const local = await getVaultFile(remote.id);
    if (local && (local.updatedAt || 0) >= (remote.updatedAt || 0)) continue;
    batch.push({
      id: remote.id,
      vault: remote.vault,
      path: remote.path || '',
      name: remote.name || '',
      type: remote.type || '',
      size: remote.size || 0,
      modified: remote.modified || 0,
      hash: remote.hash || '',
      text: remote.deleted ? '' : (remote.text || ''),
      deleted: !!remote.deleted,
      updatedAt: remote.updatedAt || Date.now(),
    });
    pulled.add(remote.id);
  }
  await putVaultFiles(batch);
  return pulled;
}

async function pushVaultFiles(since, skip) {
  const records = (await vaultFilesChangedSince(since)).filter((r) => !skip.has(r.id));
  if (!records.length) return;
  let writes = [];
  let bytes = 0;
  for (const r of records) {
    const text = r.deleted ? '' : (r.text || '');
    if ((bytes + text.length > COMMIT_BYTES || writes.length >= 400) && writes.length) {
      await firestore(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
      writes = [];
      bytes = 0;
    }
    writes.push(docWrite('vaultFiles', r.id, {
      vault: r.vault,
      path: r.path,
      name: r.name,
      type: r.type || '',
      size: r.size || 0,
      modified: r.modified || 0,
      hash: r.hash || '',
      text,
      deleted: !!r.deleted,
      updatedAt: r.updatedAt,
    }));
    bytes += text.length;
  }
  if (writes.length) await firestore(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
}

/* --- attachments ---------------------------------------------------------- */

async function pullAttachments(since) {
  const rows = await queryChanged('attachments', since);
  for (const remote of rows) {
    if (remote.purged) continue;
    const existing = await getAttachment(remote.id);
    if (existing) continue;
    if (!remote.data) continue;
    await putRawAttachment({
      id: remote.id,
      blob: base64ToBlob(remote.data, remote.type || 'image/jpeg'),
      type: remote.type || 'image/jpeg',
      kind: remote.kind || 'photo',
      noteId: remote.noteId || null,
      width: remote.width || 0,
      height: remote.height || 0,
      createdAt: remote.createdAt || Date.now(),
      updatedAt: remote.updatedAt || Date.now(),
    });
  }
}

async function pushAttachments(since) {
  const records = await listAttachments();
  const fresh = records.filter((r) => (r.updatedAt || r.createdAt || 0) > since);
  if (!fresh.length) return;

  const writes = [];
  for (const record of fresh) {
    if (!record.blob || record.blob.size > MAX_ATTACHMENT_BYTES) continue;
    writes.push(docWrite('attachments', record.id, {
      data: await blobToBase64(record.blob),
      type: record.type || 'image/jpeg',
      kind: record.kind || 'photo',
      noteId: record.noteId || null,
      width: record.width || 0,
      height: record.height || 0,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now(),
      purged: false,
    }));
  }
  if (writes.length) await commit(writes);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/* --------------------------------------------------------------- scheduling */

let timer = null;

/** Syncs on a timer and whenever the app comes back to the foreground. */
export function startAutoSync(intervalMs = 120000) {
  stopAutoSync();
  const tick = () => {
    if (!auth || !navigator.onLine) return;
    syncNow({ quiet: true }).catch(() => { /* surfaced through status() */ });
  };
  timer = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', tick);
  setTimeout(tick, 1500);
}

function onVisible() {
  if (document.visibilityState === 'visible' && auth && navigator.onLine) {
    syncNow({ quiet: true }).catch(() => {});
  }
}

export function stopAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
}

