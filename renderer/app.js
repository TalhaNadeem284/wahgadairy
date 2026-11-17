"use strict";

/* window.api is exposed by preload. Never shadow it with a local `api`. */
// window.api, but a successful save/delete also clears the "typed but not saved" mark
const A = Object.fromEntries(Object.entries(window.api).map(([k, f]) => [k,
  typeof f === "function" && /save|delete|create/i.test(k)
    ? (...args) => f(...args).then((r) => { if (r && r.ok) pageEdited = false; return r; })
    : f]));

/* ------------------------------------------------------------------ */
/*  tiny helpers                                                       */
/* ------------------------------------------------------------------ */
async function rpc(promise) {
  const res = await promise;
  if (!res || res.ok !== true) throw new Error((res && res.error) || "Request failed");
  return res.data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const $ = (sel, root = document) => root.querySelector(sel);

function toast(msg, kind = "") {
  const t = el("div", { class: "toast " + kind, text: msg });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "err" ? 5000 : 2800);
}

let SETTINGS = {};
let META = {};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function currency() { return SETTINGS.currency || "Rs"; }
function money(n) {
  const v = Math.round(Number(n) || 0);
  return currency() + " " + v.toLocaleString("en-PK");
}
function money2(n) {
  const v = Number(n) || 0;
  return currency() + " " + v.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function litres(n) { return (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 }) + " L"; }
const todayStr = () => new Date().toLocaleDateString("en-CA");
function monthStartStr() { const d = new Date(); return d.toLocaleDateString("en-CA").slice(0, 8) + "01"; }
const iso = (d) => d.toLocaleDateString("en-CA");
/** Show a stored YYYY-MM-DD date as DD-MM-YYYY (day-month-year). Storage,
 *  sorting and range queries all keep the ISO form — this is display only. */
function fmtDate(s) {
  const m = String(s == null ? "" : s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s == null || s === "" ? "—" : String(s));
}
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }

/** Named billing periods. Returns { from, to } as YYYY-MM-DD. */
function period(name) {
  const now = new Date();
  const t = iso(now);
  switch (name) {
    case "last7": return { from: iso(addDays(now, -6)), to: t };
    case "last10": return { from: iso(addDays(now, -9)), to: t };
    case "last15": return { from: iso(addDays(now, -14)), to: t };
    case "thisweek": {
      const day = (now.getDay() + 6) % 7; // Monday = 0
      return { from: iso(addDays(now, -day)), to: t };
    }
    case "lastweek": {
      const day = (now.getDay() + 6) % 7;
      const monThis = addDays(now, -day);
      return { from: iso(addDays(monThis, -7)), to: iso(addDays(monThis, -1)) };
    }
    case "thismonth": return { from: monthStartStr(), to: t };
    case "lastmonth": {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0");
      const last = new Date(y, d.getMonth() + 1, 0).getDate();
      return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, "0")}` };
    }
    default: return { from: monthStartStr(), to: t };
  }
}
/* Society groups: every client list shows AWT first, then Dream Garden, Tricon, Other. */
const SOCIETY_ORDER = ["AWT", "Dream Garden", "Tricon", "Engineering Town", "Model Town", "Other"];
const societyOf = (r) => (r && SOCIETY_ORDER.includes(r.society) ? r.society : "Other");
const societyRank = (r) => SOCIETY_ORDER.indexOf(societyOf(r));
/** Coloured heading row that starts a society group inside a table. */
function groupHeadRow(label, colspan) {
  const info = el("span", { class: "group-info" });
  const tr = el("tr", { class: "group-row" }, [el("td", { colSpan: colspan }, [el("span", { text: "📍 " + label }), info])]);
  return { tr, info };
}
const BILLING_CYCLE_OPTIONS = [
  { value: "10day", label: "Every 10 days (1–10, 11–20, 21–end)" },
  { value: "monthly", label: "Monthly" },
];
const cycleLabel = (c) => (c === "10day" ? "10 days" : "Monthly");
/** 10-day billing blocks of the month that contains `anyDate`: 1–10, 11–20, 21–last day. */
function tenDayBlock(anyDate, n) {
  const [y, m] = anyDate.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  const pick = [[1, 10], [11, 20], [21, last]][n];
  return { from: `${y}-${mm}-${String(pick[0]).padStart(2, "0")}`, to: `${y}-${mm}-${String(pick[1]).padStart(2, "0")}` };
}
const PERIOD_PRESETS = [
  ["thisweek", "This week"],
  ["last7", "Last 7 days"],
  ["last10", "Last 10 days"],
  ["last15", "Last 15 days"],
  ["thismonth", "This month"],
  ["lastmonth", "Last month"],
];
function titleCase(s) { return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase()); }

function confirmBox(message) {
  return new Promise((resolve) => {
    const ov = el("div", { class: "overlay center" });
    const box = el("div", { class: "modal", style: "width:400px" }, [
      el("h2", { text: "Please confirm" }),
      el("p", { text: message, style: "color:var(--muted)" }),
      el("div", { class: "drawer-actions" }, [
        el("button", { class: "btn secondary", onclick: () => { ov.remove(); resolve(false); } }, "Cancel"),
        el("button", { class: "btn danger", onclick: () => { ov.remove(); resolve(true); } }, "Yes, continue"),
      ]),
    ]);
    ov.append(box);
    ov.addEventListener("click", (e) => { if (e.target === ov) { ov.remove(); resolve(false); } });
    $("#overlay-root").append(ov);
  });
}

function openOverlay(node, { center = false } = {}) {
  const ov = el("div", { class: "overlay" + (center ? " center" : "") });
  ov.append(node);
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  $("#overlay-root").append(ov);
  return () => ov.remove();
}

/* ------------------------------------------------------------------ */
/*  routing                                                            */
/* ------------------------------------------------------------------ */
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "🏠" },
  { id: "order", label: "Milk Order", icon: "🛒" },
  { id: "daily", label: "Daily Entry", icon: "📝" },
  { id: "clients", label: "Clients", icon: "👥" },
  { id: "settlements", label: "Settlements", icon: "💰" },
  { id: "entries", label: "Milk Entries", icon: "🥛" },
  { id: "morning", label: "Morning Milk", icon: "🌅" },
  { id: "purchases", label: "Purchases", icon: "🚚" },
  { id: "loans", label: "Loans", icon: "🏦" },
  { id: "staff", label: "Staff & Salary", icon: "👷" },
  { id: "expenses", label: "Expenses", icon: "🧾" },
  { id: "pl", label: "Profit & Loss", icon: "📊" },
  { id: "billing", label: "Invoices & Statements", icon: "📄" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

let currentView = null;
let currentParams = {};
let pageEdited = false; // something typed on this page and not saved yet

function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  for (const item of NAV) {
    nav.append(el("button", {
      class: currentView === item.id ? "active" : "",
      onclick: () => go(item.id),
    }, [el("span", { class: "ic", text: item.icon }), item.label]));
  }
}

async function refreshDbInfo() {
  try {
    const s = await rpc(A.dbStatus());
    const box = $("#dbinfo");
    box.innerHTML = "";
    if (s.online) {
      box.append(el("div", { text: "🌐 Online database" }));
      box.append(el("div", { text: s.serverUrl.replace(/^https?:\/\//, ""), style: "margin-top:2px" }));
      box.append(el("div", { class: "sync", text: "Live — every computer sees changes", style: "margin-top:6px" }));
      return;
    }
    box.append(el("div", { text: "Shared database:" }));
    box.append(el("div", { text: s.path || "(not set)", style: "margin-top:2px" }));
    box.append(el("div", { class: "sync", text: "Auto-syncs via your cloud folder", style: "margin-top:6px" }));
  } catch { /* ignore */ }
}

async function go(view, params) {
  currentView = view;
  currentParams = params || {};
  pageEdited = false;
  renderNav();
  const main = $("#main");
  main.className = "";
  main.innerHTML = "<div class='spin'>Loading…</div>";
  try {
    await VIEWS[view](main, params || {});
  } catch (err) {
    main.innerHTML = "";
    main.append(el("div", { class: "card", html: "<h2>Something went wrong</h2>" }));
    main.append(el("pre", { text: err.message, style: "color:var(--danger);white-space:pre-wrap" }));
  }
}

/* ------------------------------------------------------------------ */
/*  shared UI pieces                                                   */
/* ------------------------------------------------------------------ */
/** Re-read the shared database file (another PC / the phone may have saved) and redraw this page. */
async function refreshPage(ev) {
  const btn = ev && ev.currentTarget;
  if (pageEdited && !confirm("You typed something on this page that is not saved yet. Refresh anyway and lose it?")) return;
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Refreshing…"; }
  try {
    const r = await rpc(A.dbReload());
    try { SETTINGS = await rpc(A.settingsGet()); } catch { /* keep old */ }
    toast(r.reloaded ? "Loaded the latest changes" : "Already up to date — page refreshed", "ok");
    await go(currentView, currentParams);
  } catch (e) {
    toast(e.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = "🔄 Refresh"; }
  }
}

function pageHead(title, sub, actions) {
  const head = el("div", { class: "page-head" });
  const rowTop = el("div", { class: "row between" }, [
    el("div", {}, [el("h1", { text: title }), sub ? el("p", { text: sub }) : null]),
  ]);
  const refreshBtn = el("button", { class: "btn secondary", title: "Load changes saved on another computer or the phone", onclick: refreshPage }, "🔄 Refresh");
  rowTop.append(el("div", { class: "row" }, [...(actions || []), refreshBtn]));
  head.append(rowTop);
  return head;
}

function field(labelText, control) {
  return el("label", { class: "field" }, [el("span", { text: labelText }), control]);
}
function input(attrs = {}) { return el("input", attrs); }
function selectBox(options, value, attrs = {}) {
  const s = el("select", attrs);
  for (const o of options) {
    const opt = typeof o === "string" ? { value: o, label: titleCase(o) } : o;
    const node = el("option", { value: opt.value }, opt.label);
    if (String(opt.value) === String(value)) node.selected = true;
    s.append(node);
  }
  return s;
}

/** A single "Client" field you can type into: a text input with its own
 *  dropdown that filters the client list live as you type (click to open the
 *  full list, ↑/↓ + Enter to pick). `onChange(id)` fires when the resolved
 *  client changes (number id). Returns { control, input, get value() } — drop
 *  `control` into the existing `field("Client", …)`. */
function clientPicker(clients, currentId, onChange) {
  let value = String(currentId || clients[0]?.id || "");
  const nameOf = (id) => (clients.find((c) => String(c.id) === String(id)) || {}).name || "";

  const box = input({ autocomplete: "off", placeholder: "Type a client name…", value: nameOf(value) });
  const menu = el("div", { class: "cp-menu", hidden: true });
  const control = el("div", { class: "cp" }, [box, menu]);
  let hl = -1;        // highlighted row in the current menu
  let typed = false;  // has the user edited the text since focusing?

  function commit(c) {
    const changed = String(c.id) !== value;
    value = String(c.id);
    box.value = c.name;
    box.classList.remove("bad");
    typed = false;
    menu.hidden = true;
    if (changed) onChange(Number(value));
  }

  // `typed` false → show every client (a plain click opens the full list);
  // `typed` true → filter live by what's in the box.
  function openMenu() {
    const q = typed ? box.value.trim().toLowerCase() : "";
    const matches = (q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients).slice(0, 200);
    menu.innerHTML = "";
    hl = -1;
    if (!matches.length) { menu.hidden = true; return; }
    matches.forEach((c, idx) => {
      const on = String(c.id) === value;
      const item = el("div", { class: "cp-item" + (on ? " on" : ""), text: c.name });
      item.addEventListener("mousedown", (e) => { e.preventDefault(); commit(c); });
      item.addEventListener("mouseenter", () => { hl = idx; paintHl(); });
      menu.append(item);
      if (on && !q) hl = idx;
    });
    menu.hidden = false;
    paintHl();
  }
  function paintHl() {
    [...menu.children].forEach((n, i) => n.classList.toggle("hl", i === hl));
    if (hl >= 0 && menu.children[hl]) menu.children[hl].scrollIntoView({ block: "nearest" });
  }

  box.addEventListener("focus", () => { typed = false; box.select(); openMenu(); });
  box.addEventListener("click", () => { if (menu.hidden) openMenu(); });
  box.addEventListener("input", () => { typed = true; box.classList.remove("bad"); openMenu(); });
  box.addEventListener("keydown", (e) => {
    if (menu.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { openMenu(); return; }
    const n = menu.children.length;
    if (e.key === "ArrowDown") { e.preventDefault(); hl = n ? (hl + 1) % n : -1; paintHl(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hl = n ? (hl - 1 + n) % n : -1; paintHl(); }
    else if (e.key === "Enter") {
      if (!menu.hidden && hl >= 0) { e.preventDefault(); menu.children[hl].dispatchEvent(new MouseEvent("mousedown")); }
    } else if (e.key === "Escape") { menu.hidden = true; }
  });
  box.addEventListener("blur", () => {
    setTimeout(() => { menu.hidden = true; }, 120);
    const q = box.value.trim().toLowerCase();
    let match = clients.find((c) => c.name.toLowerCase() === q);
    if (!match && q) { const p = clients.filter((c) => c.name.toLowerCase().includes(q)); if (p.length === 1) match = p[0]; }
    if (match) commit(match);
    else { box.value = nameOf(value); box.classList.remove("bad"); typed = false; } // snap back to last valid client
  });

  return { control, input: box, get value() { return Number(value); } };
}

/** Does row `r` contain the lowercased query `q`? `spec` is an array of row
 *  keys to look in, or a function returning the haystack string. */
function rowMatches(r, q, spec) {
  if (!q) return true;
  const hay = typeof spec === "function" ? spec(r) : spec.map((k) => r[k]).join("  ");
  return String(hay == null ? "" : hay).toLowerCase().includes(q);
}

function dataTable(columns, rows, opts = {}) {
  const { onRowClick, footer, empty = "Nothing here yet.", search, searchPlaceholder, groupBy } = opts;
  const wrap = el("div");
  const tableWrap = el("div", { class: "table-wrap" });
  let query = "";

  function build() {
    tableWrap.innerHTML = "";
    const shown = search && query ? rows.filter((r) => rowMatches(r, query, search)) : rows;
    if (!shown.length) {
      tableWrap.append(el("div", { class: "empty", text: query ? "Nothing matches “" + query + "”." : empty }));
      return;
    }
    const table = el("table", { class: "data" });
    const thead = el("thead");
    const htr = el("tr");
    for (const c of columns) htr.append(el("th", { class: c.num ? "num" : "", text: c.header }));
    thead.append(htr);
    const tbody = el("tbody");
    // groupBy "society": rows sorted AWT → Dream Garden → Tricon → Other (keeps the
    // order inside each group), a heading row per group and a subtotal row under it.
    let groups = [[null, shown]];
    if (groupBy) {
      const sorted = shown.slice().sort((a, b) => societyRank(a) - societyRank(b));
      groups = [];
      for (const r of sorted) {
        const g = societyOf(r);
        if (!groups.length || groups[groups.length - 1][0] !== g) groups.push([g, []]);
        groups[groups.length - 1][1].push(r);
      }
    }
    for (const [label, list] of groups) {
      if (label) {
        const h = groupHeadRow(label, columns.length);
        h.info.textContent = ` · ${list.length} ${opts.groupNoun || "clients"}`;
        tbody.append(h.tr);
      }
      for (const r of list) {
        const tr = el("tr", { class: onRowClick ? "clickable" : "" });
        if (onRowClick) tr.addEventListener("click", () => onRowClick(r));
        for (const c of columns) {
          const val = c.render ? c.render(r) : r[c.key];
          const td = el("td", { class: c.num ? "num" : "" });
          if (val && val.nodeType) td.append(val); else td.textContent = val == null ? "—" : String(val);
          tr.append(td);
        }
        tbody.append(tr);
      }
      if (label && groups.length > 1 && typeof footer === "function") {
        const cells = footer(list).slice();
        cells[0] = { text: label + " total" };
        const str = el("tr", { class: "subtotal-row" });
        for (const cell of cells) str.append(el("td", { class: cell.num ? "num" : "", text: cell.text }));
        tbody.append(str);
      }
    }
    table.append(thead, tbody);
    const foot = typeof footer === "function" ? footer(shown) : footer;
    if (foot) {
      const tfoot = el("tfoot");
      const ftr = el("tr");
      foot.forEach((cell, i) => ftr.append(el("td", { class: cell.num ? "num" : "", text: i === 0 && groups.length > 1 ? "Grand total" + (cell.text && cell.text !== "Total" ? " · " + cell.text : "") : cell.text })));
      tfoot.append(ftr);
      table.append(tfoot);
    }
    tableWrap.append(table);
  }

  if (search && rows.length) {
    const si = input({ type: "search", placeholder: searchPlaceholder || "Search…", value: "" });
    si.addEventListener("input", () => { query = si.value.trim().toLowerCase(); build(); });
    wrap.append(el("div", { class: "table-search" }, [si]));
  }
  build();
  wrap.append(tableWrap);
  return wrap;
}

function dateRangeControls(from, to, onChange) {
  const f = input({ type: "date", value: from });
  const t = input({ type: "date", value: to });
  f.addEventListener("change", () => onChange(f.value, t.value));
  t.addEventListener("change", () => onChange(f.value, t.value));
  return el("div", { class: "row" }, [field("From", f), field("To", t)]);
}

/* ------------------------------------------------------------------ */
/*  VIEWS                                                              */
/* ------------------------------------------------------------------ */
const VIEWS = {};

/* ---- setup (no database yet) ---- */
/** Dialog: server address + shared password → switch this computer to the online database. */
function onlineConnectModal(presetUrl) {
  const url = input({ type: "text", placeholder: "https://wahga-dairy-api.onrender.com", value: presetUrl || "" });
  const pw = input({ type: "password", placeholder: "Shared password" });
  const msg = el("div", { class: "mini", style: "min-height:18px;margin-top:8px" });
  const goBtn = el("button", { class: "btn" }, "Connect");
  let close;
  async function connect() {
    goBtn.disabled = true;
    msg.style.color = "";
    msg.textContent = "⏳ Connecting… the first time each morning the server can take up to a minute to wake up.";
    try {
      await rpc(A.onlineConnect(url.value, pw.value));
      close();
      toast("Connected to the online database", "ok");
      await boot();
    } catch (e) {
      msg.style.color = "var(--danger)";
      msg.textContent = e.message;
      goBtn.disabled = false;
    }
  }
  goBtn.onclick = connect;
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  const box = el("div", { class: "modal", style: "width:440px" }, [
    el("h2", { text: "🌐 Use the online database" }),
    el("p", { class: "mini", text: "All computers that connect here share ONE live database on the internet. You need internet to save." }),
    field("Server address", url),
    field("Password", pw),
    msg,
    el("div", { class: "drawer-actions" }, [el("button", { class: "btn secondary", onclick: () => close() }, "Cancel"), goBtn]),
  ]);
  close = openOverlay(box, { center: true });
  setTimeout(() => (presetUrl ? pw : url).focus(), 50);
}

async function showSetup(reason, dbPath, extra = {}) {
  $("#sidebar").classList.add("hidden");
  const main = $("#main");
  main.className = "center";
  main.innerHTML = "";
  const box = el("div", { class: "card setup-box" });
  box.append(el("div", { class: "logo-big", text: "🥛" }));
  box.append(el("h1", { text: "Wahga Dairy Farm", style: "margin:0 0 6px" }));
  box.append(el("p", {
    style: "color:var(--muted);margin:0 0 18px",
    text: reason === "online-error"
      ? "Can't open the online database: " + (extra.error || "no connection") + " Check the internet, then press Try again."
      : reason === "folder-missing"
      ? "The database folder isn't available right now (" + (dbPath || "") + "). Make sure your cloud drive (Google Drive / OneDrive) is running, then reopen — or choose it again below."
      : "Choose where the database lives. To share data with another computer, keep it in a Google Drive / OneDrive / Dropbox folder that syncs to both.",
  }));

  if (reason === "online-error") {
    const retry = el("button", { class: "btn" }, "🔄  Try again");
    retry.onclick = async () => {
      retry.disabled = true; retry.textContent = "⏳ Connecting…";
      try { await rpc(A.onlineRetry()); await boot(); }
      catch (e) { toast(e.message, "err"); retry.disabled = false; retry.textContent = "🔄  Try again"; }
    };
    box.append(retry);
    box.append(el("button", { class: "btn secondary", onclick: () => onlineConnectModal(extra.serverUrl) }, "🔑  Change server / password"));
    box.append(el("button", { class: "btn ghost", onclick: async () => {
      if (!(await confirmBox("Stop using the online database on this computer and go back to the local / Google Drive file? Anything saved online will NOT be in that file."))) return;
      await rpc(A.onlineDisconnect()); await boot();
    } }, "Use the local file instead"));
    main.append(box);
    return;
  }
  if (A.onlineConnect && !window.Capacitor) {
    box.append(el("button", { class: "btn", onclick: () => onlineConnectModal() }, "🌐  Connect to the online database"));
  }
  const clouds = await rpc(A.dbCloudFolders()).catch(() => []);
  const shared = clouds.find((c) => c.existingDb);
  if (shared) {
    box.append(el("div", { class: "inline-note", style: "margin-bottom:12px", text: `Found a shared database in ${shared.name}.` }));
    box.append(el("button", { class: "btn", onclick: () => openFileAt(shared.existingDb) },
      `☁️  Open the shared database from ${shared.name}`));
  }
  for (const c of clouds) {
    if (c.existingDb) continue;
    box.append(el("button", { class: shared ? "btn secondary" : "btn", onclick: () => useCloud(c) },
      `☁️  Put a new database in ${c.name}`));
  }
  box.append(el("button", { class: "btn secondary", onclick: pickExisting },
    "📂  Open an existing database file"));
  box.append(el("button", { class: "btn ghost", onclick: pickFolder },
    "Choose another folder / new database"));

  box.append(el("div", { class: "mini", style: "margin-top:14px" },
    clouds.length
      ? "To share with another computer: on one PC use “Put a new database in …”, then on the other install the app — it will find that synced database automatically."
      : "No cloud drive found. Install Google Drive for Desktop or OneDrive for sharing, or just pick a folder for local use."));
  main.append(box);
}

async function openFileAt(filePath) {
  try {
    await rpc(A.dbOpenPath(filePath));
    toast("Opened the shared database", "ok");
    await boot();
  } catch (e) { toast(e.message, "err"); }
}

async function useCloud(c) {
  try {
    const r = await rpc(A.dbUseCloud(c.path));
    toast((r.seededFrom ? "Database created with current data in " : "Database ready in ") + c.name, "ok");
    await boot();
  } catch (e) { toast(e.message, "err"); }
}
async function pickFolder() {
  try {
    const r = await rpc(A.dbPick());
    if (r.canceled) return;
    toast((r.seededFrom ? "Database created with current data: " : "Database ready: ") + r.path, "ok");
    await boot();
  } catch (e) { toast(e.message, "err"); }
}
async function pickExisting() {
  try {
    const r = await rpc(A.dbPickExisting());
    if (r.canceled) return;
    toast("Opened " + r.path, "ok");
    await boot();
  } catch (e) { toast(e.message, "err"); }
}

/* ---- dashboard ---- */
VIEWS.dashboard = async (main) => {
  const d = await rpc(A.dashboard());
  main.innerHTML = "";
  const monthName = new Date(d.today + "T00:00:00").toLocaleDateString("en-PK", { month: "long" });
  main.append(pageHead("Dashboard", `Today's figures first, then ${monthName} so far.`));

  // Today — same figures as Profit & Loss, for the current day only
  const t = d.today_pl;
  const tTotal = round2(t.litresSold + t.homeMilkLitres + t.sampleMilkLitres);
  const tDiff = round2(t.litresBought - tTotal);
  const opT = (s) => el("div", { class: "op", text: s });
  const diffHint = Math.abs(tDiff) < 0.05 ? "✓ All milk bought is accounted for"
    : tDiff > 0 ? `${litres(tDiff)} bought but not given to anyone — left over / not entered?`
    : `${litres(-tDiff)} more given out than bought — a purchase missing?`;
  main.append(el("div", { class: "card dash-sec", style: "margin-bottom:18px" }, [
    el("h2", { text: `☀️ Today — ${fmtDate(d.today)}` }),
    (t.revenue || t.litresBought || tTotal)
      ? el("p", { class: "sec-sub", text: "Money: today's sale minus today's milk purchase and expenses." })
      : el("p", { class: "sec-sub", text: "Nothing entered for today yet — record today's round in Daily Entry and today's purchase in Purchases." }),
    el("div", { class: "kpis sum" }, [
      kpi("Sale today", money(t.revenue), "accent", "Milk delivered to clients"),
      opT("−"),
      kpi("Milk bought today", money(t.costMilkSold), "bad", `${litres(t.litresBought)} from suppliers`),
      opT("−"),
      kpi("Expenses today", money(t.totalExpenses), "bad", t.totalExpenses ? "Petrol, transport, other" : "None entered yet"),
      opT("="),
      kpi("Profit today", money(t.operatingProfit), (t.operatingProfit >= 0 ? "good" : "bad") + " total"),
    ]),
    el("p", { class: "sec-sub", style: "margin:16px 0 12px", text: "Milk: everything bought should be sold, used at home or given as samples." }),
    el("div", { class: "kpis" }, [
      kpi("🛒 Bought", litres(t.litresBought), "", "From all suppliers"),
      kpi("🥛 Sold to clients", litres(t.litresSold)),
      kpi("🏠 Home use (GHAR)", litres(t.homeMilkLitres)),
      kpi("🧪 Samples", litres(t.sampleMilkLitres)),
      kpi("Difference", litres(tDiff), Math.abs(tDiff) < 0.05 ? "good total" : "bad total", diffHint),
    ]),
  ]));
  // ---- This month, split into clear sections (each with a heading + one-line explanation) ----
  const period = `1–${Number(d.today.slice(8))} ${monthName}`;
  const pm = new Date(d.today.slice(0, 8) + "01T00:00:00"); pm.setMonth(pm.getMonth() - 1);
  const prevMonthName = pm.toLocaleDateString("en-PK", { month: "long" });
  const section = (title, sub, kids, gridClass = "kpis") => el("div", { class: "card dash-sec" }, [
    el("h2", { text: title }),
    el("p", { class: "sec-sub", text: sub }),
    el("div", { class: gridClass }, kids),
  ]);
  const op = (s) => el("div", { class: "op", text: s });
  const toCollect = round2(d.receivable_prior + d.receivable_current);
  const toPay = round2(d.milk_credit_total + d.loans_outstanding + (d.salary_owed || 0));

  main.append(el("h2", { text: `📅 ${monthName} so far (${period})`, style: "margin:4px 0 12px" }));

  // 1. Profit — the main sum, written as a sum so it reads left to right.
  main.append(section(
    `1. Profit for ${monthName}`,
    "Total sale minus the milk we bought minus the running costs. Same calculation as the monthly sheet.",
    [
      kpi("Total sale", money(d.month_revenue), "accent",
        d.month_cash_sales > 0.5 ? `Client bills ${money(d.month_client_bills)} + walk-in cash ${money(d.month_cash_sales)}` : "Milk delivered to clients"),
      op("−"),
      kpi(`Milk bought${d.month_milk_cost_basis === "estimated" ? " (est.)" : ""}`, money(d.month_milk_cost), "bad",
        `${litres(d.month_litres_bought)} from all suppliers`),
      op("−"),
      kpi("Expenses", money(d.month_expenses), "bad", "Petrol, transport, salary, other costs"),
      op("="),
      kpi("Profit", money(d.month_net_profit), (d.month_net_profit >= 0 ? "good" : "bad") + " total",
        `Home milk (GHAR) not counted: ${litres(d.month_home_milk_litres)} worth ${money(d.month_home_milk_value)}`),
    ],
    "kpis sum",
  ));

  // 2. Money clients owe us.
  main.append(section(
    "2. Money clients owe us",
    `What has come in this month, and what is still to collect. Every payment pays off the oldest bill first.`,
    [
      kpi(`Received in ${monthName}`, money(d.month_collected_clients), "good",
        "All client payments this month — includes old bills paid now (cash sale not included)"),
      kpi(`To collect — ${prevMonthName} & before`, money(d.receivable_prior), d.receivable_prior > 0.5 ? "bad" : "good",
        "Old bills not paid yet — see Settlements → “Previous months still pending”"),
      kpi(`To collect — ${monthName} bills`, money(d.receivable_current), d.receivable_current > 0.5 ? "bad" : "good",
        "This month's milk not paid yet (usually billed at month end)"),
      kpi("Total to collect", money(toCollect), (toCollect > 0.5 ? "bad" : "good") + " total",
        `From ${d.active_clients} active clients`),
    ],
  ));

  // 3. Money we owe others.
  main.append(section(
    "3. Money we have to pay",
    "Milk taken from suppliers on credit (udhaar), staff salary not paid yet, and loans taken.",
    [
      kpi("To suppliers (milk on credit)", money(d.milk_credit_total), d.milk_credit_total > 0.5 ? "bad" : "good",
        `${money(d.milk_credit_month)} of it bought in ${monthName} — pay in Purchases → Supplier dues`),
      kpi("Staff salary to pay", money(d.salary_owed || 0), (d.salary_owed || 0) > 0.5 ? "bad" : "good",
        `Up to and including ${monthName} — pay on the Staff & Salary page`),
      kpi("Loans to repay", money(d.loans_outstanding), d.loans_outstanding > 0.5 ? "bad" : "good", "See the Loans page"),
      kpi("Total to pay", money(toPay), (toPay > 0.5 ? "bad" : "good") + " total", "Suppliers + salary + loans"),
    ],
  ));

  for (const t of d.salary_to_set || []) {
    main.append(el("div", { class: "inline-note warn row between", style: "margin:-6px 0 16px;align-items:center;gap:10px" }, [
      el("span", { text: `📅 Set ${t.name}'s salary for ${t.months.map(monthLabel).join(", ")} (salary not fixed — decided at month end).` }),
      el("button", { class: "btn sm", onclick: () => go("staff") }, "Open Staff & Salary"),
    ]));
  }

  // 4. Morning milk — its own ledger.
  main.append(section(
    "4. Morning milk (Doodhi) — separate account",
    "Bulk morning milk is kept apart from home deliveries, so it is NOT in the sale or profit above.",
    [
      kpi(`Sold in ${monthName}`, money(d.month_morning_sales), "", `${litres(d.month_morning_litres)}`),
      kpi("Still to collect", money(d.morning_pending), d.morning_pending > 0.5 ? "bad" : "good", "Total unpaid by morning-milk buyers"),
    ],
  ));
  main.append(el("div", { class: "card", style: "margin-top:18px" }, [
    el("h2", { text: "Quick actions" }),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn", onclick: () => go("daily") }, "📝  Enter today's round"),
      el("button", { class: "btn secondary", onclick: () => go("billing") }, "📄  Make an invoice"),
      el("button", { class: "btn secondary", onclick: () => go("pl") }, "📊  View profit & loss"),
    ]),
  ]));
};
/** Litres difference (bought − given out): amber when milk is left over, red when more went out than bought. */
function diffBadge(n) {
  n = round2(Number(n) || 0);
  if (Math.abs(n) < 0.005) return el("span", { class: "badge green", text: "0 L" });
  return el("span", { class: n > 0 ? "badge amber" : "badge red", text: (n > 0 ? "+" : "") + litres(n) });
}
function kpi(label, value, tone = "", hint = "") {
  return el("div", { class: "kpi " + tone }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: value }),
    hint ? el("div", { class: "hint", text: hint }) : null,
  ]);
}

/* ---- daily entry (the round) ---- */
/* ------------------------------------------------------------------ */
/*  Milk Order — how much milk to bring from the supplier for a date   */
/* ------------------------------------------------------------------ */
VIEWS.order = async (main, params) => {
  let date = params.date || todayStr();
  main.innerHTML = "";
  const dateInput = input({ type: "date", value: date });
  const setDate = (d) => { date = d; dateInput.value = d; load(); };
  main.append(pageHead("Milk Order", "Count the milk to bring before the round. Untick a client who doesn't want milk that day, or change their litres.", [
    field("Order for", dateInput),
    el("button", { class: "btn secondary", onclick: () => setDate(todayStr()) }, "Today"),
    el("button", { class: "btn secondary", onclick: () => setDate(iso(addDays(new Date(), 1))) }, "Tomorrow"),
  ]));
  const container = el("div");
  main.append(container);
  dateInput.addEventListener("change", () => { date = dateInput.value; load(); });

  async function load() {
    container.innerHTML = "<div class='spin'>Loading clients…</div>";
    const plan = await rpc(A.milkPlan(date));
    container.innerHTML = "";
    if (!plan.rows.length) { container.append(el("div", { class: "card", text: "No active clients yet." })); return; }

    // one entry per house; kinds inside
    const houses = [];
    const byId = new Map();
    for (const r of plan.rows) {
      let h = byId.get(r.client_id);
      if (!h) { h = { client_id: r.client_id, name: r.name, society: societyOf(r), kinds: [], takes: true }; byId.set(r.client_id, h); houses.push(h); }
      h.kinds.push({ milk_category: r.milk_category, litres: r.usual ? String(r.usual) : "" });
    }
    for (const h of houses) {
      const sum = h.kinds.reduce((a, k) => a + (parseFloat(k.litres) || 0), 0);
      if (plan.has_plan && sum <= 0) h.takes = false;
    }
    const homeI = input({ type: "number", min: "0", step: "0.25", value: plan.home || "", placeholder: "0", style: "width:90px" });
    const sampleI = input({ type: "number", min: "0", step: "0.25", value: plan.sample || "", placeholder: "0", style: "width:90px" });
    const spareI = input({ type: "number", min: "0", step: "0.25", value: plan.spare || "", placeholder: "0", style: "width:90px" });

    const out = {
      cow: el("strong"), buffalo: el("strong"), mixed: el("strong"), clients: el("strong"),
      extra: el("strong"), total: el("strong", { style: "font-size:22px;color:var(--accent)" }),
    };
    const cell = (label, node, extra = "") => el("div", { style: "min-width:110px" + extra }, [el("div", { class: "mini", text: label }), node]);
    const skippedLine = el("div", { class: "mini", style: "margin-top:10px" });
    const boughtLine = plan.bought ? el("div", { class: "mini", style: "margin-top:4px", text: `Already bought for ${fmtDate(date)}: ${litres(plan.bought)}` }) : null;

    function totals() {
      const by = { cow: 0, buffalo: 0, mixed: 0 };
      for (const h of houses) if (h.takes) for (const k of h.kinds) by[k.milk_category in by ? k.milk_category : "mixed"] += parseFloat(k.litres) || 0;
      const clients = round2(by.cow + by.buffalo + by.mixed);
      const home = parseFloat(homeI.value) || 0, sample = parseFloat(sampleI.value) || 0, spare = parseFloat(spareI.value) || 0;
      return { by, clients, home, sample, spare, extra: round2(home + sample + spare), total: round2(clients + home + sample + spare) };
    }
    function recalc() {
      const t = totals();
      out.cow.textContent = litres(t.by.cow);
      out.buffalo.textContent = litres(t.by.buffalo);
      out.mixed.textContent = litres(t.by.mixed);
      out.clients.textContent = litres(t.clients);
      out.extra.textContent = litres(t.extra);
      out.total.textContent = litres(t.total);
      for (const g of orderGroups.values()) {
        const hs = houses.filter((h) => h.society === g.label);
        const L = hs.reduce((a, h) => a + (h.takes ? h.kinds.reduce((b, k) => b + (parseFloat(k.litres) || 0), 0) : 0), 0);
        g.info.textContent = ` · ${hs.filter((h) => h.takes).length} of ${hs.length} houses · ${litres(round2(L))}`;
      }
      const off = houses.filter((h) => !h.takes);
      skippedLine.textContent = off.length ? `🚫 Not taking milk (${off.length}): ${off.map((h) => h.name).join(", ")}` : "All clients are taking milk.";
    }
    [homeI, sampleI, spareI].forEach((i) => i.addEventListener("input", recalc));
    houses.sort((a, b) => societyRank(a) - societyRank(b));
    const orderGroups = new Map(); // society -> heading row

    function supplierMessage() {
      const t = totals();
      const lines = [`Wahga Dairy Farm — milk for ${fmtDate(date)}`];
      if (t.by.cow) lines.push(`Cow: ${round2(t.by.cow)} L`);
      if (t.by.buffalo) lines.push(`Buffalo: ${round2(t.by.buffalo)} L`);
      if (t.by.mixed) lines.push(`Mix: ${round2(t.by.mixed)} L`);
      if (t.extra) lines.push(`Home / samples / spare: ${t.extra} L`);
      lines.push(`Total: ${t.total} L`);
      return lines.join("\n");
    }
    async function copyMessage() {
      const text = supplierMessage();
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = el("textarea", { style: "position:fixed;opacity:0" }); ta.value = text;
        document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      toast("Copied — paste it in WhatsApp for the supplier", "ok");
    }
    async function save() {
      const rows = [];
      for (const h of houses) for (const k of h.kinds) rows.push({ client_id: h.client_id, milk_category: k.milk_category, litres: h.takes ? (parseFloat(k.litres) || 0) : 0 });
      try {
        await rpc(A.milkPlanSave(date, rows, { home: homeI.value, sample: sampleI.value, spare: spareI.value }));
        toast(`Order saved for ${fmtDate(date)} — Daily Entry will use it`, "ok");
        load();
        return true;
      } catch (e) { toast(e.message, "err"); return false; }
    }
    async function resetPlan() {
      if (!(await confirmBox(`Remove the saved order for ${fmtDate(date)} and go back to the usual amounts?`))) return;
      try { await rpc(A.milkPlanDelete(date)); load(); } catch (e) { toast(e.message, "err"); }
    }

    container.append(el("div", { class: "card", style: "margin-bottom:14px" }, [
      el("h2", { text: `Milk to bring for ${fmtDate(date)}` + (plan.has_plan ? " (saved)" : " (not saved yet)") }),
      el("div", { class: "row", style: "gap:22px;margin-top:10px;flex-wrap:wrap;align-items:flex-end" }, [
        cell("🐄 Cow", out.cow), cell("🐃 Buffalo", out.buffalo), cell("🥛 Mix", out.mixed),
        cell("For clients", out.clients, ";border-left:2px solid var(--border);padding-left:16px"),
        cell("Home + samples + spare", out.extra),
        cell("TOTAL TO BRING", out.total, ";border-left:2px solid var(--border);padding-left:16px"),
      ]),
      el("div", { class: "row", style: "gap:24px;margin-top:14px;align-items:flex-end;flex-wrap:wrap" }, [
        field("🏠 Home / GHAR (L)", homeI), field("🧪 Samples (L)", sampleI), field("➕ Spare / extra (L)", spareI),
      ]),
      skippedLine, boughtLine,
      el("div", { class: "row", style: "gap:8px;margin-top:14px;flex-wrap:wrap" }, [
        el("button", { class: "btn", onclick: save }, "💾  Save order"),
        el("button", { class: "btn secondary", onclick: copyMessage }, "📋  Copy message for supplier"),
        el("button", { class: "btn secondary", onclick: async () => { if (await save()) go("daily", { date, fillPlan: true }); } }, "📝  Use in Daily Entry"),
        plan.has_plan ? el("button", { class: "btn ghost", onclick: resetPlan }, "↺  Back to usual amounts") : null,
      ]),
    ]));

    const searchI = input({ type: "search", placeholder: "Find a client…" });
    const table = el("table", { class: "data order-plan" });
    table.append(el("thead", {}, [el("tr", {}, [
      el("th", { text: "Takes milk" }), el("th", { text: "Client" }), el("th", { class: "num", text: "Litres" }), el("th", { text: "Milk" }),
    ])]));
    const tbody = el("tbody");
    for (const h of houses) {
      if (!orderGroups.has(h.society)) {
        const g = groupHeadRow(h.society, 4); g.label = h.society;
        orderGroups.set(h.society, g); tbody.append(g.tr);
      }
      const chk = input({ type: "checkbox" }); chk.checked = h.takes;
      const qtys = h.kinds.map((k) => {
        const q = input({ type: "number", min: "0", step: "0.25", value: k.litres, placeholder: "0", style: "width:90px" });
        q.addEventListener("input", () => { k.litres = q.value; recalc(); });
        return q;
      });
      const tr = el("tr", {}, [
        el("td", {}, [chk]),
        el("td", {}, [el("div", { text: h.name })]),
        el("td", { class: "num" }, qtys.map((q) => el("div", { class: "kind-line" }, [q]))),
        el("td", {}, h.kinds.map((k) => el("div", { class: "kind-line", style: "padding:7px 0", text: titleCase(k.milk_category) }))),
      ]);
      const paint = () => { qtys.forEach((q) => { q.disabled = !h.takes; }); tr.style.opacity = h.takes ? "" : "0.5"; };
      chk.addEventListener("change", () => { h.takes = chk.checked; paint(); recalc(); });
      paint();
      h.tr = tr;
      tbody.append(tr);
    }
    table.append(tbody);
    searchI.addEventListener("input", () => {
      const q = searchI.value.trim().toLowerCase();
      for (const h of houses) h.tr.hidden = q ? !h.name.toLowerCase().includes(q) : false;
    });
    container.append(el("div", { class: "table-search", style: "margin-bottom:10px" }, [searchI]));
    container.append(el("div", { class: "card", style: "padding:0;overflow-x:auto" }, [table]));
    container.append(el("div", { class: "inline-note", style: "margin-top:12px",
      text: "Amounts start from each client's last delivery (or their usual litres). After you save, Daily Entry's “Fill usual amounts” fills exactly this order and skips the clients marked as not taking milk." }));
    recalc();
  }
  load();
};

VIEWS.daily = async (main, params) => {
  let date = params.date || todayStr();
  main.innerHTML = "";
  const dateInput = input({ type: "date", value: date });
  const head = pageHead("Daily Entry", "One row per active client. Type litres; leave blank for a no-delivery day.", [
    field("Delivery date", dateInput),
    el("button", { class: "btn secondary", onclick: () => load() }, "Reload"),
  ]);
  main.append(head);
  const container = el("div");
  main.append(container);
  dateInput.addEventListener("change", () => { date = dateInput.value; load(); });

  async function load() {
    container.innerHTML = "<div class='spin'>Loading clients…</div>";
    const rows = await rpc(A.dailyRound(date));
    container.innerHTML = "";
    if (!rows.length) {
      container.append(el("div", { class: "card", html: "No active clients yet. Add clients first." }));
      return;
    }
    const state = rows.map((r) => ({
      client_id: r.client_id, name: r.name, society: societyOf(r),
      milk_category: r.milk_category,
      orig_category: r.orig_category || null,
      price_per_litre: r.price_per_litre,
      default_litres: Number(r.default_litres) || 0,
      primary: r.primary !== false,
      type_prices: r.type_prices || {},
      in_plan: !!r.in_plan,
      quantity_litres: r.quantity_litres === "" ? "" : String(r.quantity_litres),
      hasEntry: !!r.entry_id,
    }));
    // keep the round in society order (stable: a client's rows stay together)
    state.sort((a, b) => societyRank(a) - societyRank(b));
    const dailyGroups = new Map(); // society -> heading row (live litres / amount)
    let homeL = 0, sampleL = 0; // kept current by the home / sample inputs below

    // How much milk was bought for THIS date (so we can warn if the round
    // delivers more than was purchased, or nothing was purchased at all).
    const dayPurchases = await rpc(A.purchasesList({ from: date, to: date }));
    const boughtL = round2(dayPurchases.reduce((a, p) => a + (Number(p.quantity_litres) || 0), 0));
    let extraLitres = 0; // home use + samples for the date; kept current by the inputs below

    const purchaseBanner = el("div", { style: "margin-bottom:12px" });
    function updatePurchaseBanner() {
      let deliveredL = 0;
      for (const s of state) { const q = parseFloat(s.quantity_litres); if (q > 0) deliveredL += q; }
      const disposedL = round2(deliveredL + extraLitres);
      purchaseBanner.className = "";
      if (boughtL <= 0) {
        purchaseBanner.className = "inline-note danger";
        purchaseBanner.textContent = `⚠️ No milk purchase recorded for ${fmtDate(date)}. Add today's supply in Purchases first — otherwise this day's cost and profit will be wrong.`;
      } else if (disposedL > boughtL + 0.5) {
        purchaseBanner.className = "inline-note warn";
        purchaseBanner.textContent = `⚠️ You purchased ${litres(boughtL)} for ${fmtDate(date)}, but this round is ${litres(disposedL)}${extraLitres ? " (deliveries + home/samples)" : ""}. You're selling more milk than you bought — record the missing purchase or check the amounts.`;
      } else {
        purchaseBanner.className = "inline-note";
        purchaseBanner.textContent = `Purchased ${litres(boughtL)} for ${fmtDate(date)} · this round ${litres(disposedL)}.`;
      }
    }

    const totalCell = el("strong", { text: money(0) });
    const litresCell = el("strong", { text: litres(0) });
    const footLitresCell = el("strong", { text: litres(0) });
    const countCell = el("span", { class: "mini" });

    // Live milk breakdown: cow / buffalo / mix, sold total, home, samples, grand total
    const bd = {
      cow: el("strong"), buffalo: el("strong"), mixed: el("strong"),
      sold: el("strong"), home: el("strong"), sample: el("strong"), grand: el("strong", { style: "font-size:17px" }),
      bought: el("strong"), diff: el("span"),
    };
    const bdCell = (label, node, extra = "") => el("div", { style: "min-width:110px" + extra }, [el("div", { class: "mini", text: label }), node]);
    const breakdownCard = el("div", { class: "card", style: "margin-bottom:14px" }, [
      el("h2", { text: "Milk for " + fmtDate(date) }),
      el("div", { class: "row", style: "gap:22px;margin-top:10px;flex-wrap:wrap;align-items:flex-end" }, [
        bdCell("🐄 Cow", bd.cow),
        bdCell("🐃 Buffalo", bd.buffalo),
        bdCell("🥛 Mix", bd.mixed),
        bdCell("Total sold to clients", bd.sold, ";border-left:2px solid var(--border);padding-left:16px"),
        bdCell("🏠 Home (GHAR)", bd.home),
        bdCell("🧪 Samples", bd.sample),
        bdCell("Total milk (sold + home + samples)", bd.grand, ";border-left:2px solid var(--border);padding-left:16px"),
        bdCell("🚚 Bought", bd.bought, ";border-left:2px solid var(--border);padding-left:16px"),
        bdCell("Difference (bought − total)", bd.diff),
      ]),
    ]);
    function updateBreakdown() {
      const by = { cow: 0, buffalo: 0, mixed: 0 };
      for (const s of state) {
        const q = parseFloat(s.quantity_litres);
        if (q > 0) by[s.milk_category in by ? s.milk_category : "mixed"] += q;
      }
      const sold = round2(by.cow + by.buffalo + by.mixed);
      bd.cow.textContent = litres(by.cow);
      bd.buffalo.textContent = litres(by.buffalo);
      bd.mixed.textContent = litres(by.mixed);
      bd.sold.textContent = litres(sold);
      bd.home.textContent = litres(homeL);
      bd.sample.textContent = litres(sampleL);
      bd.grand.textContent = litres(round2(sold + homeL + sampleL));
      bd.bought.textContent = litres(boughtL);
      bd.diff.replaceChildren(diffBadge(boughtL - sold - homeL - sampleL));
    }

    function recalc() {
      let sum = 0, totL = 0;
      const served = new Set();
      for (const s of state) {
        const q = parseFloat(s.quantity_litres); const p = parseFloat(s.price_per_litre);
        if (q > 0) { totL += q; served.add(s.client_id); }
        if (q > 0 && p > 0) sum += q * p;
      }
      for (const [g, head] of dailyGroups) {
        let gl = 0, ga = 0; const gc = new Set(), gs = new Set();
        for (const s of state) {
          if (s.society !== g) continue;
          gc.add(s.client_id);
          const q = parseFloat(s.quantity_litres), p = parseFloat(s.price_per_litre);
          if (q > 0) { gl += q; gs.add(s.client_id); if (p > 0) ga += q * p; }
        }
        head.info.textContent = ` · ${gs.size} of ${gc.size} clients · ${litres(round2(gl))} · ${money(ga)}`;
      }
      const clientsN = new Set(state.map((s) => s.client_id)).size;
      totalCell.textContent = money(sum);
      litresCell.textContent = litres(totL);
      footLitresCell.textContent = litres(totL);
      countCell.textContent = `${served.size} of ${clientsN} clients`;
      updatePurchaseBanner();
      updateBreakdown();
    }

    function makeRow(s) {
      const qty = input({ type: "number", min: "0", step: "0.25", value: s.quantity_litres, placeholder: s.default_litres ? "usual " + s.default_litres : "—", style: "width:90px" });
      qty.addEventListener("input", () => { s.quantity_litres = qty.value; recalc(); });
      const cat = selectBox(META.milkCategories, s.milk_category, { style: "width:110px" });
      cat.addEventListener("change", () => {
        s.milk_category = cat.value;
        const rate = s.type_prices[cat.value];
        if (rate && !s.hasEntry) { s.price_per_litre = String(rate); price.value = String(rate); }
        recalc();
      });
      const price = input({ type: "number", min: "0", step: "0.5", value: s.price_per_litre, style: "width:90px" });
      price.addEventListener("input", () => { s.price_per_litre = price.value; recalc(); });
      const r = { s, qty, cat, price };
      const addBtn = el("button", { class: "btn sm ghost", title: "Add another milk type for this client (e.g. cow + buffalo)", onclick: () => addTypeRow(r) }, "＋ type");
      r.tr = [s.name, qty, cat, price, addBtn];
      return r;
    }
    const rowsUi = state.map(makeRow);

    // One table row per house. A client who takes 2–3 kinds of milk gets the
    // kinds stacked inside that one row (litres / type / rate per line); each
    // kind is still saved as its own entry.
    const kindLine = (node) => el("div", { class: "kind-line" }, [node]);
    function buildTr(r) {
      const tr = el("tr");
      r.cells = [el("td", {}, [el("div", { text: r.tr[0] })]), el("td", { class: "num" }), el("td"), el("td", { class: "num" }), el("td")];
      tr.append(...r.cells);
      r.trEl = tr;
      appendKind(r, r);
      r.cells[4].append(r.tr[4]);
      return tr;
    }
    function appendKind(host, r) {
      host.cells[1].append(kindLine(r.qty));
      host.cells[2].append(kindLine(r.cat));
      host.cells[3].append(kindLine(r.price));
      r.trEl = host.trEl;
      r.cells = host.cells;
    }
    // Second (third) milk type for the same client on this date
    function addTypeRow(fromRow) {
      const used = new Set(state.filter((x) => x.client_id === fromRow.s.client_id).map((x) => x.milk_category));
      const nextCat = META.milkCategories.find((c) => !used.has(c));
      if (!nextCat) { toast("This client already has a row for every milk type", "err"); return; }
      const s = { ...fromRow.s, milk_category: nextCat, orig_category: null, quantity_litres: "", default_litres: 0, primary: false, hasEntry: false,
        price_per_litre: fromRow.s.type_prices[nextCat] || fromRow.s.price_per_litre };
      const idx = state.indexOf(fromRow.s);
      state.splice(idx + 1, 0, s);
      const r = makeRow(s);
      rowsUi.splice(rowsUi.indexOf(fromRow) + 1, 0, r);
      appendKind(fromRow, r);
      r.qty.focus();
      recalc();
    }

    // Make the round exactly the saved Milk Order: planned litres for every
    // client in the order, blank for clients marked "not taking milk".
    const hasPlan = state.some((s) => s.in_plan);
    function fillFromPlan() {
      let n = 0;
      for (const r of rowsUi) {
        if (!r.s.in_plan) continue;
        const v = r.s.default_litres > 0 ? String(r.s.default_litres) : "";
        r.s.quantity_litres = v;
        r.qty.value = v;
        if (v) n++;
      }
      recalc();
      return n;
    }

    // Fill every row from each client's "usual litres/day". onlyEmpty keeps
    // any amounts already typed (or already saved for this date).
    function fillUsual(onlyEmpty) {
      let filled = 0;
      for (const r of rowsUi) {
        if (!r.s.default_litres) continue;
        if (onlyEmpty && r.s.quantity_litres !== "" && parseFloat(r.s.quantity_litres) > 0) continue;
        r.s.quantity_litres = String(r.s.default_litres);
        r.qty.value = String(r.s.default_litres);
        filled++;
      }
      recalc();
      return filled;
    }

    const table = dataTable(
      [
        { header: "Client" },
        { header: "Litres", num: true },
        { header: "Category" },
        { header: currency() + " / litre", num: true },
        { header: "" },
      ],
      rowsUi.map((r) => ({ __ui: r })),
      {}
    );
    // dataTable rendered text only; rebuild body with our controls:
    const tbody = $("tbody", table);
    tbody.innerHTML = "";
    const hosts = new Map(); // client_id -> first row of that house
    for (const r of rowsUi) {
      const host = hosts.get(r.s.client_id);
      if (host) { appendKind(host, r); continue; }
      if (!dailyGroups.has(r.s.society)) {
        const g = groupHeadRow(r.s.society, 5);
        dailyGroups.set(r.s.society, g); tbody.append(g.tr);
      }
      hosts.set(r.s.client_id, r); tbody.append(buildTr(r));
    }
    const tfoot = el("tfoot", {}, [
      el("tr", {}, [
        el("td", { text: "Total milk" }),
        el("td", { class: "num" }, [footLitresCell]),
        el("td", {}, ""),
        el("td", {}, ""),
        el("td", {}, ""),
      ]),
    ]);
    $("table.data", table).append(tfoot);
    $("table.data", table).classList.add("daily-round"); // phone layout hook
    recalc();

    const searchI = input({ type: "search", placeholder: "Find a client…" });
    searchI.addEventListener("input", () => {
      const q = searchI.value.trim().toLowerCase();
      for (const r of rowsUi) r.trEl.hidden = q ? !r.s.name.toLowerCase().includes(q) : false; // rows of one house share trEl
    });

    container.append(purchaseBanner);
    updatePurchaseBanner();

    const anyDefaults = state.some((s) => s.default_litres > 0);
    if (hasPlan) container.append(el("div", { class: "inline-note", style: "margin-bottom:10px" },
      `🛒 A Milk Order is saved for ${fmtDate(date)}. If you delivered the same, press “Same as Milk Order”, check, then Save round.`));
    container.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      hasPlan ? el("button", { class: "btn", onclick: () => { const n = fillFromPlan(); toast(`Filled ${n} rows from the Milk Order — press Save round`, "ok"); } }, "🛒  Same as Milk Order") : null,
      anyDefaults ? el("button", { class: "btn secondary", onclick: () => { const n = fillUsual(true); toast(n ? `Filled ${n} clients with their usual amount` : "Nothing to fill", "ok"); } }, "⚡  Fill usual amounts") : null,
      anyDefaults ? el("button", { class: "btn secondary", onclick: () => { const n = fillUsual(false); toast(`Reset ${n} rows to usual amounts`, "ok"); } }, "↻  Reset all to usual") : null,
      el("button", { class: "btn secondary", onclick: fillYesterday }, "📋  Copy yesterday"),
    ]));
    if (!anyDefaults) {
      container.append(el("div", { class: "inline-note", style: "margin-bottom:12px", text: "Tip: set a client's “Usual litres / day” (open the client from Clients) and a “Fill usual amounts” button appears here — one click marks the whole standard round." }));
    }

    container.append(el("div", { class: "table-search", style: "margin-bottom:10px" }, [searchI]));
    container.append(table);

    // Home use (GHAR) + free samples for this date
    const hm = await rpc(A.homeMilkForDate(date));
    const homeI = input({ type: "number", min: "0", step: "0.25", value: hm.home || "", placeholder: "0", style: "width:90px" });
    const sampI = input({ type: "number", min: "0", step: "0.25", value: hm.sample || "", placeholder: "0", style: "width:90px" });
    function syncExtra() {
      homeL = parseFloat(homeI.value) || 0;
      sampleL = parseFloat(sampI.value) || 0;
      extraLitres = round2(homeL + sampleL);
      updatePurchaseBanner();
      updateBreakdown();
    }
    syncExtra();
    async function saveHome(kind, elm) {
      try { await rpc(A.homeMilkSave({ date, kind, litres: elm.value })); }
      catch (e) { toast(e.message, "err"); }
    }
    homeI.addEventListener("input", syncExtra);
    sampI.addEventListener("input", syncExtra);
    homeI.addEventListener("change", () => saveHome("home", homeI));
    sampI.addEventListener("change", () => saveHome("sample", sampI));
    container.append(el("div", { class: "card", style: "margin-top:14px" }, [
      el("div", { class: "row", style: "gap:24px;align-items:flex-end" }, [
        field("🏠 Home use / GHAR (litres)", homeI),
        field("🧪 Samples given free (litres)", sampI),
        el("div", { class: "mini", style: "padding-bottom:8px" }, "Home milk is kept separate from profit; samples are counted as a marketing cost. Saved automatically."),
      ]),
    ]));

    container.append(el("div", { class: "row between", style: "margin-top:16px" }, [
      el("div", { class: "mini" }, ["Total milk: ", litresCell, "  ·  Round total: ", totalCell, "  ·  ", countCell]),
      el("button", { class: "btn", onclick: save }, "💾  Save round"),
    ]));
    breakdownCard.style.margin = "16px 0 0";
    container.append(breakdownCard);
    if (params.fillPlan && hasPlan) {
      params.fillPlan = false;
      const n = fillFromPlan();
      toast(`Filled ${n} rows from the Milk Order — check and press Save round`, "ok");
    }

    async function fillYesterday() {
      const y = iso(addDays(new Date(date + "T00:00:00"), -1));
      const prev = await rpc(A.dailyRound(y));
      let filled = 0;
      for (const p of prev) {
        const q = p.quantity_litres !== "" ? Number(p.quantity_litres) : 0;
        if (!(q > 0)) continue;
        // same client + same milk type, else that client's blank row, else a new type row
        let r = rowsUi.find((x) => x.s.client_id === p.client_id && x.s.milk_category === p.milk_category);
        if (!r) {
          r = rowsUi.find((x) => x.s.client_id === p.client_id && !(parseFloat(x.s.quantity_litres) > 0) && !x.s.hasEntry);
          if (r) { r.s.milk_category = p.milk_category; r.cat.value = p.milk_category; }
        }
        if (!r) {
          const base = rowsUi.filter((x) => x.s.client_id === p.client_id).pop();
          if (!base) continue; // client no longer active
          addTypeRow(base);
          r = rowsUi[rowsUi.indexOf(base) + 1];
          r.s.milk_category = p.milk_category; r.cat.value = p.milk_category;
        }
        r.s.quantity_litres = String(q);
        r.qty.value = String(q);
        if (p.price_per_litre) { r.s.price_per_litre = String(p.price_per_litre); r.price.value = String(p.price_per_litre); }
        filled++;
      }
      recalc();
      toast(filled ? `Copied ${filled} deliveries from ${y}` : `No deliveries recorded on ${y}`, filled ? "ok" : "err");
    }

    async function save() {
      try {
        let deliveredL = 0;
        for (const s of state) { const q = parseFloat(s.quantity_litres); if (q > 0) deliveredL += q; }
        const disposedL = round2(deliveredL + extraLitres);
        if (boughtL <= 0 && disposedL > 0) {
          if (!(await confirmBox(`No milk purchase is recorded for ${fmtDate(date)}, but you're delivering ${litres(disposedL)}. Save the round anyway? (Add the purchase in Purchases so profit is correct.)`))) return;
        } else if (disposedL > boughtL + 0.5) {
          if (!(await confirmBox(`This round is ${litres(disposedL)} but only ${litres(boughtL)} was purchased for ${fmtDate(date)}. You're selling more than you bought. Save anyway?`))) return;
        }
        // Two rows for one client can't share a milk type (one would overwrite /
        // clear the other). Extra rows left empty and never saved are skipped.
        const rowsToSave = state.filter((s) => s.primary || s.orig_category || parseFloat(s.quantity_litres) > 0);
        const seen = new Map();
        for (const s of rowsToSave) {
          const k = s.client_id + "|" + s.milk_category;
          if (seen.has(k) && (parseFloat(s.quantity_litres) > 0 || parseFloat(seen.get(k).quantity_litres) > 0)) {
            throw new Error(`${s.name} has two rows with the same milk type (${titleCase(s.milk_category)}). Change one of them.`);
          }
          seen.set(k, s);
        }
        const payload = rowsToSave.map((s) => ({
          client_id: s.client_id,
          milk_category: s.milk_category,
          orig_category: s.orig_category,
          price_per_litre: parseFloat(s.price_per_litre) || 0,
          quantity_litres: s.quantity_litres === "" ? 0 : parseFloat(s.quantity_litres),
        }));
        const res = await rpc(A.dailyRoundSave(date, payload));
        toast(`Saved ${res.saved} deliveries` + (res.cleared ? `, cleared ${res.cleared}` : ""), "ok");
        load();
      } catch (e) { toast(e.message, "err"); }
    }
  }
  await load();
};

/* ---- clients ---- */
VIEWS.clients = async (main) => {
  const showInactive = { v: false };
  main.innerHTML = "";
  main.append(pageHead("Clients", "Delivery clients, their price and running balance.", [
    el("button", { class: "btn", onclick: () => clientDrawer(null) }, "＋  Add client"),
  ]));
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const clients = await rpc(A.clientsList(showInactive.v));
    container.innerHTML = "";
    const toggle = el("label", { class: "row", style: "gap:6px;margin-bottom:12px;font-size:12.5px;color:var(--muted)" }, [
      (() => { const c = input({ type: "checkbox" }); c.checked = showInactive.v; c.addEventListener("change", () => { showInactive.v = c.checked; load(); }); return c; })(),
      "Show inactive clients",
    ]);
    container.append(toggle);
    container.append(dataTable([
      { header: "Name", render: (c) => el("strong", { text: c.name }) },
      { header: "Phone", key: "phone" },
      { header: "Category", render: (c) => el("span", { class: "badge gray", text: titleCase(c.milk_category) }) },
      { header: "Usual/day", num: true, render: (c) => (c.default_litres ? litres(c.default_litres) : "—") },
      { header: "Billing", render: (c) => el("span", { class: c.billing_cycle === "10day" ? "badge blue" : "badge", text: cycleLabel(c.billing_cycle) }) },
      { header: currency() + " / litre", num: true, render: (c) => money(c.price_per_litre) },
      { header: "Balance", num: true, render: (c) => el("span", { class: c.balance > 0 ? "badge red" : "badge green", text: money(c.balance) }) },
      { header: "Status", render: (c) => el("span", { class: c.active ? "badge green" : "badge gray", text: c.active ? "Active" : "Inactive" }) },
      {
        header: "", render: (c) => el("button", {
          class: "btn sm secondary",
          onclick: (e) => { e.stopPropagation(); paymentModal(c.id, null, () => load()); },
        }, "💵 Receive"),
      },
    ], clients, {
      onRowClick: (c) => clientDrawer(c.id),
      groupBy: "society",
      footer: (shown) => [
        { text: `${shown.length} clients` }, { text: "" }, { text: "" },
        { text: litres(round2(shown.reduce((a, c) => a + (c.default_litres || 0), 0))), num: true },
        { text: "" }, { text: "" },
        { text: money(shown.reduce((a, c) => a + c.balance, 0)), num: true },
        { text: "" }, { text: "" },
      ],
      empty: "No clients yet.",
      search: ["name", "phone", "address", "milk_category"],
      searchPlaceholder: "Search by name, phone or address…",
    }));
  }
  VIEWS.clients._reload = load;
  await load();
};

async function clientDrawer(id) {
  const client = id ? await rpc(A.clientGet(id)) : null;
  const f = {
    name: client?.name || "",
    phone: client?.phone || "",
    address: client?.address || "",
    price_per_litre: client ? String(client.price_per_litre) : "",
    milk_category: client?.milk_category || "mixed",
    default_litres: client && client.default_litres ? String(client.default_litres) : "",
    opening_balance: client ? String(client.opening_balance) : "0",
    active: client ? !!client.active : true,
    cash_on_delivery: client ? !!client.cash_on_delivery : false,
    billing_cycle: client?.billing_cycle || "monthly",
    society: client?.society || "",
    note: client?.note || "",
  };
  const drawer = el("div", { class: "drawer" });
  const nameI = input({ value: f.name, placeholder: "e.g. Ahmed House" });
  const phoneI = input({ value: f.phone, placeholder: "03XX-XXXXXXX" });
  const addrI = input({ value: f.address, placeholder: "Street, area" });
  const priceI = input({ type: "number", min: "0", step: "0.5", value: f.price_per_litre, placeholder: "e.g. 220" });
  const catI = selectBox(META.milkCategories, f.milk_category);
  const dailyI = input({ type: "number", min: "0", step: "0.25", value: f.default_litres, placeholder: "e.g. 2" });
  const openI = input({ type: "number", step: "1", value: f.opening_balance });
  const activeI = input({ type: "checkbox" }); activeI.checked = f.active;
  const codI = input({ type: "checkbox" }); codI.checked = f.cash_on_delivery;
  const cycleI = selectBox(BILLING_CYCLE_OPTIONS, f.billing_cycle);
  const societyI = selectBox([{ value: "", label: "Auto (from name / address)" }, ...SOCIETY_ORDER.map((s) => ({ value: s, label: s }))], f.society);
  const noteI = el("textarea", { placeholder: "Optional" }, f.note);

  drawer.append(el("h2", { text: client ? "Edit client" : "Add client" }));
  const balCell = client ? el("strong", { class: client.balance > 0 ? "badge red" : "badge green", text: money(client.balance) }) : null;
  if (client) {
    drawer.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-bottom:14px" }, [
      el("span", { class: "mini", text: "Current balance owed" }),
      el("div", { class: "row", style: "gap:8px;align-items:center" }, [
        balCell,
        el("button", { class: "btn sm", onclick: () => paymentModal(client.id, null, reloadBalance) }, "💵 Receive payment"),
      ]),
    ]));
  }
  let refreshPaymentsList = () => {};
  async function reloadBalance() {
    if (!client) return;
    const fresh = await rpc(A.clientGet(client.id));
    client.balance = fresh.balance;
    balCell.textContent = money(fresh.balance);
    balCell.className = fresh.balance > 0 ? "badge red" : "badge green";
    refreshPaymentsList();
    VIEWS.clients._reload && VIEWS.clients._reload();
  }
  drawer.append(field("Name", nameI));
  drawer.append(field("Phone", phoneI));
  drawer.append(field("Address", addrI));
  drawer.append(field("Society / area — clients are grouped by this on every page", societyI));
  drawer.append(field("Price per litre (" + currency() + ")", priceI));
  drawer.append(field("Milk category", catI));
  drawer.append(field("Usual litres / day — used by “Fill usual amounts” on Daily Entry", dailyI));
  drawer.append(field("Billing / payment cycle — when this client gets a bill and pays", cycleI));
  drawer.append(field("Opening balance (" + currency() + ") — amount owed before you started using this app", openI));
  drawer.append(el("label", { class: "row", style: "gap:8px;margin:6px 0" }, [activeI, "Active (currently receiving deliveries)"]));
  drawer.append(el("label", { class: "row", style: "gap:8px;margin:6px 0;align-items:flex-start" }, [codI,
    el("span", {}, ["Pays cash on delivery (cash sale)", el("div", { class: "mini", text: "Money is taken when the milk is given — the app records the payment automatically for every delivery, so the balance is always 0." })])]));
  drawer.append(field("Note", noteI));

  const close = openOverlay(drawer);
  drawer.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: save }, client ? "Save changes" : "Add client"),
    client ? el("button", { class: "btn danger", onclick: remove }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));

  if (client) {
    drawer.append(el("hr", { style: "margin:20px 0;border:0;border-top:1px solid var(--border)" }));
    const payLine = el("div", { class: "mini", text: "Loading…" });
    async function refreshPaymentSummary() {
      const pays = await rpc(A.paymentsList({ clientId: client.id }));
      payLine.textContent = pays.length
        ? `${pays.length} payment${pays.length > 1 ? "s" : ""} · ${money(pays.reduce((a, p) => a + p.amount, 0))} received in total`
        : "No payments recorded yet.";
    }
    refreshPaymentsList = refreshPaymentSummary;
    drawer.append(el("div", { class: "row between", style: "align-items:center" }, [
      el("div", {}, [el("h2", { text: "Payments", style: "margin:0 0 2px" }), payLine]),
      el("button", { class: "btn sm secondary", onclick: () => paymentsListModal(client.id, reloadBalance) }, "Manage payments →"),
    ]));
    drawer.append(el("div", { class: "row", style: "margin-top:14px" }, [
      el("button", { class: "btn secondary", onclick: () => { close(); go("billing", { tab: "invoice", clientId: client.id }); } }, "🧾  Invoice this client"),
      el("button", { class: "btn secondary", onclick: () => { close(); go("billing", { tab: "statement", clientId: client.id }); } }, "📄  Statement"),
    ]));
    refreshPaymentSummary();
  }

  async function save() {
    try {
      if (!nameI.value.trim()) throw new Error("Name is required.");
      if (!(parseFloat(priceI.value) > 0)) throw new Error("Enter a valid price per litre.");
      await rpc(A.clientSave({
        id: client?.id,
        name: nameI.value, phone: phoneI.value, address: addrI.value,
        price_per_litre: priceI.value, milk_category: catI.value,
        default_litres: dailyI.value, opening_balance: openI.value,
        active: activeI.checked, cash_on_delivery: codI.checked, billing_cycle: cycleI.value, society: societyI.value, note: noteI.value,
      }));
      toast("Saved", "ok");
      close();
      VIEWS.clients._reload && VIEWS.clients._reload();
    } catch (e) { toast(e.message, "err"); }
  }
  async function remove() {
    if (!(await confirmBox("Delete " + client.name + "? If they have deliveries they'll be set inactive instead."))) return;
    const r = await rpc(A.clientDelete(client.id));
    toast(r === "deleted" ? "Client deleted" : "Client set inactive", "ok");
    close();
    VIEWS.clients._reload && VIEWS.clients._reload();
  }
}

/** Full-screen-ish payments manager for one client — kept out of the client
 *  drawer so a long payment history has its own space. */
async function paymentsListModal(clientId, onChange) {
  const box = el("div", { class: "modal", style: "width:640px" });
  const client = await rpc(A.clientGet(clientId));
  box.append(el("div", { class: "row between", style: "margin-bottom:12px" }, [
    el("h2", { text: "Payments — " + client.name, style: "margin:0" }),
    el("button", { class: "btn sm", onclick: () => paymentModal(clientId, null, refresh) }, "＋ Record payment"),
  ]));
  const splitBox = el("div", { style: "margin-bottom:14px" });
  box.append(splitBox);
  const invBox = el("div", { style: "margin-bottom:14px" });
  box.append(invBox);
  const listBox = el("div");
  box.append(listBox);
  const closeV = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [el("button", { class: "btn ghost", onclick: () => closeV() }, "Close")]));

  async function refresh() {
    const [sp, pays, invoices] = await Promise.all([
      rpc(A.clientDueSplit(clientId, null)),
      rpc(A.paymentsList({ clientId })),
      rpc(A.invoiceDues(clientId)),
    ]);
    splitBox.innerHTML = "";
    splitBox.append(dueSplitBox(sp, (amount, note) => paymentModal(clientId, { amount: Math.round(amount), note }, refresh)));

    // Generated invoices — amount on the invoice, paid since, still due + Settle.
    invBox.innerHTML = "";
    invBox.append(invoiceDuesBlock(invoices, (inv) =>
      paymentModal(clientId, { amount: Math.round(inv.outstanding), note: "Against " + inv.invoice_no }, refresh)));

    listBox.innerHTML = "";
    listBox.append(dataTable([
      { header: "Date", render: (p) => fmtDate(p.date) },
      { header: "Amount", num: true, render: (p) => money(p.amount) },
      { header: "Method", render: (p) => titleCase(p.method || "—") },
      { header: "Note", key: "note" },
      { header: "", render: (p) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this payment?")) { await rpc(A.paymentDelete(p.id)); toast("Deleted", "ok"); refresh(); } } }, "✕") },
    ], pays, {
      onRowClick: (p) => paymentModal(clientId, p, refresh),
      search: ["date", "method", "note"],
      searchPlaceholder: "Search payments by date, method or note…",
      footer: (shown) => [
        { text: `${shown.length} payment${shown.length === 1 ? "" : "s"}` },
        { text: money(shown.reduce((a, p) => a + p.amount, 0)), num: true },
        { text: "" }, { text: "" }, { text: "" },
      ],
      empty: "No payments recorded yet.",
    }));
    onChange && onChange();
  }
  await refresh();
}

/* "Last month's bill / this month / total" box (from A.clientDueSplit) with
 * buttons that hand (amount, note) to onPick. */
function dueSplitBox(sp, onPick) {
  const prevName = sp.prev_month_label.split(" ")[0];
  const inv = sp.prev_invoice;
  const line = (label, sub, amount, strongCls, btn) => el("div", { class: "row between", style: "align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)" }, [
    el("div", {}, [el("div", { text: label, style: "font-weight:600" }), sub ? el("div", { class: "mini", text: sub }) : null]),
    el("div", { class: "row", style: "gap:8px;align-items:center" }, [
      el("strong", { class: strongCls || "", text: money(amount) }),
      btn || null,
    ]),
  ]);
  const prevSub = [
    inv ? `Invoice ${inv.invoice_no} · invoice amount ${money(inv.total_due)}` : `Bill at end of ${prevName}: ${money(sp.prev_bill_amount)} (no invoice generated)`,
    sp.paid_since > 0.5 ? `paid since ${money(sp.paid_since)}` : null,
    inv && Math.abs(inv.total_due - sp.prev_bill_amount) > 0.5
      ? `⚠ invoice is out of date — ${prevName} bill is now ${money(sp.prev_bill_amount)}, re-issue it` : null,
  ].filter(Boolean).join(" · ");
  const prevBtn = sp.prior_pending > 0.5
    ? el("button", { class: "btn sm", type: "button", onclick: () => onPick(sp.prior_pending, `${prevName} bill`) }, `Pay ${prevName} bill`)
    : null;
  const fullBtn = sp.balance > 0.5 && sp.current_pending > 0.5
    ? el("button", { class: "btn sm secondary", type: "button", onclick: () => onPick(sp.balance, "Full balance settled") }, "Pay all")
    : null;
  return el("div", { style: "background:var(--surface-2);border-radius:8px;padding:4px 12px" }, [
    line(`${sp.prev_month_label} bill — still due`, prevSub, sp.prior_pending, sp.prior_pending > 0.5 ? "badge red" : "badge green", prevBtn),
    line(`${sp.month_label} so far`, "milk this month, not billed yet", sp.current_pending, "", null),
    el("div", { class: "row between", style: "align-items:center;gap:8px;padding:8px 0" }, [
      el("span", { class: "mini", text: "Total owed" }),
      el("div", { class: "row", style: "gap:8px;align-items:center" }, [el("strong", { text: money(sp.balance) }), fullBtn]),
    ]),
  ]);
}

/* Box listing a client's generated invoices (from A.invoiceDues): the newest
 * invoice in full (invoice amount · paid since · still due + settle button),
 * older ones as one-line history since their balance is carried into the newest. */
function invoiceDuesBlock(dues, onSettle, o = {}) {
  const wrap = el("div");
  if (!dues || !dues.length) {
    wrap.append(el("div", { class: "mini", text: "No invoice generated for this client yet." }));
    return wrap;
  }
  const STATUS = { paid: ["green", "Paid in full"], partial: ["amber", "Partly paid"], unpaid: ["red", "Unpaid"] };
  const latest = dues[0];
  const [cls, label] = STATUS[latest.status];
  wrap.append(el("div", { class: "mini", style: "margin-bottom:6px", text: "Latest invoice" }));
  wrap.append(el("div", { style: "border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px" }, [
    el("div", { class: "row between", style: "align-items:center;gap:8px" }, [
      el("div", {}, [
        el("strong", { text: latest.invoice_no }),
        el("span", { class: "mini", text: `  ${fmtDate(latest.period_from)} – ${fmtDate(latest.period_to)} · issued ${fmtDate(latest.issued_date)}` }),
      ]),
      el("span", { class: "badge " + cls, text: label }),
    ]),
    el("div", { class: "row", style: "gap:18px;margin-top:8px;flex-wrap:wrap" }, [
      el("div", {}, [el("div", { class: "mini", text: "Invoice amount" }), el("strong", { text: money(latest.total_due) })]),
      el("div", {}, [el("div", { class: "mini", text: "Paid since" }), el("strong", { text: money(latest.paid_after) })]),
      el("div", {}, [el("div", { class: "mini", text: "Still due on invoice" }), el("strong", { class: latest.outstanding > 0.5 ? "badge red" : "badge green", text: money(latest.outstanding) })]),
      el("div", { class: "grow" }),
      latest.outstanding > 0.5 && onSettle
        ? el("button", { class: "btn sm", type: "button", onclick: () => onSettle(latest) }, o.buttonLabel ? `${o.buttonLabel} (${money(latest.outstanding)})` : `Settle ${money(latest.outstanding)}`)
        : null,
    ]),
  ]));
  if (dues.length > 1 && !o.compact) {
    const older = el("details", { style: "margin-top:4px" }, [
      el("summary", { class: "mini", style: "cursor:pointer", text: `${dues.length - 1} earlier invoice${dues.length > 2 ? "s" : ""} (balance carried into ${latest.invoice_no})` }),
    ]);
    for (const inv of dues.slice(1)) {
      older.append(el("div", { class: "mini", style: "padding:3px 0 3px 12px", text:
        `${inv.invoice_no} · ${fmtDate(inv.period_from)} – ${fmtDate(inv.period_to)} · amount ${money(inv.total_due)} · ${STATUS[inv.status][1].toLowerCase()}` }));
    }
    wrap.append(older);
  }
  return wrap;
}

async function paymentModal(clientId, payment, onDone) {
  const client = await rpc(A.clientGet(clientId));
  // Balance excluding the payment being edited, so "remaining" math is right.
  const baseBalance = payment?.id ? round2(client.balance + Number(payment.amount || 0)) : client.balance;

  const box = el("div", { class: "modal", style: "width:440px" });
  const dateI = input({ type: "date", value: payment?.date || todayStr() });
  const amtI = input({ type: "number", min: "0", step: "1", value: payment?.amount || "", placeholder: "amount received" });
  const methodI = selectBox(META.paymentMethods, payment?.method || "cash");
  const noteI = input({ value: payment?.note || "", placeholder: "Optional" });

  box.append(el("h2", { text: (payment?.id ? "Edit payment — " : "Receive payment — ") + client.name }));

  // Last month's bill vs this month so far — the owner collects last month's
  // bill, so that's the main amount offered (not the full running balance).
  const owedRow = el("div", { style: "margin-bottom:14px" }, [
    el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px" }, [
      el("span", { class: "mini", text: "Currently owes (total)" }),
      el("strong", { text: money(baseBalance) }),
    ]),
  ]);
  box.append(owedRow);
  rpc(A.clientDueSplit(clientId, payment?.id || null)).then((sp) => {
    if (!sp) return;
    owedRow.innerHTML = "";
    owedRow.append(dueSplitBox(sp, (amount, note) => {
      amtI.value = String(Math.round(amount));
      if (!noteI.value.trim() || /^(Against INV|.* bill$|Full balance)/i.test(noteI.value)) noteI.value = note;
      recalc();
    }));
  }).catch(() => {});

  box.append(field("Date received", dateI));
  box.append(field("Amount received (" + currency() + ")", amtI));
  box.append(field("Method", methodI));
  box.append(field("Note", noteI));

  const remainCell = el("strong");
  const remainRow = el("div", { class: "row between", style: "border-top:2px solid var(--border);padding-top:10px;margin-top:6px" }, [
    el("span", { class: "mini", text: "Remaining after this payment" }),
    remainCell,
  ]);
  box.append(remainRow);

  function recalc() {
    const amt = parseFloat(amtI.value) || 0;
    const remain = round2(baseBalance - amt);
    remainCell.textContent = money(remain);
    remainCell.className = remain > 0 ? "badge red" : "badge green";
  }
  amtI.addEventListener("input", recalc);
  recalc();

  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        if (!(parseFloat(amtI.value) > 0)) throw new Error("Enter a valid amount.");
        await rpc(A.paymentSave({ id: payment?.id, client_id: clientId, date: dateI.value, amount: amtI.value, method: methodI.value, note: noteI.value }));
        toast("Payment saved — remaining " + money(round2(baseBalance - (parseFloat(amtI.value) || 0))), "ok");
        close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save payment"),
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* Status badge + latest-invoice line for a settlements row. */
function settlementStatusCell(r) {
  const STATE = {
    settled: ["green", "Settled"],
    partial: ["blue", "Partly paid"],
    unpaid: ["red", "Unpaid"],
  };
  const [cls, label] = STATE[r.state] || STATE.unpaid;
  const wrap = el("div", { style: "display:flex;flex-direction:column;gap:3px;align-items:flex-start" }, [
    el("span", { class: "badge " + cls, text: label }),
  ]);
  if (r.invoice) {
    const inv = r.invoice;
    const tail = inv.status === "paid"
      ? "paid in full"
      : inv.status === "partial"
        ? `${money(inv.outstanding)} left`
        : "unpaid";
    wrap.append(el("span", { class: "mini", text: `${inv.invoice_no} · ${tail}` }));
  } else if (r.billed > 0.5) {
    wrap.append(el("span", { class: "mini", text: "no invoice yet" }));
  }
  return wrap;
}

/* ---- settlements (who owes what) ---- */
VIEWS.settlements = async (main) => {
  const opts = { hideSettled: true, sort: "pending", show: "all" };
  main.innerHTML = "";
  main.append(pageHead("Settlements", "What each client has been billed, what they've paid, and what's still pending."));
  const bar = el("div", { class: "row", style: "margin-bottom:14px" });
  main.append(bar);
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const prevOnly = opts.show === "prior";
    // Previous-month dues: include inactive clients too — someone who stopped
    // taking milk can still owe for last month.
    const s = await rpc(A.settlements({ includeInactive: prevOnly }));
    const monthName = new Date(s.month_start + "T00:00:00").toLocaleString("en-GB", { month: "long" });
    let rows = s.rows.slice();
    if (prevOnly) rows = rows.filter((r) => r.prior_pending > 0.5);
    else if (opts.hideSettled) rows = rows.filter((r) => r.pending > 0.5);
    const sortKey = prevOnly ? "prior_pending" : "pending";
    if (opts.sort === "pending") rows.sort((a, b) => b[sortKey] - a[sortKey]);
    else rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const printDoc = () => settlementHtml(s, prevOnly ? { rows, prevOnly, monthName } : null);

    bar.innerHTML = "";
    const showSel = selectBox([
      { value: "all", label: "All clients" },
      { value: "prior", label: `Previous months still pending (before ${monthName})` },
    ], opts.show);
    showSel.addEventListener("change", () => { opts.show = showSel.value; load(); });
    const hide = input({ type: "checkbox" }); hide.checked = opts.hideSettled;
    hide.addEventListener("change", () => { opts.hideSettled = hide.checked; load(); });
    const sortSel = selectBox([{ value: "pending", label: "Most pending first" }, { value: "name", label: "By name" }], opts.sort);
    sortSel.addEventListener("change", () => { opts.sort = sortSel.value; load(); });
    bar.append(
      field("Show", showSel),
      ...(prevOnly ? [] : [el("label", { class: "row", style: "gap:6px;font-size:12.5px;color:var(--muted)" }, [hide, "Hide fully settled"])]),
      field("Sort", sortSel),
      el("div", { class: "grow" }),
      el("button", { class: "btn secondary", onclick: () => rpc(A.printHtml(printDoc())).catch((e) => toast(e.message, "err")) }, "🖨  Print"),
      el("button", { class: "btn secondary", onclick: async () => { const r = await rpc(A.savePdf(printDoc(), `settlements-${prevOnly ? "previous-months-" : ""}${s.generated}`)); if (!r.canceled) toast("Saved: " + r.path, "ok"); } }, "⬇  Save PDF"),
    );

    container.innerHTML = "";
    const priorRows = s.rows.filter((r) => r.prior_pending > 0.5);
    container.append(el("div", { class: "kpis", style: "margin-bottom:14px" }, prevOnly ? [
      kpi(`Pending from before ${monthName}`, money(s.totals.prior_pending), s.totals.prior_pending > 0.5 ? "bad" : "good"),
      kpi("Clients with old dues", String(priorRows.length)),
      kpi(`Their ${monthName} bill so far`, money(priorRows.reduce((a, x) => a + x.current_pending, 0))),
      kpi("Their total pending", money(priorRows.reduce((a, x) => a + x.pending, 0)), "bad"),
    ] : [
      kpi("Total billed", money(s.totals.billed)),
      kpi("Total received", money(s.totals.received), "good"),
      kpi("Total pending", money(s.totals.pending), s.totals.pending > 0 ? "bad" : "good"),
      kpi(`Pending — before ${monthName}`, money(s.totals.prior_pending), s.totals.prior_pending > 0.5 ? "bad" : "good"),
      kpi("Clients with dues", String(s.rows.filter((r) => r.pending > 0.5).length)),
    ]));
    const sum = (shown, k) => money(shown.reduce((a, x) => a + x[k], 0));
    container.append(dataTable([
      { header: "Client", render: (r) => el("strong", { text: r.name + (r.active ? "" : " (inactive)") }) },
      { header: "Phone", key: "phone" },
      { header: "Billed", num: true, render: (r) => money(r.billed) },
      { header: "Received", num: true, render: (r) => money(r.received) },
      { header: `Before ${monthName}`, num: true, render: (r) => r.prior_pending > 0.5 ? el("span", { class: "badge red", text: money(r.prior_pending) }) : el("span", { class: "muted", text: "—" }) },
      { header: monthName, num: true, render: (r) => money(r.current_pending) },
      { header: "Pending", num: true, render: (r) => el("span", { class: r.pending > 0.5 ? "badge red" : "badge green", text: money(r.pending) }) },
      { header: "Status", render: settlementStatusCell },
      { header: "Last paid", render: (r) => fmtDate(r.last_payment) },
      { header: "", render: (r) => el("button", { class: "btn sm secondary", onclick: (e) => { e.stopPropagation(); paymentModal(r.id, null, load); } }, "💵 Receive") },
    ], rows, {
      onRowClick: (r) => clientDrawer(r.id),
      groupBy: "society",
      search: ["name", "phone"],
      searchPlaceholder: "Search by client name or phone…",
      footer: (shown) => [
        { text: `${shown.length} clients` }, { text: "" },
        { text: sum(shown, "billed"), num: true },
        { text: sum(shown, "received"), num: true },
        { text: sum(shown, "prior_pending"), num: true },
        { text: sum(shown, "current_pending"), num: true },
        { text: sum(shown, "pending"), num: true },
        { text: "" }, { text: "" }, { text: "" },
      ],
      empty: prevOnly ? `No one owes anything from before ${monthName} 🎉` : opts.hideSettled ? "Everyone is settled up 🎉" : "No clients yet.",
    }));
  }
  await load();
};

function settlementHtml(s, view) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  if (view && view.prevOnly) {
    const rows = view.rows;
    const t = (k) => rows.reduce((a, x) => a + x[k], 0);
    const body = rows.map((r, i) => `<tr>
    <td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>
    <td class="r"><strong>${m(r.prior_pending)}</strong></td><td class="r">${m(r.current_pending)}</td>
    <td class="r">${m(r.pending)}</td></tr>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Previous months pending — ${esc(fmtDate(s.generated))}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">PREVIOUS MONTHS PENDING</div><div class="muted">Unpaid from before ${esc(view.monthName)} · as of ${esc(fmtDate(s.generated))}</div></div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Client</th><th>Phone</th><th class="r">Before ${esc(view.monthName)}</th><th class="r">${esc(view.monthName)}</th><th class="r">Total pending</th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="muted c">Nothing pending from previous months</td></tr>`}</tbody>
      <tfoot><tr class="grand">
        <td colspan="3">TOTAL</td><td class="r">${m(t("prior_pending"))}</td><td class="r">${m(t("current_pending"))}</td><td class="r">${m(t("pending"))}</td>
      </tr></tfoot>
    </table>
  </div></body></html>`;
  }
  const rows = s.rows
    .filter((r) => r.pending > 0.5 || r.received > 0 || r.billed > 0)
    .sort((a, b) => b.pending - a.pending);
  const body = rows.map((r, i) => `<tr>
    <td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>
    <td class="r">${m(r.billed)}</td><td class="r">${m(r.received)}</td>
    <td class="r"><strong>${m(r.pending)}</strong></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Settlements — ${esc(fmtDate(s.generated))}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">SETTLEMENTS</div><div class="muted">As of ${esc(fmtDate(s.generated))}</div></div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Client</th><th>Phone</th><th class="r">Billed</th><th class="r">Received</th><th class="r">Pending</th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" class="muted c">Nothing to show</td></tr>`}</tbody>
      <tfoot><tr class="grand">
        <td colspan="3">TOTAL</td><td class="r">${m(s.totals.billed)}</td><td class="r">${m(s.totals.received)}</td><td class="r">${m(s.totals.pending)}</td>
      </tr></tfoot>
    </table>
  </div></body></html>`;
}

/* ------------------------------------------------------------------ */
/*  Morning Milk — a SEPARATE bulk-sale ledger                          */
/* ------------------------------------------------------------------ */
VIEWS.morning = async (main) => {
  let buyers = await rpc(A.morningBuyers(true));
  const tab = { v: "sheet" };
  const listState = { ...period("thismonth"), buyerId: "" };

  main.innerHTML = "";
  main.append(pageHead("Morning Milk", "A separate sheet for the morning bulk milk — record what each buyer took, at what price, and collect their dues. Kept apart from home deliveries and the P&L."));

  /* ---- record a sale ---- */
  const formCard = el("div", { class: "card" });
  const dateI = input({ type: "date", value: todayStr() });
  const qtyI = input({ type: "number", min: "0", step: "0.5", placeholder: "e.g. 40" });
  const priceI = input({ type: "number", min: "0", step: "0.5", placeholder: "e.g. 190" });
  const noteI = input({ placeholder: "Optional" });
  const preview = el("strong", { text: money(0) });
  const buyerSel = selectBox([], "");
  function fillBuyerOptions() {
    buyerSel.innerHTML = "";
    const active = buyers.filter((b) => b.active);
    if (!active.length) buyerSel.append(el("option", { value: "" }, "— add a buyer first —"));
    for (const b of active) buyerSel.append(el("option", { value: b.id }, b.name));
    buyerSel.append(el("option", { value: "__new" }, "＋ Add new buyer…"));
  }
  fillBuyerOptions();
  function syncPrice() {
    const b = buyers.find((x) => String(x.id) === String(buyerSel.value));
    if (b && b.price_per_litre) priceI.value = b.price_per_litre;
    recalc();
  }
  buyerSel.addEventListener("change", () => {
    if (buyerSel.value === "__new") {
      buyerSel.value = "";
      morningBuyerDrawer(null, async () => { buyers = await rpc(A.morningBuyers(true)); fillBuyerOptions(); });
      return;
    }
    syncPrice();
  });
  const recalc = () => { const q = parseFloat(qtyI.value), p = parseFloat(priceI.value); preview.textContent = money(q > 0 && p > 0 ? q * p : 0); };
  qtyI.addEventListener("input", recalc);
  priceI.addEventListener("input", recalc);
  syncPrice();

  formCard.append(el("h2", { text: "Record a morning sale" }));
  formCard.append(el("div", { class: "form-grid", style: "margin-top:12px" }, [
    field("Date", dateI), field("Buyer", buyerSel), field("Litres", qtyI),
    field("Sale price / litre (" + currency() + ")", priceI), field("Note", noteI),
    el("div", {}, [el("div", { class: "mini", text: "Amount to collect" }), el("div", { style: "font-size:18px" }, [preview])]),
  ]));
  formCard.append(el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
    try {
      if (!buyerSel.value) throw new Error("Choose a buyer (or add one).");
      await rpc(A.morningSaleSave({
        buyer_id: Number(buyerSel.value), date: dateI.value,
        quantity_litres: qtyI.value, price_per_litre: priceI.value, note: noteI.value,
      }));
      toast("Morning sale recorded", "ok");
      qtyI.value = ""; noteI.value = ""; recalc();
      buyers = await rpc(A.morningBuyers(true));
      render();
    } catch (e) { toast(e.message, "err"); }
  } }, "Add sale"));
  main.append(formCard);

  const seg = segmented([["sheet", "Daily sheet"], ["dues", "Buyers & dues"]], tab.v, (v) => { tab.v = v; render(); });
  seg.style.margin = "20px 0 12px";
  main.append(seg);
  const filterWrap = el("div");
  main.append(filterWrap);
  const container = el("div", { style: "margin-top:12px" });
  main.append(container);

  function buyerFilter(current, onChange) {
    const opts = [{ value: "", label: "All buyers" }, ...buyers.map((b) => ({ value: b.id, label: b.name }))];
    const sel = selectBox(opts, current);
    sel.addEventListener("change", () => onChange(sel.value));
    return field("Buyer", sel);
  }

  function render() {
    fillBuyerOptions();
    filterWrap.innerHTML = "";
    if (tab.v === "sheet") {
      filterWrap.append(el("div", { class: "row" }, [
        dateRangeControls(listState.from, listState.to, (f, t) => { listState.from = f; listState.to = t; loadSheet(); }),
        buyerFilter(listState.buyerId, (v) => { listState.buyerId = v; loadSheet(); }),
      ]));
      filterWrap.append(periodPresetRow(listState, () => render()));
      loadSheet();
    } else {
      loadDues();
    }
  }

  async function loadSheet() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const rows = await rpc(A.morningSalesList({
      from: listState.from, to: listState.to, buyerId: listState.buyerId ? Number(listState.buyerId) : undefined,
    }));
    const s = await rpc(A.morningSheet(listState.from, listState.to, listState.buyerId ? Number(listState.buyerId) : undefined));
    container.innerHTML = "";
    container.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      el("button", { class: "btn secondary", onclick: () => rpc(A.printHtml(morningSheetHtml(s))).catch((e) => toast(e.message, "err")) }, "🖨  Print sheet"),
      el("button", { class: "btn secondary", onclick: async () => { const r = await rpc(A.savePdf(morningSheetHtml(s), `morning-milk-${s.from}-to-${s.to}`)); if (!r.canceled) toast("Saved: " + r.path, "ok"); } }, "⬇  Save PDF"),
    ]));
    container.append(el("div", { class: "kpis", style: "margin-bottom:14px" }, [
      kpi("Litres sold", litres(s.totals.litres)),
      kpi("Amount billed", money(s.totals.amount), "accent"),
      kpi("Avg rate / litre", money2(s.totals.avg_rate)),
      kpi("Buyers", String(s.byBuyer.length)),
    ]));
    if (s.byBuyer.length > 1) {
      container.append(el("div", { class: "card", style: "margin-bottom:14px" }, [
        el("h2", { text: "By buyer" }),
        dataTable([
          { header: "Buyer", render: (r) => el("strong", { text: r.buyer }) },
          { header: "Litres", num: true, render: (r) => litres(r.litres) },
          { header: "Amount", num: true, render: (r) => money(r.amount) },
        ], s.byBuyer, { empty: "—", footer: (sh) => [
          { text: "Total" },
          { text: litres(round2(sh.reduce((a, r) => a + r.litres, 0))), num: true },
          { text: money(sh.reduce((a, r) => a + r.amount, 0)), num: true },
        ] }),
      ]));
    }
    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Buyer", key: "buyer_name" },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.total_amount) }) },
      { header: "Note", key: "note" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this sale?")) { await rpc(A.morningSaleDelete(r.id)); toast("Deleted", "ok"); loadSheet(); } } }, "✕") },
    ], rows, {
      onRowClick: (r) => morningSaleModal(r, buyers, loadSheet),
      search: ["date", "buyer_name", "note"],
      searchPlaceholder: "Search by date, buyer or note…",
      footer: (shown) => [
        { text: "Total" }, { text: "" },
        { text: litres(shown.reduce((a, r) => a + r.quantity_litres, 0)), num: true }, { text: "" },
        { text: money(shown.reduce((a, r) => a + r.total_amount, 0)), num: true }, { text: "" }, { text: "" },
      ],
      empty: "No morning sales in this period.",
    }));
  }

  async function loadDues() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const st = await rpc(A.morningSettlements());
    container.innerHTML = "";
    container.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      el("button", { class: "btn", onclick: () => morningBuyerDrawer(null, () => go("morning")) }, "＋  Add buyer"),
    ]));
    container.append(el("div", { class: "kpis", style: "margin-bottom:14px" }, [
      kpi("Total billed", money(st.totals.sold)),
      kpi("Total received", money(st.totals.received), "good"),
      kpi("Total pending", money(st.totals.pending), st.totals.pending > 0.5 ? "bad" : "good"),
      kpi("Buyers with dues", String(st.rows.filter((r) => r.pending > 0.5).length)),
    ]));
    container.append(dataTable([
      { header: "Buyer", render: (r) => el("strong", { text: r.name }) },
      { header: "Phone", key: "phone" },
      { header: "Litres", num: true, render: (r) => litres(r.litres) },
      { header: "Billed", num: true, render: (r) => money(r.sold) },
      { header: "Received", num: true, render: (r) => money(r.received) },
      { header: "Pending", num: true, render: (r) => el("span", { class: r.pending > 0.5 ? "badge red" : "badge green", text: money(r.pending) }) },
      { header: "Last paid", render: (r) => fmtDate(r.last_payment) },
      { header: "", render: (r) => el("button", { class: "btn sm secondary", onclick: (e) => { e.stopPropagation(); morningPaymentModal(r.id, null, loadDues); } }, "💵 Receive") },
    ], st.rows, {
      onRowClick: (r) => morningBuyerDrawer(r.id, loadDues),
      search: ["name", "phone"],
      searchPlaceholder: "Search by buyer name or phone…",
      footer: (shown) => [
        { text: `${shown.length} buyers` }, { text: "" },
        { text: litres(shown.reduce((a, r) => a + r.litres, 0)), num: true },
        { text: money(shown.reduce((a, r) => a + r.sold, 0)), num: true },
        { text: money(shown.reduce((a, r) => a + r.received, 0)), num: true },
        { text: money(shown.reduce((a, r) => a + r.pending, 0)), num: true },
        { text: "" }, { text: "" },
      ],
      empty: "No buyers yet — add one above.",
    }));
  }

  render();
};

async function morningBuyerDrawer(id, onDone) {
  const buyer = id ? await rpc(A.morningBuyerGet(id)) : null;
  const drawer = el("div", { class: "drawer" });
  const nameI = input({ value: buyer?.name || "", placeholder: "e.g. Chaudhry Milk Shop" });
  const phoneI = input({ value: buyer?.phone || "", placeholder: "03XX-XXXXXXX" });
  const addrI = input({ value: buyer?.address || "", placeholder: "Area / market" });
  const priceI = input({ type: "number", min: "0", step: "0.5", value: buyer ? String(buyer.price_per_litre) : "", placeholder: "e.g. 190" });
  const openI = input({ type: "number", step: "1", value: buyer ? String(buyer.opening_balance) : "0" });
  const activeI = input({ type: "checkbox" }); activeI.checked = buyer ? !!buyer.active : true;
  const noteI = el("textarea", { placeholder: "Optional" }, buyer?.note || "");

  drawer.append(el("h2", { text: buyer ? "Edit buyer" : "Add morning-milk buyer" }));
  const balCell = buyer ? el("strong", { class: buyer.balance > 0 ? "badge red" : "badge green", text: money(buyer.balance) }) : null;
  if (buyer) {
    drawer.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-bottom:14px;align-items:center" }, [
      el("div", {}, [el("div", { class: "mini", text: "Balance to collect" }), balCell]),
      el("button", { class: "btn sm secondary", onclick: () => morningPaymentsModal(buyer.id, refresh) }, "Manage payments →"),
    ]));
  }
  drawer.append(field("Name", nameI));
  drawer.append(field("Phone", phoneI));
  drawer.append(field("Address", addrI));
  drawer.append(field("Default sale price / litre (" + currency() + ")", priceI));
  drawer.append(field("Opening balance (" + currency() + ") — owed before this sheet started", openI));
  drawer.append(el("label", { class: "row", style: "gap:8px;margin:6px 0" }, [activeI, "Active"]));
  drawer.append(field("Note", noteI));

  const close = openOverlay(drawer);
  drawer.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: save }, buyer ? "Save changes" : "Add buyer"),
    buyer ? el("button", { class: "btn danger", onclick: remove }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));

  async function refresh() {
    if (!buyer) return;
    const fresh = await rpc(A.morningBuyerGet(buyer.id));
    balCell.textContent = money(fresh.balance);
    balCell.className = fresh.balance > 0 ? "badge red" : "badge green";
    onDone && onDone();
  }
  async function save() {
    try {
      if (!nameI.value.trim()) throw new Error("Name is required.");
      await rpc(A.morningBuyerSave({
        id: buyer?.id, name: nameI.value, phone: phoneI.value, address: addrI.value,
        price_per_litre: priceI.value, opening_balance: openI.value,
        active: activeI.checked, note: noteI.value,
      }));
      toast("Saved", "ok");
      close();
      onDone && onDone();
    } catch (e) { toast(e.message, "err"); }
  }
  async function remove() {
    if (!(await confirmBox("Delete " + buyer.name + "? If they have sales they'll be set inactive instead."))) return;
    const r = await rpc(A.morningBuyerDelete(buyer.id));
    toast(r === "deleted" ? "Buyer deleted" : "Buyer set inactive", "ok");
    close();
    onDone && onDone();
  }
}

async function morningPaymentModal(buyerId, payment, onDone) {
  const buyer = await rpc(A.morningBuyerGet(buyerId));
  const baseBalance = payment?.id ? round2(buyer.balance + Number(payment.amount || 0)) : buyer.balance;
  const box = el("div", { class: "modal", style: "width:440px" });
  const dateI = input({ type: "date", value: payment?.date || todayStr() });
  const amtI = input({ type: "number", min: "0", step: "1", value: payment?.amount || "", placeholder: "amount received" });
  const methodI = selectBox(META.paymentMethods, payment?.method || "cash");
  const noteI = input({ value: payment?.note || "", placeholder: "Optional" });

  box.append(el("h2", { text: (payment?.id ? "Edit payment — " : "Receive payment — ") + buyer.name }));
  box.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-bottom:14px" }, [
    el("span", { class: "mini", text: "Currently owes" }),
    el("strong", { text: money(baseBalance) }),
  ]));
  box.append(field("Date received", dateI));
  box.append(field("Amount received (" + currency() + ")", amtI));
  box.append(field("Method", methodI));
  box.append(field("Note", noteI));
  const remainCell = el("strong");
  box.append(el("div", { class: "row between", style: "border-top:2px solid var(--border);padding-top:10px;margin-top:6px" }, [
    el("span", { class: "mini", text: "Remaining after this payment" }), remainCell,
  ]));
  function recalc() {
    const remain = round2(baseBalance - (parseFloat(amtI.value) || 0));
    remainCell.textContent = money(remain);
    remainCell.className = remain > 0 ? "badge red" : "badge green";
  }
  amtI.addEventListener("input", recalc);
  recalc();
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        if (!(parseFloat(amtI.value) > 0)) throw new Error("Enter a valid amount.");
        await rpc(A.morningPaymentSave({ id: payment?.id, buyer_id: buyerId, date: dateI.value, amount: amtI.value, method: methodI.value, note: noteI.value }));
        toast("Payment saved", "ok");
        close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save payment"),
    baseBalance > 0 ? el("button", { class: "btn secondary", onclick: () => { amtI.value = String(Math.round(baseBalance)); recalc(); } }, "Pay full " + money(baseBalance)) : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

async function morningPaymentsModal(buyerId, onChange) {
  const box = el("div", { class: "modal", style: "width:620px" });
  const buyer = await rpc(A.morningBuyerGet(buyerId));
  const balStrong = el("strong");
  const payFullBtn = el("button", { class: "btn sm" }, "Pay full balance");
  box.append(el("div", { class: "row between", style: "margin-bottom:12px" }, [
    el("h2", { text: "Payments — " + buyer.name, style: "margin:0" }),
    el("button", { class: "btn sm", onclick: () => morningPaymentModal(buyerId, null, refresh) }, "＋ Record payment"),
  ]));
  box.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-bottom:14px;align-items:center" }, [
    el("div", {}, [el("div", { class: "mini", text: "Balance to collect" }), balStrong]),
    payFullBtn,
  ]));
  const listBox = el("div");
  box.append(listBox);
  const closeV = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [el("button", { class: "btn ghost", onclick: () => closeV() }, "Close")]));

  async function refresh() {
    const [b, pays] = await Promise.all([rpc(A.morningBuyerGet(buyerId)), rpc(A.morningPaymentsList({ buyerId }))]);
    balStrong.textContent = money(b.balance);
    balStrong.className = b.balance > 0 ? "badge red" : "badge green";
    payFullBtn.hidden = !(b.balance > 0.5);
    payFullBtn.onclick = () => morningPaymentModal(buyerId, { amount: Math.round(b.balance), note: "Full balance settled" }, refresh);
    listBox.innerHTML = "";
    listBox.append(dataTable([
      { header: "Date", render: (p) => fmtDate(p.date) },
      { header: "Amount", num: true, render: (p) => money(p.amount) },
      { header: "Method", render: (p) => titleCase(p.method || "—") },
      { header: "Note", key: "note" },
      { header: "", render: (p) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this payment?")) { await rpc(A.morningPaymentDelete(p.id)); toast("Deleted", "ok"); refresh(); } } }, "✕") },
    ], pays, {
      onRowClick: (p) => morningPaymentModal(buyerId, p, refresh),
      search: ["date", "method", "note"],
      searchPlaceholder: "Search payments…",
      footer: (shown) => [
        { text: `${shown.length} payment${shown.length === 1 ? "" : "s"}` },
        { text: money(shown.reduce((a, p) => a + p.amount, 0)), num: true },
        { text: "" }, { text: "" }, { text: "" },
      ],
      empty: "No payments recorded yet.",
    }));
    onChange && onChange();
  }
  await refresh();
}

function morningSaleModal(sale, buyers, onDone) {
  const box = el("div", { class: "modal", style: "width:460px" });
  const active = buyers.filter((b) => b.active || (sale && b.id === sale.buyer_id));
  const buyerI = selectBox(active.map((b) => ({ value: b.id, label: b.name })), sale?.buyer_id || active[0]?.id);
  const dateI = input({ type: "date", value: sale?.date || todayStr() });
  const qtyI = input({ type: "number", min: "0", step: "0.5", value: sale?.quantity_litres ?? "" });
  const priceI = input({ type: "number", min: "0", step: "0.5", value: sale?.price_per_litre ?? "" });
  const noteI = input({ value: sale?.note || "", placeholder: "Optional" });
  box.append(el("h2", { text: sale ? "Edit morning sale" : "Add morning sale" }));
  box.append(field("Buyer", buyerI));
  box.append(field("Date", dateI));
  box.append(field("Litres", qtyI));
  box.append(field("Sale price per litre (" + currency() + ")", priceI));
  box.append(field("Note", noteI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.morningSaleSave({
          id: sale?.id, buyer_id: Number(buyerI.value), date: dateI.value,
          quantity_litres: qtyI.value, price_per_litre: priceI.value, note: noteI.value,
        }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    sale ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this sale?")) { await rpc(A.morningSaleDelete(sale.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

function morningSheetHtml(s) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  const L = (n) => (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const dayRows = s.days.map((d) => `<tr>
    <td>${esc(fmtDate(d.date))}</td>
    <td>${d.lines.map((l) => esc(l.buyer) + " (" + L(l.litres) + "L)").join(", ")}</td>
    <td class="r">${L(d.litres)}</td><td class="r">${m(d.amount)}</td></tr>`).join("");
  const buyerRows = s.byBuyer.map((b) => `<tr><td>${esc(b.buyer)}</td><td class="r">${L(b.litres)}</td><td class="r">${m(b.amount)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Morning Milk ${esc(fmtDate(s.from))} — ${esc(fmtDate(s.to))}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">MORNING MILK</div>
      <div class="muted">${esc(fmtDate(s.from))} &nbsp;to&nbsp; ${esc(fmtDate(s.to))}</div>
      <div class="muted">${s.buyer ? "Buyer: " + esc(s.buyer) : "All buyers"}</div></div>
    </div>
    ${buyerRows ? `<table style="margin-bottom:14px"><thead><tr><th>Buyer</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead><tbody>${buyerRows}</tbody></table>` : ""}
    <table>
      <thead><tr><th>Date</th><th>Buyers</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead>
      <tbody>${dayRows || `<tr><td colspan="4" class="muted c">Nothing recorded for this period</td></tr>`}</tbody>
      <tfoot><tr class="grand"><td colspan="2">TOTAL</td><td class="r">${L(s.totals.litres)}</td><td class="r">${m(s.totals.amount)}</td></tr></tfoot>
    </table>
  </div></body></html>`;
}

/* ---- milk entries log ---- */
VIEWS.entries = async (main) => {
  const state = { from: monthStartStr(), to: todayStr(), clientId: "" };
  const clients = await rpc(A.clientsList(true));
  main.innerHTML = "";
  main.append(pageHead("Milk Entries", "Every recorded delivery. Click a row to edit.", [
    el("button", { class: "btn", onclick: () => entryModal(null, load) }, "＋  Add entry"),
  ]));
  const clientSel = selectBox([{ value: "", label: "All clients" }, ...clients.map((c) => ({ value: c.id, label: c.name }))], "");
  clientSel.addEventListener("change", () => { state.clientId = clientSel.value; load(); });
  const controls = el("div", { class: "row", style: "margin-bottom:14px" }, [
    dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; load(); }),
    field("Client", clientSel),
  ]);
  main.append(controls);
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const rows = await rpc(A.entriesList({ from: state.from, to: state.to, clientId: state.clientId || undefined }));
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Client", key: "client_name" },
      { header: "Category", render: (r) => titleCase(r.milk_category) },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.total_amount) }) },
    ], rows, {
      onRowClick: (r) => entryModal(r, load),
      groupBy: "society", groupNoun: "entries",
      search: ["date", "client_name", "milk_category"],
      searchPlaceholder: "Search by date, client or category…",
      footer: (shown) => [
        { text: "Total" }, { text: "" }, { text: "" },
        { text: litres(shown.reduce((a, r) => a + r.quantity_litres, 0)), num: true }, { text: "" },
        { text: money(shown.reduce((a, r) => a + r.total_amount, 0)), num: true },
      ],
      empty: "No entries for this period.",
    }));
  }
  await load();
};

async function entryModal(entry, onDone) {
  const clients = await rpc(A.clientsList(true));
  const box = el("div", { class: "modal", style: "width:460px" });
  const clientI = selectBox(clients.map((c) => ({ value: c.id, label: c.name })), entry?.client_id || clients[0]?.id);
  const dateI = input({ type: "date", value: entry?.date || todayStr() });
  const catI = selectBox(META.milkCategories, entry?.milk_category || "mixed");
  const qtyI = input({ type: "number", min: "0", step: "0.25", value: entry?.quantity_litres ?? "", placeholder: "litres" });
  const priceI = input({ type: "number", min: "0", step: "0.5", value: entry?.price_per_litre ?? "" });
  function syncPrice() {
    const c = clients.find((x) => String(x.id) === String(clientI.value));
    if (c && !entry) { priceI.value = c.price_per_litre; catI.value = c.milk_category; }
  }
  clientI.addEventListener("change", syncPrice);
  if (!entry) syncPrice();

  box.append(el("h2", { text: entry ? "Edit entry" : "Add entry" }));
  box.append(field("Client", clientI));
  box.append(field("Date", dateI));
  box.append(field("Milk category", catI));
  box.append(field("Quantity (litres)", qtyI));
  box.append(field("Price per litre (" + currency() + ")", priceI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.entrySave({
          id: entry?.id, client_id: Number(clientI.value), date: dateI.value,
          milk_category: catI.value, quantity_litres: qtyI.value, price_per_litre: priceI.value,
        }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    entry ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this entry?")) { await rpc(A.entryDelete(entry.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* ---- purchases ---- */
VIEWS.purchases = async (main) => {
  const p0 = period("thismonth");
  const state = { from: "", to: "", sfrom: p0.from, sto: p0.to, supplier: "all", ssupplier: "all", pay: "all", dfrom: "", dto: "", dsupplier: "all" };
  let suppliers = await rpc(A.purchaseSuppliers()); // [{supplier, n, litres, cost}]

  main.innerHTML = "";
  main.append(pageHead("Purchases", "Milk bought from suppliers — Chacha Dairy, Wahga Dairy, Doodhi, etc."));

  // ---- record form ----
  const formCard = el("div", { class: "card" });
  const dateI = input({ type: "date", value: todayStr() });
  const supplierI = input({ placeholder: "e.g. Chacha Dairy", list: "supplier-list" });
  const supplierList = el("datalist", { id: "supplier-list" });
  const qtyI = input({ type: "number", min: "0", step: "1", placeholder: "e.g. 100" });
  const priceI = input({ type: "number", min: "0", step: "0.5", placeholder: "e.g. 180" });
  const notesI = input({ placeholder: "Optional" });
  const payModeI = selectBox([{ value: "paid", label: "Paid in cash" }, { value: "credit", label: "On credit (udhaar)" }], "paid");
  const paidAmtI = input({ type: "number", min: "0", step: "1", placeholder: "0", style: "width:120px" });
  const paidWrap = field("Amount paid now", paidAmtI);
  paidWrap.hidden = true;
  payModeI.addEventListener("change", () => { paidWrap.hidden = payModeI.value !== "credit"; });
  const preview = el("strong", { text: money(0) });
  const recalc = () => { const q = parseFloat(qtyI.value), p = parseFloat(priceI.value); preview.textContent = money(q > 0 && p > 0 ? q * p : 0); };
  qtyI.addEventListener("input", recalc); priceI.addEventListener("input", recalc);
  function refreshSupplierOptions() {
    supplierList.innerHTML = "";
    for (const s of suppliers) supplierList.append(el("option", { value: s.supplier }));
  }
  refreshSupplierOptions();
  formCard.append(el("h2", { text: "Record a purchase" }));
  formCard.append(supplierList);
  formCard.append(el("div", { class: "form-grid", style: "margin-top:12px" }, [
    field("Date", dateI), field("Supplier", supplierI), field("Quantity (litres)", qtyI),
    field("Price / litre", priceI), field("Notes", notesI),
    field("Payment", payModeI), paidWrap,
    el("div", {}, [el("div", { class: "mini", text: "Total cost" }), el("div", { style: "font-size:18px" }, [preview])]),
  ]));
  formCard.append(el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
    try {
      const total = (parseFloat(qtyI.value) || 0) * (parseFloat(priceI.value) || 0);
      const amount_paid = payModeI.value === "credit" ? (parseFloat(paidAmtI.value) || 0) : total;
      await rpc(A.purchaseSave({
        date: dateI.value, supplier: supplierI.value, quantity_litres: qtyI.value,
        price_per_litre: priceI.value, supplier_notes: notesI.value, amount_paid,
      }));
      toast(payModeI.value === "credit" && amount_paid < total ? "Purchase recorded — on credit" : "Purchase recorded", "ok");
      qtyI.value = ""; priceI.value = ""; notesI.value = ""; paidAmtI.value = "";
      payModeI.value = "paid"; paidWrap.hidden = true; recalc();
      suppliers = await rpc(A.purchaseSuppliers()); refreshSupplierOptions();
      render();
    } catch (e) { toast(e.message, "err"); }
  } }, "Add purchase"));
  main.append(formCard);

  // ---- section switch ----
  const sec = { v: "list" };
  const seg = segmented([["list", "All purchases"], ["sheet", "Daily purchase sheet"], ["dues", "Supplier dues"]], sec.v, (v) => { sec.v = v; render(); });
  seg.style.margin = "20px 0 12px";
  main.append(seg);
  const filterWrap = el("div");
  main.append(filterWrap);
  const container = el("div", { style: "margin-top:12px" });
  main.append(container);

  function supplierFilter(current, onChange) {
    const opts = [{ value: "all", label: "All suppliers" }, ...suppliers.map((s) => ({ value: s.supplier, label: `${s.supplier} (${litres(s.litres)})` }))];
    const sel = selectBox(opts, current);
    sel.addEventListener("change", () => onChange(sel.value));
    return field("Supplier", sel);
  }

  function render() {
    filterWrap.innerHTML = "";
    if (sec.v === "dues") {
      filterWrap.append(el("div", { class: "row" }, [
        dateRangeControls(state.dfrom, state.dto, (f, t) => { state.dfrom = f; state.dto = t; loadDues(); }),
        supplierFilter(state.dsupplier, (v) => { state.dsupplier = v; loadDues(); }),
      ]));
      filterWrap.append(quickDates("dfrom", "dto"));
      loadDues();
    } else if (sec.v === "list") {
      filterWrap.append(el("div", { class: "row" }, [
        dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; loadList(); }),
        supplierFilter(state.supplier, (v) => { state.supplier = v; loadList(); }),
        (() => {
          const sel = selectBox([
            { value: "all", label: "All purchases" },
            { value: "credit", label: "Only on credit (udhaar)" },
            { value: "remaining", label: "Only still unpaid (remaining)" },
          ], state.pay);
          sel.addEventListener("change", () => { state.pay = sel.value; loadList(); });
          return field("Show", sel);
        })(),
      ]));
      filterWrap.append(quickDates("from", "to"));
      loadList();
    } else {
      filterWrap.append(el("div", { class: "row" }, [
        dateRangeControls(state.sfrom, state.sto, (f, t) => { state.sfrom = f; state.sto = t; loadSheet(); }),
        supplierFilter(state.ssupplier, (v) => { state.ssupplier = v; loadSheet(); }),
        el("button", { class: "btn secondary sm", onclick: () => { const p = period("thismonth"); state.sfrom = p.from; state.sto = p.to; render(); } }, "This month"),
        el("button", { class: "btn secondary sm", onclick: () => { const p = period("lastmonth"); state.sfrom = p.from; state.sto = p.to; render(); } }, "Last month"),
      ]));
      loadSheet();
    }
  }

  /** Quick date-range buttons; writes state[fk]/state[tk] and re-renders. */
  function quickDates(fk, tk) {
    const today = todayStr();
    const quick = [
      ["Until today", { from: "", to: today }],
      ["This month", period("thismonth")],
      ["Previous month", period("lastmonth")],
      ["Last 10 days", period("last10")],
      ["Last 11 days", { from: iso(addDays(new Date(), -10)), to: today }],
      ["1–10", tenDayBlock(today, 0)],
      ["11–20", tenDayBlock(today, 1)],
      ["21–end", tenDayBlock(today, 2)],
      ["All dates", { from: "", to: "" }],
    ];
    return el("div", { class: "row", style: "gap:6px;margin-top:8px;flex-wrap:wrap" }, [
      el("span", { class: "mini", text: "Quick:" }),
      ...quick.map(([label, r]) => el("button", {
        class: "btn sm " + (state[fk] === r.from && state[tk] === r.to ? "" : "secondary"),
        title: r.from || r.to ? `${r.from ? fmtDate(r.from) : "start"} → ${r.to ? fmtDate(r.to) : "now"}` : "No date limit",
        onclick: () => { state[fk] = r.from; state[tk] = r.to; render(); },
      }, label)),
    ]);
  }

  const owedOf = (r) => round2((Number(r.total_cost) || 0) - (r.amount_paid == null ? (Number(r.total_cost) || 0) : (Number(r.amount_paid) || 0)));

  async function loadList() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const [allRows, credit] = await Promise.all([
      rpc(A.purchasesList({ from: state.from || undefined, to: state.to || undefined, supplier: state.supplier })),
      rpc(A.purchaseCredit()),
    ]);
    // Payment filter: credit = bought on udhaar (paid or not); remaining = credit still not paid off.
    const rows = state.pay === "credit" ? allRows.filter((r) => owedOf(r) > 0.5)
      : state.pay === "remaining" ? allRows.filter((r) => (Number(r.credit_remaining) || 0) > 0.5)
      : allRows;
    container.innerHTML = "";

    if (state.pay !== "all") {
      // Summary of what the filtered bills still owe, per supplier.
      const by = new Map();
      for (const r of rows) {
        const k = r.supplier || "—";
        const g = by.get(k) || { supplier: k, n: 0, litres: 0, cost: 0, left: 0 };
        g.n++; g.litres += r.quantity_litres; g.cost += r.total_cost; g.left += Number(r.credit_remaining) || 0; if ((Number(r.credit_remaining) || 0) > 0.5) g.open = (g.open || 0) + 1;
        by.set(k, g);
      }
      const groups = [...by.values()].sort((a, b) => b.left - a.left);
      const totalLeft = round2(groups.reduce((a, g) => a + g.left, 0));
      container.append(el("div", { class: "kpis", style: "margin-bottom:12px" }, [
        kpi(state.pay === "remaining" ? "Unpaid bills" : "Bills on credit", String(rows.length), "", `${litres(rows.reduce((a, r) => a + r.quantity_litres, 0))} · ${money(rows.reduce((a, r) => a + r.total_cost, 0))}`),
        ...groups.map((g) => kpi(g.supplier, money(g.left), g.left > 0.5 ? "bad" : "good",
          g.left > 0.5 ? `${g.open} unpaid bill${g.open === 1 ? "" : "s"} (of ${g.n} on credit)` : `${g.n} bill${g.n === 1 ? "" : "s"} — all cleared`)),
        kpi("Total still to pay", money(totalLeft), (totalLeft > 0.5 ? "bad" : "good") + " total",
          state.supplier === "all" ? "All suppliers" : state.supplier),
      ]));
    }

    if (credit.total > 0.5) {
      const parts = credit.bySupplier.map((s) => `${s.supplier}: ${money(s.owed)}`).join("  ·  ");
      container.append(el("div", { class: "inline-note warn", style: "margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap" }, [
        el("span", { text: `💸 Still to pay suppliers: ${money(credit.total)}  —  ${parts}` }),
        el("button", { class: "btn sm", onclick: () => supplierPayModal("", suppliers, () => loadList()) }, "💵  Pay a supplier"),
      ]));
    }

    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Supplier", render: (r) => el("strong", { text: r.supplier || "—" }) },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Total cost", num: true, render: (r) => el("strong", { text: money(r.total_cost) }) },
      { header: "Payment", render: (r) => {
        const credit = owedOf(r);              // amount left unpaid at purchase time
        if (credit <= 0.5) return el("span", { class: "badge green", text: "Cash" });
        const left = Number(r.credit_remaining) || 0;
        if (left <= 0.5) return el("span", { class: "badge green", text: "Credit · cleared" });
        if (left < credit - 0.5) return el("span", { class: "badge amber", text: `Credit · ${money(left)} left` });
        return el("span", { class: "badge red", text: "Credit " + money(left) });
      } },
      { header: "Notes", key: "supplier_notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this purchase?")) { await rpc(A.purchaseDelete(r.id)); toast("Deleted", "ok"); loadList(); } } }, "✕") },
    ], rows, {
      onRowClick: (r) => purchaseModal(r, suppliers, async () => { suppliers = await rpc(A.purchaseSuppliers()); loadList(); }),
      search: ["date", "supplier", "supplier_notes"],
      searchPlaceholder: "Search by date, supplier or note…",
      footer: (shown) => {
        const stillOwed = shown.reduce((a, r) => a + (Number(r.credit_remaining) || 0), 0);
        return [
          { text: "Total" }, { text: "" },
          { text: litres(shown.reduce((a, r) => a + r.quantity_litres, 0)), num: true }, { text: "" },
          { text: money(shown.reduce((a, r) => a + r.total_cost, 0)), num: true },
          { text: stillOwed > 0.5 ? money(stillOwed) + " unpaid" : "" }, { text: "" }, { text: "" },
        ];
      },
      empty: state.pay === "remaining" ? "Nothing unpaid for this filter 🎉" : state.pay === "credit" ? "No credit purchases for this filter." : "No purchases for this filter.",
    }));
  }

  async function loadDues() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const ranged = !!(state.dfrom || state.dto);
    const [acc0, pays0, bills] = await Promise.all([
      rpc(A.supplierAccounts(false)), rpc(A.supplierPayList({})),
      ranged ? rpc(A.purchasesList({ from: state.dfrom || undefined, to: state.dto || undefined, supplier: state.dsupplier })) : Promise.resolve([]),
    ]);
    const sup = state.dsupplier;
    const acc = { ...acc0, rows: acc0.rows.filter((r) => sup === "all" || r.supplier === sup) };
    acc.total_owed = round2(acc.rows.reduce((a, r) => a + Math.max(0, r.owed), 0));
    acc.total_advance = round2(acc.rows.reduce((a, r) => a + Math.max(0, -r.owed), 0));
    const pays = pays0.filter((p) => (sup === "all" || p.supplier === sup)
      && (!state.dfrom || p.date >= state.dfrom) && (!state.dto || p.date <= state.dto));
    container.innerHTML = "";

    if (ranged) {
      // Bills in the chosen dates: bought, and how much of THOSE bills is still unpaid
      // (supplier payments clear the oldest bills first).
      const by = new Map();
      for (const b of bills) {
        const g = by.get(b.supplier) || { supplier: b.supplier, n: 0, litres: 0, bought: 0, credit: 0, left: 0, open: 0 };
        g.n++; g.litres += b.quantity_litres; g.bought += b.total_cost;
        g.credit += owedOf(b); const l = Number(b.credit_remaining) || 0; g.left += l; if (l > 0.5) g.open++;
        by.set(b.supplier, g);
      }
      const rows = [...by.values()].map((g) => ({ ...g, balance: (acc0.rows.find((r) => r.supplier === g.supplier) || {}).owed || 0 }))
        .sort((a, b) => b.left - a.left);
      const range = `${state.dfrom ? fmtDate(state.dfrom) : "start"} → ${state.dto ? fmtDate(state.dto) : "now"}`;
      const tl = round2(rows.reduce((a, r) => a + r.left, 0));
      container.append(el("div", { class: "card", style: "margin-bottom:16px" }, [
        el("h2", { text: `Bills from ${range}` }),
        el("p", { class: "mini", style: "margin:2px 0 10px", text: "What was bought in these dates and how much of those bills is still unpaid. Payments always clear the oldest bills first." }),
        el("div", { class: "kpis", style: "margin-bottom:12px" }, [
          kpi("Bought in these dates", money(rows.reduce((a, r) => a + r.bought, 0)), "", `${litres(rows.reduce((a, r) => a + r.litres, 0))} · ${rows.reduce((a, r) => a + r.n, 0)} bills`),
          kpi("On credit", money(rows.reduce((a, r) => a + r.credit, 0)), "accent"),
          kpi("Still unpaid from these bills", money(tl), (tl > 0.5 ? "bad" : "good") + " total", `${rows.reduce((a, r) => a + r.open, 0)} unpaid bills`),
        ]),
        dataTable([
          { header: "Supplier", render: (r) => el("strong", { text: r.supplier }) },
          { header: "Bills", num: true, key: "n" },
          { header: "Litres", num: true, render: (r) => litres(r.litres) },
          { header: "Bought", num: true, render: (r) => money(r.bought) },
          { header: "On credit", num: true, render: (r) => money(r.credit) },
          { header: "Still unpaid (these bills)", num: true, render: (r) => r.left > 0.5
            ? el("span", { class: "badge red", text: `${money(r.left)} · ${r.open} bill${r.open === 1 ? "" : "s"}` })
            : el("span", { class: "badge green", text: "Paid" }) },
          { header: "Total balance (all dates)", num: true, render: (r) => money(r.balance) },
          { header: "", render: (r) => r.balance > 0.5 ? el("button", { class: "btn sm secondary", onclick: () => supplierPayModal(r.supplier, suppliers, () => loadDues()) }, "💵 Pay") : "" },
        ], rows, { empty: "No purchases in these dates.", footer: (sh) => [
          { text: "Total" }, { text: String(sh.reduce((a, r) => a + r.n, 0)), num: true },
          { text: litres(sh.reduce((a, r) => a + r.litres, 0)), num: true },
          { text: money(sh.reduce((a, r) => a + r.bought, 0)), num: true },
          { text: money(sh.reduce((a, r) => a + r.credit, 0)), num: true },
          { text: money(sh.reduce((a, r) => a + r.left, 0)), num: true },
          { text: money(sh.reduce((a, r) => a + r.balance, 0)), num: true }, { text: "" },
        ] }),
      ]));
      container.append(el("h3", { text: "Overall balance (all dates)", style: "margin:4px 0 8px;font-size:14px" }));
    }

    container.append(el("div", { class: "row between", style: "margin-bottom:12px;align-items:center;flex-wrap:wrap;gap:10px" }, [
      el("div", { class: "mini" }, [
        "Total still owed to suppliers: ", el("strong", { text: money(acc.total_owed) }),
        acc.total_advance > 0.5 ? `   ·   advance paid: ${money(acc.total_advance)}` : "",
      ]),
      el("button", { class: "btn sm", onclick: () => supplierPayModal("", suppliers, () => loadDues()) }, "＋  Record a payment"),
    ]));

    container.append(dataTable([
      { header: "Supplier", render: (r) => el("strong", { text: r.supplier }) },
      { header: "Milk bought", num: true, render: (r) => money(r.purchased) },
      { header: "Paid", num: true, render: (r) => money(r.paid_total) },
      { header: "Balance", num: true, render: (r) => {
        if (r.owed > 0.5) return el("span", { class: "badge red", text: money(r.owed) + " owed" });
        if (r.owed < -0.5) return el("span", { class: "badge blue", text: money(-r.owed) + " advance" });
        return el("span", { class: "badge green", text: "Settled" });
      } },
      { header: "Last paid", render: (r) => (r.last_payment ? fmtDate(r.last_payment) : "—") },
      { header: "", render: (r) => el("button", { class: "btn sm secondary", onclick: () => supplierPayModal(r.supplier, suppliers, () => loadDues()) }, "💵 Pay") },
    ], acc.rows, { empty: "No suppliers yet — record a purchase first.", footer: (sh) => [
      { text: "Total" },
      { text: money(sh.reduce((a, r) => a + r.purchased, 0)), num: true },
      { text: money(sh.reduce((a, r) => a + r.paid_total, 0)), num: true },
      { text: money(sh.reduce((a, r) => a + r.owed, 0)) + " owed", num: true },
      { text: "" }, { text: "" },
    ] }));

    container.append(el("h3", { text: "Payment history" + (state.dfrom || state.dto ? " (in these dates)" : ""), style: "margin:22px 0 8px;font-size:14px" }));
    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Supplier", render: (r) => el("strong", { text: r.supplier }) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.amount) }) },
      { header: "Method", render: (r) => (r.method ? titleCase(r.method) : "—") },
      { header: "Note", key: "note" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this payment?")) { await rpc(A.supplierPayDelete(r.id)); toast("Deleted", "ok"); loadDues(); } } }, "✕") },
    ], pays, {
      onRowClick: (r) => supplierPayModal(r.supplier, suppliers, () => loadDues(), r),
      search: ["date", "supplier", "note"],
      searchPlaceholder: "Search payments…",
      footer: (shown) => [
        { text: "Total paid" }, { text: "" },
        { text: money(shown.reduce((a, r) => a + r.amount, 0)), num: true }, { text: "" }, { text: "" }, { text: "" },
      ],
      empty: "No supplier payments recorded yet.",
    }));
  }

  async function loadSheet() {
    container.innerHTML = "<div class='spin'>Building sheet…</div>";
    const s = await rpc(A.dailyMilkSheet(state.sfrom, state.sto, state.ssupplier));
    container.innerHTML = "";
    container.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      el("button", { class: "btn secondary", onclick: () => rpc(A.printHtml(purchaseSheetHtml(s))).catch((e) => toast(e.message, "err")) }, "🖨  Print sheet"),
      el("button", { class: "btn secondary", onclick: async () => { const r = await rpc(A.savePdf(purchaseSheetHtml(s), `milk-purchase-sheet-${s.from}-to-${s.to}`)); if (!r.canceled) toast("Saved: " + r.path, "ok"); } }, "⬇  Save as PDF"),
    ]));
    const diff = s.totals.difference_litres;
    container.append(el("div", { class: "kpis", style: "margin-bottom:14px" }, [
      kpi("Milk purchased", litres(s.totals.purchased_litres)),
      kpi("Purchase cost", money(s.totals.purchased_cost), "bad"),
      kpi("Avg rate / litre", money2(s.totals.avg_rate)),
      kpi("Milk delivered to clients", litres(s.totals.delivered_litres)),
      diff < 0
        ? kpi("Short (unrecorded purchase)", litres(-diff), "bad")
        : kpi("Purchased, not delivered", litres(diff)),
    ]));
    container.append(el("div", { class: "mini", style: "margin-bottom:12px" },
      diff < 0
        ? `Delivered ${litres(-diff)} more than purchased — a purchase entry is probably missing.`
        : "“Delivered” counts every client including wholesale buyers like Doodhi."
    ));
    if (s.by_supplier && s.by_supplier.length > 1) {
      container.append(el("div", { class: "card", style: "margin-bottom:14px" }, [
        el("h2", { text: "By supplier" }),
        dataTable([
          { header: "Supplier", render: (r) => el("strong", { text: r.supplier }) },
          { header: "Purchases", num: true, key: "n" },
          { header: "Litres", num: true, render: (r) => litres(r.litres) },
          { header: "Avg rate", num: true, render: (r) => money2(r.avg_rate) },
          { header: "Cost", num: true, render: (r) => money(r.cost) },
        ], s.by_supplier, { empty: "—", footer: (sh) => {
          const L = sh.reduce((a, r) => a + r.litres, 0), C = sh.reduce((a, r) => a + r.cost, 0);
          return [
            { text: "Total" }, { text: String(sh.reduce((a, r) => a + r.n, 0)), num: true },
            { text: litres(round2(L)), num: true }, { text: L ? money2(C / L) : "—", num: true }, { text: money(C), num: true },
          ];
        } }),
      ]));
    }
    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Purchased", num: true, render: (r) => litres(r.purchased_litres) },
      { header: "Rate", num: true, render: (r) => (r.avg_rate ? money2(r.avg_rate) : "—") },
      { header: "Cost", num: true, render: (r) => money(r.purchased_cost) },
      { header: "Delivered", num: true, render: (r) => litres(r.delivered_litres) },
      { header: "Diff", num: true, render: (r) => litres(r.difference_litres) },
    ], s.rows, {
      footer: [
        { text: "Total" },
        { text: litres(s.totals.purchased_litres), num: true },
        { text: money2(s.totals.avg_rate), num: true },
        { text: money(s.totals.purchased_cost), num: true },
        { text: litres(s.totals.delivered_litres), num: true },
        { text: litres(s.totals.difference_litres), num: true },
      ],
      empty: "No milk purchased or delivered in this period.",
    }));
  }

  render();
};

function purchaseModal(purchase, suppliers, onDone) {
  const box = el("div", { class: "modal", style: "width:460px" });
  const dateI = input({ type: "date", value: purchase?.date || todayStr() });
  const supplierI = input({ value: purchase?.supplier || "", list: "supplier-list-modal", placeholder: "e.g. Chacha Dairy" });
  const dl = el("datalist", { id: "supplier-list-modal" });
  for (const s of suppliers || []) dl.append(el("option", { value: s.supplier }));
  const qtyI = input({ type: "number", min: "0", step: "0.5", value: purchase?.quantity_litres ?? "" });
  const priceI = input({ type: "number", min: "0", step: "0.5", value: purchase?.price_per_litre ?? "" });
  const notesI = input({ value: purchase?.supplier_notes || "", placeholder: "Optional" });

  const curTotal = Number(purchase?.total_cost) || 0;
  const curPaid = purchase && purchase.amount_paid != null ? Number(purchase.amount_paid) : curTotal;
  const startCredit = purchase ? (curTotal - curPaid > 0.5) : false;
  const payModeI = selectBox([{ value: "paid", label: "Paid in full" }, { value: "credit", label: "On credit (udhaar)" }], startCredit ? "credit" : "paid");
  const paidAmtI = input({ type: "number", min: "0", step: "1", value: startCredit ? curPaid : "", placeholder: "0" });
  const owedLine = el("div", { class: "mini" });
  const paidWrap = field("Amount paid so far", paidAmtI);
  function refreshOwed() {
    const total = (parseFloat(qtyI.value) || 0) * (parseFloat(priceI.value) || 0);
    const paid = payModeI.value === "credit" ? (parseFloat(paidAmtI.value) || 0) : total;
    const owed = Math.max(0, total - paid);
    paidWrap.hidden = payModeI.value !== "credit";
    owedLine.textContent = owed > 0.5 ? `Still owed to supplier: ${money(owed)}` : "Nothing owed — paid in full.";
    owedLine.style.color = owed > 0.5 ? "var(--danger)" : "var(--muted)";
  }
  payModeI.addEventListener("change", refreshOwed);
  paidAmtI.addEventListener("input", refreshOwed);
  qtyI.addEventListener("input", refreshOwed);
  priceI.addEventListener("input", refreshOwed);

  box.append(el("h2", { text: purchase ? "Edit purchase" : "Add purchase" }));
  box.append(dl);
  box.append(field("Date", dateI));
  box.append(field("Supplier", supplierI));
  box.append(field("Quantity (litres)", qtyI));
  box.append(field("Price per litre (" + currency() + ")", priceI));
  box.append(field("Notes", notesI));
  box.append(field("Payment", payModeI));
  box.append(paidWrap);
  box.append(owedLine);
  refreshOwed();

  // If supplier payments (Supplier dues) have since been applied to this entry,
  // spell out how much of it is really still unpaid.
  const fifoLeft = purchase && purchase.credit_remaining != null ? Number(purchase.credit_remaining) : null;
  if (fifoLeft != null && (curTotal - curPaid) - fifoLeft > 0.5) {
    box.append(el("div", { class: "mini", style: "color:var(--warn);margin-top:4px" },
      `${money((curTotal - curPaid) - fifoLeft)} has since been paid to this supplier (Supplier dues) — ${fifoLeft > 0.5 ? money(fifoLeft) + " of this entry is still unpaid." : "this entry is now fully paid."}`));
  }
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        const total = (parseFloat(qtyI.value) || 0) * (parseFloat(priceI.value) || 0);
        const amount_paid = payModeI.value === "credit" ? (parseFloat(paidAmtI.value) || 0) : total;
        await rpc(A.purchaseSave({
          id: purchase?.id, date: dateI.value, supplier: supplierI.value,
          quantity_litres: qtyI.value, price_per_litre: priceI.value, supplier_notes: notesI.value,
          amount_paid,
        }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    (purchase && curTotal - curPaid > 0.5) ? el("button", { class: "btn secondary", onclick: async () => {
      try {
        await rpc(A.purchaseSave({
          id: purchase.id, date: dateI.value, supplier: supplierI.value,
          quantity_litres: qtyI.value, price_per_litre: priceI.value, supplier_notes: notesI.value,
          amount_paid: (parseFloat(qtyI.value) || 0) * (parseFloat(priceI.value) || 0),
        }));
        toast("Marked as fully paid", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "✓ Mark fully paid") : null,
    purchase ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this purchase?")) { await rpc(A.purchaseDelete(purchase.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/** Record / edit a payment made TO a supplier against milk bought on credit.
 *  `supplier` pre-selects a row; `payment` (optional) edits an existing one. */
async function supplierPayModal(supplier, suppliers, onDone, payment) {
  const acc = await rpc(A.supplierAccounts(false));
  const box = el("div", { class: "modal", style: "width:440px" });
  const dl = el("datalist", { id: "sup-pay-list" });
  for (const s of (suppliers || [])) dl.append(el("option", { value: s.supplier }));
  const supI = input({ value: payment?.supplier || supplier || "", list: "sup-pay-list", placeholder: "e.g. Chacha Dairy" });
  const dateI = input({ type: "date", value: payment?.date || todayStr() });
  const amtI = input({ type: "number", min: "0", step: "1", value: payment?.amount || "", placeholder: "amount paid" });
  const methodI = selectBox(META.paymentMethods, payment?.method || "cash");
  const noteI = input({ value: payment?.note || "", placeholder: "Optional" });

  box.append(el("h2", { text: payment?.id ? "Edit supplier payment" : "Pay a supplier" }));
  box.append(dl);
  box.append(field("Supplier", supI));

  const owedStrong = el("strong");
  box.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin:6px 0 14px" }, [
    el("span", { class: "mini", text: "Currently owed to this supplier" }), owedStrong,
  ]));
  box.append(field("Date paid", dateI));
  box.append(field("Amount paid (" + currency() + ")", amtI));
  box.append(field("Method", methodI));
  box.append(field("Note", noteI));

  const remainCell = el("strong");
  box.append(el("div", { class: "row between", style: "border-top:2px solid var(--border);padding-top:10px;margin-top:6px" }, [
    el("span", { class: "mini", text: "Remaining after this payment" }), remainCell,
  ]));

  function currentOwed() {
    const key = supI.value.trim().toLowerCase();
    const row = acc.rows.find((r) => r.supplier.toLowerCase() === key);
    let owed = row ? row.owed : 0;
    if (payment?.id && (payment.supplier || "").toLowerCase() === key) owed += Number(payment.amount) || 0;
    return round2(owed);
  }
  function recalc() {
    const owed = currentOwed();
    owedStrong.textContent = money(owed);
    const remain = round2(owed - (parseFloat(amtI.value) || 0));
    remainCell.textContent = money(remain);
    remainCell.className = remain > 0.5 ? "badge red" : "badge green";
  }
  supI.addEventListener("input", recalc);
  amtI.addEventListener("input", recalc);
  recalc();

  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        if (!supI.value.trim()) throw new Error("Choose a supplier.");
        if (!(parseFloat(amtI.value) > 0)) throw new Error("Enter a valid amount.");
        await rpc(A.supplierPaySave({ id: payment?.id, supplier: supI.value, date: dateI.value, amount: amtI.value, method: methodI.value, note: noteI.value }));
        toast("Payment recorded", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save payment"),
    el("button", { class: "btn secondary", onclick: () => { const o = currentOwed(); if (o > 0) { amtI.value = String(Math.round(o)); recalc(); } } }, "Pay full"),
    payment?.id ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this payment?")) { await rpc(A.supplierPayDelete(payment.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* ---- loans taken (borrowed money, repaid later — not income, not expense) ---- */
VIEWS.loans = async (main) => {
  main.innerHTML = "";
  main.append(pageHead("Loans", "Money you borrowed and still have to pay back (e.g. paid back when the monthly bills come in). Loans are NOT counted in profit & loss."));
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const [acc, rows] = await Promise.all([rpc(A.loanAccounts()), rpc(A.loansList({}))]);
    container.innerHTML = "";
    container.append(el("div", { class: "kpis" }, [
      kpi("Total borrowed", money(acc.total_taken)),
      kpi("Paid back", money(acc.total_repaid), "good"),
      kpi("Still to repay", money(acc.total_outstanding), acc.total_outstanding > 0.5 ? "bad" : "good"),
    ]));
    container.append(el("div", { class: "row", style: "margin:14px 0" }, [
      el("button", { class: "btn", onclick: () => loanModal({ kind: "taken" }, acc, load) }, "＋  Loan taken"),
      el("button", { class: "btn secondary", onclick: () => loanModal({ kind: "repaid" }, acc, load) }, "💵  Repay a loan"),
    ]));
    container.append(dataTable([
      { header: "Lender", render: (r) => el("strong", { text: r.lender }) },
      { header: "Borrowed", num: true, render: (r) => money(r.taken) },
      { header: "Paid back", num: true, render: (r) => money(r.repaid) },
      { header: "Balance", num: true, render: (r) => r.outstanding > 0.5
        ? el("span", { class: "badge red", text: money(r.outstanding) + " to repay" })
        : el("span", { class: "badge green", text: "Cleared" }) },
      { header: "Last entry", render: (r) => (r.last_date ? fmtDate(r.last_date) : "—") },
      { header: "", render: (r) => r.outstanding > 0.5
        ? el("button", { class: "btn sm secondary", onclick: (e) => { e.stopPropagation(); loanModal({ kind: "repaid", lender: r.lender }, acc, load); } }, "💵 Repay")
        : "" },
    ], acc.rows, { empty: "No loans recorded.", footer: (sh) => [
      { text: "Total" },
      { text: money(sh.reduce((a, r) => a + r.taken, 0)), num: true },
      { text: money(sh.reduce((a, r) => a + r.repaid, 0)), num: true },
      { text: money(sh.reduce((a, r) => a + r.outstanding, 0)) + " to repay", num: true },
      { text: "" }, { text: "" },
    ] }));

    container.append(el("h3", { text: "History", style: "margin:22px 0 8px;font-size:14px" }));
    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Lender", render: (r) => el("strong", { text: r.lender }) },
      { header: "Type", render: (r) => r.kind === "repaid"
        ? el("span", { class: "badge green", text: "Repaid" })
        : el("span", { class: "badge amber", text: "Borrowed" }) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.amount) }) },
      { header: "Note", key: "note" },
    ], rows, {
      onRowClick: (r) => loanModal(r, acc, load),
      search: ["date", "lender", "note"],
      searchPlaceholder: "Search loans…",
      footer: (sh) => {
        const tk = sh.filter((r) => r.kind !== "repaid").reduce((a, r) => a + r.amount, 0);
        const rp = sh.filter((r) => r.kind === "repaid").reduce((a, r) => a + r.amount, 0);
        return [{ text: "Total" }, { text: "" }, { text: "" },
          { text: `Borrowed ${money(tk)} · Repaid ${money(rp)}`, num: true }, { text: "" }];
      },
      empty: "Nothing yet.",
    }));
  }
  await load();
};

function loanModal(loan, acc, onDone) {
  const isRepay = loan.kind === "repaid";
  const box = el("div", { class: "modal", style: "width:440px" });
  const dl = el("datalist", { id: "loan-lender-list" });
  for (const r of acc.rows) dl.append(el("option", { value: r.lender }));
  const lenderI = input({ value: loan.lender || "", list: "loan-lender-list", placeholder: "Who gave the loan" });
  const dateI = input({ type: "date", value: loan.date || todayStr() });
  const amtI = input({ type: "number", min: "0", step: "1", value: loan.amount || "", placeholder: "amount" });
  const noteI = input({ value: loan.note || "", placeholder: "Optional" });
  const balStrong = el("strong");
  box.append(el("h2", { text: (loan.id ? "Edit — " : "") + (isRepay ? "Repay a loan" : "Loan taken") }));
  box.append(dl);
  box.append(field("Lender (who gave the money)", lenderI));
  box.append(el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin:6px 0 14px" }, [
    el("span", { class: "mini", text: "Currently still to repay to this lender" }), balStrong,
  ]));
  box.append(field("Date", dateI));
  box.append(field((isRepay ? "Amount paid back" : "Amount borrowed") + " (" + currency() + ")", amtI));
  box.append(field("Note", noteI));
  const recalc = () => {
    const row = acc.rows.find((r) => r.lender.toLowerCase() === lenderI.value.trim().toLowerCase());
    balStrong.textContent = money(row ? row.outstanding : 0);
  };
  lenderI.addEventListener("input", recalc);
  recalc();
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.loanSave({ id: loan.id, kind: loan.kind, lender: lenderI.value, date: dateI.value, amount: amtI.value, note: noteI.value }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    isRepay && !loan.id ? el("button", { class: "btn secondary", onclick: () => {
      const row = acc.rows.find((r) => r.lender.toLowerCase() === lenderI.value.trim().toLowerCase());
      if (row && row.outstanding > 0) amtI.value = String(Math.round(row.outstanding));
    } }, "Repay full") : null,
    loan.id ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this loan entry?")) { await rpc(A.loanDelete(loan.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* ------------------------------------------------------------------ */
/*  Staff & Salary — monthly salary due vs paid; paying = an expense    */
/* ------------------------------------------------------------------ */
VIEWS.staff = async (main) => {
  main.innerHTML = "";
  main.append(pageHead("Staff & Salary",
    "Each worker's monthly salary. Salary falls due every month; an ADVANCE taken during the month is kept separate and taken off the salary when you pay it. Everything paid is saved as a “salary” expense, so it is taken off profit."));
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const [acc, pays] = await Promise.all([rpc(A.staffAccounts()), rpc(A.salaryList())]);
    const M = acc.month_label;
    container.innerHTML = "";
    container.append(el("div", { class: "kpis" }, [
      kpi("Monthly salary bill", money(acc.total_monthly), "", "All active workers, per month"),
      kpi(`Advance given in ${M}`, money(acc.advance_month), "accent", "Will be taken off their salary"),
      kpi(`Total paid in ${M}`, money(acc.paid_month), "good", "Salary + advances — counted in expenses"),
      kpi("Salary still to pay", money(acc.total_owed), (acc.total_owed > 0.5 ? "bad" : "good") + " total", "After taking off advances"),
    ]));
    for (const t of acc.salary_to_set) {
      const w = acc.rows.find((r) => r.id === t.id);
      for (const ym of t.months) {
        container.append(el("div", { class: "inline-note warn row between", style: "margin-top:12px;align-items:center;gap:10px" }, [
          el("span", { text: `📅 Month end: set ${t.name}'s salary for ${monthLabel(ym)}.` }),
          el("button", { class: "btn sm", onclick: () => salaryMonthModal(w, null, load, ym) }, "Set salary"),
        ]));
      }
    }
    const anyActive = acc.rows.some((r) => r.active);
    container.append(el("div", { class: "row", style: "margin:14px 0" }, [
      el("button", { class: "btn", onclick: () => staffModal(null, load) }, "＋  Add worker"),
      anyActive ? el("button", { class: "btn secondary", onclick: () => salaryPayModal(acc, null, null, load, "salary") }, "💵  Pay salary") : null,
      anyActive ? el("button", { class: "btn secondary", onclick: () => salaryPayModal(acc, null, null, load, "advance") }, "🤝  Advance / money taken") : null,
    ]));
    container.append(dataTable([
      { header: "Worker", render: (r) => el("div", {}, [el("strong", { text: r.name + (r.active ? "" : " (left)") }), r.role ? el("div", { class: "mini", text: r.role }) : null]) },
      { header: "Monthly salary", num: true, render: (r) => r.variable ? el("span", { class: "badge blue", text: "Not fixed" })
        : r.monthly_salary > 0 ? money(r.monthly_salary) : el("span", { class: "badge amber", text: "not set" }) },
      { header: "Salary due so far", num: true, render: (r) => el("div", {}, [
        el("span", { text: money(r.due) }),
        el("div", { class: "mini", text: (r.opening_owed > 0.5 ? `${money(r.opening_owed)} from before + ` : "")
          + (r.variable ? `${r.months} month${r.months === 1 ? "" : "s"} entered` : `${r.months} × ${money(r.monthly_salary)}`) }),
      ]) },
      { header: "Advance / taken", num: true, render: (r) => r.advance > 0.5
        ? el("div", {}, [el("span", { class: "badge amber", text: "− " + money(r.advance) }), r.advance_month > 0.5 ? el("div", { class: "mini", text: `${money(r.advance_month)} in ${M}` }) : null])
        : "—" },
      { header: "Salary paid", num: true, render: (r) => r.salary_paid > 0.5 ? "− " + money(r.salary_paid) : "—" },
      { header: "To pay", num: true, render: (r) => r.owed > 0.5
        ? el("span", { class: "badge red", text: money(r.owed) })
        : r.owed < -0.5 ? el("span", { class: "badge amber", text: money(-r.owed) + " paid ahead" })
        : el("span", { class: "badge green", text: "Paid up" }) },
      { header: "Last paid", render: (r) => (r.last_paid ? fmtDate(r.last_paid) : "—") },
      { header: "", render: (r) => r.active
        ? el("div", { class: "row", style: "gap:6px;flex-wrap:nowrap" }, [
          r.variable ? el("button", { class: "btn sm", onclick: (e) => { e.stopPropagation(); salaryMonthModal(r, null, load); } }, "＋ Month's salary") : null,
          el("button", { class: "btn sm secondary", onclick: (e) => { e.stopPropagation(); salaryPayModal(acc, r.id, null, load, "salary"); } }, "💵 Pay"),
          el("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); salaryPayModal(acc, r.id, null, load, "advance"); } }, "🤝 Money taken"),
        ])
        : "" },
    ], acc.rows, {
      onRowClick: (r) => staffModal(r, load),
      empty: "No workers added yet — click “＋ Add worker”.",
      footer: (sh) => [
        { text: `${sh.length} worker${sh.length === 1 ? "" : "s"}` },
        { text: money(sh.filter((r) => r.active).reduce((a, r) => a + r.monthly_salary, 0)), num: true },
        { text: money(sh.reduce((a, r) => a + r.due, 0)), num: true },
        { text: "− " + money(sh.reduce((a, r) => a + r.advance, 0)), num: true },
        { text: "− " + money(sh.reduce((a, r) => a + r.salary_paid, 0)), num: true },
        { text: money(sh.reduce((a, r) => a + Math.max(0, r.owed), 0)) + " to pay", num: true },
        { text: "" }, { text: "" },
      ],
    }));

    const monthRows = acc.rows.filter((r) => r.variable).flatMap((r) => r.salary_months.map((m) => ({ ...m, worker: r })));
    if (acc.rows.some((r) => r.variable)) {
      container.append(el("h3", { text: "Salary earned each month (workers with salary not fixed)", style: "margin:22px 0 8px;font-size:14px" }));
      container.append(dataTable([
        { header: "Month", render: (m) => monthLabel(m.month) },
        { header: "Worker", render: (m) => el("strong", { text: m.worker.name }) },
        { header: "Salary for the month", num: true, render: (m) => el("strong", { text: money(m.amount) }) },
        { header: "Note", key: "note" },
      ], monthRows, {
        onRowClick: (m) => salaryMonthModal(m.worker, m, load),
        footer: (sh) => [{ text: `${sh.length} month${sh.length === 1 ? "" : "s"}` }, { text: "" }, { text: money(sh.reduce((a, m) => a + m.amount, 0)), num: true }, { text: "" }],
        empty: "No month entered yet — click “＋ Month's salary” next to the worker.",
      }));
    }

    container.append(el("h3", { text: "Payments to staff (salary & advances)", style: "margin:22px 0 8px;font-size:14px" }));
    container.append(dataTable([
      { header: "Paid on", render: (p) => fmtDate(p.paid_date || p.date) },
      { header: "Worker", render: (p) => el("strong", { text: p.staff_name || "—" }) },
      { header: "For month", render: (p) => monthLabel(p.date.slice(0, 7)) },
      { header: "Type", render: (p) => p.pay_kind === "advance"
        ? el("span", { class: "badge amber", text: "Advance / taken" })
        : el("span", { class: "badge green", text: "Salary" }) },
      { header: "Amount", num: true, render: (p) => el("strong", { text: money(p.amount) }) },
      { header: "Note", render: (p) => staffNote(p) },
    ], pays, {
      onRowClick: (p) => salaryPayModal(acc, p.staff_id, p, load, p.pay_kind === "advance" ? "advance" : "salary"),
      search: ["date", "staff_name", "notes"],
      searchPlaceholder: "Search payments…",
      footer: (sh) => {
        const adv = sh.filter((p) => p.pay_kind === "advance").reduce((a, p) => a + p.amount, 0);
        const sal = sh.filter((p) => p.pay_kind !== "advance").reduce((a, p) => a + p.amount, 0);
        return [{ text: `${sh.length} payment${sh.length === 1 ? "" : "s"}` }, { text: "" }, { text: "" }, { text: "" },
          { text: money(adv + sal), num: true }, { text: `Salary ${money(sal)} · Advance ${money(adv)}` }];
      },
      empty: "Nothing paid yet.",
    }));
  }
  await load();
};

function staffModal(s, onDone) {
  const box = el("div", { class: "modal", style: "width:440px" });
  const nameI = input({ value: s?.name || "", placeholder: "e.g. Nasir" });
  const roleI = input({ value: s?.role || "", placeholder: "e.g. delivery rider, helper (optional)" });
  const salI = input({ type: "number", min: "0", step: "100", value: s?.monthly_salary || "", placeholder: "per month" });
  const typeI = selectBox([
    { value: "fixed", label: "Fixed — same amount every month" },
    { value: "variable", label: "Not fixed — I enter the salary each month" },
  ], s?.salary_type || "fixed");
  const startI = input({ type: "date", value: s?.start_date || todayStr().slice(0, 8) + "01" });
  const openI = input({ type: "number", min: "0", step: "1", value: s?.opening_owed || "", placeholder: "0" });
  const activeI = input({ type: "checkbox" }); activeI.checked = s ? !!s.active : true;
  const noteI = input({ value: s?.note || "", placeholder: "Optional" });
  box.append(el("h2", { text: s ? "Edit worker — " + s.name : "Add worker" }));
  box.append(field("Name", nameI));
  box.append(field("Job", roleI));
  box.append(field("Salary type", typeI));
  const salF = field("Monthly salary (" + currency() + ")", salI);
  box.append(salF);
  const syncType = () => { salF.hidden = typeI.value === "variable"; };
  typeI.addEventListener("change", syncType); syncType();
  box.append(field("Salary counted from — due every month from this month", startI));
  box.append(field("Already owed from before this (" + currency() + ") — e.g. last month's unpaid salary", openI));
  box.append(el("label", { class: "row", style: "gap:8px;margin:6px 0" }, [activeI, "Still working (untick when they leave — salary stops falling due)"]));
  box.append(field("Note", noteI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.staffSave({ id: s?.id, name: nameI.value, role: roleI.value, monthly_salary: salI.value, salary_type: typeI.value, start_date: startI.value, opening_owed: openI.value,
          end_date: activeI.checked ? null : s?.end_date || null, active: activeI.checked, note: noteI.value }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, s ? "Save changes" : "Add worker"),
    s ? el("button", { class: "btn danger", onclick: async () => {
      if (!(await confirmBox(`Remove ${s.name}? If anything was paid to them they'll be marked as left instead, so the history stays.`))) return;
      const r = await rpc(A.staffDelete(s.id));
      toast(r === "deleted" ? "Removed" : "Marked as left", "ok"); close(); onDone && onDone();
    } }, "Remove") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

const monthLabel = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });

/** Not-fixed salary: enter what a worker earned for one month. */
function salaryMonthModal(worker, entry, onDone, presetMonth) {
  const box = el("div", { class: "modal", style: "width:440px" });
  const monthI = input({ type: "month", value: entry?.month || presetMonth || todayStr().slice(0, 7) });
  const amtI = input({ type: "number", min: "0", step: "1", value: entry?.amount || "", placeholder: "salary for this month" });
  const noteI = input({ value: entry?.note || "", placeholder: "Optional — e.g. 31 days, extra rounds" });
  box.append(el("h2", { text: (entry ? "Edit month's salary — " : "Month's salary — ") + worker.name }));
  box.append(el("p", { class: "mini", style: "margin:-4px 0 10px", text: "How much this worker earned for the month. It is added to “salary to pay”; advances and payments are taken off it." }));
  box.append(field("Month", monthI));
  const info = el("div", { style: "background:var(--surface-2);border-radius:8px;padding:8px 12px;margin:2px 0 12px" });
  box.append(info);
  box.append(field("Salary for the month (" + currency() + ")", amtI));
  box.append(field("Note", noteI));
  const resultS = el("strong");
  box.append(el("div", { class: "row between", style: "border-top:2px solid var(--border);padding-top:10px;margin-top:6px" }, [
    el("span", { class: "mini", text: "Salary still to pay after setting this" }), resultS,
  ]));
  // Owed WITHOUT this month's current entry, so the result is live.
  const curThis = () => { const m = worker.salary_months.find((x) => x.month === monthI.value); return m ? m.amount : 0; };
  let pays = [];
  const recalc = () => {
    const ym = monthI.value;
    const inMonth = pays.filter((p) => p.date.slice(0, 7) === ym);
    const adv = inMonth.filter((p) => p.pay_kind === "advance").reduce((a, p) => a + p.amount, 0);
    const sal = inMonth.filter((p) => p.pay_kind !== "advance").reduce((a, p) => a + p.amount, 0);
    const line = (l, v) => el("div", { class: "row between", style: "padding:2px 0" }, [el("span", { class: "mini", text: l }), el("strong", { text: v })]);
    info.innerHTML = "";
    info.append(
      line(`Money taken / advance in ${ym ? monthLabel(ym) : "this month"}`, money(adv)),
      line("Salary paid in that month", money(sal)),
      line("Salary still to pay right now (all months)", money(round2(worker.owed - curThis()))),
    );
    const after = round2(worker.owed - curThis() + (parseFloat(amtI.value) || 0));
    resultS.textContent = after < -0.5 ? money(-after) + " paid ahead" : money(after);
    resultS.className = after > 0.5 ? "badge red" : after < -0.5 ? "badge amber" : "badge green";
  };
  monthI.addEventListener("change", recalc); amtI.addEventListener("input", recalc); recalc();
  rpc(A.salaryList({ staffId: worker.id })).then((p) => { pays = p; recalc(); }).catch(() => {});
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        if (!(parseFloat(amtI.value) > 0)) throw new Error("Enter the salary amount.");
        await rpc(A.salaryMonthSave({ id: entry?.id, staff_id: worker.id, month: monthI.value, amount: amtI.value, note: noteI.value }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    entry ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this month's salary entry?")) { await rpc(A.salaryMonthDelete(entry.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/** The user's own note from a staff payment's notes ("Salary — Name · for Oct 2026 · paid 04-11-2026 · note"). */
const staffNote = (p) => (p.notes || "").replace(/^(Salary|Advance) — [^·]*(· )?/, "").replace(/^for [A-Za-z]+ \d{4}( · )?/, "").replace(/^paid \d{2}-\d{2}-\d{4}( · )?/, "");

/** Pay salary or give an advance (or edit one). payment = an expense row with staff_id. */
function salaryPayModal(acc, staffId, payment, onDone, kind = "salary") {
  const isAdv = kind === "advance";
  const workers = acc.rows.filter((r) => r.active || r.id === staffId);
  const box = el("div", { class: "modal", style: "width:460px" });
  const whoI = selectBox(workers.map((r) => ({ value: String(r.id), label: r.name })), String(staffId || workers[0]?.id || ""));
  const dateI = input({ type: "date", value: payment ? (payment.paid_date || payment.date) : todayStr() });
  // Month the salary is FOR — its expense counts in that month's profit. Early in a
  // month (up to the 15th) a salary payment is usually last month's salary.
  const prevYm = (() => { const x = new Date(todayStr().slice(0, 8) + "01T00:00:00"); x.setMonth(x.getMonth() - 1); return x.toLocaleDateString("en-CA").slice(0, 7); })();
  const forI = input({ type: "month", value: payment ? payment.date.slice(0, 7) : (!isAdv && Number(todayStr().slice(8)) <= 15 ? prevYm : todayStr().slice(0, 7)) });
  const amtI = input({ type: "number", min: "0", step: "1", value: payment?.amount || "", placeholder: isAdv ? "advance amount" : "amount paid" });
  const noteI = input({ value: payment ? staffNote(payment) : "", placeholder: isAdv ? "e.g. kept from collection, needed for home" : `e.g. ${acc.month_label} salary` });
  box.append(el("h2", { text: (payment ? "Edit — " : "") + (isAdv ? "Advance / money taken" : "Pay salary") }));
  if (isAdv) box.append(el("p", { class: "mini", style: "margin:-4px 0 10px", text: "Money the worker took before salary day — an advance, or cash they kept (e.g. from collections). It is kept separate and taken off their salary." }));
  box.append(field("Worker", whoI));
  const sheet = el("div", { style: "background:var(--surface-2);border-radius:8px;padding:8px 12px;margin:6px 0 14px" });
  box.append(sheet);
  box.append(field(isAdv ? "Date taken" : "Date paid", dateI));
  const forHint = el("div", { class: "mini", style: "margin:-6px 0 10px" });
  box.append(field(isAdv ? "Towards salary of month" : "Salary for month", forI));
  box.append(forHint);
  const syncFor = () => {
    const paidYm = (dateI.value || "").slice(0, 7);
    forHint.textContent = forI.value && paidYm && forI.value !== paidYm
      ? `Counted as a ${monthLabel(forI.value)} expense (paid on ${fmtDate(dateI.value)}) — it will not be in ${monthLabel(paidYm)}'s profit.`
      : `Counted as a ${forI.value ? monthLabel(forI.value) : ""} expense.`;
  };
  forI.addEventListener("change", syncFor); dateI.addEventListener("change", syncFor); syncFor();
  box.append(field((isAdv ? "Amount taken" : "Salary paid now") + " (" + currency() + ")", amtI));
  box.append(field("Note", noteI));
  const afterS = el("strong");
  box.append(el("div", { class: "row between", style: "border-top:2px solid var(--border);padding-top:10px;margin-top:6px" }, [
    el("span", { class: "mini", text: "Salary still to pay after this" }), afterS,
  ]));
  const worker = () => workers.find((r) => String(r.id) === whoI.value);
  // The worker's figures WITHOUT the payment being edited.
  const fig = () => {
    const w = worker(); if (!w) return null;
    const editAmt = payment ? Number(payment.amount) : 0;
    const editAdv = payment && payment.pay_kind === "advance";
    const adv = round2(w.advance - (editAdv ? editAmt : 0));
    const sal = round2(w.salary_paid - (payment && !editAdv ? editAmt : 0));
    return { w, due: w.due, adv, sal, toPay: round2(w.due - adv - sal) };
  };
  const line = (label, value, cls = "") => el("div", { class: "row between", style: "padding:3px 0" }, [el("span", { class: "mini", text: label }), el("strong", { class: cls, text: value })]);
  const recalc = () => {
    const f = fig(); sheet.innerHTML = "";
    if (!f) return;
    sheet.append(
      line("Salary due so far", money(f.due)),
      line("− Advance already taken", money(f.adv), f.adv > 0.5 ? "badge amber" : ""),
      line("− Salary already paid", money(f.sal)),
      el("div", { style: "border-top:1px solid var(--border);margin-top:4px" }, [line("= Salary to pay", money(f.toPay), f.toPay > 0.5 ? "badge red" : "badge green")]),
    );
    const after = round2(f.toPay - (parseFloat(amtI.value) || 0));
    afterS.textContent = after < -0.5 ? money(-after) + " paid ahead" : money(after);
    afterS.className = after > 0.5 ? "badge red" : after < -0.5 ? "badge amber" : "badge green";
  };
  whoI.addEventListener("change", recalc); amtI.addEventListener("input", recalc); recalc();
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.salarySave({ id: payment?.id, staff_id: Number(whoI.value), pay_kind: kind, date: dateI.value, for_month: forI.value, amount: amtI.value, note: noteI.value }));
        toast((isAdv ? "Advance" : "Salary") + " saved — added to expenses", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    !payment && !isAdv ? el("button", { class: "btn secondary", onclick: () => { const f = fig(); if (f && f.toPay > 0) { amtI.value = String(Math.round(f.toPay)); if (!noteI.value) noteI.value = "advance taken off"; recalc(); } } }, "Pay the balance") : null,
    payment ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this payment? (It is also removed from Expenses.)")) { await rpc(A.expenseDelete(payment.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/** Collapsible card. Remembers open/closed per key in localStorage. */
function collapsible(titleText, buildContent, key, defaultOpen = false) {
  let open = defaultOpen;
  try { const v = localStorage.getItem("wahga.collapse." + key); if (v !== null) open = v === "1"; } catch {}
  const det = el("details", { class: "card", style: "margin-bottom:14px" });
  det.open = open;
  const sum = el("summary", { style: "cursor:pointer;font-weight:600;font-size:15px;list-style:revert" }, titleText);
  det.append(sum);
  const body = el("div", { style: "margin-top:12px" });
  det.append(body);
  let built = false;
  function render() {
    if (built) return;
    built = true;
    const node = buildContent();
    if (node) body.append(node);
  }
  if (det.open) render();
  det.addEventListener("toggle", () => {
    try { localStorage.setItem("wahga.collapse." + key, det.open ? "1" : "0"); } catch {}
    if (det.open) render();
  });
  return det;
}

function segmented(options, value, onChange) {
  const wrap = el("div", { class: "row", style: "gap:6px" });
  let cur = value;
  const btns = options.map(([v, label]) => {
    const b = el("button", { class: "btn sm", onclick: () => { cur = v; paint(); onChange(v); } }, label);
    b.dataset.v = v;
    wrap.append(b);
    return b;
  });
  function paint() {
    for (const b of btns) b.className = "btn sm" + (b.dataset.v === String(cur) ? "" : " secondary");
  }
  paint();
  return wrap;
}

function purchaseSheetHtml(s) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  const L = (n) => (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const rows = s.rows.map((r) => `<tr>
    <td>${esc(fmtDate(r.date))}</td><td class="r">${L(r.purchased_litres)}</td>
    <td class="r">${r.avg_rate ? m(r.avg_rate) : "—"}</td><td class="r">${m(r.purchased_cost)}</td>
    <td class="r">${L(r.delivered_litres)}</td><td class="r">${L(r.difference_litres)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Milk Purchase Sheet ${esc(fmtDate(s.from))} — ${esc(fmtDate(s.to))}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">MILK PURCHASE SHEET</div>
      <div class="muted">${esc(fmtDate(s.from))} &nbsp;to&nbsp; ${esc(fmtDate(s.to))}</div>
      <div class="muted">${s.supplier && s.supplier !== "all" ? "Supplier: " + esc(s.supplier) : "All suppliers"}</div></div>
    </div>
    ${(s.by_supplier && s.by_supplier.length > 1) ? `<table style="margin-bottom:14px"><thead><tr><th>Supplier</th><th class="r">Litres</th><th class="r">Avg rate</th><th class="r">Cost</th></tr></thead><tbody>${s.by_supplier.map((r) => `<tr><td>${esc(r.supplier)}</td><td class="r">${L(r.litres)}</td><td class="r">${m(r.avg_rate)}</td><td class="r">${m(r.cost)}</td></tr>`).join("")}</tbody></table>` : ""}
    <table>
      <thead><tr><th>Date</th><th class="r">Purchased (L)</th><th class="r">Rate</th><th class="r">Cost</th><th class="r">Delivered (L)</th><th class="r">Diff (L)</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted c">Nothing recorded for this period</td></tr>`}</tbody>
      <tfoot><tr class="grand">
        <td>TOTAL</td><td class="r">${L(s.totals.purchased_litres)}</td><td class="r">${m(s.totals.avg_rate)}</td>
        <td class="r">${m(s.totals.purchased_cost)}</td><td class="r">${L(s.totals.delivered_litres)}</td><td class="r">${L(s.totals.difference_litres)}</td>
      </tr></tfoot>
    </table>
  </div></body></html>`;
}

/* ---- expenses ---- */
VIEWS.expenses = async (main) => {
  const state = { from: monthStartStr(), to: todayStr(), category: "all" };
  main.innerHTML = "";
  main.append(pageHead("Expenses", "Running costs — petrol, salaries, feed, and anything else."));
  const formCard = el("div", { class: "card" });
  const dateI = input({ type: "date", value: todayStr() });
  const catI = selectBox(META.expenseCategories, "petrol");
  const amtI = input({ type: "number", min: "0", step: "1", placeholder: "e.g. 1500" });
  const notesI = input({ placeholder: "Optional" });
  formCard.append(el("h2", { text: "Add an expense" }));
  formCard.append(el("div", { class: "form-grid", style: "margin-top:12px" }, [
    field("Date", dateI), field("Category", catI), field("Amount (" + currency() + ")", amtI), field("Notes", notesI),
  ]));
  formCard.append(el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
    try {
      await rpc(A.expenseSave({ date: dateI.value, category: catI.value, amount: amtI.value, notes: notesI.value }));
      toast("Expense added", "ok"); amtI.value = ""; notesI.value = ""; load();
    } catch (e) { toast(e.message, "err"); }
  } }, "Add expense"));
  main.append(formCard);

  const filterSel = selectBox([
    { value: "all", label: "All categories" },
    ...META.expenseCategories.map((c) => ({ value: c, label: titleCase(c) })),
    { value: "sample milk", label: "Sample milk" },
  ], "all");
  filterSel.addEventListener("change", () => { state.category = filterSel.value; load(); });
  const filterRow = el("div", { class: "row", style: "margin-top:18px" }, [
    dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; load(); }),
    field("Category", filterSel),
  ]);
  main.append(filterRow);
  const container = el("div", { style: "margin-top:12px" });
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const [real, samples] = await Promise.all([
      rpc(A.expensesList({ from: state.from, to: state.to, category: state.category })),
      rpc(A.homeMilkList({ from: state.from, to: state.to, kind: "sample" })),
    ]);
    const sampleRate = parseFloat(SETTINGS.sample_rate) || 205;
    container.innerHTML = "";

    // Sample milk — shown here for tracking, but it is NOT an expense: the milk
    // was already paid for as a purchase, so its cost is in the milk cost.
    const showSamples = state.category === "all" || state.category === "sample milk";
    const sam = showSamples ? samples.filter((s) => s.litres > 0).sort((a, b) => b.date.localeCompare(a.date)) : [];
    if (sam.length) {
      const totL = sam.reduce((a, s) => a + s.litres, 0);
      container.append(collapsible(
        `🧪 Sample milk given — ${litres(totL)} (tracking only, not an expense)`,
        () => {
          const wrap = el("div");
          wrap.append(el("div", { class: "sub", text: `This milk is already paid for in your purchases, so it does NOT reduce profit again. ≈ ${money(totL * sampleRate)} at ${money(sampleRate)}/L.` }));
          wrap.append(dataTable([
            { header: "Date", render: (r) => fmtDate(r.date) },
            { header: "Litres given free", num: true, render: (s) => litres(s.litres) },
            { header: "≈ Value", num: true, render: (s) => money(s.litres * sampleRate) },
            { header: "", render: (s) => el("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); sampleMilkModal(s.date, s.litres, load); } }, "edit") },
          ], sam, {
            onRowClick: (s) => sampleMilkModal(s.date, s.litres, load),
            footer: [{ text: `${sam.length} days` }, { text: litres(totL), num: true }, { text: money(totL * sampleRate), num: true }, { text: "" }],
            empty: "—",
          }));
          return wrap;
        },
        "expense-samples",
        false
      ));
    }

    container.append(dataTable([
      { header: "Date", render: (r) => fmtDate(r.date) },
      { header: "Category", render: (r) => el("span", { class: "badge gray", text: titleCase(r.category) }) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.amount) }) },
      { header: "Notes", key: "notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this expense?")) { await rpc(A.expenseDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], real, {
      onRowClick: (r) => expenseModal(r, load),
      search: ["date", "category", "notes"],
      searchPlaceholder: "Search by date, category or note…",
      footer: (shown) => [
        { text: "Total" }, { text: "" },
        { text: money(shown.reduce((a, r) => a + r.amount, 0)), num: true }, { text: "" }, { text: "" },
      ],
      empty: "No expenses for this period.",
    }));
  }
  await load();
};

function sampleMilkModal(date, litresVal, onDone) {
  const box = el("div", { class: "modal", style: "width:380px" });
  const dateI = input({ type: "date", value: date || todayStr() });
  const litI = input({ type: "number", min: "0", step: "0.25", value: litresVal ?? "", placeholder: "litres given free" });
  box.append(el("h2", { text: "Sample milk given" }));
  box.append(field("Date", dateI));
  box.append(field("Litres given free", litI));
  box.append(el("div", { class: "mini", text: "Valued at the sample rate in Settings (" + money(parseFloat(SETTINGS.sample_rate) || 205) + "/L) and counted as an expense." }));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.homeMilkSave({ date: dateI.value, kind: "sample", litres: litI.value }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

function expenseModal(expense, onDone) {
  const box = el("div", { class: "modal", style: "width:420px" });
  const dateI = input({ type: "date", value: expense?.date || todayStr() });
  const cats = [...META.expenseCategories];
  if (expense?.category && !cats.includes(expense.category)) cats.push(expense.category);
  const catI = selectBox(cats, expense?.category || "petrol");
  const amtI = input({ type: "number", min: "0", step: "1", value: expense?.amount ?? "", placeholder: "e.g. 1500" });
  const notesI = input({ value: expense?.notes || "", placeholder: "Optional" });
  box.append(el("h2", { text: expense ? "Edit expense" : "Add expense" }));
  box.append(field("Date", dateI));
  box.append(field("Category", catI));
  box.append(field("Amount (" + currency() + ")", amtI));
  box.append(field("Notes", notesI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.expenseSave({ id: expense?.id, date: dateI.value, category: catI.value, amount: amtI.value, notes: notesI.value }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    expense ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this expense?")) { await rpc(A.expenseDelete(expense.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
    } }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* ---- profit & loss ---- */
VIEWS.pl = async (main) => {
  const state = { from: monthStartStr(), to: todayStr() };
  main.innerHTML = "";
  main.append(pageHead("Profit & Loss", "Revenue, cost of milk, expenses and what's left."));
  main.append(dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; load(); }));
  const container = el("div", { style: "margin-top:16px" });
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const d = await rpc(A.profitLoss(state.from, state.to));
    container.innerHTML = "";
    container.append(el("div", { class: "kpis" }, [
      kpi("Revenue (milk billed)", money(d.revenue)),
      kpi(d.milkCostBasis === "recorded" ? "Cost of milk sold" : "Cost of milk sold (est.)", money(d.costMilkSold)),
      kpi("Margin on sales", money(d.marginOnSales), d.marginOnSales >= 0 ? "good" : "bad"),
      kpi("Expenses", money(d.totalExpenses), "bad"),
      kpi("Operating profit", money(d.operatingProfit), d.operatingProfit >= 0 ? "good" : "bad"),
      kpi("Litres sold / bought", litres(d.litresSold) + " / " + litres(d.litresBought)),
    ]));
    container.append(el("div", { class: "kpis", style: "margin-top:12px" }, [
      kpi("🥛 Total milk sold", litres(d.litresSold)),
      kpi("🏠 Home milk (GHAR)", litres(d.homeMilkLitres)),
      kpi("🧪 Samples", litres(d.sampleMilkLitres)),
      kpi("Total milk (sold + home + samples)", litres(d.litresSold + d.homeMilkLitres + d.sampleMilkLitres), "accent"),
      kpi("Milk bought", litres(d.litresBought)),
      kpi("Difference (bought − total)", litres(round2(d.litresBought - d.litresSold - d.homeMilkLitres - d.sampleMilkLitres))),
    ]));
    container.append(el("div", { class: "mini", style: "margin-top:6px" },
      "Difference = milk bought − (sold + home + samples). A plus figure is milk bought but not given to anyone (wastage / left over); a minus figure means more milk went out than was recorded as bought."));

    container.append(el("div", { class: "card", style: "margin-top:14px" }, [
      el("h2", { text: "Milk quantity" }),
      el("table", { class: "data", style: "margin-top:8px;max-width:520px" }, [
        el("tbody", {}, [
          el("tr", {}, [
            el("td", { text: "🥛 Total milk sold to clients (without home milk)" }),
            el("td", { class: "num" }, [el("strong", { text: litres(d.litresSold) })]),
          ]),
          el("tr", {}, [
            el("td", { text: "🏠 Home milk (GHAR)" }),
            el("td", { class: "num" }, [el("strong", { text: litres(d.homeMilkLitres) })]),
          ]),
          el("tr", {}, [
            el("td", { text: "🧪 Free samples given" }),
            el("td", { class: "num" }, [el("strong", { text: litres(d.sampleMilkLitres) })]),
          ]),
          el("tr", { style: "border-top:2px solid var(--border)" }, [
            el("td", { text: "Total milk incl. home & samples" }),
            el("td", { class: "num" }, [el("strong", { text: litres(d.litresSold + d.homeMilkLitres + d.sampleMilkLitres) })]),
          ]),
        ]),
      ]),
    ]));

    container.append(el("div", { class: "card", style: "margin-top:14px" }, [
      el("h2", { text: "Home milk (GHAR) & samples — kept separate" }),
      el("div", { class: "row", style: "gap:28px;margin-top:10px;flex-wrap:wrap" }, [
        el("div", {}, [
          el("div", { class: "mini", text: "🏠 Home use (GHAR)" }),
          el("strong", { text: `${litres(d.homeMilkLitres)}` }),
          el("div", { class: "mini", text: `worth ${money(d.homeMilkValue)} at ${money2(d.homeMilkRate)}/L ${d.homeRateFromSetting ? "(Settings price)" : "(avg selling price)"} — its cost is already inside the milk purchases` }),
        ]),
        el("div", {}, [
          el("div", { class: "mini", text: "🧪 Free samples given" }),
          el("strong", { text: `${litres(d.sampleMilkLitres)}` }),
          el("div", { class: "mini", text: `cost ${money(d.sampleMilkCost)} — already inside "Cost of milk sold" above · ${money(d.sampleMilkValue)} of sales given up` }),
        ]),
      ]),
      el("div", { class: "row between", style: "margin-top:14px;border-top:2px solid var(--border);padding-top:12px;flex-wrap:wrap;gap:12px" }, [
        el("div", { class: "mini", style: "max-width:58%" },
          "Sample and home (GHAR) milk both come out of the milk you bought — their cost is already in the milk cost, so nothing is deducted again. Home milk is shown here only for information, valued at the home-milk price."),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mini", text: "Operating profit + home milk value" }),
          el("strong", { class: d.totalBenefit >= 0 ? "badge green" : "badge red", style: "font-size:15px", text: money(d.totalBenefit) + "  total benefit" }),
        ]),
      ]),
    ]));
    container.append(el("div", { class: "card", style: "margin-top:14px" }, [
      el("h2", { text: "Milk purchased (all suppliers)" }),
      el("div", { class: "row", style: "gap:24px;margin-top:8px;flex-wrap:wrap" }, [
        el("div", {}, [el("div", { class: "mini", text: "Total milk purchased" }), el("strong", { text: litres(d.litresBought) })]),
        el("div", {}, [el("div", { class: "mini", text: "Total spent on milk" }), el("strong", { text: money(d.cogs) })]),
        el("div", {}, [el("div", { class: "mini", text: "Average rate" }), el("strong", { text: money2(d.avgPurchaseRate) + " / L" })]),
      ]),
      el("div", { class: "mini", style: "margin-top:10px" },
        (d.litresSold >= d.litresBought
          ? `Delivered ${litres(d.litresSold)} vs purchased ${litres(d.litresBought)} — a small gap usually means a purchase entry is missing. `
          : `Purchased ${litres(d.litresBought)}, delivered ${litres(d.litresSold)} — the rest is home use, samples, wastage or stock. `)
        + `Cost of milk = total spent on milk (${money(d.cogs)}).`
      ),
    ]));

    if (d.byCategory.length) {
      const max = Math.max(...d.byCategory.map((c) => c.amount));
      container.append(el("div", { class: "card", style: "margin-top:18px" }, [
        el("h2", { text: "Expenses by category" }),
        el("div", { class: "bar-chart", style: "margin-top:12px" }, d.byCategory.map((c) =>
          el("div", { class: "bar-row" }, [
            el("span", { text: titleCase(c.category) }),
            el("div", { class: "bar-track" }, [el("div", { class: "bar-fill", style: `width:${max ? (c.amount / max * 100) : 0}%` })]),
            el("strong", { text: money(c.amount) }),
          ])
        )),
      ]));
    }

    container.append(el("div", { class: "card", style: "margin-top:18px" }, [
      el("h2", { text: "Day by day (actual cash view)" }),
      el("div", { class: "sub", text: "Milk delivered vs actual milk purchased and expenses on each date." }),
      dataTable([
        { header: "Date", render: (r) => fmtDate(r.date) },
        { header: "Milk sold (L)", num: true, render: (r) => litres(r.litres) },
        { header: "Home milk (L)", num: true, render: (r) => litres(r.homeLitres) },
        { header: "Samples (L)", num: true, render: (r) => litres(r.sampleLitres) },
        { header: "Bought (L)", num: true, render: (r) => litres(r.boughtLitres) },
        { header: "Difference (L)", num: true, render: (r) => diffBadge(r.diffLitres) },
        { header: "Billed", num: true, render: (r) => money(r.revenue) },
        { header: "Milk bought", num: true, render: (r) => money(r.cogs) },
        { header: "Expenses", num: true, render: (r) => money(r.expenses) },
        { header: "Net", num: true, render: (r) => el("strong", { class: r.net >= 0 ? "" : "", text: money(r.net) }) },
      ], d.days, {
        footer: [
          { text: "Total" },
          { text: litres(d.litresSold), num: true },
          { text: litres(d.homeMilkLitres), num: true },
          { text: litres(d.sampleMilkLitres), num: true },
          { text: litres(d.litresBought), num: true },
          { text: litres(round2(d.litresBought - d.litresSold - d.homeMilkLitres - d.sampleMilkLitres)), num: true },
          { text: money(d.revenue), num: true },
          { text: money(d.cogs), num: true },
          { text: money(d.totalExpenses), num: true },
          { text: money(d.netProfit), num: true },
        ],
        empty: "No activity in this period.",
      }),
    ]));
  }
  await load();
};

/* ---- billing: invoices + statement + history ---- */
VIEWS.billing = async (main, params) => {
  const clients = await rpc(A.clientsList(true));
  main.innerHTML = "";
  main.append(pageHead("Invoices & Statements", "Bill any client for any period — a week, 10 days, a month — print or save a PDF for WhatsApp."));
  if (!clients.length) { main.append(el("div", { class: "card", text: "Add a client first." })); return; }

  const tab = { v: params.tab || "invoice" };
  const seg = segmented([["invoice", "New invoice"], ["batch", "Invoice everyone"], ["statement", "Statement"], ["history", "Invoice history"]], tab.v, (v) => { tab.v = v; render(); });
  seg.style.marginBottom = "16px";
  main.append(seg);
  const body = el("div");
  main.append(body);

  function render() {
    body.innerHTML = "";
    if (tab.v === "invoice") invoiceMaker(body, clients, params);
    else if (tab.v === "batch") invoiceBatchMaker(body, clients, params);
    else if (tab.v === "statement") statementMaker(body, clients, params);
    else invoiceHistory(body, clients);
  }
  render();
};

function periodPresetRow(state, onChange) {
  return el("div", { class: "row", style: "gap:6px;margin-top:6px" },
    PERIOD_PRESETS.map(([k, label]) => el("button", {
      class: "btn sm secondary",
      onclick: () => { const p = period(k); state.from = p.from; state.to = p.to; onChange(); },
    }, label))
  );
}

async function invoiceMaker(root, clients, params) {
  const state = {
    clientId: params.clientId || clients[0]?.id || "",
    ...period("thismonth"),
    note: "",
  };
  const picker = clientPicker(clients, state.clientId, (id) => { state.clientId = id; load(); });
  const fromI = input({ type: "date", value: state.from });
  const toI = input({ type: "date", value: state.to });
  const noteI = input({ placeholder: "Optional note on the invoice" });
  fromI.addEventListener("change", () => { state.from = fromI.value; load(); });
  toI.addEventListener("change", () => { state.to = toI.value; load(); });
  noteI.addEventListener("input", () => { state.note = noteI.value; });

  const controls = el("div", { class: "card" }, [
    el("div", { class: "row" }, [field("Client", picker.control), field("From", fromI), field("To", toI), field("Note", noteI)]),
    periodPresetRow(state, () => { fromI.value = state.from; toI.value = state.to; load(); }),
  ]);
  root.append(controls);
  const preview = el("div", { style: "margin-top:16px" });
  root.append(preview);

  async function load() {
    preview.innerHTML = "<div class='spin'>Building…</div>";
    const s = await rpc(A.invoicePreview(Number(state.clientId), state.from, state.to));
    const draft = toInvoiceShape(s, { invoice_no: (s.settings.invoice_prefix || "INV-") + "XXXX", issued_date: todayStr(), note: state.note });
    preview.innerHTML = "";
    preview.append(el("div", { class: "row between", style: "margin-bottom:12px" }, [
      el("div", { class: "mini", text: "Total due: " + money(s.closing_balance) }),
      el("div", { class: "row" }, [
        el("button", { class: "btn", onclick: issue }, "✓  Issue invoice"),
        el("button", { class: "btn secondary", onclick: () => rpc(A.printHtml(invoiceHtml(draft))).catch((e) => toast(e.message, "err")) }, "🖨  Print (without saving)"),
      ]),
    ]));
    preview.append(el("div", { class: "inline-note", text: "“Issue invoice” assigns a number, saves it to Invoice history, then lets you print / save the PDF." }));
    const frame = el("div", { class: "card", style: "padding:0;overflow:hidden;margin-top:12px" });
    frame.append(el("div", { html: invoiceHtml(draft, { embedded: true }) }));
    preview.append(frame);

    async function issue() {
      try {
        const inv = await rpc(A.invoiceCreate({ client_id: Number(state.clientId), from: state.from, to: state.to, note: state.note }));
        toast("Invoice " + inv.invoice_no + " issued", "ok");
        openInvoiceView(inv);
      } catch (e) { toast(e.message, "err"); }
    }
  }
  await load();
}

async function invoiceBatchMaker(root, clients, params) {
  const state = { ...period("thismonth"), note: "", cycle: "" };
  const cycleI = selectBox([{ value: "", label: "All clients" },
    { value: "10day", label: "10-day clients only" }, { value: "monthly", label: "Monthly clients only" }], "");
  cycleI.addEventListener("change", () => { state.cycle = cycleI.value; load(); });
  const fromI = input({ type: "date", value: state.from });
  const toI = input({ type: "date", value: state.to });
  const noteI = input({ placeholder: "Optional note on every invoice" });
  fromI.addEventListener("change", () => { state.from = fromI.value; load(); });
  toI.addEventListener("change", () => { state.to = toI.value; load(); });
  noteI.addEventListener("input", () => { state.note = noteI.value; });

  const setDates = () => { fromI.value = state.from; toI.value = state.to; load(); };
  root.append(el("div", { class: "card" }, [
    el("div", { class: "row" }, [field("Clients", cycleI), field("From", fromI), field("To", toI), field("Note", noteI)]),
    periodPresetRow(state, setDates),
    el("div", { class: "row", style: "gap:6px;margin-top:6px;align-items:center" }, [
      el("span", { class: "mini", text: "10-day bill for the month of “From”:" }),
      ...["1–10", "11–20", "21–end"].map((label, n) => el("button", {
        class: "btn sm secondary",
        onclick: () => { Object.assign(state, tenDayBlock(state.from, n)); state.cycle = "10day"; cycleI.value = "10day"; setDates(); },
      }, label)),
    ]),
  ]));
  root.append(el("div", { class: "inline-note", style: "margin-top:10px" },
    "Billing cycles: on the 10th, 20th and month-end use “10-day clients only” with the 1–10 / 11–20 / 21–end buttons. At month-end also pick “Monthly clients only” with “This month”. Set each client's cycle in Clients."));
  root.append(el("div", { class: "inline-note", style: "margin-top:10px" },
    "Previews one invoice per active client for the period above. Clients with no delivery or payment in the period start unticked. “Issue” assigns each a number, saves it to Invoice history, then lets you save or print them all together."));
  const out = el("div", { style: "margin-top:16px" });
  root.append(out);

  const picked = new Set();

  async function load() {
    out.innerHTML = "<div class='spin'>Building…</div>";
    let rows;
    try { rows = await rpc(A.invoicePreviewAll(state.from, state.to, state.cycle || undefined)); }
    catch (e) { out.innerHTML = ""; out.append(el("div", { class: "card", text: e.message })); return; }
    picked.clear();
    for (const r of rows) if (r.has_activity) picked.add(r.client_id);
    out.innerHTML = "";

    const summary = el("div", { class: "mini", style: "margin:2px 0 10px" });
    const issueBtn = el("button", { class: "btn" }, "");
    const summaryBelow = el("div", { class: "inline-note", style: "margin-top:10px;font-weight:600" });
    const selectAll = input({ type: "checkbox" });
    selectAll.checked = true;

    function refresh() {
      const sel = rows.filter((r) => picked.has(r.client_id));
      const tot = sel.reduce((a, r) => a + r.total_due, 0);
      summary.textContent = `${sel.length} of ${rows.length} clients selected · total due ${money(tot)}`;
      summaryBelow.textContent = `Ticked for invoicing: ${sel.length} clients · total due ${money(tot)}`;
      issueBtn.textContent = `✓  Issue ${sel.length} invoice${sel.length === 1 ? "" : "s"}`;
      issueBtn.disabled = !sel.length;
      selectAll.checked = sel.length === rows.length;
    }
    selectAll.addEventListener("change", () => {
      picked.clear();
      if (selectAll.checked) for (const r of rows) picked.add(r.client_id);
      buildTable(); refresh();
    });

    const tableWrap = el("div");
    function buildTable() {
      tableWrap.innerHTML = "";
      tableWrap.append(dataTable([
        {
          header: "", render: (r) => {
            const cb = input({ type: "checkbox" });
            cb.checked = picked.has(r.client_id);
            cb.addEventListener("change", () => { cb.checked ? picked.add(r.client_id) : picked.delete(r.client_id); refresh(); });
            return cb;
          },
        },
        { header: "Client", render: (r) => el("strong", { text: r.name }) },
        { header: "Billing", render: (r) => el("span", { class: r.billing_cycle === "10day" ? "badge blue" : "badge", text: cycleLabel(r.billing_cycle) }) },
        { header: "Litres", num: true, render: (r) => litres(r.period_litres) },
        { header: "Billed", num: true, render: (r) => money(r.period_billed) },
        { header: "Prev. balance", num: true, render: (r) => money(r.opening_balance) },
        { header: "Paid", num: true, render: (r) => money(r.period_paid) },
        { header: "Total due", num: true, render: (r) => el("strong", { text: money(r.total_due) }) },
      ], rows, {
        search: ["name"],
        searchPlaceholder: "Search client…",
        groupBy: "society",
        footer: (sh) => {
          const sum = (k) => sh.reduce((a, r) => a + (r[k] || 0), 0);
          return [
            { text: "" }, { text: `${sh.length} clients` }, { text: "" },
            { text: litres(round2(sum("period_litres"))), num: true },
            { text: money(sum("period_billed")), num: true },
            { text: money(sum("opening_balance")), num: true },
            { text: money(sum("period_paid")), num: true },
            { text: money(sum("total_due")), num: true },
          ];
        },
        empty: "No active clients.",
      }));
      tableWrap.append(summaryBelow);
    }
    buildTable();

    out.append(el("div", { class: "row between", style: "margin-bottom:8px;align-items:center" }, [
      el("label", { class: "row", style: "gap:6px;align-items:center;font-size:13px" }, [selectAll, el("span", { text: "Select all" })]),
      issueBtn,
    ]));
    out.append(summary);
    out.append(tableWrap);
    refresh();

    issueBtn.addEventListener("click", async () => {
      const ids = rows.filter((r) => picked.has(r.client_id)).map((r) => r.client_id);
      if (!ids.length) return;
      if (!(await confirmBox(`Issue ${ids.length} invoice${ids.length === 1 ? "" : "s"} for ${fmtDate(state.from)} – ${fmtDate(state.to)}? Each gets its own number and is saved to Invoice history.`))) return;
      issueBtn.disabled = true;
      try {
        const res = await rpc(A.invoiceCreateBulk({ from: state.from, to: state.to, note: state.note, clientIds: ids }));
        toast(`${res.count} invoice${res.count === 1 ? "" : "s"} issued`, "ok");
        openBatchResult(res);
        load();
      } catch (e) { toast(e.message, "err"); issueBtn.disabled = false; }
    });
  }
  await load();
}

async function batchInvoicesHtml(invoices) {
  const parts = [];
  for (const iv of invoices) {
    const full = await rpc(A.invoiceGet(iv.id));
    parts.push(invoiceHtml(full, { embedded: true }));
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoices</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff}
  .pg{page-break-after:always} .pg:last-child{page-break-after:auto}
  @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body>${parts.map((p) => `<div class="pg">${p}</div>`).join("")}</body></html>`;
}

function openBatchResult(res) {
  const box = el("div", { class: "modal", style: "width:640px" });
  box.append(el("div", { class: "row between", style: "margin-bottom:12px" }, [
    el("h2", { text: `${res.count} invoice${res.count === 1 ? "" : "s"} issued`, style: "margin:0" }),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn", onclick: async () => {
          try {
            // one PDF per client invoice, all in one folder
            toast("Preparing " + res.count + " invoices…");
            const docs = [];
            for (const iv of res.invoices) {
              const full = await rpc(A.invoiceGet(iv.id));
              docs.push({ html: invoiceHtml(full), name: `${(full.client.name || iv.name || "client").replace(/[^\w]+/g, "-")}-${full.invoice_no}` });
            }
            const first = res.invoices[0].invoice_no, last = res.invoices[res.invoices.length - 1].invoice_no;
            const r = await rpc(A.savePdfMany(docs, `Invoices ${first}${res.count > 1 ? " to " + last : ""}`));
            if (!r.canceled) toast(`Saved ${r.count} separate PDFs in: ${r.dir}`, "ok");
          } catch (e) { toast(e.message, "err"); }
        },
      }, "⬇  Save each invoice as separate PDF"),
      el("button", {
        class: "btn secondary", onclick: async () => {
          try { await rpc(A.printHtml(await batchInvoicesHtml(res.invoices))); }
          catch (e) { toast(e.message, "err"); }
        },
      }, "🖨  Print all"),
    ]),
  ]));
  const total = res.invoices.reduce((a, r) => a + r.total_due, 0);
  box.append(el("div", { class: "mini", style: "margin-bottom:8px" }, `Total billed: ${money(total)}`));
  const list = el("div", { class: "scroll-panel" });
  list.append(dataTable([
    { header: "Invoice", key: "invoice_no" },
    { header: "Client", render: (r) => r.name },
    { header: "Total due", num: true, render: (r) => money(r.total_due) },
    { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async () => openInvoiceView(await rpc(A.invoiceGet(r.id))) }, "Open") },
  ], res.invoices, { footer: (sh) => [
    { text: `${sh.length} invoices` }, { text: "Total" },
    { text: money(sh.reduce((a, r) => a + r.total_due, 0)), num: true }, { text: "" },
  ] }));
  box.append(list);
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [el("button", { class: "btn ghost", onclick: close }, "Close")]));
}

async function statementMaker(root, clients, params) {
  const state = {
    clientId: params.clientId || clients[0]?.id || "",
    ...period("thismonth"),
  };
  const picker = clientPicker(clients, state.clientId, (id) => { state.clientId = id; load(); });
  const fromI = input({ type: "date", value: state.from });
  const toI = input({ type: "date", value: state.to });
  fromI.addEventListener("change", () => { state.from = fromI.value; load(); });
  toI.addEventListener("change", () => { state.to = toI.value; load(); });

  root.append(el("div", { class: "card" }, [
    el("div", { class: "row" }, [field("Client", picker.control), field("From", fromI), field("To", toI)]),
    periodPresetRow(state, () => { fromI.value = state.from; toI.value = state.to; load(); }),
  ]));
  const preview = el("div", { style: "margin-top:16px" });
  root.append(preview);

  async function load() {
    preview.innerHTML = "<div class='spin'>Building…</div>";
    const s = await rpc(A.statement(Number(state.clientId), state.from, state.to));
    preview.innerHTML = "";
    preview.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      el("button", { class: "btn", onclick: () => rpc(A.printHtml(statementHtml(s))).catch((e) => toast(e.message, "err")) }, "🖨  Print"),
      el("button", { class: "btn secondary", onclick: async () => {
        const r = await rpc(A.savePdf(statementHtml(s), `${s.client.name.replace(/[^\w]+/g, "-")}-statement-${s.from}-to-${s.to}`));
        if (!r.canceled) toast("Saved: " + r.path, "ok");
      } }, "⬇  Save as PDF"),
    ]));
    const frame = el("div", { class: "card", style: "padding:0;overflow:hidden" });
    frame.append(el("div", { html: statementHtml(s, { embedded: true }) }));
    preview.append(frame);
  }
  await load();
}

async function invoiceHistory(root, clients) {
  const filterSel = selectBox([{ value: "", label: "All clients" }, ...clients.map((c) => ({ value: c.id, label: c.name }))], "");
  const state = { clientId: "" };
  filterSel.addEventListener("change", () => { state.clientId = filterSel.value; load(); });
  root.append(el("div", { class: "row", style: "margin-bottom:12px" }, [field("Client", filterSel)]));
  const container = el("div");
  root.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const rows = await rpc(A.invoicesList({ clientId: state.clientId || undefined }));
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Invoice", key: "invoice_no" },
      { header: "Client", key: "client_name" },
      { header: "Period", render: (r) => fmtDate(r.period_from) + " → " + fmtDate(r.period_to) },
      { header: "Issued", render: (r) => fmtDate(r.issued_date) },
      { header: "Total due", num: true, render: (r) => el("strong", { text: money(r.total_due) }) },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete invoice " + r.invoice_no + "? (Deliveries and payments are not affected.)")) { await rpc(A.invoiceDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], rows, {
      onRowClick: async (r) => openInvoiceView(await rpc(A.invoiceGet(r.id))),
      search: ["invoice_no", "client_name", "period_from", "period_to", "issued_date"],
      searchPlaceholder: "Search by invoice no, client or date…",
      footer: (sh) => [
        { text: `${sh.length} invoices` }, { text: "" }, { text: "" }, { text: "Total" },
        { text: money(sh.reduce((a, r) => a + r.total_due, 0)), num: true }, { text: "" },
      ],
      empty: "No invoices issued yet.",
    }));
  }
  await load();
}

function toInvoiceShape(s, extra) {
  return {
    invoice_no: extra.invoice_no,
    issued_date: extra.issued_date,
    period_from: s.from, period_to: s.to,
    previous_balance: s.opening_balance,
    period_litres: s.period_litres,
    period_billed: s.period_billed,
    period_paid: s.period_paid,
    total_due: s.closing_balance,
    note: extra.note || null,
    client: s.client, settings: s.settings,
    entries: s.entries, payments: s.payments, by_day: s.by_day,
  };
}

function openInvoiceView(inv) {
  const box = el("div", { class: "modal", style: "width:820px" });
  box.append(el("div", { class: "row between", style: "margin-bottom:12px" }, [
    el("h2", { text: "Invoice " + inv.invoice_no, style: "margin:0" }),
    el("div", { class: "row" }, [
      el("button", { class: "btn", onclick: () => rpc(A.printHtml(invoiceHtml(inv))).catch((e) => toast(e.message, "err")) }, "🖨  Print"),
      el("button", { class: "btn secondary", onclick: async () => {
        const r = await rpc(A.savePdf(invoiceHtml(inv), `${(inv.client.name || "client").replace(/[^\w]+/g, "-")}-${inv.invoice_no}`));
        if (!r.canceled) toast("Saved: " + r.path, "ok");
      } }, "⬇  Save PDF"),
      el("button", { class: "btn secondary", onclick: () => { closeV(); paymentModal(inv.client_id || inv.client.id, { amount: inv.total_due, note: inv.invoice_no }, () => toast("Payment recorded", "ok")); } }, "Mark paid"),
    ]),
  ]));
  const frame = el("div", { class: "card", style: "padding:0;overflow:hidden" });
  frame.append(el("div", { html: invoiceHtml(inv, { embedded: true }) }));
  box.append(frame);
  box.append(el("div", { class: "drawer-actions" }, [el("button", { class: "btn ghost", onclick: () => closeV() }, "Close")]));
  const closeV = openOverlay(box, { center: true });
}

function invoiceHtml(inv, { embedded = false } = {}) {
  const st = inv.settings || {};
  const cur = st.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const L = (n) => (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  // Clients who take more than one kind of milk (e.g. cow + buffalo for the same
  // house) get a litres column per kind and a "litres × rate" line per kind.
  const typeMap = new Map();
  for (const e of inv.entries || []) {
    const k = e.milk_category + "|" + e.price_per_litre;
    const t = typeMap.get(k) || { key: k, cat: e.milk_category, rate: e.price_per_litre, litres: 0, amount: 0, byDate: {} };
    t.litres += Number(e.quantity_litres) || 0;
    t.amount += Number(e.total_amount) || 0;
    t.byDate[e.date] = (t.byDate[e.date] || 0) + (Number(e.quantity_litres) || 0);
    typeMap.set(k, t);
  }
  const types = [...typeMap.values()].sort((a, b) => a.cat.localeCompare(b.cat) || a.rate - b.rate);
  const multi = types.length > 1;
  const catCount = (c) => types.filter((t) => t.cat === c).length;
  const typeName = (t) => titleCase(t.cat) + (catCount(t.cat) > 1 ? ` @ ${L(t.rate)}` : "");
  // Date | (Milk) | Litres | Rate | Amount — one row per day; a house taking
  // several kinds gets the kinds stacked inside that day's row.
  const span = multi ? 4 : 3;
  const headCells = (multi ? `<th>Milk</th>` : "") + `<th class="r">Litres</th><th class="r">Rate</th>`;
  const byDate = {};
  for (const e of inv.entries || []) (byDate[e.date] = byDate[e.date] || []).push(e);
  const stack = (arr) => arr.join("<br/>");
  const dayRows = (inv.by_day || []).map((d) => {
    const es = (byDate[d.date] || []).slice().sort((a, b) => a.milk_category.localeCompare(b.milk_category));
    if (!es.length) return `
    <tr><td>${esc(fmtDate(d.date))}</td>${multi ? "<td>—</td>" : ""}<td class="r">0</td><td class="r">—</td><td class="r">${m(0)}</td></tr>`;
    return `
    <tr><td>${esc(fmtDate(d.date))}</td>${multi ? `<td>${stack(es.map((e) => esc(titleCase(e.milk_category))))}</td>` : ""}<td class="r">${stack(es.map((e) => L(e.quantity_litres)))}</td><td class="r">${stack(es.map((e) => m(e.price_per_litre)))}</td><td class="r">${stack(es.map((e) => m(e.total_amount)))}</td></tr>`;
  }).join("");
  const typeLines = multi ? types.map((t) => `
    <tr><td colspan="${span}">${esc(typeName(t))} milk — ${L(t.litres)} L × ${m(t.rate)}</td><td class="r">${m(t.amount)}</td></tr>`).join("") : "";
  const payLine = inv.period_paid
    ? `<tr><td colspan="${span}">Payments received in this period</td><td class="r">− ${m(inv.period_paid)}</td></tr>` : "";
  const prevLine = inv.previous_balance
    ? `<tr><td colspan="${span}">Previous balance</td><td class="r">${m(inv.previous_balance)}</td></tr>` : "";

  const body = `
  <div class="sheet">
    <div class="hd">
      <div>
        <h1>${esc(st.shop_name || "Wahga Dairy Farm")}</h1>
        <div class="muted">${esc(st.shop_address || "")}</div>
        <div class="muted">${esc(st.shop_phone || "")}</div>
      </div>
      <div class="ttl">
        <div class="big">INVOICE</div>
        <div class="muted">${esc(inv.invoice_no)}</div>
        <div class="muted">Issued ${esc(fmtDate(inv.issued_date))}</div>
      </div>
    </div>
    <div class="to">
      <strong>Bill to: ${esc(inv.client.name)}</strong><br/>
      ${esc(inv.client.phone || "")}${inv.client.phone && inv.client.address ? " · " : ""}${esc(inv.client.address || "")}<br/>
      <span class="muted">Period: ${esc(fmtDate(inv.period_from))} to ${esc(fmtDate(inv.period_to))}</span>
    </div>
    <table>
      <thead><tr><th>Date</th>${headCells}<th class="r">Amount</th></tr></thead>
      <tbody>
        ${dayRows || `<tr><td colspan="${span + 1}" class="muted c">No deliveries in this period</td></tr>`}
      </tbody>
      <tfoot>
        ${typeLines}
        <tr><td colspan="${span}">Milk delivered this period (${L(inv.period_litres)} L)</td><td class="r">${m(inv.period_billed)}</td></tr>
        ${prevLine}
        ${payLine}
        <tr class="grand"><td colspan="${span}">TOTAL DUE</td><td class="r">${m(inv.total_due)}</td></tr>
      </tfoot>
    </table>
    ${inv.note ? `<p class="muted">${esc(inv.note)}</p>` : ""}
    ${paymentDetailsHtml(st)}
    <div class="ft muted">${esc(st.statement_footer || "")}</div>
  </div>`;

  if (embedded) return `<style>${STATEMENT_CSS}</style>${body}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.invoice_no)} — ${esc(inv.client.name)}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body>${body}</body></html>`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** "How to pay" box for statements / invoices. Only lines that are filled in
 *  Settings appear; if every payment field is blank, nothing is rendered. */
function paymentDetailsHtml(st = {}) {
  const rows = [
    ["Bank", st.pay_bank_name],
    ["Account title", st.pay_account_title],
    ["Account no. / IBAN", st.pay_account_no],
    ["Easypaisa / JazzCash", st.pay_wallet],
  ].filter(([, v]) => v && String(v).trim());
  const note = st.pay_note && String(st.pay_note).trim();
  if (!rows.length && !note) return "";
  return `<div class="pay">
    <div class="pay-h">How to pay</div>
    ${rows.map(([k, v]) => `<div><span class="muted">${esc(k)}:</span> ${esc(v)}</div>`).join("")}
    ${note ? `<div class="pay-note muted">${esc(note)}</div>` : ""}
  </div>`;
}

function statementHtml(s, { embedded = false } = {}) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const entryRows = s.entries.map((e) => `
    <tr><td>${esc(fmtDate(e.date))}</td><td>${titleCase(e.milk_category)}</td>
    <td class="r">${(Number(e.quantity_litres) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })}</td>
    <td class="r">${m(e.price_per_litre)}</td><td class="r">${m(e.total_amount)}</td></tr>`).join("");
  const payRows = s.payments.map((p) => `
    <tr><td>${esc(fmtDate(p.date))}</td><td colspan="3">Payment received${p.method ? " (" + esc(titleCase(p.method)) + ")" : ""}</td>
    <td class="r">− ${m(p.amount)}</td></tr>`).join("");

  const body = `
  <div class="sheet">
    <div class="hd">
      <div>
        <h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
        <div class="muted">${esc(s.settings.shop_address || "")}</div>
        <div class="muted">${esc(s.settings.shop_phone || "")}</div>
      </div>
      <div class="ttl">
        <div class="big">STATEMENT</div>
        <div class="muted">${esc(fmtDate(s.from))} &nbsp;to&nbsp; ${esc(fmtDate(s.to))}</div>
      </div>
    </div>
    <div class="to">
      <strong>${esc(s.client.name)}</strong><br/>
      ${esc(s.client.phone || "")}${s.client.phone && s.client.address ? " · " : ""}${esc(s.client.address || "")}
    </div>
    <table>
      <thead><tr><th>Date</th><th>Category</th><th class="r">Litres</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>
        <tr class="op"><td colspan="4">Previous balance brought forward</td><td class="r">${m(s.opening_balance)}</td></tr>
        ${entryRows || `<tr><td colspan="5" class="muted c">No deliveries in this period</td></tr>`}
        ${payRows}
      </tbody>
      <tfoot>
        <tr><td colspan="4">Milk delivered this period (${(Number(s.period_litres) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })} L)</td><td class="r">${m(s.period_billed)}</td></tr>
        <tr><td colspan="4">Payments received this period</td><td class="r">− ${m(s.period_paid)}</td></tr>
        <tr class="grand"><td colspan="4">TOTAL DUE</td><td class="r">${m(s.closing_balance)}</td></tr>
      </tfoot>
    </table>
    ${paymentDetailsHtml(s.settings)}
    <div class="ft muted">${esc(s.settings.statement_footer || "")}</div>
  </div>`;

  if (embedded) {
    return `<style>${STATEMENT_CSS}</style>${body}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement — ${esc(s.client.name)}</title>
  <style>${STATEMENT_CSS}
  body{margin:0;background:#fff}
  @media print{.sheet{box-shadow:none;margin:0}}
  </style></head><body>${body}</body></html>`;
}

const STATEMENT_CSS = `
  .sheet{max-width:760px;margin:18px auto;padding:34px;background:#fff;color:#0f172a;font-family:"Segoe UI",system-ui,sans-serif;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
  .sheet h1{margin:0 0 4px;font-size:20px;color:#15803d}
  .sheet .muted{color:#64748b;font-size:12px}
  .sheet .c{text-align:center}
  .sheet .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #15803d;padding-bottom:14px}
  .sheet .ttl{text-align:right}
  .sheet .ttl .big{font-size:18px;font-weight:800;letter-spacing:.08em;color:#15803d}
  .sheet .to{margin:16px 0;padding:10px 12px;background:#f0fdf4;border-radius:8px}
  .sheet table{width:100%;border-collapse:collapse;margin-top:6px}
  .sheet th,.sheet td{padding:7px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
  .sheet th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
  .sheet td.r,.sheet th.r{text-align:right;font-variant-numeric:tabular-nums}
  .sheet tr.op td{background:#fefce8}
  .sheet tfoot{display:table-row-group}
  .sheet tfoot tr{break-inside:avoid}
  .sheet tfoot td{border-bottom:0;padding-top:9px}
  .sheet tfoot tr.grand td{border-top:2px solid #15803d;font-weight:800;font-size:15px;color:#15803d}
  .sheet .ft{margin-top:22px;border-top:1px solid #e2e8f0;padding-top:10px;text-align:center}
  .sheet .pay{margin-top:18px;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;line-height:1.7}
  .sheet .pay .pay-h{font-weight:700;color:#15803d;margin-bottom:4px}
  .sheet .pay .pay-note{margin-top:4px}
`;

/* ---- settings ---- */
VIEWS.settings = async (main) => {
  const s = await rpc(A.settingsGet());
  const status = await rpc(A.dbStatus());
  main.innerHTML = "";
  main.append(pageHead("Settings", "Shop details for statements, and where the shared database lives."));

  const nameI = input({ value: s.shop_name || "" });
  const addrI = input({ value: s.shop_address || "" });
  const phoneI = input({ value: s.shop_phone || "" });
  const payBankI = input({ value: s.pay_bank_name || "" });
  const payTitleI = input({ value: s.pay_account_title || "" });
  const payAcctI = input({ value: s.pay_account_no || "" });
  const payWalletI = input({ value: s.pay_wallet || "" });
  const payNoteI = input({ value: s.pay_note || "" });
  const curI = input({ value: s.currency || "Rs", style: "width:90px" });
  const footI = input({ value: s.statement_footer || "" });
  const prefixI = input({ value: s.invoice_prefix || "INV-", style: "width:120px" });
  const nextNoI = input({ type: "number", min: "1", value: s.next_invoice_no || "1", style: "width:120px" });
  const sampleRateI = input({ type: "number", min: "0", step: "1", value: s.sample_rate || "205", style: "width:120px" });
  const homeRateI = input({ type: "number", min: "0", step: "1", value: s.home_milk_rate || "0", style: "width:120px" });

  const shopCard = el("div", { class: "card" }, [
    el("h2", { text: "Shop / farm details" }),
    el("div", { class: "sub", text: "Shown at the top of every printed statement and invoice." }),
    el("div", { class: "stack" }, [
      field("Name", nameI), field("Address", addrI), field("Phone", phoneI),
      field("Currency label", curI), field("Statement / invoice footer line", footI),
      el("div", { class: "row" }, [field("Invoice number prefix", prefixI), field("Next invoice number", nextNoI)]),
      el("div", { class: "row" }, [field("Sample milk value (" + currency() + " / litre) — for tracking; not deducted from profit", sampleRateI)]),
      el("div", { class: "row" }, [field("Home milk (GHAR) price (" + currency() + " / litre) — 0 = use average selling price", homeRateI)]),
    ]),
    el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
      try {
        SETTINGS = await rpc(A.settingsSave({
          shop_name: nameI.value, shop_address: addrI.value, shop_phone: phoneI.value,
          currency: curI.value || "Rs", statement_footer: footI.value,
          invoice_prefix: prefixI.value || "INV-",
          next_invoice_no: String(Math.max(1, parseInt(nextNoI.value, 10) || 1)),
          sample_rate: String(Math.max(0, parseFloat(sampleRateI.value) || 205)),
          home_milk_rate: String(Math.max(0, parseFloat(homeRateI.value) || 0)),
        }));
        toast("Saved", "ok");
      } catch (e) { toast(e.message, "err"); }
    } }, "Save details"),
  ]);
  main.append(shopCard);

  const payCard = el("div", { class: "card", style: "margin-top:18px" }, [
    el("h2", { text: "Payment details on invoices" }),
    el("div", { class: "sub", text: "Each field you fill appears in a “How to pay” box on every invoice and statement. Blank fields are hidden; leave them all blank and no box is shown." }),
    el("div", { class: "stack" }, [
      field("Bank name", payBankI),
      field("Account title", payTitleI),
      field("Account number / IBAN", payAcctI),
      field("Easypaisa / JazzCash number", payWalletI),
      field("Extra line (e.g. “Send a screenshot after payment”)", payNoteI),
    ]),
    el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
      try {
        SETTINGS = await rpc(A.settingsSave({
          pay_bank_name: payBankI.value, pay_account_title: payTitleI.value,
          pay_account_no: payAcctI.value, pay_wallet: payWalletI.value, pay_note: payNoteI.value,
        }));
        toast("Saved", "ok");
      } catch (e) { toast(e.message, "err"); }
    } }, "Save payment details"),
  ]);
  main.append(payCard);

  if (status.online) {
    const line = el("div", { class: "mini", style: "margin-top:8px" }, "Connected ✓");
    const check = el("button", { class: "btn secondary" }, "🔄  Check connection");
    check.onclick = async () => {
      check.disabled = true; line.textContent = "Checking…";
      try { await rpc(A.dbReload()); line.textContent = "Connected ✓ · checked at " + new Date().toLocaleTimeString(); toast("Online database is reachable", "ok"); }
      catch (e) { line.textContent = e.message; toast(e.message, "err"); }
      finally { check.disabled = false; }
    };
    main.append(el("div", { class: "card", style: "margin-top:18px" }, [
      el("h2", { text: "Database & sharing" }),
      el("div", { class: "inline-note", text: "🌐 Online database · " + status.serverUrl }),
      el("div", { class: "mini", style: "margin-top:6px", text: "✅ Live: every computer connected to this server sees the same data, and changes show up on the others within a few seconds. Saving needs internet." }),
      line,
      el("div", { class: "row", style: "margin-top:12px" }, [
        check,
        el("button", { class: "btn secondary", onclick: async () => {
          try { const r = await rpc(A.dbBackup()); if (!r.canceled) toast("Backup saved: " + r.path, "ok"); }
          catch (e) { toast(e.message, "err"); }
        } }, "💾  Download a backup copy"),
        el("button", { class: "btn ghost", onclick: () => onlineConnectModal(status.serverUrl) }, "🔑  Change server / password"),
        el("button", { class: "btn ghost", onclick: async () => {
          if (!(await confirmBox("Stop using the online database on this computer and go back to the local / Google Drive file? Anything saved online will NOT be in that file."))) return;
          try { await rpc(A.onlineDisconnect()); toast("Using the local database file again", "ok"); await boot(); }
          catch (e) { toast(e.message, "err"); }
        } }, "Use the local file instead"),
      ]),
    ]));
    main.append(el("div", { class: "mini", style: "margin-top:18px", text: "Wahga Dairy Farm · v" + (META.appVersion || "1.0.0") }));
    return;
  }

  const clouds = await rpc(A.dbCloudFolders()).catch(() => []);
  const inCloud = clouds.some((c) => (status.path || "").toLowerCase().startsWith(c.path.toLowerCase()));
  const syncLine = el("div", { class: "mini", style: "margin-top:8px" });
  async function refreshSync(ev) {
    const btn = ev && ev.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = "⏳  Checking…"; syncLine.textContent = "Checking for newer data…"; }
    try {
      const r = await rpc(A.dbReload());
      const when = r.mtime ? new Date(r.mtime).toLocaleString() : "unknown";
      syncLine.textContent = `Database last changed: ${when} · checked at ${new Date().toLocaleTimeString()}` + (r.reloaded ? " — loaded the newer copy." : " — you already have the latest data.");
      if (btn) {
        if (r.reloaded) {
          toast("Got the latest data from Google Drive", "ok");
          try { SETTINGS = await rpc(A.settingsGet()); } catch { /* keep old */ }
          return go("settings"); // redraw with the new data
        }
        toast("Already up to date", "ok");
      }
    } catch (e) {
      syncLine.textContent = e.message;
      if (btn) toast(e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🔄  Check for updates now"; }
    }
  }
  refreshSync();

  const dbCard = el("div", { class: "card", style: "margin-top:18px" }, [
    el("h2", { text: "Database & sharing" }),
    el("div", { class: "inline-note", text: status.path || "Not set" }),
    el("div", { class: "mini", style: "margin-top:6px" },
      inCloud
        ? "✅ This database is inside a synced cloud folder — it syncs to your other computer automatically."
        : "⚠️ This database is in a normal local folder — it does NOT sync anywhere. Move it into a cloud folder below to share with another computer."),
    syncLine,
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn secondary", onclick: refreshSync }, "🔄  Check for updates now"),
      el("button", { class: "btn secondary", onclick: async () => { try { await rpc(A.dbOpenFolder()); } catch (e) { toast(e.message, "err"); } } }, "📂  Show file in folder"),
      el("button", { class: "btn secondary", onclick: async () => {
        try { const r = await rpc(A.dbBackup()); if (!r.canceled) toast("Backup saved: " + r.path, "ok"); }
        catch (e) { toast(e.message, "err"); }
      } }, "💾  Save a backup copy"),
    ]),
  ]);
  if (!inCloud && clouds.length) {
    dbCard.append(el("div", { class: "row", style: "margin-top:10px" },
      clouds.map((c) => el("button", { class: "btn", onclick: async () => {
        if (!(await confirmBox(`Move this database (with ALL current data) into ${c.name} and use it from there? A “Wahga Dairy Farm” folder is created inside ${c.name}. Then on the other computer, install the app and open that same synced file.`))) return;
        try {
          const r = await rpc(A.dbMoveTo(c.path));
          toast("Moved to " + c.name + " — old copy left at " + r.from, "ok");
          go("settings");
        } catch (e) { toast(e.message, "err"); }
      } }, `☁️  Move to ${c.name}`))
    ));
    dbCard.append(el("div", { class: "mini", style: "margin-top:6px", text: "This copies your current database (all clients, deliveries, everything) into the cloud folder. Give the cloud drive a minute to finish uploading before opening the app on the other computer." }));
  }
  if (A.onlineConnect && !window.Capacitor) {
    dbCard.append(el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn", onclick: () => onlineConnectModal(status.serverUrl) }, "🌐  Switch to the online database"),
    ]));
  }
  dbCard.append(el("div", { class: "row", style: "margin-top:12px" }, [
    el("button", { class: "btn ghost", onclick: async () => {
      if (await confirmBox("Point this computer at a different database folder?")) pickFolder();
    } }, "Choose another folder" ),
    el("button", { class: "btn ghost", onclick: pickExisting }, "Open a different database file"),
  ]));
  dbCard.append(el("div", { class: "mini", style: "margin-top:12px", text: "Tip: to avoid clashes, let one person finish entering a day's round before another edits the same day. Your cloud drive keeps old versions as a safety net." }));
  main.append(dbCard);

  main.append(el("div", { class: "mini", style: "margin-top:18px", text: "Wahga Dairy Farm · v" + (META.appVersion || "1.0.0") }));
};

/* ------------------------------------------------------------------ */
/*  boot                                                               */
/* ------------------------------------------------------------------ */
async function boot() {
  const status = await rpc(A.dbStatus());
  if (!status.open) {
    if (status.onlineMode) return showSetup("online-error", null, { error: status.onlineError, serverUrl: status.serverUrl });
    const reason = status.configuredPath ? "folder-missing" : "not-configured";
    return showSetup(reason, status.configuredPath);
  }
  META = await rpc(A.meta());
  SETTINGS = await rpc(A.settingsGet());
  $("#sidebar").classList.remove("hidden");
  await refreshDbInfo();
  go("dashboard");
}

// remember that something was typed, so Refresh can warn before throwing it away
$("#main").addEventListener("input", () => { pageEdited = true; });

let externalChangeQueued = false;
A.onExternalChange(() => {
  if (externalChangeQueued) return;
  externalChangeQueued = true;
  toast("Data updated from another computer — refreshing…");
  setTimeout(() => {
    externalChangeQueued = false;
    if (currentView && VIEWS[currentView]) go(currentView);
  }, 600);
});

boot().catch((e) => {
  $("#main").innerHTML = "<pre style='color:red;padding:20px'>" + e.message + "</pre>";
});
