/**
 * The note editor.
 *
 * The document is a single contenteditable, so the browser owns caret, IME,
 * selection and undo, and the app only ever reaches in to change block shape.
 * Two kinds of decoration are painted into that markup and must never reach
 * storage: tag pills and find-in-note highlights. Both are stripped in
 * cleanHtml(), which is the only function allowed to produce a value for
 * note.html.
 */

import {
  store, save, uid, noteById, newNote, folderName, displayTitle, plainText,
  longStamp, countsOf, markUnlocked, purgeNoteById,
} from '../lib/store.js';
import {
  el, icon, pressable, navBar, backButton, navTextButton, navIconButton,
  bindScrollTitle, actionSheet, alert2, overlay, toast,
} from '../lib/ui.js';
import { push, pop } from '../lib/router.js';
import { haptic } from '../lib/haptics.js';
import {
  compressImage, putAttachment, hydrateAttachments, stripAttachmentUrls,
  releaseAttachmentUrls,
} from '../lib/attachments.js';
import { shareNoteText, exportNoteFile } from '../lib/share.js';
import { ensurePasscode, readBody, resealNote, sealNote, unsealNote } from './lock.js';
import { markupSheet } from './markup.js';
import { backgroundSheet, backgroundLabel, TYPED_NAMES } from './background.js';

const TAG_RE = /(^|[\s(\[])#([\p{L}\p{N}_-]{1,40})/u;

export function editorScreen(noteId, backLabel, opts = {}) {
  const note = noteId ? noteById(noteId) : newNote(opts.folderId);
  const fresh = !!opts.fresh;
  if (!noteId) {
    note.draft = true;
    save();
  }

  const screen = el('section', { class: 'screen' });
  screen.dataset.pane = 'detail';
  const body = el('div', { class: 'body' });

  const content = el('div', {
    class: 'editor-content',
    contenteditable: 'true',
    'data-placeholder': 'Start writing...',
    spellcheck: 'false',
    'data-no-edge-swipe': true,
  });
  /* A locked note's body is ciphertext until the key decrypts it, so the
     editor fills in asynchronously rather than reading note.html directly. */
  let savedBody = '';
  readBody(note).then((body) => {
    savedBody = body;
    content.innerHTML = body || '<h1><br></h1>';
    hydrateAttachments(content);
    if (!fresh) decorateTags();
  });
  if (fresh && opts.seedTag) content.innerHTML = `<h1><br></h1><div>#${opts.seedTag}&nbsp;</div>`;

  const dateLine = el('div', { class: 'editor-date', text: longStamp(note.updatedAt) });
  const paper = el('div', { class: `editor-body paper-${note.paper || 'plain'}` }, dateLine, content);

  hydrateAttachments(content);

  /* ------------------------------------------------------------ nav bar */

  const doneBtn = navTextButton('Done', () => content.blur(), { strong: true });
  doneBtn.style.display = 'none';

  const bar = navBar({
    left: [backButton(backLabel, () => pop())],
    title: '',
    right: [
      doneBtn,
      navIconButton('share', () => { flush(); shareNoteText(note); }, 'Share'),
      navIconButton('ellipsis', openMenu, 'More'),
    ],
  });

  /* -------------------------------------------------------- persistence */

  let saveTimer = null;
  let suspendSave = false;

  /** The only place note.html is produced. Decoration never survives it. */
  function cleanHtml() {
    const holder = document.createElement('div');
    holder.innerHTML = content.innerHTML;
    holder.querySelectorAll('mark.find').forEach(unwrap);
    holder.querySelectorAll('span.tag-token').forEach(unwrap);
    return stripAttachmentUrls(holder.innerHTML);
  }

  function unwrap(node) {
    const parent = node.parentNode;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
    parent.normalize();
  }

  function flush() {
    if (suspendSave) return;
    const html = cleanHtml();
    if (html === savedBody) return;
    savedBody = html;
    resealNote(note, html);
    if (plainText(html).trim() || html.includes('data-att')) delete note.draft;
    note.updatedAt = Date.now();
    if (!save()) toast('Storage is full - free some space');
    dateLine.textContent = longStamp(note.updatedAt);
    bar.titleEl.textContent = displayTitle(note);
  }

  content.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 450);
  });

  screen.onLeave = () => {
    clearTimeout(saveTimer);
    closeFind({ silent: true });
    flush();
    releaseAttachmentUrls();
    /* An untouched brand-new note is discarded, exactly as iOS does. */
    if (!note.enc && !plainText(note.html).trim() && !note.html.includes('data-att')) {
      purgeNoteById(note.id);
    } else if (note.draft) {
      delete note.draft;
      save();
    }
  };

  /* ------------------------------------------------------ block helpers */

  function currentBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    while (node && node.parentNode !== content) node = node.parentNode;
    return node && node.nodeType === 1 ? node : null;
  }

  function placeCaret(node, atEnd = true) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!atEnd);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function makeCheckItem(text = '') {
    const item = el('div', { class: 'checkitem', 'data-done': '0' });
    const box = el('span', { class: 'box', contenteditable: 'false' }, icon('check'));
    const ct = el('span', { class: 'ct' });
    ct.textContent = text;
    if (!text) ct.append(el('br'));
    item.append(box, ct);
    return item;
  }

  content.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const block = currentBlock();
    if (!block) return;

    if (block.classList && block.classList.contains('checkitem')) {
      e.preventDefault();
      const ct = block.querySelector('.ct');
      if (!ct.textContent.trim()) {
        const plain = el('div', {}, el('br'));
        block.replaceWith(plain);
        placeCaret(plain, false);
        flush();
        return;
      }
      const next = makeCheckItem('');
      block.after(next);
      placeCaret(next.querySelector('.ct'), false);
      flush();
      return;
    }

    /* A title is one line. The next line drops back to body text. */
    if (/^H[1-3]$/.test(block.tagName)) {
      setTimeout(() => {
        const nb = currentBlock();
        if (nb && /^H[1-3]$/.test(nb.tagName) && !nb.textContent.trim()) {
          document.execCommand('formatBlock', false, 'div');
        }
      }, 0);
    }
  });

  content.addEventListener('pointerdown', (e) => {
    const box = e.target.closest && e.target.closest('.box');
    if (!box) return;
    e.preventDefault();
    const item = box.closest('.checkitem');
    item.dataset.done = item.dataset.done === '1' ? '0' : '1';
    haptic('toggle');
    flush();
  });

  content.addEventListener('focus', () => {
    doneBtn.style.display = '';
    undecorateTags();
  });

  content.addEventListener('blur', () => {
    doneBtn.style.display = 'none';
    flush();
    decorateTags();
  });

  /* ---------------------------------------------------------- tag pills */

  /**
   * Tags get a pill only while the editor is idle. Rewriting text nodes under
   * a live caret moves it to the wrong place mid-word, so decoration is put on
   * at blur and taken off again the moment focus returns.
   */
  function decorateTags() {
    if (findOpen) return;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('.tag-token, mark.find')) continue;
      if (TAG_RE.test(node.nodeValue)) targets.push(node);
    }
    for (const textNode of targets) wrapTagsIn(textNode);
  }

  function wrapTagsIn(textNode) {
    const text = textNode.nodeValue;
    const re = /(^|[\s(\[])#([\p{L}\p{N}_-]{1,40})/gu;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) frag.append(text.slice(last, start));
      frag.append(el('span', { class: 'tag-token', text: `#${m[2]}` }));
      last = start + m[2].length + 1;
    }
    if (!last) return;
    if (last < text.length) frag.append(text.slice(last));
    textNode.replaceWith(frag);
  }

  function undecorateTags() {
    content.querySelectorAll('span.tag-token').forEach(unwrap);
  }

  /* -------------------------------------------------------- formatting */

  function exec(command, value = null) {
    content.focus();
    document.execCommand(command, false, value);
    flush();
  }

  function applyBlockStyle(style) {
    const map = { title: 'h1', heading: 'h2', subheading: 'h3', body: 'div', mono: 'pre' };
    exec('formatBlock', map[style] || 'div');
  }

  function openFormat() {
    overlay((close) => {
      const block = currentBlock();
      const tag = block ? block.tagName.toLowerCase() : 'div';
      const activeStyle = { h1: 'title', h2: 'heading', h3: 'subheading', pre: 'mono' }[tag] || 'body';

      const styles = el('div', {});
      for (const [key, label] of [
        ['title', 'Title'], ['heading', 'Heading'], ['subheading', 'Subheading'],
        ['body', 'Body'], ['mono', 'Monostyled'],
      ]) {
        const row = el('button', {
          class: `fmt-style${key === activeStyle ? ' on' : ''}`,
          'data-style': key,
        }, el('span', { text: label }), icon('check'));
        row.addEventListener('click', () => { haptic('select'); applyBlockStyle(key); close(); });
        styles.append(row);
      }

      const inline = el('div', { class: 'fmt-seg' });
      for (const [cls, label, cmd] of [
        ['b', 'B', 'bold'], ['i', 'I', 'italic'],
        ['u', 'U', 'underline'], ['s', 'S', 'strikeThrough'],
      ]) {
        const b = el('button', { class: `fmt-btn ${cls}`, text: label });
        b.addEventListener('click', () => { haptic(); exec(cmd); });
        inline.append(b);
      }
      const hi = el('button', { class: 'fmt-btn highlight' }, icon('marker'));
      hi.addEventListener('click', () => {
        haptic();
        content.focus();
        document.execCommand('hiliteColor', false, 'rgba(255,204,0,.45)');
        flush();
      });
      inline.append(hi);

      const lists = el('div', { class: 'fmt-seg' });
      for (const [name, cmd, label] of [
        ['list-bullet', 'insertUnorderedList', 'Bulleted list'],
        ['list-number', 'insertOrderedList', 'Numbered list'],
        ['checklist', null, 'Checklist'],
        ['outdent', 'outdent', 'Outdent'],
        ['indent', 'indent', 'Indent'],
      ]) {
        const b = el('button', { class: 'fmt-btn', 'aria-label': label }, icon(name));
        b.addEventListener('click', () => {
          haptic();
          if (cmd) exec(cmd);
          else { insertChecklist(); close(); }
        });
        lists.append(b);
      }

      return el('div', { class: 'sheet' },
        el('div', { class: 'sheet-group' },
          el('div', { class: 'sheet-title' }, el('strong', { text: 'Format' })),
          el('div', { class: 'fmt' }, styles, inline, lists)));
    });
  }

  function insertChecklist() {
    content.focus();
    const block = currentBlock();
    const item = makeCheckItem(block ? block.textContent.trim() : '');
    if (block) block.replaceWith(item); else content.append(item);
    placeCaret(item.querySelector('.ct'), true);
    flush();
  }

  /* ------------------------------------------------------------ tables */

  function insertTable(rows = 2, cols = 2) {
    const table = el('table', { class: 'nt' });
    const tbody = el('tbody');
    for (let r = 0; r < rows; r += 1) {
      const tr = el('tr');
      for (let c = 0; c < cols; c += 1) tr.append(el('td', {}, el('br')));
      tbody.append(tr);
    }
    table.append(tbody);

    content.focus();
    const block = currentBlock();
    if (block && !block.textContent.trim()) block.replaceWith(table);
    else if (block) block.after(table);
    else content.append(table);

    const after = el('div', {}, el('br'));
    table.after(after);
    placeCaret(table.querySelector('td'), false);
    flush();
  }

  function tableAtCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    node = node.nodeType === 1 ? node : node.parentElement;
    return node ? node.closest('table.nt') : null;
  }

  function openTableMenu() {
    const table = tableAtCaret();
    if (!table) {
      actionSheet('Table', [
        { label: 'Insert 2 x 2', icon: 'table', onPick: () => insertTable(2, 2) },
        { label: 'Insert 3 x 3', icon: 'table', onPick: () => insertTable(3, 3) },
        { label: 'Insert 4 x 2', icon: 'table', onPick: () => insertTable(4, 2) },
      ]);
      return;
    }
    actionSheet('Table', [
      {
        label: 'Add Row',
        icon: 'plus',
        onPick: () => {
          const cols = table.rows[0] ? table.rows[0].cells.length : 2;
          const tr = el('tr');
          for (let c = 0; c < cols; c += 1) tr.append(el('td', {}, el('br')));
          table.tBodies[0].append(tr);
          flush();
        },
      },
      {
        label: 'Add Column',
        icon: 'plus',
        onPick: () => {
          [...table.rows].forEach((tr) => tr.append(el('td', {}, el('br'))));
          flush();
        },
      },
      {
        label: 'Delete Last Row',
        icon: 'minus-circle',
        onPick: () => {
          if (table.rows.length > 1) table.deleteRow(table.rows.length - 1);
          flush();
        },
      },
      {
        label: 'Delete Table',
        icon: 'trash',
        destructive: true,
        onPick: () => { table.remove(); flush(); },
      },
    ]);
  }

  /* ------------------------------------------------------- attachments */

  function insertImageBlob(blob, kind, dims = {}) {
    return (async () => {
      const id = await putAttachment(blob, { kind, noteId: note.id, ...dims });
      const img = el('img', { class: 'att', 'data-att': id, alt: kind === 'sketch' ? 'Sketch' : 'Photo' });
      const wrap = el('div', { class: 'att-wrap' }, img);

      content.focus();
      const block = currentBlock();
      if (block && !block.textContent.trim() && block.tagName !== 'TABLE') block.replaceWith(wrap);
      else if (block) block.after(wrap);
      else content.append(wrap);

      const after = el('div', {}, el('br'));
      wrap.after(after);
      await hydrateAttachments(content);
      placeCaret(after, false);
      flush();
      haptic('commit');
    })();
  }

  function pickPhoto({ camera = false } = {}) {
    const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    if (camera) input.setAttribute('capture', 'environment');
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const { blob, width, height } = await compressImage(file);
        await insertImageBlob(blob, 'photo', { width, height });
      } catch {
        toast('Could not read that image');
      }
    });
    input.click();
  }

  function openAttachMenu() {
    actionSheet('Add', [
      { label: 'Take Photo', icon: 'camera', onPick: () => pickPhoto({ camera: true }) },
      { label: 'Choose Photo', icon: 'photo', onPick: () => pickPhoto() },
      { label: 'Add Table', icon: 'table', onPick: openTableMenu },
    ]);
  }

  function openMarkup() {
    markupSheet(async (blob, dims) => {
      await insertImageBlob(blob, 'sketch', dims);
    });
  }

  /* ----------------------------------------------------- find in note */

  let findOpen = false;
  let findHits = [];
  let findIndex = 0;

  const findInput = el('input', {
    type: 'search', placeholder: 'Find in Note',
    autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
  });
  const findCount = el('span', { class: 'find-count', text: '' });
  const findBar = el('div', { class: 'find-bar' },
    el('div', { class: 'search' }, icon('search'), findInput, findCount),
    el('button', { class: 'find-nav', 'aria-label': 'Previous match' }, icon('chev-up')),
    el('button', { class: 'find-nav', 'aria-label': 'Next match' }, icon('chev-down')),
    el('button', { class: 'find-done', text: 'Done' }));
  findBar.style.display = 'none';

  function clearFindMarks() {
    content.querySelectorAll('mark.find').forEach(unwrap);
  }

  function applyFindMarks(query) {
    clearFindMarks();
    findHits = [];
    if (!query) { findCount.textContent = ''; return; }

    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.toLowerCase().includes(needle)) targets.push(node);
    }

    for (const textNode of targets) {
      const text = textNode.nodeValue;
      const frag = document.createDocumentFragment();
      let from = 0;
      let at = text.toLowerCase().indexOf(needle, from);
      while (at !== -1) {
        if (at > from) frag.append(text.slice(from, at));
        const mark = el('mark', { class: 'find', text: text.slice(at, at + query.length) });
        frag.append(mark);
        findHits.push(mark);
        from = at + query.length;
        at = text.toLowerCase().indexOf(needle, from);
      }
      if (from < text.length) frag.append(text.slice(from));
      textNode.replaceWith(frag);
    }

    findIndex = 0;
    updateFindState();
  }

  function updateFindState() {
    findHits.forEach((m, i) => m.classList.toggle('current', i === findIndex));
    findCount.textContent = findHits.length ? `${findIndex + 1}/${findHits.length}` : '0';
    const current = findHits[findIndex];
    if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function stepFind(delta) {
    if (!findHits.length) return;
    findIndex = (findIndex + delta + findHits.length) % findHits.length;
    haptic();
    updateFindState();
  }

  findInput.addEventListener('input', () => applyFindMarks(findInput.value.trim()));
  findBar.querySelectorAll('.find-nav')[0].addEventListener('click', () => stepFind(-1));
  findBar.querySelectorAll('.find-nav')[1].addEventListener('click', () => stepFind(1));
  findBar.querySelector('.find-done').addEventListener('click', () => closeFind());

  function openFind() {
    findOpen = true;
    suspendSave = true;
    undecorateTags();
    findBar.style.display = '';
    content.setAttribute('contenteditable', 'false');
    void findBar.offsetWidth;
    findBar.classList.add('show');
    findInput.focus();
  }

  function closeFind({ silent = false } = {}) {
    if (!findOpen) return;
    findOpen = false;
    clearFindMarks();
    findBar.classList.remove('show');
    findBar.style.display = 'none';
    content.setAttribute('contenteditable', 'true');
    suspendSave = false;
    if (!silent) decorateTags();
  }

  /* --------------------------------------------------------------- menu */

  function checklistItems() {
    return [...content.querySelectorAll('.checkitem')];
  }

  function openMenu() {
    flush();
    const checks = checklistItems();
    actionSheet(null, [
      { label: note.pinned ? 'Unpin Note' : 'Pin Note', icon: note.pinned ? 'pin-slash' : 'pin', onPick: () => { note.pinned = !note.pinned; save(); toast(note.pinned ? 'Pinned' : 'Unpinned', { icon: 'pin' }); } },
      { label: 'Find in Note', icon: 'search', onPick: openFind },
      { label: 'Background', icon: 'grid', sub: backgroundLabel(note.paper || 'plain', TYPED_NAMES), onPick: openPaper },
      checks.length ? { label: 'Checklist Actions', icon: 'checklist', onPick: openChecklistMenu } : null,
      { label: note.locked ? 'Remove Lock' : 'Lock Note', icon: note.locked ? 'lock-open' : 'lock', onPick: toggleLock },
      { label: 'Move Note...', icon: 'folder', onPick: moveNote },
      { label: 'Note Info', icon: 'info', onPick: openInfo },
      { label: 'Export as Text', icon: 'download', onPick: () => exportNoteFile(note) },
      { label: 'Delete', icon: 'trash', destructive: true, onPick: deleteNote },
    ]);
  }

  function openChecklistMenu() {
    actionSheet('Checklist', [
      {
        label: 'Move Checked to Bottom',
        icon: 'arrow-down',
        onPick: () => {
          const done = checklistItems().filter((i) => i.dataset.done === '1');
          done.forEach((i) => content.append(i));
          flush();
        },
      },
      {
        label: 'Mark All as Unchecked',
        icon: 'circle',
        onPick: () => {
          checklistItems().forEach((i) => { i.dataset.done = '0'; });
          flush();
        },
      },
      {
        label: 'Delete Checked Items',
        icon: 'trash',
        destructive: true,
        onPick: () => {
          checklistItems().filter((i) => i.dataset.done === '1').forEach((i) => i.remove());
          flush();
        },
      },
    ]);
  }

  function openPaper() {
    backgroundSheet(note.paper || 'plain', TYPED_NAMES, (k) => {
      note.paper = k;
      note.updatedAt = Date.now();
      paper.className = `editor-body paper-${k}`;
      save();
    });
  }

  function toggleLock() {
    ensurePasscode(async () => {
      flush();
      if (note.locked) {
        await unsealNote(note);
        toast('Lock removed', { icon: 'lock-open' });
      } else {
        note.html = savedBody;
        await sealNote(note);
        markUnlocked(note.id);
        toast('Note encrypted', { icon: 'lock' });
      }
    });
  }

  function moveNote() {
    actionSheet('Move to Folder', store.folders.map((f) => ({
      label: f.name,
      icon: 'folder',
      selected: note.folderId === f.id,
      onPick: () => { note.folderId = f.id; save(); toast(`Moved to ${f.name}`, { icon: 'folder' }); },
    })));
  }

  function openInfo() {
    const { words, characters } = countsOf(note);
    const atts = content.querySelectorAll('img[data-att]').length;
    alert2('Note Info',
      [
        `Created  ${longStamp(note.createdAt)}`,
        `Modified  ${longStamp(note.updatedAt)}`,
        `${words} word${words === 1 ? '' : 's'}, ${characters} character${characters === 1 ? '' : 's'}`,
        atts ? `${atts} attachment${atts === 1 ? '' : 's'}` : null,
        `Folder  ${folderName(note.folderId)}`,
      ].filter(Boolean).join('\n'),
      [{ label: 'Done', strong: true }]);
  }

  function deleteNote() {
    note.deletedAt = Date.now();
    note.pinned = false;
    save();
    screen.onLeave = () => releaseAttachmentUrls();
    pop();
    toast('Note deleted', { icon: 'trash' });
  }

  /* --------------------------------------------------------- toolbars */

  const toolbar = el('footer', { class: 'toolbar editor-toolbar' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'editor-tools' },
        pressable(el('button', { 'aria-label': 'Format' }, icon('aa')), openFormat),
        pressable(el('button', { 'aria-label': 'Checklist' }, icon('checklist')), insertChecklist),
        pressable(el('button', { 'aria-label': 'Table' }, icon('table')), openTableMenu),
        pressable(el('button', { 'aria-label': 'Markup' }, icon('markup')), openMarkup),
        pressable(el('button', { 'aria-label': 'Attach' }, icon('camera')), openAttachMenu),
        pressable(el('button', { 'aria-label': 'Undo' }, icon('undo')), () => exec('undo')),
        pressable(el('button', { 'aria-label': 'Redo' }, icon('redo')), () => exec('redo')))));

  body.append(paper);
  screen.append(bar, findBar, body, toolbar);
  bindScrollTitle(body, bar, null, { alwaysShowTitle: true });
  bar.titleEl.textContent = displayTitle(note);

  screen.onShow = () => {
    if (fresh) focusStart(); else decorateTags();
  };

  function focusStart() {
    content.focus();
    const first = content.firstElementChild;
    if (first) placeCaret(first, false);
  }

  if (fresh) setTimeout(focusStart, 420);
  else setTimeout(decorateTags, 60);

  return screen;
}
