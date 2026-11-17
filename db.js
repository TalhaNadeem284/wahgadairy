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
let loadedSize = 0;

const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MS = 300;
const LOCK_MAX_TRIES = 25;

const MILK_CATEGORIES = ["cow", "buffalo", "mixed"];
const EXPENSE_CATEGORIES = ["petrol", "salary", "maintenance", "feed", "transport", "rent", "utilities", "other"];
/** Society groups — clients are listed in this order on every page. */
const SOCIETIES = ["AWT", "Dream Garden", "Tricon", "Engineering Town", "Model Town", "Other"];
const SOCIETY_RANK = "CASE society WHEN 'AWT' THEN 1 WHEN 'Dream Garden' THEN 2 WHEN 'Tricon' THEN 3 WHEN 'Engineering Town' THEN 4 WHEN 'Model Town' THEN 5 ELSE 6 END";
/** Guess the society from a client's name / address (e.g. "17 K DREAM GARDEN" → Dream Garden). */
function guessSociety(...texts) {
  const t = texts.filter(Boolean).join(" ");
  if (/\bAWT\b/i.test(t)) return "AWT";
  if (/DREAM\s*GAR/i.test(t)) return "Dream Garden";
  if (/T(RI|IR)CON/i.test(t)) return "Tricon";
  if (/ENG\w*\s*T(O|W)\w*N/i.test(t)) return "Engineering Town";   // also the sheet's "ENGREEING TWON/TOEN"
  if (/MODEL\s*TOWN/i.test(t)) return "Model Town";
  return "Other";
}
const PAYMENT_METHODS = ["cash", "bank transfer", "easypaisa", "jazzcash", "cheque", "other"];

/* ------------------------------------------------------------------ */
/*  low level                                                          */
/* ------------------------------------------------------------------ */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/* Remote (server) mode: the DB lives only in memory here and the server's
 * persist hook mirrors changed rows to the online database (Turso). */
let remoteMode = false;
let persistHook = null;

function persist() {
  if (remoteMode) { if (persistHook) persistHook(); return; }
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
  loadedSize = fileSize(dbFile);
}

function loadFromDisk() {
  const bytes = fs.readFileSync(dbFile);
  db = new SQL.Database(bytes);
  db.run("PRAGMA foreign_keys = ON");
  loadedMtimeMs = fileMtime(dbFile);
  loadedSize = fileSize(dbFile);
}

/** Reload the DB if another process/PC changed the file since we loaded it. */
function ensureFresh() {
  if (remoteMode || !db || !dbFile) return false;
  const onDisk = fileMtime(dbFile);
  if (onDisk && (Math.abs(onDisk - loadedMtimeMs) > 1 || fileSize(dbFile) !== loadedSize)) {
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
  if (remoteMode) return fn(); // the server runs one request at a time
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
  let seededFrom = null;

  if (fs.existsSync(dbFile)) {
    loadFromDisk();
  } else {
    // First time at this location: start from the database that shipped with
    // the app (current clients, deliveries, purchases, expenses…) if present.
    const seedPath = path.join(__dirname, "seed", "wahga-dairy-seed.db");
    try {
      if (fs.existsSync(seedPath)) {
        fs.copyFileSync(seedPath, dbFile);
        loadFromDisk();
        seededFrom = "seed";
      }
    } catch { /* fall through to an empty database */ }
    if (!db) {
      db = new SQL.Database();
      db.run("PRAGMA foreign_keys = ON");
    }
  }

  migrate();
  seedSettings();
  persist();
  return { path: dbFile, seededFrom };
}

/**
 * Server mode: build the database in memory with `loader(db)` (which fills it
 * from the online database), then run the normal migrations. `hook` is called
 * by persist() after every write.
 */
async function openRemote(loader, hook) {
  await ensureSql();
  remoteMode = true;
  dbFile = null;
  persistHook = null;
  db = new SQL.Database();
  await loader(db);
  db.run("PRAGMA foreign_keys = ON");
  persistHook = hook || null;
  migrate();
  seedSettings();
  persist();
  return db;
}
function rawDb() {
  return db;
}
function exportBytes() {
  return Buffer.from(db.export());
}

function isOpen() {
  return !!db && (!!dbFile || remoteMode);
}
function currentPath() {
  return remoteMode ? "online" : dbFile;
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

    /* -------- Morning milk — a SEPARATE bulk-sale ledger -------- */
    CREATE TABLE IF NOT EXISTS morning_buyers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      price_per_litre REAL NOT NULL DEFAULT 0,
      opening_balance REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS morning_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id INTEGER NOT NULL REFERENCES morning_buyers(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      quantity_litres REAL NOT NULL,
      price_per_litre REAL NOT NULL,
      total_amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_msales_date ON morning_sales(date);
    CREATE INDEX IF NOT EXISTS idx_msales_buyer ON morning_sales(buyer_id);
    CREATE TABLE IF NOT EXISTS morning_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id INTEGER NOT NULL REFERENCES morning_buyers(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_mpay_buyer ON morning_payments(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_mpay_date ON morning_payments(date);
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_suppay_supplier ON supplier_payments(supplier);

    /* -------- Loans taken (borrowed money, repaid later) — NOT income / expense -------- */
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lender TEXT NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'taken',   -- 'taken' | 'repaid'
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_loans_lender ON loans(lender);

    /* -------- Staff on monthly salary. Salary PAID is an expense row
       (category 'salary', expenses.staff_id) so it counts in profit. -------- */
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT,
      monthly_salary REAL NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    /* Salary EARNED per month for workers whose salary is not fixed. */
    CREATE TABLE IF NOT EXISTS staff_salary_months (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      month TEXT NOT NULL,                 -- YYYY-MM
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_salary_month ON staff_salary_months(staff_id, month);
    -- Milk order plan: how much each client will take on a date (0 = no milk
    -- that day), worked out before the round so the supplier order is right.
    CREATE TABLE IF NOT EXISTS milk_plan (
      date TEXT NOT NULL,
      client_id INTEGER NOT NULL,
      milk_category TEXT NOT NULL,
      litres REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, client_id, milk_category)
    );
    CREATE TABLE IF NOT EXISTS milk_plan_day (
      date TEXT PRIMARY KEY,
      home REAL NOT NULL DEFAULT 0,
      sample REAL NOT NULL DEFAULT 0,
      spare REAL NOT NULL DEFAULT 0,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suppay_date ON supplier_payments(date);
  `);
  // Columns added after the first release — safe on existing databases.
  ensureColumn("clients", "default_litres", "REAL NOT NULL DEFAULT 0");
  if (ensureColumn("purchases", "supplier", "TEXT")) {
    // Purchases used to keep the supplier name in supplier_notes — split it out.
    db.run("UPDATE purchases SET supplier = supplier_notes, supplier_notes = NULL WHERE supplier IS NULL AND supplier_notes IS NOT NULL");
  }
  if (ensureColumn("purchases", "amount_paid", "REAL")) {
    // Everything bought before this feature is treated as paid in full.
    db.run("UPDATE purchases SET amount_paid = total_cost WHERE amount_paid IS NULL");
  }
  // Clients who pay cash at the moment milk is given (walk-in / cash sale):
  // every delivery day gets a matching auto payment, so they never owe anything.
  ensureColumn("clients", "billing_cycle", "TEXT NOT NULL DEFAULT 'monthly'");
  ensureColumn("expenses", "staff_id", "INTEGER");   // salary payments → which worker
  ensureColumn("expenses", "pay_kind", "TEXT");
  ensureColumn("expenses", "paid_date", "TEXT");     // staff payments: day the cash was actually handed over (date = month it counts in)      // staff payments: 'salary' | 'advance' (advance is taken off salary)
  ensureColumn("staff", "opening_owed", "REAL NOT NULL DEFAULT 0");
  ensureColumn("staff", "salary_type", "TEXT NOT NULL DEFAULT 'fixed'");   // 'fixed' | 'variable' (entered month by month)   // salary already owed before start_date (e.g. last month)
  ensureColumn("clients", "society", "TEXT");
  for (const c of all("SELECT id, name, address FROM clients WHERE society IS NULL OR society = ''")) {
    db.run("UPDATE clients SET society = ? WHERE id = ?", [guessSociety(c.name, c.address), c.id]);
  }
  // Areas added later (Engineering Town, Model Town): move clients that were
  // auto-filed under "Other" into their own group.
  for (const c of all("SELECT id, name, address FROM clients WHERE society = 'Other'")) {
    const g = guessSociety(c.name, c.address);
    if (g !== "Other") db.run("UPDATE clients SET society = ? WHERE id = ?", [g, c.id]);
  }
  if (ensureColumn("clients", "cash_on_delivery", "INTEGER NOT NULL DEFAULT 0")) {
    db.run("UPDATE clients SET cash_on_delivery = 1 WHERE name LIKE 'Cash sale%'");
    db.run(
      `UPDATE payments SET note = ? WHERE note LIKE 'Cash sale%paid on the spot'
         AND client_id IN (SELECT id FROM clients WHERE cash_on_delivery = 1)`,
      [COD_NOTE]
    );
  }
}

const BILLING_CYCLES = ["10day", "monthly"]; // every 10 days (1-10, 11-20, 21-end) | once a month

const COD_NOTE = "Cash on delivery (auto)";
/** Keep a cash-on-delivery client's auto payment for `date` equal to that day's milk total. */
function syncCashOnDelivery(clientId, date) {
  const c = get("SELECT cash_on_delivery FROM clients WHERE id = ?", [clientId]);
  if (!c || !c.cash_on_delivery) return;
  const total = round2(get(
    "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date = ?", [clientId, date]
  ).t);
  const auto = get("SELECT id FROM payments WHERE client_id = ? AND date = ? AND note = ?", [clientId, date, COD_NOTE]);
  if (total <= 0) {
    if (auto) db.run("DELETE FROM payments WHERE id = ?", [auto.id]);
  } else if (auto) {
    db.run("UPDATE payments SET amount = ? WHERE id = ?", [total, auto.id]);
  } else {
    db.run("INSERT INTO payments (client_id, date, amount, method, note) VALUES (?,?,?,?,?)", [clientId, date, total, "cash", COD_NOTE]);
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
    home_milk_rate: "0",   // 0 = value home (GHAR) milk at the average selling price
    pay_bank_name: "",
    pay_account_title: "",
    pay_account_no: "",
    pay_wallet: "",
    pay_note: "",
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
    `SELECT * FROM clients ${includeInactive ? "" : "WHERE active = 1"} ORDER BY ${SOCIETY_RANK}, name COLLATE NOCASE`
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
    `SELECT * FROM clients ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY ${SOCIETY_RANK}, name COLLATE NOCASE`
  );
  // Split each pending amount into "earlier months" vs "this month" — same FIFO
  // rule as the dashboard: every payment clears the OLDEST debt first.
  const today = new Date().toLocaleDateString("en-CA");
  const monthStart = /^\d{4}-\d{2}-01$/.test(opts.monthStart || "") ? opts.monthStart : today.slice(0, 8) + "01";
  const rows = clients.map((c) => {
    const billed = round2(
      c.opening_balance +
      get("SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ?", [c.id]).t
    );
    const received = round2(get("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ?", [c.id]).t);
    const lastPayment = get("SELECT MAX(date) d FROM payments WHERE client_id = ?", [c.id]).d || null;
    const pending = round2(billed - received);
    const billedPrior = round2(
      c.opening_balance +
      get("SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date < ?", [c.id, monthStart]).t
    );
    const priorPending = round2(Math.max(0, billedPrior - received));
    const currentPending = round2(pending - priorPending);

    // Latest invoice for this client, plus payments made since it was issued —
    // so the settlement row can show "invoice INV-0007 · paid in full", etc.
    const invDues = clientInvoiceDues(c.id);
    let invoice = null;
    if (invDues.length) {
      const li = invDues[0];
      invoice = {
        invoice_no: li.invoice_no,
        issued_date: li.issued_date,
        total_due: li.total_due,
        paid_since: li.paid_after,
        outstanding: li.outstanding,
        status: li.status,
        count: invDues.length,
      };
    }

    // Overall settlement state (independent of any invoice).
    const state = pending <= 0.5 ? "settled" : received > 0.5 ? "partial" : "unpaid";

    return {
      id: c.id, name: c.name, phone: c.phone || "", society: c.society || "Other",
      opening_balance: round2(c.opening_balance),
      billed, received, pending,
      prior_pending: priorPending, current_pending: currentPending,
      last_payment: lastPayment,
      invoice, state,
      active: !!c.active,
    };
  });
  const totals = rows.reduce(
    (a, r) => ({
      opening_balance: round2(a.opening_balance + r.opening_balance),
      billed: round2(a.billed + r.billed),
      received: round2(a.received + r.received),
      pending: round2(a.pending + r.pending),
      prior_pending: round2(a.prior_pending + r.prior_pending),
      current_pending: round2(a.current_pending + r.current_pending),
    }),
    { opening_balance: 0, billed: 0, received: 0, pending: 0, prior_pending: 0, current_pending: 0 }
  );
  return { rows, totals, month_start: monthStart, settings: getSettings(), generated: today };
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
  const society = SOCIETIES.includes(c.society) ? c.society : guessSociety(c.name, c.address);
  if (c.id) {
    const before = get("SELECT default_litres FROM clients WHERE id = ?", [c.id]);
    // usual litres changed: today's (and later) saved Milk Orders follow it, so Daily
    // Entry doesn't keep showing the old amount (only where the order has just one kind)
    if (before && Number(before.default_litres || 0) !== defL) {
      run(
        `UPDATE milk_plan SET litres = ? WHERE client_id = ? AND milk_category = ? AND date >= date('now','localtime')
           AND date IN (SELECT date FROM milk_plan WHERE client_id = ? GROUP BY date HAVING COUNT(*) = 1)`,
        [defL, c.id, cat, c.id]
      );
    }
    run(
      `UPDATE clients SET name=?, phone=?, address=?, price_per_litre=?, milk_category=?,
        default_litres=?, opening_balance=?, active=?, note=?, cash_on_delivery=?,
        billing_cycle=COALESCE(?, billing_cycle), society=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [
        c.name.trim(), c.phone || null, c.address || null,
        Number(c.price_per_litre) || 0, cat, defL,
        Number(c.opening_balance) || 0, c.active ? 1 : 0, c.note || null, c.cash_on_delivery ? 1 : 0,
        BILLING_CYCLES.includes(c.billing_cycle) ? c.billing_cycle : null, society, c.id,
      ]
    );
    if (c.cash_on_delivery) syncAllCashOnDelivery(c.id);
    return getClient(c.id);
  }
  const id = insert(
    `INSERT INTO clients (name, phone, address, price_per_litre, milk_category, default_litres, opening_balance, active, note, cash_on_delivery, billing_cycle, society)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c.name.trim(), c.phone || null, c.address || null,
      Number(c.price_per_litre) || 0, cat, defL,
      Number(c.opening_balance) || 0, c.active ? 1 : 0, c.note || null, c.cash_on_delivery ? 1 : 0,
      BILLING_CYCLES.includes(c.billing_cycle) ? c.billing_cycle : "monthly", society,
    ]
  );
  return getClient(id);
}
/** Turning cash-on-delivery on for a client: give every delivery day its auto payment. */
function syncAllCashOnDelivery(clientId) {
  tx(() => {
    for (const r of all("SELECT DISTINCT date FROM milk_entries WHERE client_id = ?", [clientId])) syncCashOnDelivery(clientId, r.date);
  });
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
  const limit = filter.limit ? "LIMIT " + Number(filter.limit) : (filter.from || filter.to || filter.clientId) ? "" : "LIMIT 500";
  return all(
    `SELECT e.*, c.name AS client_name, c.society AS society
     FROM milk_entries e JOIN clients c ON c.id = e.client_id
     ${clause} ORDER BY e.date DESC, CASE c.society WHEN 'AWT' THEN 1 WHEN 'Dream Garden' THEN 2 WHEN 'Tricon' THEN 3 ELSE 4 END, c.name COLLATE NOCASE, e.id ${limit}`,
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
    tx(() => syncCashOnDelivery(e.client_id, e.date));
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
      syncCashOnDelivery(e.client_id, e.date);
      return get("SELECT * FROM milk_entries WHERE id = ?", [existing.id]);
    }
    db.run(
      "INSERT INTO milk_entries (client_id, date, quantity_litres, milk_category, price_per_litre, total_amount, note) VALUES (?,?,?,?,?,?,?)",
      [e.client_id, e.date, qty, cat, price, total, e.note || null]
    );
    const newId = lastId();
    syncCashOnDelivery(e.client_id, e.date);
    return get("SELECT * FROM milk_entries WHERE id = ?", [newId]);
  });
}

function deleteEntry(id) {
  const e = get("SELECT client_id, date FROM milk_entries WHERE id = ?", [id]);
  tx(() => {
    db.run("DELETE FROM milk_entries WHERE id = ?", [id]);
    if (e) syncCashOnDelivery(e.client_id, e.date);
  });
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
      // Row's milk type was changed: drop the entry saved under the old type.
      if (r.orig_category && r.orig_category !== cat) {
        const old = get("SELECT id FROM milk_entries WHERE client_id=? AND date=? AND milk_category=?", [cid, date, r.orig_category]);
        if (old) { db.run("DELETE FROM milk_entries WHERE id = ?", [old.id]); if (!qty || qty <= 0) cleared++; }
      }
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
    for (const cid of new Set(rows.map((r) => r.client_id))) syncCashOnDelivery(cid, date);
    return { saved, cleared };
  });
}

/** Prefill the daily round: active clients + any entry they already have for `date`. */
function dailyRound(date) {
  ensureFresh();
  const clients = all(`SELECT * FROM clients WHERE active = 1 ORDER BY ${SOCIETY_RANK}, name COLLATE NOCASE`);
  const entries = date ? all("SELECT * FROM milk_entries WHERE date = ?", [date]) : [];
  // A client can take more than one milk type on a day (e.g. cow + buffalo):
  // one row per saved entry, or a single blank row in their usual type.
  const byClient = new Map();
  for (const e of entries) {
    if (!byClient.has(e.client_id)) byClient.set(e.client_id, []);
    byClient.get(e.client_id).push(e);
  }
  // Last delivery day before `date` per client: a client who took two kinds that
  // day (same house, e.g. cow + buffalo) gets one blank row per kind, each with
  // its own rate and usual litres, instead of one combined row.
  const lastDay = new Map();
  const typePrices = new Map(); // client -> { category: latest rate }
  if (date) {
    for (const e of all(
      `SELECT e.* FROM milk_entries e JOIN (SELECT client_id, MAX(date) d FROM milk_entries WHERE date < ? GROUP BY client_id) m
         ON m.client_id = e.client_id AND m.d = e.date ORDER BY e.id`, [date])) {
      if (!lastDay.has(e.client_id)) lastDay.set(e.client_id, []);
      lastDay.get(e.client_id).push(e);
    }
    for (const e of all(
      `SELECT e.client_id, e.milk_category, e.price_per_litre FROM milk_entries e JOIN
         (SELECT client_id, milk_category, MAX(date) d FROM milk_entries WHERE date <= ? GROUP BY client_id, milk_category) m
         ON m.client_id = e.client_id AND m.milk_category = e.milk_category AND m.d = e.date ORDER BY e.id`, [date])) {
      if (!typePrices.has(e.client_id)) typePrices.set(e.client_id, {});
      typePrices.get(e.client_id)[e.milk_category] = e.price_per_litre;
    }
  }
  // A saved Milk Order plan for this date decides the "usual" amounts:
  // planned kinds/litres per client, 0 for clients who said no milk.
  const planByClient = new Map();
  if (date) for (const p of all("SELECT * FROM milk_plan WHERE date = ?", [date])) {
    if (!planByClient.has(p.client_id)) planByClient.set(p.client_id, []);
    planByClient.get(p.client_id).push(p);
  }
  const rows = [];
  for (const c of clients) {
    const tp = { [c.milk_category]: c.price_per_litre, ...(typePrices.get(c.id) || {}) };
    const saved = byClient.get(c.id);
    const plan = planByClient.get(c.id);
    let prev = lastDay.get(c.id) || [];
    if (plan) prev = plan.map((p) => ({ milk_category: p.milk_category, quantity_litres: p.litres, price_per_litre: tp[p.milk_category] || c.price_per_litre }));
    if (saved) {
      saved.forEach((e, i) => rows.push({
        client_id: c.id, name: c.name, society: c.society || "Other",
        milk_category: e.milk_category, orig_category: e.milk_category,
        price_per_litre: e.price_per_litre, quantity_litres: e.quantity_litres,
        default_litres: (plan || prev.length > 1) ? (prev.find((p) => p.milk_category === e.milk_category)?.quantity_litres || 0) : (i === 0 ? (c.default_litres || 0) : 0),
        primary: i === 0, entry_id: e.id, type_prices: tp, in_plan: !!plan,
      }));
      // planned kinds that aren't saved yet for this date
      if (plan) for (const p of plan) {
        if (saved.some((e) => e.milk_category === p.milk_category)) continue;
        rows.push({
          client_id: c.id, name: c.name, society: c.society || "Other", milk_category: p.milk_category, orig_category: null,
          price_per_litre: tp[p.milk_category] || c.price_per_litre, quantity_litres: "",
          default_litres: p.litres, primary: false, entry_id: null, type_prices: tp, in_plan: true,
        });
      }
    } else if (plan || prev.length > 1) {
      // sort so the client's own (primary) kind comes first
      prev.sort((a, b) => (b.milk_category === c.milk_category) - (a.milk_category === c.milk_category));
      prev.forEach((e, i) => rows.push({
        client_id: c.id, name: c.name, society: c.society || "Other",
        milk_category: e.milk_category, orig_category: null,
        price_per_litre: e.price_per_litre, quantity_litres: "",
        default_litres: e.quantity_litres, primary: i === 0, entry_id: null, type_prices: tp, in_plan: !!plan,
      }));
    } else {
      rows.push({
        client_id: c.id, name: c.name, society: c.society || "Other",
        milk_category: c.milk_category, orig_category: null,
        price_per_litre: c.price_per_litre, quantity_litres: "",
        default_litres: c.default_litres || 0, primary: true, entry_id: null, type_prices: tp, in_plan: false,
      });
    }
  }
  return rows;
}

/* ---- milk order plan (how much to ask the supplier for) ---- */
function milkPlan(date) {
  ensureFresh();
  if (!date) throw new Error("Pick a date first.");
  const hasPlan = !!get("SELECT 1 x FROM milk_plan WHERE date = ? LIMIT 1", [date]);
  const rows = dailyRound(date).map((r) => ({
    client_id: r.client_id, name: r.name, society: r.society, milk_category: r.milk_category, primary: r.primary,
    price_per_litre: r.price_per_litre, type_prices: r.type_prices,
    usual: Number(r.default_litres) || 0,
    delivered: r.entry_id ? Number(r.quantity_litres) || 0 : null,
  }));
  const day = get("SELECT * FROM milk_plan_day WHERE date = ?", [date]);
  // no plan yet: suggest home / samples from the most recent day that had them
  let home = day ? day.home : 0, sample = day ? day.sample : 0;
  if (!day) {
    const h = get("SELECT litres FROM home_milk WHERE kind='home' AND date <= ? ORDER BY date DESC LIMIT 1", [date]);
    home = h ? h.litres : 0;
  }
  const bought = get("SELECT COALESCE(SUM(quantity_litres),0) t FROM purchases WHERE date = ?", [date]).t;
  return { date, has_plan: hasPlan, rows, home, sample, spare: day ? day.spare : 0, note: day?.note || "", bought: round2(bought) };
}
function saveMilkPlan(date, rows, extra = {}) {
  if (!date) throw new Error("Pick a date first.");
  return tx(() => {
    db.run("DELETE FROM milk_plan WHERE date = ?", [date]);
    let total = 0;
    for (const r of rows || []) {
      const cat = MILK_CATEGORIES.includes(r.milk_category) ? r.milk_category : "mixed";
      const l = Math.max(0, Number(r.litres) || 0);
      total += l;
      db.run(
        `INSERT INTO milk_plan (date, client_id, milk_category, litres) VALUES (?,?,?,?)
         ON CONFLICT(date, client_id, milk_category) DO UPDATE SET litres = litres + excluded.litres`,
        [date, r.client_id, cat, l]);
    }
    db.run(
      `INSERT INTO milk_plan_day (date, home, sample, spare, note) VALUES (?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET home=excluded.home, sample=excluded.sample, spare=excluded.spare, note=excluded.note`,
      [date, Number(extra.home) || 0, Number(extra.sample) || 0, Number(extra.spare) || 0, extra.note || null]);
    return { litres: round2(total) };
  });
}
function deleteMilkPlan(date) {
  return tx(() => {
    db.run("DELETE FROM milk_plan WHERE date = ?", [date]);
    db.run("DELETE FROM milk_plan_day WHERE date = ?", [date]);
    return true;
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
const SUPPLIER_KEY = "COALESCE(NULLIF(TRIM(supplier),''),'(no supplier)')";

/** For every credit purchase, how much of it is STILL unpaid after applying
 *  each supplier's payments oldest-purchase-first (FIFO). Returns a map
 *  { purchaseId: remainingOwed }. Cash purchases are not included (→ 0).
 */
function creditRemainingByPurchase() {
  const paidBySup = {};
  for (const r of all("SELECT supplier sup, COALESCE(SUM(amount),0) t FROM supplier_payments GROUP BY supplier")) {
    paidBySup[r.sup] = r.t;
  }
  const credits = all(
    `SELECT id, ${SUPPLIER_KEY} sup,
            round(total_cost - COALESCE(amount_paid, total_cost), 2) owed
     FROM purchases
     WHERE total_cost - COALESCE(amount_paid, total_cost) > 0.005
     ORDER BY ${SUPPLIER_KEY}, date, id`
  );
  const out = {};
  let curSup = null, pool = 0;
  for (const c of credits) {
    if (c.sup !== curSup) { curSup = c.sup; pool = paidBySup[c.sup] || 0; }
    const applied = Math.min(pool, c.owed);
    pool = round2(pool - applied);
    out[c.id] = round2(c.owed - applied);
  }
  return out;
}

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
  // Keep the most recent 500 rows, but show them oldest-first (1st of the month at the top).
  const rows = all(
    `SELECT * FROM (SELECT * FROM purchases ${clause} ORDER BY date DESC, id DESC LIMIT 10000) ORDER BY date ASC, id ASC`,
    params
  );
  const remaining = creditRemainingByPurchase();
  return rows.map((r) => ({ ...r, credit_remaining: remaining[r.id] || 0 }));
}
function listSuppliers() {
  ensureFresh();
  return all(
    `SELECT supplier, COUNT(*) n,
            COALESCE(SUM(quantity_litres),0) litres,
            COALESCE(SUM(total_cost),0) cost,
            COALESCE(SUM(total_cost - COALESCE(amount_paid, total_cost)),0) owed
     FROM purchases WHERE supplier IS NOT NULL AND supplier <> ''
     GROUP BY supplier ORDER BY cost DESC`
  );
}

/** One row per supplier: milk bought, paid at purchase, paid later (from the
 *  supplier_payments ledger) and what's still owed. `onlyOwing` → drop rows
 *  that are square. */
function supplierAccounts(onlyOwing = false) {
  ensureFresh();
  const names = all(
    `SELECT ${SUPPLIER_KEY} s FROM purchases
     UNION
     SELECT ${SUPPLIER_KEY} s FROM supplier_payments
     ORDER BY s COLLATE NOCASE`
  ).map((r) => r.s);

  const rows = names.map((name) => {
    const purchased = get(`SELECT COALESCE(SUM(total_cost),0) t FROM purchases WHERE ${SUPPLIER_KEY} = ?`, [name]).t;
    const paidAtBuy = get(`SELECT COALESCE(SUM(COALESCE(amount_paid,total_cost)),0) t FROM purchases WHERE ${SUPPLIER_KEY} = ?`, [name]).t;
    const paidLater = get("SELECT COALESCE(SUM(amount),0) t FROM supplier_payments WHERE supplier = ?", [name]).t;
    const lastPayment = get("SELECT MAX(date) d FROM supplier_payments WHERE supplier = ?", [name]).d || null;
    return {
      supplier: name,
      purchased: round2(purchased),
      paid_at_purchase: round2(paidAtBuy),
      paid_later: round2(paidLater),
      paid_total: round2(paidAtBuy + paidLater),
      owed: round2(purchased - paidAtBuy - paidLater),
      last_payment: lastPayment,
    };
  }).filter((r) => !onlyOwing || r.owed > 0.005);

  return {
    rows,
    total_owed: round2(rows.reduce((a, r) => a + Math.max(0, r.owed), 0)),
    total_advance: round2(rows.reduce((a, r) => a + Math.max(0, -r.owed), 0)),
  };
}

/** Kept for existing callers (dashboard, purchases banner). */
function supplierCredit() {
  const acc = supplierAccounts(true);
  return {
    total: acc.total_owed,
    bySupplier: acc.rows.map((r) => ({ supplier: r.supplier, n: 0, cost: r.purchased, paid: r.paid_total, owed: r.owed })),
  };
}

function listSupplierPayments(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.supplier && filter.supplier !== "all") { where.push("supplier = ?"); params.push(filter.supplier); }
  if (filter.from) { where.push("date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("date <= ?"); params.push(filter.to); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(`SELECT * FROM supplier_payments ${clause} ORDER BY date DESC, id DESC LIMIT 500`, params);
}

function saveSupplierPayment(p) {
  const amount = round2(Number(p.amount) || 0);
  const supplier = (p.supplier || "").trim();
  if (!supplier) throw new Error("Supplier is required.");
  if (amount <= 0) throw new Error("Amount must be greater than 0.");
  if (!p.date) throw new Error("Date is required.");
  const method = (p.method || "").trim() || null;
  const note = (p.note || "").trim() || null;
  if (p.id) {
    run("UPDATE supplier_payments SET supplier=?, date=?, amount=?, method=?, note=? WHERE id=?", [
      supplier, p.date, amount, method, note, p.id,
    ]);
    return get("SELECT * FROM supplier_payments WHERE id = ?", [p.id]);
  }
  const id = insert("INSERT INTO supplier_payments (supplier, date, amount, method, note) VALUES (?,?,?,?,?)", [
    supplier, p.date, amount, method, note,
  ]);
  return get("SELECT * FROM supplier_payments WHERE id = ?", [id]);
}

function deleteSupplierPayment(id) {
  run("DELETE FROM supplier_payments WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  loans taken — money borrowed, repaid later (kept out of the P&L)   */
/* ------------------------------------------------------------------ */
function loanAccounts() {
  ensureFresh();
  const rows = all(
    `SELECT lender,
            COALESCE(SUM(CASE WHEN kind='taken' THEN amount END),0) taken,
            COALESCE(SUM(CASE WHEN kind='repaid' THEN amount END),0) repaid,
            MAX(date) last_date
     FROM loans GROUP BY lender ORDER BY lender COLLATE NOCASE`
  ).map((r) => ({
    lender: r.lender,
    taken: round2(r.taken),
    repaid: round2(r.repaid),
    outstanding: round2(r.taken - r.repaid),
    last_date: r.last_date,
  }));
  return {
    rows,
    total_taken: round2(rows.reduce((a, r) => a + r.taken, 0)),
    total_repaid: round2(rows.reduce((a, r) => a + r.repaid, 0)),
    total_outstanding: round2(rows.reduce((a, r) => a + Math.max(0, r.outstanding), 0)),
  };
}

function listLoans(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.lender && filter.lender !== "all") { where.push("lender = ?"); params.push(filter.lender); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(`SELECT * FROM loans ${clause} ORDER BY date ASC, id ASC LIMIT 1000`, params);
}

function saveLoan(l) {
  const amount = round2(Number(l.amount) || 0);
  const lender = (l.lender || "").trim();
  const kind = l.kind === "repaid" ? "repaid" : "taken";
  if (!lender) throw new Error("Who gave the loan? Enter a name.");
  if (amount <= 0) throw new Error("Amount must be greater than 0.");
  if (!l.date) throw new Error("Date is required.");
  const note = (l.note || "").trim() || null;
  if (l.id) {
    run("UPDATE loans SET lender=?, date=?, kind=?, amount=?, note=? WHERE id=?", [lender, l.date, kind, amount, note, l.id]);
    return get("SELECT * FROM loans WHERE id = ?", [l.id]);
  }
  const id = insert("INSERT INTO loans (lender, date, kind, amount, note) VALUES (?,?,?,?,?)", [lender, l.date, kind, amount, note]);
  return get("SELECT * FROM loans WHERE id = ?", [id]);
}

function deleteLoan(id) {
  run("DELETE FROM loans WHERE id = ?", [id]);
  return true;
}

/* ------------------------------------------------------------------ */
/*  staff salaries — monthly salary falls due each month; what's paid  */
/*  is stored as an expense (category 'salary') so profit includes it  */
/* ------------------------------------------------------------------ */
const ym = (d) => d.slice(0, 7);
/** Months from a's month to b's month, inclusive (2026-10-15 → 2026-11-04 = 2). */
function monthsInclusive(a, b) {
  const [y1, m1] = a.split("-").map(Number), [y2, m2] = b.split("-").map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) + 1);
}
function staffAccounts(opts = {}) {
  ensureFresh();
  const today = new Date().toLocaleDateString("en-CA");
  const monthStart = today.slice(0, 8) + "01";
  const staff = all(`SELECT * FROM staff ${opts.includeInactive === false ? "WHERE active = 1" : ""} ORDER BY active DESC, name COLLATE NOCASE`);
  const rows = staff.map((s) => {
    const until = s.end_date && s.end_date < today ? s.end_date : today;
    const months = s.start_date <= until ? monthsInclusive(s.start_date, until) : 0;
    const variable = s.salary_type === "variable";
    const monthsList = variable ? all("SELECT * FROM staff_salary_months WHERE staff_id = ? ORDER BY month", [s.id]) : [];
    const earned = variable ? round2(monthsList.reduce((a, m) => a + m.amount, 0)) : round2(months * s.monthly_salary);
    const due = round2((s.opening_owed || 0) + earned);
    const sumK = (kind, from) => round2(get(
      `SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE staff_id = ? AND COALESCE(pay_kind,'salary') = ? ${from ? "AND COALESCE(paid_date, date) >= ?" : ""}`,
      from ? [s.id, kind, from] : [s.id, kind]).t);
    const advance = sumK("advance"), salaryPaid = sumK("salary");
    const advanceMonth = sumK("advance", monthStart), salaryPaidMonth = sumK("salary", monthStart);
    const paid = round2(advance + salaryPaid);
    const paidMonth = round2(advanceMonth + salaryPaidMonth);
    const last = get("SELECT MAX(COALESCE(paid_date, date)) d FROM expenses WHERE staff_id = ?", [s.id]).d || null;
    return {
      ...s, active: !!s.active, months: variable ? monthsList.length : months, due, paid, paid_month: paidMonth,
      variable, salary_months: monthsList,
      advance, salary_paid: salaryPaid, advance_month: advanceMonth, salary_paid_month: salaryPaidMonth,
      owed: round2(due - paid),              // salary due − advances − salary paid; negative = paid ahead
      last_paid: last,
      // Not-fixed salary: months (start → this month) with no salary set yet.
      // This month only counts from the 25th (salary is decided at month end).
      missing_months: variable ? (() => {
        const have = new Set(monthsList.map((m) => m.month));
        const out = [];
        const d = new Date(s.start_date.slice(0, 7) + "-01T00:00:00");
        const lastYm = (s.end_date && s.end_date < today ? s.end_date : today).slice(0, 7);
        for (let ym = d.toLocaleDateString("en-CA").slice(0, 7); ym <= lastYm; d.setMonth(d.getMonth() + 1), ym = d.toLocaleDateString("en-CA").slice(0, 7)) {
          if (ym === today.slice(0, 7) && Number(today.slice(8)) < 25 && !(s.end_date && s.end_date <= today)) continue;
          if (!have.has(ym)) out.push(ym);
        }
        return out;
      })() : [],
    };
  });
  return {
    rows,
    month_label: new Date(monthStart + "T00:00:00").toLocaleString("en-GB", { month: "long" }),
    salary_to_set: rows.filter((r) => r.active && r.missing_months.length).map((r) => ({ id: r.id, name: r.name, months: r.missing_months })),
    total_monthly: round2(rows.filter((r) => r.active).reduce((a, r) => a + r.monthly_salary, 0)),
    total_owed: round2(rows.reduce((a, r) => a + Math.max(0, r.owed), 0)),
    paid_month: round2(rows.reduce((a, r) => a + r.paid_month, 0)),
    advance_month: round2(rows.reduce((a, r) => a + r.advance_month, 0)),
    total_advance: round2(rows.reduce((a, r) => a + r.advance, 0)),
  };
}
function saveStaff(s) {
  const name = (s.name || "").trim();
  if (!name) throw new Error("Enter the worker's name.");
  const salaryType = s.salary_type === "variable" ? "variable" : "fixed";
  const salary = salaryType === "variable" ? 0 : round2(Number(s.monthly_salary) || 0);
  if (salary < 0) throw new Error("Salary can't be negative.");
  if (!s.start_date) throw new Error("Enter the date they started.");
  const active = s.active === false || s.active === 0 ? 0 : 1;
  // Leaving: stop salary from falling due after their last day.
  const end = active ? (s.end_date || null) : (s.end_date || new Date().toLocaleDateString("en-CA"));
  const opening = round2(Number(s.opening_owed) || 0);
  const vals = [name, (s.role || "").trim() || null, salary, s.start_date, end, active, (s.note || "").trim() || null, opening, salaryType];
  if (s.id) {
    run("UPDATE staff SET name=?, role=?, monthly_salary=?, start_date=?, end_date=?, active=?, note=?, opening_owed=?, salary_type=? WHERE id=?", [...vals, s.id]);
    return get("SELECT * FROM staff WHERE id = ?", [s.id]);
  }
  const id = insert("INSERT INTO staff (name, role, monthly_salary, start_date, end_date, active, note, opening_owed, salary_type) VALUES (?,?,?,?,?,?,?,?,?)", vals);
  return get("SELECT * FROM staff WHERE id = ?", [id]);
}
function deleteStaff(id) {
  const n = get("SELECT COUNT(*) n FROM expenses WHERE staff_id = ?", [id]).n;
  if (n) {   // keep the payment history — just mark them as left
    run("UPDATE staff SET active = 0, end_date = COALESCE(end_date, ?) WHERE id = ?", [new Date().toLocaleDateString("en-CA"), id]);
    return "inactive";
  }
  run("DELETE FROM staff WHERE id = ?", [id]);
  return "deleted";
}
/** Not-fixed salary: set what a worker earned for one month (YYYY-MM). 0 / empty removes it. */
function saveSalaryMonth(m) {
  const s = get("SELECT id FROM staff WHERE id = ?", [m.staff_id]);
  if (!s) throw new Error("Pick a worker.");
  if (!/^\d{4}-\d{2}$/.test(m.month || "")) throw new Error("Pick the month.");
  const amount = round2(Number(m.amount) || 0);
  if (amount < 0) throw new Error("Amount can't be negative.");
  return tx(() => {
    if (m.id) db.run("DELETE FROM staff_salary_months WHERE id = ?", [m.id]);
    db.run("DELETE FROM staff_salary_months WHERE staff_id = ? AND month = ?", [s.id, m.month]);
    if (amount > 0) db.run("INSERT INTO staff_salary_months (staff_id, month, amount, note) VALUES (?,?,?,?)", [s.id, m.month, amount, (m.note || "").trim() || null]);
    return true;
  });
}
function deleteSalaryMonth(id) {
  run("DELETE FROM staff_salary_months WHERE id = ?", [id]);
  return true;
}

function listSalaryPayments(filter = {}) {
  ensureFresh();
  const where = ["e.staff_id IS NOT NULL"], params = [];
  if (filter.staffId) { where.push("e.staff_id = ?"); params.push(filter.staffId); }
  return all(
    `SELECT e.*, s.name staff_name FROM expenses e LEFT JOIN staff s ON s.id = e.staff_id
     WHERE ${where.join(" AND ")} ORDER BY COALESCE(e.paid_date, e.date) ASC, e.id ASC`, params);
}
/** Pay salary = an expense row (category salary) linked to the worker. */
function saveSalaryPayment(p) {
  const s = get("SELECT * FROM staff WHERE id = ?", [p.staff_id]);
  if (!s) throw new Error("Pick a worker.");
  const amount = round2(Number(p.amount) || 0);
  if (amount <= 0) throw new Error("Amount must be greater than 0.");
  if (!p.date) throw new Error("Date is required.");
  const kind = p.pay_kind === "advance" ? "advance" : "salary";
  // Salary counts as an expense of the month it is FOR (owner pays e.g. October
  // salary in November from October's money): the expense date is put in that
  // month (paid date if inside it, else its last day); paid_date keeps the real day.
  const forMonth = /^\d{4}-\d{2}$/.test(p.for_month || "") ? p.for_month : p.date.slice(0, 7);
  const lastDay = (ymStr) => { const [y, m] = ymStr.split("-").map(Number); return `${ymStr}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
  const expDate = p.date.slice(0, 7) === forMonth ? p.date : lastDay(forMonth);
  const forLabel = new Date(forMonth + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const paidLabel = p.date.split("-").reverse().join("-");
  const notes = `${kind === "advance" ? "Advance" : "Salary"} — ${s.name} · for ${forLabel}${expDate !== p.date ? " · paid " + paidLabel : ""}${(p.note || "").trim() ? " · " + p.note.trim() : ""}`;
  if (p.id) {
    run("UPDATE expenses SET date=?, paid_date=?, category='salary', amount=?, notes=?, staff_id=?, pay_kind=? WHERE id=?", [expDate, p.date, amount, notes, s.id, kind, p.id]);
    return get("SELECT * FROM expenses WHERE id = ?", [p.id]);
  }
  const id = insert("INSERT INTO expenses (date, paid_date, category, amount, notes, staff_id, pay_kind) VALUES (?, ?, 'salary', ?, ?, ?, ?)", [expDate, p.date, amount, notes, s.id, kind]);
  return get("SELECT * FROM expenses WHERE id = ?", [id]);
}

function savePurchase(p) {
  const qty = Number(p.quantity_litres) || 0;
  const price = Number(p.price_per_litre) || 0;
  if (qty <= 0) throw new Error("Quantity must be greater than 0.");
  if (price <= 0) throw new Error("Price per litre must be greater than 0.");
  const total = round2(qty * price);
  const supplier = (p.supplier || "").trim() || null;
  const notes = (p.supplier_notes || "").trim() || null;
  // amount_paid: blank / missing → treat as paid in full; otherwise clamp to 0..total
  const paid = (p.amount_paid === undefined || p.amount_paid === null || p.amount_paid === "")
    ? total
    : Math.max(0, Math.min(total, round2(Number(p.amount_paid) || 0)));
  if (p.id) {
    run("UPDATE purchases SET date=?, quantity_litres=?, price_per_litre=?, total_cost=?, supplier=?, supplier_notes=?, amount_paid=? WHERE id=?", [
      p.date, qty, price, total, supplier, notes, paid, p.id,
    ]);
    return get("SELECT * FROM purchases WHERE id = ?", [p.id]);
  }
  const id = insert(
    "INSERT INTO purchases (date, quantity_litres, price_per_litre, total_cost, supplier, supplier_notes, amount_paid) VALUES (?,?,?,?,?,?,?)",
    [p.date, qty, price, total, supplier, notes, paid]
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
  // Most recent 500 rows, shown oldest-first (1st of the month at the top).
  return all(
    `SELECT * FROM (SELECT * FROM expenses ${clause} ORDER BY date DESC, id DESC LIMIT 500) ORDER BY date ASC, id ASC`,
    params
  );
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

  const avgSalePrice = litresSold ? round2(revenue / litresSold) : 0;
  const sampleRate = Number((get("SELECT value FROM settings WHERE key='sample_rate'") || {}).value) || 0;
  const homeRateSetting = Number((get("SELECT value FROM settings WHERE key='home_milk_rate'") || {}).value) || 0;
  // Rate used to value home (GHAR) milk: the Settings override if set, else avg sale price.
  const homeMilkRate = homeRateSetting > 0 ? round2(homeRateSetting) : avgSalePrice;
  const homeMilkLitres = round2(get(
    "SELECT COALESCE(SUM(litres),0) t FROM home_milk WHERE kind='home' AND date BETWEEN ? AND ?", [from, to]
  ).t);
  const sampleMilkLitres = round2(get(
    "SELECT COALESCE(SUM(litres),0) t FROM home_milk WHERE kind='sample' AND date BETWEEN ? AND ?", [from, to]
  ).t);

  // The milk you paid for (cogs) is ONE pot. Sample milk is milk you ALREADY
  // bought — its cost is already inside cogs, so it must NOT be subtracted
  // again. We only carve out the home (GHAR) share as the owner's own use.
  // Blended per-litre cost = total spend / all milk that came in.
  const milkDisposed = round2(litresSold + sampleMilkLitres + homeMilkLitres);
  const milkIn = Math.max(litresBought, milkDisposed);
  const avgPurchaseRate = milkIn > 0 ? round2(cogs / milkIn) : 0;

  // Owner's sheet model (2026-10-31): profit = sales − EVERY rupee of milk
  // purchased (all suppliers) − expenses. Home (GHAR) and sample milk come out
  // of that same purchased milk, so nothing is carved out or estimated.
  const purchasesCoverSales =
    litresBought > 0 && litresSold > 0 &&
    Math.abs(litresBought - litresSold) <= Math.max(1, litresSold * 0.02);
  const milkCostBasis = "recorded";
  const homeMilkCost = 0;
  const costMilkSold = round2(cogs);
  const marginOnSales = round2(revenue - costMilkSold);
  const operatingProfit = round2(marginOnSales - totalExpenses);

  // Sample milk — informational only (already inside costMilkSold):
  const sampleMilkCost = round2(sampleMilkLitres * (sampleRate || avgPurchaseRate)); // what that milk cost
  const sampleMilkValue = round2(sampleMilkLitres * avgSalePrice);                   // revenue given up
  // Home milk (GHAR) — the owner's benefit, valued at the home-milk rate
  // (Settings override, or the average selling price when that is 0):
  const homeMilkValue = round2(homeMilkLitres * homeMilkRate);
  const expensesWithSamples = totalExpenses; // kept name for callers; samples are NOT added
  const totalBenefit = round2(operatingProfit + homeMilkValue);

  const byCategory = all(
    "SELECT category, COALESCE(SUM(amount),0) amount, COUNT(*) n FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC",
    [from, to]
  );

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
  const dayLitres = Object.fromEntries(all(
    "SELECT date, SUM(quantity_litres) v FROM milk_entries WHERE date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dayHome = Object.fromEntries(all(
    "SELECT date, SUM(litres) v FROM home_milk WHERE kind='home' AND date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const daySample = Object.fromEntries(all(
    "SELECT date, SUM(litres) v FROM home_milk WHERE kind='sample' AND date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dayBought = Object.fromEntries(all(
    "SELECT date, SUM(quantity_litres) v FROM purchases WHERE date BETWEEN ? AND ? GROUP BY date", [from, to]
  ).map((r) => [r.date, r.v]));
  const dates = [...new Set([...Object.keys(dayRev), ...Object.keys(dayCogs), ...Object.keys(dayExp), ...Object.keys(dayHome), ...Object.keys(daySample)])].sort();
  const days = dates.map((d) => {
    const rev = round2(dayRev[d] || 0);
    const cg = round2(dayCogs[d] || 0);
    const ex = round2(dayExp[d] || 0);
    return {
      date: d, revenue: rev, cogs: cg, expenses: ex, net: round2(rev - cg - ex),
      litres: round2(dayLitres[d] || 0), homeLitres: round2(dayHome[d] || 0),
      sampleLitres: round2(daySample[d] || 0),
      boughtLitres: round2(dayBought[d] || 0),
      // bought − (sold + home + samples): + = milk left over / wasted, − = gave out more than bought
      diffLitres: round2((dayBought[d] || 0) - (dayLitres[d] || 0) - (dayHome[d] || 0) - (daySample[d] || 0)),
    };
  });

  return {
    from, to, revenue, cogs, grossProfit, totalExpenses, netProfit,
    litresSold, litresBought, avgPurchaseRate, costMilkSold, marginOnSales,
    milkCost: costMilkSold, milkCostBasis, purchasesCoverSales,
    operatingProfit, expensesWithSamples,
    avgSalePrice, homeMilkRate, homeRateFromSetting: homeRateSetting > 0,
    homeMilkLitres, homeMilkValue, homeMilkCost,
    sampleMilkLitres, sampleMilkCost, sampleMilkValue,
    totalBenefit,
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
  const dayPl = profitLoss(today, today);
  const monthCollected = round2(get(
    "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE date BETWEEN ? AND ?", [monthStart, today]
  ).t);
  // Walk-in cash sales (cash-on-delivery clients) — the owner's sheet lists these
  // apart from client bills / client receipts, so the dashboard splits them out.
  const monthCashSales = round2(get(
    `SELECT COALESCE(SUM(e.total_amount),0) t FROM milk_entries e JOIN clients c ON c.id = e.client_id
     WHERE c.cash_on_delivery = 1 AND e.date BETWEEN ? AND ?`, [monthStart, today]
  ).t);
  const monthCashSalesPaid = round2(get(
    `SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN clients c ON c.id = p.client_id
     WHERE c.cash_on_delivery = 1 AND p.date BETWEEN ? AND ?`, [monthStart, today]
  ).t);
  const morning = morningSettlements();
  const morningMonth = morningDailySheet(monthStart, today, null).totals;
  // Outstanding, split into what was carried in from before this month vs.
  // what this month's deliveries added. Every payment a client has made is
  // applied to their OLDEST debt first (FIFO), so a settlement recorded now
  // for a past month still lowers the "earlier months" figure.
  const allClients = listClients(true);
  const receivable = round2(allClients.reduce((a, c) => a + Math.max(0, c.balance), 0));
  let receivablePrior = 0, receivableCurrent = 0;
  for (const c of allClients) {
    const billedBefore = get(
      "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date < ?", [c.id, monthStart]
    ).t;
    const billedMonth = get(
      "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date BETWEEN ? AND ?", [c.id, monthStart, today]
    ).t;
    const paidAll = get(
      "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ?", [c.id]
    ).t;
    const priorGross = c.opening_balance + billedBefore;
    const priorNet = Math.max(0, priorGross - paidAll);          // oldest debt cleared first
    const leftoverPaid = Math.max(0, paidAll - priorGross);      // payment beyond the old balance
    receivablePrior += priorNet;
    receivableCurrent += billedMonth - leftoverPaid;             // may go negative if overpaid
  }
  receivablePrior = round2(receivablePrior);
  receivableCurrent = round2(receivableCurrent);
  const activeClients = get("SELECT COUNT(*) c FROM clients WHERE active = 1").c;
  return {
    today,
    month_start: monthStart,
    today_litres: todayLitres,
    today_revenue: todayRevenue,
    month_revenue: pl.revenue,
    month_collected: monthCollected,
    // same figures as the Profit & Loss page, for today only
    today_pl: {
      revenue: dayPl.revenue, costMilkSold: dayPl.costMilkSold, marginOnSales: dayPl.marginOnSales,
      totalExpenses: dayPl.totalExpenses, operatingProfit: dayPl.operatingProfit,
      litresSold: dayPl.litresSold, litresBought: dayPl.litresBought,
      homeMilkLitres: dayPl.homeMilkLitres, sampleMilkLitres: dayPl.sampleMilkLitres,
    },
    month_client_bills: round2(pl.revenue - monthCashSales),
    month_cash_sales: monthCashSales,
    month_collected_clients: round2(monthCollected - monthCashSalesPaid),
    month_morning_sales: round2(morningMonth.amount || 0),
    month_morning_litres: round2(morningMonth.litres || 0),
    morning_pending: round2(morning.totals.pending || 0),
    month_milk_cost: pl.milkCost,           // recorded purchase total when it covers sales, else estimated
    month_milk_cost_basis: pl.milkCostBasis, // "recorded" | "estimated"
    month_purchases_total: pl.cogs,         // raw SUM of purchases entered
    month_cost_milk_sold: pl.costMilkSold,
    month_litres_bought: pl.litresBought,
    month_expenses: pl.expensesWithSamples,
    month_net_profit: pl.operatingProfit,
    month_litres_sold: pl.litresSold,
    month_home_milk_litres: pl.homeMilkLitres,
    month_home_milk_value: pl.homeMilkValue,
    month_total_benefit: pl.totalBenefit,
    receivable,
    receivable_prior: receivablePrior,
    receivable_current: receivableCurrent,
    milk_credit_total: supplierAccounts(true).total_owed,
    milk_credit_month: round2(get(
      "SELECT COALESCE(SUM(total_cost - COALESCE(amount_paid, total_cost)),0) t FROM purchases WHERE date BETWEEN ? AND ?",
      [monthStart, today]
    ).t),
    loans_outstanding: loanAccounts().total_outstanding,
    salary_owed: staffAccounts().total_owed,
    salary_to_set: staffAccounts().salary_to_set,
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

  // day-by-day summary (handy for weekly / 10-day / monthly invoices).
  // Every date in the period gets a row — days with no milk show 0 L / 0 Rs.
  const byDayMap = new Map();
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    byDayMap.set(ds, { date: ds, litres: 0, amount: 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
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
/**
 * A client's invoices (newest first) with how much is still due on each.
 * An invoice's total_due already subtracts payments up to period_to, so only
 * payments made AFTER period_to count towards settling it. Each invoice carries
 * the previous balance forward, so the newest one is the real amount to collect;
 * older ones are marked `superseded`.
 */
function clientInvoiceDues(clientId) {
  ensureFresh();
  const invs = all(
    `SELECT id, invoice_no, issued_date, period_from, period_to, total_due
     FROM invoices WHERE client_id = ? ORDER BY issued_date DESC, id DESC`, [clientId]
  );
  return invs.map((inv, i) => {
    const paidAfter = round2(get(
      "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ? AND date > ?", [clientId, inv.period_to]
    ).t);
    const due = round2(inv.total_due);
    const outstanding = round2(Math.max(0, due - paidAfter));
    return {
      ...inv, total_due: due, paid_after: paidAfter, outstanding,
      status: due <= 0.5 || paidAfter >= due - 0.5 ? "paid" : paidAfter > 0.5 ? "partial" : "unpaid",
      latest: i === 0, superseded: i > 0,
    };
  });
}

/**
 * What a client owes split into LAST MONTH'S BILL vs THIS MONTH so far.
 * Last-month due = what a last-month invoice says (milk up to month end − payments
 * up to month end) minus anything paid since, i.e. FIFO: payments clear the
 * oldest debt first. Works whether or not an invoice was actually generated;
 * if one was (period ending inside last month), it's attached.
 * excludePaymentId: leave one payment out (used when editing that payment).
 */
function clientDueSplit(clientId, excludePaymentId) {
  ensureFresh();
  const c = get("SELECT id, opening_balance FROM clients WHERE id = ?", [clientId]);
  if (!c) return null;
  const today = new Date().toLocaleDateString("en-CA");
  const monthStart = today.slice(0, 8) + "01";
  const pm = new Date(monthStart + "T00:00:00"); pm.setMonth(pm.getMonth() - 1);
  const prevStart = pm.toLocaleDateString("en-CA");
  const billedBefore = round2(c.opening_balance + get(
    "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ? AND date < ?", [clientId, monthStart]).t);
  const billedAll = round2(c.opening_balance + get(
    "SELECT COALESCE(SUM(total_amount),0) t FROM milk_entries WHERE client_id = ?", [clientId]).t);
  const paidAll = round2(get(
    "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ? AND id != ?", [clientId, excludePaymentId || -1]).t);
  const paidToMonthEnd = round2(get(
    "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE client_id = ? AND date < ? AND id != ?", [clientId, monthStart, excludePaymentId || -1]).t);
  const prevInvoice = get(
    `SELECT invoice_no, period_from, period_to, issued_date, total_due FROM invoices
     WHERE client_id = ? AND period_to >= ? AND period_to < ? ORDER BY period_to DESC, id DESC LIMIT 1`,
    [clientId, prevStart, monthStart]) || null;
  const priorPending = round2(Math.max(0, billedBefore - paidAll));
  const balance = round2(billedAll - paidAll);
  return {
    month_start: monthStart, prev_month_start: prevStart,
    prev_month_label: pm.toLocaleString("en-GB", { month: "long", year: "numeric" }),
    month_label: new Date(monthStart + "T00:00:00").toLocaleString("en-GB", { month: "long" }),
    prev_bill_amount: round2(Math.max(0, billedBefore - paidToMonthEnd)), // what last month's bill said at month end
    paid_since: round2(paidAll - paidToMonthEnd),
    prior_pending: priorPending,
    current_pending: round2(balance - priorPending),
    balance,
    prev_invoice: prevInvoice,
  };
}

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

/** Preview would-be invoices for every active client over one period. */
function invoicePreviewAll(from, to, cycle) {
  ensureFresh();
  if (!from || !to) throw new Error("Period is required.");
  if (from > to) throw new Error("The 'from' date is after the 'to' date.");
  const byCycle = BILLING_CYCLES.includes(cycle);
  const clients = all(
    `SELECT id, name, society, cash_on_delivery, billing_cycle FROM clients WHERE active = 1 ${byCycle ? "AND billing_cycle = ?" : ""} ORDER BY ${SOCIETY_RANK}, name COLLATE NOCASE`,
    byCycle ? [cycle] : []
  );
  return clients.map((c) => {
    const core = statementCore(c.id, from, to);
    return {
      client_id: c.id,
      name: c.name,
      society: c.society || "Other",
      billing_cycle: c.billing_cycle,
      opening_balance: core.opening_balance,
      period_litres: core.period_litres,
      period_billed: core.period_billed,
      period_paid: core.period_paid,
      total_due: core.closing_balance,
      // cash-on-delivery clients never owe anything, so they start unticked
      has_activity: !c.cash_on_delivery && (core.entries.length > 0 || core.payments.length > 0),
    };
  });
}

/** Issue invoices for many clients at once, in a single transaction.
 *  `clientIds` empty / missing → every active client. */
function createInvoicesBulk(payload = {}) {
  const { from, to, note } = payload;
  if (!from || !to) throw new Error("Period is required.");
  if (from > to) throw new Error("The 'from' date is after the 'to' date.");
  const ids = Array.isArray(payload.clientIds) && payload.clientIds.length
    ? payload.clientIds.map(Number)
    : all(`SELECT id FROM clients WHERE active = 1 ORDER BY ${SOCIETY_RANK}, name COLLATE NOCASE`).map((r) => r.id);
  if (!ids.length) throw new Error("No clients to invoice.");
  return tx(() => {
    const settings = getSettings();
    const prefix = settings.invoice_prefix || "INV-";
    const issued = new Date().toLocaleDateString("en-CA");
    const invoices = [];
    for (const cid of ids) {
      const core = statementCore(cid, from, to);
      const n = bumpCounter("next_invoice_no");
      const invoiceNo = prefix + String(n).padStart(4, "0");
      db.run(
        `INSERT INTO invoices
         (invoice_no, client_id, period_from, period_to, issued_date,
          previous_balance, period_litres, period_billed, period_paid, total_due, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceNo, cid, from, to, issued,
          core.opening_balance, core.period_litres, core.period_billed,
          core.period_paid, core.closing_balance, note || null,
        ]
      );
      invoices.push({ id: lastId(), invoice_no: invoiceNo, client_id: cid, name: core.client.name, total_due: core.closing_balance });
    }
    return { count: invoices.length, invoices };
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

/* ------------------------------------------------------------------ */
/*  Morning milk — a fully SEPARATE bulk-sale ledger                    */
/*  (not part of clients / P&L / dashboard)                            */
/* ------------------------------------------------------------------ */
function morningBuyerBalance(id) {
  const b = get("SELECT opening_balance FROM morning_buyers WHERE id = ?", [id]);
  if (!b) return 0;
  const sold = get("SELECT COALESCE(SUM(total_amount),0) t FROM morning_sales WHERE buyer_id = ?", [id]).t;
  const paid = get("SELECT COALESCE(SUM(amount),0) t FROM morning_payments WHERE buyer_id = ?", [id]).t;
  return round2(b.opening_balance + sold - paid);
}

function listMorningBuyers(includeInactive) {
  ensureFresh();
  const rows = all(
    `SELECT * FROM morning_buyers ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`
  );
  return rows.map((b) => ({
    ...b,
    active: !!b.active,
    balance: morningBuyerBalance(b.id),
  }));
}

function getMorningBuyer(id) {
  ensureFresh();
  const b = get("SELECT * FROM morning_buyers WHERE id = ?", [id]);
  if (!b) throw new Error("Buyer not found.");
  b.active = !!b.active;
  b.balance = morningBuyerBalance(id);
  return b;
}

function saveMorningBuyer(b) {
  const name = (b.name || "").trim();
  if (!name) throw new Error("Buyer name is required.");
  const price = Number(b.price_per_litre) || 0;
  const opening = Number(b.opening_balance) || 0;
  const active = b.active ? 1 : 0;
  if (b.id) {
    run(
      "UPDATE morning_buyers SET name=?, phone=?, address=?, price_per_litre=?, opening_balance=?, active=?, note=? WHERE id=?",
      [name, b.phone || null, b.address || null, price, opening, active, b.note || null, b.id]
    );
    return getMorningBuyer(b.id);
  }
  const id = insert(
    "INSERT INTO morning_buyers (name, phone, address, price_per_litre, opening_balance, active, note) VALUES (?,?,?,?,?,?,?)",
    [name, b.phone || null, b.address || null, price, opening, active, b.note || null]
  );
  return getMorningBuyer(id);
}

function deleteMorningBuyer(id) {
  ensureFresh();
  const n = get("SELECT COUNT(*) c FROM morning_sales WHERE buyer_id = ?", [id]).c;
  if (n > 0) {
    run("UPDATE morning_buyers SET active = 0 WHERE id = ?", [id]);
    return "deactivated";
  }
  run("DELETE FROM morning_buyers WHERE id = ?", [id]);
  return "deleted";
}

function listMorningSales(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.from) { where.push("s.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("s.date <= ?"); params.push(filter.to); }
  if (filter.buyerId) { where.push("s.buyer_id = ?"); params.push(filter.buyerId); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(
    `SELECT s.*, b.name AS buyer_name, b.phone AS buyer_phone
     FROM morning_sales s JOIN morning_buyers b ON b.id = s.buyer_id
     ${clause} ORDER BY s.date DESC, s.id DESC LIMIT 1000`,
    params
  );
}

function saveMorningSale(s) {
  const qty = Number(s.quantity_litres) || 0;
  const price = Number(s.price_per_litre) || 0;
  if (!s.buyer_id) throw new Error("Choose a buyer.");
  if (qty <= 0) throw new Error("Litres must be greater than 0.");
  if (price <= 0) throw new Error("Sale price per litre must be greater than 0.");
  if (!s.date) throw new Error("Date is required.");
  const total = round2(qty * price);
  if (s.id) {
    run(
      "UPDATE morning_sales SET buyer_id=?, date=?, quantity_litres=?, price_per_litre=?, total_amount=?, note=? WHERE id=?",
      [s.buyer_id, s.date, qty, price, total, s.note || null, s.id]
    );
    return get("SELECT * FROM morning_sales WHERE id = ?", [s.id]);
  }
  const id = insert(
    "INSERT INTO morning_sales (buyer_id, date, quantity_litres, price_per_litre, total_amount, note) VALUES (?,?,?,?,?,?)",
    [s.buyer_id, s.date, qty, price, total, s.note || null]
  );
  return get("SELECT * FROM morning_sales WHERE id = ?", [id]);
}

function deleteMorningSale(id) {
  run("DELETE FROM morning_sales WHERE id = ?", [id]);
  return true;
}

function listMorningPayments(filter = {}) {
  ensureFresh();
  const where = [];
  const params = [];
  if (filter.buyerId) { where.push("p.buyer_id = ?"); params.push(filter.buyerId); }
  if (filter.from) { where.push("p.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("p.date <= ?"); params.push(filter.to); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  return all(
    `SELECT p.*, b.name AS buyer_name FROM morning_payments p JOIN morning_buyers b ON b.id = p.buyer_id
     ${clause} ORDER BY p.date DESC, p.id DESC LIMIT 500`,
    params
  );
}

function saveMorningPayment(p) {
  const amount = Number(p.amount) || 0;
  if (!p.buyer_id) throw new Error("Choose a buyer.");
  if (amount <= 0) throw new Error("Payment amount must be greater than 0.");
  if (!p.date) throw new Error("Date is required.");
  if (p.id) {
    run("UPDATE morning_payments SET buyer_id=?, date=?, amount=?, method=?, note=? WHERE id=?", [
      p.buyer_id, p.date, amount, p.method || null, p.note || null, p.id,
    ]);
    return get("SELECT * FROM morning_payments WHERE id = ?", [p.id]);
  }
  const id = insert("INSERT INTO morning_payments (buyer_id, date, amount, method, note) VALUES (?,?,?,?,?)", [
    p.buyer_id, p.date, amount, p.method || null, p.note || null,
  ]);
  return get("SELECT * FROM morning_payments WHERE id = ?", [id]);
}

function deleteMorningPayment(id) {
  run("DELETE FROM morning_payments WHERE id = ?", [id]);
  return true;
}

/** Per-buyer sold / received / pending for the Morning-milk dues screen. */
function morningSettlements() {
  ensureFresh();
  const buyers = all("SELECT * FROM morning_buyers ORDER BY name COLLATE NOCASE");
  const rows = buyers.map((b) => {
    const sold = round2(b.opening_balance +
      get("SELECT COALESCE(SUM(total_amount),0) t FROM morning_sales WHERE buyer_id = ?", [b.id]).t);
    const received = round2(get("SELECT COALESCE(SUM(amount),0) t FROM morning_payments WHERE buyer_id = ?", [b.id]).t);
    const litres = round2(get("SELECT COALESCE(SUM(quantity_litres),0) t FROM morning_sales WHERE buyer_id = ?", [b.id]).t);
    const lastPayment = get("SELECT MAX(date) d FROM morning_payments WHERE buyer_id = ?", [b.id]).d || null;
    return {
      id: b.id, name: b.name, phone: b.phone || "",
      litres, sold, received, pending: round2(sold - received),
      last_payment: lastPayment, active: !!b.active,
    };
  });
  const totals = rows.reduce((a, r) => ({
    litres: round2(a.litres + r.litres),
    sold: round2(a.sold + r.sold),
    received: round2(a.received + r.received),
    pending: round2(a.pending + r.pending),
  }), { litres: 0, sold: 0, received: 0, pending: 0 });
  return { rows, totals, settings: getSettings(), generated: new Date().toLocaleDateString("en-CA") };
}

/** Printable daily morning-milk sheet for a period (optionally one buyer). */
function morningDailySheet(from, to, buyerId) {
  ensureFresh();
  const sales = listMorningSales({ from, to, buyerId: buyerId || undefined });
  const byDateMap = new Map();
  for (const s of sales) {
    const d = byDateMap.get(s.date) || { date: s.date, litres: 0, amount: 0, lines: [] };
    d.litres = round2(d.litres + s.quantity_litres);
    d.amount = round2(d.amount + s.total_amount);
    d.lines.push({ buyer: s.buyer_name, litres: s.quantity_litres, price: s.price_per_litre, amount: s.total_amount, note: s.note || "" });
    byDateMap.set(s.date, d);
  }
  const days = [...byDateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byBuyerMap = new Map();
  for (const s of sales) {
    const x = byBuyerMap.get(s.buyer_id) || { buyer: s.buyer_name, litres: 0, amount: 0 };
    x.litres = round2(x.litres + s.quantity_litres);
    x.amount = round2(x.amount + s.total_amount);
    byBuyerMap.set(s.buyer_id, x);
  }
  const byBuyer = [...byBuyerMap.values()].sort((a, b) => b.amount - a.amount);
  const totals = {
    litres: round2(sales.reduce((a, s) => a + s.quantity_litres, 0)),
    amount: round2(sales.reduce((a, s) => a + s.total_amount, 0)),
  };
  totals.avg_rate = totals.litres ? round2(totals.amount / totals.litres) : 0;
  const buyer = buyerId ? get("SELECT name FROM morning_buyers WHERE id = ?", [buyerId]) : null;
  return { from, to, days, byBuyer, totals, buyer: buyer ? buyer.name : null, settings: getSettings(), generated: new Date().toLocaleDateString("en-CA") };
}

module.exports = {
  milkPlan, saveMilkPlan, deleteMilkPlan,
  MILK_CATEGORIES, EXPENSE_CATEGORIES, PAYMENT_METHODS, BILLING_CYCLES, SOCIETIES,
  open, openRemote, rawDb, exportBytes, isOpen, currentPath, ensureFresh, fileMtime,
  getLoadedMtime: () => loadedMtimeMs,
  getSettings, saveSettings,
  listClients, getClient, saveClient, deleteClient,
  listEntries, saveEntry, deleteEntry, saveDailyRound, dailyRound,
  listPayments, savePayment, deletePayment, settlements,
  listPurchases, savePurchase, deletePurchase, listSuppliers, supplierCredit,
  supplierAccounts, listSupplierPayments, saveSupplierPayment, deleteSupplierPayment,
  loanAccounts, listLoans, saveLoan, deleteLoan,
  staffAccounts, saveStaff, deleteStaff, listSalaryPayments, saveSalaryPayment, saveSalaryMonth, deleteSalaryMonth,
  listHomeMilk, homeMilkForDate, saveHomeMilk, deleteHomeMilk,
  listExpenses, saveExpense, deleteExpense,
  profitLoss, dashboard, clientStatement, dailyMilkSheet,
  listInvoices, clientInvoiceDues, clientDueSplit, invoicePreview, invoicePreviewAll, createInvoice, createInvoicesBulk, getInvoice, deleteInvoice,
  listMorningBuyers, getMorningBuyer, saveMorningBuyer, deleteMorningBuyer,
  listMorningSales, saveMorningSale, deleteMorningSale,
  listMorningPayments, saveMorningPayment, deleteMorningPayment,
  morningSettlements, morningDailySheet,
};
