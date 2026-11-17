"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const localDb = require("./db");
const config = require("./config");
const remote = require("./remote");

// `db` is either the local file database (db.js) or, in online mode, a
// stand-in that sends every call to the online server (remote.js).
let db = localDb;
let online = null; // remote client when connected online

let win;
let changePollTimer = null;

/* The shared password is kept encrypted with Windows' own protection (DPAPI). */
function getServerPassword() {
  const enc = config.get("serverPasswordEnc");
  if (enc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(enc, "base64")); } catch { /* fall through */ }
  }
  return config.get("serverPassword") || "";
}
function setServerPassword(pw) {
  if (safeStorage.isEncryptionAvailable()) {
    config.set("serverPasswordEnc", safeStorage.encryptString(pw).toString("base64"));
    config.set("serverPassword", undefined);
  } else {
    config.set("serverPassword", pw);
  }
}

function isOnlineMode() {
  return config.get("mode") === "online" && !!config.get("serverUrl");
}

/** Connect to the online server; on success every data call goes there. */
async function connectOnline(url, password) {
  const client = remote.makeClient({ url, password });
  await client.ping();
  online = client;
  db = remote.makeRemoteDb(localDb, client);
  return client;
}

/** Use a local / cloud-folder database file (leaves online mode). */
async function openLocal(p) {
  const info = await localDb.open(p);
  db = localDb;
  online = null;
  config.set("mode", "local");
  return info;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    icon: path.join(__dirname, "build", "icon.ico"),
    title: "Wahga Dairy Farm",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on("console-message", (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer] ${message} (${path.basename(src || "")}:${line})`);
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });
}

let onlineError = null;
async function tryOpenConfiguredDb() {
  if (isOnlineMode()) {
    try {
      await connectOnline(config.get("serverUrl"), getServerPassword());
      onlineError = null;
      return { ok: true, online: true };
    } catch (err) {
      onlineError = err.message;
      return { ok: false, reason: "online-error", error: err.message };
    }
  }
  const dbPath = config.get("dbPath");
  if (!dbPath) return { ok: false, reason: "not-configured" };
  try {
    const folder = path.dirname(dbPath);
    if (!fs.existsSync(folder)) return { ok: false, reason: "folder-missing", dbPath };
    await localDb.open(dbPath);
    db = localDb;
    return { ok: true, dbPath: localDb.currentPath() };
  } catch (err) {
    return { ok: false, reason: "error", error: err.message, dbPath };
  }
}

function startChangePoll() {
  if (changePollTimer) clearInterval(changePollTimer);
  let polling = false;
  changePollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    if (online) {
      // another computer saved online → redraw; also keeps the free server awake while the app is open
      if (polling) return;
      polling = true;
      try {
        if (await online.changedElsewhere()) win.webContents.send("db:external-change");
      } catch { /* offline for a moment — next poll will retry */ }
      finally { polling = false; }
      return;
    }
    if (!db.isOpen()) return;
    const onDisk = db.fileMtime(db.currentPath());
    if (onDisk && Math.abs(onDisk - db.getLoadedMtime()) > 1) {
      win.webContents.send("db:external-change");
    }
  }, 4000);
}

app.whenReady().then(async () => {
  config.init(app.getPath("userData"));
  await tryOpenConfiguredDb();
  createWindow();
  startChangePoll();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------- generic IPC wrapper ---------- */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(channel, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function requireDb() {
  if (!db.isOpen()) throw new Error("No database is open. Choose the shared database folder first.");
}

/* ---------- database location ---------- */
handle("db:status", () => ({
  open: online ? true : (db === localDb && localDb.isOpen()),
  path: online ? db.currentPath() : (localDb.isOpen() ? localDb.currentPath() : config.get("dbPath") || null),
  configuredPath: config.get("dbPath") || null,
  online: !!online,
  onlineMode: isOnlineMode(),
  serverUrl: config.get("serverUrl") || "",
  onlineError: online ? null : onlineError,
}));

/* ---------- online database ---------- */
handle("online:connect", async (url, password) => {
  const u = remote.cleanUrl(url);
  if (!u) throw new Error("Enter the server address.");
  if (!password) throw new Error("Enter the password.");
  await connectOnline(u, password);
  config.set("serverUrl", u);
  setServerPassword(password);
  config.set("mode", "online");
  onlineError = null;
  return { url: u };
});
handle("online:retry", async () => {
  const r = await tryOpenConfiguredDb();
  if (!r.ok) throw new Error(r.error || "Could not connect.");
  return r;
});
// Back to the local / cloud-folder file this computer used before.
handle("online:disconnect", async () => {
  online = null;
  db = localDb;
  config.set("mode", "local");
  const r = await tryOpenConfiguredDb();
  return { open: r.ok, path: config.get("dbPath") || null };
});

handle("db:pick", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose the folder for the shared database (e.g. a Google Drive / OneDrive folder)",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const info = await openLocal(res.filePaths[0]);
  config.set("dbPath", info.path);
  return { canceled: false, path: info.path, seededFrom: info.seededFrom };
});

handle("db:pickExisting", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Open an existing Wahga Dairy database file",
    properties: ["openFile"],
    filters: [{ name: "Database", extensions: ["db", "sqlite", "sqlite3"] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const info = await openLocal(res.filePaths[0]);
  config.set("dbPath", info.path);
  return { canceled: false, path: info.path };
});

handle("db:openFolder", () => {
  if (online) throw new Error("The database is online — there is no file on this computer. Use “Save a backup copy” to download one.");
  if (!db.isOpen()) throw new Error("No database open.");
  shell.showItemInFolder(db.currentPath());
  return true;
});

/* ---------- cloud folder detection + one-click setup ---------- */
function detectCloudFolders() {
  const home = app.getPath("home");
  const candidates = [
    { name: "Google Drive", dirs: [path.join(home, "Google Drive"), path.join(home, "My Drive"), "G:\\My Drive", "G:\\Shared drives"] },
    { name: "OneDrive", dirs: [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial, path.join(home, "OneDrive")].filter(Boolean) },
    { name: "Dropbox", dirs: [path.join(home, "Dropbox")] },
  ];
  const found = [];
  for (const c of candidates) {
    for (const d of c.dirs) {
      try {
        if (d && fs.existsSync(d) && fs.statSync(d).isDirectory()) {
          // Has a shared Wahga DB already synced into it?
          let existingDb = null;
          const guess = path.join(d, "Wahga Dairy Farm", "wahga-dairy.db");
          if (fs.existsSync(guess)) existingDb = guess;
          found.push({ name: c.name, path: d, existingDb });
          break;
        }
      } catch { /* ignore */ }
    }
  }
  return found;
}

handle("db:cloudFolders", () => detectCloudFolders());

// Open a database at an exact path (no dialog) — used for the auto-detected shared file.
handle("db:openPath", async (p) => {
  if (!p || !fs.existsSync(p)) throw new Error("That database file isn't there.");
  const info = await openLocal(p);
  config.set("dbPath", info.path);
  return { path: info.path, seededFrom: info.seededFrom };
});

// Create (seeded) the database inside a cloud folder in one click.
handle("db:useCloud", async (cloudPath) => {
  if (!cloudPath || !fs.existsSync(cloudPath)) throw new Error("That cloud folder isn't available.");
  const folder = path.join(cloudPath, "Wahga Dairy Farm");
  fs.mkdirSync(folder, { recursive: true });
  const info = await openLocal(folder); // db.open seeds from seed/ if the file is new
  config.set("dbPath", info.path);
  return { path: info.path, seededFrom: info.seededFrom };
});

// Force a re-read from disk (e.g. right after the cloud app synced a new copy).
handle("db:reload", async () => {
  if (online) {
    await online.ping();
    return { reloaded: false, online: true, mtime: Date.now(), path: db.currentPath() };
  }
  if (!db.isOpen()) throw new Error("No database open.");
  const reloaded = db.ensureFresh();
  return { reloaded, mtime: db.fileMtime(db.currentPath()), path: db.currentPath() };
});

// Move the CURRENT database (with all its data) into a cloud folder and use it from there.
handle("db:moveTo", async (cloudPath) => {
  if (online) throw new Error("This computer uses the online database — nothing to move.");
  requireDb();
  if (!cloudPath || !fs.existsSync(cloudPath)) throw new Error("That cloud folder isn't available.");
  db.ensureFresh();
  const src = db.currentPath();
  const folder = path.join(cloudPath, "Wahga Dairy Farm");
  fs.mkdirSync(folder, { recursive: true });
  const dest = path.join(folder, "wahga-dairy.db");
  if (fs.existsSync(dest)) {
    throw new Error("A database already exists there. Use “Open a different database file” to switch to it instead.");
  }
  fs.copyFileSync(src, dest);
  const info = await openLocal(dest);
  config.set("dbPath", info.path);
  return { path: info.path, from: src };
});

handle("db:backup", async () => {
  requireDb();
  const stamp = new Date().toLocaleDateString("en-CA");
  const res = await dialog.showSaveDialog(win, {
    title: "Save a backup copy of the database",
    defaultPath: `wahga-dairy-backup-${stamp}.db`,
    filters: [{ name: "Database", extensions: ["db"] }],
  });
  if (res.canceled) return { canceled: true };
  if (online) {
    fs.writeFileSync(res.filePath, await online.backup());
    return { canceled: false, path: res.filePath };
  }
  db.ensureFresh();
  fs.copyFileSync(db.currentPath(), res.filePath);
  return { canceled: false, path: res.filePath };
});

/* ---------- meta ---------- */
handle("meta:get", () => ({
  appVersion: app.getVersion(),
  dbPath: db.isOpen() ? db.currentPath() : null,
  milkCategories: db.MILK_CATEGORIES,
  expenseCategories: db.EXPENSE_CATEGORIES,
  paymentMethods: db.PAYMENT_METHODS,
  societies: db.SOCIETIES,
}));

/* ---------- settings ---------- */
handle("settings:get", () => { requireDb(); return db.getSettings(); });
handle("settings:save", (obj) => { requireDb(); return db.saveSettings(obj); });

/* ---------- clients ---------- */
handle("clients:list", (inc) => { requireDb(); return db.listClients(inc); });
handle("clients:get", (id) => { requireDb(); return db.getClient(id); });
handle("clients:save", (c) => { requireDb(); return db.saveClient(c); });
handle("clients:delete", (id) => { requireDb(); return db.deleteClient(id); });

/* ---------- milk entries ---------- */
handle("entries:list", (filter) => { requireDb(); return db.listEntries(filter || {}); });
handle("entries:save", (e) => { requireDb(); return db.saveEntry(e); });
handle("entries:delete", (id) => { requireDb(); return db.deleteEntry(id); });
handle("entries:dailyRound", (date) => { requireDb(); return db.dailyRound(date); });
handle("entries:dailyRoundSave", (date, rows) => { requireDb(); return db.saveDailyRound(date, rows); });
handle("plan:get", (date) => { requireDb(); return db.milkPlan(date); });
handle("plan:save", (date, rows, extra) => { requireDb(); return db.saveMilkPlan(date, rows, extra); });
handle("plan:delete", (date) => { requireDb(); return db.deleteMilkPlan(date); });

/* ---------- payments ---------- */
handle("payments:list", (filter) => { requireDb(); return db.listPayments(filter || {}); });
handle("payments:save", (p) => { requireDb(); return db.savePayment(p); });
handle("payments:delete", (id) => { requireDb(); return db.deletePayment(id); });
handle("settlements:get", (opts) => { requireDb(); return db.settlements(opts || {}); });

/* ---------- purchases ---------- */
handle("purchases:list", (filter) => { requireDb(); return db.listPurchases(filter || {}); });
handle("purchases:save", (p) => { requireDb(); return db.savePurchase(p); });
handle("purchases:delete", (id) => { requireDb(); return db.deletePurchase(id); });
handle("purchases:suppliers", () => { requireDb(); return db.listSuppliers(); });
handle("purchases:credit", () => { requireDb(); return db.supplierCredit(); });
handle("suppliers:accounts", (onlyOwing) => { requireDb(); return db.supplierAccounts(onlyOwing); });
handle("suppliers:payList", (filter) => { requireDb(); return db.listSupplierPayments(filter || {}); });
handle("suppliers:paySave", (p) => { requireDb(); return db.saveSupplierPayment(p); });
handle("suppliers:payDelete", (id) => { requireDb(); return db.deleteSupplierPayment(id); });

handle("loans:accounts", () => { requireDb(); return db.loanAccounts(); });
handle("loans:list", (filter) => { requireDb(); return db.listLoans(filter || {}); });
handle("loans:save", (l) => { requireDb(); return db.saveLoan(l); });
handle("loans:delete", (id) => { requireDb(); return db.deleteLoan(id); });
handle("staff:accounts", (opts) => { requireDb(); return db.staffAccounts(opts); });
handle("staff:save", (s) => { requireDb(); return db.saveStaff(s); });
handle("staff:delete", (id) => { requireDb(); return db.deleteStaff(id); });
handle("salary:list", (filter) => { requireDb(); return db.listSalaryPayments(filter); });
handle("salary:save", (p) => { requireDb(); return db.saveSalaryPayment(p); });
handle("salary:monthSave", (m) => { requireDb(); return db.saveSalaryMonth(m); });
handle("salary:monthDelete", (id) => { requireDb(); return db.deleteSalaryMonth(id); });

handle("homemilk:list", (filter) => { requireDb(); return db.listHomeMilk(filter || {}); });
handle("homemilk:forDate", (date) => { requireDb(); return db.homeMilkForDate(date); });
handle("homemilk:save", (h) => { requireDb(); return db.saveHomeMilk(h); });
handle("homemilk:delete", (id) => { requireDb(); return db.deleteHomeMilk(id); });

/* ---------- expenses ---------- */
handle("expenses:list", (filter) => { requireDb(); return db.listExpenses(filter || {}); });
handle("expenses:save", (x) => { requireDb(); return db.saveExpense(x); });
handle("expenses:delete", (id) => { requireDb(); return db.deleteExpense(id); });

/* ---------- reports ---------- */
handle("reports:profitLoss", (from, to) => { requireDb(); return db.profitLoss(from, to); });
handle("reports:dashboard", () => { requireDb(); return db.dashboard(); });

/* ---------- statement / sheet / invoices ---------- */
handle("statement:get", (clientId, from, to) => { requireDb(); return db.clientStatement(clientId, from, to); });
handle("sheet:milk", (from, to, supplier) => { requireDb(); return db.dailyMilkSheet(from, to, supplier); });
handle("invoices:list", (filter) => { requireDb(); return db.listInvoices(filter || {}); });
handle("invoices:dues", (clientId) => { requireDb(); return db.clientInvoiceDues(clientId); });
handle("clients:dueSplit", (clientId, excludePaymentId) => { requireDb(); return db.clientDueSplit(clientId, excludePaymentId); });
handle("invoices:preview", (clientId, from, to) => { requireDb(); return db.invoicePreview(clientId, from, to); });
handle("invoices:previewAll", (from, to, cycle) => { requireDb(); return db.invoicePreviewAll(from, to, cycle); });
handle("invoices:create", (inv) => { requireDb(); return db.createInvoice(inv); });
handle("invoices:createBulk", (payload) => { requireDb(); return db.createInvoicesBulk(payload || {}); });
handle("invoices:get", (id) => { requireDb(); return db.getInvoice(id); });
handle("invoices:delete", (id) => { requireDb(); return db.deleteInvoice(id); });

/* ---------- morning milk (separate bulk-sale ledger) ---------- */
handle("morning:buyers", (inc) => { requireDb(); return db.listMorningBuyers(inc); });
handle("morning:buyerGet", (id) => { requireDb(); return db.getMorningBuyer(id); });
handle("morning:buyerSave", (b) => { requireDb(); return db.saveMorningBuyer(b); });
handle("morning:buyerDelete", (id) => { requireDb(); return db.deleteMorningBuyer(id); });
handle("morning:salesList", (filter) => { requireDb(); return db.listMorningSales(filter || {}); });
handle("morning:saleSave", (s) => { requireDb(); return db.saveMorningSale(s); });
handle("morning:saleDelete", (id) => { requireDb(); return db.deleteMorningSale(id); });
handle("morning:paymentsList", (filter) => { requireDb(); return db.listMorningPayments(filter || {}); });
handle("morning:paymentSave", (p) => { requireDb(); return db.saveMorningPayment(p); });
handle("morning:paymentDelete", (id) => { requireDb(); return db.deleteMorningPayment(id); });
handle("morning:settlements", () => { requireDb(); return db.morningSettlements(); });
handle("morning:sheet", (from, to, buyerId) => { requireDb(); return db.morningDailySheet(from, to, buyerId); });

handle("print:html", async (html) => {
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await pw.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return await new Promise((resolve) => {
    pw.webContents.print(
      { silent: false, printBackground: true, margins: { marginType: "none" } },
      (success, reason) => {
        pw.close();
        resolve({ success, reason });
      }
    );
  });
});

handle("print:pdf", async (html, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: "Save statement as PDF",
    defaultPath: (suggestedName || "statement") + ".pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (res.canceled) return { canceled: true };
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await pw.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const data = await pw.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
  fs.writeFileSync(res.filePath, data);
  pw.close();
  return { canceled: false, path: res.filePath };
});

// Many documents → pick ONE folder, write one PDF per document (e.g. one per client invoice).
handle("print:pdfMany", async (docs, folderName) => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose a folder to save the invoices in",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  let dir = res.filePaths[0];
  if (folderName) {
    dir = path.join(dir, folderName.replace(/[<>:"/\\|?*]+/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
  }
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const saved = [];
  try {
    for (const d of docs || []) {
      await pw.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(d.html));
      const data = await pw.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
      const file = path.join(dir, String(d.name || "invoice").replace(/[<>:"/\\|?*]+/g, "-") + ".pdf");
      fs.writeFileSync(file, data);
      saved.push(file);
    }
  } finally {
    pw.close();
  }
  return { canceled: false, dir, count: saved.length, files: saved };
});
