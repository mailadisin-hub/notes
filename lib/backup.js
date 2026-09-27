/**
 * A backup you can actually read, and restore from.
 *
 * Two jobs in one file, deliberately. A backup that only this app understands
 * is a promise, not a guarantee: if the app stopped working tomorrow the notes
 * would be gone with it. So the archive holds both - the notes as ordinary
 * Markdown, the pictures and PDFs as ordinary files, openable on any computer
 * with nothing installed; and a `data` folder beside them that restores
 * everything back exactly, including handwriting, which no file format could
 * carry faithfully.
 *
 * Restoring merges rather than replaces. The usual reason to restore is a lost
 * or new device, and the worst thing a restore could do is quietly delete
 * something the archive happens not to know about, so nothing is ever removed
 * and the newer of the two copies of anything wins.
 */

import { zip, unzip } from './zip.js';
import { store, save, allNotes } from './store.js';
import {
  inkChangedSince, putRawInk, pdfInkChangedSince, putRawPdfInk,
  getVaultFiles, putVaultFiles, putFile, getFile,
} from './library.js';
import { listAttachments, getAttachment, putRawAttachment } from './attachments.js';

const stamp = () => new Date().toISOString().slice(0, 10);

/** A name safe on every filesystem, and never empty. */
function safeName(text, fallback = 'Untitled') {
  const clean = String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || fallback;
}

/** Keeps two files from the same folder ever landing on the same name. */
function uniquely(taken, name) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const next = `${stem} ${n}${ext}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
}

/**
 * A note's HTML as Markdown. Not a general converter - it only has to handle
 * what the editor itself produces, which is headings, lists, checklists,
 * tables, bold, italics and highlights.
 */
export function htmlToMarkdown(html) {
  const host = document.createElement('div');
  host.innerHTML = String(html || '');

  const inline = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      const inner = inline(child);
      if (tag === 'br') out += '\n';
      else if (tag === 'b' || tag === 'strong') out += `**${inner}**`;
      else if (tag === 'i' || tag === 'em') out += `*${inner}*`;
      else if (tag === 'u') out += `_${inner}_`;
      else if (tag === 's' || tag === 'strike') out += `~~${inner}~~`;
      else if (tag === 'mark') out += `==${inner}==`;
      else if (tag === 'code') out += `\`${inner}\``;
      else if (tag === 'a') out += `[${inner}](${child.getAttribute('href') || ''})`;
      else if (tag === 'img') out += `![picture](attachments/${child.dataset.att || 'missing'})`;
      else out += inner;
    }
    return out;
  };

  const lines = [];
  for (const node of host.children) {
    const tag = node.tagName.toLowerCase();
    const text = inline(node).trim();
    if (tag === 'h1') lines.push(`# ${text}`, '');
    else if (tag === 'h2') lines.push(`## ${text}`, '');
    else if (tag === 'h3') lines.push(`### ${text}`, '');
    else if (tag === 'ul' || tag === 'ol') {
      [...node.children].forEach((li, i) => {
        lines.push(`${tag === 'ol' ? `${i + 1}.` : '-'} ${inline(li).trim()}`);
      });
      lines.push('');
    } else if (tag === 'table') {
      for (const tr of node.querySelectorAll('tr')) {
        lines.push(`| ${[...tr.children].map((td) => inline(td).trim()).join(' | ')} |`);
      }
      lines.push('');
    } else if (node.classList.contains('checkitem')) {
      lines.push(`- [${node.dataset.done === '1' ? 'x' : ' '}] ${inline(node.querySelector('.ct') || node).trim()}`);
    } else if (tag === 'blockquote') lines.push(`> ${text}`, '');
    else lines.push(text, '');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const README = `Notes backup
============

Your notes, twice over.

  notes/         every typed note as Markdown, in its folder. Open these in
                 anything - a text editor, Obsidian, Word.
  attachments/   the pictures from inside those notes.
  files/         PDFs and other files you imported.
  data/          the same thing in the form this app reads back. Handwriting
                 lives here, because no ordinary file format holds pen
                 strokes faithfully.

To put it all back: Notes > Settings > Restore from Backup, and choose this
zip file. Nothing is deleted by a restore - anything already on the device is
kept, and the newer copy of anything that exists in both wins.

Notes that were locked stay encrypted in here. They need the passcode they
were locked with, on a device signed in to the same account.
`;

/**
 * Builds the archive. [onProgress] is called with a line of plain text as each
 * part is gathered, because a big library takes long enough to need telling.
 */
export async function buildBackup(onProgress = () => {}) {
  const files = [];
  const say = (text) => onProgress(text);

  say('Collecting your notes...');
  const notes = allNotes().filter((n) => !n.deletedAt && !n.draft);
  const folders = new Map((store.folders || []).map((f) => [f.id, f.name]));
  const takenPer = new Map();
  let written = 0;
  for (const note of notes) {
    if (note.locked) continue;            // encrypted: it only goes in data/
    if (note.kind === 'ink' || note.kind === 'pdf') continue;
    const folder = safeName(folders.get(note.folderId) || 'Notes', 'Notes');
    if (!takenPer.has(folder)) takenPer.set(folder, new Set());
    const title = safeName(note.title || (note.html || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 40));
    const name = uniquely(takenPer.get(folder), `${title}.md`);
    const body = htmlToMarkdown(note.html);
    const head = `---\ntitle: ${note.title || title}\nupdated: ${new Date(note.updatedAt || Date.now()).toISOString()}\n---\n\n`;
    files.push({ name: `notes/${folder}/${name}`, data: head + body + '\n' });
    written += 1;
  }

  say('Collecting pictures...');
  for (const rec of await listAttachments()) {
    if (!rec || !rec.blob) continue;
    const ext = (rec.blob.type || '').includes('png') ? 'png' : 'jpg';
    files.push({ name: `attachments/${rec.id}.${ext}`, data: rec.blob });
  }

  say('Collecting files...');
  const fileNames = new Set();
  const importedIds = (store.notes || []).filter((n) => n.kind === 'file' && n.fileId).map((n) => n.fileId);
  for (const id of new Set(importedIds)) {
    const rec = await getFile(id);
    if (rec && rec.blob) files.push({ name: `files/${uniquely(fileNames, safeName(rec.name, id))}`, data: rec.blob });
  }

  say('Collecting handwriting...');
  const ink = await inkChangedSince(0);
  const pdfInk = await pdfInkChangedSince(0);
  const vaultFiles = [];
  for (const vault of store.vaults || []) {
    for (const rec of await getVaultFiles(vault.id)) vaultFiles.push(rec);
  }

  files.push({ name: 'README.txt', data: README });
  files.push({ name: 'data/notes.json', data: JSON.stringify(store) });
  files.push({ name: 'data/ink.json', data: JSON.stringify(ink) });
  files.push({ name: 'data/pdfink.json', data: JSON.stringify(pdfInk) });
  files.push({ name: 'data/vaultfiles.json', data: JSON.stringify(vaultFiles) });
  files.push({
    name: 'data/about.json',
    data: JSON.stringify({ app: 'Notes', format: 1, madeAt: new Date().toISOString(), notes: notes.length }),
  });

  say('Packing it up...');
  return {
    blob: await zip(files),
    name: `Notes backup ${stamp()}.zip`,
    counts: { notes: written, handwritten: ink.length, files: fileNames.size },
  };
}

/** Newer wins, and anything only one side has is kept. */
function mergeRecords(mine, theirs, key = 'id', at = 'updatedAt') {
  const byId = new Map(mine.map((r) => [r[key], r]));
  const incoming = [];
  for (const rec of theirs) {
    const here = byId.get(rec[key]);
    if (!here || (rec[at] || 0) > (here[at] || 0)) incoming.push(rec);
  }
  return incoming;
}

/**
 * Puts a backup back. Merges: nothing already here is deleted, and for
 * anything in both, whichever was edited last is kept.
 */
export async function restoreBackup(blob, onProgress = () => {}) {
  const say = (text) => onProgress(text);
  say('Opening the backup...');
  const entries = await unzip(blob);

  const read = (name) => {
    const bytes = entries.get(name);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`${name} in this backup is damaged`);
    }
  };

  const about = read('data/about.json');
  const incoming = read('data/notes.json');
  if (!about || !incoming) throw new Error('That zip is not a Notes backup');
  if (about.format > 1) throw new Error('This backup was made by a newer version of Notes');

  const result = { notes: 0, handwriting: 0, pictures: 0, files: 0, folders: 0 };

  say('Putting your notes back...');
  const mineById = new Map((store.notes || []).map((n) => [n.id, n]));
  for (const note of incoming.notes || []) {
    const here = mineById.get(note.id);
    if (!here) {
      store.notes.push(note);
      result.notes += 1;
    } else if ((note.updatedAt || 0) > (here.updatedAt || 0)) {
      Object.assign(here, note);
      result.notes += 1;
    }
  }
  const folderIds = new Set((store.folders || []).map((f) => f.id));
  for (const folder of incoming.folders || []) {
    if (!folderIds.has(folder.id)) {
      store.folders.push(folder);
      result.folders += 1;
    }
  }
  const vaultIds = new Set((store.vaults || []).map((v) => v.id));
  for (const vault of incoming.vaults || []) if (!vaultIds.has(vault.id)) store.vaults.push(vault);
  save();

  say('Putting handwriting back...');
  for (const rec of mergeRecords(await inkChangedSince(0), read('data/ink.json') || [])) {
    await putRawInk(rec);
    result.handwriting += 1;
  }
  for (const rec of mergeRecords(await pdfInkChangedSince(0), read('data/pdfink.json') || [])) {
    await putRawPdfInk(rec);
  }
  const vaultFiles = read('data/vaultfiles.json') || [];
  if (vaultFiles.length) await putVaultFiles(vaultFiles);

  say('Putting pictures back...');
  for (const [name, bytes] of entries) {
    if (!name.startsWith('attachments/')) continue;
    const id = name.slice('attachments/'.length).replace(/\.[a-z0-9]+$/i, '');
    if (await getAttachment(id)) continue;
    const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
    await putRawAttachment({ id, blob: new Blob([bytes], { type }), kind: 'photo', createdAt: Date.now() });
    result.pictures += 1;
  }

  say('Putting files back...');
  for (const note of store.notes || []) {
    if (note.kind !== 'file' || !note.fileId) continue;
    if (await getFile(note.fileId)) continue;
    const match = [...entries.keys()].find((n) => n.startsWith('files/') && safeName(n.slice(6)) === safeName(note.title));
    if (!match) continue;
    const bytes = entries.get(match);
    const blob = new Blob([bytes]);
    blob.name = note.title;
    await putFile(note.fileId, new File([bytes], note.title));
    result.files += 1;
  }

  return result;
}
