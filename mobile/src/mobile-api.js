/* Wahga Dairy Farm — Android bridge.
 *
 * On the desktop, renderer → preload.js → ipcRenderer.invoke → main.js → db.js.
 * On the phone there is no main process, so this file provides the same
 * `ipcRenderer.invoke(channel, ...args)` and answers it directly with db.js.
 * The simple data handlers are copied from main.js at build time
 * (mobile-handlers.js); only the desktop-only ones (file dialogs, folders,
 * printing) are re-done here for the phone.
 */
(function () {
  "use strict";

  const db = window.WAHGA_DB;
  const F = window.WAHGA_FILES;
  const H = (window.MOBILE_HANDLERS = {});
  const Plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
  const today = () => new Date().toLocaleDateString("en-CA");
  const safeName = (s) => String(s || "file").replace(/[<>:"/\\|?*]+/g, "-");

  /* ---------- online database (same server as the computers) ---------- */
  const ONLINE_KEY = "wahga-online";
  const onlineCfg = () => { try { return JSON.parse(localStorage.getItem(ONLINE_KEY) || "null"); } catch { return null; } };
  let online = null;        // connected client
  let onlineError = null;
  const cleanUrl = (u) => { let s = String(u || "").trim().replace(/\/+$/, ""); if (s && !/^https?:\/\//i.test(s)) s = "https://" + s; return s; };
  function makeClient(url, password) {
    const base = cleanUrl(url);
    let lastVersion = 0, awake = false;
    async function request(p, { method = "GET", body, timeout } = {}) {
      const ms = timeout || (awake ? 60000 : 100000); // the free server can take ~1 min to wake up
      let timer;
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = new Promise((_, rej) => { timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} rej(new Error("The online server did not answer in time. Check the internet and try again.")); }, ms); });
      let res;
      try {
        res = await Promise.race([fetch(base + p, {
          method,
          headers: { authorization: "Bearer " + password, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl ? ctl.signal : undefined,
        }), t]);
      } catch (e) {
        if (/did not answer/.test(String(e && e.message))) throw e;
        throw new Error("No internet / can't reach the online server. Nothing was saved — try again when connected.");
      } finally { clearTimeout(timer); }
      awake = true;
      if (res.status === 401) throw new Error("Wrong password for the online database.");
      if (res.status === 429) throw new Error("Too many wrong passwords — wait a few minutes.");
      return res;
    }
    async function json(p, opts) {
      const res = await request(p, opts);
      let out;
      try { out = await res.json(); } catch { throw new Error("Online server error (" + res.status + ")."); }
      if (out && out.version) lastVersion = Math.max(lastVersion, out.version);
      if (!out || out.ok !== true) throw new Error((out && out.error) || "Online server error (" + res.status + ").");
      return out;
    }
    return {
      url: base,
      ping: () => json("/api/ping", { timeout: 100000 }),
      call: async (fn, args) => (await json("/api/call", { method: "POST", body: { fn, args } })).data,
      async changedElsewhere() { const before = lastVersion; const out = await json("/api/version", { timeout: 15000 }); return before > 0 && out.version > before; },
      async backupBytes() { const res = await request("/api/backup"); if (!res.ok) throw new Error("Backup failed (" + res.status + ")."); return new Uint8Array(await res.arrayBuffer()); },
    };
  }
  function remoteDb(client) {
    const special = { isOpen: () => true, currentPath: () => "Online · " + client.url, ensureFresh: () => false };
    return new Proxy({}, { get(_t, p) {
      if (p in special) return special[p];
      const v = db[p];
      if (typeof v !== "function") return v;
      return (...args) => client.call(p, args);
    } });
  }
  async function connectOnline(url, password) {
    const c = makeClient(url, password);
    await c.ping();
    online = c;
    onlineError = null;
    window.WAHGA_ONLINE_DB = remoteDb(c);
    return c;
  }
  window.WAHGA_IS_ONLINE = () => !!online;
  window.WAHGA_ONLINE_MODE = () => !!onlineCfg();

  const ready = (async () => {
    await F.load();
    const cfg = onlineCfg();
    if (cfg) { // online phone: no local data file, everything comes from the server
      try { await connectOnline(cfg.url, cfg.password); } catch (e) { onlineError = e.message; }
      return;
    }
    // not linked to the shared Drive file yet: open nothing, the app shows the "connect" screen
    const S = window.WAHGA_SYNC;
    if (!S || !S.status().connected || !F.currentBytes()) return;
    await db.open(F.DB_FILE);
    // start from the latest shared data (quietly skip if offline — the last copy is used)
    try { await Promise.race([S.pull(), new Promise((r) => setTimeout(r, 8000))]); } catch (e) { console.warn("start pull failed", e); }
  })();

  /* ---------- helpers: write a file to the cache and open the share sheet ---------- */
  async function shareFiles(list, title) {
    const { Filesystem, Share } = Plugins();
    if (!Filesystem || !Share) throw new Error("Sharing works in the Android app only.");
    const uris = [];
    for (const f of list) {
      await Filesystem.writeFile({ path: f.name, data: f.base64, directory: "CACHE" });
      uris.push((await Filesystem.getUri({ path: f.name, directory: "CACHE" })).uri);
    }
    try {
      await Share.share({ title, files: uris, dialogTitle: title });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) throw e; // closing the share sheet is fine
      return { canceled: true };
    }
    return { canceled: false, count: uris.length };
  }

  /** Render a full HTML document (invoice / statement) to an A4 PDF, as base64. */
  async function htmlToPdfBase64(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-10000px;top:0;";
    const css = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n")
      .replace(/(^|})\s*body\s*\{/g, "$1 .pdf-root {"); // keep page rules off the app itself
    box.innerHTML = `<style>${css} .pdf-root .sheet{margin:0 auto;box-shadow:none}</style><div class="pdf-root" style="width:794px;background:#fff">${doc.body.innerHTML}</div>`;
    document.body.append(box);
    // html2pdf copies the element it is given, so give it the page itself,
    // not the off-screen box around it (a copied left:-10000px renders blank)
    const page = box.querySelector(".pdf-root");
    try {
      const uri = await window.html2pdf().set({
        margin: [8, 0, 8, 0],
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], avoid: "tr" },
      }).from(page).outputPdf("datauristring");
      return uri.slice(uri.indexOf(",") + 1);
    } finally {
      box.remove();
    }
  }

  /** Ask the user for a .db file (Android file picker). */
  function pickFile() {
    return new Promise((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".db,.sqlite,.sqlite3,application/octet-stream,application/x-sqlite3,*/*";
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve(null);
        resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      };
      inp.click();
    });
  }
  const isSqlite = (u8) => u8 && u8.length > 100 && new TextDecoder().decode(u8.subarray(0, 15)) === "SQLite format 3";

  async function exportDb() {
    db.ensureFresh();
    await F.flush();
    const bytes = F.currentBytes();
    return shareFiles([{ name: `wahga-dairy-backup-${today()}.db`, base64: F.bytesToBase64(bytes) }], "Wahga Dairy data file");
  }
  async function importDb() {
    const f = await pickFile();
    if (!f) return { canceled: true };
    if (!isSqlite(f.bytes)) throw new Error("That file is not a Wahga Dairy database (.db).");
    // keep a copy of the current phone data first, so an import can be undone
    const before = F.currentBytes();
    if (before && Plugins().Filesystem) {
      await Plugins().Filesystem.writeFile({ path: `before-import-${Date.now()}.db`, data: F.bytesToBase64(before), directory: "DATA" });
    }
    await F.replaceDb(f.bytes);
    await db.open(F.DB_FILE);
    return { canceled: false, path: f.name };
  }

  async function linkOrImport() {
    if (!Plugins().SharedFile || !window.WAHGA_SYNC) return importDb();
    const info = await window.WAHGA_SYNC.connect();
    if (!info) return { canceled: true };
    return { canceled: false, path: (info.name || "wahga-dairy.db") + " — linked, phone saves go into this file" };
  }

  /* ---------- phone versions of the desktop-only handlers ---------- */
  const notOnPhone = () => { throw new Error("Not available on the phone. Use “Open a different database file” to load the data file."); };
  Object.assign(H, {
    "db:status": () => {
      if (online || onlineCfg()) {
        return { open: !!online, path: online ? "Online · " + online.url : null, configuredPath: null,
          online: !!online, onlineMode: !!onlineCfg(), serverUrl: (onlineCfg() || {}).url || "", onlineError: online ? null : onlineError };
      }
      const st = window.WAHGA_SYNC && window.WAHGA_SYNC.status();
      return { open: db.isOpen(), path: st && st.connected ? `Google Drive: ${st.file} (shared)` : "Not connected", configuredPath: null };
    },
    // opening a database file = LINK it (Drive file), so phone saves go back into it;
    // a one-time copy would leave the shared file untouched
    "db:pick": linkOrImport,
    "db:pickExisting": linkOrImport,
    "db:openFolder": () => (online ? onlineBackup() : exportDb()),
    "db:backup": () => (online ? onlineBackup() : exportDb()),
    "online:connect": async (url, password) => {
      const u = cleanUrl(url);
      if (!u) throw new Error("Enter the server address.");
      if (!password) throw new Error("Enter the password.");
      await connectOnline(u, password);
      localStorage.setItem(ONLINE_KEY, JSON.stringify({ url: u, password }));
      return { url: u };
    },
    "online:retry": async () => {
      const cfg = onlineCfg();
      if (!cfg) throw new Error("Not set up for the online database.");
      try { await connectOnline(cfg.url, cfg.password); } catch (e) { onlineError = e.message; throw e; }
      return { ok: true, online: true };
    },
    "online:disconnect": async () => {
      localStorage.removeItem(ONLINE_KEY);
      online = null;
      window.WAHGA_ONLINE_DB = null;
      setTimeout(() => location.reload(), 300); // back to the phone's own data / Drive file
      return { open: false };
    },
    "db:cloudFolders": () => [],
    "db:openPath": notOnPhone,
    "db:useCloud": notOnPhone,
    "db:moveTo": notOnPhone,
    // 🔄 Refresh: on the phone, "newer data" lives in the Google Drive file
    "db:reload": async () => {
      if (online) { await online.ping(); return { reloaded: false, online: true, mtime: Date.now(), path: "online" }; }
      const S = window.WAHGA_SYNC;
      const reloaded = S && S.status().connected ? await S.pull() : db.ensureFresh();
      return { reloaded, path: "phone" };
    },
    "meta:get": () => ({
      appVersion: window.WAHGA_VERSION || "",
      dbPath: "phone",
      milkCategories: db.MILK_CATEGORIES,
      expenseCategories: db.EXPENSE_CATEGORIES,
      paymentMethods: db.PAYMENT_METHODS,
    }),
    // "Print" on the phone = make a PDF and open the share sheet (WhatsApp, Drive, printer app…)
    "print:html": async (html) => shareFiles([{ name: `wahga-${Date.now()}.pdf`, base64: await htmlToPdfBase64(html) }], "Share PDF"),
    "print:pdf": async (html, name) => shareFiles([{ name: safeName(name || "statement") + ".pdf", base64: await htmlToPdfBase64(html) }], "Share PDF"),
    "print:pdfMany": async (docs, folderName) => {
      const list = [];
      for (const d of docs || []) list.push({ name: safeName(d.name || "invoice") + ".pdf", base64: await htmlToPdfBase64(d.html) });
      const r = await shareFiles(list, folderName || "Invoices");
      return { ...r, dir: "share sheet", count: list.length, files: list.map((x) => x.name) };
    },
  });

  async function onlineBackup() {
    const bytes = await online.backupBytes();
    return shareFiles([{ name: `wahga-dairy-online-${today()}.db`, base64: F.bytesToBase64(bytes) }], "Wahga Dairy backup");
  }

  /* ---------- online: tell the screens when another device saved ---------- */
  const changeListeners = new Set();
  let polling = false;
  setInterval(async () => {
    if (!online || document.hidden || polling || !changeListeners.size) return;
    polling = true;
    try { if (await online.changedElsewhere()) changeListeners.forEach((cb) => { try { cb(); } catch {} }); }
    catch { /* offline for a moment */ }
    finally { polling = false; }
  }, 5000);

  /* ---------- Google Drive: pull before a change, push after it ---------- */
  const S = () => window.WAHGA_SYNC;
  const changesData = (channel) => !channel.startsWith("db:") && /:\w*(save|delete|create)/i.test(channel);
  const toast = (msg, kind) => { try { window.toast(msg, kind); } catch { /* app not ready */ } };
  async function pullQuietly() {
    try { return await S().pull(); }
    catch (e) { console.warn("pull failed", e); return false; } // offline: work on the phone copy
  }

  /* ---------- the ipcRenderer stand-in that preload.js talks to ---------- */
  const ipcRenderer = {
    async invoke(channel, ...args) {
      try {
        await ready;
        const fn = H[channel];
        if (!fn) throw new Error("Not available on the phone: " + channel);
        const synced = !online && !onlineCfg() && S() && S().status().connected && changesData(channel);
        if (synced) await pullQuietly();
        const data = await fn(...args);
        if (synced) S().push().catch(() => toast("Saved on the phone. Could not save to Google Drive yet — will try again.", "err"));
        return { ok: true, data };
      } catch (err) {
        console.error(channel, err);
        return { ok: false, error: (err && err.message) || String(err) };
      }
    },
    on(channel, listener) { if (channel === "db:external-change") changeListeners.add(listener); },
    removeListener(channel, listener) { changeListeners.delete(listener); },
  };
  const contextBridge = { exposeInMainWorld: (key, value) => { window[key] = value; } };
  window.MOBILE_ELECTRON = { ipcRenderer, contextBridge };
})();
