"use strict";
// Refreshes seed/wahga-dairy-seed.db from whatever database this machine's app
// currently uses, so a fresh build ships with the latest data. Run before
// `npm run dist` if you want the installer to carry current data.
const fs = require("fs");
const path = require("path");

const configPath = path.join(process.env.APPDATA || "", "wahga-dairy-desktop", "config.json");
let dbPath;
try {
  dbPath = JSON.parse(fs.readFileSync(configPath, "utf8")).dbPath;
} catch {
  console.error("Could not read", configPath, "- open the app once, or set the DB path.");
  process.exit(1);
}
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("Database not found at", dbPath);
  process.exit(1);
}
const dest = path.join(__dirname, "..", "seed", "wahga-dairy-seed.db");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(dbPath, dest);
console.log("seed refreshed from", dbPath, "->", dest, `(${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
