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
import { boxOf } from '../lib/ink.js';
import { inkView } from '../lib/inkview.js';
import { inkChrome } from './inkchrome.js';
import { backgroundSheet, backgroundLabel, INK_NAMES } from './background.js';
import { pickPicture, placePicture, sharePage } from './pictures.js';
import { putAttachment, getAttachment } from '../lib/attachments.js';

export const PAGE_WIDTH = 800;

/**
 * Whiteboard: the same page, seventy-five page-widths across and down, opened
 * in the middle. It is not literally endless - a number has to stop somewhere -
 * but at writing size it is thousands of pages of room in every direction, and
 * "Find My Writing" is there for when you have panned into the empty part.
 */
const BOARD = 60000;
const BOARD_START_TOP = 300;

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
    const at = await putInk(note.id, {
      strokes: page.strokes, paper: page.paper, images: page.images, board: page.board,
    });
    note.updatedAt = at;
    note.inkAt = at;
    if (page.strokes.length || page.images.length) delete note.draft;
    if (!save()) toast('Storage is full - free some space');
  }

  getInk(note.id).then((ink) => {
    page.strokes = ink.strokes;
    page.images = ink.images;
    page.paper = ink.paper || store.settings.defaultPaper || 'plain';
    if (ink.board) shapePage(true);
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
    /* Another device may have turned the whiteboard on or off, which changes
       the shape of the page under the camera, not just what is drawn on it. */
    if (!!ink.board !== !!page.board) {
      shapePage(ink.board);
      view.reframe();
    } else {
      view.refresh();
    }
  };
  window.addEventListener('notes:ink-pulled', onPulled);

  /* -------------------------------------------------------- whiteboard */

  /** What is on the page, as [x0, y0, x1, y1], or null when it is empty. */
  function contentBox() {
    let box = null;
    const take = (b) => {
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]),
        Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice();
    };
    for (const s of page.strokes) take(boxOf(s));
    for (const im of page.images) take([im.x, im.y, im.x + im.w, im.y + im.h]);
    return box;
  }

  /* Moves everything on the page together. The cached outline and bounding box
     are measured in the old position, so both have to go. */
  function shiftContent(dx, dy) {
    if (!dx && !dy) return;
    for (const s of page.strokes) {
      for (let i = 0; i < s.pts.length; i += 3) {
        s.pts[i] += dx;
        s.pts[i + 1] += dy;
      }
      delete s._box;
      delete s._path;
    }
    for (const im of page.images) {
      im.x += dx;
      im.y += dy;
    }
  }

  /** Gives the page a board's dimensions, or a page's, without moving anything. */
  function shapePage(board) {
    page.board = !!board;
    page.unit = board ? PAGE_WIDTH : undefined;
    page.width = board ? BOARD : PAGE_WIDTH;
    if (board) page.height = BOARD;
    else page.height = Math.max(page.minHeight, 1400);
  }

  function setBoard(on) {
    const box = contentBox();
    if (on) {
      /* The page's origin is its top-left, the board's starting view is its
         middle, so the writing moves to meet it and keeps its own layout. */
      shapePage(true);
      shiftContent(BOARD / 2 - PAGE_WIDTH / 2, BOARD / 2 - BOARD_START_TOP);
    } else {
      /* Coming back to a page, the writing is wherever it ended up on the
         board, so it is brought to the top-left corner rather than left at
         coordinates a page has no room for. */
      shapePage(false);
      if (box) shiftContent(-box[0], -box[1]);
    }
    view.clearHistory();
    view.reframe();
    dirty = true;
    scheduleSave();
  }

  function toggleBoard() {
    if (page.board) {
      const box = contentBox();
      const tooWide = box && box[2] - box[0] > PAGE_WIDTH;
      if (!tooWide) return setBoard(false);
      return alert2('Turn Off Whiteboard?',
        'The writing is wider than a page. It will be moved to the top-left corner, '
        + 'and whatever still falls past the right edge will be off the page.', [
          { label: 'Cancel' },
          { label: 'Turn Off', destructive: true, onPick: () => setBoard(false) },
        ]);
    }
    setBoard(true);
    toast('Whiteboard on - write anywhere, in any direction');
    return undefined;
  }

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
      {
        label: page.board ? 'Turn Off Whiteboard' : 'Whiteboard',
        icon: 'arrows',
        sub: page.board ? 'Back to a single page' : 'Room to write in every direction',
        onPick: toggleBoard,
      },
      page.board ? { label: 'Find My Writing', icon: 'search', onPick: () => view.recentre() } : null,
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
