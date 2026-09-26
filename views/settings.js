/**
 * Settings. iOS keeps these in the system Settings app, which is not available
 * to a sideloaded WebView, so they live behind the gear on the Folders screen.
 */

import {
  store, save, hasPin, notesIn, TRASH, plainText, purgeNote, allNotes,
} from '../lib/store.js';
import {
  el, icon, pressable, navBar, backButton, bindScrollTitle, alert2, actionSheet, sliderSheet, toast,
} from '../lib/ui.js';
import { pop, push, setSplitView } from '../lib/router.js';
import { setHapticsEnabled, haptic } from '../lib/haptics.js';
import { listAttachments } from '../lib/attachments.js';
import { attachmentsScreen } from './attachments.js';
import { ensurePasscode, removePasscode, forgotPasscode } from './lock.js';
import * as sync from '../lib/sync.js';
import { signInFlow as signIn, nameFlow, changePasswordFlow } from './account.js';
import { applyTheme, applyTextScale } from '../lib/theme.js';
import { showWhatsNew } from './whatsnew.js';

export function settingsScreen() {
  const screen = el('section', { class: 'screen grouped' });
  const body = el('div', { class: 'body' });
  const bar = navBar({
    left: [backButton('Folders', () => pop())],
    title: 'Settings',
  });

  function row(label, { value, iconName, onPick, trail, destructive, sub }) {
    const node = el('div', { class: `cell${destructive ? ' destructive' : ''}${iconName ? '' : ' no-icon'}` },
      iconName ? icon(iconName, 'lead') : null,
      el('span', { class: 'cell-name' },
        el('span', { text: label }),
        sub ? el('small', { class: 'cell-sub', text: sub }) : null),
      value != null ? el('span', { class: 'cell-count', text: value }) : null,
      trail === false ? null : (trail || icon('chev-right', 'chev')));
    if (onPick) pressable(node, onPick);
    return node;
  }

  function toggleRow(label, iconName, getter, setter) {
    const knob = el('span', { class: 'switch-knob' });
    const sw = el('button', { class: `switch${getter() ? ' on' : ''}`, 'aria-label': label }, knob);
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic('toggle');
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      setter(next);
      save();
    });
    return row(label, { iconName, trail: sw });
  }

  /* --------------------------------------------------------- appearance */

  function pickTheme() {
    actionSheet('Appearance', ['system', 'light', 'dark'].map((t) => ({
      label: t === 'system' ? 'Match System' : t === 'light' ? 'Light' : 'Dark',
      selected: store.settings.theme === t,
      onPick: () => { store.settings.theme = t; save(); applyTheme(); render(); },
    })));
  }

  function pickTextSize() {
    sliderSheet({
      title: 'Text Size',
      min: 75,
      max: 150,
      step: 5,
      value: Math.round((Number(store.settings.textScale) || 1) * 100),
      detent: 100,
      format: (v) => `${v}%`,
      onInput: (v) => {
        store.settings.textScale = v / 100;
        applyTextScale();
      },
      onClose: () => {
        save();
        render();
      },
    });
  }

  const themeLabel = () => ({ system: 'Match System', light: 'Light', dark: 'Dark' }[store.settings.theme]);
  const textLabel = () => {
    const pct = Math.round((Number(store.settings.textScale) || 1) * 100);
    return pct === 100 ? 'Default' : `${pct}%`;
  };

  /* --------------------------------------------------------------- lock */

  const choosePin = () => ensurePasscode(() => { toast('Passcode set', { icon: 'lock' }); render(); });
  const dropPin = () => removePasscode(render);
  const forgotPin = () => forgotPasscode(render);

  /* ------------------------------------------------------------ storage */

  async function storageSummary() {
    const notesBytes = new Blob([JSON.stringify(store)]).size;
    const files = await listAttachments();
    const fileBytes = files.reduce((sum, f) => sum + (f.blob ? f.blob.size : 0), 0);
    return { notesBytes, fileBytes, fileCount: files.length };
  }

  const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  function emptyTrash() {
    const count = notesIn(TRASH).length;
    if (!count) { toast('Nothing in Recently Deleted'); return; }
    alert2(`Delete ${count} Note${count === 1 ? '' : 's'}?`, 'This cannot be undone.', [
      { label: 'Cancel' },
      {
        label: 'Delete All',
        destructive: true,
        onPick: () => {
          notesIn(TRASH).forEach(purgeNote);
          save();
          toast('Recently Deleted emptied');
          render();
        },
      },
    ]);
  }

  /* ---------------------------------------------------------------- sync */

  function syncCard() {
    const state = sync.status();
    const card = el('div', { class: 'group-card' });

    if (!state.signedIn) {
      card.append(row('Sign in to sync', {
        iconName: 'cloud',
        sub: 'Your Koino account, or a new one',
        onPick: signInFlow,
      }));
    } else {
      // Koino accounts are usernames wearing a made-up address; show the name.
      const label = /@adi-study\.local$/.test(state.email || '')
        ? `${state.email.split('@')[0]} (Koino)`
        : state.email;
      card.append(row(label, {
        iconName: 'cloud',
        sub: state.syncing
          ? 'Syncing...'
          : state.lastError
            ? state.lastError
            : state.lastSyncAt
              ? `Last synced ${timeAgo(state.lastSyncAt)}`
              : 'Not synced yet',
        trail: false,
      }));
      card.append(row('Your Name', {
        iconName: 'pencil',
        value: store.settings.displayName || '',
        sub: 'What people see on pages you share',
        onPick: () => nameFlow(render),
      }));
      card.append(row('Change Password', {
        iconName: 'lock',
        onPick: changePasswordFlow,
      }));
      card.append(row('Sync now', {
        iconName: 'restore',
        onPick: async () => {
          try {
            await sync.syncNow();
            toast('Synced', { icon: 'check' });
          } catch (err) {
            toast(String(err.message || err));
          }
          render();
        },
      }));
      card.append(row('Sign out', { iconName: 'lock-open', destructive: true, trail: false, onPick: () => {
        sync.signOut();
        toast('Signed out');
        render();
      } }));
    }

    return el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'Sync' }), card);
  }

  function signInFlow() {
    signIn(() => {
      render();
      sync.syncNow().then(render).catch((err) => toast(String(err.message || err)));
    });
  }

  function timeAgo(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /* ------------------------------------------------------------- render */

  async function render() {
    const scrollTop = body.scrollTop;
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: 'Settings' }));

    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'Display' }),
      el('div', { class: 'group-card' },
        row('Appearance', { iconName: 'aa', value: themeLabel(), onPick: pickTheme }),
        row('Text Size', { iconName: 'text-size', value: textLabel(), onPick: pickTextSize }),
        toggleRow('Haptics', 'haptic',
          () => store.settings.haptics !== false,
          (v) => { store.settings.haptics = v; setHapticsEnabled(v); }),
        toggleRow('Scribble to Erase', 'eraser',
          () => store.settings.scribbleErases !== false,
          (v) => { store.settings.scribbleErases = v; }),
        toggleRow('Split View', 'folder-stack',
          () => store.settings.splitView === true,
          (v) => { store.settings.splitView = v; setSplitView(v); }))));

    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'Privacy' }),
      el('div', { class: 'group-card' },
        row(hasPin() ? 'Passcode set' : 'Set Passcode', {
          iconName: 'lock',
          sub: hasPin()
            ? 'Locked notes are encrypted with it'
            : 'Encrypts locked notes, on every device',
          onPick: hasPin() ? null : choosePin,
          trail: hasPin() ? false : undefined,
        }),
        hasPin() ? row('Turn Off Passcode', { iconName: 'lock-open', onPick: dropPin, trail: false }) : null,
        hasPin() ? row('Forgot Passcode', {
          iconName: 'info',
          sub: 'The only way out - locked notes get deleted',
          destructive: true,
          onPick: forgotPin,
          trail: false,
        }) : null)));

    body.append(syncCard());

    const attachCard = el('div', { class: 'group-card' });
    attachCard.append(row('Attachments', { iconName: 'photo', onPick: () => push(attachmentsScreen()) }));
    attachCard.append(row('Empty Recently Deleted', {
      iconName: 'trash', destructive: true, onPick: emptyTrash, trail: false,
    }));
    body.append(el('div', { class: 'group' },
      el('div', { class: 'group-label', text: 'Storage' }), attachCard));

    const statsCard = el('div', { class: 'group-card' });
    statsCard.append(row('Notes', { value: '...', trail: false }));
    statsCard.append(row("What's New", {
      iconName: 'info',
      onPick: () => showWhatsNew({
        force: true,
        onTry: (where) => {
          if (where === 'shared') import('./shared.js').then((m) => push(m.sharedListScreen()));
          else if (where === 'ink') import('./inknote.js').then((m) => push(m.inkNoteScreen(null, 'Settings', {})));
        },
      }),
    }));
    body.append(el('div', { class: 'group' }, statsCard));

    body.append(el('p', { class: 'settings-footnote' },
      el('span', { text: 'Notes 0.5.7' }),
      el('span', {
        text: sync.status().signedIn
          ? 'Notes and handwriting sync to your account. Imported files and folders stay on this device.'
          : 'Everything is stored on this device. Nothing leaves it.',
      })));

    bindScrollTitle(body, bar, body.querySelector('.large-title'));
    body.scrollTop = scrollTop;

    const { notesBytes, fileBytes, fileCount } = await storageSummary();
    statsCard.innerHTML = '';
    statsCard.append(
      row('Notes', { value: `${allNotes().filter((n) => !n.deletedAt).length}`, trail: false }),
      row('Text', { value: fmtBytes(notesBytes), trail: false }),
      row('Media', { value: fileCount ? `${fileCount} - ${fmtBytes(fileBytes)}` : 'None', trail: false }),
      row('Words', {
        value: String(allNotes().filter((n) => !n.deletedAt)
          .reduce((sum, n) => sum + (plainText(n.html).trim() ? plainText(n.html).trim().split(/\s+/).length : 0), 0)),
        trail: false,
      }));
  }

  screen.append(bar, body);
  screen.onReturn = render;
  render();
  return screen;
}
