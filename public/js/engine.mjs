// Transfer engine: the part that makes sure files arrive complete.
//
// It knows nothing about WebRTC, WebSockets or the DOM. It is given a
// `send(peerId, message)` function (message is a plain object or an
// ArrayBuffer chunk) and a storage backend, and is fed whatever arrives from
// peers. Guarantees:
//
//  * every chunk carries a CRC-32; corrupted chunks are dropped and re-requested
//  * the receiver only acknowledges chunks after they have been written to
//    storage (in batches, for speed), so an acknowledged byte survives a
//    crash or reload
//  * the receiver always tells the sender where to continue ("resume"), so a
//    dropped connection, a transport switch or a reload continues where it
//    stopped instead of starting over or silently skipping data
//  * a file is only handed to the user after its size is checked against the
//    size the sender announced

import { CHUNK_SIZE, decodeChunk, encodeChunk, layout, locate, randomId } from './protocol.mjs';

export const WINDOW = 128; // chunks in flight (8 MiB)
export const BATCH = 32; // chunks written to storage at once (2 MiB)
const FLUSH_MS = 200;
const READ_AHEAD = 16 * CHUNK_SIZE;
const STALL_MS = 15000;
const RESUME_THROTTLE_MS = 1000;
const UPDATE_MS = 120;

export class TransferEngine {
  constructor({ send, storage, now = () => Date.now() }) {
    this.send = send;
    this.storage = storage;
    this.now = now;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.connected = new Set();
    this.finished = new Map(); // transfer id -> peer id, to repeat a lost 'done'
    this.listeners = new Map();
    this.stallTimer = setInterval(() => this.checkStalls(), 2000);
    if (this.stallTimer.unref) this.stallTimer.unref();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) fn(payload);
  }

  destroy() {
    clearInterval(this.stallTimer);
  }

  // Reload incoming transfers that were interrupted by a page reload.
  async restore() {
    for (const meta of await this.storage.getTransfers()) {
      if (meta.state === 'done') {
        this.finished.set(meta.id, meta.peerId);
        continue;
      }
      const t = { ...meta, dir: 'in', ...layout(meta.files), queue: Promise.resolve(), lastResume: 0 };
      t.next = t.expected;
      t.pending = [];
      this.incoming.set(t.id, t);
      this.notify(t, true);
      if (this.connected.has(t.peerId)) this.requestResume(t, true);
    }
  }

  // ---- sending -----------------------------------------------------------

  sendFiles(peerId, files) {
    const id = randomId();
    const meta = Array.from(files, (f) => ({
      name: f.name || 'file',
      size: f.size,
      type: f.type || 'application/octet-stream',
    }));
    const t = {
      id,
      peerId,
      dir: 'out',
      files: Array.from(files),
      meta,
      ...layout(meta),
      state: 'offered',
      next: 0,
      acked: 0,
      lastAck: this.now(),
      pumping: false,
    };
    this.outgoing.set(id, t);
    if (this.connected.has(peerId)) this.send(peerId, { t: 'offer', id, files: meta });
    else t.state = 'waiting';
    this.notify(t, true);
    return id;
  }

  // Progress updates are throttled; state changes always go out.
  notify(t, force = false) {
    const now = this.now();
    const view = this.view(t, t.dir);
    if (!force && t.lastState === view.state && now - (t.lastEmit || 0) < UPDATE_MS) {
      if (!t.emitTimer) {
        t.emitTimer = setTimeout(() => {
          t.emitTimer = null;
          this.notify(t, true);
        }, UPDATE_MS - (now - t.lastEmit));
      }
      return;
    }
    clearTimeout(t.emitTimer);
    t.emitTimer = null;
    // Smoothed speed in bytes per second.
    if (t.rateAt && now - t.rateAt >= 400) {
      const sample = ((view.bytesDone - t.rateBytes) * 1000) / (now - t.rateAt);
      t.rate = t.rate ? t.rate * 0.6 + sample * 0.4 : sample;
      t.rateAt = now;
      t.rateBytes = view.bytesDone;
    } else if (!t.rateAt && (view.state === 'sending' || view.state === 'receiving')) {
      t.rateAt = now;
      t.rateBytes = view.bytesDone;
    }
    view.rate = Math.max(0, t.rate || 0);
    t.lastEmit = now;
    t.lastState = view.state;
    this.emit('update', view);
  }

  async readChunk(t, seq) {
    const loc = locate(t.ranges, seq);
    const file = t.files[loc.fileIndex];
    const from = loc.chunkIndex * CHUNK_SIZE;
    const c = t.cache;
    if (!c || c.fileIndex !== loc.fileIndex || from < c.from || from >= c.from + c.buf.byteLength) {
      const buf = await file.slice(from, Math.min(from + READ_AHEAD, file.size)).arrayBuffer();
      t.cache = { fileIndex: loc.fileIndex, from, buf };
    }
    const off = from - t.cache.from;
    return new Uint8Array(t.cache.buf, off, Math.min(CHUNK_SIZE, t.cache.buf.byteLength - off));
  }

  async pump(t) {
    if (t.pumping) return;
    t.pumping = true;
    try {
      while (t.state === 'sending' && t.next < t.total && t.next - t.acked < WINDOW) {
        if (!this.connected.has(t.peerId)) break;
        const seq = t.next++;
        const data = await this.readChunk(t, seq);
        if (t.state !== 'sending') break;
        await this.send(t.peerId, encodeChunk(t.id, seq, data));
      }
    } catch (err) {
      this.emit('error', { id: t.id, error: err });
    } finally {
      t.pumping = false;
    }
  }

  // ---- receiving ---------------------------------------------------------

  accept(id) {
    const t = this.incoming.get(id);
    if (!t || t.state !== 'pending') return;
    t.state = 'receiving';
    t.queue = t.queue.then(() => this.persist(t));
    this.requestResume(t, true);
    this.notify(t, true);
  }

  decline(id) {
    const t = this.incoming.get(id);
    if (!t) return;
    t.state = 'declined';
    this.send(t.peerId, { t: 'answer', id, accept: false });
    this.incoming.delete(id);
    this.notify(t, true);
  }

  cancel(id) {
    const t = this.outgoing.get(id) || this.incoming.get(id);
    if (!t) return;
    t.state = 'cancelled';
    this.send(t.peerId, { t: 'cancel', id });
    this.finishIncoming(t);
    this.outgoing.delete(id);
    this.notify(t, true);
  }

  requestResume(t, force = false) {
    const now = this.now();
    if (!force && now - t.lastResume < RESUME_THROTTLE_MS) return;
    t.lastResume = now;
    this.send(t.peerId, { t: 'resume', id: t.id, seq: t.next });
  }

  // Chunks are collected in memory (t.next counts them) and written to
  // storage in batches (t.expected counts what is safely stored). Only stored
  // chunks are acknowledged.
  async onChunk(t, chunk) {
    if (t.state !== 'receiving') return;
    if (chunk.seq < t.next) return; // duplicate after a resume
    if (chunk.seq > t.next || !chunk.ok) {
      // A gap (lost data after a reconnect) or a corrupted chunk: ask again.
      this.requestResume(t);
      return;
    }
    t.pending.push(chunk.data);
    t.next = chunk.seq + 1;
    t.lastResume = 0;
    const range = t.ranges[locate(t.ranges, chunk.seq).fileIndex];
    if (t.pending.length >= BATCH || t.next === range.end) {
      await this.flush(t);
    } else if (!t.flushTimer) {
      t.flushTimer = setTimeout(() => {
        t.flushTimer = null;
        t.queue = t.queue.then(() => this.flush(t)).catch((error) => this.emit('error', { id: t.id, error }));
      }, FLUSH_MS);
    }
  }

  async flush(t) {
    clearTimeout(t.flushTimer);
    t.flushTimer = null;
    if (!t.pending.length || t.state !== 'receiving') return;
    const start = t.expected;
    const parts = t.pending;
    t.pending = [];
    try {
      await this.storage.putBatch(t.id, start, parts.length, new Blob(parts));
    } catch (err) {
      // Not stored, so not acknowledged: ask for it again.
      t.next = t.expected;
      throw err;
    }
    t.expected = start + parts.length;
    const loc = locate(t.ranges, t.expected - 1);
    const range = t.ranges[loc.fileIndex];
    if (t.expected === range.end) {
      const saved = await this.assemble(t, loc.fileIndex);
      if (!saved) return;
    }
    await this.persist(t);
    this.send(t.peerId, { t: 'ack', id: t.id, seq: t.expected });
    this.notify(t);
    if (t.expected === t.total) {
      t.state = 'done';
      this.send(t.peerId, { t: 'done', id: t.id });
      await this.finishIncoming(t);
      this.notify(t, true);
    }
  }

  async assemble(t, fileIndex) {
    const meta = t.files[fileIndex];
    const range = t.ranges[fileIndex];
    const parts = [];
    const starts = [];
    let seq = range.start;
    while (seq < range.end) {
      const batch = await this.storage.getBatch(t.id, seq);
      if (!batch || batch.count < 1) break;
      parts.push(batch.blob);
      starts.push(seq);
      seq += batch.count;
    }
    const blob = new Blob(parts, { type: meta.type });
    if (seq !== range.end || blob.size !== meta.size) {
      // Storage lost something: fetch the whole file again.
      await this.storage.deleteBatches(t.id, starts);
      t.expected = range.start;
      t.next = range.start;
      t.pending = [];
      await this.persist(t);
      this.requestResume(t, true);
      this.emit('error', { id: t.id, error: new Error(`Verification failed for ${meta.name}, re-downloading`) });
      return false;
    }
    const record = {
      id: `${t.id}-${fileIndex}`,
      name: meta.name,
      type: meta.type,
      size: meta.size,
      from: t.peerName || t.peerId,
      receivedAt: this.now(),
      blob,
    };
    await this.storage.saveFile(record);
    await this.storage.deleteBatches(t.id, starts);
    this.emit('file', record);
    return true;
  }

  persist(t) {
    const { id, peerId, peerName, files, expected, state, createdAt } = t;
    return this.storage.putTransfer({ id, peerId, peerName, files, expected, state, createdAt });
  }

  async finishIncoming(t) {
    if (t.dir === 'out') return;
    clearTimeout(t.flushTimer);
    this.incoming.delete(t.id);
    await this.storage.deleteTransferData(t.id);
    if (t.state === 'done') {
      this.finished.set(t.id, t.peerId);
      await this.storage.putTransfer({ id: t.id, peerId: t.peerId, state: 'done', files: [], finishedAt: this.now() });
    } else {
      await this.storage.deleteTransfer(t.id);
    }
  }

  // ---- input from the link layer -------------------------------------------

  peerConnected(peerId) {
    this.connected.add(peerId);
    for (const t of this.outgoing.values()) {
      if (t.peerId !== peerId) continue;
      if (t.state === 'waiting' || t.state === 'offered') {
        t.state = 'offered';
        this.send(peerId, { t: 'offer', id: t.id, files: t.meta });
      }
      this.notify(t, true);
    }
    for (const t of this.incoming.values()) {
      if (t.peerId === peerId && t.state === 'receiving') this.requestResume(t, true);
    }
    for (const [id, from] of this.finished) if (from === peerId) this.send(peerId, { t: 'done', id });
  }

  peerDisconnected(peerId) {
    this.connected.delete(peerId);
    for (const t of this.outgoing.values()) {
      if (t.peerId === peerId) this.notify(t, true);
    }
    for (const t of this.incoming.values()) {
      if (t.peerId !== peerId) continue;
      // Anything not yet stored will be sent again after the reconnect.
      if (t.state === 'receiving') t.queue = t.queue.then(() => this.flush(t)).catch(() => {});
      this.notify(t, true);
    }
  }

  handleBinary(peerId, buf) {
    const chunk = decodeChunk(buf);
    if (!chunk) return;
    const t = this.incoming.get(chunk.transferId);
    if (!t && this.finished.get(chunk.transferId) === peerId) {
      // The sender missed our 'done'; tell it again (at most once a second).
      const now = this.now();
      if (now - (this.lastDoneRepeat || 0) > 1000) {
        this.lastDoneRepeat = now;
        this.send(peerId, { t: 'done', id: chunk.transferId });
      }
      return;
    }
    if (!t || t.peerId !== peerId) return;
    // Chunks are processed strictly one after another.
    t.queue = t.queue.then(() => this.onChunk(t, chunk)).catch((error) => {
      this.emit('error', { id: t.id, error });
      this.requestResume(t, true);
    });
  }

  handleMessage(peerId, msg, peerName) {
    const out = this.outgoing.get(msg.id);
    const inc = this.incoming.get(msg.id);
    switch (msg.t) {
      case 'offer': {
        if (this.finished.get(msg.id) === peerId) {
          this.send(peerId, { t: 'done', id: msg.id });
          return;
        }
        if (inc) {
          // The sender re-offered after a reconnect; tell it how far we are.
          if (inc.state === 'receiving') this.requestResume(inc, true);
          return;
        }
        if (!Array.isArray(msg.files) || msg.files.length === 0) return;
        const files = msg.files.map((f) => ({
          name: String(f.name).slice(0, 255),
          size: Math.max(0, Number(f.size) || 0),
          type: String(f.type || 'application/octet-stream'),
        }));
        const t = {
          id: msg.id,
          peerId,
          peerName,
          dir: 'in',
          files,
          ...layout(files),
          state: 'pending',
          expected: 0,
          next: 0,
          pending: [],
          createdAt: this.now(),
          queue: Promise.resolve(),
          lastResume: 0,
        };
        this.incoming.set(t.id, t);
        this.emit('offer', this.view(t, 'in'));
        this.notify(t, true);
        return;
      }
      case 'answer':
        if (!out || out.peerId !== peerId) return;
        if (!msg.accept) {
          out.state = 'declined';
          this.outgoing.delete(out.id);
        }
        this.notify(out, true);
        return;
      case 'resume': {
        if (!out || out.peerId !== peerId || out.state === 'done') return;
        const seq = Math.max(0, Math.min(out.total, msg.seq | 0));
        out.state = 'sending';
        out.next = seq;
        out.acked = seq;
        out.lastAck = this.now();
        this.notify(out, true);
        this.pump(out);
        return;
      }
      case 'ack':
        if (!out || out.peerId !== peerId) return;
        if (msg.seq > out.acked) {
          out.acked = Math.min(out.total, msg.seq);
          out.lastAck = this.now();
          this.notify(out);
        }
        this.pump(out);
        return;
      case 'done':
        if (!out || out.peerId !== peerId) return;
        out.state = 'done';
        out.acked = out.total;
        out.cache = null;
        this.outgoing.delete(out.id);
        this.notify(out, true);
        return;
      case 'cancel': {
        const t = out || inc;
        if (!t || t.peerId !== peerId) return;
        t.state = 'cancelled';
        this.outgoing.delete(t.id);
        this.finishIncoming(t);
        this.notify(t, true);
        return;
      }
    }
  }

  // If acknowledgements stop while the peer still looks connected, start over
  // from the last acknowledged chunk.
  checkStalls() {
    const now = this.now();
    for (const t of this.outgoing.values()) {
      if (t.state !== 'sending' || !this.connected.has(t.peerId)) continue;
      if (t.acked < t.total && now - t.lastAck > STALL_MS) {
        t.next = t.acked;
        t.lastAck = now;
        this.pump(t);
      }
    }
    for (const t of this.incoming.values()) {
      if (t.state === 'receiving' && this.connected.has(t.peerId)) this.requestResume(t);
    }
  }

  view(t, dir) {
    const done = dir === 'out' ? t.acked ?? 0 : t.expected ?? 0;
    const files = dir === 'out' ? t.meta : t.files;
    const bytes = files.reduce((n, f) => n + f.size, 0);
    let bytesDone = 0;
    for (let i = 0; i < t.ranges.length; i++) {
      const r = t.ranges[i];
      if (done >= r.end) bytesDone += files[i].size;
      else if (done > r.start) bytesDone += Math.min(files[i].size, (done - r.start) * CHUNK_SIZE);
    }
    return {
      id: t.id,
      dir,
      peerId: t.peerId,
      peerName: t.peerName,
      files,
      bytes,
      bytesDone,
      state: t.state,
      online: this.connected.has(t.peerId),
      progress: t.total ? Math.min(1, done / t.total) : 0,
    };
  }
}

// In-memory storage, used by the tests and as a fallback when IndexedDB is not
// available (for example in some private browsing modes).
export class MemoryStorage {
  constructor() {
    this.transfers = new Map();
    this.chunks = new Map();
    this.files = new Map();
  }
  async putTransfer(meta) { this.transfers.set(meta.id, structuredClone(meta)); }
  async getTransfers() { return [...this.transfers.values()].map((m) => structuredClone(m)); }
  async deleteTransfer(id) { this.transfers.delete(id); }
  async putBatch(id, start, count, blob) { this.chunks.set(`${id}:${start}`, { count, blob }); }
  async getBatch(id, start) { return this.chunks.get(`${id}:${start}`) ?? null; }
  async deleteBatches(id, starts) { for (const s of starts) this.chunks.delete(`${id}:${s}`); }
  async deleteTransferData(id) { for (const k of [...this.chunks.keys()]) if (k.startsWith(`${id}:`)) this.chunks.delete(k); }
  async saveFile(record) { this.files.set(record.id, record); }
  async listFiles() { return [...this.files.values()].sort((a, b) => b.receivedAt - a.receivedAt); }
  async deleteFile(id) { this.files.delete(id); }
}
