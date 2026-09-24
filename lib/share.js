/**
 * Getting a note out of the app.
 *
 * Android WebView exposes navigator.share on recent versions, which opens the
 * real system share sheet. Where it is missing, the clipboard is the honest
 * fallback - a download of a .txt is offered separately rather than silently
 * substituted, because those are different intentions.
 */

import { plainText, displayTitle } from './store.js';
import { toast } from './ui.js';

export async function shareNoteText(note) {
  const text = plainText(note.html).trim();
  const title = displayTitle(note);

  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      /* AbortError is the user dismissing the sheet; anything else falls back. */
      if (err && err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', { icon: 'copy' });
  } catch {
    toast('Could not share this note');
  }
}

export function exportNoteFile(note) {
  const text = plainText(note.html).trim();
  const name = `${displayTitle(note).replace(/[^\w \-]+/g, '').slice(0, 60) || 'Note'}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Saved ${name}`, { icon: 'download' });
}
