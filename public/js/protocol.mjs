// Wire format shared by the browser app, the server tests and the engine.
//
// Every file in a transfer is cut into CHUNK_SIZE pieces and the pieces of all
// files are numbered with one running sequence number ("seq"). A binary chunk
// frame looks like:
//
//   byte 0      MAGIC (0x53)
//   bytes 1-16  transfer id (16 ASCII hex chars)
//   bytes 17-20 seq (uint32, big endian)
//   bytes 21-24 CRC-32 of the payload (uint32, big endian)
//   bytes 25-   payload

export const CHUNK_SIZE = 64 * 1024;
export const ID_LENGTH = 16;
export const HEADER_SIZE = 1 + ID_LENGTH + 4 + 4;
const MAGIC = 0x53;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, prev = 0) {
  let crc = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function randomId() {
  const bytes = new Uint8Array(ID_LENGTH / 2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Number of chunks a file occupies. Empty files still take one (empty) chunk so
// that they are acknowledged like every other file.
export function chunkCount(size) {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

// Builds the seq layout of a transfer: where each file starts and how many
// chunks it has.
export function layout(files) {
  const ranges = [];
  let start = 0;
  for (const f of files) {
    const count = chunkCount(f.size);
    ranges.push({ start, count, end: start + count });
    start += count;
  }
  return { ranges, total: start };
}

export function locate(ranges, seq) {
  for (let i = 0; i < ranges.length; i++) {
    if (seq >= ranges[i].start && seq < ranges[i].end) {
      return { fileIndex: i, chunkIndex: seq - ranges[i].start };
    }
  }
  return null;
}

export function encodeChunk(transferId, seq, data) {
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
  const buf = new ArrayBuffer(HEADER_SIZE + payload.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint8(0, MAGIC);
  for (let i = 0; i < ID_LENGTH; i++) bytes[1 + i] = transferId.charCodeAt(i);
  view.setUint32(1 + ID_LENGTH, seq);
  view.setUint32(5 + ID_LENGTH, crc32(payload));
  bytes.set(payload, HEADER_SIZE);
  return buf;
}

// Returns null for frames that are not chunks. `ok` is false when the payload
// does not match its checksum.
export function decodeChunk(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < HEADER_SIZE || bytes[0] !== MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let transferId = '';
  for (let i = 0; i < ID_LENGTH; i++) transferId += String.fromCharCode(bytes[1 + i]);
  const seq = view.getUint32(1 + ID_LENGTH);
  const crc = view.getUint32(5 + ID_LENGTH);
  const data = bytes.slice(HEADER_SIZE);
  return { transferId, seq, crc, data, ok: crc32(data) === crc };
}
