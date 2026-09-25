/**
 * Shared pages on screen: the list of them, and the page itself - a
 * handwritten page like any other, except that everyone on it sees each
 * stroke and picture the moment it is finished.
 *
 * lib/shared.js keeps the live copy of the board. This file keeps that copy
 * and the page the ink view draws in step. Strokes and pictures that arrive
 * are added; ones deleted elsewhere are removed; changes made here are sent.
 * The bookkeeping sets below exist so that neither the echo of our own write
 * nor a write still on its way can undo what is on screen.
 */

import {
  el, icon, pressable, longPress, navBar, backButton, navIconButton, bindScrollTitle,
  actionSheet, alert2, contextMenu, overlay, toast,
} from '../lib/ui.js';
import { push, pop, openDetail } from '../lib/router.js';
import { store, save } from '../lib/store.js';
import { haptic } from '../lib/haptics.js';
import { account } from '../lib/sync.js';
import { TOOL_IDS, INK, encodePoints, decodePoints, PAPERS, BOARD } from '../lib/ink.js';
import { inkView, newStrokeId } from '../lib/inkview.js';
import * as shared from '../lib/shared.js';
import { inkChrome } from './inkchrome.js';
import { isDark } from './inknote.js';
import { backgroundSheet, backgroundLabel, INK_NAMES } from './background.js';
import { pickPicture, placePicture, sharePage } from './pictures.js';
import { signInFlow, nameFlow } from './account.js';

const PAGE_WIDTH = 800;
const SERVER_TIME = { '.sv': 'timestamp' };
const HERE_MS = 75000;
const MOVE_ECHO_MS = 4000;
/* Firebase keeps a whole board in one tree; a picture much bigger than this
   makes every join slow for everyone. The rules refuse past ~660KB of JPEG. */
const MAX_PICTURE_CHARS = 880000;

const AVATAR_COLOURS = ['#e8590c', '#2f9e44', '#1c7ed6', '#9c36b5', '#c2255c', '#0c8599'];

const say = (err) => toast(String((err && err.message) || err));

/* ------------------------------------------------------------- encoding */

function encodeStroke(s, uid) {
  return {
    t: Math.max(0, TOOL_IDS.indexOf(s.tool)),
    c: s.colour,
    s: Math.round(s.size * 100) / 100,
    p: encodePoints(s.pts),
    by: uid,
    at: SERVER_TIME,
  };
}

function decodeStroke(id, r) {
  if (!r || typeof r.p !== 'string') return null;
  const pts = decodePoints(r.p);
  if (pts.length < 3) return null;
  return {
    id,
    tool: TOOL_IDS[r.t] || 'pen',
    colour: r.c || INK,
    size: Number(r.s) || 3,
    pts,
    at: Number(r.at) || 0,
  };
}

const geometry = (r) => ({
  x: Number(r.x) || 0,
  y: Number(r.y) || 0,
  w: Math.max(1, Number(r.w) || 1),
  h: Math.max(1, Number(r.h) || 1),
});

const sameGeometry = (a, b) => ['x', 'y', 'w', 'h'].every((k) => Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0)) < 0.05);

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(data, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

function colourFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

function peopleLine(members, meUid) {
  const others = members.filter((m) => m.uid !== meUid).map((m) => m.name);
  if (!others.length) return 'Just you so far';
  if (others.length === 1) return `You and ${others[0]}`;
  if (others.length === 2) return `You, ${others[0]} and ${others[1]}`;
  return `You, ${others[0]} and ${others.length - 1} others`;
}

/* --------------------------------------------------------- invite, join */

function inviteSheet(link, title, members) {
  overlay((close) => {
    const share = el('button', { class: 'sheet-item' },
      el('span', { class: 'sheet-label' }, el('span', { text: 'Share Link...' })), icon('share'));
    share.addEventListener('click', async () => {
      haptic('select');
      close();
      const text = `Write on "${title || 'my page'}" with me in Notes`;
      if (navigator.share) {
        try {
          await navigator.share({ title: title || 'Shared page', text, url: link });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      copy(link);
    });
    const copyBtn = el('button', { class: 'sheet-item' },
      el('span', { class: 'sheet-label' }, el('span', { text: 'Copy Link' })), icon('copy'));
    copyBtn.addEventListener('click', () => {
      haptic('select');
      close();
      copy(link);
    });
    return el('div', { class: 'sheet' },
      el('div', { class: 'sheet-group' },
        el('div', { class: 'sheet-title' },
          el('strong', { text: 'Invite People' }),
          el('span', { text: 'Anyone with this link can write on this page once they sign in. In Notes they tap Shared Pages, then Join, and paste it.' })),
        el('div', { class: 'sheet-pad invite-people', text: members }),
        el('div', { class: 'sheet-pad invite-link', text: link }),
        share,
        copyBtn),
      el('div', { class: 'sheet-group' },
        el('button', { class: 'sheet-item cancel', text: 'Done', onclick: () => { haptic(); close(); } })));
  });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', { icon: 'copy' });
  } catch {
    toast('Could not copy the link');
  }
}

/**
 * A failure worth more than a toast - which, with the keyboard up, lands
 * under the dialog and fades before it can be read.
 */
function explain(err) {
  const setup = /not set up/i.test(String((err && err.message) || ''));
  alert2(
    setup ? 'Shared Pages Are Not Switched On' : 'That Did Not Work',
    setup
      ? 'They need a Realtime Database in the Koino Firebase project, and it has not been created yet. It is a one-time step in the Firebase console.'
      : String((err && err.message) || err),
    [{ label: 'OK', strong: true }],
  );
}

/** Asks for an invite link and joins; opens the page on success. */
export function joinFlow(prefill = '', onJoined = null) {
  if (!shared.signedIn()) {
    signInFlow(() => joinFlow(prefill, onJoined));
    return;
  }
  alert2('Join a Shared Page', 'Paste the invite link you were sent.', [
    { label: 'Cancel' },
    {
      label: 'Join',
      strong: true,
      onPick: async (text) => {
        if (!text) return false;
        try {
          const id = await shared.joinBoard(text);
          toast('Joined', { icon: 'check' });
          openDetail(sharedPageScreen(id));
          if (onJoined) onJoined(id);
          return true;
        } catch (err) {
          // A mistyped link stays open to fix; anything else is explained.
          if (err.status === 400 || err.status === 401 || err.status === 403) {
            say(err);
            return false;
          }
          setTimeout(() => explain(err), 420);
          return true;
        }
      },
    },
  ], { input: prefill, placeholder: 'Invite link' });
}

/** Starts a new shared page; opens it on success. */
export function createFlow(onCreated = null) {
  if (!shared.signedIn()) {
    signInFlow(() => createFlow(onCreated));
    return;
  }
  alert2('New Shared Page', 'Give it a name. You can invite people once it is open.', [
    { label: 'Cancel' },
    {
      label: 'Create',
      strong: true,
      onPick: async (title) => {
        try {
          const id = await shared.createBoard(title || '');
          openDetail(sharedPageScreen(id));
          if (onCreated) onCreated(id);
          return true;
        } catch (err) {
          setTimeout(() => explain(err), 420);
          return true;
        }
      },
    },
  ], { input: '', placeholder: 'Name' });
}

/** An invite link opened the web app: show the list, then offer to join. */
export function joinFromLink(text) {
  const list = sharedListScreen();
  push(list);
  setTimeout(() => joinFlow(text, () => list.onReturn && list.onReturn()), 420);
}

/* ------------------------------------------------------------ the list */

export function sharedListScreen() {
  const screen = el('section', { class: 'screen grouped' });
  const body = el('div', { class: 'body' });
  let boards = shared.cachedBoards();
  let failure = null;
  let loading = false;

  const bar = navBar({
    left: [backButton('Folders', () => pop())],
    title: 'Shared',
    right: [navIconButton('ellipsis', openMenu, 'More')],
  });

  const toolbar = el('footer', { class: 'toolbar' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'toolbar-left' },
        pressable(el('button', { class: 'toolbar-text', text: 'Join' }), () => joinFlow('', load))),
      el('div', { class: 'toolbar-count' }),
      el('div', { class: 'toolbar-right' },
        pressable(el('button', { class: 'compose', 'aria-label': 'New shared page' }, icon('compose')), () => createFlow(load)))));

  function openMenu() {
    actionSheet(null, [
      { label: 'New Shared Page', icon: 'compose', onPick: () => createFlow(load) },
      { label: 'Join with a Link...', icon: 'people', onPick: () => joinFlow('', load) },
      shared.signedIn() ? { label: 'Your Name', icon: 'pencil', sub: shared.myName(), onPick: () => nameFlow(render) } : null,
      { label: 'Refresh', icon: 'restore', onPick: load },
    ]);
  }

  async function load() {
    if (!shared.signedIn()) {
      render();
      return;
    }
    loading = true;
    render();
    try {
      boards = await shared.listBoards();
      failure = null;
    } catch (err) {
      failure = err;
    }
    loading = false;
    render();
  }

  function confirmLeave(b) {
    const owner = b.mine;
    alert2(owner ? `Delete "${b.title || 'Untitled page'}"?` : `Leave "${b.title || 'Untitled page'}"?`,
      owner ? 'It is deleted for everyone it is shared with. This cannot be undone.' : 'You can come back with the invite link.',
      [
        { label: 'Cancel' },
        {
          label: owner ? 'Delete' : 'Leave',
          destructive: true,
          onPick: async () => {
            try {
              if (owner) await shared.deleteBoard(b.id);
              else await shared.leaveBoard(b.id);
              boards = boards.filter((x) => x.id !== b.id);
              render();
            } catch (err) {
              say(err);
            }
          },
        },
      ]);
  }

  function boardCell(b) {
    const me = account();
    const node = el('div', { class: 'cell' },
      icon('people', 'lead'),
      el('span', { class: 'cell-name' },
        el('span', { text: b.title || 'Untitled page' }),
        el('span', { class: 'cell-sub', text: peopleLine(b.members || [], me && me.uid) })),
      icon('chev-right', 'chev'));
    pressable(node, () => openDetail(sharedPageScreen(b.id)));
    longPress(node, () => contextMenu(node, [
      { label: b.mine ? 'Delete for Everyone' : 'Leave', icon: b.mine ? 'trash' : 'minus-circle', destructive: true, onPick: () => confirmLeave(b) },
    ], { title: b.title || 'Untitled page' }));
    return node;
  }

  function render() {
    const scrollTop = body.scrollTop;
    body.innerHTML = '';
    body.append(el('h1', { class: 'large-title', text: 'Shared' }));

    if (!shared.signedIn()) {
      body.append(el('div', { class: 'empty' },
        icon('people'),
        el('h4', { text: 'Write Together' }),
        el('p', { text: 'Sign in to start a shared page, or to join one from an invite link. Everyone sees each stroke as it is written.' }),
        pressable(el('button', { class: 'vault-retry', text: 'Sign In' }), () => signInFlow(load))));
    } else if (!boards.length) {
      body.append(el('div', { class: 'empty' },
        icon('people'),
        el('h4', { text: loading ? 'Loading...' : failure ? 'Could Not Load' : 'No Shared Pages' }),
        el('p', {
          text: failure
            ? String(failure.message || failure)
            : 'Start one with the compose button, then send the invite link. Everyone sees each stroke as it is written.',
        })));
    } else {
      body.append(el('div', { class: 'group' },
        el('div', { class: 'group-card' }, boards.map(boardCell))));
      if (failure) body.append(el('p', { class: 'vault-status', text: String(failure.message || failure) }));
    }

    bindScrollTitle(body, bar, body.querySelector('.large-title'));
    body.scrollTop = scrollTop;
  }

  screen.append(bar, body, toolbar);
  screen.onReturn = load;
  render();
  load();
  return screen;
}

/* ------------------------------------------------------------- the page */

export function sharedPageScreen(boardId) {
  const me = account();
  const screen = el('section', { class: 'screen ink-screen' });
  screen.dataset.pane = 'detail';

  /* A shared page is always a whiteboard. Several people writing at once need
     room to spread out and keep out of each other's way, which a page does not
     have, and there is no page edge to argue about. */
  const page = {
    key: 'page',
    width: BOARD,
    height: BOARD,
    minHeight: BOARD,
    unit: PAGE_WIDTH,
    board: true,
    strokes: [],
    images: [],
    paper: 'plain',
  };
  /* Pages written before they were boards have their strokes up by the origin,
     a long way from where a board opens, so the first load goes to find them. */
  let framed = false;
  let session = null;
  let stopPresence = null;
  let left = false;
  let serverOffset = 0;
  let lastOwnBeat = 0;
  let herePreviously = new Set();

  // Strokes drawn here that the server has not echoed back yet, and ones
  // erased here that it still holds. The same for pictures, plus pictures
  // moved here whose new place has not come back.
  const localOnly = new Set();
  const erasedHere = new Set();
  const picturesLocalOnly = new Set();
  const picturesErasedHere = new Set();
  const moving = new Map();
  const pictureData = new Map();

  const board = () => (session && session.board) || {};

  const view = inkView({
    pages: [page],
    grow: false,
    sidePad: 0,
    topPad: 72,
    bottomPad: 120,
    dark: isDark,
    paper: () => page.paper,
    fingerDraws: () => !!store.settings.fingerDraws,
    onChange: () => sendChanges(),
    onHistory: () => chrome.sync(),
    onView: (v) => chrome.setView(v),
    imageFor: async (im) => {
      const data = pictureData.get(im.id) || ((board().images || {})[im.id] || {}).d;
      return data ? createImageBitmap(base64ToBlob(data, 'image/jpeg')) : null;
    },
  });

  const title = el('input', {
    class: 'ink-title',
    type: 'text',
    placeholder: 'Shared page',
    enterkeyhint: 'done',
    'aria-label': 'Title',
  });
  let titleTimer = 0;
  const sendTitle = () => {
    clearTimeout(titleTimer);
    titleTimer = 0;
    if (session) session.write({ 'meta/title': title.value.slice(0, 120) });
  };
  title.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(sendTitle, 500);
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });

  const people = el('div', { class: 'pill-people', 'aria-live': 'polite' });

  const chrome = inkChrome(view, {
    titleEl: title,
    onBack: () => pop(),
    onMenu: openMenu,
    pages: false,
    onImage: addPicture,
    navExtra: people,
  });

  // Covers the page, not the toolbars, until the board has arrived: a stroke
  // drawn before then would have nothing to be reconciled against.
  const status = el('div', { class: 'pdf-status shared-status', text: 'Connecting...' });
  screen.append(el('div', { class: 'ink-stage' }, view.el, status, chrome.el));

  /* ------------------------------------------------- server to screen */

  function applyStrokes() {
    const remote = board().strokes || {};
    const onPage = new Set(page.strokes.map((s) => s.id));
    let changed = false;
    const keep = [];
    for (const s of page.strokes) {
      if (remote[s.id] || localOnly.has(s.id)) keep.push(s);
      else changed = true; // it reached the server, and now it is gone: erased elsewhere
    }
    const arrived = [];
    for (const [id, r] of Object.entries(remote)) {
      localOnly.delete(id);
      if (onPage.has(id) || erasedHere.has(id)) continue;
      const s = decodeStroke(id, r);
      if (s) arrived.push(s);
    }
    for (const id of [...erasedHere]) if (!remote[id]) erasedHere.delete(id);
    if (arrived.length) {
      arrived.sort((a, b) => a.at - b.at);
      for (const s of arrived) keep.push(s);
      changed = true;
    }
    if (changed) {
      page.strokes.length = 0;
      for (const s of keep) page.strokes.push(s);
      view.refresh();
      frameOnce();
    }
  }

  /* The first writing to arrive decides where the board opens, so a page from
     before boards - or one someone else started in a far corner - is on screen
     rather than somewhere out in the empty part. */
  function frameOnce() {
    if (framed || (!page.strokes.length && !page.images.length)) return;
    framed = true;
    view.recentre();
  }

  function applyPictures() {
    const remote = board().images || {};
    const dragging = view.dragging();
    const onPage = new Set(page.images.map((im) => im.id));
    let changed = false;
    const keep = [];
    for (const im of page.images) {
      const r = remote[im.id];
      if (r) {
        if (typeof r.d === 'string' && !pictureData.has(im.id)) pictureData.set(im.id, r.d);
        const sent = moving.get(im.id);
        if (sent && (sameGeometry(r, sent.g) || Date.now() - sent.at > MOVE_ECHO_MS)) moving.delete(im.id);
        if (!moving.has(im.id) && im !== dragging && !sameGeometry(r, im)) {
          Object.assign(im, geometry(r));
          changed = true;
        }
        keep.push(im);
      } else if (picturesLocalOnly.has(im.id)) {
        keep.push(im);
      } else {
        changed = true;
      }
    }
    for (const [id, r] of Object.entries(remote)) {
      picturesLocalOnly.delete(id);
      if (onPage.has(id) || picturesErasedHere.has(id)) continue;
      if (typeof r.d === 'string') pictureData.set(id, r.d);
      keep.push({ id, ...geometry(r) });
      changed = true;
    }
    for (const id of [...picturesErasedHere]) if (!remote[id]) picturesErasedHere.delete(id);
    if (changed) {
      page.images.length = 0;
      for (const im of keep) page.images.push(im);
      view.refresh();
      frameOnce();
    }
  }

  function applyMeta() {
    const meta = board().meta || {};
    if (document.activeElement !== title && !titleTimer) title.value = meta.title || '';
    const paper = PAPERS.includes(meta.paper) ? meta.paper : 'plain';
    if (paper !== page.paper) {
      page.paper = paper;
      view.redraw();
    }
  }

  function applyPeople() {
    const members = board().members || {};
    const presence = board().presence || {};
    const mine = presence[me.uid];
    // Our own heartbeat, stamped by the server, says how far our clock is off.
    if (mine && typeof mine.at === 'number' && mine.at !== lastOwnBeat) {
      lastOwnBeat = mine.at;
      serverOffset = mine.at - Date.now();
    }
    const now = Date.now() + serverOffset;
    const here = Object.entries(presence)
      .filter(([uid, p]) => uid !== me.uid && p && typeof p.at === 'number' && now - p.at < HERE_MS)
      .map(([uid, p]) => ({ uid, name: (members[uid] && members[uid].name) || p.name || 'Someone' }));

    for (const p of here) {
      if (!herePreviously.has(p.uid) && lastOwnBeat) toast(`${p.name} is here`);
    }
    herePreviously = new Set(here.map((p) => p.uid));

    people.textContent = '';
    people.classList.toggle('empty', !here.length);
    for (const p of here.slice(0, 3)) {
      people.append(el('span', { class: 'avatar', title: `${p.name} is here`, style: `--av:${colourFor(p.name)}`, text: initials(p.name) }));
    }
    if (here.length > 3) people.append(el('span', { class: 'avatar more', text: `+${here.length - 3}` }));
  }

  /* ------------------------------------------------- screen to server */

  function sendChanges() {
    if (!session || !session.board) return;
    const updates = {};

    const remote = board().strokes || {};
    const here = new Set();
    for (const s of page.strokes) {
      if (!s.id) s.id = newStrokeId();
      here.add(s.id);
      if (!remote[s.id] && !localOnly.has(s.id)) {
        localOnly.add(s.id);
        erasedHere.delete(s.id);
        updates[`strokes/${s.id}`] = encodeStroke(s, me.uid);
      }
    }
    for (const id of Object.keys(remote)) {
      if (!here.has(id) && !erasedHere.has(id)) {
        erasedHere.add(id);
        updates[`strokes/${id}`] = null;
      }
    }
    for (const id of [...localOnly]) {
      if (!here.has(id)) {
        localOnly.delete(id);
        erasedHere.add(id);
        updates[`strokes/${id}`] = null;
      }
    }

    const remotePictures = board().images || {};
    const herePictures = new Set();
    for (const im of page.images) {
      herePictures.add(im.id);
      const r = remotePictures[im.id];
      if (!r && !picturesLocalOnly.has(im.id)) {
        const d = pictureData.get(im.id);
        if (!d) continue;
        picturesLocalOnly.add(im.id);
        picturesErasedHere.delete(im.id);
        updates[`images/${im.id}`] = { ...geometry(im), d, by: me.uid, at: SERVER_TIME };
      } else if (r && !sameGeometry(r, im)) {
        const sent = moving.get(im.id);
        if (!sent || !sameGeometry(sent.g, im)) {
          const g = geometry(im);
          moving.set(im.id, { g, at: Date.now() });
          for (const k of ['x', 'y', 'w', 'h']) updates[`images/${im.id}/${k}`] = Math.round(g[k] * 10) / 10;
        }
      }
    }
    for (const id of Object.keys(remotePictures)) {
      if (!herePictures.has(id) && !picturesErasedHere.has(id)) {
        picturesErasedHere.add(id);
        updates[`images/${id}`] = null;
      }
    }
    for (const id of [...picturesLocalOnly]) {
      if (!herePictures.has(id)) {
        picturesLocalOnly.delete(id);
        picturesErasedHere.add(id);
        updates[`images/${id}`] = null;
      }
    }

    if (Object.keys(updates).length) session.write(updates);
  }

  /* -------------------------------------------------------- actions */

  function addPicture() {
    if (!session || !session.board) {
      toast('Still connecting');
      return;
    }
    pickPicture(async ({ blob, width, height }) => {
      const data = await blobToBase64(blob);
      if (data.length > MAX_PICTURE_CHARS) {
        toast('That picture is too big to share');
        return;
      }
      const id = shared.randomId(12);
      pictureData.set(id, data);
      placePicture(view, { id }, width, height);
    });
  }

  function openInvite() {
    const b = board();
    if (!b.invite) {
      toast('Still connecting');
      return;
    }
    const members = Object.entries(b.members || {}).map(([uid, m]) => ({ uid, name: (m && m.name) || 'Someone' }));
    inviteSheet(shared.inviteLink(boardId, b.invite), title.value, peopleLine(members, me.uid));
  }

  function openMenu() {
    const meta = board().meta || {};
    const owner = meta.owner === me.uid;
    const members = Object.entries(board().members || {}).map(([uid, m]) => ({ uid, name: (m && m.name) || 'Someone' }));
    actionSheet(null, [
      { label: 'Invite People', icon: 'people', sub: peopleLine(members, me.uid), onPick: openInvite },
      {
        label: 'Background',
        icon: 'grid',
        sub: backgroundLabel(page.paper, INK_NAMES),
        onPick: () => backgroundSheet(page.paper, INK_NAMES, (k) => {
          page.paper = k;
          view.redraw();
          if (session) session.write({ 'meta/paper': k });
        }),
      },
      { label: 'Find My Writing', icon: 'search', onPick: () => view.recentre() },
      { label: 'Add a Picture', icon: 'photo', onPick: addPicture },
      {
        label: store.settings.fingerDraws ? 'Finger Scrolls' : 'Finger Draws',
        icon: 'markup',
        sub: 'Only when no stylus has been used',
        onPick: () => {
          store.settings.fingerDraws = !store.settings.fingerDraws;
          save();
          chrome.sync();
        },
      },
      { label: 'Share as Image', icon: 'share', onPick: () => sharePage(view, title.value || 'Shared page') },
      owner
        ? { label: 'Delete for Everyone', icon: 'trash', destructive: true, onPick: () => confirmEnd(true) }
        : { label: 'Leave Page', icon: 'minus-circle', destructive: true, onPick: () => confirmEnd(false) },
    ]);
  }

  function confirmEnd(owner) {
    alert2(owner ? 'Delete for Everyone?' : 'Leave This Page?',
      owner ? 'The page is deleted for everyone it is shared with. This cannot be undone.' : 'You can come back with the invite link.',
      [
        { label: 'Cancel' },
        {
          label: owner ? 'Delete' : 'Leave',
          destructive: true,
          onPick: async () => {
            left = true;
            try {
              if (owner) await shared.deleteBoard(boardId);
              else await shared.leaveBoard(boardId);
            } catch (err) {
              left = false;
              say(err);
              return false;
            }
            pop();
            return true;
          },
        },
      ]);
  }

  /* -------------------------------------------------------- life */

  function start() {
    session = shared.openBoard(boardId, {
      ready: () => {
        status.hidden = true;
        applyMeta();
        applyStrokes();
        applyPictures();
        applyPeople();
        // Anything drawn while the connection was down goes up now.
        sendChanges();
      },
      change: (sections) => {
        if (sections.has('strokes')) applyStrokes();
        if (sections.has('images')) applyPictures();
        if (sections.has('meta')) applyMeta();
        if (sections.has('members') || sections.has('presence')) applyPeople();
      },
      status: (online, err) => {
        people.classList.toggle('offline', !online);
        if (!online && !status.hidden && !left) {
          status.textContent = err ? String(err.message || err) : 'Waiting for a connection...';
        }
      },
      gone: () => {
        if (left) return;
        left = true;
        toast('This page is no longer shared with you');
        pop();
      },
      error: say,
    });
    stopPresence = shared.announce(boardId);
  }

  const peopleTimer = setInterval(() => { if (session && session.board) applyPeople(); }, 20000);

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || document.activeElement === title) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); view.undo(); }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); view.redo(); }
  };
  document.addEventListener('keydown', onKey);

  screen.onShow = () => view.layout();
  screen.onReturn = () => view.layout();
  screen.onLeave = () => {
    left = true;
    if (titleTimer) sendTitle();
    clearInterval(peopleTimer);
    document.removeEventListener('keydown', onKey);
    if (stopPresence) stopPresence();
    if (session) session.close();
    view.destroy();
    chrome.destroy();
  };

  if (!me) {
    status.textContent = 'Sign in to open shared pages';
  } else {
    start();
  }
  haptic('tap');
  return screen;
}
