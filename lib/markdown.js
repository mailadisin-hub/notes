/**
 * Markdown to safe HTML, Obsidian-flavoured.
 *
 * GitHub-style Markdown via marked, plus what an Obsidian vault actually uses:
 * [[wikilinks]] and ![[embeds]], ==highlights==, > [!note] callouts, #tags,
 * YAML frontmatter, and $inline$ / $$display$$ maths rendered by KaTeX - the
 * Opia textbooks are mostly maths.
 *
 * Safe, because this HTML goes into a WebView that can talk to the native app:
 * raw HTML in a file is passed through an allow-list, and links and images are
 * limited to ordinary protocols. A .md downloaded from anywhere cannot run
 * script here.
 */

import { Marked } from '../vendor/marked.esm.js';
import katex from '../vendor/katex/katex.module.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/* ------------------------------------------------------------------ maths */

function tex(src, display) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' });
  } catch {
    return `<code class="md-tex-error">${escapeHtml(src)}</code>`;
  }
}

const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    const i = src.indexOf('$$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token) {
    return `<div class="md-math">${tex(token.text, true)}</div>`;
  },
};

const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const display = /^\$\$([^$]+?)\$\$/.exec(src);
    if (display) return { type: 'mathInline', raw: display[0], text: display[1], display: true };
    // No space inside the delimiters and no digit after: "$5 and $10" is money.
    const m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
    return undefined;
  },
  renderer(token) {
    return tex(token.text, token.display);
  },
};

/* --------------------------------------------------------------- Obsidian */

const wikilink = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const m = /!?\[\[/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^(!?)\[\[([^\]|#^]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return undefined;
    return {
      type: 'wikilink',
      raw: m[0],
      embed: !!m[1],
      target: (m[2] || '').trim(),
      heading: (m[3] || '').slice(1).trim(),
      alias: (m[4] || '').trim(),
    };
  },
  renderer(t) {
    const label = escapeHtml(t.alias || [t.target, t.heading].filter(Boolean).join(' › '));
    const attrs = `data-target="${escapeHtml(t.target)}" data-heading="${escapeHtml(t.heading)}"`;
    if (t.embed) {
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(t.target)) {
        return `<img class="md-embed-img" alt="${label}" ${attrs}>`;
      }
      return `<a class="md-wikilink md-embed" href="#" ${attrs}>${label}</a>`;
    }
    return `<a class="md-wikilink" href="#" ${attrs}>${label}</a>`;
  },
};

const highlight = {
  name: 'highlight',
  level: 'inline',
  start(src) {
    const i = src.indexOf('==');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!m) return undefined;
    return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  },
};

const tag = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = /(^|\s)#[\p{L}_]/u.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(src);
    if (!m) return undefined;
    return { type: 'tag', raw: m[0], name: m[1] };
  },
  renderer(token) {
    return `<span class="md-tag">#${escapeHtml(token.name)}</span>`;
  },
};

/* --------------------------------------------------------------- safety */

const SAFE_URL = /^(https?:|mailto:|tel:|#)/i;
const SAFE_IMG = /^(https?:|blob:|data:image\/(png|jpe?g|gif|webp);)/i;

const ALLOWED_TAGS = new Set(('p br hr h1 h2 h3 h4 h5 h6 strong b em i u del s strike code pre blockquote ul ol li a img '
  + 'table thead tbody tfoot tr th td mark span div sup sub small kbd abbr details summary figure figcaption '
  + 'center dl dt dd').split(' '));
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align', 'start',
  'width', 'height', 'open', 'id', 'lang', 'dir']);

/** Allow-list pass over HTML that came from the file itself. */
export function sanitizeFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      const tagName = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tagName)) {
        // Unknown wrappers keep their text; dangerous ones go entirely.
        if (/^(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|template|noscript)$/.test(tagName)) {
          child.remove();
        } else {
          walk(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        const ok = ALLOWED_ATTRS.has(name)
          && !(name === 'href' && !SAFE_URL.test(value))
          && !(name === 'src' && !SAFE_IMG.test(value));
        if (!ok) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

/* ----------------------------------------------------------------- engine */

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [mathBlock, mathInline, wikilink, highlight, tag],
  renderer: {
    html({ text }) {
      return sanitizeFragment(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = String(href || '').trim();
      if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('#')) {
        // A relative path is another file in the vault; the reader resolves
        // it the same way it resolves a [[wikilink]].
        const [target, frag = ''] = url.split('#');
        let heading = frag;
        try { heading = decodeURIComponent(frag); } catch { /* keep it as written */ }
        return `<a class="md-wikilink" href="#" data-target="${escapeHtml(target)}" data-heading="${escapeHtml(heading)}">${label}</a>`;
      }
      if (!SAFE_URL.test(url)) return label;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      const external = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href)}"${t}${external}>${label}</a>`;
    },
    image({ href, title, text }) {
      const src = String(href || '').trim();
      if (!SAFE_IMG.test(src)) {
        // A relative path means a file in the vault; the reader resolves it.
        return `<img class="md-embed-img" alt="${escapeHtml(text)}" data-target="${escapeHtml(src)}">`;
      }
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${t}>`;
    },
  },
});

/** YAML frontmatter off the top, with its tags and aliases kept for display. */
export function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { body: src, meta: {} };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (v.startsWith('[')) meta[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else meta[key] = v ? v.replace(/^["']|["']$/g, '') : [];
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(meta[key])) meta[key].push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return { body: src.slice(m[0].length), meta };
}

const slug = (text) => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

/**
 * Rendered markdown as a DOM fragment, with headings given ids and callouts
 * turned into boxes.
 */
export function renderMarkdown(src) {
  const { body, meta } = splitFrontmatter(String(src || ''));
  const html = marked.parse(body);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;

  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!h.id) h.id = slug(h.textContent);
  }

  // > [!note] Title   ->   a callout box.
  for (const quote of root.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild;
    if (!first || first.tagName !== 'P') continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(first.textContent);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const box = document.createElement('div');
    box.className = `md-callout md-callout-${kind}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'md-callout-title';
    titleEl.textContent = m[3] || kind.charAt(0).toUpperCase() + kind.slice(1);
    box.append(titleEl);
    // Whatever followed the [!type] line in that first paragraph is body text.
    const firstHtml = first.innerHTML;
    const nl = firstHtml.indexOf('\n');
    if (nl >= 0) {
      const rest = document.createElement('p');
      rest.innerHTML = firstHtml.slice(nl + 1);
      box.append(rest);
    }
    first.remove();
    box.append(...quote.childNodes);
    quote.replaceWith(box);
  }

  return { fragment: root, meta };
}
