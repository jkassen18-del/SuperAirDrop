package com.superairdrop;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static ShareServer server;

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Phones cut network access to sleeping apps; stay awake while open.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (server == null) server = new ShareServer(getAssets(), getContentResolver());
        try {
            server.start();
        } catch (IOException e) {
            Toast.makeText(this, "Could not start sharing: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
        takeShared(getIntent());

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "SuperAirDropAndroid");
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(intent, "Choose files"), PICK_FILES);
                return true;
            }
        });
        setContentView(web);
        web.loadUrl("http://127.0.0.1:" + ShareServer.PORT + "/");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (takeShared(intent)) web.evaluateJavascript("window.dispatchEvent(new Event('android-shared'))", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES || pendingPick == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            result = uris.toArray(new Uri[0]);
        }
        pendingPick.onReceiveValue(result);
        pendingPick = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Files sent to the app with Android's "Share" button. */
    private boolean takeShared(Intent intent) {
        if (intent == null) return false;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return false;
        List<ShareServer.SharedFile> files = new ArrayList<>();
        for (Uri uri : uris) {
            String type = getContentResolver().getType(uri);
            files.add(new ShareServer.SharedFile(uri, displayName(uri), type != null ? type : "application/octet-stream"));
        }
        server.setShared(files);
        return true;
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) return name;
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "file";
    }

    static String localAddress() {
        String fallback = null;
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    String name = nif.getName();
                    // Prefer Wi-Fi and the phone's own hotspot over mobile data.
                    if (name.startsWith("wlan") || name.startsWith("swlan") || name.startsWith("ap")) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    class Bridge {
        private final AtomicInteger nextId = new AtomicInteger(1);
        private final Map<Integer, Uri> saving = new ConcurrentHashMap<>();
        private final Map<Integer, OutputStream> streams = new ConcurrentHashMap<>();

        @JavascriptInterface
        public String getShareUrl() {
            String ip = localAddress();
            return ip == null ? "" : "http://" + ip + ":" + ShareServer.PORT + "/";
        }

        @JavascriptInterface
        public String takeSharedFiles() {
            String json = server.sharedJson().toString();
            return json;
        }

        @JavascriptInterface
        public void clearSharedFiles() {
            server.setShared(new ArrayList<>());
        }

        /** Saving to the Downloads folder in pieces (the WebView cannot download blob: URLs). */
        @JavascriptInterface
        public int beginSave(String name, String type) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, type == null || type.isEmpty() ? "application/octet-stream" : type);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SuperAirDrop");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return -1;
                OutputStream out = getContentResolver().openOutputStream(uri);
                if (out == null) return -1;
                int id = nextId.getAndIncrement();
                saving.put(id, uri);
                streams.put(id, out);
                return id;
            } catch (Exception e) {
                return -1;
            }
        }

        @JavascriptInterface
        public boolean appendSave(int id, String base64) {
            OutputStream out = streams.get(id);
            if (out == null) return false;
            try {
                out.write(Base64.getDecoder().decode(base64));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean finishSave(int id, boolean ok) {
            OutputStream out = streams.remove(id);
            Uri uri = saving.remove(id);
            if (out == null || uri == null) return false;
            try {
                out.close();
                if (!ok) {
                    getContentResolver().delete(uri, null, null);
                    return false;
                }
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, values, null, null);
                return true;
            } catch (Exception e) {
                getContentResolver().delete(uri, null, null);
                return false;
            }
        }
    }
}
