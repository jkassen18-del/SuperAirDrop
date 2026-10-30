// End-to-end check with two browsers: `node test/e2e.mjs` (needs Playwright).
// Sends files from a "Samsung" to an "iPhone" over WebRTC, then again with
// WebRTC disabled to exercise the server relay, and checks the bytes.
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createServer } = require('../server.js');

const SAMSUNG_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function run(browser, url, { relay }) {
  const init = relay ? () => { delete window.RTCPeerConnection; } : () => {};
  const open = async (ua) => {
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e));
    await page.goto(url);
    return page;
  };
  const samsung = await open(SAMSUNG_UA);
  const iphone = await open(IPHONE_UA);

  await samsung.locator('.peer', { hasText: 'iPhone' }).waitFor();
  if (!relay) await samsung.locator('.peer', { hasText: 'Direct' }).waitFor({ timeout: 15000 });

  const files = [
    { name: 'holiday.mp4', mimeType: 'video/mp4', buffer: randomBytes(3 * 1024 * 1024 + 17) },
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello iPhone') },
  ];
  const chooser = samsung.waitForEvent('filechooser');
  await samsung.locator('.peer', { hasText: 'iPhone' }).click();
  await (await chooser).setFiles(files);

  await iphone.locator('#offer-dialog[open]').waitFor();
  await iphone.getByRole('button', { name: 'Accept' }).click();
  await samsung.getByText(/Delivered to/).waitFor({ timeout: 60000 });
  await iphone.locator('#inbox .item').nth(1).waitFor();

  const received = await iphone.evaluate(async () => {
    const db = await new Promise((r) => { const o = indexedDB.open('superairdrop'); o.onsuccess = () => r(o.result); });
    const all = await new Promise((r) => { const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => r(q.result); });
    return Promise.all(all.map(async (f) => ({ name: f.name, bytes: Array.from(new Uint8Array(await (f.blob || new Blob([f.buffer])).arrayBuffer())) })));
  });
  for (const f of files) {
    const r = received.find((x) => x.name === f.name);
    assert.ok(r, `missing ${f.name}`);
    assert.equal(sha(Buffer.from(r.bytes)), sha(f.buffer), `${f.name} corrupted`);
  }
  await iphone.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
  await samsung.context().close();
  await iphone.context().close();
  console.log(`ok - ${relay ? 'relay' : 'direct WebRTC'} transfer verified`);
}

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
try {
  await run(browser, url, { relay: false });
  await run(browser, url, { relay: true });
} finally {
  await browser.close();
  server.close();
}
