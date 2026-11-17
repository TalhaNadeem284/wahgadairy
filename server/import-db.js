"use strict";

/**
 * One-time upload of a local wahga-dairy.db into an EMPTY Turso database.
 *
 *   node server/import-db.js "G:\My Drive\Wahga Dairy Farm\wahga-dairy.db"
 *   (env TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or a server/.env file)
 *
 * --replace   wipe the Turso database first (DANGER: overwrites online data)
 * --verify    only compare row counts local vs Turso
 */

const fs = require("fs");
const path = require("path");
require("./env").load();
const initSqlJs = require("sql.js");
const { createClient } = require("@libsql/client");

(async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const replace = args.includes("--replace");
  const verifyOnly = args.includes("--verify");
  if (!file || !fs.existsSync(file)) throw new Error("Give the path of the .db file to upload.");
  if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is not set (put it in server/.env)");

  const SQL = await initSqlJs();
  const local = new SQL.Database(fs.readFileSync(file));
  const q = (sql) => { const r = local.exec(sql)[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
  const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

  const objects = q("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name");
  const tables = objects.filter((o) => o.type === "table").map((o) => o.name);

  async function counts() {
    let same = true;
    for (const t of tables) {
      const a = q(`SELECT count(*) n FROM "${t}"`)[0].n;
      let b = "missing";
      try { b = Number((await client.execute(`SELECT count(*) n FROM "${t}"`)).rows[0].n); } catch {}
      if (a !== b) same = false;
      console.log(`${a === b ? "✓" : "✗"} ${t.padEnd(22)} local ${String(a).padStart(5)}   online ${b}`);
    }
    return same;
  }
  if (verifyOnly) { process.exit((await counts()) ? 0 : 1); }

  const existing = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'")).rows.map((r) => r.name);
  if (existing.length && !replace) {
    throw new Error(`The online database already has ${existing.length} tables. Run with --replace to overwrite it (this deletes the online data).`);
  }
  if (replace) {
    const idx = (await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")).rows.map((r) => r.name);
    await client.batch([...idx.map((n) => `DROP INDEX IF EXISTS "${n}"`), ...existing.map((n) => `DROP TABLE IF EXISTS "${n}"`)], "write");
  }

  await client.batch(objects.filter((o) => o.type === "table").map((o) => o.sql), "write");
  for (const t of tables) {
    const rows = q(`SELECT * FROM "${t}"`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    for (let i = 0; i < rows.length; i += 400) {
      await client.batch(rows.slice(i, i + 400).map((r) => ({ sql, args: cols.map((c) => r[c] instanceof Uint8Array ? r[c] : r[c] ?? null) })), "write");
    }
    process.stdout.write(`  ${t}: ${rows.length}\n`);
  }
  await client.batch(objects.filter((o) => o.type !== "table").map((o) => o.sql), "write");
  console.log("\nUploaded. Checking…");
  const ok = await counts();
  console.log(ok ? "\nAll tables match. ✅" : "\nMISMATCH — do not switch the app to online yet.");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
