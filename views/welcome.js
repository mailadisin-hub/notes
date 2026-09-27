/**
 * The first thing a new person sees.
 *
 * Everything this app can do that another notes app cannot is hidden one level
 * down - in a menu, behind a gesture, inside a line of text. A feature nobody
 * finds is worth nothing, so this says plainly what is here, once, and then
 * gets out of the way for good.
 *
 * Four panels, not fourteen. The aim is that someone knows what to try next,
 * not that they have been taught the whole app.
 */

import { el, icon, pressable, overlay } from '../lib/ui.js';
import { store, save, newNote } from '../lib/store.js';
import { haptic } from '../lib/haptics.js';

const SEEN_KEY = 'notes.welcomed';

const PANELS = [
  {
    icon: 'pen',
    title: 'Write, or Handwrite',
    body: 'Type a note, or start a handwritten one and use a stylus. Handwritten '
      + 'pages open as a whiteboard with room in every direction, and there are '
      + 'eight pens you can set up however you like.',
  },
  {
    icon: 'cards',
    title: 'Your Notes Revise You',
    body: 'Write a line like "momentum :: mass times velocity" and it becomes a '
      + 'revision card. Revise on the Folders screen brings up whatever is due. '
      + 'There is no second copy to keep in step - fix the note, fix the card.',
  },
  {
    icon: 'search',
    title: 'Find Anything You Kept',
    body: 'One search covers your notes, the text inside PDFs you import, your '
      + 'vault folders, and - on Android - your own handwriting, read on the '
      + 'device.',
  },
  {
    icon: 'download',
    title: 'It Is Still Yours',
    body: 'Settings backs everything up as a plain zip: notes as Markdown, '
      + 'pictures and files as files. Any note exports as a PDF. Nothing is '
      + 'locked in, and every note keeps its earlier versions for 45 days.',
  },
];

/** The note a new library starts with, written to show rather than tell. */
export function welcomeNote(folderId = 'default') {
  const note = newNote(folderId);
  note.kind = 'note';
  note.title = 'Start Here';
  note.html = [
    '<h1>Start Here</h1>',
    '<div><br></div>',
    '<div>This note is an ordinary note. Change it, or delete it.</div>',
    '<div><br></div>',
    '<h2>Turn a line into a revision card</h2>',
    '<div>Write a definition with two colons in the middle:</div>',
    '<div><br></div>',
    '<div>spaced repetition :: revising something just before you would forget it</div>',
    '<div>photosynthesis :: how plants make sugar out of light</div>',
    '<div><br></div>',
    '<div>Those two are already cards. Open Revise on the Folders screen and they '
      + 'will be waiting. A question works too:</div>',
    '<div><br></div>',
    '<div>Q: What is the unit of force?</div>',
    '<div>A: The newton</div>',
    '<div><br></div>',
    '<div>And you can hide a word in the middle of a sentence: '
      + 'the mitochondria is the {{powerhouse}} of the cell.</div>',
    '<div><br></div>',
    '<h2>A few things worth knowing</h2>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">Type a #hashtag and it becomes a tag on the Folders screen</span></div>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">Swipe a note left to lock, move or delete it, right to pin it</span></div>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">In a handwritten page, scribble over writing to rub it out, '
      + 'and hold still at the end of a shape to draw it neatly</span></div>',
    '<div class="checkitem" data-done="0"><span class="box" contenteditable="false">'
      + '<svg viewBox="0 0 24 24" class="ic"><use href="#i-check"></use></svg></span>'
      + '<span class="ct">Settings backs everything up as a zip you can open anywhere</span></div>',
    '<div><br></div>',
    '<div>#welcome</div>',
  ].join('');
  note.updatedAt = Date.now();
  delete note.draft;
  return note;
}

export const hasBeenWelcomed = () => !!store.settings[SEEN_KEY];

export function markWelcomed() {
  store.settings[SEEN_KEY] = true;
  save();
}

/**
 * Shows the panels, if this is a first run. [onDone] is called when they are
 * finished with, whether they were read or skipped.
 */
export function showWelcome({ force = false, onDone } = {}) {
  if (!force && hasBeenWelcomed()) return false;
  markWelcomed();

  let at = 0;
  overlay((close) => {
    const art = el('div', { class: 'welcome-art' });
    const heading = el('h2');
    const body = el('p');
    const dots = el('div', { class: 'welcome-dots' });
    const next = el('button', { class: 'welcome-next', type: 'button' });
    const skip = el('button', { class: 'welcome-skip', type: 'button', text: 'Skip' });

    const draw = () => {
      const panel = PANELS[at];
      art.textContent = '';
      art.append(icon(panel.icon));
      heading.textContent = panel.title;
      body.textContent = panel.body;
      next.textContent = at === PANELS.length - 1 ? 'Start' : 'Next';
      skip.hidden = at === PANELS.length - 1;
      dots.textContent = '';
      PANELS.forEach((_, i) => dots.append(el('span', { class: `welcome-dot${i === at ? ' on' : ''}` })));
    };

    const finish = () => {
      close();
      if (onDone) onDone();
    };

    pressable(next, () => {
      haptic('select');
      if (at === PANELS.length - 1) return finish();
      at += 1;
      return draw();
    });
    pressable(skip, finish);

    draw();
    return el('div', { class: 'welcome' },
      art,
      el('div', { class: 'welcome-text' }, heading, body),
      dots,
      next,
      skip);
  }, { dismissable: false });

  return true;
}
