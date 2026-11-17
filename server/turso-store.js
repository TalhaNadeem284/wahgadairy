"use strict";

/**
 * Keeps the in-memory sql.js database (where all of db.js runs) mirrored to
 * the online Turso (libSQL) database.
 *
 *  - load(memDb)   copy every table + index + row from Turso into memory
 *  - track(memDb)  record every changed row via SQLite's update hook
 *                  (also catches ON DELETE CASCADE deletions)
 *  - flush()       write the changed rows to Turso in ONE transaction:
 *                  rows still in memory are upserted, vanished rows deleted
 *  - syncSchema()  after migrate(): create new tables/indexes, add new columns
 *
 * Tables without an INTEGER PRIMARY KEY (e.g. settings, keyed by text) have a
 * rowid that differs between the two databases, so any change to them
 * re-copies the whole (tiny) table.
 */

const { createClient } = require("@libsql/client");

const SKIP = (name) => /^sqlite_/.test(name) || /^_litestream/.test(name);

function makeStore({ url, authToken }) {
  const client = createClient({ url, authToken });
  let mem = null;
  const dirty = new Map(); // "table\u0000rowid" -> { table, rowid }
  const fullTables = new Set();
  const tableInfoCache = new Map();

  function memAll(sql, params = []) {
    const st = mem.prepare(sql);
    try {
      st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally {
      st.free();
    }
  }

  /** Columns + whether the table's PK is an alias for rowid (INTEGER PRIMARY KEY). */
  function tableInfo(table) {
    if (tableInfoCache.has(table)) return tableInfoCache.get(table);
    const cols = memAll(`PRAGMA table_info("${table}")`);
    const pk = cols.filter((c) => c.pk > 0);
    const info = {
      cols: cols.map((c) => c.name),
      pkCol: pk.length === 1 && /^integer$/i.test(pk[0].type) ? pk[0].name : null,
    };
    tableInfoCache.set(table, info);
    return info;
  }

  async function load(memDb) {
    mem = memDb;
    const schema = await client.execute(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
    );
    const tables = [];
    for (const r of schema.rows) {
      if (SKIP(r.name)) continue;
      mem.run(r.sql);
      if (r.type === "table") tables.push(r.name);
    }
    mem.run("BEGIN");
    try {
      for (const t of tables) {
        const res = await client.execute(`SELECT * FROM "${t}"`);
        if (!res.rows.length) continue;
        const cols = res.columns;
        const st = mem.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
        try {
          for (const row of res.rows) st.run(cols.map((c) => normalize(row[c])));
        } finally {
          st.free();
        }
      }
      mem.run("COMMIT");
    } catch (e) {
      try { mem.run("ROLLBACK"); } catch {}
      throw e;
    }
    return tables.length;
  }

  function normalize(v) {
    if (typeof v === "bigint") return Number(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v === undefined ? null : v;
  }

  function track(memDb) {
    mem = memDb;
    mem.updateHook((_op, _dbName, table, rowid) => {
      if (SKIP(table)) return;
      dirty.set(table + "\u0000" + rowid, { table, rowid });
    });
  }

  function hasChanges() {
    return dirty.size > 0 || fullTables.size > 0;
  }

  function discard() {
    dirty.clear();
    fullTables.clear();
  }

  /** Build the statements that bring Turso in line with memory for the changed rows. */
  function buildStatements() {
    const deletes = [];
    const upserts = [];
    const whole = new Set(fullTables);
    for (const { table, rowid } of dirty.values()) {
      const info = tableInfo(table);
      if (!info.pkCol) { whole.add(table); continue; }
      const row = memAll(`SELECT * FROM "${table}" WHERE rowid = ?`, [rowid])[0];
      if (!row) {
        deletes.push({ sql: `DELETE FROM "${table}" WHERE "${info.pkCol}" = ?`, args: [rowid] });
      } else {
        const cols = info.cols;
        const set = cols.filter((c) => c !== info.pkCol).map((c) => `"${c}" = excluded."${c}"`).join(", ");
        upserts.push({
          sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})` +
            (set ? ` ON CONFLICT("${info.pkCol}") DO UPDATE SET ${set}` : ` ON CONFLICT("${info.pkCol}") DO NOTHING`),
          args: cols.map((c) => normalize(row[c])),
        });
      }
    }
    const stmts = [...deletes];
    for (const table of whole) {
      const cols = tableInfo(table).cols;
      stmts.push({ sql: `DELETE FROM "${table}"`, args: [] });
      for (const row of memAll(`SELECT * FROM "${table}"`)) {
        stmts.push({
          sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          args: cols.map((c) => normalize(row[c])),
        });
      }
    }
    return stmts.concat(upserts);
  }

  /** Write all pending changes to Turso atomically. Returns the number of statements sent. */
  async function flush() {
    if (!hasChanges()) return 0;
    const stmts = buildStatements();
    discard();
    if (stmts.length) await client.batch(stmts, "write");
    return stmts.length;
  }

  /** Bring Turso's schema up to the in-memory schema (new tables, indexes, columns). */
  async function syncSchema() {
    tableInfoCache.clear();
    const remote = await client.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL");
    const have = new Map(remote.rows.map((r) => [r.name, r]));
    const local = memAll("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END");
    const stmts = [];
    for (const l of local) {
      if (SKIP(l.name)) continue;
      if (!have.has(l.name)) {
        stmts.push(l.sql);
        if (l.type === "table") fullTables.add(l.name); // copy its rows too
        continue;
      }
      if (l.type !== "table") continue;
      const rcols = new Set((await client.execute(`PRAGMA table_info("${l.name}")`)).rows.map((c) => c.name));
      for (const c of memAll(`PRAGMA table_info("${l.name}")`)) {
        if (rcols.has(c.name)) continue;
        let decl = `"${c.name}" ${c.type || ""}`;
        if (c.notnull) decl += " NOT NULL";
        if (c.dflt_value !== null && c.dflt_value !== undefined) decl += ` DEFAULT ${c.dflt_value}`;
        // Turso fills the same DEFAULT; any back-fill UPDATEs migrate() ran were tracked row by row.
        stmts.push(`ALTER TABLE "${l.name}" ADD COLUMN ${decl}`);
      }
    }
    for (const s of stmts) await client.execute(s);
    return stmts.length;
  }

  return { client, load, track, flush, syncSchema, hasChanges, discard };
}

module.exports = { makeStore };
