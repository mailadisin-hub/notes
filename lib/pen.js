/**
 * What the button on a stylus does.
 *
 * A pen with one button is the only shortcut some people have while writing,
 * and which shortcut is worth having depends entirely on what they are doing -
 * so it is set rather than assumed. The button does two separate things, and
 * they are configured separately:
 *
 *   holding it while writing   - the pen becomes something else for that stroke
 *   clicking it off the paper  - a one-off action
 *
 * Erasing on hold is the default because that is what the button did before
 * any of this existed, and an update should not change what someone's hand
 * already knows.
 */

export const PEN_HOLD = [
  { id: 'erase', label: 'Erase', sub: 'Rubs out whatever it is dragged over' },
  { id: 'highlighter', label: 'Highlight', sub: 'Writes with the highlighter instead' },
  { id: 'pencil', label: 'Pencil', sub: 'Writes with the pencil instead' },
  { id: 'none', label: 'Nothing', sub: 'The button is ignored while writing' },
];

export const PEN_CLICK = [
  { id: 'undo', label: 'Undo', sub: 'Takes back the last thing drawn' },
  { id: 'eraser', label: 'Switch to the Eraser', sub: 'And back again on the next click' },
  { id: 'ruler', label: 'Ruler', sub: 'Puts the straight-edge down, or away' },
  { id: 'mark', label: 'Mark This Spot', sub: 'Drops a marker where you are' },
  { id: 'lastPen', label: 'Last Two Pens', sub: 'Swaps between the two you used most recently' },
  { id: 'none', label: 'Nothing', sub: 'The button does nothing on its own' },
];

export const holdAction = (settings) => {
  const id = settings && settings.penHold;
  return PEN_HOLD.some((a) => a.id === id) ? id : 'erase';
};

export const clickAction = (settings) => {
  const id = settings && settings.penClick;
  return PEN_CLICK.some((a) => a.id === id) ? id : 'undo';
};

export const labelOf = (list, id) => (list.find((a) => a.id === id) || list[0]).label;
