/**
 * The earlier versions of a note, and the way back to one.
 *
 * Restoring never throws anything away: the note as it is now is kept first,
 * so going back is itself undoable. That is the whole reason this screen can
 * be used without thinking about it.
 */

import {
  el, icon, pressable, navBar, backButton, alert2, toast,
} from '../lib/ui.js';
import { pop } from '../lib/router.js';
import { store, save, noteById, plainText } from '../lib/store.js';
import { haptic } from '../lib/haptics.js';
import { versionsOf, keepVersion } from '../lib/history.js';

function when(at) {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export function historyScreen(noteId, backLabel = 'Note') {
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body' });
  const bar = navBar({ left: [backButton(backLabel, () => pop())], title: 'Earlier Versions', right: [] });

  function restore(version) {
    const note = noteById(noteId);
    if (!note) return toast('That note is gone');
    return alert2('Go Back to This Version?',
      `The note as it is now is kept as a version first, so you can come straight back to it.`, [
        { label: 'Cancel' },
        {
          label: 'Restore',
          strong: true,
          onPick: async () => {
            await keepVersion(note, { force: true });
            note.html = version.html;
            if (version.title) note.title = version.title;
            note.updatedAt = Date.now();
            save();
            haptic('commit');
            toast(`Back to ${when(version.at)}`);
            pop();
          },
        },
      ]);
  }

  async function render() {
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: 'Earlier Versions' }));

    const note = noteById(noteId);
    const versions = await versionsOf(noteId);

    if (!versions.length) {
      body.append(el('div', { class: 'empty' },
        icon('restore'),
        el('h4', { text: 'No Earlier Versions Yet' }),
        el('p', { text: 'A copy of this note is kept every few minutes while you are editing it. They show up here.' })));
      return;
    }

    const card = el('div', { class: 'group-card' });
    for (const version of versions) {
      const text = plainText(version.html).replace(/\s+/g, ' ').trim();
      const current = note && note.html === version.html;
      const row = el('div', { class: 'cell version-row' },
        el('span', { class: 'cell-name' },
          el('span', { class: 'version-when' },
            el('span', { text: when(version.at) }),
            current ? el('span', { class: 'version-now', text: 'Same as now' }) : null),
          el('span', { class: 'version-text', text: text.slice(0, 160) || 'Empty' }),
          el('span', { class: 'cell-sub', text: `${version.words} word${version.words === 1 ? '' : 's'}` })));
      if (!current) pressable(row, () => restore(version));
      card.append(row);
    }

    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: `${versions.length} kept` }),
      card,
      el('p', { class: 'group-foot', text: 'Versions are kept for 45 days, on this device.' })));
  }

  screen.append(bar, body);
  screen.onReturn = render;
  render();
  return screen;
}
