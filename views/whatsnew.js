/**
 * What changed since the version that last ran on this device.
 *
 * A sideloaded app has no store listing and no release notes, so a new build
 * arrives silently and its new features go unfound. This shows them once, on
 * the first launch after an update, and every entry can open the thing it is
 * describing rather than leaving you to hunt for it.
 *
 * `RELEASES` is newest first. Adding a version here is the whole job: the
 * screen shows every release newer than the one last seen, so an update that
 * skips two versions still explains all three.
 */

import { el, icon, pressable, overlay } from '../lib/ui.js';
import { store, save } from '../lib/store.js';
import { haptic } from '../lib/haptics.js';

const SEEN_KEY = 'notes.seenVersion';

/**
 * Each release: the version, and what is worth opening the app for. `try` is
 * optional - without it an entry is just read - and is given the close function
 * so it can take you somewhere.
 */
export const RELEASES = [
  {
    version: '0.7.7',
    items: [
      {
        icon: 'lock',
        title: 'The Lock Actually Locks',
        body: 'It used to stop you writing but still let the page be shoved '
          + 'around. Now it pins everything down - nothing written, nothing '
          + 'moved, no panning or zooming - which is what you want when you are '
          + 'reading, or resting a hand on a page with a PDF on it.',
      },
    ],
  },
  {
    version: '0.7.6',
    items: [
      {
        icon: 'pen',
        title: 'The Button on Your Stylus',
        body: 'Settings > Pen Button sets what it does, in two parts. Holding it '
          + 'while writing can erase, highlight or use the pencil - or nothing at '
          + 'all. Clicking it with the pen off the page can undo, swap to the '
          + 'eraser, put the ruler down, drop a marker, or flip between your two '
          + 'most recent pens.',
        tryIt: { label: 'Open Settings', go: (done) => done('settings') },
      },
    ],
  },
  {
    version: '0.7.5',
    items: [
      {
        icon: 'arrows',
        title: 'A Board No Bigger Than It Needs',
        body: 'A whiteboard used to be enormous from the moment you opened it, '
          + 'which made it easy to drift off into blank paper and lose what you '
          + 'were doing. It now reaches about a screen past whatever you have '
          + 'written, and grows as you use it - so there is always something of '
          + 'yours within one swipe.',
      },
      {
        icon: 'pin',
        title: 'Mark Places and Jump Back',
        body: 'The pin in the corner drops a marker where you are. Give it a '
          + 'name and a colour, and it appears in that list - tap it and you are '
          + 'back there. Drag a pin to move it, tap one on the board to rename, '
          + 'recolour or remove it.',
        tryIt: { label: 'Open a Board', go: (done) => done('ink') },
      },
    ],
  },
  {
    version: '0.7.4',
    items: [
      {
        icon: 'restore',
        title: 'Notes That Vanished',
        body: 'A bug could stop the app writing anything to disk at all, quietly, '
          + 'and a note you had just started could disappear for good. Both causes '
          + 'are fixed, writing is saved as you type, and anything that was '
          + 'stranded by it is recovered when you open this version.',
      },
    ],
  },
  {
    version: '0.7.3',
    items: [
      {
        icon: 'doc',
        title: 'Put a PDF on a Whiteboard',
        body: 'Add a PDF from the menu of a handwritten page and every page of it '
          + 'goes on the board, one under the next, ready to write straight on. '
          + 'They behave like any other picture from then on - move them, rub out '
          + 'what you wrote, export the lot.',
        tryIt: { label: 'Open a Page', go: (done) => done('ink') },
      },
      {
        icon: 'people',
        title: 'And on Shared Boards',
        body: 'The same on a shared page: everyone gets the pages, and everyone '
          + 'can annotate them at once. Tap a page and Fill Screen to zoom to it '
          + 'before you write.',
      },
    ],
  },
  {
    version: '0.7.2',
    items: [
      {
        icon: 'info',
        title: 'It Explains Itself Now',
        body: 'A new device gets four panels saying what is here, and a Start Here '
          + 'note that shows how a line of writing becomes a revision card rather '
          + 'than just telling you. Nothing changes for a device you already use.',
      },
    ],
  },
  {
    version: '0.7.1',
    items: [
      {
        icon: 'doc',
        title: 'Export as PDF',
        body: 'Any note can be saved as a PDF, from its menu. A typed note '
          + 'becomes real selectable text rather than a picture of itself, so it '
          + 'stays small and can be searched; a handwritten page becomes a page '
          + 'of your writing, ready to hand in or send.',
      },
    ],
  },
  {
    version: '0.7.0',
    items: [
      {
        icon: 'search',
        title: 'Search Your Handwriting',
        body: 'In a handwritten page, the menu now offers Make This Page '
          + 'Searchable. It reads the writing line by line, on the phone, and '
          + 'search finds the page by what you actually wrote. Nothing is sent '
          + 'anywhere - the reading happens on the device and stays there.',
        tryIt: { label: 'Open a Page', go: (done) => done('ink') },
      },
      {
        icon: 'download',
        title: 'One Download, Then Offline',
        body: 'The first page you read fetches a language model, about twenty '
          + 'megabytes, over wifi only. After that it works with no connection '
          + 'at all. Android only: the web version cannot do this.',
      },
    ],
  },
  {
    version: '0.6.3',
    items: [
      {
        icon: 'restore',
        title: 'Earlier Versions of a Note',
        body: 'A copy of a note is kept every few minutes while you are editing '
          + 'it, and the last 45 days of those are in the note menu under '
          + 'Earlier Versions. Going back to one keeps the current version '
          + 'first, so it is never a one-way door. Locked notes are not copied.',
      },
    ],
  },
  {
    version: '0.6.2',
    items: [
      {
        icon: 'search',
        title: 'Search Inside Everything',
        body: 'The search button on the Folders screen looks through your notes, '
          + 'the text inside imported PDFs, and the Markdown in your vault '
          + 'folders - all at once, showing the line that matched.',
        tryIt: { label: 'Try Search', go: (done) => done('search') },
      },
    ],
  },
  {
    version: '0.6.1',
    items: [
      {
        icon: 'cards',
        title: 'Revise From Your Own Notes',
        body: 'Write "momentum :: mass times velocity" in a note, or a Q: with an '
          + 'A: under it, or hide a word in {{double braces}} - and it becomes a '
          + 'card. Revise on the Folders screen brings up whatever is due, and '
          + 'spaces each card out further every time you get it right.',
        tryIt: { label: 'Open Revise', go: (done) => done('revise') },
      },
      {
        icon: 'doc',
        title: 'Nothing to Keep in Step',
        body: 'The note is the only copy. Correct a definition and the card is '
          + 'corrected; delete the line and the card goes. There is no separate '
          + 'pile of cards to maintain.',
      },
    ],
  },
  {
    version: '0.6.0',
    items: [
      {
        icon: 'list',
        title: 'Big Folders Open Instantly',
        body: 'A folder with a thousand notes in it used to take a second to '
          + 'open, building every row before showing you any. It now builds what '
          + 'fits on screen and the rest as you scroll: a thousand notes opens '
          + 'as quickly as ten.',
      },
      {
        icon: 'doc',
        title: 'No Ceiling on How Much You Write',
        body: 'Notes were kept somewhere with a five megabyte limit - a couple '
          + 'of thousand notes and saving would start failing. They have moved '
          + 'somewhere measured in gigabytes. Nothing to do; it moves itself the '
          + 'first time you open this version.',
      },
    ],
  },
  {
    version: '0.5.9',
    items: [
      {
        icon: 'download',
        title: 'Back Up Everything',
        body: 'Settings now saves the lot as a zip: every typed note as Markdown, '
          + 'your pictures and files as ordinary files, and beside them the data '
          + 'that puts handwriting back exactly. Open it on any computer with '
          + 'nothing installed - your notes are not locked inside this app.',
        tryIt: { label: 'Open Settings', go: (done) => done('settings') },
      },
      {
        icon: 'restore',
        title: 'Restore Without Losing Anything',
        body: 'Restoring merges. Nothing already on the device is deleted, and '
          + 'where something exists in both, whichever you edited last is kept.',
      },
    ],
  },
  {
    version: '0.5.8',
    items: [
      {
        icon: 'pen',
        title: 'Eight Pens, and Yours to Change',
        body: 'Fountain pen, brush, ballpoint and fineliner join the pen, and a '
          + 'marker joins the highlighter. Tap the pen you are already using to '
          + 'pick the nib, then set its size, opacity, pressure, taper and '
          + 'smoothing. Each pen keeps its own settings, and ink already on the '
          + 'page never changes.',
        tryIt: { label: 'Try the Pens', go: (done) => done('ink') },
      },
      {
        icon: 'eraser',
        title: 'Crossing Out Is Fussier Again',
        body: 'It now wants the pen to have gone over the same writing three '
          + 'separate times before anything is erased, so a line through a word '
          + 'stays a line through a word.',
      },
    ],
  },
  {
    version: '0.5.7',
    items: [
      {
        icon: 'eraser',
        title: 'Scribbling Leaves Your Writing Alone',
        body: 'Crossing out was catching joined handwriting - an m at speed was '
          + 'enough to wipe out a word. It now asks whether the pen went over the '
          + 'same ground again rather than how sharply it turned, which writing '
          + 'never does. It also says so when it crosses something out.',
      },
    ],
  },
  {
    version: '0.5.6',
    items: [
      {
        icon: 'eraser',
        title: 'Scribble Something Out',
        body: 'Scribble back and forth over writing and it goes, along with the '
          + 'scribble. A scribble on empty paper is just a scribble. Settings '
          + 'turns it off if it ever catches your handwriting.',
        tryIt: { label: 'Try It', go: (done) => done('ink') },
      },
      {
        icon: 'circle',
        title: 'Hold for a Neat Shape',
        body: 'Draw a circle, a box, a triangle or a line and hold the pen still '
          + 'at the end without lifting. It is redrawn properly. Carry on drawing '
          + 'instead and you keep what you drew.',
      },
      {
        icon: 'lines',
        title: 'A Ruler',
        body: 'The ruler button lays a straight-edge on the page. Drag its middle '
          + 'to move it, either end to turn it, and draw along the top edge for a '
          + 'line that comes out straight however badly you draw it.',
      },
    ],
  },
  {
    version: '0.5.5',
    items: [
      {
        icon: 'folder-stack',
        title: 'Notes Open Full Screen',
        body: 'On a tablet or a computer an open note takes the whole window now, '
          + 'instead of sitting in a column beside the folder list. Split View in '
          + 'Settings puts the list back if you ever want it.',
      },
    ],
  },
  {
    version: '0.5.4',
    items: [
      {
        icon: 'people',
        title: 'Watch Each Other Write',
        body: 'On a shared page you now see the pen moving as someone writes, '
          + 'instead of the line appearing once they have finished.',
        tryIt: { label: 'Open Shared Pages', go: (done) => done('shared') },
      },
      {
        icon: 'search',
        title: 'The Wheel Zooms',
        body: 'On a computer, scrolling zooms in and out where the pointer is. '
          + 'Hold Shift to scroll instead, or drag with the middle mouse button '
          + 'to slide the board around.',
      },
    ],
  },
  {
    version: '0.5.3',
    items: [
      {
        icon: 'arrows',
        title: 'Everything Is a Whiteboard',
        body: 'Handwritten notes and shared pages open as a board with room to '
          + 'write in every direction, instead of a page that runs out. The '
          + 'menu turns it back into a page, and Find My Writing brings you '
          + 'back if you wander off into the empty part.',
        tryIt: { label: 'New Handwritten Note', go: (done) => done('ink') },
      },
    ],
  },
];

/** The newest version the app knows about - what a launch is compared against. */
export const CURRENT = RELEASES.length ? RELEASES[0].version : '0.0.0';

const parts = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);

/** Compares two version strings; positive when [a] is the newer one. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

/**
 * The releases this device has not been told about.
 *
 * With no version recorded this is either a genuinely new install - which has
 * no "new" to speak of, and gets nothing - or a build from before this screen
 * existed, which is an update like any other and gets the newest release. The
 * notes already on the device are what tells the two apart.
 */
export function unseenReleases() {
  const seen = store.settings[SEEN_KEY] || null;
  if (!seen) return store.notes.length ? RELEASES.slice(0, 1) : [];
  return RELEASES.filter((r) => compareVersions(r.version, seen) > 0);
}

export function markSeen(version = CURRENT) {
  store.settings[SEEN_KEY] = version;
  save();
}

/**
 * Shows the screen if there is anything to show, and remembers the version
 * either way. [onTry] is handed a short name - 'shared', 'ink' - so the caller
 * decides where that goes; this module stays out of the router.
 */
export function showWhatsNew({ onTry, force = false } = {}) {
  const releases = force ? RELEASES : unseenReleases();
  markSeen();
  if (!releases.length) return false;
  // Launch and a tap in Settings must not stack two of these on each other.
  if (document.querySelector('.whatsnew')) return false;

  const items = releases.flatMap((r) => r.items);
  overlay((close) => {
    const done = (where) => {
      close();
      if (where && onTry) onTry(where);
    };

    const list = el('div', { class: 'whatsnew-list' });
    for (const item of items) {
      const row = el('div', { class: 'whatsnew-item' },
        el('div', { class: 'whatsnew-icon' }, icon(item.icon)),
        el('div', { class: 'whatsnew-text' },
          el('h3', { text: item.title }),
          el('p', { text: item.body })));
      if (item.tryIt) {
        const go = el('button', { class: 'whatsnew-try', type: 'button', text: item.tryIt.label });
        pressable(go, () => {
          haptic('tap');
          item.tryIt.go(done);
        });
        row.querySelector('.whatsnew-text').append(go);
      }
      list.append(row);
    }

    const card = el('div', { class: 'whatsnew' },
      el('div', { class: 'whatsnew-head' },
        el('h2', { text: "What's New" }),
        el('p', { text: `Notes ${releases[0].version}` })),
      list);

    const dismiss = el('button', { class: 'whatsnew-done', type: 'button', text: 'Continue' });
    pressable(dismiss, () => done(null));
    card.append(dismiss);
    return card;
  });
  return true;
}
