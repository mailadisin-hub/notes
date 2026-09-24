/**
 * A vault folder, browsed: its folders and files the way the Files app lists
 * them. Markdown, PDFs and pictures open in the reader - beside the list on a
 * tablet - and [[links]] inside a note follow through the rest of the vault.
 *
 * On a device that has the folder, it is listed afresh on every visit, so a
 * note Syncthing brought in a minute ago is simply there - and the account's
 * copy of the notes is refreshed in the background. On a device without it,
 * the same screen shows that copy, read-only, with a way to link the folder
 * if it turns out to be here after all.
 */

import {
  el, icon, pressable, navBar, backButton, navIconButton, bindScrollTitle,
  actionSheet, alert2, toast,
} from '../lib/ui.js';
import { push, pop, openDetail } from '../lib/router.js';
import { kindOf, extOf } from '../lib/library.js';
import { shortStamp } from '../lib/store.js';
import {
  listFolder, readText, readBlob, lookup, searchVault,
  removeVault, renameVault, repickVault, isAccessLost,
  isLinked, linkVault, setVaultCloud, mirrorVault, vaultSupported,
} from '../lib/vault.js';
import { pdfScreen } from './pdfview.js';
import { mdScreen } from './mdview.js';
import { imageScreen, fileLabel } from './files.js';

const SORT_KEY = 'notes.vaultSort';
const OPENABLE = new Set(['markdown', 'text', 'pdf', 'image']);
const READABLE = new Set(['markdown', 'text']);

const stripExt = (name) => name.replace(/\.(md|markdown)$/i, '');

/* When each vault last refreshed its account copy, so browsing in and out of
   folders does not rescan the whole vault each time. */
const MIRROR_EVERY_MS = 10 * 60 * 1000;
const lastMirror = new Map();
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Opens a vault file in whichever reader suits it. */
export async function openVaultFile(vault, file, backLabel, how = openDetail) {
  const kind = kindOf(file.name, file.type);
  if (READABLE.has(kind)) {
    const text = await readText(vault, file);
    how(mdScreen({
      text,
      title: stripExt(file.name),
      backLabel,
      plain: kind === 'text',
      ...linksFrom(vault, file.path),
    }));
  } else if (kind === 'pdf') {
    how(pdfScreen({ blob: await readBlob(vault, file), title: file.name.replace(/\.pdf$/i, ''), backLabel }));
  } else if (kind === 'image') {
    how(imageScreen({ blob: await readBlob(vault, file), title: file.name, backLabel }));
  } else {
    toast(`Notes cannot open .${extOf(file.name) || 'these'} files`);
  }
}

/** What a note read from [path] needs to follow its links and show its pictures. */
function linksFrom(vault, path) {
  return {
    resolve: async (target) => {
      const hit = await lookup(vault, target, path);
      if (!hit) return null;
      const kind = kindOf(hit.name, hit.type);
      if (READABLE.has(kind)) {
        return {
          title: stripExt(hit.name),
          text: await readText(vault, hit),
          plain: kind === 'text',
          ...linksFrom(vault, hit.path),
        };
      }
      if (OPENABLE.has(kind)) return { open: (backLabel) => openVaultFile(vault, hit, backLabel, push) };
      return null;
    },
    resolveImage: async (target) => {
      const hit = await lookup(vault, target, path);
      return hit ? URL.createObjectURL(await readBlob(vault, hit)) : null;
    },
  };
}

/**
 * @param vault  a vault from lib/vault.js
 * @param folder {doc, name, path} of a folder inside it, or null for the top
 *               level; path is relative to the vault and ends in a slash
 */
export function vaultScreen(vault, folder = null, { backLabel = 'Folders' } = {}) {
  const screen = el('section', { class: 'screen grouped' });
  const body = el('div', { class: 'body' });
  const prefix = folder ? folder.path : '';
  const titleOf = () => (folder ? folder.name : vault.name);

  let items = null;
  let failure = null;
  let loadedAt = 0;
  const mirrorLine = el('p', { class: 'vault-status vault-mirror', hidden: true });
  let query = '';
  let elsewhere = null;
  let searchSeq = 0;
  let opening = false;
  let sort = localStorage.getItem(SORT_KEY) === 'modified' ? 'modified' : 'name';

  const bar = navBar({
    left: [backButton(backLabel, () => pop())],
    title: titleOf(),
    right: [navIconButton('ellipsis', openMenu, 'More')],
  });

  /* ----------------------------------------------------------- loading */

  async function load() {
    loadedAt = Date.now();
    try {
      items = await listFolder(vault, folder ? folder.doc : null);
      failure = null;
    } catch (err) {
      failure = err;
    }
    renderResults();
    if (!failure && !folder) refreshCopy();
  }

  /* A device that has the folder keeps the account copy current, quietly: a
     failure here costs other devices a fresher copy, never this screen. */
  function refreshCopy(force = false) {
    if (!isLinked(vault) || vault.cloud === false) return;
    if (!force && Date.now() - (lastMirror.get(vault.id) || 0) < MIRROR_EVERY_MS) return;
    lastMirror.set(vault.id, Date.now());
    const show = (text) => {
      mirrorLine.textContent = text;
      mirrorLine.hidden = !text;
    };
    const run = mirrorVault(vault, (done, total) => {
      if (total > 20) show(`Saving a copy for your other devices... ${Math.round((done / total) * 100)}%`);
    });
    run.then((result) => {
      if (!result) return show('');
      show(result.uploaded ? 'Copy saved for your other devices' : '');
      setTimeout(() => show(''), 3000);
    }).catch(() => {
      lastMirror.delete(vault.id);
      show('');
    });
  }

  /* A vault known from another device, linked to its folder on this one:
     the same screen carries on, now reading the folder itself. */
  async function useThisFolder() {
    try {
      const linked = await linkVault(vault);
      if (!linked) return;
      vault = linked;
      items = null;
      failure = null;
      render();
      load();
    } catch (err) {
      toast(String((err && err.message) || err));
    }
  }

  function failed(err, what) {
    if (isAccessLost(err)) {
      alert2('Folder Access Lost', `Android no longer lets Notes read "${vault.name}". Choose the folder again to carry on.`, [
        { label: 'Cancel' },
        { label: 'Choose Folder', strong: true, onPick: repick },
      ]);
      return;
    }
    toast(what);
  }

  async function repick() {
    try {
      if (await repickVault(vault)) {
        if (folder) pop();
        else load();
      }
    } catch (err) {
      toast(String((err && err.message) || err));
    }
  }

  /* ------------------------------------------------------------ opening */

  async function open(file, node) {
    const kind = kindOf(file.name, file.type);
    if (!OPENABLE.has(kind)) {
      toast(`Notes cannot open .${extOf(file.name) || 'these'} files`);
      return;
    }
    if (opening) return;
    opening = true;
    node.classList.add('busy');
    try {
      await openVaultFile(vault, file, titleOf());
    } catch (err) {
      failed(err, `Could not open ${file.name}`);
    } finally {
      opening = false;
      node.classList.remove('busy');
    }
  }

  function openFolder(it) {
    push(vaultScreen(vault, { doc: it.doc, name: it.name, path: `${prefix}${it.name}/` }, { backLabel: titleOf() }));
  }

  /* -------------------------------------------------------------- menus */

  function openMenu() {
    const linked = isLinked(vault);
    actionSheet(null, [
      { label: 'Sort By...', icon: 'arrows', sub: sort === 'name' ? 'Name' : 'Date Modified', onPick: openSort },
      { label: 'Refresh', icon: 'restore', onPick: () => { load(); if (linked) refreshCopy(true); } },
      !linked && vaultSupported()
        ? { label: "Use This Device's Folder", icon: 'folder', sub: 'Read the folder itself instead of the copy', onPick: useThisFolder }
        : null,
      !folder && linked ? {
        label: 'Keep a Copy in Your Account',
        icon: 'cloud',
        sub: vault.cloud === false ? 'Off' : 'On - your other devices can read it',
        onPick: toggleCopy,
      } : null,
      folder ? null : { label: 'Rename', icon: 'pencil', sub: 'Only in Notes; the folder keeps its name', onPick: rename },
      folder ? null : {
        label: 'Remove from Notes',
        icon: 'minus-circle',
        destructive: true,
        sub: 'On all your devices; the folder is not touched',
        onPick: remove,
      },
    ]);
  }

  function toggleCopy() {
    if (vault.cloud === false) {
      setVaultCloud(vault, true).then(() => refreshCopy(true));
      toast('Saving a copy for your other devices');
      return;
    }
    alert2('Stop Keeping a Copy?', 'The copy is deleted from your account. Other devices will no longer see this vault\'s notes.', [
      { label: 'Cancel' },
      {
        label: 'Delete Copy',
        destructive: true,
        onPick: async () => {
          await setVaultCloud(vault, false);
          toast('Copy deleted');
        },
      },
    ]);
  }

  function openSort() {
    actionSheet('Sort By', [['name', 'Name'], ['modified', 'Date Modified']].map(([k, label]) => ({
      label,
      selected: sort === k,
      onPick: () => {
        sort = k;
        try { localStorage.setItem(SORT_KEY, k); } catch { /* ignore */ }
        renderResults();
      },
    })));
  }

  function rename() {
    alert2('Rename', 'The name this folder has in Notes.', [
      { label: 'Cancel' },
      {
        label: 'Save',
        strong: true,
        onPick: (name) => {
          if (!name) return;
          renameVault(vault, name);
          bar.titleEl.textContent = name;
          render();
        },
      },
    ], { input: vault.name });
  }

  function remove() {
    alert2(`Remove "${vault.name}"?`, 'Removes it from Notes on all your devices, along with the copy in your account. The folder and its files are not touched.', [
      { label: 'Cancel' },
      {
        label: 'Remove',
        destructive: true,
        onPick: async () => {
          await removeVault(vault);
          pop();
        },
      },
    ]);
  }

  /* ------------------------------------------------------------- search */

  const input = el('input', {
    type: 'search', placeholder: 'Search', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Search this folder',
  });
  const field = el('div', { class: 'search' },
    icon('search'), input,
    el('button', { class: 'clear', 'aria-label': 'Clear search' }, icon('xfill')));
  const cancel = el('button', { class: 'search-cancel', text: 'Cancel' });
  const search = el('div', { class: 'search-wrap' }, field, cancel);

  let searchTimer = null;
  function setQuery(q) {
    query = q;
    field.classList.toggle('has-text', !!q);
    elsewhere = null;
    clearTimeout(searchTimer);
    renderResults();
    if (q.trim().length < 2) return;
    // The whole-vault search waits for a pause in typing; the first one walks
    // every folder, which on a big vault is a second or two.
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      try {
        const hits = await searchVault(vault, q);
        if (seq !== searchSeq) return;
        const here = prefix.toLowerCase();
        elsewhere = hits.filter((f) => !(f.path.toLowerCase().startsWith(here) && !f.path.slice(here.length).includes('/')));
      } catch (err) {
        if (seq !== searchSeq) return;
        elsewhere = [];
      }
      renderResults();
    }, 220);
  }

  input.addEventListener('input', () => setQuery(input.value));
  input.addEventListener('focus', () => search.classList.add('searching'));
  field.querySelector('.clear').addEventListener('click', () => {
    input.value = '';
    setQuery('');
    input.focus();
  });
  cancel.addEventListener('click', () => {
    input.value = '';
    input.blur();
    search.classList.remove('searching');
    setQuery('');
  });

  /* ---------------------------------------------------------- rendering */

  function folderCell(it) {
    const node = el('div', { class: 'cell' },
      icon('folder', 'lead'),
      el('span', { class: 'cell-name' }, el('span', { text: it.name })),
      icon('chev-right', 'chev'));
    pressable(node, () => openFolder(it));
    return node;
  }

  function fileCell(file, sub) {
    const kind = kindOf(file.name, file.type);
    const node = el('div', { class: `cell file${OPENABLE.has(kind) ? '' : ' dim'}` },
      icon(kind === 'image' ? 'photo' : 'doc', 'lead'),
      el('span', { class: 'cell-name' },
        el('span', { text: kind === 'markdown' ? stripExt(file.name) : file.name }),
        el('span', { class: 'cell-sub', text: sub })));
    pressable(node, () => open(file, node));
    return node;
  }

  const describe = (it) => [
    it.modified ? shortStamp(it.modified) : null,
    fileLabel(it.name, it.type, Math.max(0, it.size)),
  ].filter(Boolean).join(' · ');

  function sorted(list) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const dirs = list.filter((it) => it.dir).sort(byName);
    const files = list.filter((it) => !it.dir)
      .sort(sort === 'modified' ? (a, b) => b.modified - a.modified || byName(a, b) : byName);
    return [...dirs, ...files];
  }

  const results = el('div', {});

  function group(label, cells) {
    return el('div', { class: 'group' },
      label ? el('div', { class: 'group-label', text: label }) : null,
      el('div', { class: 'group-card' }, cells));
  }

  function renderResults() {
    results.innerHTML = '';

    if (failure && !items) {
      const lost = isAccessLost(failure);
      results.append(el('div', { class: 'empty' },
        icon('folder'),
        el('h4', { text: lost ? 'Folder Access Lost' : 'Could Not Open' }),
        el('p', {
          text: lost
            ? 'Android no longer lets Notes read this folder. It may have been moved or renamed.'
            : String(failure.message || failure),
        }),
        lost ? pressable(el('button', { class: 'vault-retry', text: 'Choose Folder Again' }), repick) : null));
      return;
    }
    if (!items) {
      results.append(el('p', { class: 'vault-status', text: 'Loading...' }));
      return;
    }

    const q = query.trim().toLowerCase();
    const list = sorted(q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items);
    const copy = !isLinked(vault);

    if (copy && !folder && !q) {
      const card = el('div', { class: 'group-card' },
        el('div', { class: 'cell' },
          icon('cloud', 'lead'),
          el('span', { class: 'cell-name' },
            el('span', { text: 'Copy From Your Other Devices' }),
            el('span', { class: 'cell-sub', text: 'Read-only copy of the notes. Pictures and PDFs stay on the device with the folder.' }))));
      if (vaultSupported()) {
        const link = el('div', { class: 'cell action' },
          icon('folder', 'lead'),
          el('span', { class: 'cell-name', text: "Use This Device's Folder" }));
        pressable(link, useThisFolder);
        card.append(link);
      }
      results.append(el('div', { class: 'group vault-info' }, card));
    }

    if (!q) {
      if (!list.length && copy) {
        results.append(el('div', { class: 'empty' },
          icon('cloud'),
          el('h4', { text: 'Nothing Here Yet' }),
          el('p', { text: 'Open this vault once on the device that has the folder, and its notes will appear here.' })));
        return;
      }
      if (!list.length) {
        results.append(el('div', { class: 'empty' },
          icon('folder'),
          el('h4', { text: 'Empty Folder' }),
          el('p', { text: 'Files added to this folder on any device show up here.' })));
        return;
      }
      results.append(group(null, list.map((it) => (it.dir ? folderCell(it) : fileCell({ ...it, path: `${prefix}${it.name}` }, describe(it))))));
      return;
    }

    if (list.length) {
      results.append(group(folder ? 'In This Folder' : null,
        list.map((it) => (it.dir ? folderCell(it) : fileCell({ ...it, path: `${prefix}${it.name}` }, describe(it))))));
    }
    if (q.length >= 2) {
      if (elsewhere === null) {
        results.append(el('p', { class: 'vault-status', text: `Searching ${vault.name}...` }));
      } else if (elsewhere.length) {
        results.append(group(`Elsewhere in ${vault.name}`,
          elsewhere.map((f) => fileCell(f, dirOf(f.path) || vault.name))));
      }
    }
    if (!list.length && (q.length < 2 || (elsewhere && !elsewhere.length))) {
      results.append(el('div', { class: 'empty' },
        icon('search'),
        el('h4', { text: 'No Results' }),
        el('p', { text: 'Search matches file names, not what is inside them.' })));
    }
  }

  function render() {
    const scrollTop = body.scrollTop;
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: titleOf() }), search, mirrorLine, results);
    renderResults();
    bindScrollTitle(body, bar, body.querySelector('.large-title'));
    body.scrollTop = scrollTop;
  }

  screen.append(bar, body);
  // Coming back to the list (or, beside a note, the note changing) lists the
  // folder again - cheap, and it is how new files arrive - but not on every
  // tap in a row.
  screen.onReturn = () => {
    if (Date.now() - loadedAt > 3000) load();
  };
  render();
  load();
  return screen;
}
