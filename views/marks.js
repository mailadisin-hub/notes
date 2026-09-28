/**
 * Markers: the places on a board worth getting back to.
 *
 * A board big enough to be useful is big enough to lose things on. A marker is
 * a coloured pin with a name, dropped where you are, and the list in the corner
 * takes you back to any of them - which turns "somewhere up and to the left" at
 * back into a thing you can point at.
 */

import { el, icon, pressable, actionSheet, alert2, toast } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';

export const MARK_COLOURS = [
  { name: 'Red', value: '#ff3b30' },
  { name: 'Orange', value: '#ff9500' },
  { name: 'Yellow', value: '#ffcc00' },
  { name: 'Green', value: '#34c759' },
  { name: 'Blue', value: '#007aff' },
  { name: 'Purple', value: '#af52de' },
];

const nameOf = (mark, i) => mark.name || `Marker ${i + 1}`;

/**
 * The list in the corner. [onChange] is called whenever a marker is added,
 * renamed, recoloured or removed, so the page can save.
 */
export function marksButton(view, onChange = () => {}) {
  const button = el('button', {
    class: 'pill-btn mark-btn', type: 'button', 'aria-label': 'Places', title: 'Places',
  }, icon('pin'));
  const menu = el('div', { class: 'mark-menu', hidden: true });
  const wrap = el('div', { class: 'mark-wrap' }, button, menu);

  const close = () => { menu.hidden = true; };

  function render() {
    menu.textContent = '';
    const marks = view.marks();

    const add = el('button', { class: 'mark-row mark-add', type: 'button' },
      icon('plus'), el('span', { text: 'Mark This Spot' }));
    pressable(add, () => {
      close();
      const made = view.addMark({});
      onChange();
      haptic('commit');
      /* Straight into naming it: an unnamed pin is barely better than no pin. */
      editMark(view, made, onChange, true);
    });
    menu.append(add);

    if (!marks.length) {
      menu.append(el('p', { class: 'mark-empty', text: 'Nothing marked yet. Drop one where you are and it appears here.' }));
      return;
    }

    const list = el('div', { class: 'mark-list' });
    marks.forEach((mark, i) => {
      const row = el('div', { class: 'mark-row' },
        el('span', { class: 'mark-dot', style: `--c:${mark.colour}` }),
        el('span', { class: 'mark-name', text: nameOf(mark, i) }));
      pressable(row, () => {
        close();
        view.goToMark(mark.id);
        haptic('select');
      });
      /* Holding a row is how it is renamed, the way holding anything else in
         this app opens what can be done to it. */
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        close();
        editMark(view, mark, onChange);
      });
      let held = null;
      row.addEventListener('pointerdown', () => {
        held = setTimeout(() => { close(); editMark(view, mark, onChange); }, 480);
      });
      for (const stop of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) {
        row.addEventListener(stop, () => clearTimeout(held));
      }
      list.append(row);
    });
    menu.append(list);
  }

  pressable(button, () => {
    if (!menu.hidden) return close();
    render();
    menu.hidden = false;
    return undefined;
  });

  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) close();
  }, true);

  return { el: wrap, close, refresh: () => { if (!menu.hidden) render(); } };
}

/** Naming a marker, colouring it, or taking it away. */
export function editMark(view, mark, onChange = () => {}, isNew = false) {
  alert2(isNew ? 'Name This Place' : 'Rename', 'What is here?', [
    {
      label: isNew ? 'Skip' : 'Cancel',
      onPick: () => { if (isNew) onChange(); },
    },
    {
      label: 'Save',
      strong: true,
      onPick: (value) => {
        view.updateMark(mark.id, { name: (value || '').slice(0, 40) });
        onChange();
        if (isNew) pickColour(view, mark, onChange);
      },
    },
  ], { input: mark.name || '', placeholder: 'Diagram, page 4, to finish...' });

  if (isNew) return;

  /* An existing marker gets the rest of its options after the name, rather
     than a dialog with everything in it. */
  setTimeout(() => {
    actionSheet(null, [
      { label: 'Colour...', icon: 'circle', onPick: () => pickColour(view, mark, onChange) },
      {
        label: 'Remove',
        icon: 'trash',
        destructive: true,
        onPick: () => {
          view.removeMark(mark.id);
          onChange();
          toast('Marker removed');
        },
      },
    ]);
  }, 420);
}

export function pickColour(view, mark, onChange = () => {}) {
  actionSheet('Colour', MARK_COLOURS.map((c) => ({
    label: c.name,
    icon: 'circle',
    selected: mark.colour === c.value,
    onPick: () => {
      view.updateMark(mark.id, { colour: c.value });
      onChange();
      haptic('select');
    },
  })));
}
