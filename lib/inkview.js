/**
 * A pannable, zoomable column of pages you can write on - one endless sheet
 * for a handwritten note, or the pages of a PDF.
 *
 * Input is split the way paper works:
 *   - a stylus writes (S Pen, OnePlus Stylo; both report pointerType "pen");
 *   - fingers pan and pinch-zoom, so a resting palm never draws;
 *   - a mouse writes, and the wheel scrolls (ctrl+wheel zooms), for the laptop.
 * Holding the pen's side button, or using an eraser tip, erases.
 *
 * Two canvases. The base holds every committed stroke and is redrawn when the
 * view moves; the live canvas holds only the stroke in progress and is drawn
 * straight from the pointer event on a desynchronized context, which is what
 * keeps the ink close under the nib.
 *
 * touch-action is off for the whole surface - a browser that is allowed to pan
 * will take a pen drag as a scroll - so panning, flinging and zooming are all
 * done here.
 *
 * Pictures sit on a page under the ink: { id, x, y, w, h } in page units, in
 * page.images, plus whatever their owner needs to find the pixels -
 * opts.imageFor turns one into something drawImage accepts. A tap with a
 * finger (or holding the pen or mouse still on one, or a right-click) selects
 * a picture; it can then be dragged, resized from its corner, or deleted.
 */

import { TOOLS, INK, outline, boxOf, hits, resolveColour, drawPaper } from './ink.js';

const BASE = 1;
const LIVE = 2;
const MIN_SAMPLE_PX = 0.75;
const ERASER_PX = 14;
const EDGE_PAD = 20;
const HOLD_MS = 450;
const TAP_MS = 320;
const TAP_SLOP_PX = 8;
const MIN_IMAGE = 32;

/* Capturing a pointer that has already lifted throws; the gesture should
   carry on regardless. */
function capture(target, pointerId) {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Gone already: nothing to capture.
  }
}

/** Strokes carry an id so a shared page can tell which one changed. */
export const newStrokeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function inkView(opts) {
  const pages = opts.pages;
  const gap = opts.gap || 0;
  // Space kept clear above the first page and below the last, so floating
  // toolbars do not sit on the content at either end.
  const topPad = opts.topPad ?? EDGE_PAD;
  const bottomPad = opts.bottomPad ?? EDGE_PAD * 4;
  let readOnly = false;

  const el = document.createElement('div');
  el.className = 'ink-view';
  el.setAttribute('data-no-edge-swipe', 'true');
  const base = document.createElement('canvas');
  base.className = 'ink-base';
  const live = document.createElement('canvas');
  live.className = 'ink-live';
  el.append(base, live);

  const bctx = base.getContext('2d');
  let lctx = null;
  try { lctx = live.getContext('2d', { desynchronized: true }); } catch { /* not supported */ }
  if (!lctx) lctx = live.getContext('2d');

  const state = { tool: 'pen', colour: INK, highlight: '#ffd60a', sizeStep: 1, mode: 'draw' };
  const cam = { x: 0, y: 0, scale: 1 };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let fitScale = 1;
  let ready = false;
  let rect = { left: 0, top: 0 };

  let tops = [];
  let lefts = [];
  let docW = 1;
  let docH = 1;

  const dark = () => !!(opts.dark && opts.dark());

  /* ------------------------------------------------------------- layout */

  function growPage() {
    if (!opts.grow) return;
    const page = pages[0];
    let bottom = 0;
    for (const s of page.strokes) bottom = Math.max(bottom, boxOf(s)[3]);
    for (const im of page.images || []) bottom = Math.max(bottom, im.y + im.h);
    const viewH = H && fitScale ? H / fitScale : 1200;
    page.height = Math.max(page.minHeight || 0, viewH * 1.4, bottom + viewH);
  }

  function relayout() {
    growPage();
    docW = Math.max(1, ...pages.map((p) => p.width));
    tops = [];
    lefts = [];
    let y = 0;
    for (const p of pages) {
      tops.push(y);
      lefts.push((docW - p.width) / 2);
      y += p.height + gap;
    }
    docH = Math.max(1, y - gap);
  }

  function measure() {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    rect = r;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const sizeChanged = r.width !== W || r.height !== H;
    W = r.width;
    H = r.height;
    if (sizeChanged) {
      for (const c of [base, live]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
    }
    relayout();
    const pad = opts.sidePad ?? 16;
    const nextFit = Math.max(0.05, (W - pad * 2) / docW);
    if (!ready) {
      cam.scale = Math.min(nextFit, opts.maxFitScale || Infinity);
      cam.x = 0;
      cam.y = -topPad / cam.scale;
      ready = true;
    } else if (nextFit !== fitScale) {
      // Rotation or split-view resize: keep the same zoom relative to the page.
      const centreY = cam.y + H / 2 / cam.scale;
      cam.scale *= nextFit / fitScale;
      cam.y = centreY - H / 2 / cam.scale;
    }
    fitScale = nextFit;
    relayout();
    clampCam();
    return true;
  }

  function clampCam() {
    const minScale = fitScale * 0.5;
    const maxScale = Math.max(fitScale * 6, 3);
    cam.scale = Math.min(maxScale, Math.max(minScale, cam.scale));
    const viewW = W / cam.scale;
    const viewH = H / cam.scale;
    if (viewW >= docW) {
      cam.x = -(viewW - docW) / 2;
    } else {
      const pad = EDGE_PAD / cam.scale;
      cam.x = Math.min(docW - viewW + pad, Math.max(-pad, cam.x));
    }
    const minY = -topPad / cam.scale;
    const maxY = Math.max(minY, docH - viewH + bottomPad / cam.scale);
    cam.y = Math.min(maxY, Math.max(minY, cam.y));
  }

  /** Client coordinates to a page and a point on it, or null between pages. */
  function toPage(clientX, clientY, pageIndex = -1) {
    const dx = (clientX - rect.left) / cam.scale + cam.x;
    const dy = (clientY - rect.top) / cam.scale + cam.y;
    if (pageIndex >= 0) return { i: pageIndex, x: dx - lefts[pageIndex], y: dy - tops[pageIndex] };
    for (let i = 0; i < pages.length; i += 1) {
      if (dy >= tops[i] && dy <= tops[i] + pages[i].height && dx >= lefts[i] && dx <= lefts[i] + pages[i].width) {
        return { i, x: dx - lefts[i], y: dy - tops[i] };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------- rendering */

  let pending = 0;
  let raf = 0;
  let timer = 0;

  /* rAF never fires while the WebView is occluded, so a timer backs it up;
     whichever comes first draws. */
  function schedule(flags) {
    pending |= flags;
    if (raf || timer) return;
    raf = requestAnimationFrame(flush);
    timer = setTimeout(flush, 40);
  }

  function flush() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    const f = pending;
    pending = 0;
    if (f & BASE) renderBase();
    if (f & LIVE) renderLive();
  }

  const deskColour = () => (dark() ? '#1d1d1f' : '#e9e9ee');
  const pageDark = (page) => dark() && !page.pdf;

  function drawStrokes(ctx, strokes, x0, y0, x1, y1, darkPage) {
    for (const highlights of [true, false]) {
      ctx.globalCompositeOperation = highlights && !darkPage ? 'multiply' : 'source-over';
      for (const stroke of strokes) {
        const tool = TOOLS[stroke.tool] || TOOLS.pen;
        if (!!tool.flat !== highlights) continue;
        const b = boxOf(stroke);
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
        ctx.globalAlpha = tool.alpha;
        ctx.fillStyle = resolveColour(stroke.colour, darkPage);
        ctx.fill(outline(stroke));
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------ pictures */

  const bitmaps = new Map();

  function bitmapFor(image) {
    let entry = bitmaps.get(image.id);
    if (!entry) {
      entry = { state: 'loading', img: null, promise: null };
      bitmaps.set(image.id, entry);
      entry.promise = Promise.resolve()
        .then(() => (opts.imageFor ? opts.imageFor(image) : null))
        .then((img) => {
          entry.img = img;
          entry.state = img ? 'ready' : 'missing';
        })
        .catch(() => { entry.state = 'missing'; })
        .then(() => schedule(BASE));
    }
    return entry;
  }

  function drawImages(ctx, page, x0, y0, x1, y1, darkPage) {
    for (const im of page.images || []) {
      if (im.x > x1 || im.x + im.w < x0 || im.y > y1 || im.y + im.h < y0) continue;
      const entry = bitmapFor(im);
      if (entry.state === 'ready') {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(entry.img, im.x, im.y, im.w, im.h);
      } else {
        // Still loading, or its file has gone: hold its place.
        ctx.fillStyle = darkPage ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
        ctx.fillRect(im.x, im.y, im.w, im.h);
      }
    }
  }

  const imagesOf = (i) => pages[i].images || (pages[i].images = []);

  /** The topmost picture under a point on page i, or null. */
  function imageAt(i, x, y) {
    const list = pages[i] && pages[i].images;
    if (!list) return null;
    for (let k = list.length - 1; k >= 0; k -= 1) {
      const im = list[k];
      if (x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h) return im;
    }
    return null;
  }

  function renderBase() {
    if (!ready) return;
    const ctx = bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = deskColour();
    ctx.fillRect(0, 0, base.width, base.height);

    const s = cam.scale * dpr;
    const viewTop = cam.y;
    const viewBottom = cam.y + H / cam.scale;
    let centrePage = 0;
    const centre = cam.y + H / 2 / cam.scale;

    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      const top = tops[i];
      if (centre >= top - gap) centrePage = i;
      if (top > viewBottom || top + page.height < viewTop) continue;

      ctx.setTransform(s, 0, 0, s, (lefts[i] - cam.x) * s, (top - cam.y) * s);
      const darkPage = pageDark(page);
      if (page.pdf && !dark()) {
        ctx.shadowColor = 'rgba(0,0,0,0.18)';
        ctx.shadowBlur = 10 * dpr;
      }
      ctx.fillStyle = darkPage ? '#1c1c1e' : '#ffffff';
      ctx.fillRect(0, 0, page.width, page.height);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      const x0 = Math.max(0, cam.x - lefts[i]);
      const y0 = Math.max(0, viewTop - top);
      const x1 = Math.min(page.width, cam.x - lefts[i] + W / cam.scale);
      const y1 = Math.min(page.height, viewBottom - top);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, page.width, page.height);
      ctx.clip();
      const painted = opts.background ? opts.background(ctx, page, i, s) : false;
      if (!painted) drawPaper(ctx, page.paper || (opts.paper && opts.paper()) || 'plain', x0, y0, x1, y1, cam.scale, darkPage);
      drawImages(ctx, page, x0, y0, x1, y1, darkPage);
      drawStrokes(ctx, page.strokes, x0, y0, x1, y1, darkPage);
      ctx.restore();
    }
    placeSelection();
    if (opts.onView) opts.onView({ page: centrePage, pages: pages.length, scale: cam.scale / fitScale });
  }

  let hover = null;

  function renderLive() {
    if (!ready) return;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
    const s = cam.scale * dpr;

    if (active && !active.erase && active.stroke) {
      const i = active.page;
      const page = pages[i];
      const darkPage = pageDark(page);
      const stroke = active.stroke;
      const tool = TOOLS[stroke.tool] || TOOLS.pen;
      lctx.setTransform(s, 0, 0, s, (lefts[i] - cam.x) * s, (tops[i] - cam.y) * s);
      // The newest raw sample rides on the end so the ink never lags the smoothing.
      const draft = active.tail ? { ...stroke, pts: stroke.pts.concat(active.tail) } : { ...stroke };
      delete draft._path;
      lctx.globalAlpha = tool.alpha;
      lctx.fillStyle = resolveColour(stroke.colour, darkPage);
      lctx.fill(outline(draft));
      lctx.globalAlpha = 1;
    }

    const ring = (active && active.erase && active.at) || (hover && (state.mode === 'erase' || hover.erase) ? hover : null);
    if (ring) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.beginPath();
      lctx.arc(ring.cx, ring.cy, ERASER_PX, 0, Math.PI * 2);
      lctx.lineWidth = 1.5;
      lctx.strokeStyle = dark() ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
      lctx.stroke();
    }
  }

  /* ------------------------------------------------------------- history */

  const undoStack = [];
  const redoStack = [];

  function changed(pageIndex) {
    if (pageIndex === 0 && opts.grow) {
      const before = pages[0].height;
      relayout();
      if (pages[0].height !== before) clampCam();
    }
    if (opts.onChange) opts.onChange(pages[pageIndex], pageIndex);
    if (opts.onHistory) opts.onHistory();
  }

  function record(op) {
    undoStack.push(op);
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
  }

  function apply(op, forward) {
    const strokes = pages[op.page].strokes;
    if (op.type === 'image-add' || op.type === 'image-remove') {
      const list = imagesOf(op.page);
      const adding = (op.type === 'image-add') === forward;
      if (adding) list.splice(Math.min(op.index ?? list.length, list.length), 0, op.image);
      else {
        const k = list.indexOf(op.image);
        if (k >= 0) list.splice(k, 1);
        if (selected && selected.image === op.image) select(null);
      }
    } else if (op.type === 'image-move') {
      Object.assign(op.image, forward ? op.to : op.from);
    } else if (op.type === 'add') {
      if (forward) strokes.push(op.stroke);
      else {
        const k = strokes.lastIndexOf(op.stroke);
        if (k >= 0) strokes.splice(k, 1);
      }
    } else if (op.type === 'erase') {
      if (forward) {
        for (const { stroke } of op.removed) {
          const k = strokes.indexOf(stroke);
          if (k >= 0) strokes.splice(k, 1);
        }
      } else {
        for (let j = op.removed.length - 1; j >= 0; j -= 1) {
          const { stroke, index } = op.removed[j];
          strokes.splice(Math.min(index, strokes.length), 0, stroke);
        }
      }
    }
    renderBase();
    changed(op.page);
  }

  /* --------------------------------------------------------------- input */

  const touches = new Map();
  let active = null;
  let penEverSeen = false;
  let penActiveAt = 0;
  let gesture = null;
  let inertia = null;

  function pressureOf(e) {
    if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
    return 0.5;
  }

  function beginStroke(e, erase) {
    const pt = toPage(e.clientX, e.clientY);
    if (!pt) return false;
    active = { id: e.pointerId, pointerType: e.pointerType, page: pt.i, erase };
    if (erase) {
      active.removed = [];
      eraseAt(e);
    } else {
      const tool = TOOLS[state.tool];
      active.stroke = {
        id: newStrokeId(),
        tool: state.tool,
        colour: state.tool === 'highlighter' ? state.highlight : state.colour,
        size: Math.round(tool.size * state.sizeStep * 100) / 100,
        pts: [pt.x, pt.y, pressureOf(e)],
      };
      active.sx = pt.x;
      active.sy = pt.y;
      active.tail = null;
      // Held still on a picture, the pen picks the picture up instead.
      const under = readOnly ? null : imageAt(pt.i, pt.x, pt.y);
      if (under) {
        active.hold = {
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            if (!active || !active.hold) return;
            active = null;
            renderLive();
            select({ page: pt.i, image: under });
          }, HOLD_MS),
        };
      }
    }
    renderLive();
    return true;
  }

  function dropHold() {
    if (active && active.hold) {
      clearTimeout(active.hold.timer);
      active.hold = null;
    }
  }

  function addSample(e) {
    if (active.hold && Math.hypot(e.clientX - active.hold.x, e.clientY - active.hold.y) > TAP_SLOP_PX) dropHold();
    const pt = toPage(e.clientX, e.clientY, active.page);
    const p = pressureOf(e);
    const tool = TOOLS[active.stroke.tool] || TOOLS.pen;
    const k = 1 - tool.smoothing;
    const sx = active.sx + (pt.x - active.sx) * k;
    const sy = active.sy + (pt.y - active.sy) * k;
    const pts = active.stroke.pts;
    const lx = pts[pts.length - 3];
    const ly = pts[pts.length - 2];
    active.tail = [pt.x, pt.y, p];
    if (Math.hypot(sx - lx, sy - ly) * cam.scale < MIN_SAMPLE_PX) return;
    pts.push(sx, sy, p);
    active.sx = sx;
    active.sy = sy;
  }

  function eraseAt(e) {
    const pt = toPage(e.clientX, e.clientY, active.page);
    active.at = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
    const strokes = pages[active.page].strokes;
    const r = ERASER_PX / cam.scale;
    let hit = false;
    for (let k = strokes.length - 1; k >= 0; k -= 1) {
      if (hits(strokes[k], pt.x, pt.y, r)) {
        active.removed.push({ stroke: strokes[k], index: k });
        strokes.splice(k, 1);
        hit = true;
      }
    }
    if (hit) renderBase();
  }

  function endStroke() {
    dropHold();
    const done = active;
    active = null;
    if (!done) return;
    if (done.erase) {
      if (done.removed.length) {
        record({ type: 'erase', page: done.page, removed: done.removed });
        changed(done.page);
      }
    } else if (done.stroke) {
      if (done.tail) done.stroke.pts.push(...done.tail);
      pages[done.page].strokes.push(done.stroke);
      record({ type: 'add', page: done.page, stroke: done.stroke });
      renderBase();
      changed(done.page);
    }
    renderLive();
  }

  function stopInertia() {
    if (inertia) {
      cancelAnimationFrame(inertia.raf);
      clearTimeout(inertia.timer);
      inertia = null;
    }
  }

  function startGesture() {
    const pts = [...touches.values()];
    if (pts.length === 1) {
      gesture = { kind: 'pan', x: pts[0].x, y: pts[0].y, vx: 0, vy: 0, t: performance.now() };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      gesture = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: cam.scale,
        docX: (mx - rect.left) / cam.scale + cam.x,
        docY: (my - rect.top) / cam.scale + cam.y,
      };
    } else {
      gesture = null;
    }
  }

  function moveGesture() {
    const pts = [...touches.values()];
    if (!gesture) return;
    if (gesture.kind === 'pan' && pts.length === 1) {
      const now = performance.now();
      const dx = pts[0].x - gesture.x;
      const dy = pts[0].y - gesture.y;
      const dt = Math.max(1, now - gesture.t);
      gesture.vx = gesture.vx * 0.2 + (dx / dt) * 0.8;
      gesture.vy = gesture.vy * 0.2 + (dy / dt) * 0.8;
      gesture.x = pts[0].x;
      gesture.y = pts[0].y;
      gesture.t = now;
      cam.x -= dx / cam.scale;
      cam.y -= dy / cam.scale;
    } else if (gesture.kind === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      cam.scale = gesture.scale * (dist / gesture.dist);
      clampCam();
      cam.x = gesture.docX - (mx - rect.left) / cam.scale;
      cam.y = gesture.docY - (my - rect.top) / cam.scale;
    }
    clampCam();
    schedule(BASE | LIVE);
  }

  /* A fling only runs while someone is looking at it, so animation frames are
     enough here - no timer backup needed. */
  function fling(vx, vy) {
    stopInertia();
    if (Math.hypot(vx, vy) < 0.15) return;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(48, now - last);
      last = now;
      const bx = cam.x;
      const by = cam.y;
      cam.x -= (vx * dt) / cam.scale;
      cam.y -= (vy * dt) / cam.scale;
      clampCam();
      const decay = Math.pow(0.994, dt);
      vx *= decay;
      vy *= decay;
      renderBase();
      renderLive();
      const stuck = cam.x === bx && cam.y === by;
      if (Math.hypot(vx, vy) < 0.02 || stuck) {
        inertia = null;
        return;
      }
      inertia.raf = requestAnimationFrame(step);
    };
    inertia = { raf: requestAnimationFrame(step), timer: 0 };
  }

  let tap = null;

  const onDown = (e) => {
    rect = el.getBoundingClientRect();
    if (selected) select(null);
    if (e.pointerType === 'mouse' && e.button === 2 && !readOnly) {
      const pt = toPage(e.clientX, e.clientY);
      const hit = pt && imageAt(pt.i, pt.x, pt.y);
      if (hit) select({ page: pt.i, image: hit });
      return;
    }
    if (e.pointerType === 'pen') {
      penEverSeen = true;
      penActiveAt = performance.now();
    }
    const fingerDraws = e.pointerType === 'touch' && !penEverSeen && !!(opts.fingerDraws && opts.fingerDraws());
    const canDraw = !readOnly && (e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0) || fingerDraws);

    if (canDraw && !active && (e.pointerType === 'pen' || touches.size === 0)) {
      // A pen coming down ends whatever the palm was doing.
      if (e.pointerType === 'pen' && touches.size) {
        touches.clear();
        gesture = null;
      }
      stopInertia();
      const erase = state.mode === 'erase' || (e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2)));
      if (beginStroke(e, erase)) {
        capture(el, e.pointerId);
        e.preventDefault();
      }
      return;
    }

    // Locked for reading: a pen or mouse drag pans, exactly as a finger does.
    const pans = e.pointerType === 'touch' || (readOnly && (e.pointerType === 'pen' || e.pointerType === 'mouse'));
    if (pans) {
      if (active && active.pointerType === 'pen') return; // palm while writing
      // A palm landing between words, just after the pen lifted.
      if (e.pointerType === 'touch' && !readOnly && performance.now() - penActiveAt < 400) return;
      capture(el, e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      tap = touches.size === 1 && e.pointerType === 'touch' && !readOnly
        ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }
        : null;
      stopInertia();
      startGesture();
    }
  };

  const onMove = (e) => {
    if (e.pointerType === 'pen') penActiveAt = performance.now();
    if (active && e.pointerId === active.id) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      if (active.erase) {
        for (const ev of list) eraseAt(ev);
      } else {
        for (const ev of list) addSample(ev);
      }
      renderLive();
      return;
    }
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap && (e.pointerId !== tap.id || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_PX)) tap = null;
      moveGesture();
      return;
    }
    if (e.pointerType === 'pen' && !active) {
      // Hovering pen: show the eraser ring where it would erase.
      rect = el.getBoundingClientRect();
      hover = { cx: e.clientX - rect.left, cy: e.clientY - rect.top, erase: !!(e.buttons & 32) };
      if (state.mode === 'erase' || hover.erase) renderLive();
    }
  };

  const onUp = (e) => {
    if (e.pointerType === 'pen') penActiveAt = performance.now();
    if (active && e.pointerId === active.id) {
      endStroke();
      return;
    }
    if (touches.has(e.pointerId)) {
      const wasPan = gesture && gesture.kind === 'pan';
      const { vx = 0, vy = 0 } = gesture || {};
      touches.delete(e.pointerId);
      // A quick tap with a finger on a picture selects it.
      if (tap && tap.id === e.pointerId && e.type === 'pointerup' && performance.now() - tap.t < TAP_MS) {
        tap = null;
        const pt = toPage(e.clientX, e.clientY);
        const hit = pt && imageAt(pt.i, pt.x, pt.y);
        if (hit) {
          gesture = null;
          touches.clear();
          select({ page: pt.i, image: hit });
          return;
        }
      }
      tap = null;
      if (touches.size) startGesture();
      else {
        gesture = null;
        if (wasPan && e.type === 'pointerup') fling(vx, vy);
      }
    }
  };

  const onLeave = (e) => {
    if (e.pointerType === 'pen' && hover) {
      hover = null;
      renderLive();
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    rect = el.getBoundingClientRect();
    stopInertia();
    if (e.ctrlKey) {
      const docX = (e.clientX - rect.left) / cam.scale + cam.x;
      const docY = (e.clientY - rect.top) / cam.scale + cam.y;
      cam.scale *= Math.exp(-e.deltaY * 0.0022);
      clampCam();
      cam.x = docX - (e.clientX - rect.left) / cam.scale;
      cam.y = docY - (e.clientY - rect.top) / cam.scale;
    } else {
      cam.x += e.deltaX / cam.scale;
      cam.y += e.deltaY / cam.scale;
    }
    clampCam();
    schedule(BASE | LIVE);
  };

  /* --------------------------------------------------- selected picture */

  let selected = null;
  let drag = null;

  const selEl = document.createElement('div');
  selEl.className = 'ink-sel';
  selEl.hidden = true;
  const selHandle = document.createElement('div');
  selHandle.className = 'ink-sel-handle';
  const selBar = document.createElement('div');
  selBar.className = 'ink-sel-bar';
  const selDelete = document.createElement('button');
  selDelete.className = 'ink-sel-btn';
  selDelete.textContent = 'Delete';
  selBar.append(selDelete);
  selEl.append(selHandle, selBar);
  el.append(selEl);

  function select(next) {
    selected = next;
    drag = null;
    placeSelection();
    if (opts.onSelect) opts.onSelect(selected ? selected.image : null);
  }

  function placeSelection() {
    if (!selected || !ready) {
      selEl.hidden = true;
      return;
    }
    const { page: i, image: im } = selected;
    const top = (tops[i] + im.y - cam.y) * cam.scale;
    selEl.hidden = false;
    // Near the top of the screen the Delete button goes underneath instead.
    selEl.classList.toggle('bar-below', top < 120);
    selEl.style.transform = `translate(${(lefts[i] + im.x - cam.x) * cam.scale}px, ${top}px)`;
    selEl.style.width = `${im.w * cam.scale}px`;
    selEl.style.height = `${im.h * cam.scale}px`;
  }

  function removeImage() {
    if (!selected) return;
    const { page: i, image: im } = selected;
    const list = imagesOf(i);
    const index = list.indexOf(im);
    if (index < 0) return;
    list.splice(index, 1);
    record({ type: 'image-remove', page: i, image: im, index });
    select(null);
    renderBase();
    changed(i);
  }

  selEl.addEventListener('pointerdown', (e) => {
    // Nothing on the frame may start a stroke underneath it.
    e.stopPropagation();
    if (!selected || e.target.closest('.ink-sel-bar')) return;
    e.preventDefault();
    capture(selEl, e.pointerId);
    const im = selected.image;
    drag = {
      id: e.pointerId,
      resize: e.target === selHandle,
      sx: e.clientX,
      sy: e.clientY,
      from: { x: im.x, y: im.y, w: im.w, h: im.h },
    };
  });

  selEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !selected) return;
    e.stopPropagation();
    const im = selected.image;
    const page = pages[selected.page];
    const dx = (e.clientX - drag.sx) / cam.scale;
    const dy = (e.clientY - drag.sy) / cam.scale;
    if (drag.resize) {
      const ratio = drag.from.h / drag.from.w;
      im.w = Math.max(MIN_IMAGE, Math.min(page.width * 1.5, drag.from.w + dx));
      im.h = im.w * ratio;
    } else {
      // Keep a corner on the page so it can always be grabbed again.
      im.x = Math.min(page.width - MIN_IMAGE, Math.max(MIN_IMAGE - im.w, drag.from.x + dx));
      im.y = Math.max(MIN_IMAGE - im.h, drag.from.y + dy);
    }
    schedule(BASE);
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id || !selected) return;
    e.stopPropagation();
    const im = selected.image;
    const to = { x: im.x, y: im.y, w: im.w, h: im.h };
    const from = drag.from;
    drag = null;
    if (to.x !== from.x || to.y !== from.y || to.w !== from.w || to.h !== from.h) {
      record({ type: 'image-move', page: selected.page, image: im, from, to });
      renderBase();
      changed(selected.page);
    }
  };
  selEl.addEventListener('pointerup', endDrag);
  selEl.addEventListener('pointercancel', endDrag);
  selDelete.addEventListener('click', (e) => {
    e.stopPropagation();
    removeImage();
  });

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (measure()) schedule(BASE | LIVE); })
    : null;
  if (observer) observer.observe(el);

  /* The page and the desk follow the theme. A change while the page is on
     screen - dark mode at sunset, or the setting changed beside it in the
     tablet's split view - repaints straight away, not at the next pan. */
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => schedule(BASE | LIVE);
  scheme.addEventListener('change', onTheme);
  const themeWatch = new MutationObserver(onTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ----------------------------------------------------------------- api */

  return {
    el,
    /** Call once the element is in the document, and whenever it is shown. */
    layout() {
      if (measure()) {
        renderBase();
        renderLive();
      }
    },
    redraw() { schedule(BASE); },
    setTool(tool) {
      state.tool = tool;
      state.mode = 'draw';
    },
    setMode(mode) {
      state.mode = mode;
      renderLive();
    },
    setColour(colour) {
      if (state.tool === 'highlighter') state.highlight = colour;
      else state.colour = colour;
    },
    setSizeStep(step) { state.sizeStep = step; },
    get state() { return { ...state }; },
    undo() {
      const op = undoStack.pop();
      if (!op) return;
      redoStack.push(op);
      apply(op, false);
    },
    redo() {
      const op = redoStack.pop();
      if (!op) return;
      undoStack.push(op);
      apply(op, true);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    /** Forgets undo and redo - for when the page was replaced from elsewhere. */
    clearHistory() {
      undoStack.length = 0;
      redoStack.length = 0;
      if (opts.onHistory) opts.onHistory();
    },
    scrollToPage(i) {
      if (!ready || !pages[i]) return;
      cam.y = tops[i] - topPad / cam.scale;
      clampCam();
      renderBase();
    },
    /** Pages whose background (a PDF page) is on screen at [pixelScale]. */
    visiblePages() {
      const viewTop = cam.y;
      const viewBottom = cam.y + H / cam.scale;
      const out = [];
      for (let i = 0; i < pages.length; i += 1) {
        if (tops[i] <= viewBottom && tops[i] + pages[i].height >= viewTop) out.push(i);
      }
      return out;
    },
    pixelScale: () => cam.scale * dpr,
    setReadOnly(on) {
      readOnly = !!on;
      hover = null;
      if (readOnly) select(null);
      renderLive();
    },
    /** Puts a picture on page i and selects it, ready to be placed. */
    addImage(i, image) {
      const list = imagesOf(i);
      list.push(image);
      record({ type: 'image-add', page: i, image, index: list.length - 1 });
      renderBase();
      changed(i);
      select({ page: i, image });
    },
    /** The page under the middle of the screen, and the point on it. */
    viewCentre() {
      const cx = cam.x + W / 2 / cam.scale;
      const cy = cam.y + H / 2 / cam.scale;
      let i = 0;
      for (let k = 0; k < pages.length; k += 1) if (cy >= tops[k]) i = k;
      return { i, x: cx - lefts[i], y: cy - tops[i], width: W / cam.scale };
    },
    /** The picture being dragged right now, which a remote update must not move. */
    dragging: () => (drag && selected ? selected.image : null),
    /** After the pages were changed from outside - a shared page's stream. */
    refresh() {
      if (selected && !imagesOf(selected.page).includes(selected.image)) select(null);
      if (!ready) return;
      relayout();
      clampCam();
      schedule(BASE | LIVE);
    },
    /** Every picture's pixels, for drawing the page somewhere else. */
    whenImagesReady() {
      const all = pages.flatMap((p) => p.images || []);
      return Promise.all(all.map((im) => bitmapFor(im).promise));
    },
    get readOnly() { return readOnly; },
    /** Back to fitting the width, keeping the same part of the page centred. */
    zoomToFit() {
      if (!ready) return;
      const centreY = cam.y + H / 2 / cam.scale;
      cam.scale = fitScale;
      cam.y = centreY - H / 2 / cam.scale;
      clampCam();
      renderBase();
      renderLive();
    },
    /** Next or previous page; on one endless page, a screenful. */
    step(dir) {
      if (!ready) return;
      if (pages.length > 1) {
        const centre = cam.y + H / 2 / cam.scale;
        let i = 0;
        for (let k = 0; k < pages.length; k += 1) if (centre >= tops[k] - gap) i = k;
        const target = Math.min(pages.length - 1, Math.max(0, i + dir));
        cam.y = tops[target] - topPad / cam.scale;
      } else {
        cam.y += dir * (H * 0.85) / cam.scale;
      }
      clampCam();
      renderBase();
      renderLive();
    },
    /** A page drawn onto its own canvas at [scale] - for sharing as an image. */
    renderPage(i, scale = 2) {
      const page = pages[i];
      let height = page.height;
      if (opts.grow) {
        let bottom = 0;
        for (const s of page.strokes) bottom = Math.max(bottom, boxOf(s)[3]);
        for (const im of page.images || []) bottom = Math.max(bottom, im.y + im.h);
        height = Math.min(page.height, Math.max(400, bottom + 48));
      }
      const c = document.createElement('canvas');
      c.width = Math.round(page.width * scale);
      c.height = Math.round(height * scale);
      const ctx = c.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, page.width, height);
      const painted = opts.background ? opts.background(ctx, page, i, scale) : false;
      if (!painted) drawPaper(ctx, page.paper || (opts.paper && opts.paper()) || 'plain', 0, 0, page.width, height, scale, false);
      drawImages(ctx, page, 0, 0, page.width, height, false);
      drawStrokes(ctx, page.strokes, 0, 0, page.width, height, false);
      return c;
    },
    destroy() {
      stopInertia();
      dropHold();
      for (const entry of bitmaps.values()) {
        if (entry.img && entry.img.close) entry.img.close();
      }
      bitmaps.clear();
      if (observer) observer.disconnect();
      scheme.removeEventListener('change', onTheme);
      themeWatch.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
    },
  };
}
