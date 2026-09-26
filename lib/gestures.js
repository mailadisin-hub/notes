/**
 * Reading intent out of a stroke: a scribble meant as an erasure, and a rough
 * shape meant as a neat one.
 *
 * Everything here is pure - points in, an answer out - so the thresholds can be
 * tried against real strokes without a canvas, a pointer or a page. The view
 * decides what to do with the answer; this file only recognises.
 *
 * Points arrive in the stroke format used everywhere else: a flat array of
 * x, y, pressure triples, in page units.
 */

/* -------------------------------------------------------------- helpers */

const xy = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1]]);
  return out;
};

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function bounds(p) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0) };
}

function pathLength(p) {
  let total = 0;
  for (let i = 1; i < p.length; i += 1) total += dist(p[i - 1], p[i]);
  return total;
}

/** Distance from c to the infinite line through a and b. */
function offLine(a, b, c) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return dist(a, c);
  return Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / len;
}

/**
 * Ramer-Douglas-Peucker: keeps the points that carry the shape and drops the
 * ones that only carry the wobble, which leaves the corners.
 */
function simplify(p, tolerance) {
  if (p.length < 3) return p.slice();
  let worst = 0;
  let at = 0;
  for (let i = 1; i < p.length - 1; i += 1) {
    const d = offLine(p[0], p[p.length - 1], p[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tolerance) return [p[0], p[p.length - 1]];
  const left = simplify(p.slice(0, at + 1), tolerance);
  const right = simplify(p.slice(at), tolerance);
  return left.slice(0, -1).concat(right);
}

/** The turn at b, in degrees: 0 is straight on, 180 is doubling back. */
function turn(a, b, c) {
  const ax = b[0] - a[0];
  const ay = b[1] - a[1];
  const bx = c[0] - b[0];
  const by = c[1] - b[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (!la || !lb) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** The path walked at an even step, so density of sampling stops mattering. */
function resample(p, step) {
  const out = [p[0]];
  let carry = 0;
  for (let i = 1; i < p.length; i += 1) {
    const a = p[i - 1];
    const b = p[i];
    const len = dist(a, b);
    if (!len) continue;
    let at = step - carry;
    while (at <= len) {
      out.push([a[0] + ((b[0] - a[0]) * at) / len, a[1] + ((b[1] - a[1]) * at) / len]);
      at += step;
    }
    carry = (carry + len) % step;
  }
  return out;
}

/**
 * How many times over the stroke covers its own width.
 *
 * This is what separates a crossing-out from handwriting. Writing advances
 * along its line: the pen moves up and down constantly, but it only crosses the
 * width of the word once, so this comes out near 1 whether it is a single m or
 * a whole joined sentence, and whatever size it is written at. A crossing-out
 * goes back over the same few centimetres four or five times, and says so.
 *
 * Measured along whichever way the stroke is longer, which is the line the
 * writing runs along, or the line a crossing-out is scrubbed along.
 */
function timesOver(p, box) {
  const alongX = box.w >= box.h;
  const span = Math.max(1, alongX ? box.w : box.h);
  let travel = 0;
  for (let i = 1; i < p.length; i += 1) {
    travel += Math.abs(alongX ? p[i][0] - p[i - 1][0] : p[i][1] - p[i - 1][1]);
  }
  return travel / span;
}

/** Points thinned so short jitter cannot masquerade as a change of direction. */
function coarse(p, step) {
  const out = [p[0]];
  for (const q of p) if (dist(out[out.length - 1], q) >= step) out.push(q);
  const last = p[p.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/* ------------------------------------------------------------- scribble */

/**
 * A scribble: the same ground gone over again and again, the way anyone crosses
 * something out.
 *
 * Counting sharp turns is not enough on its own and was the mistake in the
 * first version of this - joined handwriting is nothing but sharp turns, and an
 * m at speed was being wiped out. What a crossing-out does and writing never
 * does is go over the same ground again: writing advances along its line and
 * crosses the width of a word once, however many times the pen changes
 * direction inside it.
 *
 * So both have to hold: it doubles back repeatedly, and it covers its own width
 * several times over while doing it.
 */
export function looksLikeScribble(pts) {
  const p = xy(pts);
  if (p.length < 14) return false;
  const box = bounds(p);
  if (box.diag < 16) return false;

  const length = pathLength(p);
  if (length < box.diag * 2.2) return false;

  const steps = coarse(p, Math.max(3, box.diag / 25));
  if (steps.length < 8) return false;

  let reversals = 0;
  for (let i = 1; i < steps.length - 1; i += 1) {
    if (turn(steps[i - 1], steps[i], steps[i + 1]) > 110) reversals += 1;
  }
  if (reversals < 2) return false;

  return timesOver(p, box) >= 2.4;
}

/* --------------------------------------------------------------- shapes */

const CLOSE_ENOUGH = 0.28;   // gap between the ends, against the shape's size
const SQUARE = 26;           // how far off ninety degrees a corner may be

/**
 * Simplifying leaves a corner wherever the hand wobbled hardest, even on a side
 * that is meant to be straight. A real corner is one the path actually turns
 * at, and is not sitting on top of the corner before it.
 */
function realCorners(ring, diag) {
  const near = diag * 0.09;
  const merged = [];
  for (const q of ring) {
    if (!merged.length || dist(merged[merged.length - 1], q) > near) merged.push(q);
  }
  if (merged.length > 1 && dist(merged[0], merged[merged.length - 1]) <= near) merged.pop();
  if (merged.length < 3) return merged;

  const kept = [];
  for (let i = 0; i < merged.length; i += 1) {
    const a = merged[(i + merged.length - 1) % merged.length];
    const b = merged[i];
    const c = merged[(i + 1) % merged.length];
    if (turn(a, b, c) > 25) kept.push(b);
  }
  return kept.length >= 3 ? kept : merged;
}

function idealLine(a, b, pressure) {
  return [a[0], a[1], pressure, b[0], b[1], pressure];
}

function idealPolygon(corners, pressure) {
  const out = [];
  const ring = corners.concat([corners[0]]);
  for (let i = 1; i < ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i];
    /* Drawn as a run of points rather than two: every other part of the app
       treats a stroke as a path, and a straight run of points is still one. */
    const steps = Math.max(2, Math.round(dist(a, b) / 6));
    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, pressure);
    }
  }
  out.push(ring[0][0], ring[0][1], pressure);
  return out;
}

function idealEllipse(box, pressure) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const steps = Math.max(24, Math.round((rx + ry) / 2));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a), pressure);
  }
  return out;
}

/**
 * The neat shape a rough one was meant to be, or null when it is not clear
 * enough to be worth guessing: a line, a rectangle, a triangle or an ellipse.
 *
 * Returns { kind, pts }. Nothing else about the stroke changes, so the result
 * is an ordinary stroke and erasing, undo and sync know nothing about shapes.
 */
export function recogniseShape(pts) {
  const p = xy(pts);
  if (p.length < 6) return null;
  const box = bounds(p);
  if (box.diag < 24) return null;

  const pressure = pts.length ? pts[2] : 0.5;
  const length = pathLength(p);
  const first = p[0];
  const last = p[p.length - 1];

  /* An open stroke can only sensibly be a line, and only if it barely strays
     from the straight run between its ends. */
  const closed = dist(first, last) < box.diag * CLOSE_ENOUGH;
  if (!closed) {
    let worst = 0;
    for (const q of p) worst = Math.max(worst, offLine(first, last, q));
    if (worst < box.diag * 0.07 && length < box.diag * 1.25) {
      return { kind: 'line', pts: idealLine(first, last, pressure) };
    }
    return null;
  }

  /* A closed shape is judged by its corners. The wobble of a drawn line is a
     fraction of the shape's size, so the tolerance is too. */
  const ring = simplify(p, box.diag * 0.085);
  const corners = realCorners(ring.slice(0, -1), box.diag);   // the last point closes the loop

  if (corners.length === 3) {
    return { kind: 'triangle', pts: idealPolygon(corners, pressure) };
  }

  if (corners.length === 4) {
    let square = true;
    for (let i = 0; i < 4; i += 1) {
      const a = corners[(i + 3) % 4];
      const b = corners[i];
      const c = corners[(i + 1) % 4];
      if (Math.abs(turn(a, b, c) - 90) > SQUARE) square = false;
    }
    /* Square corners mean it was meant to sit straight, so it is rebuilt from
       the bounding box - which is what anyone drawing a box is aiming at. */
    if (square) {
      const rect = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
      return { kind: 'rectangle', pts: idealPolygon(rect, pressure) };
    }
    return { kind: 'quadrilateral', pts: idealPolygon(corners, pressure) };
  }

  /* Many corners and a closed path: a round shape. It has to actually be round
     - every point about the same way out from the middle. */
  if (corners.length >= 5) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const rx = Math.max(1, box.w / 2);
    const ry = Math.max(1, box.h / 2);
    let worst = 0;
    for (const [x, y] of p) {
      // 1 on the ellipse through the bounding box, less inside, more outside.
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
      worst = Math.max(worst, Math.abs(r - 1));
    }
    if (worst < 0.22) return { kind: 'ellipse', pts: idealEllipse(box, pressure) };
  }

  return null;
}

/* ---------------------------------------------------------------- ruler */

/**
 * The point on the ruler's edge nearest (x, y), or null when it is too far
 * away for the pen to be leaning on it.
 *
 * [ruler] is { x, y, angle, length } in page units: the middle of the edge,
 * the direction it runs in, and how long it is.
 */
export function snapToRuler(ruler, x, y, reach) {
  const cos = Math.cos(ruler.angle);
  const sin = Math.sin(ruler.angle);
  const dx = x - ruler.x;
  const dy = y - ruler.y;
  // Along the edge, and away from it.
  const along = dx * cos + dy * sin;
  const away = -dx * sin + dy * cos;
  /* Only the drawing side counts: the pen runs along the edge, and the hand is
     never on the ruler itself. Past either end there is nothing to lean on. */
  if (Math.abs(away) > reach) return null;
  if (Math.abs(along) > ruler.length / 2) return null;
  return { x: ruler.x + cos * along, y: ruler.y + sin * along, along };
}

/**
 * Where (x, y) lands on the ruler's edge once the pen is already running along
 * it: always on the edge, and never past either end, the way a pencil stops at
 * the end of a real one.
 */
export function projectOnRuler(ruler, x, y) {
  const cos = Math.cos(ruler.angle);
  const sin = Math.sin(ruler.angle);
  const half = ruler.length / 2;
  let along = (x - ruler.x) * cos + (y - ruler.y) * sin;
  along = Math.min(half, Math.max(-half, along));
  return { x: ruler.x + cos * along, y: ruler.y + sin * along };
}
