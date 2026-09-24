/**
 * Vault folders: real folders on the device - an Obsidian vault Syncthing
 * keeps in step with the PC, a folder of past papers - opened in place, and
 * known to every device on the account.
 *
 * Two halves:
 *   - The list of vaults syncs like notes do (store.vaults, one record per
 *     vault). Which folder a vault is on *this* device is kept here only, in
 *     notes.vaultLinks: Android's grant for a folder belongs to one device, so
 *     a vault added on the phone shows on the tablet ready to be linked to
 *     the same folder there.
 *   - The account keeps a copy of each vault's Markdown and text files
 *     (lib/library.js vaultfiles, synced by lib/sync.js). A device that has
 *     the folder refreshes the copy when the vault is opened (mirrorVault); a
 *     device without it - no Syncthing, the web version - reads the copy.
 *
 * Reading goes through the same functions either way: listFolder, readText,
 * readBlob and vaultIndex look at the live folder when the vault is linked
 * here and at the copy when it is not.
 *
 * [[Links]] resolve the way Obsidian resolves them: by file name anywhere in
 * the vault, the nearest one winning when two share a name. That needs every
 * file's path, so the first link followed (or the first search) walks the
 * whole folder once and keeps the result for the session.
 */

import { store, save, uid } from './store.js';
import {
  guessType, kindOf, getVaultFiles, getVaultFile, putVaultFiles,
} from './library.js';
import { account, syncNow } from './sync.js';

const LINKS_KEY = 'notes.vaultLinks';
const OLD_KEY = 'notes.vaults';
const TEXT_KINDS = new Set(['markdown', 'text']);
/* A Firestore document caps at 1 MiB; bigger notes stay on their device. */
const MAX_COPY_BYTES = 900000;

const core = () => (window.__TAURI__ && window.__TAURI__.core) || null;

/** True inside the Android app, the one place a folder can be picked. */
export const vaultSupported = () => !!core() && /Android/i.test(navigator.userAgent);

const invoke = (cmd, args) => core().invoke(cmd, args);

/* ------------------------------------------------------------- the list */

function links() {
  try {
    const map = JSON.parse(localStorage.getItem(LINKS_KEY));
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function saveLinks(map) {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(map));
  } catch {
    // Storage full: the link lasts until the app closes.
  }
}

const hintOf = (tree) => {
  try {
    return decodeURIComponent(String(tree || '').split('/tree/')[1] || '');
  } catch {
    return '';
  }
};

/* 0.3 and 0.4 kept the whole list per device in notes.vaults. */
let migrated = false;
function migrate() {
  if (migrated) return;
  migrated = true;
  let old = null;
  try { old = JSON.parse(localStorage.getItem(OLD_KEY)); } catch { /* unreadable: nothing to move */ }
  if (!Array.isArray(old)) return;
  const map = links();
  const now = Date.now();
  for (const v of old) {
    if (!v || !v.id) continue;
    if (!store.vaults.some((x) => x.id === v.id)) {
      store.vaults.push({
        id: v.id, name: v.name || 'Folder', hint: hintOf(v.tree), cloud: true,
        addedAt: v.addedAt || now, updatedAt: now, deleted: false,
      });
    }
    if (v.tree) map[v.id] = v.tree;
  }
  saveLinks(map);
  save();
  try { localStorage.removeItem(OLD_KEY); } catch { /* ignore */ }
}

const recordOf = (v) => store.vaults.find((x) => x.id === v.id);

/** Every vault on the account, each with its folder on this device (tree), if any. */
export function vaults() {
  migrate();
  const map = links();
  return store.vaults.filter((v) => !v.deleted).map((v) => ({ ...v, tree: map[v.id] || null }));
}

export const isLinked = (v) => !!(v && v.tree);

function forget(v) {
  indexes.delete(`${v.id}:live`);
  indexes.delete(`${v.id}:copy`);
}

/**
 * Opens the system folder picker; resolves to the vault, or null if backed
 * out of. The same folder already known from another device is linked rather
 * than listed twice.
 */
export async function addVault() {
  migrate();
  const picked = await invoke('vault_pick', { hint: null });
  if (!picked || !picked.tree) return null;
  const hint = picked.root || hintOf(picked.tree);
  const map = links();
  let rec = store.vaults.find((v) => !v.deleted && hint && v.hint === hint)
    || store.vaults.find((v) => !v.deleted && !map[v.id] && v.name === picked.name);
  if (!rec) {
    const now = Date.now();
    rec = {
      id: `v${uid()}`, name: picked.name || 'Folder', hint, cloud: true,
      addedAt: now, updatedAt: now, deleted: false,
    };
    store.vaults.push(rec);
    save();
  }
  map[rec.id] = picked.tree;
  saveLinks(map);
  forget(rec);
  return { ...rec, tree: picked.tree };
}

/** Links a vault known from another device to its folder on this one. */
export async function linkVault(v) {
  const picked = await invoke('vault_pick', { hint: v.hint || null });
  if (!picked || !picked.tree) return null;
  const map = links();
  map[v.id] = picked.tree;
  saveLinks(map);
  forget(v);
  return { ...v, tree: picked.tree };
}

/**
 * Picks the folder again after Android dropped the grant (the folder was
 * moved, or the app's data cleared). Updates [v] in place.
 */
export async function repickVault(v) {
  const linked = await linkVault(v);
  if (!linked) return false;
  v.tree = linked.tree;
  return true;
}

export function renameVault(v, name) {
  const rec = recordOf(v);
  v.name = name;
  if (!rec) return;
  rec.name = name;
  rec.updatedAt = Date.now();
  save();
}

async function dropCopy(v) {
  const now = Date.now();
  const gone = (await getVaultFiles(v.id)).filter((r) => !r.deleted)
    .map((r, i) => ({ ...r, text: '', deleted: true, updatedAt: now + i }));
  await putVaultFiles(gone);
  forget(v);
}

/** Turns the account copy on or off; off deletes it on every device. */
export async function setVaultCloud(v, on) {
  const rec = recordOf(v);
  v.cloud = on;
  if (rec) {
    rec.cloud = on;
    rec.updatedAt = Date.now();
    save();
  }
  if (!on) await dropCopy(v);
}

/** Removes a vault from every device, with its copy. The folder is untouched. */
export async function removeVault(v) {
  const rec = recordOf(v);
  if (rec) {
    rec.deleted = true;
    rec.updatedAt = Date.now();
    save();
  }
  const map = links();
  const tree = map[v.id];
  delete map[v.id];
  saveLinks(map);
  await dropCopy(v);
  if (tree && core()) {
    try {
      await invoke('vault_release', { tree });
    } catch {
      // Already released; nothing is owed.
    }
  }
}

/** The code the native side uses when a folder's grant has gone. */
export const isAccessLost = (err) => String(err && (err.message || err)).includes('access-lost');

/* ----------------------------------------------------------------- reading */

/* The account copy, shaped like a folder listing. [prefix] is a path inside
   the vault ending in a slash, or '' for the top level. */
async function copyList(v, prefix) {
  const dirs = new Map();
  const files = [];
  for (const r of await getVaultFiles(v.id)) {
    if (r.deleted || !r.path.startsWith(prefix)) continue;
    const rest = r.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      if (!dirs.has(name)) dirs.set(name, { doc: `${prefix}${name}/`, name, dir: true, type: '', size: -1, modified: 0 });
    } else {
      files.push({ doc: r.id, name: r.name, dir: false, type: r.type, size: r.size, modified: r.modified, path: r.path });
    }
  }
  return [...dirs.values(), ...files];
}

/**
 * One folder's contents, hidden files left out as Obsidian leaves them out.
 * For a vault read from the copy, [doc] is a path prefix ('' or 'a/b/').
 */
export async function listFolder(v, doc = null) {
  if (!isLinked(v)) return copyList(v, doc || '');
  const { items } = await invoke('vault_list', { tree: v.tree, doc });
  return items.filter((it) => !it.name.startsWith('.'));
}

async function readBytes(v, doc) {
  const out = await invoke('vault_read', { tree: v.tree, doc });
  // Raw responses arrive as an ArrayBuffer; a runtime that had to fall back
  // to JSON sends an array of numbers instead.
  return Array.isArray(out) ? new Uint8Array(out) : out;
}

export async function readText(v, file) {
  if (!isLinked(v)) {
    const rec = await getVaultFile(file.doc);
    if (!rec || rec.deleted) throw new Error('That note is not in the copy yet');
    return rec.text;
  }
  return new TextDecoder().decode(await readBytes(v, file.doc));
}

export async function readBlob(v, file) {
  const type = file.type || guessType(file.name);
  if (!isLinked(v)) {
    if (!TEXT_KINDS.has(kindOf(file.name, type))) throw new Error('Open this on the device that has the folder');
    return new Blob([await readText(v, file)], { type });
  }
  return new Blob([await readBytes(v, file.doc)], { type });
}

/* --------------------------------------------------------- the whole vault */

const indexes = new Map();
const STALE_MS = 20_000;
const indexKey = (v) => `${v.id}:${isLinked(v) ? 'live' : 'copy'}`;

function buildIndex(files, truncated) {
  const byName = new Map();
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  return { files, byName, truncated: !!truncated };
}

/**
 * Every file in the vault by name and path. Kept for the session; a lookup
 * that misses rebuilds it once if it is more than a few seconds old, because
 * Syncthing - or a sync of the copy - may have brought the file in since.
 */
export function vaultIndex(v, { fresh = false } = {}) {
  const key = indexKey(v);
  const cached = indexes.get(key);
  if (cached && !fresh) return cached.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = isLinked(v)
    ? invoke('vault_walk', { tree: v.tree, doc: null }).then(({ files, truncated }) => buildIndex(files, truncated))
    : getVaultFiles(v.id).then((records) => buildIndex(records.filter((r) => !r.deleted).map((r) => ({
      doc: r.id, path: r.path, name: r.name, type: r.type, size: r.size, modified: r.modified,
    })), false));
  entry.promise.catch(() => indexes.delete(key));
  indexes.set(key, entry);
  return entry.promise;
}

/* ------------------------------------------------------- the account copy */

async function sha1Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fileId = async (vaultId, path) => `${vaultId}~${(await sha1Hex(path)).slice(0, 24)}`;

const mirroring = new Map();

/**
 * Brings the account copy of a linked vault up to date with its folder: new
 * and changed notes are copied, deleted ones become tombstones, and unchanged
 * ones are not even read (same size and modified time). Resolves to
 * { scanned, uploaded }, or null when there is nothing to do here - not
 * linked, copy switched off, or not signed in.
 */
export function mirrorVault(v, onProgress) {
  if (!isLinked(v) || v.cloud === false || !account()) return Promise.resolve(null);
  if (mirroring.has(v.id)) return mirroring.get(v.id);
  const run = (async () => {
    const index = await vaultIndex(v, { fresh: true });
    const known = new Map((await getVaultFiles(v.id)).map((r) => [r.path, r]));
    const wanted = index.files.filter((f) => TEXT_KINDS.has(kindOf(f.name, f.type)) && f.size <= MAX_COPY_BYTES);
    const start = Date.now();
    let stamp = start;
    const queued = [];
    let done = 0;
    for (const f of wanted) {
      const old = known.get(f.path);
      known.delete(f.path);
      done += 1;
      if (onProgress && done % 10 === 0) onProgress(done, wanted.length);
      if (old && !old.deleted && old.modified === f.modified && old.size === f.size) continue;
      const text = await readText(v, f);
      const hash = await sha1Hex(text);
      if (old && !old.deleted && old.hash === hash) {
        // Touched but not changed: remember the new time, send nothing.
        queued.push({ ...old, modified: f.modified, size: f.size });
        continue;
      }
      queued.push({
        id: old ? old.id : await fileId(v.id, f.path),
        vault: v.id,
        path: f.path,
        name: f.name,
        type: f.type || guessType(f.name),
        size: f.size,
        modified: f.modified,
        hash,
        text,
        deleted: false,
        updatedAt: stamp++,
      });
    }
    // A cut-short walk proves nothing about what is missing.
    if (!index.truncated) {
      for (const old of known.values()) {
        if (!old.deleted) queued.push({ ...old, text: '', deleted: true, updatedAt: stamp++ });
      }
    }
    await putVaultFiles(queued);
    const uploaded = queued.filter((r) => r.updatedAt >= start).length;
    if (onProgress) onProgress(wanted.length, wanted.length);
    if (uploaded) syncNow({ quiet: true }).catch(() => { /* surfaced through sync status */ });
    return { scanned: wanted.length, uploaded };
  })();
  mirroring.set(v.id, run);
  run.then(() => mirroring.delete(v.id), () => mirroring.delete(v.id));
  return run;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/** Joins a relative path onto a folder, resolving ./ and ../ */
function join(dir, rel) {
  const parts = `${dir}${rel}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function clean(target) {
  let t = String(target || '').trim().replace(/\\/g, '/');
  try { t = decodeURIComponent(t); } catch { /* a literal % in a name */ }
  return t.replace(/^\/+/, '');
}

/** Of several files with one name, the one closest to the file linking to it. */
function nearest(hits, fromPath) {
  if (hits.length < 2) return hits[0] || null;
  const from = dirOf(fromPath || '').toLowerCase();
  const shared = (p) => {
    const d = dirOf(p).toLowerCase();
    let n = 0;
    while (n < d.length && n < from.length && d[n] === from[n]) n += 1;
    return n;
  };
  return [...hits].sort((a, b) => shared(b.path) - shared(a.path) || a.path.length - b.path.length)[0];
}

function find(index, target, fromPath) {
  const t = clean(target);
  if (!t) return null;
  const lower = t.toLowerCase();
  // A name can hold a dot ("Chapter 3.2"), so the bare name and the name with
  // .md are both tried rather than guessing whether it has an extension.
  const tries = [lower, `${lower}.md`];

  if (lower.includes('/')) {
    const byPath = (p) => index.files.find((f) => f.path.toLowerCase() === p);
    for (const want of tries) {
      const hit = (fromPath && byPath(join(dirOf(fromPath).toLowerCase(), want))) || byPath(want);
      if (hit) return hit;
    }
    for (const want of tries) {
      const hits = index.files.filter((f) => f.path.toLowerCase().endsWith(`/${want}`));
      if (hits.length) return nearest(hits, fromPath);
    }
    // Fall through: a link to "attachments/pic.png" where the file moved.
  }
  const name = lower.split('/').pop();
  for (const want of [name, `${name}.md`]) {
    const hits = index.byName.get(want);
    if (hits && hits.length) return nearest(hits, fromPath);
  }
  return null;
}

/** Finds the file a [[link]] or relative image path points at, from [fromPath]. */
export async function lookup(v, target, fromPath) {
  const entry = indexes.get(indexKey(v));
  let index = await vaultIndex(v);
  let hit = find(index, target, fromPath);
  if (!hit && entry && Date.now() - entry.at > STALE_MS) {
    index = await vaultIndex(v, { fresh: true });
    hit = find(index, target, fromPath);
  }
  return hit;
}

/** Files anywhere in the vault whose name contains [query]. */
export async function searchVault(v, query, limit = 120) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const index = await vaultIndex(v);
  const hits = [];
  for (const f of index.files) {
    const n = f.name.toLowerCase();
    const at = n.indexOf(q);
    if (at >= 0) hits.push({ f, rank: (at === 0 ? 0 : 2) + (/\.md$/.test(n) ? 0 : 1) });
  }
  hits.sort((a, b) => a.rank - b.rank || a.f.path.length - b.f.path.length);
  return hits.slice(0, limit).map((h) => h.f);
}
