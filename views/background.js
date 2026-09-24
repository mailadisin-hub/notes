/**
 * Choosing a page's background - plain, lines, squares or dots - from tiles
 * that show each one, instead of a list of words.
 *
 * Typed notes and handwritten pages store the same four backgrounds under
 * different names (they were added at different times), so each caller passes
 * the names it uses.
 */

import { el, overlay } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';

const KINDS = [
  { key: 'plain', label: 'Plain' },
  { key: 'lines', label: 'Lines' },
  { key: 'squares', label: 'Squares' },
  { key: 'dots', label: 'Dots' },
];

/** The names typed notes store (editor.js). */
export const TYPED_NAMES = { plain: 'plain', lines: 'lines', squares: 'grid', dots: 'dots' };
/** The names handwritten and shared pages store (lib/ink.js PAPERS). */
export const INK_NAMES = { plain: 'plain', lines: 'lined', squares: 'grid', dots: 'dotted' };

/** The label for a stored name. */
export function backgroundLabel(stored, names) {
  const kind = KINDS.find((k) => names[k.key] === stored);
  return kind ? kind.label : 'Plain';
}

/**
 * @param current  the stored name in use now
 * @param names    TYPED_NAMES or INK_NAMES
 * @param onPick   called with the stored name chosen
 */
export function backgroundSheet(current, names, onPick) {
  return overlay((close) => {
    const row = el('div', { class: 'bg-row' });
    for (const kind of KINDS) {
      const stored = names[kind.key];
      const tile = el('button', { class: `bg-tile${stored === current ? ' on' : ''}`, 'aria-label': kind.label },
        el('span', { class: `bg-swatch bg-${kind.key}` }),
        el('span', { class: 'bg-label', text: kind.label }));
      tile.addEventListener('click', () => {
        haptic('select');
        close();
        if (stored !== current) setTimeout(() => onPick(stored), 140);
      });
      row.append(tile);
    }
    const group = el('div', { class: 'sheet-group' },
      el('div', { class: 'sheet-title' }, el('strong', { text: 'Background' })),
      row);
    const cancel = el('div', { class: 'sheet-group' },
      el('button', {
        class: 'sheet-item cancel',
        text: 'Cancel',
        onclick: () => { haptic(); close(); },
      }));
    return el('div', { class: 'sheet' }, group, cancel);
  });
}
