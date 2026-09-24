/**
 * A handwritten note: one endless page you write on with a stylus.
 *
 * The page is 800 units wide on every device and scales to fit, so a note
 * written on the tablet reads the same on the phone - just smaller, until you
 * pinch. Strokes live in IndexedDB (lib/library.js); the note record in the
 * store carries only the title and the timestamps that drive the list and sync.
 * Pictures on the page are attachments, placed by position and size.
 */

import { el, actionSheet, toast, alert2 } from '../lib/ui.js';
import { pop } from '../lib/router.js';
import { store, save, newNote, noteById } from '../lib/store.js';
import { haptic } from '../lib/haptics.js';
import { getInk, putInk } from '../lib/library.js';
import { inkView } from '../lib/inkview.js';
import { inkChrome } from './inkchrome.js';
import { backgroundSheet, backgroundLabel, INK_NAMES } from './background.js';
import { pickPicture, placePicture, sharePage } from './pictures.js';
import { putAttachment, getAttachment } from '../lib/attachments.js';

export const PAGE_WIDTH = 800;

export const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

export function inkNoteScreen(noteId, backLabel, opts = {}) {
  const note = noteId ? noteById(noteId) : newNote(opts.folderId);
  if (!noteId) {
    note.kind = 'ink';
    note.title = '';
    note.draft = true;
    save();
  }
  const fresh = !noteId;

  const screen = el('section', { class: 'screen ink-screen' });
  screen.dataset.pane = 'detail';

  const page = { key: 'page', width: PAGE_WIDTH, height: 1400, minHeight: 1400, strokes: [], images: [], paper: 'plain' };
  let loaded = false;
  let dirty = false;

  const view = inkView({
    pages: [page],
    grow: true,
    sidePad: 0,
    topPad: 72,
    bottomPad: 120,
    dark: isDark,
    paper: () => page.paper,
    fingerDraws: () => !!store.settings.fingerDraws,
    onChange: () => {
      dirty = true;
      scheduleSave();
    },
    onHistory: () => chrome.sync(),
    onView: (v) => chrome.setView(v),
    imageFor: async (im) => {
      const rec = await getAttachment(im.att);
      return rec && rec.blob ? createImageBitmap(rec.blob) : null;
    },
  });

  /* ------------------------------------------------------------ chrome */

  const title = el('input', {
    class: 'ink-title',
    type: 'text',
    placeholder: 'Handwritten note',
    value: note.title || '',
    enterkeyhint: 'done',
    'aria-label': 'Title',
  });
  title.addEventListener('input', () => {
    note.title = title.value;
    if (note.title.trim()) delete note.draft;
    note.updatedAt = Date.now();
    save();
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });

  const chrome = inkChrome(view, {
    titleEl: title,
    onBack: () => pop(),
    onMenu: openMenu,
    pages: false,
    onImage: addPicture,
  });

  screen.append(el('div', { class: 'ink-stage' }, view.el, chrome.el));

  /* -------------------------------------------------------- persistence */

  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!loaded || !dirty) return;
    dirty = false;
    const at = await putInk(note.id, { strokes: page.strokes, paper: page.paper, images: page.images });
    note.updatedAt = at;
    note.inkAt = at;
    if (page.strokes.length || page.images.length) delete note.draft;
    if (!save()) toast('Storage is full - free some space');
  }

  getInk(note.id).then((ink) => {
    page.strokes = ink.strokes;
    page.images = ink.images;
    page.paper = ink.paper || store.settings.defaultPaper || 'plain';
    loaded = true;
    view.layout();
    chrome.sync();
  }).catch(() => {
    loaded = true;
    toast('Could not open this page');
  });

  /* A sync that brings this page's strokes from another device shows them
     straight away - unless there is writing here not yet saved, which then
     wins when it saves, as the later edit always does. */
  const onPulled = async (e) => {
    if (!loaded || dirty || !e.detail.ids.includes(note.id)) return;
    const ink = await getInk(note.id);
    if (dirty) return;
    page.strokes = ink.strokes;
    page.images = ink.images;
    page.paper = ink.paper || page.paper;
    view.clearHistory();
    view.refresh();
  };
  window.addEventListener('notes:ink-pulled', onPulled);

  /* ------------------------------------------------------------ menus */

  function openPaper() {
    backgroundSheet(page.paper, INK_NAMES, (k) => {
      page.paper = k;
      store.settings.defaultPaper = k;
      dirty = true;
      scheduleSave();
      view.redraw();
    });
  }

  function addPicture() {
    pickPicture(async ({ blob, width, height }) => {
      const att = await putAttachment(blob, { kind: 'photo', noteId: note.id, width, height });
      placePicture(view, { id: att, att }, width, height);
    });
  }

  function openMenu() {
    actionSheet(null, [
      { label: 'Background', icon: 'grid', sub: backgroundLabel(page.paper, INK_NAMES), onPick: openPaper },
      { label: 'Add a Picture', icon: 'photo', onPick: addPicture },
      {
        label: store.settings.fingerDraws ? 'Finger Scrolls' : 'Finger Draws',
        icon: 'markup',
        sub: 'Only when no stylus has been used',
        onPick: () => {
          store.settings.fingerDraws = !store.settings.fingerDraws;
          save();
          toast(store.settings.fingerDraws ? 'Your finger draws until a stylus is used' : 'Your finger scrolls');
        },
      },
      { label: 'Share as Image', icon: 'share', onPick: shareImage },
      {
        label: 'Delete',
        icon: 'trash',
        destructive: true,
        onPick: () => alert2('Delete this note?', null, [
          { label: 'Cancel' },
          {
            label: 'Delete',
            destructive: true,
            onPick: () => {
              note.deletedAt = Date.now();
              note.updatedAt = Date.now();
              save();
              pop();
            },
          },
        ]),
      },
    ]);
  }

  async function shareImage() {
    await flush();
    await sharePage(view, note.title || 'Handwritten note');
  }

  /* ------------------------------------------------------ keyboard, life */

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || document.activeElement === title) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); view.undo(); }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); view.redo(); }
  };
  document.addEventListener('keydown', onKey);

  screen.onShow = () => view.layout();
  screen.onReturn = () => view.layout();

  screen.onLeave = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('notes:ink-pulled', onPulled);
    const nothing = !page.strokes.length && !page.images.length && !(note.title || '').trim();
    if (fresh && nothing) {
      // An untouched new page is discarded, as a typed note is.
      const i = store.notes.indexOf(note);
      if (i >= 0) store.notes.splice(i, 1);
      save();
    } else {
      if (note.draft) {
        delete note.draft;
        save();
      }
      flush();
    }
    view.destroy();
    chrome.destroy();
  };

  haptic('tap');
  return screen;
}
