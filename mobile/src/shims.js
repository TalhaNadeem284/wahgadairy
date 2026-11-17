/* Wahga Dairy Farm — Android shims.
 *
 * db.js was written for Node/Electron (sync `fs`, `path`, `os`, `sql.js`).
 * On the phone it runs inside the WebView, so this file gives it small
 * stand-ins: an in-memory file table that is mirrored to the phone's private
 * app storage (Capacitor Filesystem, Directory.Data) after every save.
 */
(function () {
  "use strict";

  const DB_DIR = "/data";
  const DB_FILE = DB_DIR + "/wahga-dairy.db";
  const STORE_NAME = "wahga-dairy.db"; // file name inside Directory.Data

  const files = new Map(); // path -> { data: Uint8Array|string, mtime: number }
  const dirs = new Set(["/", DB_DIR, "/app", "/app/seed"]);

  const Plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};

  /* ---- base64 helpers (Filesystem plugin reads/writes base64) ---- */
  function bytesToBase64(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  /* ---- writing the DB to phone storage (debounced, never blocks the UI) ---- */
  let saveTimer = null;
  let saving = Promise.resolve();
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  }
  function flush() {
    clearTimeout(saveTimer);
    const f = files.get(DB_FILE);
    if (!f) return saving;
    const data = bytesToBase64(f.data);
    saving = saving.then(async () => {
      const FS = Plugins().Filesystem;
      if (FS) await FS.writeFile({ path: STORE_NAME, data, directory: "DATA" });
      else try { localStorage.setItem("wahga-db", data); } catch { /* browser preview only */ }
    }).catch((e) => console.error("save failed", e));
    return saving;
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
  const norm = (p) => String(p).replace(/\\/g, "/");
  const touch = (p, data) => { files.set(p, { data, mtime: Date.now() }); if (p === DB_FILE) scheduleSave(); };

  const fs = {
    existsSync: (p) => { p = norm(p); return files.has(p) || dirs.has(p); },
    statSync: (p) => {
      p = norm(p);
      if (dirs.has(p)) return { mtimeMs: 0, isDirectory: () => true };
      const f = files.get(p);
      if (!f) throw err("ENOENT", "no such file: " + p);
      return { mtimeMs: f.mtime, size: f.data.length, isDirectory: () => false };
    },
    readFileSync: (p, enc) => {
      const f = files.get(norm(p));
      if (!f) throw err("ENOENT", "no such file: " + p);
      if (enc) return typeof f.data === "string" ? f.data : new TextDecoder().decode(f.data);
      return f.data;
    },
    writeFileSync: (p, data) => touch(norm(p), typeof data === "string" ? data : new Uint8Array(data)),
    renameSync: (a, b) => {
      a = norm(a); b = norm(b);
      const f = files.get(a);
      if (!f) throw err("ENOENT");
      files.delete(a);
      touch(b, f.data);
    },
    copyFileSync: (a, b) => { const f = files.get(norm(a)); if (!f) throw err("ENOENT"); touch(norm(b), f.data); },
    unlinkSync: (p) => { files.delete(norm(p)); },
    mkdirSync: (p) => { dirs.add(norm(p)); },
    // lock file: "wx" fails when the file exists
    openSync: (p, flags) => {
      p = norm(p);
      if (flags === "wx" && files.has(p)) throw err("EEXIST");
      files.set(p, { data: "", mtime: Date.now() });
      return p;
    },
    writeSync: (fd, s) => { const f = files.get(fd); if (f) f.data = String(s); },
    closeSync: () => {},
  };

  const path = {
    join: (...parts) => norm(parts.filter(Boolean).join("/")).replace(/\/+/g, "/"),
    dirname: (p) => { p = norm(p); const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); },
    basename: (p) => norm(p).split("/").pop(),
  };

  const os = { hostname: () => "phone" };

  // sql.js: the browser build (sql-wasm.js) defines window.initSqlJs
  const sqljs = () => window.initSqlJs({ locateFile: (f) => f });

  window.Buffer = window.Buffer || { from: (u8) => (u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)) };
  window.process = window.process || { pid: 1, env: {}, platform: "android" };

  window.MOBILE_SHIMS = { fs, path, os, "sql.js": sqljs };

  /* ---- startup: load the saved DB (or the bundled seed) into memory ---- */
  window.WAHGA_FILES = {
    DB_FILE,
    flush,
    bytesToBase64,
    base64ToBytes,
    /** Replace the phone's database with these bytes (import / restore). */
    replaceDb(bytes) { touch(DB_FILE, bytes); return flush(); },
    currentBytes() { const f = files.get(DB_FILE); return f ? f.data : null; },
    async load() {
      let b64 = null;
      const FS = Plugins().Filesystem;
      try {
        if (FS) b64 = (await FS.readFile({ path: STORE_NAME, directory: "DATA" })).data;
        else b64 = localStorage.getItem("wahga-db");
      } catch { b64 = null; } // first run: nothing saved yet
      if (b64) files.set(DB_FILE, { data: base64ToBytes(b64), mtime: Date.now() });
      // the seed is only used by db.open() when there is no saved database
      try {
        const res = await fetch("seed/wahga-dairy-seed.db");
        if (res.ok) files.set("/app/seed/wahga-dairy-seed.db", { data: new Uint8Array(await res.arrayBuffer()), mtime: 0 });
      } catch { /* no seed bundled */ }
      return !!b64;
    },
  };
})();
