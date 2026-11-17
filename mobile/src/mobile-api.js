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

  const ready = (async () => {
    await F.load();
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
      const st = window.WAHGA_SYNC && window.WAHGA_SYNC.status();
      return { open: db.isOpen(), path: st && st.connected ? `Google Drive: ${st.file} (shared)` : "Not connected", configuredPath: null };
    },
    // opening a database file = LINK it (Drive file), so phone saves go back into it;
    // a one-time copy would leave the shared file untouched
    "db:pick": linkOrImport,
    "db:pickExisting": linkOrImport,
    "db:openFolder": exportDb,
    "db:backup": exportDb,
    "db:cloudFolders": () => [],
    "db:openPath": notOnPhone,
    "db:useCloud": notOnPhone,
    "db:moveTo": notOnPhone,
    // 🔄 Refresh: on the phone, "newer data" lives in the Google Drive file
    "db:reload": async () => {
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
        const synced = S() && S().status().connected && changesData(channel);
        if (synced) await pullQuietly();
        const data = await fn(...args);
        if (synced) S().push().catch(() => toast("Saved on the phone. Could not save to Google Drive yet — will try again.", "err"));
        return { ok: true, data };
      } catch (err) {
        console.error(channel, err);
        return { ok: false, error: (err && err.message) || String(err) };
      }
    },
    on() {}, // no other computers push changes into the phone app
    removeListener() {},
  };
  const contextBridge = { exposeInMainWorld: (key, value) => { window[key] = value; } };
  window.MOBILE_ELECTRON = { ipcRenderer, contextBridge };
})();
