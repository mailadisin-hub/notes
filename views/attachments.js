/**
 * Every photo and sketch across all notes, newest first.
 *
 * Reads IndexedDB directly instead of walking note markup: the store already
 * knows which note each file came from, and an orphan (its note deleted) is
 * worth showing so it can be cleared rather than hidden while it still costs
 * space.
 */

import { store, noteById, displayTitle, shortStamp } from '../lib/store.js';
import {
  el, icon, pressable, longPress, navBar, backButton, navTextButton,
  bindScrollTitle, overlay, alert2, contextMenu, toast,
} from '../lib/ui.js';
import { pop, push } from '../lib/router.js';
import { listAttachments, deleteAttachment, pruneOrphans } from '../lib/attachments.js';
import { inkImageAttachments } from '../lib/library.js';
import { editorScreen } from './editor.js';

export function attachmentsScreen() {
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body' });
  const urls = [];

  const bar = navBar({
    left: [backButton('Settings', () => pop())],
    title: 'Attachments',
    right: [navTextButton('Clean Up', cleanUp)],
  });

  async function cleanUp() {
    const removed = await pruneOrphans(store.notes.map((n) => n.html), await inkImageAttachments());
    toast(removed ? `Removed ${removed} unused file${removed === 1 ? '' : 's'}` : 'Nothing to clean up');
    render();
  }

  function viewer(record, url) {
    overlay((close) => {
      const img = el('img', { class: 'viewer-img', src: url, alt: '' });
      const bar2 = el('div', { class: 'viewer-bar' },
        el('button', { class: 'nav-btn', text: 'Close', onclick: close }),
        el('span', { class: 'viewer-title', text: record.kind === 'sketch' ? 'Sketch' : 'Photo' }),
        el('span', {}));
      return el('div', { class: 'viewer' }, bar2, el('div', { class: 'viewer-stage' }, img));
    });
  }

  function confirmDelete(record) {
    alert2('Delete Attachment?',
      'It is removed from the note as well. This cannot be undone.',
      [
        { label: 'Cancel' },
        {
          label: 'Delete',
          destructive: true,
          onPick: async () => {
            await deleteAttachment(record.id);
            /* The note keeps an <img> pointing at nothing otherwise. */
            for (const note of store.notes) {
              if (!note.html || !note.html.includes(record.id)) continue;
              const holder = document.createElement('div');
              holder.innerHTML = note.html;
              holder.querySelectorAll(`img[data-att="${record.id}"]`).forEach((n) => {
                const wrap = n.closest('.att-wrap');
                (wrap || n).remove();
              });
              note.html = holder.innerHTML;
            }
            const { save } = await import('../lib/store.js');
            save();
            render();
          },
        },
      ]);
  }

  async function render() {
    body.innerHTML = '';
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.length = 0;

    body.append(el('h1', { class: 'large-title', text: 'Attachments' }));
    const records = await listAttachments();

    if (!records.length) {
      body.append(el('div', { class: 'empty' },
        icon('photo'),
        el('h4', { text: 'No Attachments' }),
        el('p', { text: 'Photos and sketches you add to notes collect here.' })));
      bindScrollTitle(body, bar, body.querySelector('.large-title'));
      return;
    }

    const grid = el('div', { class: 'att-grid' });
    for (const record of records) {
      const url = URL.createObjectURL(record.blob);
      urls.push(url);

      const note = record.noteId ? noteById(record.noteId) : null;
      const orphan = !note || (note.html && !note.html.includes(record.id));

      const tile = el('div', { class: `att-tile${orphan ? ' orphan' : ''}` },
        el('img', { src: url, alt: '', loading: 'lazy' }),
        el('div', { class: 'att-meta' },
          el('span', { class: 'att-note', text: orphan ? 'Not in any note' : displayTitle(note) }),
          el('span', { class: 'att-date', text: shortStamp(record.createdAt) })),
        record.kind === 'sketch' ? icon('markup', 'att-kind') : null);

      pressable(tile, () => viewer(record, url), { feedback: 'select' });
      longPress(tile, () => contextMenu(tile, [
        !orphan && note
          ? { label: 'Open Note', icon: 'compose', onPick: () => push(editorScreen(note.id, 'Attachments')) }
          : null,
        { label: 'Delete', icon: 'trash', destructive: true, onPick: () => confirmDelete(record) },
      ].filter(Boolean), { title: record.kind === 'sketch' ? 'Sketch' : 'Photo' }));

      grid.append(tile);
    }
    body.append(grid);

    const bytes = records.reduce((s, r) => s + (r.blob ? r.blob.size : 0), 0);
    body.append(el('p', { class: 'settings-footnote' },
      el('span', {
        text: `${records.length} file${records.length === 1 ? '' : 's'} - ${
          bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`}`,
      })));

    bindScrollTitle(body, bar, body.querySelector('.large-title'));
  }

  screen.append(bar, body);
  screen.onReturn = render;
  screen.onLeave = () => urls.forEach((u) => URL.revokeObjectURL(u));
  render();
  return screen;
}
