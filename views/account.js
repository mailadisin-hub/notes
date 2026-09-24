/**
 * Signing in and making an account - real pages, not alerts - plus the name
 * other people see and changing a password.
 *
 * Koino signs its people in with a username, which it turns into an address
 * of the form name@adi-study.local. Nothing can be delivered there, so a
 * reset link for one of those accounts has nowhere to go. The sign-in page
 * takes the username as it is, says so plainly when "Forgot password" cannot
 * help, and accounts made here use a real email so resetting them works.
 */

import { el, navBar, backButton, alert2, toast, pressable } from '../lib/ui.js';
import { push, pop } from '../lib/router.js';
import { store, touchSettings } from '../lib/store.js';
import * as sync from '../lib/sync.js';

/* Must match Koino's usernameToEmail() in adi-study/app.js. */
const USERNAME_DOMAIN = 'adi-study.local';
const RESET_SENDER = 'noreply@adi-study.firebaseapp.com';

const say = (err) => toast(String((err && err.message) || err));

/** A typed email, or a Koino username turned into the address Koino uses. */
export function toEmail(text) {
  const raw = String(text || '').trim();
  if (raw.includes('@')) return raw.toLowerCase();
  const username = raw.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  return username ? `${username}@${USERNAME_DOMAIN}` : '';
}

const hasNoInbox = (email) => email.endsWith(`@${USERNAME_DOMAIN}`);

/**
 * The sign-in page, which flips to making an account.
 * @param opts.mode    'signin' (default) or 'signup'
 * @param opts.onDone  runs once signed in, after the page has closed
 */
export function accountScreen({ mode = 'signin', onDone = null } = {}) {
  const screen = el('section', { class: 'screen grouped' });
  const body = el('div', { class: 'body' });
  let current = mode;
  let busy = false;

  const bar = navBar({ left: [backButton('Back', () => pop())], title: '' });

  const field = (attrs) => {
    const input = el('input', { autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', ...attrs });
    return { input, row: el('label', { class: 'form-field' }, input) };
  };

  const name = field({ type: 'text', placeholder: 'Your name', autocomplete: 'name', autocapitalize: 'words', enterkeyhint: 'next' });
  const email = field({ type: 'email', inputmode: 'email', autocomplete: 'username', enterkeyhint: 'next' });
  const password = field({ type: 'password', placeholder: 'Password', enterkeyhint: 'go' });
  const show = el('button', { class: 'form-show', type: 'button', text: 'Show' });
  show.addEventListener('click', (e) => {
    e.preventDefault();
    const hidden = password.input.type === 'password';
    password.input.type = hidden ? 'text' : 'password';
    show.textContent = hidden ? 'Hide' : 'Show';
  });
  password.row.append(show);

  const message = el('p', { class: 'form-message', role: 'status' });
  const submit = el('button', { class: 'form-primary', type: 'button' });
  const forgot = el('button', { class: 'form-link', type: 'button', text: 'Forgot password?' });
  const flip = el('button', { class: 'form-link', type: 'button' });

  function setMessage(text, kind = 'error') {
    message.textContent = text || '';
    message.className = `form-message ${kind}`;
  }

  function render() {
    const signup = current === 'signup';
    const title = signup ? 'Create Account' : 'Sign In';
    bar.titleEl.textContent = title;
    email.input.placeholder = signup ? 'Email' : 'Email or Koino username';
    password.input.placeholder = signup ? 'Password (6 or more characters)' : 'Password';
    password.input.autocomplete = signup ? 'new-password' : 'current-password';
    submit.textContent = signup ? 'Create Account' : 'Sign In';
    forgot.hidden = signup;
    flip.textContent = signup ? 'Already have an account? Sign in' : 'New here? Create an account';
    setMessage('');

    body.textContent = '';
    body.append(
      el('h1', { class: 'large-title', text: title }),
      el('p', {
        class: 'form-intro',
        text: signup
          ? 'Use an email you can open: it is where a reset link goes if the password is ever forgotten.'
          : 'Your Koino account, or one made here. Signing in syncs your notes between devices and lets you write on shared pages.',
      }),
      el('div', { class: 'group' },
        el('div', { class: 'group-card form-card' }, signup ? name.row : null, email.row, password.row)),
      message,
      submit,
      forgot,
      flip,
    );
    setTimeout(() => (signup ? name.input : email.input).focus(), 60);
  }

  function setBusy(on, label) {
    busy = on;
    submit.disabled = on;
    forgot.disabled = on;
    if (on) submit.textContent = label;
    else submit.textContent = current === 'signup' ? 'Create Account' : 'Sign In';
  }

  function finish() {
    pop();
    if (onDone) setTimeout(onDone, 420);
  }

  async function go() {
    if (busy) return;
    const address = toEmail(email.input.value);
    const pass = password.input.value;
    if (current === 'signup') {
      if (!name.input.value.trim()) return setMessage('Add your name - it is what people you share with see.');
      if (!address.includes('@') || hasNoInbox(address)) return setMessage('Use a real email address.');
      if (pass.length < 6) return setMessage('Use a password of at least 6 characters.');
      setBusy(true, 'Creating...');
      try {
        await sync.signUp(address, pass);
      } catch (err) {
        setBusy(false);
        return setMessage(String(err.message || err));
      }
      store.settings.displayName = name.input.value.trim().slice(0, 40);
      touchSettings();
      sync.startAutoSync();
      toast('Account created', { icon: 'check' });
      finish();
      return;
    }
    if (!address) return setMessage('Type your email or Koino username.');
    if (!pass) return setMessage('Type your password.');
    setBusy(true, 'Signing In...');
    try {
      await sync.signIn(address, pass);
    } catch (err) {
      setBusy(false);
      return setMessage(String(err.message || err));
    }
    sync.startAutoSync();
    toast('Signed in', { icon: 'check' });
    finish();
  }

  async function sendReset() {
    if (busy) return;
    const address = toEmail(email.input.value);
    if (!address) {
      setMessage('Type your email above first, then tap Forgot password.');
      email.input.focus();
      return;
    }
    if (hasNoInbox(address)) {
      setMessage('Koino usernames have no inbox behind them, so there is nowhere to send a reset link. '
        + 'If you still know the password, sign in and change it in Settings.', 'note');
      return;
    }
    setBusy(true, 'Sending...');
    try {
      await sync.sendPasswordReset(address);
      setMessage(`A reset link is on its way to ${address} from ${RESET_SENDER}. `
        + 'It can take a few minutes - check Spam and Promotions too.', 'note');
    } catch (err) {
      setMessage(String(err.message || err));
    }
    setBusy(false);
  }

  pressable(submit, go);
  pressable(forgot, sendReset);
  pressable(flip, () => {
    current = current === 'signup' ? 'signin' : 'signup';
    render();
  });
  for (const input of [name.input, email.input, password.input]) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (input === name.input) email.input.focus();
      else if (input === email.input) password.input.focus();
      else go();
    });
  }

  screen.append(bar, body);
  render();
  return screen;
}

/** Opens the sign-in page; onDone runs once there is an account. */
export function signInFlow(onDone) {
  push(accountScreen({ mode: 'signin', onDone }));
}

/** Asks for the name shown to other people on a shared page. */
export function nameFlow(onDone) {
  alert2('Your Name', 'Shown to the people you share pages with.', [
    { label: 'Cancel' },
    {
      label: 'Save',
      strong: true,
      onPick: (value) => {
        if (value) {
          store.settings.displayName = value.slice(0, 40);
          touchSettings();
        }
        if (onDone) setTimeout(onDone, 420);
        return true;
      },
    },
  ], { input: store.settings.displayName || '', placeholder: 'Name' });
}

/**
 * Changes the password of the signed-in account. Being signed in is enough
 * when the sign-in is recent - which also covers a forgotten password on a
 * device that is still signed in. Only when Firebase wants a fresh sign-in is
 * the current password asked for.
 */
export function changePasswordFlow() {
  const me = sync.account();
  if (!me) return;
  const koino = hasNoInbox(me.email);
  alert2('New Password', koino
    ? 'At least 6 characters. This is also your Koino password.'
    : 'At least 6 characters.', [
    { label: 'Cancel' },
    {
      label: 'Save',
      strong: true,
      onPick: async (next) => {
        if (!next || next.length < 6) return false;
        try {
          await sync.changePassword(next);
          toast('Password changed', { icon: 'check' });
          return true;
        } catch (err) {
          if (!/sign in again/i.test(String(err.message))) {
            say(err);
            return false;
          }
        }
        // Firebase wants proof: the current password, then try again.
        setTimeout(() => confirmCurrent(me.email, next), 420);
        return true;
      },
    },
  ], { input: '', inputType: 'password' });
}

function confirmCurrent(email, next) {
  alert2('Current Password', 'Firebase wants your current password before it will change it.', [
    { label: 'Cancel' },
    {
      label: 'Change',
      strong: true,
      onPick: async (current) => {
        if (!current) return false;
        try {
          await sync.signIn(email, current);
          await sync.changePassword(next);
        } catch (err) {
          say(err);
          return false;
        }
        toast('Password changed', { icon: 'check' });
        return true;
      },
    },
  ], { input: '', inputType: 'password' });
}
