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
