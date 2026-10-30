// Transfer engine: the part that makes sure files arrive complete.
//
// It knows nothing about WebRTC, WebSockets or the DOM. It is given a
// `send(peerId, message)` function (message is a plain object or an
// ArrayBuffer chunk) and a storage backend, and is fed whatever arrives from
// peers. Guarantees:
//
//  * every chunk carries a CRC-32; corrupted chunks are dropped and re-requested
//  * the receiver only acknowledges a chunk after it has been written to
//    storage, so an acknowledged byte survives a crash or reload
//  * the receiver always tells the sender where to continue ("resume"), so a
//    dropped connection, a transport switch or a reload continues where it
//    stopped instead of starting over or silently skipping data
//  * a file is only handed to the user after its size is checked against the
//    size the sender announced

import { CHUNK_SIZE, decodeChunk, encodeChunk, layout, locate, randomId } from './protocol.mjs';

export const WINDOW = 32; // chunks in flight (2 MiB)
const STALL_MS = 15000;
const RESUME_THROTTLE_MS = 1000;

export class TransferEngine {
  constructor({ send, storage, now = () => Date.now() }) {
    this.send = send;
    this.storage = storage;
    this.now = now;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.connected = new Set();
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
      if (meta.state === 'done') continue;
      const t = { ...meta, dir: 'in', ...layout(meta.files), queue: Promise.resolve(), lastResume: 0 };
      this.incoming.set(t.id, t);
      this.emit('update', this.view(t, 'in'));
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
    this.emit('update', this.view(t, 'out'));
    return id;
  }

  async pump(t) {
    if (t.pumping) return;
    t.pumping = true;
    try {
      while (t.state === 'sending' && t.next < t.total && t.next - t.acked < WINDOW) {
        if (!this.connected.has(t.peerId)) break;
        const seq = t.next++;
        const loc = locate(t.ranges, seq);
        const file = t.files[loc.fileIndex];
        const from = loc.chunkIndex * CHUNK_SIZE;
        const data = await file.slice(from, Math.min(from + CHUNK_SIZE, file.size)).arrayBuffer();
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
    this.emit('update', this.view(t, 'in'));
  }

  decline(id) {
    const t = this.incoming.get(id);
    if (!t) return;
    t.state = 'declined';
    this.send(t.peerId, { t: 'answer', id, accept: false });
    this.incoming.delete(id);
    this.emit('update', this.view(t, 'in'));
  }

  cancel(id) {
    const t = this.outgoing.get(id) || this.incoming.get(id);
    if (!t) return;
    t.state = 'cancelled';
    this.send(t.peerId, { t: 'cancel', id });
    this.finishIncoming(t);
    this.outgoing.delete(id);
    this.emit('update', this.view(t, t.dir || 'in'));
  }

  requestResume(t, force = false) {
    const now = this.now();
    if (!force && now - t.lastResume < RESUME_THROTTLE_MS) return;
    t.lastResume = now;
    this.send(t.peerId, { t: 'resume', id: t.id, seq: t.expected });
  }

  async onChunk(t, chunk) {
    if (t.state !== 'receiving') return;
    if (chunk.seq < t.expected) return; // duplicate after a resume
    if (chunk.seq > t.expected || !chunk.ok) {
      // A gap (lost data after a reconnect) or a corrupted chunk: ask again.
      this.requestResume(t);
      return;
    }
    await this.storage.putChunk(t.id, chunk.seq, chunk.data);
    t.expected = chunk.seq + 1;
    t.lastResume = 0;
    const loc = locate(t.ranges, chunk.seq);
    const range = t.ranges[loc.fileIndex];
    if (t.expected === range.end) {
      const saved = await this.assemble(t, loc.fileIndex);
      if (!saved) return;
    }
    await this.persist(t);
    this.send(t.peerId, { t: 'ack', id: t.id, seq: t.expected });
    this.emit('update', this.view(t, 'in'));
    if (t.expected === t.total) {
      t.state = 'done';
      this.send(t.peerId, { t: 'done', id: t.id });
      await this.finishIncoming(t);
      this.emit('update', this.view(t, 'in'));
    }
  }

  async assemble(t, fileIndex) {
    const meta = t.files[fileIndex];
    const range = t.ranges[fileIndex];
    const parts = [];
    for (let seq = range.start; seq < range.end; seq++) {
      const part = await this.storage.getChunk(t.id, seq);
      if (part == null) break;
      parts.push(part);
    }
    const blob = new Blob(parts, { type: meta.type });
    if (parts.length !== range.count || blob.size !== meta.size) {
      // Storage lost something: fetch the whole file again.
      t.expected = range.start;
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
    await this.storage.deleteChunks(t.id, range.start, range.end);
    this.emit('file', record);
    return true;
  }

  persist(t) {
    const { id, peerId, peerName, files, expected, state, createdAt } = t;
    return this.storage.putTransfer({ id, peerId, peerName, files, expected, state, createdAt });
  }

  async finishIncoming(t) {
    if (t.dir === 'out') return;
    this.incoming.delete(t.id);
    await this.storage.deleteChunks(t.id, 0, t.total);
    await this.storage.deleteTransfer(t.id);
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
      this.emit('update', this.view(t, 'out'));
    }
    for (const t of this.incoming.values()) {
      if (t.peerId === peerId && t.state === 'receiving') this.requestResume(t, true);
    }
  }

  peerDisconnected(peerId) {
    this.connected.delete(peerId);
    for (const t of this.outgoing.values()) {
      if (t.peerId === peerId) this.emit('update', this.view(t, 'out'));
    }
    for (const t of this.incoming.values()) {
      if (t.peerId === peerId) this.emit('update', this.view(t, 'in'));
    }
  }

  handleBinary(peerId, buf) {
    const chunk = decodeChunk(buf);
    if (!chunk) return;
    const t = this.incoming.get(chunk.transferId);
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
          createdAt: this.now(),
          queue: Promise.resolve(),
          lastResume: 0,
        };
        this.incoming.set(t.id, t);
        this.emit('offer', this.view(t, 'in'));
        this.emit('update', this.view(t, 'in'));
        return;
      }
      case 'answer':
        if (!out || out.peerId !== peerId) return;
        if (!msg.accept) {
          out.state = 'declined';
          this.outgoing.delete(out.id);
        }
        this.emit('update', this.view(out, 'out'));
        return;
      case 'resume': {
        if (!out || out.peerId !== peerId || out.state === 'done') return;
        const seq = Math.max(0, Math.min(out.total, msg.seq | 0));
        out.state = 'sending';
        out.next = seq;
        out.acked = seq;
        out.lastAck = this.now();
        this.emit('update', this.view(out, 'out'));
        this.pump(out);
        return;
      }
      case 'ack':
        if (!out || out.peerId !== peerId) return;
        if (msg.seq > out.acked) {
          out.acked = Math.min(out.total, msg.seq);
          out.lastAck = this.now();
          this.emit('update', this.view(out, 'out'));
        }
        this.pump(out);
        return;
      case 'done':
        if (!out || out.peerId !== peerId) return;
        out.state = 'done';
        out.acked = out.total;
        this.outgoing.delete(out.id);
        this.emit('update', this.view(out, 'out'));
        return;
      case 'cancel': {
        const t = out || inc;
        if (!t || t.peerId !== peerId) return;
        t.state = 'cancelled';
        this.outgoing.delete(t.id);
        this.finishIncoming(t);
        this.emit('update', this.view(t, t.dir));
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
    return {
      id: t.id,
      dir,
      peerId: t.peerId,
      peerName: t.peerName,
      files,
      bytes,
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
  async putChunk(id, seq, data) { this.chunks.set(`${id}:${seq}`, new Blob([data])); }
  async getChunk(id, seq) { return this.chunks.get(`${id}:${seq}`) ?? null; }
  async deleteChunks(id, from, to) { for (let s = from; s < to; s++) this.chunks.delete(`${id}:${s}`); }
  async saveFile(record) { this.files.set(record.id, record); }
  async listFiles() { return [...this.files.values()].sort((a, b) => b.receivedAt - a.receivedAt); }
  async deleteFile(id) { this.files.delete(id); }
}
