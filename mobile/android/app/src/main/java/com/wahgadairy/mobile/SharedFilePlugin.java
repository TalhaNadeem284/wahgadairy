package com.wahgadairy.mobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Lets the app use ONE file the user picked with Android's file picker — e.g.
 * wahga-dairy.db inside the Google Drive app — like the desktop app uses
 * G:\My Drive\...\wahga-dairy.db. Android keeps the permission, so the app can
 * read and save that same file every time it starts.
 */
@CapacitorPlugin(name = "SharedFile")
public class SharedFilePlugin extends Plugin {

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        ContentResolver cr = getContext().getContentResolver();
        boolean writable = true;
        try {
            cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            writable = false;
            try { cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
        }
        try {
            JSObject info = info(uri);
            info.put("writable", writable);
            call.resolve(info);
        } catch (Exception e) {
            call.reject("Could not read the picked file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            call.resolve(info(Uri.parse(call.getString("uri"))));
        } catch (Exception e) {
            call.reject("Could not reach the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        Uri uri = Uri.parse(call.getString("uri"));
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("no data");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSObject r = info(uri);
            r.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        Uri uri = Uri.parse(call.getString("uri"));
        byte[] bytes = Base64.decode(call.getString("data"), Base64.DEFAULT);
        ContentResolver cr = getContext().getContentResolver();
        OutputStream out = null;
        try {
            try { out = cr.openOutputStream(uri, "wt"); }       // truncate, then write
            catch (Exception notSupported) { out = cr.openOutputStream(uri, "w"); }
            if (out == null) throw new Exception("no output");
            out.write(bytes);
            out.flush();
            out.close();
            out = null;
            call.resolve(info(uri));
        } catch (Exception e) {
            call.reject("Could not save to the file: " + e.getMessage());
        } finally {
            if (out != null) try { out.close(); } catch (Exception ignored) { }
        }
    }

    /** name, size and last-modified time of the file (used to notice changes from other devices). */
    private JSObject info(Uri uri) {
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int iName = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int iSize = c.getColumnIndex(OpenableColumns.SIZE);
                int iMod = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                if (iName >= 0) o.put("name", c.getString(iName));
                if (iSize >= 0 && !c.isNull(iSize)) o.put("size", c.getLong(iSize));
                if (iMod >= 0 && !c.isNull(iMod)) o.put("modified", c.getLong(iMod));
            }
        }
        return o;
    }
}
