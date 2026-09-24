/**
 * The root screen: folders, shared pages, vault folders on the device, smart
 * folders and the tag cloud.
 *
 * Tags are not stored anywhere - they are read back out of the note text every
 * time this screen renders. That keeps a tag from outliving the word that
 * created it, at the cost of a full text scan, which is nothing at the scale
 * one phone reaches.
 */

import {
  store, save, uid, ALL, TRASH, TAG_PREFIX, SMART_PREFIX,
  notesIn, allTags, firstRealFolder, folderName, defaultStore, reorderFolders,
} from '../lib/store.js';
import {
  el, icon, pressable, longPress, navBar, navTextButton, navIconButton,
  bindScrollTitle, alert2, overlay, contextMenu, toast,
} from '../lib/ui.js';
import { push, openDetail } from '../lib/router.js';
import { haptic } from '../lib/haptics.js';
import { listScreen } from './list.js';
import { editorScreen } from './editor.js';
import { settingsScreen } from './settings.js';
import { vaultScreen } from './vault.js';
import { sharedListScreen } from './shared.js';
import { cachedBoards } from '../lib/shared.js';
import { vaultSupported, vaults, addVault, removeVault, renameVault } from '../lib/vault.js';

export function foldersScreen() {
  const screen = el('section', { class: 'screen grouped' });
  const body = el('div', { class: 'body' });
  let editing = false;

  const editBtn = navTextButton('Edit', () => {
    editing = !editing;
    editBtn.textContent = editing ? 'Done' : 'Edit';
    editBtn.classList.toggle('strong', editing);
    render();
  });

  const bar = navBar({
    left: [navIconButton('gear', () => push(settingsScreen()), 'Settings')],
    title: 'Folders',
    right: [editBtn],
  });

  const toolbar = el('footer', { class: 'toolbar' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'toolbar-left' },
        pressable(el('button', { 'aria-label': 'New folder' }, icon('folder-new')), promptNewFolder)),
      el('div', { class: 'toolbar-count' }),
      el('div', { class: 'toolbar-right' },
        pressable(el('button', { class: 'compose', 'aria-label': 'New note' }, icon('compose')), composeHere))));

  function composeHere() {
    const folder = firstRealFolder();
    push(listScreen(folder));
    setTimeout(() => openDetail(editorScreen(null, folderName(folder), { fresh: true, folderId: folder })), 60);
  }

  /* ------------------------------------------------------------ folders */

  function promptNewFolder() {
    alert2('New Folder', 'Enter a name for this folder.', [
      { label: 'Cancel' },
      {
        label: 'Save',
        strong: true,
        onPick: (name) => {
          if (!name) return;
          store.folders.push({ id: uid(), name, createdAt: Date.now() });
          save();
          render();
        },
      },
    ], { input: '', placeholder: 'Name' });
  }

  function renameFolder(f) {
    alert2('Rename Folder', 'Enter a new name for this folder.', [
      { label: 'Cancel' },
      {
        label: 'Save',
        strong: true,
        onPick: (name) => { if (name) { f.name = name; save(); render(); } },
      },
    ], { input: f.name });
  }

  function deleteFolder(f) {
    const count = notesIn(f.id).length;
    alert2(`Delete "${f.name}"?`,
      count
        ? `${count} note${count === 1 ? '' : 's'} will be moved to Recently Deleted.`
        : 'This folder will be deleted.',
      [
        { label: 'Cancel' },
        {
          label: 'Delete',
          destructive: true,
          onPick: () => {
            const now = Date.now();
            store.notes.forEach((n) => { if (n.folderId === f.id && !n.deletedAt) n.deletedAt = now; });
            store.folders = store.folders.filter((x) => x.id !== f.id);
            if (!store.folders.length) store.folders = defaultStore().folders;
            save();
            render();
          },
        },
      ]);
  }

  /* ------------------------------------------------------------- vaults */

  async function openFolderPicker() {
    try {
      const v = await addVault();
      if (!v) return;
      render();
      push(vaultScreen(v));
    } catch (err) {
      toast(String((err && err.message) || err || 'Could not open that folder'));
    }
  }

  function renameVaultPrompt(v) {
    alert2('Rename', 'The name this folder has in Notes.', [
      { label: 'Cancel' },
      { label: 'Save', strong: true, onPick: (name) => { if (name) { renameVault(v, name); render(); } } },
    ], { input: v.name });
  }

  function removeVaultPrompt(v) {
    alert2(`Remove "${v.name}"?`, 'Removes it from Notes on all your devices, along with the copy in your account. The folder and its files are not touched.', [
      { label: 'Cancel' },
      { label: 'Remove', destructive: true, onPick: async () => { await removeVault(v); render(); } },
    ]);
  }

  /* ------------------------------------------------------ smart folders */

  function newSmartFolder(preselected = []) {
    const tags = allTags();
    if (!tags.length) {
      toast('Add a #tag to a note first');
      return;
    }
    const chosen = new Set(preselected);

    const close = actionSheetLike(chosen, tags, (match) => {
      alert2('Smart Folder', 'Name this Smart Folder.', [
        { label: 'Cancel' },
        {
          label: 'Save',
          strong: true,
          onPick: (name) => {
            if (!name || !chosen.size) return;
            store.smartFolders.push({
              id: uid(), name, tags: [...chosen], match, createdAt: Date.now(),
            });
            save();
            render();
          },
        },
      ], { input: [...chosen].map((t) => `#${t}`).join(' ') });
    });
    return close;
  }

  /** A multi-select sheet; the built-in actionSheet closes on the first pick. */
  function actionSheetLike(chosen, tags, done) {
    return overlay((close) => {
      const group = el('div', { class: 'sheet-group' });
      group.append(el('div', { class: 'sheet-title' },
        el('strong', { text: 'Include Tags' }),
        el('span', { text: 'Notes carrying these tags appear in the folder.' })));

      let match = 'any';
      const matchRow = el('div', { class: 'seg' });
      for (const [key, label] of [['any', 'Any tag'], ['all', 'All tags']]) {
        const b = el('button', { class: `seg-btn${key === match ? ' on' : ''}`, text: label });
        b.addEventListener('click', () => {
          match = key;
          matchRow.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
        });
        matchRow.append(b);
      }
      group.append(el('div', { class: 'sheet-pad' }, matchRow));

      const cloud = el('div', { class: 'tag-cloud in-sheet' });
      for (const t of tags) {
        const chip = el('button', {
          class: `tag-chip${chosen.has(t.name) ? ' on' : ''}`,
        }, icon('tag'), el('span', { text: t.name }), el('small', { text: String(t.count) }));
        chip.addEventListener('click', () => {
          if (chosen.has(t.name)) chosen.delete(t.name); else chosen.add(t.name);
          chip.classList.toggle('on');
        });
        cloud.append(chip);
      }
      group.append(el('div', { class: 'sheet-pad' }, cloud));

      const actions = el('div', { class: 'sheet-group' },
        el('button', {
          class: 'sheet-item cancel',
          text: 'Continue',
          onclick: () => { close(); setTimeout(() => done(match), 140); },
        }));
      return el('div', { class: 'sheet' }, group, actions);
    });
  }

  function deleteSmart(f) {
    alert2(`Delete "${f.name}"?`, 'The notes inside are not affected.', [
      { label: 'Cancel' },
      {
        label: 'Delete',
        destructive: true,
        onPick: () => {
          store.smartFolders = store.smartFolders.filter((x) => x.id !== f.id);
          save();
          render();
        },
      },
    ]);
  }

  /* ----------------------------------------------------- drag to reorder */

  /**
   * Edit mode shows a grip on every folder, so the grip has to actually drag.
   * Rows are reordered in the DOM as the finger passes each neighbour's
   * midpoint, and the store is rewritten from that order on release - which
   * means the thing you see is the thing that gets saved, with no parallel
   * index to keep in step.
   */
  function makeReorderable(card) {
    let dragEl = null;
    let startY = 0;

    const onMove = (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const y = e.clientY;
      dragEl.style.transform = `translateY(${y - startY}px)`;

      const dr = dragEl.getBoundingClientRect();
      const dragMid = dr.top + dr.height / 2;

      for (const sib of card.querySelectorAll('.cell[data-fid]')) {
        if (sib === dragEl) continue;
        const r = sib.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const dragIsAfter = !!(sib.compareDocumentPosition(dragEl) & Node.DOCUMENT_POSITION_FOLLOWING);

        if (dragMid < mid && dragIsAfter) sib.before(dragEl);
        else if (dragMid > mid && !dragIsAfter) sib.after(dragEl);
        else continue;

        /* The node just moved by roughly one row, so rebase the drag offset
           or it would jump out from under the finger. */
        startY = y;
        dragEl.style.transform = '';
        haptic('select');
        break;
      }
    };

    const onEnd = () => {
      if (!dragEl) return;
      dragEl.style.transform = '';
      dragEl.classList.remove('dragging');
      dragEl = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      reorderFolders([...card.querySelectorAll('.cell[data-fid]')].map((n) => n.dataset.fid));
    };

    card.querySelectorAll('.grip-handle').forEach((grip) => {
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragEl = grip.closest('.cell');
        startY = e.clientY;
        dragEl.classList.add('dragging');
        haptic('commit');
        document.addEventListener('pointermove', onMove, { passive: false });
        document.addEventListener('pointerup', onEnd);
        document.addEventListener('pointercancel', onEnd);
      });
    });
  }

  /* ------------------------------------------------------------- render */

  function cell({ iconName, name, sub, count, onPick, extra, onHold, lead }) {
    const node = el('div', { class: 'cell' },
      lead || icon(iconName, 'lead'),
      sub
        ? el('span', { class: 'cell-name' }, el('span', { text: name }), el('span', { class: 'cell-sub', text: sub }))
        : el('span', { class: 'cell-name', text: name }),
      count != null ? el('span', { class: 'cell-count', text: String(count) }) : null,
      extra || icon('chev-right', 'chev'));
    pressable(node, onPick);
    if (onHold) longPress(node, () => contextMenu(node, onHold(), { title: name }));
    return node;
  }

  function render() {
    const scrollTop = body.scrollTop;
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: 'Folders' }));

    /* --- on my phone --- */
    const card = el('div', { class: 'group-card' });
    card.append(cell({
      iconName: 'folder-stack',
      name: 'All Notes',
      count: notesIn(ALL).length,
      onPick: () => push(listScreen(ALL)),
    }));

    for (const f of store.folders) {
      if (editing) {
        const trash = el('button', { class: 'cell-trail danger', 'aria-label': `Delete ${f.name}` }, icon('minus-circle'));
        trash.addEventListener('click', (e) => { e.stopPropagation(); deleteFolder(f); });
        const grip = el('button', { class: 'grip-handle', 'aria-label': `Reorder ${f.name}` }, icon('grip'));
        const node = el('div', { class: 'cell', 'data-fid': f.id },
          icon('folder', 'lead'),
          el('span', { class: 'cell-name', text: f.name }),
          trash,
          grip);
        pressable(node, () => renameFolder(f));
        card.append(node);
      } else {
        card.append(cell({
          iconName: 'folder',
          name: f.name,
          count: notesIn(f.id).length,
          onPick: () => push(listScreen(f.id)),
          onHold: () => [
            { label: 'Rename', icon: 'pencil', onPick: () => renameFolder(f) },
            { label: 'New Note', icon: 'compose', onPick: () => {
              push(listScreen(f.id));
              setTimeout(() => openDetail(editorScreen(null, f.name, { fresh: true, folderId: f.id })), 60);
            } },
            { label: 'Delete', icon: 'trash', destructive: true, onPick: () => deleteFolder(f) },
          ],
        }));
      }
    }

    const trashCount = notesIn(TRASH).length;
    card.append(cell({
      iconName: 'trash',
      name: 'Recently Deleted',
      count: trashCount || null,
      onPick: () => push(listScreen(TRASH)),
    }));

    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'On My Phone' }), card));
    if (editing) makeReorderable(card);

    /* --- pages written on together --- */
    const sharedCount = cachedBoards().length;
    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'Shared' }),
      el('div', { class: 'group-card' }, cell({
        iconName: 'people',
        name: 'Shared Pages',
        count: sharedCount || null,
        onPick: () => push(sharedListScreen()),
      }))));

    /* --- vaults: folders on a device, known on every device --- */
    const known = vaults();
    if (vaultSupported() || known.length) {
      const vaultCard = el('div', { class: 'group-card' });
      for (const v of known) {
        vaultCard.append(cell({
          iconName: 'vault',
          name: v.name,
          sub: v.tree ? 'On this device' : 'Copy from your other devices',
          onPick: () => push(vaultScreen(v)),
          onHold: () => [
            { label: 'Rename', icon: 'pencil', onPick: () => renameVaultPrompt(v) },
            { label: 'Remove from Notes', icon: 'minus-circle', destructive: true, onPick: () => removeVaultPrompt(v) },
          ],
        }));
      }
      if (vaultSupported()) {
        const add = el('div', { class: 'cell action' },
          icon('plus', 'lead'),
          el('span', { class: 'cell-name', text: known.length ? 'Open Another Folder...' : 'Open a Folder...' }));
        pressable(add, openFolderPicker);
        vaultCard.append(add);
      }
      body.append(el('div', { class: 'group' },
        el('div', { class: 'group-label', text: 'Vaults' }), vaultCard));
    }

    /* --- smart folders --- */
    if (store.smartFolders.length) {
      const smartCard = el('div', { class: 'group-card' });
      for (const f of store.smartFolders) {
        if (editing) {
          const trash = el('button', { class: 'cell-trail danger' }, icon('minus-circle'));
          trash.addEventListener('click', (e) => { e.stopPropagation(); deleteSmart(f); });
          const node = el('div', { class: 'cell' },
            icon('gear-folder', 'lead'),
            el('span', { class: 'cell-name', text: f.name }),
            trash);
          smartCard.append(node);
        } else {
          smartCard.append(cell({
            iconName: 'gear-folder',
            name: f.name,
            count: notesIn(SMART_PREFIX + f.id).length,
            onPick: () => push(listScreen(SMART_PREFIX + f.id)),
            onHold: () => [
              { label: 'Delete', icon: 'trash', destructive: true, onPick: () => deleteSmart(f) },
            ],
          }));
        }
      }
      body.append(el('div', { class: 'group' },
        el('div', { class: 'group-label', text: 'Smart Folders' }), smartCard));
    }

    /* --- tags --- */
    const tags = allTags();
    const cloud = el('div', { class: 'tag-cloud' });
    if (tags.length) {
      for (const t of tags) {
        const chip = el('button', { class: 'tag-chip' },
          icon('tag'), el('span', { text: t.name }), el('small', { text: String(t.count) }));
        pressable(chip, () => push(listScreen(TAG_PREFIX + t.name)));
        cloud.append(chip);
      }
    } else {
      cloud.append(el('p', { class: 'tag-empty', text: 'Type #something in a note and it shows up here.' }));
    }

    const tagGroup = el('div', { class: 'group' },
      el('div', { class: 'group-label' },
        el('span', { text: 'Tags' }),
        tags.length
          ? pressable(el('button', { class: 'group-action', text: 'New Smart Folder' }), () => newSmartFolder())
          : null),
      cloud);
    body.append(tagGroup);

    bindScrollTitle(body, bar, body.querySelector('.large-title'));
    body.scrollTop = scrollTop;
  }

  screen.append(bar, body, toolbar);
  screen.onReturn = render;
  render();
  return screen;
}
