/**
 * Revision, made out of the notes you already wrote.
 *
 * The point is that there is nothing to keep in step. A flashcard app means
 * writing everything twice - once to learn it, once to test it - and the second
 * copy goes stale the moment the first is corrected. Here the note is the only
 * copy: cards are read out of it every time, so editing the note edits the
 * cards, and deleting a line deletes its card.
 *
 * Three ways to mark something, all of them things people already write:
 *
 *   photosynthesis :: how plants make sugar from light
 *   Q: What is the unit of force?
 *   A: The newton
 *   The mitochondria is the {{powerhouse}} of the cell
 *
 * What the app keeps is only what it cannot read from the note: when each card
 * is next due, and how well it has been going.
 */

import { store, save } from './store.js';

/* ---------------------------------------------------------------- reading */

const stripTags = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(div|p|li|h[1-6]|tr)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

/** A short, stable name for a card, so its progress survives the app restarting. */
export function cardId(noteId, front) {
  let h = 5381;
  const text = `${noteId}|${front}`;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `c${h.toString(36)}`;
}

/**
 * Every card a note holds, in the order they appear in it.
 *
 * Returns [{ id, front, back, kind, line }]. `kind` is 'term', 'qa' or 'cloze',
 * which is only used to explain a card to the reader.
 */
export function cardsInNote(note) {
  if (!note || note.locked || note.deletedAt) return [];
  const text = stripTags(note.html);
  const lines = text.split('\n').map((l) => l.trim());
  const out = [];
  const seen = new Set();

  const add = (front, back, kind, line) => {
    if (!front || !back) return;
    if (front.length > 300 || back.length > 600) return;
    const id = cardId(note.id, front);
    if (seen.has(id)) return;          // the same question twice is one card
    seen.add(id);
    out.push({ id, front, back, kind, line, noteId: note.id, noteTitle: note.title || 'Untitled' });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    /* term :: definition - one line, and the most common thing people write. */
    const term = line.match(/^(.{1,200}?)\s*::\s*(.+)$/);
    if (term) {
      add(term[1].trim(), term[2].trim(), 'term', i);
      continue;
    }

    /* Q: ... on one line, A: ... on the next. */
    const q = line.match(/^Q[:.]\s*(.+)$/i);
    if (q) {
      const answers = [];
      for (let k = i + 1; k < lines.length; k += 1) {
        const a = lines[k].match(/^A[:.]\s*(.+)$/i);
        if (a) {
          answers.push(a[1].trim());
          continue;
        }
        if (answers.length || !lines[k]) break;
        break;
      }
      if (answers.length) {
        add(q[1].trim(), answers.join('\n'), 'qa', i);
        continue;
      }
    }

    /* A sentence with {{something}} hidden in it. Each hidden part is its own
       card, so a line with three of them tests three things. */
    const holes = [...line.matchAll(/\{\{([^{}]{1,120})\}\}/g)];
    if (holes.length) {
      holes.forEach((hole, n) => {
        const front = line.replace(/\{\{([^{}]{1,120})\}\}/g, (whole, inner, at) => (
          at === hole.index ? '_____' : inner
        ));
        add(`${front}${holes.length > 1 ? ` (${n + 1})` : ''}`, hole[1].trim(), 'cloze', i);
      });
    }
  }

  return out;
}

/** Every card in the library, newest notes last. */
export function allCards(notes = store.notes) {
  const out = [];
  for (const note of notes) {
    if (note.purged || note.deletedAt || note.draft) continue;
    out.push(...cardsInNote(note));
  }
  return out;
}

/* ------------------------------------------------------------- scheduling */

/* SM-2, cut down. The full algorithm's precision is wasted on a few hundred
   cards; what matters is that a card you find hard comes back soon and one you
   find easy goes away for longer each time. */
const FIRST_STEPS = [1 / 1440, 10 / 1440, 1];     // a minute, ten minutes, a day
const MIN_EASE = 1.3;
const DAY = 86400000;

const progress = () => {
  if (!store.study || typeof store.study !== 'object') store.study = {};
  return store.study;
};

/** What the app remembers about one card, or a brand-new one. */
export function stateOf(id) {
  const kept = progress()[id];
  return kept || { step: 0, interval: 0, ease: 2.5, due: 0, seen: 0, lapses: 0 };
}

export const isDue = (id, now = Date.now()) => stateOf(id).due <= now;

/**
 * Records how it went. [grade] is 'again', 'hard', 'good' or 'easy', and the
 * card's next showing follows from it.
 */
export function grade(id, rating, now = Date.now()) {
  const was = stateOf(id);
  const next = { ...was, seen: was.seen + 1 };

  if (rating === 'again') {
    next.step = 0;
    next.lapses = was.lapses + 1;
    next.ease = Math.max(MIN_EASE, was.ease - 0.2);
    next.interval = FIRST_STEPS[0];
  } else if (was.step < FIRST_STEPS.length) {
    /* Still being learned: walk up the short steps before it is a day away. */
    const step = rating === 'easy' ? FIRST_STEPS.length : was.step + 1;
    next.step = step;
    next.interval = step >= FIRST_STEPS.length ? 1 : FIRST_STEPS[step];
    if (rating === 'hard') next.ease = Math.max(MIN_EASE, was.ease - 0.15);
  } else {
    /* Known: the gap grows by how easy it has been finding it. */
    const grow = { hard: 1.2, good: was.ease, easy: was.ease * 1.35 }[rating] || was.ease;
    next.ease = rating === 'hard'
      ? Math.max(MIN_EASE, was.ease - 0.15)
      : rating === 'easy' ? was.ease + 0.15 : was.ease;
    next.interval = Math.max(1, Math.round(Math.max(1, was.interval) * grow));
    next.step = FIRST_STEPS.length;
  }

  next.due = now + next.interval * DAY;
  progress()[id] = next;
  save();
  return next;
}

/** Forgets a card's history, so it starts again from nothing. */
export function resetCard(id) {
  delete progress()[id];
  save();
}

/**
 * The cards to go through now: everything due, hardest first, with new cards
 * after them so a backlog is never hidden behind fresh material.
 */
export function dueNow(cards = allCards(), now = Date.now(), limit = 60) {
  const ready = [];
  const fresh = [];
  for (const card of cards) {
    const state = stateOf(card.id);
    if (!state.seen) fresh.push(card);
    else if (state.due <= now) ready.push({ card, state });
  }
  ready.sort((a, b) => a.state.due - b.state.due);
  return [...ready.map((r) => r.card), ...fresh].slice(0, limit);
}

/** Counts for the revision screen, without building the whole queue twice. */
export function studySummary(cards = allCards(), now = Date.now()) {
  let due = 0;
  let fresh = 0;
  let learned = 0;
  let soonest = Infinity;
  for (const card of cards) {
    const state = stateOf(card.id);
    if (!state.seen) fresh += 1;
    else if (state.due <= now) due += 1;
    else {
      learned += 1;
      if (state.due < soonest) soonest = state.due;
    }
  }
  return { total: cards.length, due, fresh, learned, soonest: soonest === Infinity ? null : soonest };
}

/** Tidies away progress for cards whose notes or lines are gone. */
export function forgetMissing(cards = allCards()) {
  const alive = new Set(cards.map((c) => c.id));
  const kept = progress();
  let removed = 0;
  for (const id of Object.keys(kept)) {
    if (!alive.has(id)) {
      delete kept[id];
      removed += 1;
    }
  }
  if (removed) save();
  return removed;
}
