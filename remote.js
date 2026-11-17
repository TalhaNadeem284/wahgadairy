"use strict";

/**
 * Online mode for the desktop app: a stand-in for db.js that sends every data
 * call to the Wahga Dairy API server (server/index.js), which runs the same
 * db.js against the online Turso database.
 *
 * makeRemoteDb(localDb, { url, password }) returns an object with the same
 * shape as db.js: constants (MILK_CATEGORIES …) come from the local module,
 * every function becomes an HTTPS call returning a Promise.
 */

const FIRST_TIMEOUT_MS = 100_000; // the free server sleeps; waking up can take ~1 minute
const CALL_TIMEOUT_MS = 60_000;

function cleanUrl(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

function makeClient({ url, password }) {
  const base = cleanUrl(url);
  let lastVersion = 0;
  let awake = false;

  async function request(pathname, { method = "GET", body, timeout } = {}) {
    let res;
    try {
      res = await fetch(base + pathname, {
        method,
        headers: { authorization: "Bearer " + password, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout || (awake ? CALL_TIMEOUT_MS : FIRST_TIMEOUT_MS)),
      });
    } catch (err) {
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut
        ? "The online server did not answer in time. Check the internet and try again."
        : "No internet / can't reach the online server. Nothing was saved — try again when connected.");
    }
    awake = true;
    if (res.status === 401) throw new Error("Wrong password for the online database.");
    if (res.status === 429) throw new Error("Too many wrong passwords — wait a few minutes.");
    return res;
  }

  async function json(pathname, opts) {
    const res = await request(pathname, opts);
    let out;
    try { out = await res.json(); } catch { throw new Error(`Online server error (${res.status}).`); }
    if (out && out.version) lastVersion = Math.max(lastVersion, out.version);
    if (!out || out.ok !== true) throw new Error((out && out.error) || `Online server error (${res.status}).`);
    return out;
  }

  return {
    url: base,
    ping: () => json("/api/ping", { timeout: FIRST_TIMEOUT_MS }),
    call: async (fn, args) => (await json("/api/call", { method: "POST", body: { fn, args } })).data,
    /** Returns true when someone ELSE saved since our last call. */
    async changedElsewhere() {
      const before = lastVersion;
      const out = await json("/api/version", { timeout: 15_000 });
      return before > 0 && out.version > before;
    },
    async backup() {
      const res = await request("/api/backup", { timeout: FIRST_TIMEOUT_MS });
      if (!res.ok) throw new Error(`Backup failed (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function makeRemoteDb(localDb, client) {
  const special = {
    isOpen: () => true,
    currentPath: () => "Online · " + client.url,
    ensureFresh: () => false,
    fileMtime: () => 0,
    getLoadedMtime: () => 0,
    open: () => { throw new Error("Switch this computer off the online database first."); },
  };
  return new Proxy({}, {
    get(_t, prop) {
      if (prop in special) return special[prop];
      const v = localDb[prop];
      if (typeof v !== "function") return v;
      return (...args) => client.call(prop, args);
    },
  });
}

module.exports = { makeClient, makeRemoteDb, cleanUrl };
