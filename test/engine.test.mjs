import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TransferEngine, MemoryStorage } from '../public/js/engine.mjs';
import { CHUNK_SIZE, crc32, decodeChunk, encodeChunk } from '../public/js/protocol.mjs';

// Two engines joined by a fake link that can drop, corrupt and disconnect.
function pair({ dropEvery = 0, corruptEvery = 0, cutAfter = 0, receiverStorage = new MemoryStorage() } = {}) {
  const link = { up: true, chunks: 0, engines: {} };
  link.cut = new Promise((r) => (link.onCut = r));
  const deliver = (to, from, msg) => {
    if (!link.up) return;
    setImmediate(() => {
      if (!link.up) return;
      const engine = link.engines[to];
      if (msg instanceof ArrayBuffer) {
        link.chunks++;
        if (cutAfter && link.chunks === cutAfter) {
          // Drop the connection part-way through, as Wi-Fi does.
          link.disconnect();
          link.onCut();
          return;
        }
        if (dropEvery && link.chunks % dropEvery === 0) return;
        let buf = msg;
        if (corruptEvery && link.chunks % corruptEvery === 0) {
          buf = msg.slice(0);
          const bytes = new Uint8Array(buf);
          bytes[bytes.length - 1] ^= 0xff;
        }
        engine.handleBinary(from, buf);
      } else {
        engine.handleMessage(from, structuredClone(msg), from);
      }
    });
  };
  const make = (self, other, storage) =>
    new TransferEngine({ storage, send: (peer, msg) => deliver(other, self, msg) });
  link.engines.a = make('a', 'b', new MemoryStorage());
  link.engines.b = make('b', 'a', receiverStorage);
  link.connect = () => {
    link.up = true;
    link.engines.a.peerConnected('b');
    link.engines.b.peerConnected('a');
  };
  link.disconnect = () => {
    link.up = false;
    link.engines.a.peerDisconnected('b');
    link.engines.b.peerDisconnected('a');
  };
  return link;
}

function makeFiles() {
  return [
    new File([randomBytes(CHUNK_SIZE * 150 + 123)], 'video.mp4', { type: 'video/mp4' }),
    new File([], 'empty.txt', { type: 'text/plain' }),
    new File([randomBytes(5000)], 'photo.heic', { type: 'image/heic' }),
  ];
}

async function bytesOf(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

function waitFor(engine, predicate, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    const off = engine.on('update', (v) => {
      if (predicate(v)) {
        clearTimeout(timer);
        off();
        resolve(v);
      }
    });
  });
}

async function assertReceived(storage, files) {
  const received = await storage.listFiles();
  assert.equal(received.length, files.length);
  for (const f of files) {
    const r = received.find((x) => x.name === f.name);
    assert.ok(r, `missing ${f.name}`);
    assert.equal(r.size, f.size);
    assert.ok((await bytesOf(r.blob)).equals(await bytesOf(f)), `${f.name} differs`);
  }
}

function autoAccept(engine) {
  engine.on('offer', (v) => engine.accept(v.id));
}

test('protocol round-trips chunks and detects corruption', () => {
  const data = randomBytes(1000);
  const frame = encodeChunk('0123456789abcdef', 42, data);
  const chunk = decodeChunk(frame);
  assert.equal(chunk.transferId, '0123456789abcdef');
  assert.equal(chunk.seq, 42);
  assert.ok(chunk.ok);
  assert.ok(Buffer.from(chunk.data).equals(data));
  new Uint8Array(frame)[30] ^= 1;
  assert.equal(decodeChunk(frame).ok, false);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('transfers several files intact', async () => {
  const link = pair();
  link.connect();
  autoAccept(link.engines.b);
  const files = makeFiles();
  link.engines.a.sendFiles('b', files);
  await waitFor(link.engines.a, (v) => v.state === 'done');
  await assertReceived(link.engines.b.storage, files);
});

test('recovers from dropped and corrupted chunks', async () => {
  const link = pair({ dropEvery: 37, corruptEvery: 53 });
  link.connect();
  autoAccept(link.engines.b);
  const files = makeFiles();
  link.engines.a.sendFiles('b', files);
  await waitFor(link.engines.a, (v) => v.state === 'done');
  await assertReceived(link.engines.b.storage, files);
});

test('resumes after the connection drops mid-transfer', async () => {
  const link = pair({ cutAfter: 70 });
  link.connect();
  autoAccept(link.engines.b);
  const files = makeFiles();
  link.engines.a.sendFiles('b', files);
  await link.cut;
  await new Promise((r) => setTimeout(r, 50));
  link.connect();
  await waitFor(link.engines.a, (v) => v.state === 'done');
  await assertReceived(link.engines.b.storage, files);
});

test('receiver page reload keeps partial data and resumes', async () => {
  const storage = new MemoryStorage();
  const link = pair({ receiverStorage: storage, cutAfter: 80 });
  link.connect();
  autoAccept(link.engines.b);
  const files = makeFiles();
  link.engines.a.sendFiles('b', files);
  await link.cut;
  await new Promise((r) => setTimeout(r, 20));

  // Simulate a reload: a brand new engine on the same storage.
  link.engines.b.destroy();
  const fresh = new TransferEngine({
    storage,
    send: (peer, msg) => {
      if (!link.up) return;
      setImmediate(() => {
        if (msg instanceof ArrayBuffer) link.engines.a.handleBinary('b', msg);
        else link.engines.a.handleMessage('b', structuredClone(msg), 'b');
      });
    },
  });
  link.engines.b = fresh;
  await fresh.restore();
  const resumedFrom = [];
  const origSend = fresh.send;
  fresh.send = (peer, msg) => {
    if (msg.t === 'resume') resumedFrom.push(msg.seq);
    return origSend(peer, msg);
  };
  link.connect();
  await waitFor(link.engines.a, (v) => v.state === 'done');
  assert.ok(resumedFrom[0] > 0, `should resume from the middle, not from zero (${resumedFrom})`);
  await assertReceived(storage, files);
});

test('sender waits for an offline peer and offers when it appears', async () => {
  const link = pair();
  link.up = false;
  autoAccept(link.engines.b);
  const files = makeFiles().slice(2);
  const id = link.engines.a.sendFiles('b', files);
  assert.equal(link.engines.a.outgoing.get(id).state, 'waiting');
  link.connect();
  await waitFor(link.engines.a, (v) => v.state === 'done');
  await assertReceived(link.engines.b.storage, files);
});

test('sender finishes even when the final "done" message is lost', async () => {
  const link = pair();
  link.connect();
  autoAccept(link.engines.b);
  const files = makeFiles().slice(2);
  link.engines.b.on('update', (v) => {
    if (v.state === 'done') link.disconnect();
  });
  link.engines.a.sendFiles('b', files);
  await new Promise((r) => setTimeout(r, 100));
  link.connect();
  await waitFor(link.engines.a, (v) => v.state === 'done');
  await assertReceived(link.engines.b.storage, files);
});

test('declining stops the transfer', async () => {
  const link = pair();
  link.connect();
  link.engines.b.on('offer', (v) => link.engines.b.decline(v.id));
  link.engines.a.sendFiles('b', makeFiles());
  await waitFor(link.engines.a, (v) => v.state === 'declined');
  assert.equal((await link.engines.b.storage.listFiles()).length, 0);
});

