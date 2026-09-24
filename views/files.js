/**
 * Imported files as notes: a PDF, a .md or anything else sits in a folder next
 * to typed and handwritten notes, and opens in the right viewer.
 *
 * The note record carries only the name, type and size; the file itself is a
 * Blob in lib/library.js. Imported files are local to the device - they are
 * marked localOnly so sync leaves them out rather than advertising a file the
 * other device can never open.
 */

import { el, actionSheet, toast, alert2, navBar, backButton } from '../lib/ui.js';
import { openDetail, pop } from '../lib/router.js';
import { save, newNote, uid, displayTitle, allNotes } from '../lib/store.js';
import { putFile, getFile, kindOf, formatSize, guessType, extOf } from '../lib/library.js';
import { pdfScreen } from './pdfview.js';
import { mdScreen } from './mdview.js';

const KIND_LABELS = { pdf: 'PDF', markdown: 'Markdown', text: 'Text', image: 'Image', other: 'File' };

export function fileLabel(name, type, size) {
  const kind = kindOf(name, type);
  const label = kind === 'other' ? (extOf(name).toUpperCase() || 'File') : KIND_LABELS[kind];
  return `${label} · ${formatSize(size)}`;
}

/** Opens the system file picker and files everything chosen into [folderId]. */
export function importFiles(folderId, onDone) {
  const input = el('input', { type: 'file', multiple: true, style: 'display:none' });
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.remove();
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      try {
        const fileId = uid();
        await putFile(fileId, file);
        const note = newNote(folderId);
        const type = file.type || guessType(file.name);
        Object.assign(note, {
          kind: 'file',
          title: file.name.replace(/\.[^.]+$/, ''),
          fileId,
          fileName: file.name,
          fileType: type,
          fileSize: file.size,
          fileLabel: fileLabel(file.name, type, file.size),
          localOnly: true,
          updatedAt: Date.now(),
        });
        added += 1;
      } catch {
        toast(`Could not import ${file.name}`);
      }
    }
    save();
    if (added) toast(added === 1 ? 'File added' : `${added} files added`);
    if (onDone) onDone(added);
  });
  document.body.append(input);
  input.click();
}

/** Opens a file note in whatever can show it. */
export async function openFileNote(note, backLabel) {
  const record = await getFile(note.fileId);
  if (!record || !record.blob) {
    alert2('File not on this device', 'Imported files stay on the device they were added on. '
      + 'Put files you want everywhere in a vault folder that Syncthing shares.', [{ label: 'OK', strong: true }]);
    return;
  }
  const kind = kindOf(record.name, record.type);
  const title = displayTitle(note);
  if (kind === 'pdf') {
    openDetail(pdfScreen({ blob: record.blob, title, backLabel }));
  } else if (kind === 'markdown' || kind === 'text') {
    const text = await record.blob.text();
    openDetail(mdScreen({
      text,
      title,
      backLabel,
      plain: kind === 'text',
      resolve: resolveImported,
      resolveImage: resolveImportedImage,
    }));
  } else if (kind === 'image') {
    openDetail(imageScreen({ blob: record.blob, title, backLabel }));
  } else {
    actionSheet(`${title}`, [
      { label: 'Save a Copy', icon: 'download', onPick: () => saveCopy(record) },
    ], { message: `Notes cannot show .${extOf(record.name) || 'this kind of'} files yet.` });
  }
}

/* [[Links]] between imported files resolve by file name, as Obsidian does. */
function findImported(target, kinds) {
  const want = String(target || '').toLowerCase().replace(/\.(md|markdown)$/, '');
  return allNotes().find((n) => n.kind === 'file' && !n.deletedAt
    && kinds.includes(kindOf(n.fileName, n.fileType))
    && ((n.fileName || '').toLowerCase().replace(/\.[^.]+$/, '') === want
      || (n.fileName || '').toLowerCase() === want));
}

async function resolveImported(target) {
  const note = findImported(target, ['markdown', 'text']);
  if (!note) return null;
  const record = await getFile(note.fileId);
  return record ? { title: displayTitle(note), text: await record.blob.text() } : null;
}

async function resolveImportedImage(target) {
  const name = String(target || '').split('/').pop();
  const note = allNotes().find((n) => n.kind === 'file' && (n.fileName || '').toLowerCase() === name.toLowerCase());
  if (!note) return null;
  const record = await getFile(note.fileId);
  return record ? URL.createObjectURL(record.blob) : null;
}

export function saveCopy(record) {
  const url = URL.createObjectURL(record.blob);
  const a = el('a', { href: url, download: record.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* A plain viewer for pictures, imported or in a vault: fit to width, pinch
   with the system. */

export function imageScreen({ blob, title, backLabel }) {
  const screen = el('section', { class: 'screen' });
  screen.dataset.pane = 'detail';
  const url = URL.createObjectURL(blob);
  const bar = navBar({ left: [backButton(backLabel || 'Back', () => pop())], title });
  bar.titleEl.classList.add('show');
  const img = el('img', { class: 'file-image', src: url, alt: title });
  screen.append(bar, el('div', { class: 'body file-image-body' }, img));
  screen.onLeave = () => URL.revokeObjectURL(url);
  return screen;
}
