/**
 * Encryption for locked notes.
 *
 * A locked note is encrypted at rest on the device, not only on the way to the
 * server. That is the simpler design as well as the safer one: sync never
 * needs the key, because it is moving an opaque blob either way. Push and pull
 * work while the app is locked; only reading needs the passcode.
 *
 * AES-GCM with a key derived from the passcode by PBKDF2. The salt is stored
 * with the account and synced, because a per-device salt would mean the same
 * passcode produced a different key on each device and nothing would decrypt.
 *
 * The honest limit: a 4-8 digit passcode is a tiny search space. 310k PBKDF2
 * iterations make each guess cost something, but this protects a note from
 * somebody reading the database, not from a determined attacker with the
 * ciphertext and time. The key never leaves memory and is dropped when the app
 * is backgrounded.
 */

const ITERATIONS = 310000;

let sessionKey = null;

export const hasSessionKey = () => sessionKey !== null;
export const clearSessionKey = () => { sessionKey = null; };

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Derives the AES key and keeps it for this session only. */
export async function unlockWith(passcode, saltHex) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey'],
  );
  sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(saltHex),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return sessionKey;
}

/** @returns {{iv: string, ct: string}} */
export async function encryptText(plaintext) {
  if (!sessionKey) throw new Error('locked');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, sessionKey, enc.encode(plaintext),
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

/** Returns null rather than throwing when the key is wrong or missing. */
export async function decryptText(payload) {
  if (!sessionKey || !payload || !payload.ct) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.iv) },
      sessionKey,
      fromBase64(payload.ct),
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}

/**
 * Proof the passcode is right without storing the passcode.
 *
 * This replaces the old salted-SHA-256 check: a separately stored hash of the
 * passcode would be a second, weaker thing to attack. Instead a known string
 * is encrypted with the derived key, so verifying means decrypting it, and the
 * only stored artefact is ciphertext the key already protects.
 */
const VERIFIER_PLAINTEXT = 'kairos-notes-verifier-v1';

export async function makeVerifier() {
  return encryptText(VERIFIER_PLAINTEXT);
}

export async function checkVerifier(verifier) {
  const plain = await decryptText(verifier);
  return plain === VERIFIER_PLAINTEXT;
}

/** True once WebCrypto is usable; false in an insecure context. */
export const cryptoAvailable = () =>
  typeof crypto !== 'undefined' && !!crypto.subtle;
