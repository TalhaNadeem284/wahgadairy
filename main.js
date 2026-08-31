"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const config = require("./config");

let win;
let changePollTimer = null;

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

async function tryOpenConfiguredDb() {
  const dbPath = config.get("dbPath");
  if (!dbPath) return { ok: false, reason: "not-configured" };
  try {
    const folder = path.dirname(dbPath);
    if (!fs.existsSync(folder)) return { ok: false, reason: "folder-missing", dbPath };
    await db.open(dbPath);
    return { ok: true, dbPath: db.currentPath() };
  } catch (err) {
    return { ok: false, reason: "error", error: err.message, dbPath };
  }
}

function startChangePoll() {
  if (changePollTimer) clearInterval(changePollTimer);
  changePollTimer = setInterval(() => {
    if (!db.isOpen() || !win || win.isDestroyed()) return;
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
  open: db.isOpen(),
  path: db.isOpen() ? db.currentPath() : config.get("dbPath") || null,
  configuredPath: config.get("dbPath") || null,
}));

handle("db:pick", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose the folder for the shared database (e.g. a Google Drive / OneDrive folder)",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const info = await db.open(res.filePaths[0]);
  config.set("dbPath", info.path);
  return { canceled: false, path: info.path };
});

handle("db:pickExisting", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Open an existing Wahga Dairy database file",
    properties: ["openFile"],
    filters: [{ name: "Database", extensions: ["db", "sqlite", "sqlite3"] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const info = await db.open(res.filePaths[0]);
  config.set("dbPath", info.path);
  return { canceled: false, path: info.path };
});

handle("db:openFolder", () => {
  if (!db.isOpen()) throw new Error("No database open.");
  shell.showItemInFolder(db.currentPath());
  return true;
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

/* ---------- payments ---------- */
handle("payments:list", (filter) => { requireDb(); return db.listPayments(filter || {}); });
handle("payments:save", (p) => { requireDb(); return db.savePayment(p); });
handle("payments:delete", (id) => { requireDb(); return db.deletePayment(id); });

/* ---------- purchases ---------- */
handle("purchases:list", (filter) => { requireDb(); return db.listPurchases(filter || {}); });
handle("purchases:save", (p) => { requireDb(); return db.savePurchase(p); });
handle("purchases:delete", (id) => { requireDb(); return db.deletePurchase(id); });

/* ---------- expenses ---------- */
handle("expenses:list", (filter) => { requireDb(); return db.listExpenses(filter || {}); });
handle("expenses:save", (x) => { requireDb(); return db.saveExpense(x); });
handle("expenses:delete", (id) => { requireDb(); return db.deleteExpense(id); });

/* ---------- reports ---------- */
handle("reports:profitLoss", (from, to) => { requireDb(); return db.profitLoss(from, to); });
handle("reports:dashboard", () => { requireDb(); return db.dashboard(); });

/* ---------- statement ---------- */
handle("statement:get", (clientId, from, to) => { requireDb(); return db.clientStatement(clientId, from, to); });

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
