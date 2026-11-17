"use strict";

/**
 * Wahga Dairy Farm — online API server.
 *
 * Runs the desktop app's own db.js (all business logic, reports, invoices)
 * against an in-memory SQLite copy of the online Turso database. Every save
 * is mirrored to Turso before the reply is sent, so Turso is always the
 * source of truth and a restart (Render free plan sleeps) loses nothing.
 *
 * Env:
 *   TURSO_DATABASE_URL   libsql://<db>-<org>.turso.io
 *   TURSO_AUTH_TOKEN     database token
 *   APP_PASSWORD         shared password the desktop app sends
 *   TZ                   Asia/Karachi  ("today", localtime defaults)
 *   PORT                 set by Render
 */

require("./env").load();
process.env.TZ = process.env.TZ || "Asia/Karachi";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const db = require("../db");
const { makeStore } = require("./turso-store");

const PORT = Number(process.env.PORT) || 8787;
const PASSWORD = process.env.APP_PASSWORD || "";
if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is not set");
if (PASSWORD.length < 6) throw new Error("APP_PASSWORD must be set (at least 6 characters)");

/* Functions the API may call = exactly the plain data handlers in main.js. */
const ALLOWED = new Set();
for (const line of fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8").split(/\r?\n/)) {
  const m = /^handle\("[\w:]+",.*requireDb\(\); return db\.(\w+)\(.*\); \}\);\s*$/.exec(line);
  if (m && typeof db[m[1]] === "function") ALLOWED.add(m[1]);
}

const store = makeStore({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
let version = Date.now(); // bumps on every saved change; clients poll it
let ready = null;          // promise of the loaded DB

async function loadDb() {
  const t0 = Date.now();
  await db.openRemote(async (mem) => {
    const n = await store.load(mem);
    store.track(mem);
    console.log(`loaded ${n} tables from Turso in ${Date.now() - t0} ms`);
  }, () => {});
  const ddl = await store.syncSchema();
  const sent = await store.flush();
  if (ddl || sent) console.log(`startup migration: ${ddl} schema change(s), ${sent} row write(s)`);
}
function ensureReady() {
  if (!ready) ready = loadDb().catch((e) => { ready = null; throw e; });
  return ready;
}

/* One request at a time: db.js is synchronous and every write must reach Turso in order. */
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function call(fn, args) {
  await ensureReady();
  let result;
  try {
    result = db[fn](...(Array.isArray(args) ? args : []));
  } catch (err) {
    // A failed tx is rolled back in memory; mirroring the touched rows again
    // just re-writes their unchanged values (cheap and keeps both in step).
    if (store.hasChanges()) await store.flush().catch(() => resync());
    throw err;
  }
  if (store.hasChanges()) {
    try {
      await store.flush();
      version = Date.now();
    } catch (err) {
      console.error("flush failed", err);
      await resync();
      throw new Error("Could not save to the online database (" + (err.message || err) + "). Nothing was saved — please try again.");
    }
  }
  return result;
}

/** Memory and Turso may disagree after a failed save: reload memory from Turso. */
async function resync() {
  store.discard();
  ready = null;
  await ensureReady();
}

/* ---------- auth ---------- */
const fails = new Map(); // ip -> { n, until }
function authorized(req) {
  const h = req.headers.authorization || "";
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 60_000 * Math.min(30, f.n - 4); }
  fails.set(ip, f);
}

/* ---------- http ---------- */
// The Android app's web view runs on https://localhost; the desktop app sends no Origin.
const ALLOWED_ORIGINS = new Set(["https://localhost", "http://localhost", "capacitor://localhost"]);
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.has(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function send(res, status, body, req) {
  const json = Buffer.from(JSON.stringify(body));
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (json.length > 2048 && /\bgzip\b/.test((req && req.headers["accept-encoding"]) || "")) {
    headers["content-encoding"] = "gzip";
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(json));
  }
  res.writeHead(status, headers);
  res.end(json);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const url = new URL(req.url, "http://x");
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return send(res, 200, { ok: true, service: "wahga-dairy-api" }, req);
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { ok: false, error: "Not found" }, req);
    if (blocked(ip)) return send(res, 429, { ok: false, error: "Too many wrong passwords — wait a few minutes." }, req);
    if (!authorized(req)) {
      noteFail(ip);
      return send(res, 401, { ok: false, error: "Wrong password" }, req);
    }
    fails.delete(ip);

    if (url.pathname === "/api/ping" && req.method === "GET") {
      await serial(ensureReady);
      return send(res, 200, { ok: true, version }, req);
    }
    if (url.pathname === "/api/version" && req.method === "GET") {
      return send(res, 200, { ok: true, version }, req);
    }
    if (url.pathname === "/api/call" && req.method === "POST") {
      const { fn, args } = JSON.parse((await readBody(req)) || "{}");
      if (!ALLOWED.has(fn)) return send(res, 400, { ok: false, error: "Unknown function: " + fn }, req);
      try {
        const data = await serial(() => call(fn, args));
        return send(res, 200, { ok: true, data, version }, req);
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message || String(err), version }, req);
      }
    }
    if (url.pathname === "/api/backup" && req.method === "GET") {
      const bytes = await serial(async () => { await ensureReady(); return db.exportBytes(); });
      res.writeHead(200, {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="wahga-dairy-online-${new Date().toLocaleDateString("en-CA")}.db"`,
        "cache-control": "no-store",
      });
      return res.end(bytes);
    }
    if (url.pathname === "/api/reload" && req.method === "POST") {
      await serial(resync);
      version = Date.now();
      return send(res, 200, { ok: true, version }, req);
    }
    return send(res, 404, { ok: false, error: "Not found" }, req);
  } catch (err) {
    console.error(req.method, url.pathname, err);
    return send(res, 500, { ok: false, error: err.message || String(err) }, req);
  }
});

server.listen(PORT, () => {
  console.log(`Wahga Dairy API on :${PORT} · ${ALLOWED.size} functions · TZ=${process.env.TZ}`);
  serial(ensureReady).catch((e) => console.error("initial load failed:", e.message));
});
