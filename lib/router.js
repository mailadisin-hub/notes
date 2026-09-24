/**
 * A navigation stack of full-screen elements, backed by real history entries.
 *
 * Every push adds a history entry, so Android's back gesture pops a screen
 * instead of quitting the app (MainActivity.kt hands back presses to the
 * WebView for exactly this). The interactive edge swipe drives the same two
 * transforms the animation uses, so a cancelled drag settles back with no
 * special case.
 *
 * Two panes. Folders, lists and settings are "master" screens; a note, a
 * handwritten page, a PDF or a Markdown file is a "detail" screen (marked with
 * data-pane="detail"). On a phone the panes overlap and it all behaves as one
 * stack. On a tablet-width window (900px and up - the OnePlus Pad in either
 * orientation, never a phone) they sit side by side, iPad-style: the list stays
 * on the left and the open note fills the right.
 *
 * In split view the system back pops the detail pane first, a pane's own back
 * button pops that pane, and opening another note from the list replaces the
 * detail rather than stacking on it. History entries stay one per screen
 * throughout; the ones this code removes itself are marked so the popstate they
 * cause is not mistaken for a back press.
 */

const TRANSITION_MS = 380;
const SPLIT_QUERY = '(min-width: 900px)';

let host = null;
const panes = { master: null, detail: null };
const stack = [];
let animating = false;
let split = false;
let ignorePops = 0;
let lastTap = null;

const paneOf = (screen) => (screen.dataset.pane === 'detail' ? 'detail' : 'master');

function topOf(pane) {
  for (let i = stack.length - 1; i >= 0; i -= 1) if (paneOf(stack[i]) === pane) return stack[i];
  return null;
}

function below(screen) {
  const i = stack.indexOf(screen);
  if (!split) return stack[i - 1] || null;
  for (let j = i - 1; j >= 0; j -= 1) if (paneOf(stack[j]) === paneOf(screen)) return stack[j];
  return null;
}

export function mount(hostEl) {
  host = hostEl;
  panes.master = document.createElement('div');
  panes.master.className = 'pane pane-master';
  panes.detail = document.createElement('div');
  panes.detail.className = 'pane pane-detail';
  const empty = document.createElement('div');
  empty.className = 'detail-empty';
  empty.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-compose"></use></svg><span>No note open</span>';
  panes.detail.append(empty);
  host.append(panes.master, panes.detail);

  const mq = matchMedia(SPLIT_QUERY);
  const apply = () => {
    split = mq.matches;
    host.classList.toggle('split', split);
    // Screens that were stacked behind others on a phone are side by side now.
    for (const s of stack) {
      s.classList.remove('behind');
      s.style.transform = '';
    }
    if (!split) for (let i = 0; i < stack.length - 1; i += 1) stack[i].classList.add('behind');
    else {
      const m = topOf('master');
      for (const s of stack) if (paneOf(s) === 'master' && s !== m) s.classList.add('behind');
      const d = topOf('detail');
      for (const s of stack) if (paneOf(s) === 'detail' && s !== d) s.classList.add('behind');
    }
    for (const s of stack) s.onShow && s.onShow();
  };
  mq.addEventListener('change', apply);
  apply();

  // Which pane a back button was tapped in, for pop() below.
  document.addEventListener('pointerdown', (e) => { lastTap = e.target; }, true);
}

export const depth = () => stack.length;
export const top = () => stack[stack.length - 1];
export const isSplit = () => split;

export function push(screen) {
  if (animating || !host) return;
  const pane = paneOf(screen);
  const prev = split ? topOf(pane) : stack[stack.length - 1];
  stack.push(screen);

  screen.classList.add('enter-right');
  panes[pane].append(screen);
  history.pushState({ depth: stack.length }, '');

  animating = true;
  /* Flush layout so translateX(100%) is committed before it is removed;
     without this the screen jumps straight to its final position. A paint
     callback would work too, but it never fires while the window is
     occluded, which would leave the pushed screen stuck off to the right. */
  void screen.offsetWidth;
  screen.classList.add('animating');
  prev && prev.classList.add('animating');
  screen.classList.remove('enter-right');
  prev && prev.classList.add('behind');

  setTimeout(() => {
    screen.classList.remove('animating');
    prev && prev.classList.remove('animating');
    animating = false;
    screen.onShow && screen.onShow();
  }, TRANSITION_MS);
}

/**
 * Opens a note, page or file. On a phone that is an ordinary push; in split
 * view it replaces whatever the detail pane was showing, the way tapping
 * another note in iPad Notes does.
 */
export function openDetail(screen) {
  screen.dataset.pane = 'detail';
  if (!split || animating) {
    push(screen);
    return;
  }
  const old = stack.filter((s) => paneOf(s) === 'detail');
  if (!old.length) {
    push(screen);
    return;
  }
  for (const s of old) {
    s.onLeave && s.onLeave();
    s.remove();
    stack.splice(stack.indexOf(s), 1);
  }
  // One history entry per screen: the new screen takes over one of the old
  // screens' entries, and any others are dropped.
  if (old.length > 1) {
    ignorePops += 1;
    history.go(-(old.length - 1));
  }
  stack.push(screen);
  screen.classList.add('fade-in');
  panes.detail.append(screen);
  void screen.offsetWidth;
  screen.classList.remove('fade-in');
  setTimeout(() => { screen.onShow && screen.onShow(); }, 0);
  refreshMaster();
}

/* The list beside an open note shows its title; tell it when that changes. */
function refreshMaster() {
  const m = topOf('master');
  if (m && m.onReturn) m.onReturn();
}

export function pop({ fromHistory = false } = {}) {
  if (animating) return false;

  let leaving;
  if (!split) {
    if (stack.length < 2) return false;
    leaving = stack[stack.length - 1];
  } else {
    // The system back closes the note first; a back button closes its own pane.
    let pane = topOf('detail') ? 'detail' : 'master';
    if (!fromHistory && lastTap && lastTap.closest) {
      pane = lastTap.closest('.pane-detail') ? 'detail' : 'master';
    }
    leaving = topOf(pane);
    if (!leaving) return false;
    if (pane === 'master' && stack.filter((s) => paneOf(s) === 'master').length < 2) return false;
  }

  const prev = below(leaving);
  stack.splice(stack.indexOf(leaving), 1);

  animating = true;
  leaving.onLeave && leaving.onLeave();
  leaving.classList.add('animating');
  prev && prev.classList.add('animating');

  void leaving.offsetWidth;
  leaving.classList.add('enter-right');
  prev && prev.classList.remove('behind');

  setTimeout(() => {
    leaving.remove();
    prev && prev.classList.remove('animating', 'behind');
    animating = false;
    prev && prev.onReturn && prev.onReturn();
    if (split && paneOf(leaving) === 'detail') refreshMaster();
  }, TRANSITION_MS);

  if (!fromHistory) {
    ignorePops += 1;
    history.back();
  }
  return true;
}

export function popTo(rootIndex = 0) {
  const count = stack.length - (rootIndex + 1);
  if (count <= 0) return;
  for (let i = 0; i < count; i += 1) {
    const leaving = stack.pop();
    leaving.onLeave && leaving.onLeave();
    leaving.remove();
  }
  // One go() for all of them, and one popstate to ignore - calling back() in
  // a loop would deliver popstates that then popped screens that were meant
  // to stay.
  ignorePops += 1;
  history.go(-count);
  const current = stack[stack.length - 1];
  if (current) {
    current.classList.remove('behind', 'animating', 'enter-right');
    current.onReturn && current.onReturn();
  }
}

export function reset(screen) {
  stack.length = 0;
  panes.master.querySelectorAll('.screen').forEach((s) => s.remove());
  panes.detail.querySelectorAll('.screen').forEach((s) => s.remove());
  stack.push(screen);
  panes[paneOf(screen)].append(screen);
  screen.onShow && screen.onShow();
}

window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops -= 1;
    return;
  }
  if (stack.length > 1) pop({ fromHistory: true });
});

/* -------------------------------------------------- interactive edge swipe */

let edge = null;

document.addEventListener('touchstart', (e) => {
  // Tablets in split view have the system back gesture and two panes; a
  // left-edge drag there would be ambiguous.
  if (split || stack.length < 2 || animating) return;
  if (e.touches[0].clientX > 24) return;
  if (e.target.closest('[data-no-edge-swipe]')) return;
  edge = { x: e.touches[0].clientX, y: e.touches[0].clientY, active: false, pct: 0 };
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!edge) return;
  const dx = e.touches[0].clientX - edge.x;
  const dy = Math.abs(e.touches[0].clientY - edge.y);

  if (!edge.active) {
    if (dy > 14 && dy > dx) { edge = null; return; }
    if (dx < 12) return;
    edge.active = true;
  }

  const leaving = stack[stack.length - 1];
  const prev = stack[stack.length - 2];
  const pct = Math.max(0, Math.min(1, dx / window.innerWidth));
  leaving.style.transform = `translateX(${pct * 100}%)`;
  prev.style.transform = `translateX(${-28 + pct * 28}%)`;
  edge.pct = pct;
}, { passive: true });

document.addEventListener('touchend', () => {
  if (!edge || !edge.active) { edge = null; return; }
  const leaving = stack[stack.length - 1];
  const prev = stack[stack.length - 2];
  const commit = edge.pct > 0.32;
  edge = null;

  leaving.style.transform = '';
  prev.style.transform = '';
  if (commit) pop();
}, { passive: true });
