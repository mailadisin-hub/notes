/**
 * The note list for one folder, tag or smart folder.
 *
 * Everything on this screen is a re-render from the store rather than a
 * targeted DOM patch. A phone folder holds hundreds of notes at most, and
 * rebuilding is what makes pin, move, delete, sort and view switching all
 * behave identically without any of them having to know about the others.
 */

import {
  store, save, ALL, TRASH, TAG_PREFIX, SMART_PREFIX, uid,
  notesIn, noteById, folderName, isVirtual, plainText, displayTitle, snippetOf,
  shortStamp, sectionFor, daysLeftInTrash, attachmentCount, tagsOf, purgeNote, purgeNoteById,
  kindOfNote,
} from '../lib/store.js';
import {
  el, icon, pressable, longPress, navBar, backButton, navTextButton, navIconButton,
  bindScrollTitle, swipeRow, closeOpenSwipe, hasOpenSwipe, actionSheet, alert2,
  contextMenu, toast,
} from '../lib/ui.js';
import { push, pop, openDetail } from '../lib/router.js';
import { editorScreen } from './editor.js';
import { inkNoteScreen } from './inknote.js';
import { importFiles, openFileNote } from './files.js';
import { promptUnlock, ensurePasscode, isSealed, sealNote, unsealNote } from './lock.js';
import { shareNoteText, exportNoteFile } from '../lib/share.js';

export function listScreen(folderId) {
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body' });

  let query = '';
  let selecting = false;
  const selected = new Set();
  const isTrash = folderId === TRASH;
  const isTag = String(folderId).startsWith(TAG_PREFIX);

  const editBtn = navTextButton('Edit', () => toggleSelect(!selecting));
  const menuBtn = navIconButton('ellipsis', openMenu, 'More');

  const bar = navBar({
    left: [backButton('Folders', () => pop())],
    title: folderName(folderId),
    right: [menuBtn, editBtn],
  });

  /* ----------------------------------------------------------- toolbars */

  const countLabel = el('div', { class: 'toolbar-count' });
  const composeBtn = pressable(
    el('button', { class: 'compose', 'aria-label': 'New note' }, icon('compose')),
    () => openDetail(editorScreen(null, folderName(folderId), {
      fresh: true,
      folderId,
      seedTag: isTag ? String(folderId).slice(TAG_PREFIX.length) : null,
    })),
  );

  const inkBtn = pressable(
    el('button', { class: 'compose', 'aria-label': 'New handwritten note' }, icon('pen')),
    () => openDetail(inkNoteScreen(null, folderName(folderId), { folderId })),
  );

  const emptyTrashBtn = pressable(
    el('button', { class: 'toolbar-text danger', text: 'Delete All' }),
    emptyTrash,
  );

  const browseToolbar = el('footer', { class: 'toolbar' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'toolbar-left' }, isTrash ? emptyTrashBtn : []),
      countLabel,
      el('div', { class: 'toolbar-right' }, isTrash ? [] : [inkBtn, composeBtn])));

  const selCount = el('div', { class: 'toolbar-count' });
  const selectToolbar = el('footer', { class: 'toolbar', style: 'display:none' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'toolbar-left' },
        isTrash
          ? pressable(el('button', { class: 'toolbar-text', text: 'Recover' }), bulkRestore)
          : pressable(el('button', { class: 'toolbar-text', text: 'Move' }), bulkMove)),
      selCount,
      el('div', { class: 'toolbar-right' },
        isTrash
          ? pressable(el('button', { class: 'toolbar-text danger', text: 'Delete' }), bulkDelete)
          : [
            pressable(el('button', { class: 'toolbar-text', text: 'Pin' }), bulkPin),
            pressable(el('button', { class: 'toolbar-text danger', text: 'Delete' }), bulkDelete),
          ])));

  function toggleSelect(on) {
    selecting = on;
    selected.clear();
    editBtn.textContent = on ? 'Done' : 'Edit';
    editBtn.classList.toggle('strong', on);
    browseToolbar.style.display = on ? 'none' : '';
    selectToolbar.style.display = on ? '' : 'none';
    menuBtn.style.display = on ? 'none' : '';
    render();
  }

  /* ------------------------------------------------------- bulk actions */

  const selectedNotes = () => [...selected].map(noteById).filter(Boolean);

  function bulkPin() {
    const list = selectedNotes();
    if (!list.length) return;
    const anyUnpinned = list.some((n) => !n.pinned);
    list.forEach((n) => { n.pinned = anyUnpinned; });
    save();
    toggleSelect(false);
    toast(anyUnpinned ? 'Pinned' : 'Unpinned', { icon: 'pin' });
  }

  function bulkDelete() {
    const list = selectedNotes();
    if (!list.length) return;
    const n = list.length;
    if (isTrash) {
      alert2(`Delete ${n} Note${n === 1 ? '' : 's'}?`, 'This cannot be undone.', [
        { label: 'Cancel' },
        {
          label: 'Delete',
          destructive: true,
          onPick: () => {
            list.forEach(purgeNote);
            save();
            toggleSelect(false);
          },
        },
      ]);
      return;
    }
    list.forEach((x) => { x.deletedAt = Date.now(); x.pinned = false; });
    save();
    toggleSelect(false);
    toast(`${n} note${n === 1 ? '' : 's'} deleted`, { icon: 'trash' });
  }

  function bulkRestore() {
    const list = selectedNotes();
    if (!list.length) return;
    list.forEach((x) => { x.deletedAt = null; x.updatedAt = Date.now(); });
    save();
    toggleSelect(false);
    toast('Recovered', { icon: 'restore' });
  }

  function bulkMove() {
    const list = selectedNotes();
    if (!list.length) return;
    chooseFolder((target) => {
      list.forEach((x) => { x.folderId = target; });
      save();
      toggleSelect(false);
      toast(`Moved to ${folderName(target)}`, { icon: 'folder' });
    });
  }

  function chooseFolder(done) {
    actionSheet('Move to Folder', [
      ...store.folders.map((f) => ({ label: f.name, icon: 'folder', onPick: () => done(f.id) })),
      {
        label: 'New Folder...',
        icon: 'folder-new',
        onPick: () => alert2('New Folder', 'Enter a name for this folder.', [
          { label: 'Cancel' },
          {
            label: 'Save',
            strong: true,
            onPick: (name) => {
              if (!name) return;
              const f = { id: uid(), name, createdAt: Date.now() };
              store.folders.push(f);
              save();
              done(f.id);
            },
          },
        ], { input: '' }),
      },
    ]);
  }

  function emptyTrash() {
    const count = notesIn(TRASH).length;
    if (!count) { toast('Nothing to delete'); return; }
    alert2(`Delete ${count} Note${count === 1 ? '' : 's'}?`, 'This cannot be undone.', [
      { label: 'Cancel' },
      {
        label: 'Delete All',
        destructive: true,
        onPick: () => {
          notesIn(TRASH).forEach(purgeNote);
          save();
          render();
        },
      },
    ]);
  }

  /* -------------------------------------------------------------- menus */

  function openMenu() {
    actionSheet(null, [
      {
        label: store.settings.view === 'list' ? 'View as Gallery' : 'View as List',
        icon: store.settings.view === 'list' ? 'grid' : 'list',
        onPick: () => {
          store.settings.view = store.settings.view === 'list' ? 'gallery' : 'list';
          save();
          render();
        },
      },
      !isTrash ? { label: 'New Handwritten Note', icon: 'pen', onPick: () => openDetail(inkNoteScreen(null, folderName(folderId), { folderId })) } : null,
      !isTrash ? { label: 'Import Files...', icon: 'doc', sub: 'PDF, Markdown, pictures, anything', onPick: () => importFiles(folderId, render) } : null,
      { label: 'Select Notes', icon: 'check-circle', onPick: () => toggleSelect(true) },
      { label: 'Sort By...', icon: 'arrows', sub: sortLabel(), onPick: openSort },
      !isTrash && !isVirtual(folderId)
        ? { label: 'New Folder', icon: 'folder-new', onPick: () => toast('Create folders on the Folders screen') }
        : null,
      isTrash ? { label: 'Delete All', icon: 'trash', destructive: true, onPick: emptyTrash } : null,
    ]);
  }

  const SORTS = { edited: 'Date Edited', created: 'Date Created', title: 'Title' };
  const sortLabel = () => SORTS[store.settings.sort];

  function openSort() {
    actionSheet('Sort Notes By', Object.keys(SORTS).map((k) => ({
      label: SORTS[k],
      selected: store.settings.sort === k,
      onPick: () => { store.settings.sort = k; save(); render(); },
    })));
  }

  /* ------------------------------------------------------ note actions */

  function deleteNote(note) {
    note.deletedAt = Date.now();
    note.pinned = false;
    save();
    render();
    toast('Note deleted', { icon: 'trash' });
  }

  function purgeNote(note) {
    alert2('Delete Note?', 'This cannot be undone.', [
      { label: 'Cancel' },
      {
        label: 'Delete',
        destructive: true,
        onPick: () => {
          purgeNoteById(note.id);
          render();
        },
      },
    ]);
  }

  function duplicateNote(note) {
    const copy = {
      ...note,
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    store.notes.unshift(copy);
    save();
    render();
    toast('Duplicated', { icon: 'copy' });
  }

  function toggleLock(note) {
    ensurePasscode(async () => {
      if (note.locked) {
        await unsealNote(note);
        toast('Note unlocked', { icon: 'lock-open' });
      } else {
        await sealNote(note);
        toast('Note encrypted', { icon: 'lock' });
      }
      render();
    });
  }

  function noteMenuItems(note) {
    if (isTrash) {
      return [
        { label: 'Recover', icon: 'restore', onPick: () => { note.deletedAt = null; save(); render(); } },
        { label: 'Delete Permanently', icon: 'trash', destructive: true, onPick: () => purgeNote(note) },
      ];
    }
    const typed = kindOfNote(note) === 'text';
    return [
      { label: note.pinned ? 'Unpin Note' : 'Pin Note', icon: note.pinned ? 'pin-slash' : 'pin', onPick: () => { note.pinned = !note.pinned; save(); render(); } },
      typed ? { label: note.locked ? 'Remove Lock' : 'Lock Note', icon: note.locked ? 'lock-open' : 'lock', onPick: () => toggleLock(note) } : null,
      typed ? { label: 'Duplicate', icon: 'copy', onPick: () => duplicateNote(note) } : null,
      { label: 'Move to Folder...', icon: 'folder', onPick: () => chooseFolder((t) => { note.folderId = t; save(); render(); toast(`Moved to ${folderName(t)}`); }) },
      typed ? { label: 'Share', icon: 'share', onPick: () => shareNoteText(note) } : null,
      typed ? { label: 'Export as Text', icon: 'download', onPick: () => exportNoteFile(note) } : null,
      { label: 'Delete', icon: 'trash', destructive: true, onPick: () => deleteNote(note) },
    ];
  }

  function openNote(note) {
    const kind = kindOfNote(note);
    if (kind === 'ink') { openDetail(inkNoteScreen(note.id, folderName(folderId))); return; }
    if (kind === 'file') { openFileNote(note, folderName(folderId)); return; }
    const gated = isSealed(note);
    const go = () => openDetail(editorScreen(note.id, folderName(folderId)));
    if (gated) promptUnlock(note, go, render); else go();
  }

  /* --------------------------------------------------------------- data */

  function visibleNotes() {
    let list = notesIn(folderId);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((n) => {
        if (n.locked) return displayTitle(n).toLowerCase().includes(q);
        return plainText(n.html).toLowerCase().includes(q);
      });
    }
    const { sort } = store.settings;
    return [...list].sort((a, b) => {
      if (sort === 'title') return displayTitle(a).localeCompare(displayTitle(b));
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
  }

  function grouped(list) {
    const out = [];
    if (query) return [{ head: null, items: list }];

    const pinned = list.filter((n) => n.pinned);
    const rest = list.filter((n) => !n.pinned);
    if (pinned.length) out.push({ head: 'Pinned', pin: true, items: pinned });

    let current = null;
    for (const n of rest) {
      const key = isTrash
        ? 'Recently Deleted'
        : sectionFor(store.settings.sort === 'created' ? n.createdAt : n.updatedAt);
      if (!current || current.head !== key) {
        current = { head: key, items: [] };
        out.push(current);
      }
      current.items.push(n);
    }
    return out;
  }

  /* ----------------------------------------------------------- rendering */

  function highlight(text, q) {
    if (!q) return document.createTextNode(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    frag.append(text.slice(0, i));
    frag.append(el('mark', { class: 'hit', text: text.slice(i, i + q.length) }));
    frag.append(text.slice(i + q.length));
    return frag;
  }

  function buildRow(note) {
    const locked = isSealed(note);
    const stamp = isTrash
      ? `${daysLeftInTrash(note)} day${daysLeftInTrash(note) === 1 ? '' : 's'} left`
      : shortStamp(store.settings.sort === 'created' ? note.createdAt : note.updatedAt);

    const row = el('div', { class: 'row' });

    if (selecting) {
      row.classList.add('selectable');
      row.append(el('span', { class: 'sel-dot' }, icon('check')));
      if (selected.has(note.id)) row.classList.add('selected');
    }

    const kind = kindOfNote(note);
    row.append(el('div', { class: 'row-title' },
      locked ? icon('lock', 'row-lock') : null,
      kind === 'ink' ? icon('pen', 'row-kind') : kind === 'file' ? icon('doc', 'row-kind') : null,
      el('span', {}, highlight(displayTitle(note), query))));

    if (locked) {
      row.append(el('div', { class: 'row-sub' },
        el('span', { class: 'date', text: stamp }),
        el('span', { class: 'snippet', text: 'Locked' })));
    } else {
      const atts = attachmentCount(note);
      row.append(el('div', { class: 'row-sub' },
        el('span', { class: 'date', text: stamp }),
        el('span', { class: 'snippet' }, highlight(snippetOf(note) || 'No additional text', query))));
      const meta = el('div', { class: 'row-meta' });
      if (folderId === ALL && !isTrash) {
        meta.append(el('span', { class: 'row-chip' }, icon('folder'), el('span', { text: folderName(note.folderId) })));
      }
      if (atts) meta.append(el('span', { class: 'row-chip' }, icon('paperclip'), el('span', { text: String(atts) })));
      for (const t of tagsOf(note).slice(0, 3)) {
        meta.append(el('span', { class: 'row-chip tag' }, el('span', { text: `#${t}` })));
      }
      if (meta.children.length) row.append(meta);
    }

    const activate = () => {
      if (selecting) {
        if (selected.has(note.id)) { selected.delete(note.id); row.classList.remove('selected'); }
        else { selected.add(note.id); row.classList.add('selected'); }
        updateSelCount();
        return;
      }
      if (hasOpenSwipe()) { closeOpenSwipe(); return; }
      if (isTrash) {
        actionSheet(displayTitle(note), noteMenuItems(note));
        return;
      }
      openNote(note);
    };

    pressable(row, activate, { feedback: 'select' });
    if (!selecting) {
      longPress(row, () => contextMenu(row, noteMenuItems(note), { title: displayTitle(note) }));
    }

    if (selecting) return el('div', { class: 'swipe' }, row);

    const actions = isTrash
      ? [
        { label: 'Recover', icon: 'restore', cls: 'restore', onPick: () => { note.deletedAt = null; save(); render(); } },
        { label: 'Delete', icon: 'trash', cls: 'delete', onPick: () => purgeNote(note) },
      ]
      : [
        kindOfNote(note) === 'text'
          ? { label: note.locked ? 'Unlock' : 'Lock', icon: note.locked ? 'lock-open' : 'lock', cls: 'lock', onPick: () => toggleLock(note) }
          : null,
        { label: 'Move', icon: 'folder', cls: 'move', onPick: () => chooseFolder((t) => { note.folderId = t; save(); render(); toast(`Moved to ${folderName(t)}`); }) },
        { label: 'Delete', icon: 'trash', cls: 'delete', onPick: () => deleteNote(note) },
      ];

    const leading = isTrash ? null : {
      label: note.pinned ? 'Unpin' : 'Pin',
      icon: note.pinned ? 'pin-slash' : 'pin',
      cls: 'pin',
      onPick: () => { note.pinned = !note.pinned; save(); render(); },
    };

    return swipeRow(row, actions.filter(Boolean), { leading });
  }

  function buildTile(note) {
    const locked = isSealed(note);
    const card = el('div', { class: 'tile-card' });

    if (locked) {
      card.classList.add('locked');
      card.append(icon('lock', 'tc-lock'));
    } else if (kindOfNote(note) !== 'text') {
      card.classList.add('kind');
      card.append(icon(kindOfNote(note) === 'ink' ? 'pen' : 'doc', 'tc-kind'));
      card.append(el('div', { class: 'tc-body', text: snippetOf(note) }));
    } else {
      const lines = plainText(note.html).split('\n').filter((l) => l.trim());
      if (lines.length) card.append(el('div', { class: 'tc-title', text: lines[0] }));
      card.append(el('div', { class: 'tc-body', text: lines.slice(1, 24).join('\n') }));
    }
    if (note.pinned) card.append(icon('pin', 'tc-pin'));

    const tile = el('div', { class: 'tile' },
      card,
      el('div', {},
        el('div', { class: 'tile-name', text: displayTitle(note) }),
        el('div', { class: 'tile-date', text: shortStamp(note.updatedAt) })));

    pressable(tile, () => {
      if (selecting) {
        if (selected.has(note.id)) { selected.delete(note.id); tile.classList.remove('selected'); }
        else { selected.add(note.id); tile.classList.add('selected'); }
        updateSelCount();
        return;
      }
      if (isTrash) { actionSheet(displayTitle(note), noteMenuItems(note)); return; }
      openNote(note);
    }, { feedback: 'select' });

    longPress(tile, () => contextMenu(tile, noteMenuItems(note), { title: displayTitle(note) }));
    if (selecting && selected.has(note.id)) tile.classList.add('selected');
    return tile;
  }

  function updateSelCount() {
    const n = selected.size;
    selCount.textContent = n ? `${n} Note${n === 1 ? '' : 's'} Selected` : 'Select Notes';
  }

  function searchField() {
    const input = el('input', {
      type: 'search', placeholder: 'Search', value: query,
      autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Search notes',
    });
    const field = el('div', { class: `search${query ? ' has-text' : ''}` },
      icon('search'), input,
      el('button', { class: 'clear', 'aria-label': 'Clear search' }, icon('xfill')));
    const wrap = el('div', { class: `search-wrap${query ? ' searching' : ''}` },
      field,
      el('button', { class: 'search-cancel', text: 'Cancel' }));

    input.addEventListener('input', () => {
      query = input.value;
      field.classList.toggle('has-text', !!query);
      renderRows();
    });
    input.addEventListener('focus', () => wrap.classList.add('searching'));
    field.querySelector('.clear').addEventListener('click', () => {
      input.value = ''; query = '';
      field.classList.remove('has-text');
      renderRows();
      input.focus();
    });
    wrap.querySelector('.search-cancel').addEventListener('click', () => {
      input.value = ''; query = ''; input.blur();
      wrap.classList.remove('searching');
      field.classList.remove('has-text');
      renderRows();
    });
    return wrap;
  }

  const rowsHost = el('div', {});

  function renderRows() {
    rowsHost.innerHTML = '';
    const list = visibleNotes();
    countLabel.textContent = list.length
      ? `${list.length} Note${list.length === 1 ? '' : 's'}`
      : 'No Notes';

    if (!list.length) {
      rowsHost.append(el('div', { class: 'empty' },
        icon(query ? 'search' : isTrash ? 'trash' : 'compose'),
        el('h4', { text: query ? 'No Results' : isTrash ? 'No Deleted Notes' : 'No Notes' }),
        el('p', {
          text: query
            ? 'Try a different search.'
            : isTrash
              ? 'Notes you delete stay here for 30 days.'
              : 'Tap the compose button to start one.',
        })));
      return;
    }

    const gallery = store.settings.view === 'gallery' && !isTrash;

    for (const group of grouped(list)) {
      if (group.head) {
        rowsHost.append(el('div', { class: 'section-head' },
          group.pin ? icon('pin') : null, el('span', { text: group.head })));
      }
      if (gallery) {
        const grid = el('div', { class: 'gallery' });
        group.items.forEach((n) => grid.append(buildTile(n)));
        rowsHost.append(grid);
      } else {
        const block = el('div', { class: 'rows' });
        group.items.forEach((n) => block.append(buildRow(n)));
        rowsHost.append(block);
      }
    }
  }

  function render() {
    const scrollTop = body.scrollTop;
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: folderName(folderId) }));
    if (!selecting) body.append(searchField());
    body.append(rowsHost);
    renderRows();
    updateSelCount();
    bindScrollTitle(body, bar, body.querySelector('.large-title'));
    body.scrollTop = scrollTop;
  }

  screen.append(bar, body, browseToolbar, selectToolbar);
  screen.onReturn = render;
  render();
  return screen;
}
