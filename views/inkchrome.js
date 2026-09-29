/**
 * The floating toolbars around a page you write on - handwritten notes and
 * PDFs alike - laid out the way Samsung Notes does it: rounded pills over a
 * full-bleed page instead of bars that take a strip of screen each.
 *
 *   top left      back, the title
 *   under it      undo, redo, and the hand: whether a finger draws
 *   top centre    pen, pencil, highlighter, eraser, a picture, and the colour
 *   top right     everything else, behind ...
 *   bottom left   page n of m, zoom (tap to fit), and the lock, which pins
 *                 the page down so nothing is written or moved
 *   bottom right  previous and next page
 *
 * On a phone-width page the tools drop to the bottom, where the thumb is, and
 * undo/redo move up beside the menu.
 *
 * Tap the tool you are already using to open its colours and sizes; the colour
 * dot does the same.
 */

import { el, icon, pressable, toast, actionSheet } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';
import { store, save } from '../lib/store.js';
import { INK, INK_COLOURS, HIGHLIGHT_COLOURS, SIZE_STEPS, TOOLS, PEN_KNOBS, penStyle } from '../lib/ink.js';

const BUTTONS = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil' },
  { id: 'highlighter', icon: 'marker', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser' },
];

/**
 * The nibs behind each button. One button, several pens: the pen button writes
 * with whichever nib was last chosen under it, so the toolbar stays four wide
 * however many pens there are.
 */
const NIBS = {
  pen: ['pen', 'fountain', 'ballpoint', 'fineliner', 'brush'],
  pencil: ['pencil'],
  highlighter: ['highlighter', 'marker'],
};

/** The nib in use for a button, and the settings it has been given. */
function nibOf(group) {
  const chosen = (store.settings.nibs || {})[group];
  return NIBS[group].includes(chosen) ? chosen : group;
}

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
 * @param opts.marksEl   the places list, shown beside the menu on a board
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
  /* What the eraser goes back to, and the nib before the last swap. */
  let lastDrawing = 'pen';
  let previousNib = null;
  const colourDot = el('button', { class: 'pill-btn pill-colour', 'aria-label': 'Colour and size', title: 'Colour and size' },
    el('span', { class: 'pill-dot' }));
  pressable(colourDot, () => togglePopover());

  const tools = el('div', { class: 'pill pill-tools' });
  for (const t of BUTTONS) {
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

  /* The places list sits beside the menu, in the corner, because it is about
     where you are on the board rather than about the note. */
  const more = el('div', { class: 'pill pill-more' },
    opts.marksEl || null,
    button('ellipsis', 'More', () => opts.onMenu && opts.onMenu()));

  /* --------------------------------------------------------------- bottom */

  const pageNow = el('span', { class: 'pill-page-now', text: '1' });
  const pageAll = el('span', { class: 'pill-page-all', text: '1' });
  const pageStack = el('div', { class: 'pill-page' }, pageNow, pageAll);
  const zoom = el('button', { class: 'pill-zoom', 'aria-label': 'Fit to width', title: 'Fit to width', text: '100%' });
  pressable(zoom, () => view.zoomToFit());
  /* Pinning a page is usually about keeping it still while you write on it, so
     the useful locks are the ones that hold an axis and leave the pen alone.
     Holding everything is there too, for reading. */
  const LOCKS = [
    { id: 'free', label: 'Moves Freely', icon: 'lock-open', said: 'Unlocked' },
    { id: 'x', label: 'No Sideways', icon: 'arrow-down', said: 'Only moves up and down - you can still write' },
    { id: 'y', label: 'No Up and Down', icon: 'arrow-left', said: 'Only moves sideways - you can still write' },
    { id: 'all', label: 'Hold Everything', icon: 'lock', said: 'Held - nothing can be written or moved' },
  ];

  const lockBtn = button('lock-open', 'How the page moves', () => {
    actionSheet('How the Page Moves', LOCKS.map((l) => ({
      label: l.label,
      icon: l.icon,
      selected: view.lock === l.id,
      onPick: () => {
        view.setLock(l.id);
        paint();
        toast(l.said);
      },
    })), { message: 'Locking an axis keeps the page still while you write on it.' });
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
    const nib = nibOf(current);
    const style = penStyle(nib, store.settings.penTweaks);

    /* Which nib this button writes with. One row, only when there is a choice
       to make. */
    if (NIBS[current].length > 1) {
      const nibs = el('div', { class: 'pop-row pop-nibs' });
      for (const id of NIBS[current]) {
        const b = el('button', { class: `pop-nib${id === nib ? ' on' : ''}`, type: 'button' },
          el('span', { class: 'pop-nib-line', style: `--w:${Math.min(11, penStyle(id, store.settings.penTweaks).size)}px` }),
          el('span', { class: 'pop-nib-name', text: TOOLS[id].label }));
        pressable(b, () => {
          store.settings.nibs = { ...(store.settings.nibs || {}), [current]: id };
          save();
          applyTool();
          haptic('select');
          renderPopover();
        });
        nibs.append(b);
      }
      popover.append(nibs);
    }

    const list = style.flat ? HIGHLIGHT_COLOURS : INK_COLOURS;
    const selected = style.flat ? view.state.highlight : view.state.colour;
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

    /* The pen itself. Every change is saved against that nib, so each pen keeps
       its own feel, and the ink already on the page is left as it was. */
    const knobs = el('div', { class: 'pop-knobs' });
    for (const knob of PEN_KNOBS) {
      if (style.flat && (knob.key === 'pressure' || knob.key === 'taper')) continue;
      const value = style[knob.key] ?? 0;
      const out = el('span', { class: 'pop-knob-value', text: knob.percent ? `${Math.round(value * 100)}%` : value.toFixed(1) });
      const input = el('input', {
        type: 'range', class: 'pop-knob-range',
        min: knob.min, max: knob.max, step: knob.step, value,
        'aria-label': `${TOOLS[nib].label} ${knob.label}`,
      });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = knob.percent ? `${Math.round(v * 100)}%` : v.toFixed(1);
        const tweaks = { ...(store.settings.penTweaks || {}) };
        tweaks[nib] = { ...(tweaks[nib] || {}), [knob.key]: v };
        store.settings.penTweaks = tweaks;
        applyTool();
      });
      input.addEventListener('change', () => { save(); haptic('tap'); });
      knobs.append(el('label', { class: 'pop-knob' },
        el('span', { class: 'pop-knob-name', text: knob.label }), out, input));
    }

    const reset = el('button', { class: 'pop-reset', type: 'button', text: `Reset ${TOOLS[nib].label}` });
    pressable(reset, () => {
      const tweaks = { ...(store.settings.penTweaks || {}) };
      delete tweaks[nib];
      store.settings.penTweaks = tweaks;
      save();
      applyTool();
      haptic('toggle');
      renderPopover();
    });
    knobs.append(reset);
    popover.append(knobs);
  }

  /* Tells the view which pen to write with, and how it has been set up. */
  function applyTool() {
    if (current === 'eraser') return;
    const nib = nibOf(current);
    view.setTool(nib, penStyle(nib, store.settings.penTweaks));
    view.setSizeStep(SIZE_STEPS[sizes[current]]);
    paint();
  }

  /* ---------------------------------------------------------------- state */

  function pick(id) {
    if (id === current) {
      togglePopover();
      return;
    }
    if (current !== 'eraser') lastDrawing = current;
    current = id;
    if (id === 'eraser') view.setMode('erase');
    else applyTool();
    haptic('select');
    paint();
    if (!popover.hidden) renderPopover();
  }

  function paint() {
    for (const [id, b] of toolBtns) b.classList.toggle('on', id === current);
    const flat = current !== 'eraser' && penStyle(nibOf(current), store.settings.penTweaks).flat;
    const c = flat ? view.state.highlight : view.state.colour;
    colourDot.classList.toggle('ink-default', c === INK);
    colourDot.style.setProperty('--sw', c === INK ? '' : c);
    colourDot.hidden = current === 'eraser';
    handBtn.classList.toggle('on', !!store.settings.fingerDraws);
    const lock = LOCKS.find((l) => l.id === view.lock) || LOCKS[0];
    lockBtn.classList.toggle('on', lock.id !== 'free');
    lockBtn.querySelector('use').setAttribute('href', `#i-${lock.icon}`);
    lockBtn.setAttribute('aria-label', `How the page moves: ${lock.label}`);
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

  applyTool();

  return {
    el: root,
    sync: paint,
    /* Things the pen's button can ask for. They go through the toolbar rather
       than the view so that the buttons light up to match, and so a click of
       the pen looks exactly like a tap of the tool. */
    toggleEraser() {
      pick(current === 'eraser' ? lastDrawing : 'eraser');
    },
    toggleRuler() {
      const on = !view.ruler;
      view.setRuler(on || null);
      rulerBtn.classList.toggle('on', on);
    },
    swapPens() {
      const pens = NIBS[current === 'eraser' ? 'pen' : current];
      if (!pens || pens.length < 2) return pick(current === 'pen' ? 'pencil' : 'pen');
      const here = nibOf(current === 'eraser' ? 'pen' : current);
      const next = previousNib && previousNib !== here ? previousNib : pens[(pens.indexOf(here) + 1) % pens.length];
      previousNib = here;
      store.settings.nibs = { ...(store.settings.nibs || {}), pen: next };
      save();
      if (current === 'eraser') pick('pen');
      else applyTool();
      return undefined;
    },
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
