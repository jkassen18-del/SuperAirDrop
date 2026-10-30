import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer, isPrivate } = require('../server.js');

function client(url, id, name) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    inbox.push(msg);
    for (const w of [...waiters]) w();
  };
  const next = (pred) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      const check = () => {
        const i = inbox.findIndex(pred);
        if (i === -1) return;
        const [m] = inbox.splice(i, 1);
        waiters.splice(waiters.indexOf(check), 1);
        clearTimeout(timer);
        resolve(m);
      };
      waiters.push(check);
      check();
    });
  const ready = new Promise((r) => (ws.onopen = r)).then(() =>
    ws.send(JSON.stringify({ type: 'hello', id, name, device: 'test' })),
  );
  return { ws, next, ready };
}

test('peers discover each other, signal and relay binary', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.address().port}/ws`;

  const a = client(url, 'aaaaaaaaaaaaaaaa', 'Galaxy');
  await a.ready;
  await a.next((m) => m.type === 'welcome');
  const b = client(url, 'bbbbbbbbbbbbbbbb', 'iPhone');
  await b.ready;

  const seen = await a.next((m) => m.type === 'peers' && m.peers.length === 1);
  assert.equal(seen.peers[0].name, 'iPhone');

  a.ws.send(JSON.stringify({ type: 'signal', to: 'bbbbbbbbbbbbbbbb', data: { sdp: 'x' } }));
  const sig = await b.next((m) => m.type === 'signal');
  assert.equal(sig.from, 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(sig.data, { sdp: 'x' });

  const payload = new Uint8Array(200000).map((_, i) => i % 251);
  const frame = new Uint8Array(16 + payload.length);
  frame.set(new TextEncoder().encode('bbbbbbbbbbbbbbbb'));
  frame.set(payload, 16);
  a.ws.send(frame);
  const bin = new Uint8Array(await b.next((m) => m instanceof ArrayBuffer));
  assert.equal(new TextDecoder().decode(bin.subarray(0, 16)), 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(bin.subarray(16), payload);

  b.ws.close();
  await a.next((m) => m.type === 'peers' && m.peers.length === 0);
  a.ws.close();
});

test('classifies private addresses', () => {
  assert.ok(isPrivate('192.168.1.20'));
  assert.ok(isPrivate('10.0.0.5'));
  assert.ok(isPrivate('172.20.1.1'));
  assert.ok(!isPrivate('8.8.8.8'));
  assert.ok(!isPrivate('172.40.1.1'));
});
