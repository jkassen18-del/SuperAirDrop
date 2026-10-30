import { randomId } from './protocol.mjs';
import { TransferEngine } from './engine.mjs';
import { openStorage } from './storage.mjs';
import { Link } from './link.mjs';

const $ = (id) => document.getElementById(id);

// ---- identity ---------------------------------------------------------------

const ADJECTIVES = ['Blue', 'Swift', 'Sunny', 'Quiet', 'Brave', 'Lucky', 'Clever', 'Happy', 'Cosmic', 'Golden'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Tiger', 'Dolphin', 'Owl', 'Lynx', 'Penguin'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function stored(key, make) {
  try {
    let v = localStorage.getItem(key);
    if (!v) localStorage.setItem(key, (v = make()));
    return v;
  } catch {
    return make();
  }
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/SamsungBrowser|SM-[A-Z0-9]+/i.test(ua)) return 'Samsung';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Computer';
}

const me = {
  id: stored('sad.id', randomId),
  name: stored('sad.name', () => `${pick(ADJECTIVES)} ${pick(ANIMALS)}`),
  device: deviceLabel(),
};
$('my-name').textContent = me.name;

// ---- helpers ------------------------------------------------------------------

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function deviceIcon(device) {
  const phone = /iPhone|Samsung|Android/.test(device);
  return el('span', { class: 'avatar', 'aria-hidden': 'true' }, phone ? '📱' : '💻');
}

// ---- state --------------------------------------------------------------------

const { storage, persistent } = await openStorage();
if (!persistent) $('storage-warning').textContent = ' Private browsing: files are only kept until you close this tab.';

const peers = new Map(); // id -> { id, name, device, direct }
const transfers = new Map(); // id -> view
let targetPeer = null;

const engine = new TransferEngine({ storage, send: (peerId, msg) => link.send(peerId, msg) });

const link = new Link({
  me,
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  handlers: {
    onStatus(status) {
      const s = $('status');
      s.textContent = { online: 'Online', connecting: 'Connecting…', offline: 'Reconnecting…' }[status];
      s.dataset.state = status;
    },
    onPeers(list) {
      peers.clear();
      for (const p of list) peers.set(p.id, p);
      renderPeers();
      renderTransfers();
    },
    onPeerUp: (id) => engine.peerConnected(id),
    onPeerDown: (id) => engine.peerDisconnected(id),
    // A new route (direct channel opened or closed) may have lost messages in
    // flight; peerConnected makes both sides re-sync where they are.
    onRoute: (id) => engine.peerConnected(id),
    onMessage: (from, msg) => engine.handleMessage(from, msg, peers.get(from)?.name),
    onBinary: (from, buf) => engine.handleBinary(from, buf),
  },
});

for (const code of JSON.parse(stored('sad.codes', () => '[]'))) link.joinCode(code);

engine.on('update', (view) => {
  transfers.set(view.id, view);
  renderTransfers();
  updateWakeLock();
});
engine.on('offer', (view) => queueOffer(view));
engine.on('file', (record) => {
  toast(`Received ${record.name}`);
  renderInbox();
});
engine.on('error', ({ error }) => toast(error.message || String(error)));
await engine.restore();

// ---- peers -----------------------------------------------------------------------

function renderPeers() {
  const box = $('peers');
  box.replaceChildren(
    ...[...peers.values()].map((p) =>
      el(
        'button',
        {
          class: 'peer',
          onclick: () => choose(p.id),
          ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop'); },
          ondragleave: (e) => e.currentTarget.classList.remove('drop'),
          ondrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('drop');
            if (e.dataTransfer.files.length) send(p.id, e.dataTransfer.files);
          },
        },
        deviceIcon(p.device),
        el('span', { class: 'peer-name' }, p.name),
        el('span', { class: 'peer-meta' }, `${p.device} · ${p.direct ? 'Direct' : 'Via server'}`),
      ),
    ),
  );
  $('no-peers').hidden = peers.size > 0;
}

function choose(peerId) {
  targetPeer = peerId;
  $('file-input').value = '';
  $('file-input').click();
}

$('file-input').addEventListener('change', (e) => {
  if (targetPeer && e.target.files.length) send(targetPeer, e.target.files);
});

function send(peerId, files) {
  engine.sendFiles(peerId, files);
  toast(`Waiting for ${peers.get(peerId)?.name || 'the other device'} to accept…`);
}

// ---- incoming offers ------------------------------------------------------------

const offers = [];
function queueOffer(view) {
  offers.push(view);
  if (!$('offer-dialog').open) showOffer();
}

function showOffer() {
  const view = offers.shift();
  if (!view) return;
  const dialog = $('offer-dialog');
  const who = view.peerName || 'A device';
  const count = view.files.length;
  $('offer-title').textContent = `${who} wants to send ${count === 1 ? 'a file' : `${count} files`} (${formatSize(view.bytes)})`;
  $('offer-files').replaceChildren(
    ...view.files.slice(0, 8).map((f) => el('li', {}, f.name, el('span', { class: 'muted' }, ` ${formatSize(f.size)}`))),
    count > 8 ? el('li', { class: 'muted' }, `and ${count - 8} more`) : null,
  );
  dialog.onclose = () => {
    if (dialog.returnValue === 'accept') engine.accept(view.id);
    else engine.decline(view.id);
    showOffer();
  };
  dialog.returnValue = '';
  dialog.showModal();
}

// ---- transfers ----------------------------------------------------------------

function statusText(v) {
  const who = peers.get(v.peerId)?.name || v.peerName || 'device';
  const pct = `${Math.floor(v.progress * 100)}%`;
  switch (v.state) {
    case 'waiting': return `Waiting for ${who} to come online…`;
    case 'offered': return `Waiting for ${who} to accept…`;
    case 'pending': return 'Waiting for you to accept';
    case 'sending':
    case 'receiving':
      return v.online ? `${v.dir === 'out' ? 'Sending' : 'Receiving'} · ${pct}` : `Paused at ${pct} · will resume when ${who} reconnects`;
    case 'done': return v.dir === 'out' ? `Delivered to ${who} ✓` : 'Received and verified ✓';
    case 'declined': return `${who} declined`;
    case 'cancelled': return 'Cancelled';
    default: return v.state;
  }
}

function renderTransfers() {
  const list = [...transfers.values()].reverse();
  $('transfers').replaceChildren(
    ...list.map((v) => {
      const active = !['done', 'declined', 'cancelled'].includes(v.state);
      const names = v.files.length === 1 ? v.files[0].name : `${v.files.length} files`;
      return el(
        'li',
        { class: `item ${v.state}` },
        el('div', { class: 'row' },
          el('span', { class: 'dir' }, v.dir === 'out' ? '↑' : '↓'),
          el('div', { class: 'grow' },
            el('div', { class: 'title' }, names, el('span', { class: 'muted' }, ` · ${formatSize(v.bytes)}`)),
            el('div', { class: 'muted small' }, statusText(v)),
          ),
          active
            ? el('button', { class: 'icon', title: 'Cancel', onclick: () => engine.cancel(v.id) }, '✕')
            : el('button', { class: 'icon', title: 'Dismiss', onclick: () => { transfers.delete(v.id); renderTransfers(); } }, '✕'),
        ),
        active ? el('progress', { max: '1', value: String(v.progress) }) : null,
      );
    }),
  );
  $('no-transfers').hidden = transfers.size > 0;
}

function hasActiveTransfers() {
  return [...transfers.values()].some((v) => v.state === 'sending' || v.state === 'receiving');
}

// Keep the screen on while transferring: phones kill network activity of
// sleeping tabs, which is the most common way transfers get interrupted.
let wakeLock = null;
async function updateWakeLock() {
  const want = hasActiveTransfers() && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', updateWakeLock);

window.addEventListener('beforeunload', (e) => {
  if ([...transfers.values()].some((v) => v.dir === 'out' && !['done', 'declined', 'cancelled'].includes(v.state))) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- inbox ----------------------------------------------------------------------

const objectUrls = new Map();
function urlFor(record) {
  if (!objectUrls.has(record.id)) objectUrls.set(record.id, URL.createObjectURL(record.blob));
  return objectUrls.get(record.id);
}

function download(record) {
  const a = el('a', { href: urlFor(record), download: record.name });
  document.body.append(a);
  a.click();
  a.remove();
}

async function share(record) {
  const file = new File([record.blob], record.name, { type: record.type });
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== 'AbortError') download(record);
  }
}

function canShareFiles(record) {
  try {
    return !!navigator.canShare?.({ files: [new File([record.blob], record.name, { type: record.type })] });
  } catch {
    return false;
  }
}

async function renderInbox() {
  const files = await storage.listFiles();
  $('inbox').replaceChildren(
    ...files.map((r) => {
      const preview = r.type.startsWith('image/')
        ? el('img', { class: 'thumb', src: urlFor(r), alt: '', loading: 'lazy' })
        : el('span', { class: 'thumb file' }, r.name.split('.').pop().slice(0, 4).toUpperCase() || 'FILE');
      return el(
        'li',
        { class: 'item' },
        el('div', { class: 'row' },
          preview,
          el('div', { class: 'grow' },
            el('div', { class: 'title' }, r.name),
            el('div', { class: 'muted small' }, `${formatSize(r.size)} · from ${r.from} · ${new Date(r.receivedAt).toLocaleString()}`),
          ),
        ),
        el('div', { class: 'buttons' },
          canShareFiles(r) ? el('button', { class: 'primary', onclick: () => share(r) }, 'Save / Share') : null,
          el('button', { class: canShareFiles(r) ? 'secondary' : 'primary', onclick: () => download(r) }, 'Download'),
          el('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm(`Delete ${r.name} from SuperAirDrop?`)) return;
              await storage.deleteFile(r.id);
              URL.revokeObjectURL(objectUrls.get(r.id));
              objectUrls.delete(r.id);
              renderInbox();
            },
          }, 'Delete'),
        ),
      );
    }),
  );
  $('no-files').hidden = files.length > 0;
  $('save-all').hidden = files.length < 2;
}

$('save-all').addEventListener('click', async () => {
  const records = await storage.listFiles();
  const files = records.map((r) => new File([r.blob], r.name, { type: r.type }));
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  for (const r of records) download(r);
});

renderInbox();
renderPeers();
renderTransfers();

// ---- rename & pairing -----------------------------------------------------------

$('my-name').addEventListener('click', () => {
  const name = prompt('Name this device', me.name)?.trim();
  if (!name) return;
  me.name = name.slice(0, 40);
  try { localStorage.setItem('sad.name', me.name); } catch {}
  $('my-name').textContent = me.name;
  link.ws?.close(); // reconnect with the new name
});

const myCode = String(parseInt(me.id.slice(0, 8), 16) % 1000000).padStart(6, '0');
$('my-code').textContent = myCode;
// Always listen on our own code so a device paired earlier finds us again.
link.joinCode(myCode);

function rememberCode(code) {
  const codes = new Set(JSON.parse(stored('sad.codes', () => '[]')));
  codes.add(code);
  try { localStorage.setItem('sad.codes', JSON.stringify([...codes].slice(-5))); } catch {}
  link.joinCode(code);
}

$('pair').addEventListener('click', () => {
  $('code-input').value = '';
  $('pair-dialog').showModal();
});

$('pair-dialog').addEventListener('close', () => {
  if ($('pair-dialog').returnValue !== 'join') return;
  const code = $('code-input').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('Codes have 6 digits');
  rememberCode(code);
  toast('Paired. The other device will appear in a moment.');
});
