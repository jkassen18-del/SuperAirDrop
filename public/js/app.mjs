import { randomId } from './protocol.mjs';
import { TransferEngine } from './engine.mjs';
import { openStorage } from './storage.mjs';
import { Link } from './link.mjs';
import { qrSvg } from './qr.mjs';

// Present when running inside the Android app (see android/).
const android = globalThis.SuperAirDropAndroid;

const $ = (id) => document.getElementById(id);

// ---- identity ---------------------------------------------------------------

function stored(key, make) {
  try {
    let v = localStorage.getItem(key);
    if (!v) localStorage.setItem(key, (v = make()));
    return v;
  } catch {
    return make();
  }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

function deviceLabel() {
  if (/SamsungBrowser|SM-[A-Z0-9]+/i.test(ua) || android) return 'Samsung';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (isIOS) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Computer';
}

const DEFAULT_NAMES = { Samsung: 'Galaxy', iPhone: 'iPhone', iPad: 'iPad', Android: 'Android phone', Mac: 'Mac', Windows: 'PC', Computer: 'Computer' };
const device = deviceLabel();
const me = { id: stored('sad.id', randomId), name: stored('sad.name', () => DEFAULT_NAMES[device]), device };
// v1 gave devices random names like "Brave Owl"; use the device name instead.
if (/^(Blue|Swift|Sunny|Quiet|Brave|Lucky|Clever|Happy|Cosmic|Golden) (Otter|Falcon|Panda|Fox|Koala|Tiger|Dolphin|Owl|Lynx|Penguin)$/.test(me.name)) {
  me.name = DEFAULT_NAMES[device];
  remember('sad.name', me.name);
}
$('my-name').textContent = me.name;

// ---- helpers ------------------------------------------------------------------

function formatSize(n) {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatTime(s) {
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
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

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (size) svg.style.width = svg.style.height = `${size}px`;
  svg.innerHTML = paths;
  return svg;
}
const ICON = {
  photo: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 15.5l-4.5-4.5-7.5 8.5"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="3"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  file: '<path d="M7 3.5h6.5l4.5 4.5v11a1.5 1.5 0 01-1.5 1.5h-9.5A1.5 1.5 0 015.5 19V5A1.5 1.5 0 017 3.5z"/><path d="M13.5 3.5V8h4.5"/>',
  save: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M6.5 11.5h-1a1.5 1.5 0 00-1.5 1.5v6a1.5 1.5 0 001.5 1.5h13a1.5 1.5 0 001.5-1.5v-6a1.5 1.5 0 00-1.5-1.5h-1"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 15.5v2a2 2 0 002 2h11a2 2 0 002-2v-2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  remove: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const kindOf = (type = '') => (type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'file');

function initials(name) {
  const words = name.replace(/[’']s\b/g, '').split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?')[0];
  return letters.toUpperCase();
}
function colorClass(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `c${h % 6}`;
}
function avatar(peerLike, cls = '') {
  return el('div', { class: `avatar ${cls} ${colorClass(peerLike.id || peerLike.name)}`, 'aria-hidden': 'true' }, initials(peerLike.name || '?'));
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function buzz(ms = 12) {
  try { navigator.vibrate?.(ms); } catch {}
}

function describe(files) {
  const kinds = new Set(files.map((f) => kindOf(f.type)));
  const n = files.length;
  const noun = kinds.size === 1 && kinds.has('photo') ? 'photo' : kinds.size === 1 && kinds.has('video') ? 'video' : 'file';
  return n === 1 ? (noun === 'file' ? files[0].name : `a ${noun}`) : `${n} ${noun}s`;
}

// ---- sheets -----------------------------------------------------------------------

let openSheet = null;
function showSheet(id) {
  if (openSheet && openSheet !== id) $(openSheet).hidden = true;
  openSheet = id;
  $(id).hidden = false;
  $('dim').hidden = false;
}
function closeSheet() {
  if (!openSheet) return;
  $(openSheet).hidden = true;
  openSheet = null;
  $('dim').hidden = true;
  if (openSheet === null) showNextOffer();
}
$('dim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

// ---- state --------------------------------------------------------------------

const { storage, persistent } = await openStorage();
if (!persistent) $('inbox-note').textContent = 'Private browsing: files are kept until you close this tab.';

const peers = new Map(); // id -> { id, name, device, direct }
const outgoing = new Map(); // peerId -> latest outgoing transfer view
const transfers = new Map(); // id -> view
let pickFor = null;

const engine = new TransferEngine({ storage, send: (peerId, msg) => link.send(peerId, msg) });

const link = new Link({
  me,
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  handlers: {
    onStatus(status) {
      $('offline').hidden = status !== 'offline';
    },
    onPeers(list) {
      peers.clear();
      for (const p of list) peers.set(p.id, p);
      renderPeers();
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
  if (view.dir === 'out') {
    outgoing.set(view.peerId, view);
    if (view.state === 'done') buzz(20);
    if (view.state === 'declined') toast(`${peerName(view.peerId)} declined`);
    renderPeer(view.peerId);
  } else if (currentOffer?.id === view.id) {
    renderOfferProgress(view);
  }
  updateWakeLock();
});
engine.on('offer', (view) => {
  offers.push(view);
  buzz(30);
  showNextOffer();
});
engine.on('file', async (record) => {
  if (android) await saveRecord(record, { quiet: true });
  renderInbox();
});
engine.on('error', ({ error }) => toast(error.message || String(error)));
await engine.restore();

const peerName = (id) => peers.get(id)?.name || 'The other device';

// ---- peers on the radar -------------------------------------------------------------

// Slots around "you", as fractions of the radar box: alternating rings so
// names never overlap the centre.
const SLOTS = [
  [0.24, 0.14], [0.78, 0.26], [0.36, 0.86], [0.82, 0.72],
  [0.16, 0.58], [0.6, 0.06], [0.88, 0.48], [0.62, 0.92],
];
const peerEls = new Map();
const slotOf = new Map();

function renderPeers() {
  const box = $('peers');
  for (const [id, node] of peerEls) {
    if (!peers.has(id)) {
      node.remove();
      peerEls.delete(id);
      slotOf.delete(id);
    }
  }
  for (const p of peers.values()) {
    if (!peerEls.has(p.id)) {
      const used = new Set(slotOf.values());
      let slot = 0;
      while (used.has(slot) && slot < SLOTS.length - 1) slot++;
      slotOf.set(p.id, slot);
      peerEls.set(p.id, makePeer(p));
      box.append(peerEls.get(p.id));
    }
    renderPeer(p.id);
  }
  $('no-peers').hidden = peers.size > 0;
}

function makePeer(p) {
  const node = el('button', { class: 'peer', 'data-peer': p.id });
  node.innerHTML = `
    <div class="halo">
      <svg viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="39"/><circle class="bar" cx="42" cy="42" r="39"/></svg>
      <div class="check"></div>
    </div>
    <span class="peer-name"></span>
    <span class="peer-status"></span>`;
  node.querySelector('.check').append(icon(ICON.check));
  node.querySelector('.halo').insertBefore(avatar(p), node.querySelector('.check'));
  node.addEventListener('click', () => tapPeer(p.id));
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop'); });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop');
    if (e.dataTransfer.files.length) send(p.id, e.dataTransfer.files);
  });
  return node;
}

const doneTimers = new Map();
function renderPeer(id) {
  const node = peerEls.get(id);
  const p = peers.get(id);
  if (!node || !p) return;
  const [x, y] = SLOTS[slotOf.get(id) % SLOTS.length];
  node.style.left = `${x * 100}%`;
  node.style.top = `${y * 100}%`;
  node.querySelector('.peer-name').textContent = p.name;
  node.dataset.direct = String(!!p.direct);

  const v = outgoing.get(id);
  let status = p.device;
  let progress = 0;
  let cls = '';
  if (v) {
    if (v.state === 'offered' || v.state === 'waiting') { status = v.state === 'waiting' ? 'Waiting to connect…' : 'Waiting…'; cls = 'busy'; }
    else if (v.state === 'sending') {
      progress = v.progress;
      cls = 'busy';
      status = v.online ? `Sending · ${Math.floor(v.progress * 100)}%` : 'Paused · reconnecting';
    } else if (v.state === 'done') {
      progress = 1;
      cls = 'done';
      status = 'Delivered';
      if (!doneTimers.has(id)) {
        doneTimers.set(id, setTimeout(() => {
          doneTimers.delete(id);
          if (outgoing.get(id) === v) outgoing.delete(id);
          renderPeer(id);
        }, 3500));
      }
    }
  }
  node.className = `peer ${cls}`;
  node.querySelector('.bar').style.strokeDashoffset = String(245.04 * (1 - progress));
  node.querySelector('.peer-status').textContent = status;
  node.setAttribute('aria-label', `${p.name}, ${status}. Tap to send files.`);
}

function isActive(v) {
  return v && ['offered', 'waiting', 'sending'].includes(v.state);
}

function tapPeer(id) {
  buzz(8);
  const v = outgoing.get(id);
  if (isActive(v)) {
    $('busy-title').textContent = `Sending to ${peerName(id)}`;
    $('busy-what').textContent = `${describe(v.files)} · ${formatSize(v.bytes)}`;
    $('busy-cancel').onclick = () => { engine.cancel(v.id); outgoing.delete(id); renderPeer(id); closeSheet(); };
    $('busy-more').onclick = () => { closeSheet(); choose(id); };
    showSheet('sheet-busy');
    return;
  }
  choose(id);
}

function choose(id) {
  if (sharedFiles.length) {
    send(id, sharedFiles);
    sharedFiles = [];
    android?.clearSharedFiles();
    updateSharedBanner();
    return;
  }
  pickFor = id;
  if (isIOS) {
    // On iPhone the Photos picker converts HEIC and compresses videos; offer
    // the Files route for originals.
    $('pick-title').textContent = `Send to ${peerName(id)}`;
    showSheet('sheet-pick');
    return;
  }
  openPicker('file-any');
}

function openPicker(inputId) {
  const input = $(inputId);
  input.value = '';
  input.click();
}
$('pick-media').addEventListener('click', () => { closeSheet(); openPicker('file-media'); });
$('pick-files').addEventListener('click', () => { closeSheet(); openPicker('file-any'); });
for (const id of ['file-any', 'file-media']) {
  $(id).addEventListener('change', (e) => {
    if (pickFor && e.target.files.length) send(pickFor, e.target.files);
  });
}

function send(peerId, files) {
  engine.sendFiles(peerId, files);
}

// ---- incoming requests ------------------------------------------------------------

const offers = [];
let currentOffer = null;

function showNextOffer() {
  if (currentOffer) return;
  const view = offers.shift();
  if (!view) return;
  currentOffer = view;
  const who = { id: view.peerId, name: view.peerName || 'Someone' };
  $('offer-avatar').replaceWith(Object.assign(avatar(who, 'sm'), { id: 'offer-avatar' }));
  $('offer-name').textContent = who.name;
  $('offer-what').textContent = `wants to share ${describe(view.files)} · ${formatSize(view.bytes)}`;
  const shown = view.files.slice(0, view.files.length > 3 ? 2 : 3);
  $('offer-files').replaceChildren(
    ...shown.map((f) => el('div', { class: 'ftile' }, icon(ICON[kindOf(f.type)]), el('span', {}, f.name))),
    view.files.length > 3 ? el('div', { class: 'ftile more' }, `+${view.files.length - 2}`) : null,
  );
  $('offer-actions').hidden = false;
  $('offer-progress').hidden = true;
  showSheet('sheet-offer');
}

$('offer-accept').addEventListener('click', () => {
  if (!currentOffer) return;
  engine.accept(currentOffer.id);
  $('offer-actions').hidden = true;
  $('offer-progress').hidden = false;
  renderOfferProgress(transfers.get(currentOffer.id) || currentOffer);
});
$('offer-decline').addEventListener('click', () => {
  if (!currentOffer) return;
  engine.decline(currentOffer.id);
  currentOffer = null;
  closeSheet();
});

function renderOfferProgress(v) {
  $('offer-bar').style.width = `${Math.round(v.progress * 100)}%`;
  const speed = v.rate > 0 ? ` · ${formatSize(v.rate)}/s` : '';
  $('offer-done').textContent = v.online === false && v.state === 'receiving'
    ? 'Paused · waiting for the other device'
    : `${formatSize(v.bytesDone || 0)} of ${formatSize(v.bytes)}${speed}`;
  const left = v.rate > 0 ? formatTime((v.bytes - v.bytesDone) / v.rate) : '';
  $('offer-eta').textContent = left ? `About ${left} left` : '';
  $('received-count').hidden = false;
  $('received-count').textContent = `${Math.floor(v.progress * 100)}%`;
  if (v.state === 'done' || v.state === 'cancelled') {
    const finished = v.state === 'done';
    currentOffer = null;
    buzz(finished ? 25 : 10);
    if (finished) {
      renderInbox();
      showSheet('sheet-received');
    } else {
      renderInbox();
      toast('The sender stopped');
      if (openSheet === 'sheet-offer') closeSheet();
    }
  }
}

// Incoming transfers restored after a reload keep showing their progress.
for (const v of transfers.values()) {
  if (v.dir === 'in' && v.state === 'receiving' && !currentOffer) {
    currentOffer = v;
    $('offer-name').textContent = v.peerName || 'Receiving';
    $('offer-what').textContent = `${describe(v.files)} · ${formatSize(v.bytes)}`;
    $('offer-actions').hidden = true;
    $('offer-progress').hidden = false;
    showSheet('sheet-offer');
    renderOfferProgress(v);
  }
}

// ---- keep transfers alive -------------------------------------------------------

// Phones throttle sleeping tabs, the most common way transfers stall.
let wakeLock = null;
async function updateWakeLock() {
  const busy = [...transfers.values()].some((v) => v.state === 'sending' || v.state === 'receiving');
  const want = busy && document.visibilityState === 'visible';
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
  if ([...transfers.values()].some((v) => v.dir === 'out' && isActive(v))) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- received files ---------------------------------------------------------------

const objectUrls = new Map();
function urlFor(record) {
  if (!objectUrls.has(record.id)) objectUrls.set(record.id, URL.createObjectURL(record.blob));
  return objectUrls.get(record.id);
}

const asFile = (r) => new File([r.blob], r.name, { type: r.type });
function canShare(files) {
  try { return !!navigator.canShare?.({ files }); } catch { return false; }
}

async function markSaved(record) {
  record.saved = true;
  await storage.saveFile(record);
}

// Saves one file the best way this device allows. Returns true when saved.
async function saveRecord(record, { quiet = false } = {}) {
  if (android) {
    // The Android app writes straight to Downloads; no conversion needed.
    try {
      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'X-File-Name': encodeURIComponent(record.name), 'Content-Type': record.type || 'application/octet-stream' },
        body: record.blob,
      });
      if (!res.ok) throw new Error(String(res.status));
      await markSaved(record);
      if (!quiet) toast('Saved to Downloads');
      return true;
    } catch {
      toast(`Couldn’t save ${record.name}`);
      return false;
    }
  }
  const file = asFile(record);
  if (canShare([file])) {
    try {
      await navigator.share({ files: [file] });
      await markSaved(record);
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const a = el('a', { href: urlFor(record), download: record.name });
  document.body.append(a);
  a.click();
  a.remove();
  await markSaved(record);
  return true;
}

function openRecord(record) {
  // Opening a photo or video full size lets iPhone users long-press it and
  // choose Save to Photos, which works even without HTTPS.
  window.open(urlFor(record), '_blank');
}

async function renderInbox() {
  const files = await storage.listFiles();
  $('inbox').replaceChildren(
    ...files.map((r) => {
      const kind = kindOf(r.type);
      const thumb = el('button', { class: 'thumb', 'aria-label': `Open ${r.name}`, onclick: () => openRecord(r) },
        kind === 'photo' ? el('img', { src: urlFor(r), alt: '', loading: 'lazy' }) : icon(ICON[kind]));
      const save = el('button', {
        class: `icon-btn ${r.saved ? 'saved' : ''}`,
        'aria-label': r.saved ? `Save ${r.name} again` : `Save ${r.name}`,
        onclick: async () => { if (await saveRecord(r)) renderInbox(); },
      }, icon(r.saved ? ICON.check : ICON.save));
      const remove = el('button', {
        class: 'icon-btn plain',
        'aria-label': `Remove ${r.name}`,
        onclick: async () => {
          if (!r.saved && !confirm(`${r.name} hasn’t been saved yet. Remove it anyway?`)) return;
          await storage.deleteFile(r.id);
          URL.revokeObjectURL(objectUrls.get(r.id));
          objectUrls.delete(r.id);
          renderInbox();
        },
      }, icon(ICON.remove));
      const when = new Date(r.receivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return el('li', { class: 'row' }, thumb,
        el('div', { class: 'row-text' },
          el('span', { class: 'row-name' }, r.name),
          el('span', { class: 'row-meta' }, `${formatSize(r.size)} · ${r.from} · ${when}`)),
        save, remove);
    }),
  );
  const unsaved = files.filter((r) => !r.saved).length;
  $('no-files').hidden = files.length > 0;
  $('save-all').hidden = files.length < 2;
  $('save-all').disabled = unsaved === 0;
  $('save-all').textContent = unsaved === 0 ? 'All saved' : 'Save all';
  if (currentOffer && transfers.get(currentOffer.id)?.state === 'receiving') return;
  $('received-count').hidden = unsaved === 0;
  $('received-count').textContent = String(unsaved);
}

$('received-btn').addEventListener('click', () => {
  // While something is arriving, this reopens its progress.
  if (currentOffer && transfers.get(currentOffer.id)?.state === 'receiving') return showSheet('sheet-offer');
  renderInbox();
  showSheet('sheet-received');
});

$('save-all').addEventListener('click', async () => {
  const records = (await storage.listFiles()).filter((r) => !r.saved);
  const files = records.map(asFile);
  if (!android && canShare(files)) {
    try {
      await navigator.share({ files });
      for (const r of records) await markSaved(r);
    } catch {}
  } else {
    for (const r of records) await saveRecord(r, { quiet: true });
    if (android) toast(`Saved ${records.length} files to Downloads`);
  }
  renderInbox();
});

renderInbox();
renderPeers();

// ---- invite: QR code for the other device ------------------------------------------

const inviteUrl = android?.getShareUrl() || (/^(localhost|127\.|\[::1\])/.test(location.hostname) ? '' : location.origin + '/');
if (inviteUrl) {
  $('invite-qr').innerHTML = qrSvg(inviteUrl);
  $('invite-url').textContent = inviteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('invite-btn').hidden = false;
  $('invite-btn').addEventListener('click', () => showSheet('sheet-invite'));
} else if (android) {
  toast('Join Wi-Fi or turn on your hotspot so others can connect');
}

// ---- Android: files from the share sheet ---------------------------------------------

let sharedFiles = [];

function updateSharedBanner() {
  const banner = $('shared-banner');
  banner.hidden = sharedFiles.length === 0;
  banner.textContent = `Tap someone to send ${describe(sharedFiles)}`;
}

async function loadSharedFiles() {
  const list = JSON.parse(android.takeSharedFiles());
  if (!list.length) return;
  try {
    sharedFiles = await Promise.all(
      list.map(async (f) => new File([await (await fetch(f.url)).blob()], f.name, { type: f.type })),
    );
  } catch {
    toast('Couldn’t open the shared files');
  }
  updateSharedBanner();
}

if (android) {
  window.addEventListener('android-shared', loadSharedFiles);
  loadSharedFiles();
}

// ---- rename & pairing ------------------------------------------------------------

$('my-name').addEventListener('click', () => {
  $('name-input').value = me.name;
  showSheet('sheet-name');
  setTimeout(() => $('name-input').focus(), 50);
});
$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim().slice(0, 40);
  closeSheet();
  if (!name || name === me.name) return;
  me.name = name;
  remember('sad.name', name);
  $('my-name').textContent = name;
  link.ws?.close(); // reconnect with the new name
});

const myCode = String(parseInt(me.id.slice(0, 8), 16) % 1000000).padStart(6, '0');
$('my-code').textContent = `${myCode.slice(0, 3)} ${myCode.slice(3)}`;
// Always listen on our own code so a device paired earlier finds us again.
link.joinCode(myCode);

$('pair-btn').addEventListener('click', () => {
  $('code-input').value = '';
  showSheet('sheet-pair');
});
$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code-input').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('Codes have 6 digits');
  const codes = new Set(JSON.parse(stored('sad.codes', () => '[]')));
  codes.add(code);
  remember('sad.codes', JSON.stringify([...codes].slice(-5)));
  link.joinCode(code);
  closeSheet();
  toast('Paired. They’ll appear in a moment');
});
