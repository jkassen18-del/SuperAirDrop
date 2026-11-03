package com.superairdrop;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs the SuperAirDrop server on the phone itself: serves the web app (from
 * the APK assets) to the iPhone's Safari and introduces the devices to each
 * other. Mirrors server.js. Files go phone-to-phone over WebRTC, or are
 * relayed through here when that is not possible; nothing is stored.
 */
public class ShareServer {
    public static final int PORT = 8642;
    private static final int MAX_FRAME = 1024 * 1024;
    private static final int ID_LENGTH = 16;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final AssetManager assets;
    private final ContentResolver resolver;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Peer> peers = new HashMap<>();
    private final Map<String, Set<String>> rooms = new HashMap<>();
    private final List<SharedFile> shared = new ArrayList<>();
    private ServerSocket serverSocket;

    static class SharedFile {
        final Uri uri;
        final String name;
        final String type;

        SharedFile(Uri uri, String name, String type) {
            this.uri = uri;
            this.name = name;
            this.type = type;
        }
    }

    public ShareServer(AssetManager assets, ContentResolver resolver) {
        this.assets = assets;
        this.resolver = resolver;
    }

    public synchronized void start() throws IOException {
        if (serverSocket != null) return;
        serverSocket = new ServerSocket(PORT);
        pool.execute(() -> {
            while (!serverSocket.isClosed()) {
                try {
                    Socket s = serverSocket.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    return;
                }
            }
        });
    }

    /** Files shared into the app from Android's share sheet, served at /shared/N to this phone only. */
    public synchronized void setShared(List<SharedFile> files) {
        shared.clear();
        shared.addAll(files);
    }

    public synchronized JSONArray sharedJson() {
        JSONArray arr = new JSONArray();
        try {
            for (int i = 0; i < shared.size(); i++) {
                arr.put(new JSONObject()
                        .put("url", "/shared/" + i)
                        .put("name", shared.get(i).name)
                        .put("type", shared.get(i).type));
            }
        } catch (Exception ignored) {
        }
        return arr;
    }

    // ---- HTTP -----------------------------------------------------------------

    private void handle(Socket socket) {
        try {
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();
            String head = readHead(in);
            if (head == null) {
                socket.close();
                return;
            }
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2) {
                socket.close();
                return;
            }
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            String path = request[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            if ("websocket".equalsIgnoreCase(headers.get("upgrade")) && path.startsWith("/ws")) {
                upgrade(socket, in, out, headers);
                return;
            }
            if (request[0].equals("POST") && path.equals("/save")) {
                saveToDownloads(socket, in, out, headers);
            } else if (path.startsWith("/shared/")) {
                serveShared(socket, out, path);
            } else {
                serveAsset(out, path);
            }
            socket.close();
        } catch (IOException e) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (buf.size() < 16384) {
            int b = in.read();
            if (b < 0) return null;
            buf.write(b);
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = b == '\r' ? 1 : 0;
            if (state == 4) return buf.toString("ISO-8859-1");
        }
        return null;
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private void serveAsset(OutputStream out, String path) throws IOException {
        if (path.equals("/")) path = "/index.html";
        if (path.contains("..")) {
            writeStatus(out, "403 Forbidden");
            return;
        }
        try (InputStream file = assets.open(path.substring(1))) {
            byte[] body = readAll(file);
            String header = "HTTP/1.1 200 OK\r\nContent-Type: " + mime(path) + "\r\nContent-Length: " + body.length
                    + "\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
            out.write(body);
            out.flush();
        } catch (FileNotFoundException e) {
            writeStatus(out, "404 Not Found");
        }
    }

    /**
     * Streams a received file from this phone's own web view straight into
     * Downloads/SuperAirDrop. Only accepted from this phone (loopback).
     */
    private void saveToDownloads(Socket socket, InputStream in, OutputStream out, Map<String, String> headers) throws IOException {
        long length;
        try {
            length = Long.parseLong(headers.getOrDefault("content-length", "-1"));
        } catch (NumberFormatException e) {
            length = -1;
        }
        if (!socket.getInetAddress().isLoopbackAddress() || length < 0) {
            writeStatus(out, "403 Forbidden");
            return;
        }
        String name = "file";
        try {
            name = URLDecoder.decode(headers.getOrDefault("x-file-name", "file"), "UTF-8").replaceAll("[/\\\\\\u0000-\\u001f]", "_");
        } catch (Exception ignored) {
        }
        String type = headers.getOrDefault("content-type", "application/octet-stream");
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SuperAirDrop");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            writeStatus(out, "500 Internal Server Error");
            return;
        }
        boolean ok = false;
        try (OutputStream dest = resolver.openOutputStream(uri)) {
            if (dest == null) throw new IOException("no output");
            byte[] buf = new byte[256 * 1024];
            long remaining = length;
            while (remaining > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                if (n < 0) throw new IOException("closed early");
                dest.write(buf, 0, n);
                remaining -= n;
            }
            ok = true;
        } finally {
            if (ok) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
            } else {
                resolver.delete(uri, null, null);
            }
        }
        byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private void serveShared(Socket socket, OutputStream out, String path) throws IOException {
        InetAddress remote = socket.getInetAddress();
        SharedFile file = null;
        try {
            int index = Integer.parseInt(path.substring("/shared/".length()));
            synchronized (this) {
                if (index >= 0 && index < shared.size()) file = shared.get(index);
            }
        } catch (NumberFormatException ignored) {
        }
        if (!remote.isLoopbackAddress() || file == null) {
            writeStatus(out, "404 Not Found");
            return;
        }
        try (InputStream src = resolver.openInputStream(file.uri)) {
            if (src == null) throw new FileNotFoundException();
            String header = "HTTP/1.1 200 OK\r\nContent-Type: " + file.type + "\r\nConnection: close\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
            byte[] buf = new byte[65536];
            int n;
            while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } catch (FileNotFoundException | SecurityException e) {
            writeStatus(out, "404 Not Found");
        }
    }

    private static void writeStatus(OutputStream out, String status) throws IOException {
        out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        return buf.toByteArray();
    }

    // ---- WebSocket ------------------------------------------------------------

    private void upgrade(Socket socket, InputStream in, OutputStream out, Map<String, String> headers) throws IOException {
        String key = headers.get("sec-websocket-key");
        if (key == null) {
            writeStatus(out, "400 Bad Request");
            socket.close();
            return;
        }
        String accept;
        try {
            byte[] sha = MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).getBytes(StandardCharsets.ISO_8859_1));
            accept = Base64.getEncoder().encodeToString(sha);
        } catch (Exception e) {
            throw new IOException(e);
        }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        Ws ws = new Ws(socket, out);
        Client client = new Client(ws, socket.getInetAddress());
        try {
            readFrames(in, ws, client);
        } finally {
            ws.close();
            client.closed();
        }
    }

    private static int readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("closed");
            off += n;
        }
        return off;
    }

    private void readFrames(InputStream in, Ws ws, Client client) throws IOException {
        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        int fragmentOpcode = 0;
        byte[] two = new byte[2];
        while (true) {
            readFully(in, two);
            boolean fin = (two[0] & 0x80) != 0;
            int opcode = two[0] & 0x0f;
            boolean masked = (two[1] & 0x80) != 0;
            long len = two[1] & 0x7f;
            if (len == 126) {
                byte[] b = new byte[2];
                readFully(in, b);
                len = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
            } else if (len == 127) {
                byte[] b = new byte[8];
                readFully(in, b);
                len = 0;
                for (byte x : b) len = (len << 8) | (x & 0xff);
            }
            if (!masked || len > MAX_FRAME) return;
            byte[] mask = new byte[4];
            readFully(in, mask);
            byte[] payload = new byte[(int) len];
            readFully(in, payload);
            for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

            if (opcode == 0x8) return;
            if (opcode == 0x9) {
                ws.write(0xa, payload);
                continue;
            }
            if (opcode == 0xa) continue;
            if (opcode != 0) {
                fragmentOpcode = opcode;
                fragments.reset();
            }
            fragments.write(payload);
            if (fragments.size() > MAX_FRAME) return;
            if (!fin) continue;
            byte[] message = fragments.toByteArray();
            fragments.reset();
            if (fragmentOpcode == 0x2) client.onBinary(message);
            else client.onText(new String(message, StandardCharsets.UTF_8));
        }
    }

    static class Ws {
        private final Socket socket;
        private final OutputStream out;
        private volatile boolean closed;

        Ws(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
        }

        synchronized void write(int opcode, byte[] payload) {
            if (closed) return;
            try {
                int len = payload.length;
                if (len < 126) {
                    out.write(new byte[]{(byte) (0x80 | opcode), (byte) len});
                } else if (len < 65536) {
                    out.write(new byte[]{(byte) (0x80 | opcode), 126, (byte) (len >> 8), (byte) len});
                } else {
                    byte[] h = new byte[10];
                    h[0] = (byte) (0x80 | opcode);
                    h[1] = 127;
                    for (int i = 0; i < 8; i++) h[9 - i] = (byte) ((long) len >> (8 * i));
                    out.write(h);
                }
                out.write(payload);
                out.flush();
            } catch (IOException e) {
                close();
            }
        }

        void text(JSONObject obj) {
            write(0x1, obj.toString().getBytes(StandardCharsets.UTF_8));
        }

        void close() {
            if (closed) return;
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    // ---- rooms and peers --------------------------------------------------------

    static class Peer {
        String id;
        String name;
        String device;
        Ws ws;
        final Set<String> rooms = ConcurrentHashMap.newKeySet();
    }

    private static boolean isPrivate(InetAddress a) {
        return a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress();
    }

    private static String clean(String s, int max) {
        if (s == null) return "";
        s = s.replaceAll("[\\u0000-\\u001f]", "");
        return s.length() > max ? s.substring(0, max) : s;
    }

    private List<Peer> roomPeers(Peer peer) {
        Set<String> ids = new HashSet<>();
        for (String room : peer.rooms) {
            Set<String> members = rooms.get(room);
            if (members != null) ids.addAll(members);
        }
        ids.remove(peer.id);
        List<Peer> list = new ArrayList<>();
        for (String id : ids) {
            Peer p = peers.get(id);
            if (p != null) list.add(p);
        }
        return list;
    }

    private static boolean canTalk(Peer a, Peer b) {
        for (String room : a.rooms) if (b.rooms.contains(room)) return true;
        return false;
    }

    private void sendPeers(Peer peer) {
        try {
            JSONArray arr = new JSONArray();
            for (Peer p : roomPeers(peer)) {
                arr.put(new JSONObject().put("id", p.id).put("name", p.name).put("device", p.device));
            }
            peer.ws.text(new JSONObject().put("type", "peers").put("peers", arr));
        } catch (Exception ignored) {
        }
    }

    private void joinRoom(Peer peer, String room) {
        rooms.computeIfAbsent(room, k -> new HashSet<>()).add(peer.id);
        peer.rooms.add(room);
        for (Peer other : roomPeers(peer)) sendPeers(other);
        sendPeers(peer);
    }

    private void leaveRooms(Peer peer) {
        List<Peer> others = roomPeers(peer);
        for (String room : peer.rooms) {
            Set<String> members = rooms.get(room);
            if (members == null) continue;
            members.remove(peer.id);
            if (members.isEmpty()) rooms.remove(room);
        }
        peer.rooms.clear();
        for (Peer other : others) sendPeers(other);
    }

    class Client {
        final Ws ws;
        final InetAddress address;
        Peer peer;

        Client(Ws ws, InetAddress address) {
            this.ws = ws;
            this.address = address;
        }

        void onBinary(byte[] data) {
            Peer target;
            synchronized (ShareServer.this) {
                if (peer == null || data.length < ID_LENGTH) return;
                target = peers.get(new String(data, 0, ID_LENGTH, StandardCharsets.ISO_8859_1));
                if (target == null || !canTalk(peer, target)) return;
            }
            byte[] id = peer.id.getBytes(StandardCharsets.ISO_8859_1);
            System.arraycopy(id, 0, data, 0, ID_LENGTH);
            target.ws.write(0x2, data);
        }

        void onText(String text) {
            JSONObject msg;
            try {
                msg = new JSONObject(text);
            } catch (Exception e) {
                return;
            }
            String type = msg.optString("type");
            synchronized (ShareServer.this) {
                try {
                    if (type.equals("hello")) {
                        String id = msg.optString("id");
                        if (peer != null || !id.matches("[0-9a-f]{16}")) return;
                        Peer existing = peers.remove(id);
                        if (existing != null) {
                            leaveRooms(existing);
                            existing.ws.close();
                        }
                        peer = new Peer();
                        peer.id = id;
                        peer.name = clean(msg.optString("name"), 40);
                        peer.device = clean(msg.optString("device"), 40);
                        peer.ws = ws;
                        peers.put(id, peer);
                        ws.text(new JSONObject().put("type", "welcome").put("id", id));
                        joinRoom(peer, isPrivate(address) ? "lan" : "ip:" + address.getHostAddress());
                        return;
                    }
                    if (peer == null) return;
                    if (type.equals("join-code")) {
                        String code = clean(msg.optString("code"), 12).replaceAll("\\D", "");
                        if (code.length() == 6) joinRoom(peer, "code:" + code);
                        return;
                    }
                    if (type.equals("signal") || type.equals("relay")) {
                        Peer target = peers.get(msg.optString("to"));
                        if (target == null || !canTalk(peer, target)) return;
                        target.ws.text(new JSONObject().put("type", type).put("from", peer.id).put("data", msg.opt("data")));
                    }
                } catch (Exception ignored) {
                }
            }
        }

        void closed() {
            synchronized (ShareServer.this) {
                if (peer != null && peers.get(peer.id) == peer) {
                    leaveRooms(peer);
                    peers.remove(peer.id);
                }
            }
        }
    }
}
