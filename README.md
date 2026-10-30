# SuperAirDrop

AirDrop-style file sharing between **Samsung / Android phones and iPhones**, built so files are **never silently lost**. It runs in the phone's browser (Samsung Internet, Chrome, Safari) — nothing to install on either phone.

## Can a Samsung just use real AirDrop?

Research findings (October 2026):

| Option | Works with | Notes |
| --- | --- | --- |
| **Quick Share → "Share with Apple Devices"** | Galaxy S26 / S26+ / S26 Ultra only (March 2026 update) | Real AirDrop interop. Settings › Connected devices › Quick Share › Share with Apple devices. iPhone must be set to AirDrop "Everyone for 10 minutes". Other Galaxy models: not announced yet. ([SamMobile](https://www.sammobile.com/news/how-to-share-files-galaxy-phone-iphone-ipad-macbook/), [heise](https://heise.de/-11220599)) |
| Google Pixel 10 Quick Share | Pixel 10 series | Google shipped the first Android↔AirDrop interop in Nov 2025. |
| [PairDrop](https://github.com/schlagmichdoch/pairdrop) / Snapdrop | Any browser | Open-source WebRTC file sharing — the approach this project follows. |
| OpenDrop (AWDL reimplementation) | Linux/macOS with special Wi-Fi chips | Not usable from a phone. |

If you own a Galaxy S26, try the built-in option first. For **every other Samsung**, SuperAirDrop gives you the same tap-a-device experience.

## The APK (easiest)

1. On the Samsung, download **[SuperAirDrop.apk](https://github.com/jkassen18-del/SuperAirDrop/releases/download/apk-latest/SuperAirDrop.apk)** and open it. Allow "Install unknown apps" for your browser when asked.
2. Open SuperAirDrop. It shows a **QR code**.
3. On the iPhone, point the **Camera** at the QR code and tap the link. Safari opens; nothing to install on the iPhone.
4. Tap the other phone's bubble to send. Or, on the Samsung, use **Share → SuperAirDrop** from Gallery, My Files, etc., then tap the iPhone.

Both phones must be on the same Wi-Fi, **or** turn on the Samsung's hotspot and connect the iPhone to it (works with no router or internet). Files the Samsung receives go to `Downloads/SuperAirDrop`. On the iPhone, tap **Download** on a received file, then save it from the Downloads list in Safari / the Files app.

The APK is built by GitHub Actions on every push (`.github/workflows/android.yml`) and runs the whole server on the Samsung (`android/`, a Java port of `server.js`) with the same web app bundled inside.

## What it does to avoid losing files

- **Checksummed chunks** — every 64 KB piece carries a CRC-32; corrupted pieces are thrown away and re-requested.
- **Saved before acknowledged** — the receiver writes each piece to on-device storage (IndexedDB) *before* telling the sender it arrived.
- **Automatic resume** — Wi-Fi drops, the phone sleeps, the page reloads, or the route switches between direct and relay: the transfer continues from the last saved piece instead of starting over or skipping data.
- **Size verification** — a file appears in "Received files" only after its assembled size matches what the sender announced.
- **Inbox keeps files** until you delete them, so a cancelled or failed "Save" never loses the file. Use **Save / Share** (iPhone: Save to Photos / Files) or **Download**.
- **Sender waits** — if the other phone is offline, the transfer waits and starts when it comes back; the sender is warned before closing the page mid-transfer.
- **Screen kept awake** during transfers (Wake Lock), because phones throttle sleeping tabs.

Files go **directly phone-to-phone over WebRTC** (encrypted, stays on your Wi-Fi). If the phones can't reach each other directly, the server relays the same checksummed pieces; it never stores them.

## Run it

Requires Node.js 18+. No dependencies.

```bash
npm start          # prints http://<your-computer-ip>:3000
```

Open that address on both phones (same Wi-Fi). Each phone shows the other; tap it, choose files, accept on the other phone.

### HTTPS (recommended for iPhone)

The iPhone share sheet ("Save to Photos"), the keep-awake lock and a few other features only work over HTTPS. Either:

- `npm run cert` to create a self-signed certificate in `certs/`, restart, open `https://<ip>:3000` and accept the warning once on each phone; or
- deploy to any Node host with HTTPS (Render, Fly.io, Railway, a VPS behind Caddy…). Set `TRUST_PROXY=1` behind a reverse proxy so phones on the same Wi-Fi are grouped by their real IP.

### Different networks

Tap **Pair with code** and enter the 6-digit code from the other phone. Pairings are remembered.

## Development

```bash
npm test           # engine (drops, corruption, disconnect, reload) + server tests
npm run test:e2e   # two headless browsers, direct WebRTC and relay, byte-for-byte check (needs Playwright)
```

| File | Role |
| --- | --- |
| `server.js` | Static files, room/peer discovery, WebRTC signaling, binary relay (built-in WebSocket) |
| `public/js/protocol.mjs` | Chunk framing, CRC-32 |
| `public/js/engine.mjs` | Transfer engine: windowed sending, ordered persisted receive, resume, verification |
| `public/js/storage.mjs` | IndexedDB storage for partial and received files |
| `public/js/link.mjs` | WebRTC data channels with WebSocket relay fallback |
| `public/js/app.mjs` | UI |

## Limits

- The sending page must stay open until the transfer finishes (a browser can't re-open a file you picked after a reload).
- Very large files (multiple GB) depend on the receiving browser's storage quota; iPhone Safari may ask for permission or refuse beyond its limit.
