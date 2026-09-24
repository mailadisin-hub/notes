/**
 * Handwriting: what a stroke is, the shape it draws, and how it is stored.
 *
 * A stroke is a list of (x, y, pressure) samples in page units - never
 * pixels - so the same note draws at the same size on a phone, a tablet and a
 * laptop, and stays sharp at any zoom. Nothing is rasterised until it is on
 * screen.
 *
 * The drawn shape is one filled outline per stroke: left and right edges
 * offset from the centre line by half the pressure-scaled width, joined by
 * round caps. One fill per stroke is what keeps a highlighter from darkening
 * where it crosses itself, and what lets a page of a few thousand strokes
 * redraw inside a frame.
 */

export const TOOLS = {
  pen: { label: 'Pen', size: 3, alpha: 1, pressure: 0.8, smoothing: 0.3 },
  pencil: { label: 'Pencil', size: 1.8, alpha: 0.78, pressure: 0.55, smoothing: 0.15 },
  highlighter: { label: 'Highlighter', size: 18, alpha: 0.3, pressure: 0, smoothing: 0.45, flat: true },
};
export const TOOL_IDS = Object.keys(TOOLS);

/** Sizes offered per tool, as multiples of its base size. */
export const SIZE_STEPS = [0.6, 1, 1.8];

/** The default colour follows the theme: dark ink on a light page, light on dark. */
export const INK = 'ink';
export const INK_COLOURS = [INK, '#ff3b30', '#ff9500', '#34c759', '#007aff', '#af52de'];
export const HIGHLIGHT_COLOURS = ['#ffd60a', '#30d158', '#64d2ff', '#ff9f0a', '#ff6482'];

export function resolveColour(colour, dark) {
  if (colour === INK) return dark ? '#f2f2f7' : '#1c1c1e';
  return colour;
}

/* ------------------------------------------------------------------ shape */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* Pens report pressure from 0 to 1, but a relaxed hand sits around 0.3-0.5.
   Easing it keeps ordinary writing near full width and saves the thin end for
   a deliberately light touch. */
const pressureCurve = (p) => Math.pow(clamp01(p), 0.72);

function widthAt(stroke, tool, p) {
  if (tool.flat) return stroke.size;
  return stroke.size * (1 - tool.pressure + tool.pressure * pressureCurve(p));
}

/**
 * The stroke's filled outline as a Path2D, in page units. Cached on the stroke
 * until its points change - an outline is recomputed only while it is being
 * drawn.
 */
export function outline(stroke) {
  if (stroke._path && stroke._pathLen === stroke.pts.length) return stroke._path;
  const tool = TOOLS[stroke.tool] || TOOLS.pen;
  const pts = stroke.pts;
  const n = Math.floor(pts.length / 3);
  const path = new Path2D();

  if (n === 1 || (n === 2 && pts[0] === pts[3] && pts[1] === pts[4])) {
    const r = widthAt(stroke, tool, pts[2]) / 2;
    if (tool.flat) path.rect(pts[0] - r, pts[1] - r * 0.4, r * 2, r * 0.8);
    else path.arc(pts[0], pts[1], Math.max(r, 0.4), 0, Math.PI * 2);
    stroke._path = path;
    stroke._pathLen = pts.length;
    return path;
  }

  const left = new Float64Array(n * 2);
  const right = new Float64Array(n * 2);
  const radius = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = pts[b * 3] - pts[a * 3];
    let dy = pts[b * 3 + 1] - pts[a * 3 + 1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const r = widthAt(stroke, tool, pts[i * 3 + 2]) / 2;
    radius[i] = r;
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    left[i * 2] = x - dy * r;
    left[i * 2 + 1] = y + dx * r;
    right[i * 2] = x + dy * r;
    right[i * 2 + 1] = y - dx * r;
  }

  /* Each edge is smoothed with quadratic curves through segment midpoints,
     which rounds off the facets a 60 Hz mouse or a quick flick would leave. */
  const edge = (arr, forward) => {
    const at = (k) => (forward ? k : n - 1 - k);
    for (let k = 1; k < n - 1; k += 1) {
      const i = at(k);
      const j = at(k + 1);
      path.quadraticCurveTo(arr[i * 2], arr[i * 2 + 1], (arr[i * 2] + arr[j * 2]) / 2, (arr[i * 2 + 1] + arr[j * 2 + 1]) / 2);
    }
    const last = at(n - 1);
    path.lineTo(arr[last * 2], arr[last * 2 + 1]);
  };

  path.moveTo(left[0], left[1]);
  edge(left, true);
  if (tool.flat) {
    path.lineTo(right[(n - 1) * 2], right[(n - 1) * 2 + 1]);
  } else {
    // Round cap at the end: from the left edge, round the front, to the right.
    const i = n - 1;
    const angle = Math.atan2(left[i * 2 + 1] - pts[i * 3 + 1], left[i * 2] - pts[i * 3]);
    path.arc(pts[i * 3], pts[i * 3 + 1], radius[i], angle, angle - Math.PI, true);
  }
  edge(right, false);
  if (tool.flat) {
    path.lineTo(left[0], left[1]);
  } else {
    const angle = Math.atan2(right[1] - pts[1], right[0] - pts[0]);
    path.arc(pts[0], pts[1], radius[0], angle, angle - Math.PI, true);
  }
  path.closePath();

  stroke._path = path;
  stroke._pathLen = pts.length;
  return path;
}

/** Bounding box [minX, minY, maxX, maxY], padded by the widest point. */
export function boxOf(stroke) {
  if (stroke._box && stroke._boxLen === stroke.pts.length) return stroke._box;
  const pts = stroke.pts;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  const pad = stroke.size;
  stroke._box = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  stroke._boxLen = pts.length;
  return stroke._box;
}

/** True if the circle (x, y, r) touches the stroke's centre line or its width. */
export function hits(stroke, x, y, r) {
  const b = boxOf(stroke);
  if (x + r < b[0] || x - r > b[2] || y + r < b[1] || y - r > b[3]) return false;
  const pts = stroke.pts;
  const reach = r + stroke.size / 2;
  const reach2 = reach * reach;
  if (pts.length === 3) return (pts[0] - x) ** 2 + (pts[1] - y) ** 2 <= reach2;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    const ax = pts[i]; const ay = pts[i + 1];
    const bx = pts[i + 3]; const by = pts[i + 4];
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    if (px * px + py * py <= reach2) return true;
  }
  return false;
}

/* ----------------------------------------------------------------- storage */

/*
 * Compact encoding. Coordinates are quantised to an eighth of a unit and
 * pressure to 1/100, stored as zig-zag varint deltas and base64'd. A page of
 * ordinary handwriting comes out around 3 bytes per sample - small enough to
 * sync a dense page inside one Firestore document.
 */
const Q = 8;

function pushVarint(out, value) {
  let v = value < 0 ? (-value * 2) - 1 : value * 2; // zig-zag
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readVarint(bytes, pos) {
  let result = 0;
  let mul = 1;
  let b;
  do {
    b = bytes[pos.i];
    pos.i += 1;
    result += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export function encodePoints(pts) {
  const out = [];
  let px = 0; let py = 0; let pp = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = Math.round(pts[i] * Q);
    const y = Math.round(pts[i + 1] * Q);
    const p = Math.round(clamp01(pts[i + 2]) * 100);
    pushVarint(out, x - px);
    pushVarint(out, y - py);
    pushVarint(out, p - pp);
    px = x; py = y; pp = p;
  }
  return bytesToB64(out);
}

export function decodePoints(b64) {
  const bytes = b64ToBytes(b64);
  const pos = { i: 0 };
  const pts = [];
  let x = 0; let y = 0; let p = 0;
  while (pos.i < bytes.length) {
    x += readVarint(bytes, pos);
    y += readVarint(bytes, pos);
    p += readVarint(bytes, pos);
    pts.push(x / Q, y / Q, p / 100);
  }
  return pts;
}

/** Strokes to a plain, JSON-safe array. */
export function encodeStrokes(strokes) {
  return strokes.map((s) => [TOOL_IDS.indexOf(s.tool), s.colour, Math.round(s.size * 100) / 100, encodePoints(s.pts)]);
}

export function decodeStrokes(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(([tool, colour, size, data]) => ({
    tool: TOOL_IDS[tool] || 'pen',
    colour: colour || INK,
    size: Number(size) || TOOLS.pen.size,
    pts: decodePoints(data || ''),
  })).filter((s) => s.pts.length >= 3);
}

/* ------------------------------------------------------------------ paper */

export const PAPERS = ['plain', 'lined', 'grid', 'dotted'];
export const PAPER_LABELS = { plain: 'Plain', lined: 'Lines', grid: 'Squares', dotted: 'Dots' };
const RULE = 32;

/**
 * Paints a paper pattern over the region (x0, y0)-(x1, y1) of a page, in page
 * units, with the context already transformed to page space. [scale] keeps the
 * rules one screen pixel wide at any zoom.
 */
export function drawPaper(ctx, kind, x0, y0, x1, y1, scale, dark) {
  if (kind === 'plain') return;
  const line = dark ? 'rgba(255,255,255,0.13)' : 'rgba(60,60,67,0.16)';
  const start = Math.floor(y0 / RULE) * RULE;
  ctx.save();
  if (kind === 'dotted') {
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(60,60,67,0.32)';
    const r = Math.max(0.9, 1.4 / scale);
    for (let y = start; y <= y1; y += RULE) {
      for (let x = Math.floor(x0 / RULE) * RULE; x <= x1; x += RULE) {
        ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
    }
  } else {
    ctx.strokeStyle = line;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    for (let y = start; y <= y1; y += RULE) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    if (kind === 'grid') {
      for (let x = Math.floor(x0 / RULE) * RULE; x <= x1; x += RULE) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
