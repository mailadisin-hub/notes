/**
 * The shared control vocabulary: elements, icons, press handling, and the four
 * overlay shapes the app uses (toast, action sheet, alert, context menu).
 *
 * Press handling is the fiddly part. On a phone the action must fire on
 * touchend so it beats the 300ms click delay and can be cancelled by a scroll;
 * on a desktop browser only click exists. Both listeners are attached and the
 * click is suppressed for the synthetic event that follows a real tap.
 */

import { haptic } from './haptics.js';

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ic ${cls}`.trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let lastTouchAt = 0;
export const touchedRecently = () => Date.now() - lastTouchAt < 600;

export function pressable(node, onActivate, { cls = 'pressed', feedback = 'tap' } = {}) {
  let moved = false;
  let sx = 0;
  let sy = 0;

  node.addEventListener('touchstart', (e) => {
    moved = false;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    node.classList.add(cls);
  }, { passive: true });

  node.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) {
      moved = true;
      node.classList.remove(cls);
    }
  }, { passive: true });

  node.addEventListener('touchend', (e) => {
    node.classList.remove(cls);
    lastTouchAt = Date.now();
    if (moved) return;
    e.preventDefault();
    haptic(feedback);
    onActivate(e);
  });

  node.addEventListener('touchcancel', () => {
    node.classList.remove(cls);
    lastTouchAt = Date.now();
  }, { passive: true });

  node.addEventListener('click', (e) => {
    if (touchedRecently()) return;
    haptic(feedback);
    onActivate(e);
  });

  return node;
}

/** Fires once the finger has been still on `node` for `delay` ms. */
export function longPress(node, onHold, delay = 460) {
  let timer = null;
  let sx = 0;
  let sy = 0;

  const cancel = () => { clearTimeout(timer); timer = null; };

  node.addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      haptic('commit');
      onHold({ x: sx, y: sy });
    }, delay);
  }, { passive: true });

  node.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) cancel();
  }, { passive: true });

  node.addEventListener('touchend', cancel, { passive: true });
  node.addEventListener('touchcancel', cancel, { passive: true });

  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (touchedRecently()) return;
    onHold({ x: e.clientX, y: e.clientY });
  });

  return node;
}

/* ---------------------------------------------------------------- toasts */

export function toast(message, { icon: iconName = null } = {}) {
  const host = document.getElementById('toast-host');
  host.innerHTML = '';
  const t = el('div', { class: 'toast' }, iconName ? icon(iconName) : null, el('span', { text: message }));
  host.append(t);
  void t.offsetWidth;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 320);
  }, 1900);
}

/* -------------------------------------------------------------- overlays */

/**
 * Builds a scrim plus one piece of content and returns a close function. The
 * builder receives close so items can dismiss themselves; content is removed
 * after the exit transition rather than immediately, or sheets snap away.
 */
export function overlay(build, { dismissable = true, onClose = null, clear = false } = {}) {
  const host = document.getElementById('sheet-host');
  const scrim = el('div', { class: `scrim${clear ? ' clear' : ''}` });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove('show');
    content.classList.remove('show');
    setTimeout(() => {
      scrim.remove();
      content.remove();
      onClose && onClose();
    }, 400);
  };

  const content = build(close);
  if (dismissable) scrim.addEventListener('click', () => { haptic(); close(); });

  host.append(scrim, content);
  /* Reading offsetWidth flushes layout, which commits the pre-transition
     state so the transition has something to animate from. requestAnimationFrame
     would do the same job only while the window is painting, and an occluded
     window would leave the sheet permanently invisible. */
  void scrim.offsetWidth;
  scrim.classList.add('show');
  content.classList.add('show');
  return close;
}

/** items: [{ label, sub, icon, destructive, selected, onPick }] */
export function actionSheet(title, items, { message = null } = {}) {
  return overlay((close) => {
    const group = el('div', { class: 'sheet-group' });
    if (title || message) {
      group.append(el('div', { class: 'sheet-title' },
        title ? el('strong', { text: title }) : null,
        message ? el('span', { text: message }) : null));
    }
    for (const it of items.filter(Boolean)) {
      const btn = el('button', { class: `sheet-item${it.destructive ? ' destructive' : ''}` },
        el('span', { class: 'sheet-label' },
          el('span', { text: it.label }),
          it.sub ? el('small', { text: it.sub }) : null),
        it.selected ? icon('check', 'tick') : (it.icon ? icon(it.icon) : null));
      btn.addEventListener('click', () => {
        haptic('select');
        close();
        setTimeout(() => it.onPick && it.onPick(), 140);
      });
      group.append(btn);
    }
    const cancel = el('div', { class: 'sheet-group' },
      el('button', {
        class: 'sheet-item cancel',
        text: 'Cancel',
        onclick: () => { haptic(); close(); },
      }));
    return el('div', { class: 'sheet' }, group, cancel);
  });
}

/**
 * A sheet holding one slider, for a value better dragged than picked, like
 * text size. onInput runs as it moves, over a clear scrim, so the change can
 * be watched as it happens. Crossing [detent] gives a tick, like iOS.
 */
export function sliderSheet({ title, min, max, step, value, format, onInput, detent = null, onClose = null }) {
  return overlay((close) => {
    const readout = el('span', { class: 'slider-value', text: format(value) });
    const input = el('input', {
      class: 'slider', type: 'range', min, max, step, value, 'aria-label': title,
    });
    const paint = () => {
      input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    };
    let last = Number(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (detent != null && (last - detent) * (v - detent) <= 0 && v !== last) haptic('select');
      last = v;
      readout.textContent = format(v);
      paint();
      onInput(v);
    });
    paint();
    const group = el('div', { class: 'sheet-group' },
      el('div', { class: 'sheet-title' }, el('strong', { text: title })),
      el('div', { class: 'slider-row' },
        el('span', { class: 'slider-a small', text: 'A' }),
        input,
        el('span', { class: 'slider-a big', text: 'A' })),
      el('div', { class: 'slider-readout' }, readout));
    const done = el('div', { class: 'sheet-group' },
      el('button', { class: 'sheet-item cancel', text: 'Done', onclick: () => { haptic(); close(); } }));
    return el('div', { class: 'sheet' }, group, done);
  }, { clear: true, onClose });
}

/**
 * buttons: [{ label, strong, destructive, onPick }] ; opts.input -> text field.
 * An onPick that returns false keeps the alert open, which is what a rejected
 * passcode needs - dismissing on a wrong entry loses what was typed and gives
 * no way back in.
 */
export function alert2(title, message, buttons, opts = {}) {
  let input = null;
  let card = null;
  overlay((closeFn) => {
    const head = el('div', { class: 'alert-head' },
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null);

    if (opts.input !== undefined) {
      input = el('input', {
        class: 'alert-input',
        type: opts.inputType || 'text',
        value: opts.input,
        placeholder: opts.placeholder || '',
        inputmode: opts.inputMode || null,
        maxlength: opts.maxLength || null,
        autocapitalize: 'sentences',
      });
      head.append(input);
    }

    const actions = el('div', { class: `alert-actions${buttons.length > 2 ? ' stack-v' : ''}` });
    for (const b of buttons) {
      const btn = el('button', {
        class: `alert-btn${b.strong ? ' strong' : ''}${b.destructive ? ' destructive' : ''}`,
        text: b.label,
      });
      btn.addEventListener('click', async () => {
        haptic(b.destructive ? 'warn' : 'select');
        const value = input ? input.value.trim() : undefined;
        const keepOpen = b.onPick ? await b.onPick(value) : undefined;
        if (keepOpen === false) {
          haptic('warn');
          card.classList.remove('shake');
          void card.offsetWidth;
          card.classList.add('shake');
          if (input) { input.value = ''; input.focus(); }
          return;
        }
        closeFn();
      });
      actions.append(btn);
    }
    card = el('div', { class: 'alert' }, head, actions);
    return card;
  });

  if (input) setTimeout(() => { input.focus(); input.select(); }, 280);
}

/**
 * The iOS long-press menu: the pressed row is lifted onto its own layer above
 * a dimmed backdrop, with the menu tucked underneath. Using a clone means the
 * list below never has to be re-laid-out to animate one row.
 */
export function contextMenu(sourceEl, items, { title = null } = {}) {
  const rect = sourceEl.getBoundingClientRect();
  const clone = sourceEl.cloneNode(true);
  clone.classList.add('ctx-preview');
  clone.style.top = `${rect.top}px`;
  clone.style.left = `${rect.left}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;

  const below = window.innerHeight - rect.bottom;
  const menuAbove = below < 260 && rect.top > 260;

  overlay((close) => {
    const menu = el('div', { class: `ctx-menu${menuAbove ? ' above' : ''}` });
    if (title) menu.append(el('div', { class: 'ctx-title', text: title }));
    for (const it of items.filter(Boolean)) {
      const btn = el('button', { class: `ctx-item${it.destructive ? ' destructive' : ''}` },
        el('span', { text: it.label }),
        icon(it.icon || 'circle'));
      btn.addEventListener('click', () => {
        haptic('select');
        close();
        setTimeout(() => it.onPick && it.onPick(), 140);
      });
      menu.append(btn);
    }

    const wrap = el('div', { class: 'ctx-layer' }, clone, menu);
    if (menuAbove) {
      menu.style.bottom = `${window.innerHeight - rect.top + 10}px`;
    } else {
      menu.style.top = `${rect.bottom + 10}px`;
    }
    menu.style.left = `${Math.min(Math.max(12, rect.left), window.innerWidth - 252)}px`;
    return wrap;
  }, { onClose: () => {} });
}

/* --------------------------------------------------------------- chrome */

export function navBar({ left = [], title = '', right = [] }) {
  const titleEl = el('div', { class: 'nav-title', text: title });
  const bar = el('header', { class: 'nav' },
    el('div', { class: 'nav-row' },
      el('div', { class: 'nav-left' }, left),
      titleEl,
      el('div', { class: 'nav-right' }, right)));
  bar.titleEl = titleEl;
  return bar;
}

export function backButton(label, onBack) {
  const text = el('span', { class: 'back-label', text: label });
  const b = el('button', { class: 'nav-btn back-btn', 'aria-label': `Back to ${label}` },
    icon('chev-left'), text);
  b.addEventListener('click', () => { haptic(); onBack(); });

  /* The way iOS does it: the previous screen's name if it fits beside the
     title, "Back" if that fits instead, and the chevron alone if nothing
     does. Only the column's width decides, so settling takes one pass. */
  if (typeof ResizeObserver === 'function') {
    const fit = () => {
      const room = b.parentElement ? b.parentElement.clientWidth : 0;
      if (!room) return;
      b.classList.remove('short');
      for (const candidate of [label, 'Back']) {
        text.textContent = candidate;
        if (text.scrollWidth + 30 <= room) return;
      }
      b.classList.add('short');
    };
    new ResizeObserver(fit).observe(b);
  }
  return b;
}

export function navTextButton(label, onPick, { strong = false } = {}) {
  const b = el('button', { class: `nav-btn${strong ? ' strong' : ''}`, text: label });
  b.addEventListener('click', () => { haptic('select'); onPick(); });
  return b;
}

export function navIconButton(name, onPick, label = name) {
  const b = el('button', { class: 'nav-btn', 'aria-label': label }, icon(name));
  b.addEventListener('click', () => { haptic('select'); onPick(); });
  return b;
}

/**
 * Fades the inline nav title in once the large title has scrolled past it, and
 * raises the bar's hairline. Measuring before the screen is in the DOM reports
 * a zero threshold, so that case is skipped rather than guessed at.
 */
export function bindScrollTitle(body, bar, largeTitleEl, { alwaysShowTitle = false } = {}) {
  const onScroll = () => {
    bar.classList.toggle('scrolled', body.scrollTop > 4);
    if (alwaysShowTitle) {
      bar.titleEl.classList.add('show');
      return;
    }
    if (largeTitleEl && !largeTitleEl.offsetHeight) {
      bar.titleEl.classList.remove('show');
      return;
    }
    const threshold = largeTitleEl ? largeTitleEl.offsetTop + largeTitleEl.offsetHeight - 12 : 10;
    bar.titleEl.classList.toggle('show', body.scrollTop > threshold);
  };
  if (body.__scrollTitle) body.removeEventListener('scroll', body.__scrollTitle);
  body.__scrollTitle = onScroll;
  body.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  /* Re-run once layout exists; a paint callback would not fire if the
     window is occluded and the title would stay hidden until a scroll. */
  setTimeout(onScroll, 0);

  /* Tapping the bar returns to the top, as every iOS list does. */
  bar.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    body.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* ----------------------------------------------------------- swipe rows */

let openSwipe = null;

export function closeOpenSwipe() {
  if (!openSwipe) return;
  const row = openSwipe;
  row.classList.add('snap');
  row.style.transform = '';
  openSwipe = null;
  setTimeout(() => {
    if (openSwipe !== row && row.parentElement) row.parentElement.classList.remove('swiping');
  }, 340);
}

export const hasOpenSwipe = () => !!openSwipe;

/**
 * actions are rendered right-to-left behind the row; `leading` is the single
 * action revealed by a rightward swipe. A swipe past ~1.75x the tray width
 * commits the last (destructive) action outright, matching Mail and Notes.
 */
export function swipeRow(rowContent, actions, { leading = null } = {}) {
  const wrap = el('div', { class: 'swipe' });
  const tray = el('div', { class: 'swipe-actions' });

  for (const a of actions) {
    const b = el('button', { class: `swipe-action ${a.cls}` }, icon(a.icon), el('span', { text: a.label }));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic('commit');
      closeOpenSwipe();
      a.onPick();
    });
    tray.append(b);
  }
  wrap.append(tray);

  let leadTray = null;
  if (leading) {
    leadTray = el('div', { class: `swipe-leading ${leading.cls}` }, icon(leading.icon), el('span', { text: leading.label }));
    wrap.append(leadTray);
  }
  wrap.append(rowContent);

  const width = actions.length * 74;
  const leadWidth = 84;

  let sx = 0; let sy = 0; let dragging = false; let decided = false; let base = 0; let armed = false;

  rowContent.addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    decided = false;
    dragging = false;
    armed = false;
    base = openSwipe === rowContent ? -width : 0;
    rowContent.classList.remove('snap');
  }, { passive: true });

  rowContent.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!decided) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      decided = true;
      dragging = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (dragging) {
        if (openSwipe && openSwipe !== rowContent) closeOpenSwipe();
        wrap.classList.add('swiping');
      }
    }
    if (!dragging) return;
    rowContent.classList.remove('pressed');

    let off = base + dx;
    if (off > 0 && !leading) off *= 0.25;
    if (off > leadWidth) off = leadWidth + (off - leadWidth) * 0.3;
    if (off < -width) off = -width - (Math.abs(off) - width) * 0.35;
    rowContent.style.transform = `translateX(${off}px)`;

    /* One buzz at the point the full-swipe commit arms, not on every frame. */
    const shouldArm = off < -width * 1.75 || (leading && off > leadWidth * 1.5);
    if (shouldArm !== armed) {
      armed = shouldArm;
      if (armed) haptic('commit');
    }
  }, { passive: true });

  rowContent.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    const current = new DOMMatrixReadOnly(getComputedStyle(rowContent).transform).m41;
    rowContent.classList.add('snap');

    if (leading && current > leadWidth * 0.6) {
      rowContent.style.transform = '';
      openSwipe = null;
      setTimeout(() => leading.onPick(), 120);
      setTimeout(() => wrap.classList.remove('swiping'), 340);
      return;
    }
    if (current < -width * 1.75) {
      haptic('commit');
      rowContent.style.transform = 'translateX(-100%)';
      openSwipe = null;
      setTimeout(() => actions[actions.length - 1].onPick(), 190);
      return;
    }
    if (current < -width * 0.45) {
      rowContent.style.transform = `translateX(${-width}px)`;
      openSwipe = rowContent;
      return;
    }
    rowContent.style.transform = '';
    if (openSwipe === rowContent) openSwipe = null;
    setTimeout(() => {
      if (openSwipe !== rowContent) wrap.classList.remove('swiping');
    }, 340);
  }, { passive: true });

  return wrap;
}

document.addEventListener('touchstart', (e) => {
  if (openSwipe && !e.target.closest('.swipe')) closeOpenSwipe();
}, { passive: true });
