/**
 * One search across everything you have written or kept.
 *
 * Notes were searchable; nothing else was. A PDF of a lecture, a Markdown file
 * in a vault, a file you imported - all of it was findable only by remembering
 * where you put it, which is the opposite of what a search is for. This looks
 * in all of them at once and says, for each result, the line that matched and
 * where it came from.
 *
 * PDF text is pulled out once and kept, because pulling it out is slow and the
 * result never changes. Everything else is read live, so a search can never
 * show something that has since been edited away.
 */

import { store, plainText } from './store.js';
import { getVaultFiles, getFile } from './library.js';

/* Long enough to be worth reading, short enough to fit a row. */
const SNIPPET_BEFORE = 36;
const SNIPPET_AFTER = 90;

/* ------------------------------------------------------- remembered text */

const DB_NAME = 'notes.library';
const TEXT_STORE = 'pdftext';
let textDb = null;

/* The PDF text store was added after the library database existed, so it is
   opened on its own rather than by bumping the shared one - an upgrade there
   would have to be understood by every other part that opens it. */
function openTextDb() {
  if (textDb) return textDb;
  textDb = new Promise((resolve) => {
    const req = indexedDB.open('notes.pdftext', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TEXT_STORE)) req.result.createObjectStore(TEXT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return textDb;
}

async function rememberedText(id) {
  const db = await openTextDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(TEXT_STORE, 'readonly').objectStore(TEXT_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function rememberText(id, text) {
  const db = await openTextDb();
  if (!db) return;
  try {
    const tx = db.transaction(TEXT_STORE, 'readwrite');
    tx.objectStore(TEXT_STORE).put({ text, at: Date.now() }, id);
  } catch {
    /* Out of room, or blocked: the search still works, just slower next time. */
  }
}

/**
 * The words in a PDF, page by page, joined. Read once and kept: a PDF does not
 * change, and reading a long one takes seconds.
 */
export async function pdfText(fileId, blob, onProgress) {
  const kept = await rememberedText(fileId);
  if (kept) return kept.text;
  if (!blob) return '';

  const pdfjs = await import('../vendor/pdfjs/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    if (onProgress) onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(' '));
    page.cleanup();
  }
  const text = pages.join('\n');
  /* Letting the document go is worth doing and not worth failing over: which
     of these exists depends on the version of the reader. */
  try {
    if (typeof doc.destroy === 'function') await doc.destroy();
    else if (typeof doc.cleanup === 'function') await doc.cleanup();
  } catch {
    /* It will be collected anyway. */
  }
  await rememberText(fileId, text);
  return text;
}

/** Forgets one PDF's text, for when the file it came from is deleted. */
export async function forgetText(id) {
  const db = await openTextDb();
  if (!db) return;
  try {
    db.transaction(TEXT_STORE, 'readwrite').objectStore(TEXT_STORE).delete(id);
  } catch {
    /* Nothing to do. */
  }
}

/* ------------------------------------------------------------- searching */

/** The line a match sits in, with the match itself marked out. */
export function snippetFor(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET_BEFORE);
  const to = Math.min(text.length, at + query.length + SNIPPET_AFTER);
  const before = (from ? '...' : '') + text.slice(from, at);
  const after = text.slice(at + query.length, to) + (to < text.length ? '...' : '');
  return { before: before.replace(/\s+/g, ' '), hit: text.slice(at, at + query.length), after: after.replace(/\s+/g, ' ') };
}

const decoder = new TextDecoder();

/**
 * Searches everything.
 *
 * [onResult] is called with each result as it is found, so a search of a big
 * library fills in rather than making you wait for the slowest part of it -
 * notes first, because they are instant, then the files.
 */
export async function searchEverything(query, { onResult, signal, includePdfs = true } = {}) {
  const q = String(query || '').trim();
  const results = [];
  if (q.length < 2) return results;
  const lower = q.toLowerCase();
  const stopped = () => signal && signal.aborted;

  const give = (result) => {
    results.push(result);
    if (onResult) onResult(result);
  };

  const isPdf = (n) => n.kind === 'file' && n.fileId && /\.pdf$/i.test(n.title || '');

  /* Notes, which are already in memory. */
  for (const note of store.notes) {
    if (stopped()) return results;
    if (note.purged || note.deletedAt || note.draft) continue;
    /* A PDF is left to the part below, which can look inside it. Matching its
       name here would hide the line in it that actually answers the search. */
    if (includePdfs && isPdf(note)) continue;
    const title = note.title || '';
    if (note.locked) {
      if (title.toLowerCase().includes(lower)) {
        give({ kind: 'note', id: note.id, title: title || 'Locked Note', where: 'Locked', snippet: null, note });
      }
      continue;
    }
    const body = plainText(note.html || '');
    const hay = `${title}\n${body}`;
    if (!hay.toLowerCase().includes(lower)) continue;
    give({
      kind: note.kind === 'ink' ? 'ink' : note.kind === 'file' ? 'file' : 'note',
      id: note.id,
      title: title || body.slice(0, 40) || 'Untitled',
      where: 'Note',
      snippet: snippetFor(body, q) || snippetFor(title, q),
      note,
    });
  }

  /* Markdown kept from vault folders. */
  for (const vault of store.vaults || []) {
    if (stopped()) return results;
    let files = [];
    try {
      files = await getVaultFiles(vault.id);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (stopped()) return results;
      if (file.deleted || !file.text) continue;
      const hay = `${file.path || ''}\n${file.text}`;
      if (!hay.toLowerCase().includes(lower)) continue;
      give({
        kind: 'vault',
        id: file.id,
        title: (file.path || '').split('/').pop() || 'File',
        where: vault.name || 'Vault',
        snippet: snippetFor(file.text, q) || snippetFor(file.path || '', q),
        vaultId: vault.id,
        path: file.path,
      });
    }
  }

  /* PDFs, last and slowest: each one has to be read the first time. */
  if (includePdfs) {
    const pdfs = store.notes.filter((n) => !n.deletedAt && !n.purged && isPdf(n));
    for (const note of pdfs) {
      if (stopped()) return results;
      const named = (note.title || '').toLowerCase().includes(lower);
      let text = '';
      try {
        const kept = await rememberedText(note.fileId);
        if (kept) text = kept.text;
        else {
          const rec = await getFile(note.fileId);
          text = rec && rec.blob ? await pdfText(note.fileId, rec.blob) : '';
        }
      } catch {
        text = '';                      // unreadable: its name can still match
      }
      const inside = text.toLowerCase().includes(lower);
      if (!inside && !named) continue;
      give({
        kind: 'pdf',
        id: note.id,
        title: note.title || 'PDF',
        where: inside ? 'PDF' : 'PDF name',
        snippet: inside ? snippetFor(text, q) : null,
        note,
      });
    }
  }

  return results;
}

/** Readable text from a vault file's stored bytes, for indexing. */
export const textOf = (bytes) => {
  try {
    return decoder.decode(bytes);
  } catch {
    return '';
  }
};
