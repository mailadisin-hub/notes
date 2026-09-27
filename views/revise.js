/**
 * Revision: the cards in your notes, one at a time, in the order you most need
 * to see them.
 *
 * Deliberately one thing on screen and four ways out. Anything else on this
 * screen is something to look at instead of answering, and the whole value of
 * the exercise is in trying to remember before being told.
 */

import {
  el, icon, pressable, navBar, backButton, toast, alert2, actionSheet,
} from '../lib/ui.js';
import { pop, push, openDetail } from '../lib/router.js';
import { haptic } from '../lib/haptics.js';
import { store, noteById } from '../lib/store.js';
import {
  allCards, dueNow, studySummary, grade, stateOf, resetCard, forgetMissing, cardsInNote,
} from '../lib/cards.js';

const DAY = 86400000;

/** "in 3 days", "in 4 minutes" - the wait before a card is asked again. */
export function whenAgain(days) {
  const mins = days * 24 * 60;
  if (mins < 60) return `${Math.max(1, Math.round(mins))} min`;
  if (days < 1) return `${Math.round(mins / 60)} h`;
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 365) return `${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'}`;
  return `${(days / 365).toFixed(1)} years`;
}

/** What each answer would do to this card, so the choice is never a guess. */
function previewIntervals(id) {
  const before = { ...stateOf(id) };
  const out = {};
  for (const rating of ['again', 'hard', 'good', 'easy']) {
    const after = grade(id, rating, Date.now());
    out[rating] = whenAgain(after.interval);
    /* Put it back: this was a question about the future, not a visit to it. */
    if (before.seen) store.study[id] = before;
    else delete store.study[id];
  }
  return out;
}

export function reviseScreen(backLabel = 'Folders') {
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body revise-body' });
  const bar = navBar({ left: [backButton(backLabel, () => pop())], title: 'Revise', right: [] });

  let queue = [];
  let at = 0;
  let showing = false;

  function start() {
    forgetMissing();
    queue = dueNow();
    at = 0;
    showing = false;
    render();
  }

  function answer(rating) {
    const card = queue[at];
    if (!card) return;
    haptic(rating === 'again' ? 'warn' : 'commit');
    grade(card.id, rating);
    at += 1;
    showing = false;
    render();
  }

  function cardMenu(card) {
    actionSheet(null, [
      {
        label: 'Open the Note',
        icon: 'doc',
        sub: card.noteTitle,
        onPick: () => {
          const note = noteById(card.noteId);
          if (!note) return toast('That note is gone');
          pop();
          return import('./editor.js').then((m) => openDetail(m.editorScreen(note.id, 'Revise')));
        },
      },
      {
        label: 'Start This One Again',
        icon: 'restore',
        sub: 'Forgets how it has been going',
        onPick: () => { resetCard(card.id); toast('Back to the beginning'); },
      },
    ]);
  }

  /* ------------------------------------------------------------- drawing */

  function renderDone() {
    const sum = studySummary();
    const wait = sum.soonest ? whenAgain((sum.soonest - Date.now()) / DAY) : null;
    body.append(el('div', { class: 'revise-done' },
      icon('check-circle'),
      el('h2', { text: sum.total ? 'Nothing Left For Now' : 'No Cards Yet' }),
      el('p', {
        text: sum.total
          ? wait ? `Next one in ${wait}.` : 'Everything here is learned.'
          : 'Write a note with lines like "photon :: a particle of light", or a Q: and an A:, '
            + 'and they turn up here.',
      }),
      sum.total ? el('div', { class: 'revise-tally' },
        el('span', { text: `${sum.learned} learned` }),
        el('span', { text: `${sum.fresh} not started` })) : null,
      sum.fresh ? (() => {
        const b = el('button', { class: 'revise-again', type: 'button', text: 'Learn New Ones' });
        pressable(b, start);
        return b;
      })() : null));
  }

  function render() {
    body.innerHTML = '';
    const card = queue[at];

    if (!card) {
      renderDone();
      return;
    }

    const left = queue.length - at;
    body.append(el('div', { class: 'revise-count' },
      el('span', { text: `${left} to go` }),
      el('span', { class: 'revise-source', text: card.noteTitle })));

    const face = el('div', { class: 'revise-card' },
      el('div', { class: 'revise-front', text: card.front }));

    if (showing) {
      face.append(el('div', { class: 'revise-line' }));
      face.append(el('div', { class: 'revise-back', text: card.back }));
    }
    pressable(face, () => {
      if (showing) return;
      showing = true;
      haptic('tap');
      render();
    });
    body.append(face);

    if (!showing) {
      const show = el('button', { class: 'revise-show', type: 'button', text: 'Show Answer' });
      pressable(show, () => { showing = true; haptic('tap'); render(); });
      body.append(show);
    } else {
      const next = previewIntervals(card.id);
      const row = el('div', { class: 'revise-grades' });
      for (const [rating, label] of [['again', 'Again'], ['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']]) {
        const b = el('button', { class: `revise-grade ${rating}`, type: 'button' },
          el('span', { class: 'revise-grade-name', text: label }),
          el('span', { class: 'revise-grade-when', text: next[rating] }));
        pressable(b, () => answer(rating));
        row.append(b);
      }
      body.append(row);
    }

    const more = el('button', { class: 'revise-more', type: 'button', text: 'Where is this from?' });
    pressable(more, () => cardMenu(card));
    body.append(more);
  }

  screen.append(bar, body);
  screen.onReturn = start;
  start();
  return screen;
}

/**
 * The cards one note holds, so it is obvious what the app has found in it -
 * and obvious when a line was not written in a way it recognises.
 */
export function noteCardsScreen(noteId, backLabel = 'Note') {
  const note = noteById(noteId);
  const screen = el('section', { class: 'screen' });
  const body = el('div', { class: 'body' });
  const bar = navBar({ left: [backButton(backLabel, () => pop())], title: 'Cards', right: [] });

  const cards = note ? cardsInNote(note) : [];
  body.append(el('h1', { class: 'large-title', text: 'Cards' }));

  if (!cards.length) {
    body.append(el('div', { class: 'empty' },
      icon('cards'),
      el('h4', { text: 'No Cards in This Note' }),
      el('p', {
        text: 'A line like "photon :: a particle of light" becomes a card. So does a '
          + 'Q: followed by an A:, and a sentence with {{something}} in double braces.',
      })));
  } else {
    const group = el('div', { class: 'group-card' });
    for (const card of cards) {
      const state = stateOf(card.id);
      const when = !state.seen ? 'Not started'
        : state.due <= Date.now() ? 'Due now'
          : `In ${whenAgain((state.due - Date.now()) / DAY)}`;
      group.append(el('div', { class: 'cell no-icon' },
        el('span', { class: 'cell-name' },
          el('span', { text: card.front }),
          el('span', { class: 'cell-sub', text: card.back })),
        el('span', { class: 'cell-value', text: when })));
    }
    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: `${cards.length} card${cards.length === 1 ? '' : 's'}` }),
      group));
  }

  screen.append(bar, body);
  return screen;
}

/** The line shown on the Folders screen: how much is waiting. */
export function reviseSummaryText() {
  const sum = studySummary(allCards(store.notes));
  if (!sum.total) return null;
  if (sum.due) return `${sum.due} due`;
  if (sum.fresh) return `${sum.fresh} new`;
  return 'All learned';
}
