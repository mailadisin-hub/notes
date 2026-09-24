/**
 * Freehand markup, inserted into a note as a PNG.
 *
 * Strokes are kept as point lists rather than painted straight onto the canvas,
 * so undo is a redraw of one fewer stroke instead of a stack of bitmap copies -
 * a phone-sized canvas at 3x device pixel ratio is about 12MB per snapshot.
 *
 * The sheet always paints on white. A sketch drawn in dark mode and exported
 * with a transparent background disappears the moment the note is read in
 * light mode.
 */

import { el, icon, overlay, toast } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';

const COLOURS = ['#1c1c1e', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de'];
const TOOLS = [
  { key: 'pen', label: 'Pen', width: 3.5, alpha: 1, cap: 'round' },
  { key: 'marker', label: 'Marker', width: 14, alpha: 0.42, cap: 'butt' },
  { key: 'pencil', label: 'Pencil', width: 1.6, alpha: 0.85, cap: 'round' },
  { key: 'eraser', label: 'Eraser', width: 20, alpha: 1, cap: 'round' },
];

export function markupSheet(onDone) {
  let tool = TOOLS[0];
  let colour = COLOURS[0];
  const strokes = [];
  let current = null;

  overlay((close) => {
    const canvas = el('canvas', { class: 'markup-canvas' });
    const ctx = canvas.getContext('2d');

    const stage = el('div', { class: 'markup-stage' }, canvas);

    /* ---------------------------------------------------------- paint */

    function sizeCanvas() {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    function redraw() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      for (const stroke of strokes) paintStroke(stroke);
    }

    function paintStroke(stroke) {
      if (stroke.points.length < 2) {
        const p = stroke.points[0];
        if (!p) return;
        ctx.save();
        ctx.globalAlpha = stroke.alpha;
        ctx.fillStyle = stroke.erase ? '#ffffff' : stroke.colour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      ctx.save();
      ctx.globalAlpha = stroke.alpha;
      ctx.strokeStyle = stroke.erase ? '#ffffff' : stroke.colour;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = stroke.cap;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      /* Quadratic midpoints turn a polyline of touch samples into a curve. */
      for (let i = 1; i < stroke.points.length - 1; i += 1) {
        const a = stroke.points[i];
        const b = stroke.points[i + 1];
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      const last = stroke.points[stroke.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.restore();
    }

    /* --------------------------------------------------------- input */

    const pointFrom = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (canvas.width <= 2 || canvas.height <= 2) sizeCanvas();
      canvas.setPointerCapture(e.pointerId);
      current = {
        colour,
        width: tool.width,
        alpha: tool.alpha,
        cap: tool.cap,
        erase: tool.key === 'eraser',
        points: [pointFrom(e)],
      };
      strokes.push(current);
      redraw();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      e.preventDefault();
      const p = pointFrom(e);
      const last = current.points[current.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return;
      current.points.push(p);
      redraw();
    });

    const endStroke = () => {
      if (!current) return;
      current = null;
      haptic();
    };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);
    canvas.addEventListener('pointerleave', endStroke);

    /* --------------------------------------------------------- chrome */

    const swatches = el('div', { class: 'markup-colours' });
    COLOURS.forEach((c) => {
      const dot = el('button', {
        class: `swatch${c === colour ? ' on' : ''}`,
        style: `--sw:${c}`,
        'aria-label': `Colour ${c}`,
      });
      dot.addEventListener('click', () => {
        colour = c;
        haptic('select');
        swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
        dot.classList.add('on');
      });
      swatches.append(dot);
    });

    const toolRow = el('div', { class: 'markup-tools' });
    TOOLS.forEach((t) => {
      const b = el('button', {
        class: `markup-tool${t.key === tool.key ? ' on' : ''}`,
      }, icon(t.key === 'eraser' ? 'eraser' : t.key === 'marker' ? 'marker' : 'markup'),
      el('span', { text: t.label }));
      b.addEventListener('click', () => {
        tool = t;
        haptic('select');
        toolRow.querySelectorAll('.markup-tool').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        swatches.classList.toggle('disabled', t.key === 'eraser');
      });
      toolRow.append(b);
    });

    const undoBtn = el('button', { class: 'markup-btn', 'aria-label': 'Undo' }, icon('undo'));
    undoBtn.addEventListener('click', () => {
      if (!strokes.length) return;
      strokes.pop();
      haptic();
      redraw();
    });

    const clearBtn = el('button', { class: 'markup-btn', 'aria-label': 'Clear' }, icon('trash'));
    clearBtn.addEventListener('click', () => {
      strokes.length = 0;
      haptic('warn');
      redraw();
    });

    const finish = () => { observer.disconnect(); close(); };

    const cancelBtn = el('button', { class: 'nav-btn', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { haptic(); finish(); });

    /**
     * Exporting the whole sheet would drop a full page of white into the note
     * for a sketch the size of a stamp, so the ink is measured and only that
     * rectangle is written out.
     */
    function croppedCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      let pad = 8;

      for (const stroke of strokes) {
        pad = Math.max(pad, stroke.width);
        for (const p of stroke.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      if (!Number.isFinite(minX)) return canvas;

      const cssW = canvas.width / dpr;
      const cssH = canvas.height / dpr;
      const x = Math.max(0, minX - pad);
      const y = Math.max(0, minY - pad);
      const w = Math.min(cssW, maxX + pad) - x;
      const h = Math.min(cssH, maxY + pad) - y;
      if (w < 4 || h < 4) return canvas;

      const out = document.createElement('canvas');
      out.width = Math.round(w * dpr);
      out.height = Math.round(h * dpr);
      const octx = out.getContext('2d');
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(canvas,
        Math.round(x * dpr), Math.round(y * dpr), out.width, out.height,
        0, 0, out.width, out.height);
      return out;
    }

    const doneBtn = el('button', { class: 'nav-btn strong', text: 'Done' });
    doneBtn.addEventListener('click', () => {
      if (!strokes.length) { finish(); return; }
      haptic('commit');
      const out = croppedCanvas();
      out.toBlob((blob) => {
        finish();
        if (!blob) { toast('Could not save the sketch'); return; }
        onDone(blob, { width: out.width, height: out.height });
      }, 'image/png');
    });

    const sheet = el('div', { class: 'markup-sheet' },
      el('div', { class: 'markup-bar' }, cancelBtn, el('span', { class: 'markup-title', text: 'Markup' }), doneBtn),
      stage,
      el('div', { class: 'markup-controls' },
        toolRow,
        el('div', { class: 'markup-row' }, swatches, undoBtn, clearBtn)));

    /* The whole rendering pipeline - requestAnimationFrame and ResizeObserver
       delivery alike - is suspended while the window is occluded, and calling
       sizeCanvas() here is too early because the sheet is not in the document
       until overlay() appends it. A macrotask is late enough to measure and
       early enough to beat the first stroke, and getBoundingClientRect forces
       layout whether or not anything is being painted. */
    setTimeout(sizeCanvas, 0);
    const observer = new ResizeObserver(() => sizeCanvas());
    observer.observe(stage);

    return sheet;
  }, { dismissable: false });
}
