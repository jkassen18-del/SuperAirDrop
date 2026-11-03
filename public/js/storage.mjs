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
    const open = indexedDB.open(DB_NAME, 2);
    open.onupgradeneeded = (e) => {
      const db = open.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('transfers', { keyPath: 'id' });
        db.createObjectStore('chunks');
        db.createObjectStore('files', { keyPath: 'id' });
      } else {
        // v2 stores chunks in batches; unfinished v1 transfers cannot resume.
        open.transaction.objectStore('chunks').clear();
        open.transaction.objectStore('transfers').clear();
      }
    };
    const storage = new IDBStorage(await req(open));
    // Some older Safari versions cannot store Blobs; fall back to ArrayBuffers.
    try {
      await storage.store('chunks', 'readwrite', (s) => s.put({ count: 0, value: new Blob(['x']) }, '__probe'));
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

  async putBatch(id, start, count, blob) {
    const value = this.blobs ? blob : await blob.arrayBuffer();
    return this.store('chunks', 'readwrite', (s) => s.put({ count, value }, `${id}:${start}`));
  }

  async getBatch(id, start) {
    const v = await this.store('chunks', 'readonly', (s) => s.get(`${id}:${start}`));
    if (v == null) return null;
    return { count: v.count, blob: v.value instanceof Blob ? v.value : new Blob([v.value]) };
  }

  deleteBatches(id, starts) {
    return this.store('chunks', 'readwrite', (s) => {
      for (const start of starts) s.delete(`${id}:${start}`);
    });
  }

  // ';' sorts right after ':', so this range is exactly this transfer's keys.
  deleteTransferData(id) {
    return this.store('chunks', 'readwrite', (s) => {
      s.delete(IDBKeyRange.bound(`${id}:`, `${id};`, false, true));
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
