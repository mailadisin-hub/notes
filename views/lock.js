/**
 * The passcode, and the encryption it unlocks.
 *
 * A locked note's body is encrypted on disk and syncs as an opaque blob, so
 * the passcode is genuinely the only way to read it - on this device or any
 * other. That also means there is no recovery: forget it and those notes are
 * gone. Every screen that sets a passcode says so.
 */

import {
  store, save, hasPin, lockSalt, setLockCredentials, clearLockCredentials,
  markUnlocked, touchSettings, purgeNote,
} from '../lib/store.js';
import { alert2, toast } from '../lib/ui.js';
import { haptic } from '../lib/haptics.js';
import {
  unlockWith, makeVerifier, checkVerifier, encryptText, decryptText,
  randomSaltHex, hasSessionKey, cryptoAvailable,
} from '../lib/crypto.js';

export { hasSessionKey };

/** Plain body of a note, decrypting if it is locked and the key is loaded. */
export async function readBody(note) {
  if (!note.enc) return note.html || '';
  const plain = await decryptText(note.enc);
  return plain === null ? '' : plain;
}

/** True when the note is locked and this session cannot read it. */
export const isSealed = (note) => !!note.enc && !hasSessionKey();

/** Encrypts a note's body in place. Requires the key. */
export async function sealNote(note) {
  if (!hasSessionKey()) return false;
  if (note.enc) return true;
  note.enc = await encryptText(note.html || '');
  note.html = '';
  note.locked = true;
  note.updatedAt = Date.now();
  save();
  return true;
}

/** Decrypts a note's body in place and drops the lock. */
export async function unsealNote(note) {
  if (!note.enc) {
    note.locked = false;
    note.updatedAt = Date.now();
    save();
    return true;
  }
  if (!hasSessionKey()) return false;
  const plain = await decryptText(note.enc);
  if (plain === null) return false;
  note.html = plain;
  note.enc = null;
  note.locked = false;
  note.updatedAt = Date.now();
  save();
  return true;
}

/** Re-encrypts after an edit. Plain assignment for notes that are not locked. */
export async function resealNote(note, html) {
  if (!note.locked) {
    note.html = html;
    return;
  }
  if (!hasSessionKey()) return;
  note.enc = await encryptText(html);
  note.html = '';
}

/* ------------------------------------------------------------- passcode */

async function tryPasscode(pin) {
  const salt = lockSalt();
  if (!salt) return false;
  await unlockWith(pin, salt);
  return checkVerifier(store.lockVerifier);
}

/** Asks for the passcode, then runs `onUnlocked`. */
export function promptUnlock(note, onUnlocked, onForgotten = null) {
  if (!hasPin() || hasSessionKey()) {
    if (note) markUnlocked(note.id);
    onUnlocked();
    return;
  }

  let attempts = 0;

  alert2('Enter Passcode', 'This note is encrypted.', [
    { label: 'Cancel' },
    {
      label: 'Forgot passcode',
      onPick: () => { forgotPasscode(onForgotten); },
    },
    {
      label: 'Unlock',
      strong: true,
      onPick: async (pin) => {
        if (!pin || !(await tryPasscode(pin))) {
          attempts += 1;
          toast(attempts >= 3 ? 'Still wrong - try Forgot passcode' : 'Wrong passcode');
          return false;
        }
        if (note) markUnlocked(note.id);
        onUnlocked();
        return true;
      },
    },
  ], { input: '', inputType: 'password', maxLength: 32 });
}

/** Ensures a passcode exists and the key is loaded, then runs `onReady`. */
export function ensurePasscode(onReady) {
  if (!cryptoAvailable()) {
    toast('Encryption is not available here');
    return;
  }
  if (hasPin()) {
    if (hasSessionKey()) { onReady(); return; }
    promptUnlock(null, onReady);
    return;
  }

  alert2('Set Passcode',
    'Locked notes are encrypted with this. It is never stored, so it cannot be '
    + 'recovered - write it down. Lose it and those notes are unreadable everywhere.',
    [
      { label: 'Cancel' },
      {
        label: 'Save',
        strong: true,
        onPick: async (pin) => {
          if (!pin || pin.length < 4) {
            toast('Use at least 4 characters');
            return false;
          }
          const salt = randomSaltHex();
          await unlockWith(pin, salt);
          setLockCredentials(salt, await makeVerifier());
          haptic('commit');
          onReady();
          return true;
        },
      },
    ], { input: '', inputType: 'password', maxLength: 32, placeholder: 'At least 4 characters' });
}

/**
 * The way out when the passcode is gone.
 *
 * Without this the app is a dead end: locked notes cannot be read, and the
 * passcode cannot be removed either, because removing it requires entering it.
 * The notes are already unrecoverable at that point - there is no key - so the
 * only honest option is to delete them and start again, and to say so plainly
 * before doing it.
 */
export function forgotPasscode(onDone) {
  const locked = store.notes.filter((n) => n.enc && !n.purged);

  alert2('Forgotten the passcode?',
    locked.length
      ? `${locked.length} locked note${locked.length === 1 ? '' : 's'} can only be `
        + 'opened with it. Without the passcode they cannot be recovered by anyone, '
        + 'including me. The only way forward is to delete them.'
      : 'There are no locked notes, so the passcode can simply be cleared.',
    [
      { label: 'Cancel' },
      {
        label: locked.length ? 'Delete and reset' : 'Clear passcode',
        destructive: true,
        onPick: () => {
          if (!locked.length) {
            clearLockCredentials();
            toast('Passcode cleared');
            onDone && onDone();
            return;
          }
          /* Asked twice: this is the one action in the app that destroys
             something no backup can bring back. */
          alert2('Delete them permanently?',
            `This deletes ${locked.length} note${locked.length === 1 ? '' : 's'} on every `
            + 'device and cannot be undone.',
            [
              { label: 'Keep them' },
              {
                label: 'Delete',
                destructive: true,
                onPick: () => {
                  locked.forEach(purgeNote);
                  clearLockCredentials();
                  save();
                  toast('Locked notes deleted, passcode cleared');
                  onDone && onDone();
                },
              },
            ]);
        },
      },
    ]);
}

/**
 * Turning the passcode off has to decrypt every locked note first, or they
 * would be left as ciphertext with the key thrown away.
 */
export function removePasscode(onDone) {
  alert2('Turn Off Passcode', 'Every locked note will be decrypted and unlocked.', [
    { label: 'Cancel' },
    {
      label: 'Turn Off',
      destructive: true,
      onPick: () => {
        alert2('Confirm Passcode', null, [
          { label: 'Cancel' },
          {
            label: 'Confirm',
            strong: true,
            onPick: async (pin) => {
              if (!pin || !(await tryPasscode(pin))) {
                toast('Wrong passcode');
                return false;
              }
              for (const note of store.notes) {
                if (note.enc) await unsealNote(note);
                note.locked = false;
              }
              clearLockCredentials();
              touchSettings();
              save();
              toast('Passcode removed');
              onDone && onDone();
              return true;
            },
          },
        ], { input: '', inputType: 'password', maxLength: 32 });
      },
    },
  ]);
}
