/**
 * Writing PDFs, with nothing installed.
 *
 * Two kinds, because notes come in two kinds. A typed note becomes a PDF of
 * real text - selectable, searchable, a tenth the size of a picture of itself.
 * A handwritten page becomes a PDF of pictures, because that is what it is.
 *
 * Only the fonts every PDF reader already has are used (Helvetica and its bold
 * and italic), so nothing has to be embedded and the file stays small.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;

/* ------------------------------------------------------------- plumbing */

const latin1 = (text) => {
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    out.push(code < 256 ? ch : '?');      // Helvetica has no more than this
  }
  return out.join('');
};

/** PDF strings escape their own delimiters. */
const pdfString = (text) => latin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * Assembles the objects into a file. [objects] is an array of strings or
 * Uint8Arrays, numbered from 1 in order.
 */
function assemble(objects, rootRef) {
  const parts = [];
  const offsets = [];
  let at = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    parts.push(bytes);
    at += bytes.length;
  };

  push('%PDF-1.4\n%âãÏÓ\n');
  objects.forEach((body, i) => {
    offsets.push(at);
    push(`${i + 1} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else push(body);
    push('\nendobj\n');
  });

  const xref = at;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootRef} 0 R >>\nstartxref\n${xref}\n%%EOF`);

  return new Blob(parts, { type: 'application/pdf' });
}

/** A stream object, with its own length worked out. */
function stream(dict, data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const head = new TextEncoder().encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`);
  const tail = new TextEncoder().encode('\nendstream');
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/* ------------------------------------------------------------ typed text */

const FONTS = { regular: 'F1', bold: 'F2', italic: 'F3' };

/** How wide a line of Helvetica is, near enough to break lines on. */
const WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  '{': 334, '|': 260, '}': 334, '~': 584,
};
function widthOf(text, size) {
  let units = 0;
  for (const ch of text) {
    if (WIDTHS[ch] !== undefined) units += WIDTHS[ch];
    else if (ch >= '0' && ch <= '9') units += 556;
    else if (ch >= 'A' && ch <= 'Z') units += 700;
    else if (ch >= 'a' && ch <= 'z') units += 545;
    else units += 556;
  }
  return (units / 1000) * size;
}

/** Breaks a paragraph to fit the page, keeping whole words together. */
function wrap(text, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size) <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A PDF of ordinary text. [blocks] is [{ text, style }], where style is
 * 'title', 'heading', 'body' or 'bullet'.
 */
export function textPdf(blocks, { title = 'Note' } = {}) {
  const look = {
    title: { size: 22, font: FONTS.bold, before: 0, after: 12, lead: 1.25 },
    heading: { size: 15, font: FONTS.bold, before: 12, after: 5, lead: 1.3 },
    body: { size: 11, font: FONTS.regular, before: 0, after: 8, lead: 1.45 },
    bullet: { size: 11, font: FONTS.regular, before: 0, after: 4, lead: 1.45, indent: 16 },
    quote: { size: 11, font: FONTS.italic, before: 4, after: 8, lead: 1.45, indent: 14 },
  };

  const pages = [];
  let lines = [];
  let y = A4.height - MARGIN;

  const newPage = () => {
    if (lines.length) pages.push(lines);
    lines = [];
    y = A4.height - MARGIN;
  };

  for (const block of blocks) {
    const style = look[block.style] || look.body;
    const indent = style.indent || 0;
    const width = A4.width - MARGIN * 2 - indent;
    y -= style.before;
    const wrapped = wrap(block.text, style.size, width);
    for (let i = 0; i < wrapped.length; i += 1) {
      const step = style.size * style.lead;
      if (y - step < MARGIN) newPage();
      y -= step;
      const text = wrapped[i];
      const prefix = block.style === 'bullet' && i === 0 ? '•  ' : '';
      if (text || prefix) {
        lines.push(`BT /${style.font} ${style.size} Tf ${MARGIN + indent} ${y.toFixed(2)} Td (${pdfString(prefix + text)}) Tj ET`);
      }
    }
    y -= style.after;
  }
  if (lines.length) pages.push(lines);
  if (!pages.length) pages.push([]);

  /* 1 catalogue, 2 pages, then a page and a stream each, then three fonts. */
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const fontBase = 3 + pages.length * 2;
  const objects = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((content, i) => {
    const id = pageIds[i];
    objects[id - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
      + `/Resources << /Font << /F1 ${fontBase} 0 R /F2 ${fontBase + 1} 0 R /F3 ${fontBase + 2} 0 R >> >> `
      + `/Contents ${id + 1} 0 R >>`;
    objects[id] = stream('', content.join('\n'));
  });
  objects[fontBase - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[fontBase] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[fontBase + 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';

  const doc = assemble(objects, 1);
  doc.title = title;
  return doc;
}

/* ---------------------------------------------------------- pictures */

/**
 * A PDF of pictures, one per page - what a handwritten page is. [images] is
 * [{ bytes, width, height }], each a JPEG.
 */
export function imagePdf(images) {
  const objects = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';

  const pageIds = images.map((_, i) => 3 + i * 3);
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`;

  images.forEach((image, i) => {
    const id = pageIds[i];
    /* Fitted to the page with its proportions kept, and centred in whatever is
       left over. */
    const scale = Math.min((A4.width - 36) / image.width, (A4.height - 36) / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    const x = (A4.width - w) / 2;
    const y = (A4.height - h) / 2;

    objects[id - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
      + `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id] = stream('', `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
    objects[id + 1] = stream(
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
      + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
      image.bytes,
    );
  });

  return assemble(objects, 1);
}

/* -------------------------------------------------------- note to blocks */

/** A typed note's HTML as the blocks textPdf wants. */
export function blocksFromHtml(html, title) {
  const host = document.createElement('div');
  host.innerHTML = String(html || '');
  const blocks = [];
  if (title) blocks.push({ text: title, style: 'title' });

  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();

  /* A note usually opens with its own title as a heading, and the title has
     already been put at the top: printing it twice looks like a mistake. */
  let first = true;

  for (const node of host.children) {
    const tag = node.tagName.toLowerCase();
    const wasFirst = first;
    first = false;
    if (wasFirst && title && tag === 'h1' && textOf(node).toLowerCase() === String(title).trim().toLowerCase()) {
      continue;
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const text = textOf(node);
      if (text) blocks.push({ text, style: tag === 'h1' && !title ? 'title' : 'heading' });
    } else if (tag === 'ul' || tag === 'ol') {
      [...node.children].forEach((li, i) => {
        const text = textOf(li);
        if (text) blocks.push({ text: tag === 'ol' ? `${i + 1}. ${text}` : text, style: 'bullet' });
      });
    } else if (tag === 'blockquote') {
      const text = textOf(node);
      if (text) blocks.push({ text, style: 'quote' });
    } else if (node.classList.contains('checkitem')) {
      const done = node.dataset.done === '1';
      const text = textOf(node.querySelector('.ct') || node);
      if (text) blocks.push({ text: `${done ? '[x]' : '[ ]'} ${text}`, style: 'bullet' });
    } else if (tag === 'table') {
      for (const tr of node.querySelectorAll('tr')) {
        const cells = [...tr.children].map((td) => textOf(td)).filter(Boolean);
        if (cells.length) blocks.push({ text: cells.join('   |   '), style: 'body' });
      }
    } else {
      const text = textOf(node);
      if (text) blocks.push({ text, style: 'body' });
    }
  }
  return blocks;
}
