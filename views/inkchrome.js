/**
 * The floating toolbars around a page you write on - handwritten notes and
 * PDFs alike - laid out the way Samsung Notes does it: rounded pills over a
 * full-bleed page instead of bars that take a strip of screen each.
 *
 *   top left      back, the title
 *   under it      undo, redo, and the hand: whether a finger draws
 *   top centre    pen, pencil, highlighter, eraser, a picture, and the colour
 *   top right     everything else, behind ...
 *   bottom left   page n of m, zoom (tap to fit), and the lock - pen scrolls
 *   bottom right  previous and next page
 *
 * On a phone-width page the tools drop to the bottom, where the thumb is, and
 * undo/redo move up beside the menu.
 *
 * Tap the tool you are already using to open its colours and sizes; the colour
 * dot does the same.
 */

import { el, icon, pressable } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';
import { store, save } from '../lib/store.js';
import { INK, INK_COLOURS, HIGHLIGHT_COLOURS, SIZE_STEPS } from '../lib/ink.js';

const TOOLS = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil' },
  { id: 'highlighter', icon: 'marker', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
];

function button(name, label, onPick, extraClass = '') {
  const b = el('button', { class: `pill-btn ${extraClass}`, 'aria-label': label, title: label }, icon(name));
  pressable(b, () => { haptic('select'); onPick(); });
  return b;
}

/**
 * @param view     an inkView
 * @param opts.titleEl   element shown after the back arrow (an input for notes)
 * @param opts.onBack
 * @param opts.onMenu
 * @param opts.pages     true when the document has pages to step through
 * @param opts.lightPage the page is always white (a PDF): the default ink
 *                       swatch shows dark whatever the theme
 * @param opts.onImage   when set, a picture button that calls it
 * @param opts.navExtra  an element shown after the title (who else is here)
 */
export function inkChrome(view, opts) {
  const sizes = { pen: 1, pencil: 1, highlighter: 1 };
  let current = 'pen';

  /* ---------------------------------------------------------------- left */

  const nav = el('div', { class: 'pill pill-nav' },
    button('arrow-left', 'Back', opts.onBack),
    opts.titleEl ? el('div', { class: 'pill-title' }, opts.titleEl) : null,
    opts.navExtra || null);

  const undoBtn = button('undo', 'Undo', () => view.undo());
  const redoBtn = button('redo', 'Redo', () => view.redo());
  const handBtn = button('hand', 'Draw with your finger', () => {
    store.settings.fingerDraws = !store.settings.fingerDraws;
    save();
    paint();
  });
  const hist = el('div', { class: 'pill pill-hist' }, undoBtn, redoBtn, handBtn);

  /* --------------------------------------------------------------- tools */

  const toolBtns = new Map();
  const colourDot = el('button', { class: 'pill-btn pill-colour', 'aria-label': 'Colour and size', title: 'Colour and size' },
    el('span', { class: 'pill-dot' }));
  pressable(colourDot, () => togglePopover());

  const tools = el('div', { class: 'pill pill-tools' });
  for (const t of TOOLS) {
    const b = el('button', { class: 'pill-btn', 'aria-label': t.label, title: t.label }, icon(t.icon));
    pressable(b, () => pick(t.id));
    toolBtns.set(t.id, b);
    tools.append(b);
  }
  if (opts.onImage) tools.append(button('photo', 'Add a picture', () => opts.onImage()));
  /* The ruler sits with the tools because it is one: something you pick up,
     draw along, and put down again. */
  const rulerBtn = button('lines', 'Ruler', () => {
    const on = !view.ruler;
    view.setRuler(on || null);
    rulerBtn.classList.toggle('on', on);
    if (opts.onRulerToggle) opts.onRulerToggle(on);
  });
  tools.append(rulerBtn);
  tools.append(el('span', { class: 'pill-sep' }), colourDot);

  /* ---------------------------------------------------------------- right */

  const more = el('div', { class: 'pill pill-more' }, button('ellipsis', 'More', () => opts.onMenu && opts.onMenu()));

  /* --------------------------------------------------------------- bottom */

  const pageNow = el('span', { class: 'pill-page-now', text: '1' });
  const pageAll = el('span', { class: 'pill-page-all', text: '1' });
  const pageStack = el('div', { class: 'pill-page' }, pageNow, pageAll);
  const zoom = el('button', { class: 'pill-zoom', 'aria-label': 'Fit to width', title: 'Fit to width', text: '100%' });
  pressable(zoom, () => view.zoomToFit());
  const lockBtn = button('lock-open', 'Lock for reading', () => {
    view.setReadOnly(!view.readOnly);
    paint();
  });
  const pagePill = el('div', { class: 'pill pill-status' },
    opts.pages ? pageStack : null,
    opts.pages ? el('span', { class: 'pill-sep' }) : null,
    zoom, lockBtn);

  const step = el('div', { class: 'pill pill-step' },
    button('chev-up', 'Previous page', () => view.step(-1)),
    button('chev-down', 'Next page', () => view.step(1)));

  /* -------------------------------------------------------------- popover */

  const popover = el('div', { class: 'pill-pop', hidden: true });

  function togglePopover(force) {
    const open = force ?? popover.hidden;
    if (open) renderPopover();
    popover.hidden = !open;
  }

  function renderPopover() {
    popover.textContent = '';
    if (current === 'eraser') {
      popover.append(el('div', { class: 'pop-hint', text: 'Erases whole strokes. The pen\'s side button erases too.' }));
      return;
    }
    const list = current === 'highlighter' ? HIGHLIGHT_COLOURS : INK_COLOURS;
    const selected = current === 'highlighter' ? view.state.highlight : view.state.colour;
    const row = el('div', { class: 'pop-row' });
    for (const c of list) {
      const sw = el('button', {
        class: `pop-swatch${c === INK ? ' ink-default' : ''}${c === selected ? ' on' : ''}`,
        'aria-label': c === INK ? 'Ink' : c,
        style: c === INK ? '' : `--sw:${c}`,
      });
      pressable(sw, () => {
        view.setColour(c);
        haptic('select');
        paint();
        renderPopover();
      });
      row.append(sw);
    }
    const sizeRow = el('div', { class: 'pop-row pop-sizes' });
    SIZE_STEPS.forEach((_, k) => {
      const b = el('button', { class: `pop-size${sizes[current] === k ? ' on' : ''}`, 'aria-label': `Size ${k + 1}` },
        el('span', { style: `--d:${4 + k * 5}px` }));
      pressable(b, () => {
        sizes[current] = k;
        view.setSizeStep(SIZE_STEPS[k]);
        haptic('select');
        paint();
        renderPopover();
      });
      sizeRow.append(b);
    });
    popover.append(row, sizeRow);
  }

  /* ---------------------------------------------------------------- state */

  function pick(id) {
    if (id === current) {
      togglePopover();
      return;
    }
    current = id;
    if (id === 'eraser') view.setMode('erase');
    else {
      view.setTool(id);
      view.setSizeStep(SIZE_STEPS[sizes[id]]);
    }
    haptic('select');
    paint();
    if (!popover.hidden) renderPopover();
  }

  function paint() {
    for (const [id, b] of toolBtns) b.classList.toggle('on', id === current);
    const c = current === 'highlighter' ? view.state.highlight : view.state.colour;
    colourDot.classList.toggle('ink-default', c === INK);
    colourDot.style.setProperty('--sw', c === INK ? '' : c);
    colourDot.hidden = current === 'eraser';
    handBtn.classList.toggle('on', !!store.settings.fingerDraws);
    lockBtn.classList.toggle('on', !!view.readOnly);
    lockBtn.querySelector('use').setAttribute('href', view.readOnly ? '#i-lock' : '#i-lock-open');
    undoBtn.classList.toggle('disabled', !view.canUndo());
    redoBtn.classList.toggle('disabled', !view.canRedo());
  }

  const root = el('div', { class: `ink-float${opts.lightPage ? ' light-page' : ''}` },
    nav, hist, tools, more, pagePill, opts.pages ? step : null, popover);

  // A tap on the page closes the colour popover.
  const closeOnOutside = (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !tools.contains(e.target)) togglePopover(false);
  };
  document.addEventListener('pointerdown', closeOnOutside, true);

  paint();

  return {
    el: root,
    sync: paint,
    setView({ page, pages, scale }) {
      pageNow.textContent = String(page + 1);
      pageAll.textContent = String(pages);
      zoom.textContent = `${Math.round(scale * 100)}%`;
    },
    destroy() {
      document.removeEventListener('pointerdown', closeOnOutside, true);
    },
  };
}
