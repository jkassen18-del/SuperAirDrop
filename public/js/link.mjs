// Connections to other devices. Each peer is reached directly over a WebRTC
// data channel when possible (fast, stays on the local network) and through
// the server's WebSocket relay otherwise. The transfer engine above does not
// care which one is used; whenever the route changes it is told the peer
// (re)connected and the transfer resumes from the last saved chunk.

import { ID_LENGTH } from './protocol.mjs';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const HIGH_WATER = 4 * 1024 * 1024;

export class Link {
  constructor({ me, url, handlers }) {
    this.me = me;
    this.url = url;
    this.h = handlers; // onStatus, onPeers, onMessage, onBinary, onPeerUp, onPeerDown, onRoute
    this.peers = new Map(); // id -> { info, pc, dc, attempts }
    this.codes = new Set();
    this.retry = 0;
    this.connect();
    document.addEventListener('visibilitychange', () => {
      // Phones suspend background tabs; reconnect as soon as we are visible.
      if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }

  // ---- server connection ----------------------------------------------------

  connect() {
    clearTimeout(this.reconnectTimer);
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.h.onStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', ...this.me }));
      for (const code of this.codes) ws.send(JSON.stringify({ type: 'join-code', code }));
      this.h.onStatus('online');
    };
    ws.onmessage = (e) => this.onServer(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.h.onStatus('offline');
      this.updatePeers([]);
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  joinCode(code) {
    this.codes.add(code);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'join-code', code }));
  }

  onServer(data) {
    if (data instanceof ArrayBuffer) {
      const from = new TextDecoder().decode(new Uint8Array(data, 0, ID_LENGTH));
      this.h.onBinary(from, data.slice(ID_LENGTH));
      return;
    }
    const msg = JSON.parse(data);
    if (msg.type === 'peers') this.updatePeers(msg.peers);
    else if (msg.type === 'relay') this.h.onMessage(msg.from, msg.data);
    else if (msg.type === 'signal') this.onSignal(msg.from, msg.data);
  }

  updatePeers(list) {
    const seen = new Set();
    for (const info of list) {
      seen.add(info.id);
      let p = this.peers.get(info.id);
      if (!p) {
        p = { info, attempts: 0 };
        this.peers.set(info.id, p);
        this.h.onPeerUp(info.id);
        if (this.me.id < info.id) this.startRtc(p);
      }
      p.info = info;
    }
    for (const [id, p] of this.peers) {
      if (seen.has(id)) continue;
      // The server lost track of this peer. Keep it only while a direct
      // channel is still open.
      if (p.dc?.readyState === 'open') continue;
      this.closeRtc(p);
      this.peers.delete(id);
      this.h.onPeerDown(id);
    }
    this.h.onPeers([...this.peers.values()].map((p) => ({ ...p.info, direct: p.dc?.readyState === 'open' })));
  }

  // ---- WebRTC ---------------------------------------------------------------

  signal(to, data) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  makePc(p) {
    this.closeRtc(p);
    if (!globalThis.RTCPeerConnection) return null;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    p.pc = pc;
    pc.onicecandidate = (e) => e.candidate && this.signal(p.info.id, { candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closeRtc(p);
        this.routeChanged(p);
        if (this.me.id < p.info.id && p.attempts < 3 && this.peers.get(p.info.id) === p) {
          setTimeout(() => this.peers.get(p.info.id) === p && !p.pc && this.startRtc(p), 3000);
        }
      }
    };
    pc.ondatachannel = (e) => this.setupChannel(p, e.channel);
    return pc;
  }

  async startRtc(p) {
    const pc = this.makePc(p);
    if (!pc) return;
    p.attempts++;
    this.setupChannel(p, pc.createDataChannel('files', { ordered: true }));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      this.signal(p.info.id, { sdp: pc.localDescription });
    } catch {
      this.closeRtc(p);
    }
  }

  async onSignal(from, data) {
    const p = this.peers.get(from);
    if (!p || !data) return;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          const pc = this.makePc(p);
          if (!pc) return;
          await pc.setRemoteDescription(data.sdp);
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal(from, { sdp: pc.localDescription });
        } else if (p.pc) {
          await p.pc.setRemoteDescription(data.sdp);
        }
      } else if (data.candidate && p.pc) {
        await p.pc.addIceCandidate(data.candidate);
      }
    } catch {
      // A failed handshake just means we keep using the relay.
    }
  }

  setupChannel(p, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
    dc.onopen = () => {
      p.dc = dc;
      this.routeChanged(p);
    };
    dc.onclose = () => {
      if (p.dc !== dc) return;
      p.dc = null;
      this.routeChanged(p);
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') this.h.onMessage(p.info.id, JSON.parse(e.data));
      else this.h.onBinary(p.info.id, e.data);
    };
  }

  closeRtc(p) {
    const { pc, dc } = p;
    p.pc = null;
    p.dc = null;
    try { dc?.close(); } catch {}
    try { pc?.close(); } catch {}
  }

  routeChanged(p) {
    const direct = p.dc?.readyState === 'open';
    this.h.onRoute(p.info.id, direct);
    this.h.onPeers([...this.peers.values()].map((x) => ({ ...x.info, direct: x.dc?.readyState === 'open' })));
  }

  // ---- sending ----------------------------------------------------------------

  async send(peerId, msg) {
    const p = this.peers.get(peerId);
    if (!p) return;
    const dc = p.dc?.readyState === 'open' ? p.dc : null;
    if (dc) {
      if (msg instanceof ArrayBuffer) {
        if (dc.bufferedAmount > HIGH_WATER) await drain(dc);
        if (dc.readyState === 'open') dc.send(msg);
      } else {
        dc.send(JSON.stringify(msg));
      }
      return;
    }
    const ws = this.ws;
    if (ws?.readyState !== 1) return;
    if (msg instanceof ArrayBuffer) {
      while (ws.bufferedAmount > HIGH_WATER && ws.readyState === 1) await sleep(30);
      const frame = new Uint8Array(ID_LENGTH + msg.byteLength);
      frame.set(new TextEncoder().encode(peerId));
      frame.set(new Uint8Array(msg), ID_LENGTH);
      ws.send(frame);
    } else {
      ws.send(JSON.stringify({ type: 'relay', to: peerId, data: msg }));
    }
  }
}

function drain(dc) {
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
