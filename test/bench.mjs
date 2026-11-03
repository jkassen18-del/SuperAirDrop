// Transfer speed benchmark: `node test/bench.mjs [MB]` (needs Playwright).
// Sends one file between two headless browsers, over direct WebRTC and over
// the server relay, and prints the throughput.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createServer } = require('../server.js');

const MB = Number(process.argv[2]) || 50;

async function bench(browser, url, relay) {
  const open = async (ua) => {
    const ctx = await browser.newContext({ userAgent: ua });
    if (relay) await ctx.addInitScript(() => { delete window.RTCPeerConnection; });
    const page = await ctx.newPage();
    await page.goto(url);
    return page;
  };
  const a = await open('Mozilla/5.0 (Linux; Android 14; SM-S921B) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36');
  const b = await open('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1');
  const peer = a.locator('[data-peer]', { hasText: 'iPhone' }).or(a.locator('.peer', { hasText: 'iPhone' })).first();
  await peer.waitFor();
  if (!relay) await a.waitForFunction(() => document.body.innerText.includes('Direct') || document.querySelector('[data-direct="true"]'), null, { timeout: 15000 }).catch(() => {});
  const chooser = a.waitForEvent('filechooser');
  await peer.click();
  const sheetOption = a.getByRole('button', { name: /Files/ });
  const fc = await Promise.race([chooser, sheetOption.waitFor({ timeout: 1500 }).then(() => null).catch(() => null)]);
  const finalChooser = fc || (await (async () => { const c = a.waitForEvent('filechooser'); await sheetOption.click(); return c; })());
  const file = join(mkdtempSync(join(tmpdir(), 'sad-')), 'big.bin');
  writeFileSync(file, randomBytes(MB * 1024 * 1024));
  await finalChooser.setFiles(file);
  await b.getByRole('button', { name: 'Accept' }).click();
  const start = Date.now();
  await a.getByText(/Delivered/).first().waitFor({ timeout: 300000 });
  const s = (Date.now() - start) / 1000;
  console.log(`${relay ? 'relay ' : 'direct'}: ${MB} MB in ${s.toFixed(1)} s = ${(MB / s).toFixed(1)} MB/s`);
  await a.context().close();
  await b.context().close();
}

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
try {
  await bench(browser, url, false);
  await bench(browser, url, true);
} finally {
  await browser.close();
  server.close();
}
