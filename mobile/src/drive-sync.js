/* Wahga Dairy Farm — keep the phone's database in step with the shared
 * wahga-dairy.db in Google Drive.
 *
 * Like the desktop app (which opens G:\My Drive\Wahga Dairy Farm\wahga-dairy.db),
 * the user picks that file ONCE with Android's file picker — inside the Google
 * Drive app. Android remembers the choice (SharedFile plugin, MainActivity).
 *
 *   pull  — if the Drive file changed (another device saved), load it.
 *   push  — save the phone's database back into the Drive file.
 *
 * Before every change on the phone we pull first, so the change is made on
 * top of the latest data; right after it we push. If the phone could not
 * save (offline) and someone else saved meanwhile, the user chooses.
 */
(function () {
  "use strict";

  const KEY = "wahga-drive";
  const Plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
  const F = window.WAHGA_FILES;

  let state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { state = {}; }
  const saveState = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };

  function plugin() {
    const P = Plugins().SharedFile;
    if (!P) throw new Error("This works in the Android app only.");
    return P;
  }
  // a file's "version": changes whenever anyone saves it
  const versionOf = (info) => `${info.modified || 0}:${info.size || 0}`;
  const isSqlite = (u8) => u8 && u8.length > 100 && new TextDecoder().decode(u8.subarray(0, 15)) === "SQLite format 3";

  async function remoteMeta() { return plugin().stat({ uri: state.uri }); }
  async function download() {
    const r = await plugin().read({ uri: state.uri });
    const bytes = F.base64ToBytes(r.data);
    if (!isSqlite(bytes)) throw new Error("The picked file is not a Wahga database (wahga-dairy.db).");
    await F.replaceDb(bytes);
    await window.WAHGA_DB.open(F.DB_FILE);
    return r;
  }
  async function upload() {
    await F.flush();
    return plugin().write({ uri: state.uri, data: F.bytesToBase64(F.currentBytes()) });
  }

  /* ---------- "both changed" choice ---------- */
  function choose(title, text, a, b) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "overlay center";
      ov.innerHTML = `<div class="modal" style="width:420px"><h2></h2><p style="color:var(--muted)"></p>
        <div class="drawer-actions"><button class="btn secondary" data-v="b"></button><button class="btn" data-v="a"></button></div></div>`;
      ov.querySelector("h2").textContent = title;
      ov.querySelector("p").textContent = text;
      ov.querySelector('[data-v="a"]').textContent = a;
      ov.querySelector('[data-v="b"]').textContent = b;
      ov.addEventListener("click", (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) { ov.remove(); resolve(v); } });
      document.getElementById("overlay-root").append(ov);
    });
  }

  /* ---------- sync steps (run one at a time) ---------- */
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  const listeners = new Set();
  const notify = (kind) => listeners.forEach((fn) => { try { fn(status(), kind); } catch { /* ignore */ } });
  const stamp = (kind) => { state.lastSync = new Date().toISOString(); saveState(); notify(kind); };

  /** Load the Drive file if it changed. Returns true when the phone data changed. */
  function pull() {
    return serial(async () => {
      if (!state.uri) return false;
      const meta = await remoteMeta();
      if (versionOf(meta) === state.version) return false;
      if (state.dirty) {
        const pick = await choose("Data changed in two places",
          "This phone has changes that were not saved to Google Drive yet, and someone also saved on another device. Which copy should be kept?",
          "Keep Drive's copy", "Keep phone's copy");
        if (pick === "b") { const r = await upload(); state.version = versionOf(r); state.dirty = false; stamp("pushed"); return false; }
      }
      const r = await download();
      state.version = versionOf(r); state.dirty = false; stamp("pulled");
      return true;
    });
  }
  /** Save the phone's data into the Drive file. On failure it is remembered and retried later. */
  function push() {
    return serial(async () => {
      if (!state.uri) return;
      try {
        const r = await upload();
        state.version = versionOf(r); state.dirty = false; stamp("pushed");
      } catch (e) {
        state.dirty = true; saveState(); notify("failed");
        throw e;
      }
    });
  }

  /** Pick wahga-dairy.db (in the Google Drive app) and start using it. */
  async function connect() {
    let info;
    try { info = await plugin().pick(); }
    catch (e) { if (/cancel/i.test(String(e && e.message))) return null; throw e; }
    if (!info.writable) throw new Error("That file can only be read, not saved. Ask the owner to give you Editor access to the “Wahga Dairy Farm” folder.");
    const prev = state;
    state = { uri: info.uri, fileName: info.name || "wahga-dairy.db", version: null, dirty: false };
    try {
      await serial(async () => { const r = await download(); state.version = versionOf(r); stamp("pulled"); });
    } catch (e) {
      state = prev; saveState(); notify();
      throw e;
    }
    return info;
  }
  function disconnect() { state = {}; saveState(); notify(); }
  function status() {
    return { connected: !!state.uri, file: state.fileName || "", lastSync: state.lastSync || null, dirty: !!state.dirty };
  }

  window.WAHGA_SYNC = { connect, disconnect, pull, push, status, onChange: (fn) => listeners.add(fn) };
})();
