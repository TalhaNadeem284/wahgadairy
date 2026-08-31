"use strict";

/**
 * Tiny JSON config store in the app's own userData dir (NOT the shared
 * database). Its only real job is to remember WHERE the shared database
 * file lives — typically a path inside a Google Drive / OneDrive / Dropbox
 * folder that syncs between the computers that run this app.
 */

const path = require("path");
const fs = require("fs");

let configPath;
let cache = {};

function init(userDataDir) {
  configPath = path.join(userDataDir, "config.json");
  try {
    cache = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function get(key) {
  return cache[key];
}

function set(key, value) {
  cache[key] = value;
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, configPath);
  return cache;
}

function all() {
  return { ...cache };
}

module.exports = { init, get, set, all };
