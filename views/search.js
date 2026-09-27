/**
 * Search, over everything at once.
 *
 * Results arrive as they are found rather than all at the end, because the
 * parts are not equally quick: notes are in memory and answer instantly, vault
 * files come from a database, and a PDF has to be read the first time it is
 * searched. Waiting for the slowest of those before showing any of it would
 * make the whole thing feel as slow as its slowest part.
 */

import {
  el, icon, pressable, navBar, backButton, toast,
} from '../lib/ui.js';
import { pop, openDetail, push } from '../lib/router.js';
import { noteById } from '../lib/store.js';
import { searchEverything } from '../lib/search.js';

const LABELS = {
  note: { icon: 'doc', word: 'Note' },
  ink: { icon: 'pen', word: 'Handwritten' },
  file: { icon: 'paperclip', word: 'File' },
  pdf: { icon: 'doc', word: 'PDF' },
  vault: { icon: 'vault', word: 'Vault' },
};

export function searchScreen(backLabel = 'Folders') {
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body' });
  const bar = navBar({ left: [backButton(backLabel, () => pop())], title: 'Search', right: [] });

  const field = el('input', {
    type: 'search', placeholder: 'Notes, PDFs, vault files',
    autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Search everything',
  });
  /* The same field as the one on a folder, so search looks like search. */
  const wrap = el('div', { class: 'search-wrap' }, el('div', { class: 'search' }, icon('search'), field));
  const status = el('p', { class: 'search-status', hidden: true });
  const results = el('div', { class: 'search-results' });

  /* A search of a big library can match hundreds of things; building a row for
     every one of them is the freeze this app just stopped doing elsewhere. */
  const MOST_SHOWN = 120;
  let running = null;
  let shown = 0;
  let found = 0;

  function openResult(r) {
    if (r.kind === 'vault') {
      toast(`In ${r.where}: ${r.path || r.title}`);
      return;
    }
    const note = noteById(r.id);
    if (!note) return toast('That note is gone');
    if (r.kind === 'ink') {
      return import('./inknote.js').then((m) => openDetail(m.inkNoteScreen(note.id, 'Search')));
    }
    if (r.kind === 'pdf' || r.kind === 'file') {
      return import('./files.js').then((m) => m.openFileNote(note, 'Search'));
    }
    return import('./editor.js').then((m) => openDetail(m.editorScreen(note.id, 'Search')));
  }

  function addResult(r) {
    found += 1;
    if (shown >= MOST_SHOWN) {
      status.textContent = `${found} results, showing the first ${MOST_SHOWN}`;
      return;
    }
    shown += 1;
    const look = LABELS[r.kind] || LABELS.note;
    const row = el('div', { class: 'cell search-row' },
      icon(look.icon, 'lead'),
      el('span', { class: 'cell-name' },
        el('span', { class: 'search-title', text: r.title }),
        r.snippet
          ? el('span', { class: 'search-snip' },
            el('span', { text: r.snippet.before }),
            el('mark', { text: r.snippet.hit }),
            el('span', { text: r.snippet.after }))
          : el('span', { class: 'cell-sub', text: look.word }),
        el('span', { class: 'search-where', text: r.where })));
    pressable(row, () => openResult(r));
    results.append(row);
    status.textContent = `${found} result${found === 1 ? '' : 's'}`;
  }

  async function run() {
    if (running) running.abort();
    const controller = new AbortController();
    running = controller;
    results.innerHTML = '';
    shown = 0;
    found = 0;

    const q = field.value.trim();
    if (q.length < 2) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.textContent = 'Searching...';

    try {
      await searchEverything(q, {
        signal: controller.signal,
        onResult: (r) => { if (!controller.signal.aborted) addResult(r); },
      });
      if (controller.signal.aborted) return;
      status.textContent = found
        ? (found > shown ? `${found} results, showing the first ${shown}` : `${found} result${found === 1 ? '' : 's'}`)
        : 'Nothing found. PDFs are read the first time you search them, so try again in a moment.';
    } catch (err) {
      if (!controller.signal.aborted) status.textContent = String((err && err.message) || err);
    }
  }

  let typing = null;
  field.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(run, 160);
  });

  body.append(el('h1', { class: 'large-title', text: 'Search' }), wrap, status, results);
  screen.append(bar, body);
  screen.onShow = () => setTimeout(() => field.focus(), 320);
  return screen;
}
