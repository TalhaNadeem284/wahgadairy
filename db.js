"use strict";

/**
 * SQLite (via sql.js / WASM) data layer for Wahga Dairy Farm.
 *
 * The database is a single .db file that normally lives inside a cloud-synced
 * folder (Google Drive / OneDrive / Dropbox) so two or three PCs can work off
 * the same data while each app itself stays fully offline.
 *
 * Concurrency strategy (deliberately simple, for a 1-3 person operation):
 *   - Every write goes through withLock(): a short-lived `<db>.lock` sidecar
 *     file guards same-machine races and gives other machines a hint.
 *   - ensureFresh() reloads the file from disk whenever its mtime changed
 *     (i.e. another PC's edit just synced in). It runs before every write and
 *     at the start of every read entrypoint, so screens always load current
 *     data and writes always apply on top of the latest synced state.
 *   - persist() writes atomically (temp file + rename).
 * Two people hitting "save" within the same couple-of-seconds sync window can
 * still have one edit lose to the other; the UI nudges users to avoid that and
 * cloud providers keep file version history as a backstop.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const initSqlJs = require("sql.js");

let SQL = null;
let db = null;
let dbFile = null;
let loadedMtimeMs = 0;

const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MS = 300;
const LOCK_MAX_TRIES = 25;

const MILK_CATEGORIES = ["cow", "buffalo", "mixed"];
const EXPENSE_CATEGORIES = ["petrol", "salary", "maintenance", "feed", "transport", "rent", "utilities", "other"];
const PAYMENT_METHODS = ["cash", "bank transfer", "easypaisa", "jazzcash", "cheque", "other"];

/* ------------------------------------------------------------------ */
/*  low level                                                          */
/* ------------------------------------------------------------------ */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function persist() {
  const data = Buffer.from(db.export());
  const tmp = dbFile + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  // Cloud-sync clients (Drive/OneDrive/Dropbox) briefly lock the file; retry the swap.
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, dbFile);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!["EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err;
      sleepSync(150);
    }
  }
  if (lastErr) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error("Could not save — the database file is locked (cloud sync may be busy). Try again in a moment.");
  }
  loadedMtimeMs = fileMtime(dbFile);
}

function loadFromDisk() {
  const bytes = fs.readFileSync(dbFile);
  db = new SQL.Database(bytes);
  db.run("PRAGMA foreign_keys = ON");
  loadedMtimeMs = fileMtime(dbFile);
}

/** Reload the DB if another process/PC changed the file since we loaded it. */
function ensureFresh() {
  if (!db || !dbFile) return false;
  const onDisk = fileMtime(dbFile);
  if (onDisk && Math.abs(onDisk - loadedMtimeMs) > 1) {
    try {
      loadFromDisk();
      return true;
    } catch {
      /* keep the in-memory copy if the file is mid-sync / unreadable */
    }
  }
  return false;
}

function lockPath() {
  return dbFile + ".lock";
}

function withLock(fn) {
  const lp = lockPath();
  let acquired = false;
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      const fd = fs.openSync(lp, "wx"); // fails if it already exists
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), ts: Date.now() }));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // someone holds it — steal it if it looks stale
      let stale = true;
      try {
        const info = JSON.parse(fs.readFileSync(lp, "utf8"));
        stale = Date.now() - (info.ts || 0) > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try { fs.unlinkSync(lp); } catch {}
      } else {
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }
  if (!acquired) throw new Error("Database is busy (another computer is saving). Please try again in a moment.");
  try {
    ensureFresh();
    return fn();
  } finally {
    try { fs.unlinkSync(lp); } catch {}
  }
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}
function get(sql, params = []) {
  return all(sql, params)[0];
}
function lastId() {
  return get("SELECT last_insert_rowid() AS id").id;
}

/** Single mutating statement, guarded + persisted. */
function run(sql, params = []) {
  return withLock(() => {
    db.run(sql, params);
    persist();
  });
}
/** Insert one row, return its new id. (export() resets last_insert_rowid, so read id before persist.) */
function insert(sql, params = []) {
  return withLock(() => {
    db.run(sql, params);
    const id = lastId();
    persist();
    return id;
  });
}
/** Multi-statement transaction, guarded + persisted once. */
function tx(fn) {
  return withLock(() => {
    db.run("BEGIN");
    try {
      const r = fn();
      db.run("COMMIT");
      persist();
      return r;
    } catch (e) {
      try { db.run("ROLLBACK"); } catch {}
      throw e;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  open / schema                                                      */
/* ------------------------------------------------------------------ */
async function ensureSql() {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: () => path.join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    });
  }
  return SQL;
}

/**
 * Point the app at a database file.
 * @param {string} targetPath  either an existing .db file, or a folder in
 *                             which "wahga-dairy.db" will be created.
 */
async function open(targetPath) {
  await ensureSql();

  let file = targetPath;
  try {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      file = path.join(targetPath, "wahga-dairy.db");
    }
  } catch {
    /* treat as a file path */
  }

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) throw new Error("That folder does not exist: " + dir);
  fs.mkdirSync(dir, { recursive: true });

  dbFile = file;

  if (fs.existsSync(dbFile)) {
    loadFromDisk();
  } else {
    db = new SQL.Database();
    db.run("PRAGMA foreign_keys = ON");
  }

  migrate();
  seedSettings();
  persist();
  return { path: dbFile, created: true };
}

function isOpen() {
  return !!db && !!dbFile;
}
function currentPath() {
  return dbFile;
}

function migrate() {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      price_per_litre REAL NOT NULL DEFAULT 0,
      milk_category TEXT NOT NULL DEFAULT 'mixed',
      opening_balance REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS milk_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      quantity_litres REAL NOT NULL,
      milk_category TEXT NOT NULL DEFAULT 'mixed',
      price_per_litre REAL NOT NULL,
      total_amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_entries_date ON milk_entries(date);
    CREATE INDEX IF NOT EXISTS idx_entries_client ON milk_entries(client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_entry_client_date_cat
      ON milk_entries(client_id, date, milk_category);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      quantity_litres REAL NOT NULL,
      price_per_litre REAL NOT NULL,
      total_cost REAL NOT NULL,
      supplier_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      issued_date TEXT NOT NULL,
      previous_balance REAL NOT NULL DEFAULT 0,
      period_litres REAL NOT NULL DEFAULT 0,
      period_billed REAL NOT NULL DEFAULT 0,
      period_paid REAL NOT NULL DEFAULT 0,
      total_due REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(issued_date);
    CREATE TABLE IF NOT EXISTS home_milk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'home',   -- 'home' (GHAR) | 'sample'
      litres REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_home_milk_date_kind ON home_milk(date, kind);
  `);
  // Columns added after the first release — safe on existing databases.
  ensureColumn("clients", "default_litres", "REAL NOT NULL DEFAULT 0");
  if (ensureColumn("purchases", "supplier", "TEXT")) {
    // Purchases used to keep the supplier name in supplier_notes — split it out.
    db.run("UPDATE purchases SET supplier = supplier_notes, supplier_notes = NULL WHERE supplier IS NULL AND supplier_notes IS NOT NULL");
  }
}

function ensureColumn(table, col, decl) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    return true;
  }
  return false;
}

function seedSettings() {
  const defaults = {
    shop_name: "Wahga Dairy Farm",
    shop_address: "",
    shop_phone: "",
    statement_footer: "Thank you for your business.",
    currency: "Rs",
    invoice_prefix: "INV-",
    next_invoice_no: "1",
    sample_rate: "205",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!get("SELECT value FROM settings WHERE key = ?", [k])) {
      db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [k, v]);
    }
  }
}

function bumpCounter(key, fallback = 1) {
  const row = get("SELECT value FROM settings WHERE key = ?", [key]);
  const n = parseInt(row ? row.value : String(fallback), 10) || fallback;
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, String(n + 1)]
  );
  return n;
}

/* ------------------------------------------------------------------ */
/*  settings                                                           */
/* ------------------------------------------------------------------ */
function getSettings() {
  ensureFresh();
  const out = {};
  for (const r of all("SELECT key, value FROM settings")) out[r.key] = r.value;
  return out;
}
function saveSettings(obj) {
  tx(() => {
    for (const [k, v] of Object.entries(obj)) {
      db.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [k, String(v ?? "")]
      );
    }
  });
  return getSettings();
}

/* ------------------------------------------------------------------ */
/*  clients                                                            */
/* ------------------------------------------------------------------ */
function clientBalance(id) {
  const c = get("SELECT opening_balance FROM clients WHERE id = ?", [id]);
  if (!c) return 0;
  const billed = get("SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ?", [id]).t;
  const paid = get("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ?", [id]).t;
  return round2(c.opening_balance + billed - paid);
}

function listClients(includeInactive) {
  ensureFresh();
  const rows = all(
    `SELECT * FROM clients ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`
  );
  return rows.map((c) => ({ ...c, balance: clientBalance(c.id) }));
}

/**
 * Settlement sheet — one row per client: total billed (opening balance + all
 * deliveries), total received (all payments), and what's still pending.
 * Mirrors the "BILL" tab of the owner's spreadsheet.
 */
function settlements(opts = {}) {
  ensureFresh();
  const clients = all(
    `SELECT * FROM clients ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`
  );
  const rows = clients.map((c) => {
    const billed = round2(
      c.opening_balance +
      get("SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ?", [c.id]).t
    );
    const received = round2(get("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ?", [c.id]).t);
    const lastPayment = get("SELECT MAX(date) d FROM payments WHERE client_id = ?", [c.id]).d || null;
    return {
      id: c.id, name: c.name, phone: c.phone || "",
      opening_balance: round2(c.opening_balance),
      billed, received, pending: round2(billed - received),
      last_payment: lastPayment,
      active: !!c.active,
    };
  });
  const totals = rows.reduce(
    (a, r) => ({
      opening_balance: round2(a.opening_balance + r.opening_balance),
      billed: round2(a.billed + r.billed),
      received: round2(a.received + r.received),
      pending: round2(a.pending + r.pending),
    }),
    { opening_balance: 0, billed: 0, received: 0, pending: 0 }
  );
  return { rows, totals, settings: getSettings(), generated: new Date().toLocaleDateString("en-CA") };
}
function getClient(id) {
  ensureFresh();
  const c = get("SELECT * FROM clients WHERE id = ?", [id]);
  if (!c) return null;
  c.balance = clientBalance(id);
  return c;
}
function saveClient(c) {
  const cat = MILK_CATEGORIES.includes(c.milk_category) ? c.milk_category : "mixed";
  const defL = Math.max(0, Number(c.default_litres) || 0);
  if (c.id) {
    run(
      `UPDATE clients SET name=?, phone=?, address=?, price_per_litre=?, milk_category=?,
        default_litres=?, opening_balance=?, active=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [
        c.name.trim(), c.phone || null, c.address || null,
        Number(c.price_per_litre) || 0, cat, defL,
        Number(c.opening_balance) || 0, c.active ? 1 : 0, c.note || null, c.id,
      ]
    );
    return getClient(c.id);
  }
  const id = insert(
    `INSERT INTO clients (name, phone, address, price_per_litre, milk_category, default_litres, opening_balance, active, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      c.name.trim(), c.phone || null, c.address || null,
      Number(c.price_per_litre) || 0, cat, defL,
      Number(c.opening_balance) || 0, c.active ? 1 : 0, c.note || null,
    ]
  );
  return getClient(id);
}
function deleteClient(id) {
  const entries = get("SELECT COUNT(*) c FROM milk_entries WHERE client_id = ?", [id]).c;
  const pays = get("SELECT COUNT(*) c FROM payments WHERE client_id = ?", [id]).c;
  if (entries || pays) {
    run("UPDATE clients SET active = 0, updated_at=datetime('now','localtime') WHERE id = ?", [id]);
    return "deactivated";
  }
  run("DELETE FROM clients WHERE id = ?", [id]);
  return "deleted";
}

/* ------------------------------------------------------------------ */
/*  milk entries                                                       */
/* ------------------------------------------------------------------ */
function listEntries(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.clientId) { where.push("e.client_id = ?"); params.push(filter.clientId); }
  if (filter.from) { where.push("e.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("e.date <= ?"); params.push(filter.to); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = filter.limit ? "LIMIT " + Number(filter.limit) : "LIMIT 500";
  return all(
    `SELECT e.*, c.name AS client_name
     FROM milk_entries e JOIN clients c ON c.id = e.client_id
     ${clause} ORDER BY e.date DESC, e.id DESC ${limit}`,
    params
  );
}

function saveEntry(e) {
  const qty = Number(e.quantity_litres) || 0;
  const price = Number(e.price_per_litre) || 0;
  if (qty <= 0) throw new Error("Quantity must be greater than 0.");
  if (price <= 0) throw new Error("Price per litre must be greater than 0.");
  const cat = MILK_CATEGORIES.includes(e.milk_category) ? e.milk_category : "mixed";
  const total = round2(qty * price);
  if (e.id) {
    run(
      `UPDATE milk_entries SET client_id=?, date=?, quantity_litres=?, milk_category=?,
        price_per_litre=?, total_amount=?, note=? WHERE id=?`,
      [e.client_id, e.date, qty, cat, price, total, e.note || null, e.id]
    );
    return get("SELECT * FROM milk_entries WHERE id = ?", [e.id]);
  }
  // One entry per client+date+category: fold a repeat add into an update.
  return tx(() => {
    const existing = get(
      "SELECT id FROM milk_entries WHERE client_id=? AND date=? AND milk_category=?",
      [e.client_id, e.date, cat]
    );
    if (existing) {
      db.run(
        "UPDATE milk_entries SET quantity_litres=?, price_per_litre=?, total_amount=?, note=? WHERE id=?",
        [qty, price, total, e.note || null, existing.id]
      );
      return get("SELECT * FROM milk_entries WHERE id = ?", [existing.id]);
    }
    db.run(
      "INSERT INTO milk_entries (client_id, date, quantity_litres, milk_category, price_per_litre, total_amount, note) VALUES (?,?,?,?,?,?,?)",
      [e.client_id, e.date, qty, cat, price, total, e.note || null]
    );
    return get("SELECT * FROM milk_entries WHERE id = ?", [lastId()]);
  });
}

function deleteEntry(id) {
  run("DELETE FROM milk_entries WHERE id = ?", [id]);
  return true;
}

/**
 * The daily-round workflow: one date, a row per active client with a litres
 * value. Rows with blank / zero litres are removed for that date+category;
 * rows with a value are inserted or updated. Everything in one transaction.
 */
function saveDailyRound(date, rows) {
  if (!date) throw new Error("Pick a date first.");
  return tx(() => {
    let saved = 0, cleared = 0;
    for (const r of rows) {
      const cid = r.client_id;
      const cat = MILK_CATEGORIES.includes(r.milk_category) ? r.milk_category : "mixed";
      const qty = Number(r.quantity_litres);
      const price = Number(r.price_per_litre) || 0;
      const existing = get(
        "SELECT id FROM milk_entries WHERE client_id=? AND date=? AND milk_category=?",
        [cid, date, cat]
      );
      if (!qty || qty <= 0) {
        if (existing) { db.run("DELETE FROM milk_entries WHERE id = ?", [existing.id]); cleared++; }
        continue;
      }
      if (price <= 0) throw new Error(`Price per litre missing for one of the clients.`);
      const total = round2(qty * price);
      if (existing) {
        db.run(
          "UPDATE milk_entries SET quantity_litres=?, milk_category=?, price_per_litre=?, total_amount=?, note=? WHERE id=?",
          [qty, cat, price, total, r.note || null, existing.id]
        );
      } else {
        db.run(
          "INSERT INTO milk_entries (client_id, date, quantity_litres, milk_category, price_per_litre, total_amount, note) VALUES (?,?,?,?,?,?,?)",
          [cid, date, qty, cat, price, total, r.note || null]
        );
      }
      saved++;
    }
    return { saved, cleared };
  });
}

/** Prefill the daily round: active clients + any entry they already have for `date`. */
function dailyRound(date) {
  ensureFresh();
  const clients = all("SELECT * FROM clients WHERE active = 1 ORDER BY name COLLATE NOCASE");
  const entries = date ? all("SELECT * FROM milk_entries WHERE date = ?", [date]) : [];
  const byClient = new Map();
  for (const e of entries) byClient.set(e.client_id, e);
  return clients.map((c) => {
    const e = byClient.get(c.id);
    return {
      client_id: c.id,
      name: c.name,
      milk_category: e ? e.milk_category : c.milk_category,
      price_per_litre: e ? e.price_per_litre : c.price_per_litre,
      quantity_litres: e ? e.quantity_litres : "",
      default_litres: c.default_litres || 0,
      entry_id: e ? e.id : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  payments                                                           */
/* ------------------------------------------------------------------ */
function listPayments(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.clientId) { where.push("p.client_id = ?"); params.push(filter.clientId); }
  if (filter.from) { where.push("p.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("p.date <= ?"); params.push(filter.to); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(
    `SELECT p.*, c.name AS client_name FROM payments p JOIN clients c ON c.id = p.client_id
     ${clause} ORDER BY p.date DESC, p.id DESC LIMIT 500`,
    params
  );
}
function savePayment(p) {
  const amount = Number(p.amount) || 0;
  if (amount <= 0) throw new Error("Payment amount must be greater than 0.");
  if (p.id) {
    run("UPDATE payments SET client_id=?, date=?, amount=?, method=?, note=? WHERE id=?", [
      p.client_id, p.date, amount, p.method || null, p.note || null, p.id,
    ]);
    return get("SELECT * FROM payments WHERE id = ?", [p.id]);
  }
  const id = insert("INSERT INTO payments (client_id, date, amount, method, note) VALUES (?,?,?,?,?)", [
    p.client_id, p.date, amount, p.method || null, p.note || null,
  ]);
  return get("SELECT * FROM payments WHERE id = ?", [id]);
}
function deletePayment(id) {
  run("DELETE FROM payments WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  purchases                                                          */
/* ------------------------------------------------------------------ */
function listPurchases(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.from) { where.push("date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("date <= ?"); params.push(filter.to); }
  if (filter.supplier && filter.supplier !== "all") {
    where.push("IFNULL(supplier,'') = ?"); params.push(filter.supplier);
  }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(`SELECT * FROM purchases ${clause} ORDER BY date DESC, id DESC LIMIT 500`, params);
}
function listSuppliers() {
  ensureFresh();
  return all(
    "SELECT supplier, COUNT(*) n, COALESCE(SUM(quantity_litres),0) litres, COALESCE(SUM(total_cost),0) cost FROM purchases WHERE supplier IS NOT NULL AND supplier <> '' GROUP BY supplier ORDER BY cost DESC"
  );
}
function savePurchase(p) {
  const qty = Number(p.quantity_litres) || 0;
  const price = Number(p.price_per_litre) || 0;
  if (qty <= 0) throw new Error("Quantity must be greater than 0.");
  if (price <= 0) throw new Error("Price per litre must be greater than 0.");
  const total = round2(qty * price);
  const supplier = (p.supplier || "").trim() || null;
  const notes = (p.supplier_notes || "").trim() || null;
  if (p.id) {
    run("UPDATE purchases SET date=?, quantity_litres=?, price_per_litre=?, total_cost=?, supplier=?, supplier_notes=? WHERE id=?", [
      p.date, qty, price, total, supplier, notes, p.id,
    ]);
    return get("SELECT * FROM purchases WHERE id = ?", [p.id]);
  }
  const id = insert(
    "INSERT INTO purchases (date, quantity_litres, price_per_litre, total_cost, supplier, supplier_notes) VALUES (?,?,?,?,?,?)",
    [p.date, qty, price, total, supplier, notes]
  );
  return get("SELECT * FROM purchases WHERE id = ?", [id]);
}
function deletePurchase(id) {
  run("DELETE FROM purchases WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  home / sample milk (not sold — GHAR)                               */
/* ------------------------------------------------------------------ */
function listHomeMilk(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.from) { where.push("date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("date <= ?"); params.push(filter.to); }
  if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(`SELECT * FROM home_milk ${clause} ORDER BY date DESC, kind LIMIT 800`, params);
}
function homeMilkForDate(date) {
  ensureFresh();
  const rows = all("SELECT kind, litres FROM home_milk WHERE date = ?", [date]);
  const out = { home: 0, sample: 0 };
  for (const r of rows) out[r.kind] = r.litres;
  return out;
}
/** Upsert one date+kind. litres <= 0 removes the row. */
function saveHomeMilk(h) {
  const kind = h.kind === "sample" ? "sample" : "home";
  const litres = Number(h.litres) || 0;
  return tx(() => {
    const existing = get("SELECT id FROM home_milk WHERE date = ? AND kind = ?", [h.date, kind]);
    if (litres <= 0) {
      if (existing) db.run("DELETE FROM home_milk WHERE id = ?", [existing.id]);
      return { removed: !!existing };
    }
    if (existing) {
      db.run("UPDATE home_milk SET litres = ?, note = ? WHERE id = ?", [litres, h.note || null, existing.id]);
    } else {
      db.run("INSERT INTO home_milk (date, kind, litres, note) VALUES (?,?,?,?)", [h.date, kind, litres, h.note || null]);
    }
    return { saved: true };
  });
}
function deleteHomeMilk(id) {
  run("DELETE FROM home_milk WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  expenses                                                           */
/* ------------------------------------------------------------------ */
function listExpenses(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.from) { where.push("date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("date <= ?"); params.push(filter.to); }
  if (filter.category && filter.category !== "all") { where.push("category = ?"); params.push(filter.category); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(`SELECT * FROM expenses ${clause} ORDER BY date DESC, id DESC LIMIT 500`, params);
}
function saveExpense(x) {
  const amount = Number(x.amount) || 0;
  if (amount <= 0) throw new Error("Amount must be greater than 0.");
  const category = (x.category || "other").trim().toLowerCase() || "other";
  if (x.id) {
    run("UPDATE expenses SET date=?, category=?, amount=?, notes=? WHERE id=?", [
      x.date, category, amount, x.notes || null, x.id,
    ]);
    return get("SELECT * FROM expenses WHERE id = ?", [x.id]);
  }
  const id = insert("INSERT INTO expenses (date, category, amount, notes) VALUES (?,?,?,?)", [
    x.date, category, amount, x.notes || null,
  ]);
  return get("SELECT * FROM expenses WHERE id = ?", [id]);
}
function deleteExpense(id) {
  run("DELETE FROM expenses WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  reports                                                            */
/* ------------------------------------------------------------------ */
function sumBetween(table, valueCol, from, to, extraSql = "", extraParams = []) {
  return round2(
    get(
      `SELECT COALESCE(SUM(${valueCol}),0) t FROM ${table} WHERE date BETWEEN ? AND ? ${extraSql}`,
      [from, to, ...extraParams]
    ).t
  );
}

function profitLoss(from, to) {
  ensureFresh();
  const revenue = sumBetween("milk_entries", "total_amount", from, to);
  const cogs = sumBetween("purchases", "total_cost", from, to);
  const totalExpenses = sumBetween("expenses", "amount", from, to);
  const grossProfit = round2(revenue - cogs);
  const netProfit = round2(grossProfit - totalExpenses);

  const litresSold = round2(get(
    "SELECT COALESCE(SUM(quantity_litres),0) t FROM milk_entries WHERE date BETWEEN ? AND ?", [from, to]
  ).t);
  const litresBought = round2(get(
    "SELECT COALESCE(SUM(quantity_litres),0) t FROM purchases WHERE date BETWEEN ? AND ?", [from, to]
  ).t);

  // "Sold basis": what the delivered milk actually cost.
  //  - If you sold more than you bought, the extra came from your own animals
  //    (free), so the cost of milk sold is simply everything you spent on milk.
  //  - Otherwise value the delivered litres at the average purchase rate, so a
  //    period isn't a huge loss just because stock / home-use milk was bought.
  const avgPurchaseRate = litresBought ? round2(cogs / litresBought) : 0;
  const costMilkSold = litresSold >= litresBought ? cogs : round2(litresSold * avgPurchaseRate);
  const marginOnSales = round2(revenue - costMilkSold);

  // Home milk (GHAR): used in the owner's own house — not sold, kept OUT of
  // operating profit but valued separately as a benefit (at avg sale price).
  // Sample milk: given free to clients — a marketing cost, valued at the
  // settings sample_rate and added to expenses so it DOES hit profit.
  const avgSalePrice = litresSold ? round2(revenue / litresSold) : 0;
  const sampleRate = Number((get("SELECT value FROM settings WHERE key='sample_rate'") || {}).value) || 205;
  const homeMilkLitres = round2(get(
    "SELECT COALESCE(SUM(litres),0) t FROM home_milk WHERE kind='home' AND date BETWEEN ? AND ?", [from, to]
  ).t);
  const sampleMilkLitres = round2(get(
    "SELECT COALESCE(SUM(litres),0) t FROM home_milk WHERE kind='sample' AND date BETWEEN ? AND ?", [from, to]
  ).t);
  const homeMilkValue = round2(homeMilkLitres * avgSalePrice);
  const sampleMilkCost = round2(sampleMilkLitres * sampleRate);

  const expensesWithSamples = round2(totalExpenses + sampleMilkCost);
  const operatingProfit = round2(marginOnSales - expensesWithSamples);
  const totalBenefit = round2(operatingProfit + homeMilkValue);

  const byCategory = all(
    "SELECT category, COALESCE(SUM(amount),0) amount, COUNT(*) n FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category",
    [from, to]
  );
  if (sampleMilkCost > 0) byCategory.push({ category: "sample milk", amount: sampleMilkCost, n: 0, auto: true });
  byCategory.sort((a, b) => b.amount - a.amount);

  // per-day series
  const dayRev = Object.fromEntries(all(
    "SELECT date, SUM(total_amount) v FROM milk_entries WHERE date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dayCogs = Object.fromEntries(all(
    "SELECT date, SUM(total_cost) v FROM purchases WHERE date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dayExp = Object.fromEntries(all(
    "SELECT date, SUM(amount) v FROM expenses WHERE date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const daySample = Object.fromEntries(all(
    "SELECT date, SUM(litres) v FROM home_milk WHERE kind='sample' AND date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dates = [...new Set([...Object.keys(dayRev), ...Object.keys(dayCogs), ...Object.keys(dayExp), ...Object.keys(daySample)])].sort();
  const days = dates.map((d) => {
    const rev = round2(dayRev[d] || 0);
    const cg = round2(dayCogs[d] || 0);
    const ex = round2((dayExp[d] || 0) + (daySample[d] || 0) * sampleRate);
    return { date: d, revenue: rev, cogs: cg, expenses: ex, net: round2(rev - cg - ex) };
  });

  return {
    from, to, revenue, cogs, grossProfit, totalExpenses, netProfit,
    litresSold, litresBought, avgPurchaseRate, costMilkSold, marginOnSales,
    operatingProfit, expensesWithSamples,
    avgSalePrice, sampleRate,
    homeMilkLitres, homeMilkValue, sampleMilkLitres, sampleMilkCost, totalBenefit,
    byCategory, days,
  };
}

function dashboard() {
  ensureFresh();
  const today = new Date().toLocaleDateString("en-CA");
  const monthStart = today.slice(0, 8) + "01";
  const todayLitres = round2(get(
    "SELECT COALESCE(SUM(quantity_litres),0) t FROM milk_entries WHERE date = ?", [today]
  ).t);
  const todayRevenue = round2(get(
    "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE date = ?", [today]
  ).t);
  const pl = profitLoss(monthStart, today);
  const monthCollected = round2(get(
    "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE date BETWEEN ? AND ?", [monthStart, today]
  ).t);
  const receivable = round2(
    listClients(true).reduce((a, c) => a + Math.max(0, c.balance), 0)
  );
  const activeClients = get("SELECT COUNT(*) c FROM clients WHERE active = 1").c;
  return {
    today,
    month_start: monthStart,
    today_litres: todayLitres,
    today_revenue: todayRevenue,
    month_revenue: pl.revenue,
    month_collected: monthCollected,
    month_expenses: pl.expensesWithSamples,
    month_net_profit: pl.operatingProfit,
    month_litres_sold: pl.litresSold,
    month_home_milk_litres: pl.homeMilkLitres,
    month_home_milk_value: pl.homeMilkValue,
    month_total_benefit: pl.totalBenefit,
    receivable,
    active_clients: activeClients,
  };
}

/* ------------------------------------------------------------------ */
/*  daily milk purchase sheet                                          */
/* ------------------------------------------------------------------ */
/**
 * One row per day for a range: how much milk was bought (litres + cost) and,
 * for comparison, how much was delivered to clients that day.
 */
function dailyMilkSheet(from, to, supplier) {
  ensureFresh();
  const supFilter = supplier && supplier !== "all" ? " AND IFNULL(supplier,'') = ?" : "";
  const supParam = supFilter ? [supplier] : [];
  const buys = all(
    `SELECT date,
            SUM(quantity_litres) litres,
            SUM(total_cost) cost,
            COUNT(*) n
     FROM purchases WHERE date BETWEEN ? AND ?${supFilter} GROUP BY date`,
    [from, to, ...supParam]
  );
  const sells = all(
    `SELECT date, SUM(quantity_litres) litres, SUM(total_amount) amount
     FROM milk_entries WHERE date BETWEEN ? AND ? GROUP BY date`,
    [from, to]
  );
  const buyMap = Object.fromEntries(buys.map((r) => [r.date, r]));
  const sellMap = Object.fromEntries(sells.map((r) => [r.date, r]));
  const dates = [...new Set([...Object.keys(buyMap), ...Object.keys(sellMap)])].sort();

  const rows = dates.map((date) => {
    const b = buyMap[date] || { litres: 0, cost: 0, n: 0 };
    const s = sellMap[date] || { litres: 0, amount: 0 };
    const purchasedL = round2(b.litres);
    return {
      date,
      purchased_litres: purchasedL,
      purchased_cost: round2(b.cost),
      avg_rate: purchasedL ? round2(b.cost / purchasedL) : 0,
      purchase_count: b.n,
      delivered_litres: round2(s.litres),
      delivered_amount: round2(s.amount),
      difference_litres: round2(purchasedL - s.litres),
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      purchased_litres: round2(a.purchased_litres + r.purchased_litres),
      purchased_cost: round2(a.purchased_cost + r.purchased_cost),
      delivered_litres: round2(a.delivered_litres + r.delivered_litres),
      delivered_amount: round2(a.delivered_amount + r.delivered_amount),
      difference_litres: round2(a.difference_litres + r.difference_litres),
    }),
    { purchased_litres: 0, purchased_cost: 0, delivered_litres: 0, delivered_amount: 0, difference_litres: 0 }
  );
  totals.avg_rate = totals.purchased_litres ? round2(totals.purchased_cost / totals.purchased_litres) : 0;

  const bySupplier = all(
    `SELECT COALESCE(NULLIF(supplier,''),'(no supplier)') supplier,
            COUNT(*) n, SUM(quantity_litres) litres, SUM(total_cost) cost
     FROM purchases WHERE date BETWEEN ? AND ?${supFilter}
     GROUP BY COALESCE(NULLIF(supplier,''),'(no supplier)') ORDER BY cost DESC`,
    [from, to, ...supParam]
  ).map((r) => ({
    supplier: r.supplier,
    n: r.n,
    litres: round2(r.litres),
    cost: round2(r.cost),
    avg_rate: r.litres ? round2(r.cost / r.litres) : 0,
  }));

  return { from, to, supplier: supplier || "all", rows, totals, by_supplier: bySupplier, settings: getSettings() };
}

/* ------------------------------------------------------------------ */
/*  client statement / invoice (for print / PDF -> WhatsApp)           */
/* ------------------------------------------------------------------ */
/** Shared period math used by both the running statement and formal invoices. */
function statementCore(clientId, from, to) {
  const client = get("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new Error("Client not found.");

  const priorBilled = get(
    "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date < ?",
    [clientId, from]
  ).t;
  const priorPaid = get(
    "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ? AND date < ?",
    [clientId, from]
  ).t;
  const openingBalance = round2(client.opening_balance + priorBilled - priorPaid);

  const entries = all(
    "SELECT * FROM milk_entries WHERE client_id = ? AND date BETWEEN ? AND ? ORDER BY date, id",
    [clientId, from, to]
  );
  const payments = all(
    "SELECT * FROM payments WHERE client_id = ? AND date BETWEEN ? AND ? ORDER BY date, id",
    [clientId, from, to]
  );

  // day-by-day summary (handy for weekly / 10-day / monthly invoices)
  const byDayMap = new Map();
  for (const e of entries) {
    const d = byDayMap.get(e.date) || { date: e.date, litres: 0, amount: 0 };
    d.litres = round2(d.litres + e.quantity_litres);
    d.amount = round2(d.amount + e.total_amount);
    byDayMap.set(e.date, d);
  }
  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const periodBilled = round2(entries.reduce((a, e) => a + e.total_amount, 0));
  const periodLitres = round2(entries.reduce((a, e) => a + e.quantity_litres, 0));
  const periodPaid = round2(payments.reduce((a, p) => a + p.amount, 0));
  const closingBalance = round2(openingBalance + periodBilled - periodPaid);

  return {
    client, from, to,
    entries, payments, by_day: byDay,
    opening_balance: openingBalance,
    period_billed: periodBilled,
    period_litres: periodLitres,
    period_paid: periodPaid,
    closing_balance: closingBalance,
  };
}

function clientStatement(clientId, from, to) {
  ensureFresh();
  return { ...statementCore(clientId, from, to), settings: getSettings() };
}

/* ---- invoices ---- */
function listInvoices(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.clientId) { where.push("i.client_id = ?"); params.push(filter.clientId); }
  if (filter.from) { where.push("i.issued_date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("i.issued_date <= ?"); params.push(filter.to); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(
    `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id
     ${clause} ORDER BY i.issued_date DESC, i.id DESC LIMIT 500`,
    params
  );
}

/** Preview the numbers for a would-be invoice without saving it. */
function invoicePreview(clientId, from, to) {
  ensureFresh();
  const core = statementCore(clientId, from, to);
  return { ...core, settings: getSettings() };
}

/** Create + persist an invoice, assigning the next number. */
function createInvoice(inv) {
  const { client_id, from, to, note } = inv;
  if (!client_id || !from || !to) throw new Error("Client and period are required.");
  if (from > to) throw new Error("The 'from' date is after the 'to' date.");
  return tx(() => {
    const core = statementCore(client_id, from, to);
    const settings = getSettings();
    const prefix = settings.invoice_prefix || "INV-";
    const n = bumpCounter("next_invoice_no");
    const invoiceNo = prefix + String(n).padStart(4, "0");
    const issued = new Date().toLocaleDateString("en-CA");
    db.run(
      `INSERT INTO invoices
       (invoice_no, client_id, period_from, period_to, issued_date,
        previous_balance, period_litres, period_billed, period_paid, total_due, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        invoiceNo, client_id, from, to, issued,
        core.opening_balance, core.period_litres, core.period_billed,
        core.period_paid, core.closing_balance, note || null,
      ]
    );
    return getInvoice(lastId());
  });
}

function getInvoice(id) {
  ensureFresh();
  const inv = get(
    "SELECT i.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?",
    [id]
  );
  if (!inv) return null;
  // Recompute everything live for the invoice's period so the line items and
  // the totals can never disagree (e.g. after a delivery was fixed later).
  // Only invoice_no / issued_date / note are kept from the stored row; the
  // period_* columns on the row remain a snapshot of what was billed at issue.
  const core = statementCore(inv.client_id, inv.period_from, inv.period_to);
  inv.entries = core.entries;
  inv.payments = core.payments;
  inv.by_day = core.by_day;
  inv.snapshot_total_due = inv.total_due;
  inv.previous_balance = core.opening_balance;
  inv.period_litres = core.period_litres;
  inv.period_billed = core.period_billed;
  inv.period_paid = core.period_paid;
  inv.total_due = core.closing_balance;
  inv.settings = getSettings();
  inv.client = get("SELECT * FROM clients WHERE id = ?", [inv.client_id]);
  return inv;
}

function deleteInvoice(id) {
  run("DELETE FROM invoices WHERE id = ?", [id]);
  return true;
}

module.exports = {
  MILK_CATEGORIES, EXPENSE_CATEGORIES, PAYMENT_METHODS,
  open, isOpen, currentPath, ensureFresh, fileMtime,
  getLoadedMtime: () => loadedMtimeMs,
  getSettings, saveSettings,
  listClients, getClient, saveClient, deleteClient,
  listEntries, saveEntry, deleteEntry, saveDailyRound, dailyRound,
  listPayments, savePayment, deletePayment, settlements,
  listPurchases, savePurchase, deletePurchase, listSuppliers,
  listHomeMilk, homeMilkForDate, saveHomeMilk, deleteHomeMilk,
  listExpenses, saveExpense, deleteExpense,
  profitLoss, dashboard, clientStatement, dailyMilkSheet,
  listInvoices, invoicePreview, createInvoice, getInvoice, deleteInvoice,
};
