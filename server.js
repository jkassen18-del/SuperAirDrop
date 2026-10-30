// SuperAirDrop server: serves the web app and introduces devices to each
// other. File data normally flows phone-to-phone over WebRTC; when two phones
// cannot reach each other directly the server relays the (still chunked and
// checksummed) data over the WebSocket. Nothing is ever written to disk here.
//
// No dependencies: a minimal RFC 6455 WebSocket implementation is included.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FRAME = 1024 * 1024;
const ID_LENGTH = 16;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---- static files ---------------------------------------------------------

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---- minimal WebSocket ------------------------------------------------------

class Socket {
  constructor(raw) {
    this.raw = raw;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.onmessage = () => {};
    this.onclose = () => {};
    raw.setNoDelay(true);
    raw.on('data', (data) => this.receive(data));
    raw.on('close', () => this.finish());
    raw.on('error', () => this.finish());
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME || !masked) return this.close(len > MAX_FRAME ? 1009 : 1002);
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this.frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x8) return this.close(1000);
    if (opcode === 0x9) return this.write(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    }
    const total = this.fragments.reduce((n, f) => n + f.length, 0);
    if (total > MAX_FRAME) return this.close(1009);
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.onmessage(message, this.fragmentOpcode === 0x2);
  }

  write(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.raw.write(Buffer.concat([header, payload]));
  }

  sendText(obj) {
    this.write(0x1, Buffer.from(JSON.stringify(obj)));
  }

  sendBinary(buf) {
    this.write(0x2, buf);
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.write(0x8, payload);
    this.raw.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.raw.destroy();
    this.onclose();
  }
}

function upgrade(req, raw) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || !req.url.startsWith('/ws')) {
    raw.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  raw.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  onConnection(new Socket(raw), clientAddress(req));
}

// ---- rooms and peers --------------------------------------------------------

// Devices on the same Wi-Fi share a public IP and see each other automatically.
// When the server itself runs on the home network every client has a private
// address, so all private addresses share one room. Pairing codes join devices
// that are on different networks.
function clientAddress(req) {
  const forwarded = process.env.TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || '').trim();
  return ip.replace(/^::ffff:/, '');
}

function isPrivate(ip) {
  return (
    ip === '::1' ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
    /^f[cd]/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
}

const peers = new Map(); // peerId -> peer
const rooms = new Map(); // room -> Set<peerId>

function roomPeers(peer) {
  const ids = new Set();
  for (const room of peer.rooms) for (const id of rooms.get(room) || []) if (id !== peer.id) ids.add(id);
  return [...ids].map((id) => peers.get(id)).filter(Boolean);
}

function canTalk(a, b) {
  for (const room of a.rooms) if (b.rooms.has(room)) return true;
  return false;
}

function describe(peer) {
  return { id: peer.id, name: peer.name, device: peer.device };
}

function broadcastPeers(peer) {
  peer.socket.sendText({ type: 'peers', peers: roomPeers(peer).map(describe) });
}

function joinRoom(peer, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(peer.id);
  peer.rooms.add(room);
  for (const other of roomPeers(peer)) broadcastPeers(other);
  broadcastPeers(peer);
}

function leaveRooms(peer) {
  const others = roomPeers(peer);
  for (const room of peer.rooms) {
    const set = rooms.get(room);
    if (!set) continue;
    set.delete(peer.id);
    if (set.size === 0) rooms.delete(room);
  }
  peer.rooms.clear();
  for (const other of others) broadcastPeers(other);
}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);
}

function onConnection(socket, ip) {
  let peer = null;
  const keepAlive = setInterval(() => socket.write(0x9, Buffer.alloc(0)), 20000);

  socket.onmessage = (data, binary) => {
    if (binary) {
      // Relayed chunk: [16 byte target id][frame]. Rewritten to carry the
      // sender's id instead.
      if (!peer || data.length < ID_LENGTH) return;
      const target = peers.get(data.subarray(0, ID_LENGTH).toString('latin1'));
      if (!target || !canTalk(peer, target)) return;
      Buffer.from(peer.id, 'latin1').copy(data, 0);
      target.socket.sendBinary(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      if (peer || !/^[0-9a-f]{16}$/.test(msg.id)) return;
      const existing = peers.get(msg.id);
      if (existing) {
        // Same device reconnecting (e.g. after the phone woke up).
        leaveRooms(existing);
        existing.socket.close(4000);
        peers.delete(existing.id);
      }
      peer = { id: msg.id, name: clean(msg.name, 40), device: clean(msg.device, 40), socket, rooms: new Set() };
      peers.set(peer.id, peer);
      socket.sendText({ type: 'welcome', id: peer.id });
      joinRoom(peer, isPrivate(ip) ? 'lan' : `ip:${ip}`);
      return;
    }
    if (!peer) return;
    if (msg.type === 'join-code') {
      const code = clean(msg.code, 12).replace(/\D/g, '');
      if (code.length === 6) joinRoom(peer, `code:${code}`);
      return;
    }
    if (msg.type === 'signal' || msg.type === 'relay') {
      const target = peers.get(msg.to);
      if (!target || !canTalk(peer, target)) return;
      target.socket.sendText({ type: msg.type, from: peer.id, data: msg.data });
    }
  };

  socket.onclose = () => {
    clearInterval(keepAlive);
    if (peer && peers.get(peer.id) === peer) {
      leaveRooms(peer);
      peers.delete(peer.id);
    }
  };
}

// ---- start ------------------------------------------------------------------

function createServer() {
  const keyFile = process.env.TLS_KEY || path.join(__dirname, 'certs', 'key.pem');
  const certFile = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
  const tls = fs.existsSync(keyFile) && fs.existsSync(certFile);
  const server = tls
    ? https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, serveStatic)
    : http.createServer(serveStatic);
  server.on('upgrade', upgrade);
  server.tls = tls;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const scheme = server.tls ? 'https' : 'http';
    const addrs = Object.values(require('os').networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `${scheme}://${a.address}:${PORT}`);
    console.log(`SuperAirDrop running. Open on both phones (same Wi-Fi):`);
    for (const a of addrs.length ? addrs : [`${scheme}://localhost:${PORT}`]) console.log(`  ${a}`);
    if (!server.tls) console.log('Tip: add certs/key.pem + certs/cert.pem for HTTPS (see README).');
  });
}

module.exports = { createServer, isPrivate };
