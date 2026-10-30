// IndexedDB storage for the transfer engine. Received chunks and finished
// files live here, so a reload, a crash or iOS killing the tab does not lose
// what already arrived. Finished files stay in the inbox until the user deletes
// them.

import { MemoryStorage } from './engine.mjs';

const DB_NAME = 'superairdrop';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IDBStorage {
  constructor(db) {
    this.db = db;
  }

  static async open() {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('transfers', { keyPath: 'id' });
      db.createObjectStore('chunks');
      db.createObjectStore('files', { keyPath: 'id' });
    };
    const storage = new IDBStorage(await req(open));
    // Some older Safari versions cannot store Blobs; fall back to ArrayBuffers.
    try {
      await storage.store('chunks', 'readwrite', (s) => s.put(new Blob(['x']), '__probe'));
      storage.blobs = true;
    } catch {
      storage.blobs = false;
    }
    return storage;
  }

  store(name, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, mode);
      let result;
      const r = fn(tx.objectStore(name));
      if (r) r.onsuccess = () => (result = r.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage aborted (disk full?)'));
    });
  }

  putTransfer(meta) { return this.store('transfers', 'readwrite', (s) => s.put(meta)); }
  getTransfers() { return this.store('transfers', 'readonly', (s) => s.getAll()); }
  deleteTransfer(id) { return this.store('transfers', 'readwrite', (s) => s.delete(id)); }

  putChunk(id, seq, data) {
    const value = this.blobs ? new Blob([data]) : data.slice().buffer;
    return this.store('chunks', 'readwrite', (s) => s.put(value, `${id}:${seq}`));
  }

  async getChunk(id, seq) {
    const v = await this.store('chunks', 'readonly', (s) => s.get(`${id}:${seq}`));
    if (v == null) return null;
    return v instanceof Blob ? v : new Blob([v]);
  }

  deleteChunks(id, from, to) {
    return this.store('chunks', 'readwrite', (s) => {
      for (let seq = from; seq < to; seq++) s.delete(`${id}:${seq}`);
    });
  }

  async saveFile(record) {
    if (this.blobs) return this.store('files', 'readwrite', (s) => s.put(record));
    const buffer = await record.blob.arrayBuffer();
    return this.store('files', 'readwrite', (s) => s.put({ ...record, blob: undefined, buffer }));
  }

  async listFiles() {
    const all = await this.store('files', 'readonly', (s) => s.getAll());
    return all
      .map((r) => (r.blob ? r : { ...r, blob: new Blob([r.buffer], { type: r.type }) }))
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  deleteFile(id) { return this.store('files', 'readwrite', (s) => s.delete(id)); }
}

export async function openStorage() {
  try {
    if (!globalThis.indexedDB) throw new Error('no IndexedDB');
    const storage = await IDBStorage.open();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    return { storage, persistent: true };
  } catch {
    return { storage: new MemoryStorage(), persistent: false };
  }
}
