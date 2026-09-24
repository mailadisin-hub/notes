/**
 * Reading a Markdown or text file.
 *
 * Laid out for reading, not editing: a comfortable measure on a tablet, maths
 * typeset, callouts boxed. [[Links]] open the linked note when the file came
 * from somewhere that can find it - a vault folder, or the imported files -
 * and say so plainly when it cannot.
 */

import { el, navBar, backButton, navIconButton, sliderSheet, toast } from '../lib/ui.js';
import { push, pop } from '../lib/router.js';
import { renderMarkdown, escapeHtml } from '../lib/markdown.js';

let katexCssLoaded = false;
function loadKatexCss() {
  if (katexCssLoaded) return;
  katexCssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../vendor/katex/katex.min.css', import.meta.url).href;
  document.head.append(link);
}

/**
 * @param {object} o
 * @param {string} o.text        file contents
 * @param {string} o.title
 * @param {string} [o.backLabel]
 * @param {boolean} [o.plain]    show as plain text rather than Markdown
 * @param {(target: string) => Promise<object|null>} [o.resolve]
 *        finds a [[linked]] note by name. Answers {title, text} for a note to
 *        read next - plus, optionally, plain and its own resolve/resolveImage
 *        for links relative to where that note lives - or {open(backLabel)}
 *        for something that is not Markdown, like a PDF
 * @param {string} [o.heading]   scroll to this heading once shown
 * @param {(target: string) => Promise<string|null>} [o.resolveImage]
 *        returns a URL for an embedded image
 */
export function mdScreen(o) {
  loadKatexCss();
  const screen = el('section', { class: 'screen' });
  screen.dataset.pane = 'detail';
  const bar = navBar({
    left: [backButton(o.backLabel || 'Back', () => pop())],
    title: o.title,
    right: [navIconButton('aa', openSize, 'Text size')],
  });

  bar.titleEl.classList.add('show');
  const doc = el('article', { class: `md${o.plain ? ' md-plain' : ''}` });
  const body = el('div', { class: 'body md-body' }, doc);
  screen.append(bar, body);

  const urls = [];

  if (o.plain) {
    doc.append(el('pre', { class: 'md-text', text: o.text }));
  } else {
    const { fragment, meta } = renderMarkdown(o.text);
    // Obsidian allows a list or one string, with or without the leading #.
    const tags = [].concat(meta.tags || [])
      .flatMap((t) => String(t).split(/[,\s]+/))
      .map((t) => t.replace(/^#+/, '').trim())
      .filter(Boolean);
    if (tags.length) {
      doc.append(el('div', { class: 'md-props' }, ...tags.map((t) => el('span', { class: 'md-tag', text: `#${t}` }))));
    }
    doc.append(fragment);
    hydrateImages();
  }

  async function hydrateImages() {
    for (const img of doc.querySelectorAll('img.md-embed-img')) {
      const target = img.dataset.target;
      const url = o.resolveImage ? await o.resolveImage(target).catch(() => null) : null;
      if (url) {
        img.src = url;
        if (url.startsWith('blob:')) urls.push(url);
      } else {
        img.replaceWith(el('span', { class: 'md-missing', text: `[image: ${target}]` }));
      }
    }
  }

  doc.addEventListener('click', async (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('md-wikilink')) {
      e.preventDefault();
      const target = a.dataset.target;
      const heading = a.dataset.heading;
      if (!target && heading) {
        scrollToHeading(heading);
        return;
      }
      const found = o.resolve ? await o.resolve(target).catch(() => null) : null;
      if (!found) {
        toast(`"${target}" is not here`);
        return;
      }
      if (found.open) {
        found.open(o.title);
        return;
      }
      push(mdScreen({ ...o, plain: false, ...found, backLabel: o.title, heading }));
      return;
    }
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      scrollToHeading(decodeURIComponent(href.slice(1)));
    }
  });

  function scrollToHeading(name) {
    const id = name.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
    const target = doc.querySelector(`#${CSS.escape(id)}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  let size = Number(localStorage.getItem('notes.readerSize')) || 1;
  size = Math.min(1.5, Math.max(0.75, size));
  doc.style.setProperty('--md-scale', String(size));

  function openSize() {
    sliderSheet({
      title: 'Text Size',
      min: 75,
      max: 150,
      step: 5,
      value: Math.round(size * 100),
      detent: 100,
      format: (v) => `${v}%`,
      onInput: (v) => {
        size = v / 100;
        doc.style.setProperty('--md-scale', String(size));
        try { localStorage.setItem('notes.readerSize', String(size)); } catch { /* ignore */ }
      },
    });
  }

  let arrived = false;
  screen.onShow = () => {
    if (arrived) return;
    arrived = true;
    if (o.heading) scrollToHeading(o.heading);
  };

  screen.onLeave = () => urls.forEach((u) => URL.revokeObjectURL(u));
  return screen;
}

export { escapeHtml };
