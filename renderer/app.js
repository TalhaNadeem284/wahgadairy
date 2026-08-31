"use strict";

/* window.api is exposed by preload. Never shadow it with a local `api`. */
const A = window.api;

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
  { id: "daily", label: "Daily Entry", icon: "📝" },
  { id: "clients", label: "Clients", icon: "👥" },
  { id: "settlements", label: "Settlements", icon: "💰" },
  { id: "entries", label: "Milk Entries", icon: "🥛" },
  { id: "purchases", label: "Purchases", icon: "🚚" },
  { id: "expenses", label: "Expenses", icon: "🧾" },
  { id: "pl", label: "Profit & Loss", icon: "📊" },
  { id: "billing", label: "Invoices & Statements", icon: "📄" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

let currentView = null;

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
    box.append(el("div", { text: "Shared database:" }));
    box.append(el("div", { text: s.path || "(not set)", style: "margin-top:2px" }));
    box.append(el("div", { class: "sync", text: "Auto-syncs via your cloud folder", style: "margin-top:6px" }));
  } catch { /* ignore */ }
}

async function go(view, params) {
  currentView = view;
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
function pageHead(title, sub, actions) {
  const head = el("div", { class: "page-head" });
  const rowTop = el("div", { class: "row between" }, [
    el("div", {}, [el("h1", { text: title }), sub ? el("p", { text: sub }) : null]),
  ]);
  if (actions) rowTop.append(el("div", { class: "row" }, actions));
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

function dataTable(columns, rows, { onRowClick, footer, empty = "Nothing here yet." } = {}) {
  const wrap = el("div", { class: "table-wrap" });
  if (!rows.length) { wrap.append(el("div", { class: "empty", text: empty })); return wrap; }
  const table = el("table", { class: "data" });
  const thead = el("thead");
  const htr = el("tr");
  for (const c of columns) htr.append(el("th", { class: c.num ? "num" : "", text: c.header }));
  thead.append(htr);
  const tbody = el("tbody");
  for (const r of rows) {
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
  table.append(thead, tbody);
  if (footer) {
    const tfoot = el("tfoot");
    const ftr = el("tr");
    for (const cell of footer) ftr.append(el("td", { class: cell.num ? "num" : "", text: cell.text }));
    tfoot.append(ftr);
    table.append(tfoot);
  }
  wrap.append(table);
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
async function showSetup(reason, dbPath) {
  $("#sidebar").classList.add("hidden");
  const main = $("#main");
  main.className = "center";
  main.innerHTML = "";
  const box = el("div", { class: "card setup-box" }, [
    el("div", { class: "logo-big", text: "🥛" }),
    el("h1", { text: "Wahga Dairy Farm", style: "margin:0 0 6px" }),
    el("p", {
      style: "color:var(--muted);margin:0 0 18px",
      text: reason === "folder-missing"
        ? "The shared database folder isn't available right now (" + (dbPath || "") + "). Make sure your cloud drive is running, then reopen — or choose the database again below."
        : "Put the database file in a folder that syncs across your computers (Google Drive, OneDrive or Dropbox). Every PC running this app should point at the same folder.",
    }),
    el("button", { class: "btn", onclick: pickFolder }, "📁  Choose shared folder (new database)"),
    el("button", { class: "btn secondary", onclick: pickExisting }, "Open existing database file"),
  ]);
  main.append(box);
}

async function pickFolder() {
  try {
    const r = await rpc(A.dbPick());
    if (r.canceled) return;
    toast("Database ready: " + r.path, "ok");
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
  main.append(pageHead("Dashboard", `Today at a glance, and ${monthName} so far (1–${d.today.slice(8)}).`));
  main.append(el("div", { class: "kpis" }, [
    kpi("Litres delivered today", litres(d.today_litres)),
    kpi("Revenue today (billed)", money(d.today_revenue), "accent"),
    kpi(`${monthName} revenue (billed)`, money(d.month_revenue)),
    kpi(`${monthName} cash collected`, money(d.month_collected), "good"),
    kpi(`${monthName} expenses`, money(d.month_expenses), "bad"),
    kpi(`${monthName} operating profit`, money(d.month_net_profit), d.month_net_profit >= 0 ? "good" : "bad"),
    kpi(`Home milk (GHAR) ${monthName}`, `${litres(d.month_home_milk_litres)} · ${money(d.month_home_milk_value)}`),
    kpi("Outstanding (to receive)", money(d.receivable), d.receivable > 0 ? "bad" : "good"),
    kpi("Active clients", String(d.active_clients)),
  ]));
  main.append(el("div", { class: "mini", style: "margin-top:8px" },
    "Home milk (GHAR) is your own use — its milk cost is taken out of the business and it's shown separately, valued at your selling price. Operating profit + home milk value = " + money(d.month_total_benefit) + " total benefit this month."
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
function kpi(label, value, tone = "") {
  return el("div", { class: "kpi " + tone }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: value }),
  ]);
}

/* ---- daily entry (the round) ---- */
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
      client_id: r.client_id, name: r.name,
      milk_category: r.milk_category,
      price_per_litre: r.price_per_litre,
      default_litres: Number(r.default_litres) || 0,
      quantity_litres: r.quantity_litres === "" ? "" : String(r.quantity_litres),
      hasEntry: !!r.entry_id,
    }));

    const totalCell = el("strong", { text: money(0) });
    const countCell = el("span", { class: "mini" });
    function recalc() {
      let sum = 0, n = 0;
      for (const s of state) {
        const q = parseFloat(s.quantity_litres); const p = parseFloat(s.price_per_litre);
        if (q > 0 && p > 0) { sum += q * p; n++; }
      }
      totalCell.textContent = money(sum);
      countCell.textContent = `${n} of ${state.length} clients`;
    }

    const rowsUi = state.map((s) => {
      const qty = input({ type: "number", min: "0", step: "0.25", value: s.quantity_litres, placeholder: s.default_litres ? "usual " + s.default_litres : "—", style: "width:90px" });
      qty.addEventListener("input", () => { s.quantity_litres = qty.value; recalc(); });
      const cat = selectBox(META.milkCategories, s.milk_category, { style: "width:110px" });
      cat.addEventListener("change", () => { s.milk_category = cat.value; });
      const price = input({ type: "number", min: "0", step: "0.5", value: s.price_per_litre, style: "width:90px" });
      price.addEventListener("input", () => { s.price_per_litre = price.value; recalc(); });
      return { s, qty, tr: [s.name, qty, cat, price] };
    });

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
      ],
      rowsUi.map((r) => ({ __ui: r })),
      {}
    );
    // dataTable rendered text only; rebuild body with our controls:
    const tbody = $("tbody", table);
    tbody.innerHTML = "";
    for (const r of rowsUi) {
      const tr = el("tr");
      tr.append(el("td", { text: r.tr[0] }));
      tr.append(el("td", { class: "num" }, r.tr[1]));
      tr.append(el("td", {}, r.tr[2]));
      tr.append(el("td", { class: "num" }, r.tr[3]));
      tbody.append(tr);
    }
    recalc();

    const anyDefaults = state.some((s) => s.default_litres > 0);
    container.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      anyDefaults ? el("button", { class: "btn secondary", onclick: () => { const n = fillUsual(true); toast(n ? `Filled ${n} clients with their usual amount` : "Nothing to fill", "ok"); } }, "⚡  Fill usual amounts") : null,
      anyDefaults ? el("button", { class: "btn secondary", onclick: () => { const n = fillUsual(false); toast(`Reset ${n} rows to usual amounts`, "ok"); } }, "↻  Reset all to usual") : null,
      el("button", { class: "btn secondary", onclick: fillYesterday }, "📋  Copy yesterday"),
    ]));
    if (!anyDefaults) {
      container.append(el("div", { class: "inline-note", style: "margin-bottom:12px", text: "Tip: set a client's “Usual litres / day” (open the client from Clients) and a “Fill usual amounts” button appears here — one click marks the whole standard round." }));
    }

    container.append(table);

    // Home use (GHAR) + free samples for this date
    const hm = await rpc(A.homeMilkForDate(date));
    const homeI = input({ type: "number", min: "0", step: "0.25", value: hm.home || "", placeholder: "0", style: "width:90px" });
    const sampI = input({ type: "number", min: "0", step: "0.25", value: hm.sample || "", placeholder: "0", style: "width:90px" });
    async function saveHome(kind, elm) {
      try { await rpc(A.homeMilkSave({ date, kind, litres: elm.value })); }
      catch (e) { toast(e.message, "err"); }
    }
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
      el("div", { class: "mini" }, ["Round total: ", totalCell, "  ·  ", countCell]),
      el("button", { class: "btn", onclick: save }, "💾  Save round"),
    ]));

    async function fillYesterday() {
      const y = iso(addDays(new Date(date + "T00:00:00"), -1));
      const prev = await rpc(A.dailyRound(y));
      const byId = new Map(prev.map((p) => [p.client_id, p]));
      let filled = 0;
      for (const r of rowsUi) {
        const p = byId.get(r.s.client_id);
        const q = p && p.quantity_litres !== "" ? Number(p.quantity_litres) : 0;
        if (q > 0) {
          r.s.quantity_litres = String(q);
          r.qty.value = String(q);
          if (p.price_per_litre) { r.s.price_per_litre = String(p.price_per_litre); }
          filled++;
        }
      }
      recalc();
      toast(filled ? `Copied ${filled} deliveries from ${y}` : `No deliveries recorded on ${y}`, filled ? "ok" : "err");
    }

    async function save() {
      try {
        const payload = state.map((s) => ({
          client_id: s.client_id,
          milk_category: s.milk_category,
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
      { header: currency() + " / litre", num: true, render: (c) => money(c.price_per_litre) },
      { header: "Balance", num: true, render: (c) => el("span", { class: c.balance > 0 ? "badge red" : "badge green", text: money(c.balance) }) },
      { header: "Status", render: (c) => el("span", { class: c.active ? "badge green" : "badge gray", text: c.active ? "Active" : "Inactive" }) },
      {
        header: "", render: (c) => el("button", {
          class: "btn sm secondary",
          onclick: (e) => { e.stopPropagation(); paymentModal(c.id, null, () => load()); },
        }, "💵 Receive"),
      },
    ], clients, { onRowClick: (c) => clientDrawer(c.id), empty: "No clients yet." }));
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
  drawer.append(field("Price per litre (" + currency() + ")", priceI));
  drawer.append(field("Milk category", catI));
  drawer.append(field("Usual litres / day — used by “Fill usual amounts” on Daily Entry", dailyI));
  drawer.append(field("Opening balance (" + currency() + ") — amount owed before you started using this app", openI));
  drawer.append(el("label", { class: "row", style: "gap:8px;margin:6px 0" }, [activeI, "Active (currently receiving deliveries)"]));
  drawer.append(field("Note", noteI));

  const close = openOverlay(drawer);
  drawer.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: save }, client ? "Save changes" : "Add client"),
    client ? el("button", { class: "btn danger", onclick: remove }, "Delete") : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));

  if (client) {
    drawer.append(el("hr", { style: "margin:20px 0;border:0;border-top:1px solid var(--border)" }));
    drawer.append(el("div", { class: "row between" }, [
      el("h2", { text: "Payments", style: "margin:0" }),
      el("button", { class: "btn sm secondary", onclick: () => paymentModal(client.id, null, reloadBalance) }, "＋ Record payment"),
    ]));
    const payBox = el("div", { style: "margin-top:10px" });
    drawer.append(payBox);
    drawer.append(el("div", { class: "row", style: "margin-top:14px" }, [
      el("button", { class: "btn secondary", onclick: () => { close(); go("billing", { tab: "invoice", clientId: client.id }); } }, "🧾  Invoice this client"),
      el("button", { class: "btn secondary", onclick: () => { close(); go("billing", { tab: "statement", clientId: client.id }); } }, "📄  Statement"),
    ]));
    async function refreshPayments() {
      const pays = await rpc(A.paymentsList({ clientId: client.id }));
      payBox.innerHTML = "";
      if (!pays.length) { payBox.append(el("div", { class: "mini", text: "No payments recorded." })); return; }
      payBox.append(dataTable([
        { header: "Date", key: "date" },
        { header: "Amount", num: true, render: (p) => money(p.amount) },
        { header: "Method", render: (p) => titleCase(p.method || "—") },
        { header: "", render: (p) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this payment?")) { await rpc(A.paymentDelete(p.id)); reloadBalance(); toast("Deleted", "ok"); } } }, "✕") },
      ], pays, { onRowClick: (p) => paymentModal(client.id, p, reloadBalance) }));
    }
    refreshPaymentsList = refreshPayments;
    refreshPayments();
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
        active: activeI.checked, note: noteI.value,
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

  const owedRow = el("div", { class: "row between", style: "background:var(--surface-2);border-radius:8px;padding:10px 12px;margin-bottom:14px" }, [
    el("span", { class: "mini", text: "Currently owes" }),
    el("strong", { class: baseBalance > 0 ? "" : "", text: money(baseBalance) }),
  ]);
  box.append(owedRow);

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
    baseBalance > 0 ? el("button", { class: "btn secondary", onclick: () => { amtI.value = String(Math.round(baseBalance)); recalc(); } }, "Pay full " + money(baseBalance)) : null,
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
}

/* ---- settlements (who owes what) ---- */
VIEWS.settlements = async (main) => {
  const opts = { hideSettled: true, sort: "pending" };
  main.innerHTML = "";
  main.append(pageHead("Settlements", "What each client has been billed, what they've paid, and what's still pending."));
  const bar = el("div", { class: "row", style: "margin-bottom:14px" });
  main.append(bar);
  const container = el("div");
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const s = await rpc(A.settlements({}));
    let rows = s.rows.slice();
    if (opts.hideSettled) rows = rows.filter((r) => r.pending > 0.5);
    if (opts.sort === "pending") rows.sort((a, b) => b.pending - a.pending);
    else rows.sort((a, b) => a.name.localeCompare(b.name));

    bar.innerHTML = "";
    const hide = input({ type: "checkbox" }); hide.checked = opts.hideSettled;
    hide.addEventListener("change", () => { opts.hideSettled = hide.checked; load(); });
    const sortSel = selectBox([{ value: "pending", label: "Most pending first" }, { value: "name", label: "By name" }], opts.sort);
    sortSel.addEventListener("change", () => { opts.sort = sortSel.value; load(); });
    bar.append(
      el("label", { class: "row", style: "gap:6px;font-size:12.5px;color:var(--muted)" }, [hide, "Hide fully settled"]),
      field("Sort", sortSel),
      el("div", { class: "grow" }),
      el("button", { class: "btn secondary", onclick: () => rpc(A.printHtml(settlementHtml(s))).catch((e) => toast(e.message, "err")) }, "🖨  Print"),
      el("button", { class: "btn secondary", onclick: async () => { const r = await rpc(A.savePdf(settlementHtml(s), `settlements-${s.generated}`)); if (!r.canceled) toast("Saved: " + r.path, "ok"); } }, "⬇  Save PDF"),
    );

    container.innerHTML = "";
    container.append(el("div", { class: "kpis", style: "margin-bottom:14px" }, [
      kpi("Total billed", money(s.totals.billed)),
      kpi("Total received", money(s.totals.received), "good"),
      kpi("Total pending", money(s.totals.pending), s.totals.pending > 0 ? "bad" : "good"),
      kpi("Clients with dues", String(s.rows.filter((r) => r.pending > 0.5).length)),
    ]));
    container.append(dataTable([
      { header: "Client", render: (r) => el("strong", { text: r.name }) },
      { header: "Phone", key: "phone" },
      { header: "Billed", num: true, render: (r) => money(r.billed) },
      { header: "Received", num: true, render: (r) => money(r.received) },
      { header: "Pending", num: true, render: (r) => el("span", { class: r.pending > 0.5 ? "badge red" : "badge green", text: money(r.pending) }) },
      { header: "Last paid", render: (r) => r.last_payment || "—" },
      { header: "", render: (r) => el("button", { class: "btn sm secondary", onclick: (e) => { e.stopPropagation(); paymentModal(r.id, null, load); } }, "💵 Receive") },
    ], rows, {
      onRowClick: (r) => clientDrawer(r.id),
      footer: [
        { text: `${rows.length} clients` }, { text: "" },
        { text: money(rows.reduce((a, r) => a + r.billed, 0)), num: true },
        { text: money(rows.reduce((a, r) => a + r.received, 0)), num: true },
        { text: money(rows.reduce((a, r) => a + r.pending, 0)), num: true },
        { text: "" }, { text: "" },
      ],
      empty: opts.hideSettled ? "Everyone is settled up 🎉" : "No clients yet.",
    }));
  }
  await load();
};

function settlementHtml(s) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  const rows = s.rows
    .filter((r) => r.pending > 0.5 || r.received > 0 || r.billed > 0)
    .sort((a, b) => b.pending - a.pending);
  const body = rows.map((r, i) => `<tr>
    <td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td>
    <td class="r">${m(r.billed)}</td><td class="r">${m(r.received)}</td>
    <td class="r"><strong>${m(r.pending)}</strong></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Settlements — ${esc(s.generated)}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">SETTLEMENTS</div><div class="muted">As of ${esc(s.generated)}</div></div>
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
    const totL = rows.reduce((a, r) => a + r.quantity_litres, 0);
    const totA = rows.reduce((a, r) => a + r.total_amount, 0);
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Date", key: "date" },
      { header: "Client", key: "client_name" },
      { header: "Category", render: (r) => titleCase(r.milk_category) },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.total_amount) }) },
    ], rows, {
      onRowClick: (r) => entryModal(r, load),
      footer: [{ text: "Total" }, { text: "" }, { text: "" }, { text: litres(totL), num: true }, { text: "" }, { text: money(totA), num: true }],
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
  const state = { from: "", to: "", sfrom: p0.from, sto: p0.to, supplier: "all", ssupplier: "all" };
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
    el("div", {}, [el("div", { class: "mini", text: "Total cost" }), el("div", { style: "font-size:18px" }, [preview])]),
  ]));
  formCard.append(el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
    try {
      await rpc(A.purchaseSave({
        date: dateI.value, supplier: supplierI.value, quantity_litres: qtyI.value,
        price_per_litre: priceI.value, supplier_notes: notesI.value,
      }));
      toast("Purchase recorded", "ok");
      qtyI.value = ""; priceI.value = ""; notesI.value = ""; recalc();
      suppliers = await rpc(A.purchaseSuppliers()); refreshSupplierOptions();
      render();
    } catch (e) { toast(e.message, "err"); }
  } }, "Add purchase"));
  main.append(formCard);

  // ---- section switch ----
  const sec = { v: "list" };
  const seg = segmented([["list", "All purchases"], ["sheet", "Daily purchase sheet"]], sec.v, (v) => { sec.v = v; render(); });
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
    if (sec.v === "list") {
      filterWrap.append(el("div", { class: "row" }, [
        dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; loadList(); }),
        supplierFilter(state.supplier, (v) => { state.supplier = v; loadList(); }),
      ]));
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

  async function loadList() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const rows = await rpc(A.purchasesList({ from: state.from || undefined, to: state.to || undefined, supplier: state.supplier }));
    const totC = rows.reduce((a, r) => a + r.total_cost, 0);
    const totL = rows.reduce((a, r) => a + r.quantity_litres, 0);
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Date", key: "date" },
      { header: "Supplier", render: (r) => el("strong", { text: r.supplier || "—" }) },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Total cost", num: true, render: (r) => el("strong", { text: money(r.total_cost) }) },
      { header: "Notes", key: "supplier_notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this purchase?")) { await rpc(A.purchaseDelete(r.id)); toast("Deleted", "ok"); loadList(); } } }, "✕") },
    ], rows, {
      onRowClick: (r) => purchaseModal(r, suppliers, async () => { suppliers = await rpc(A.purchaseSuppliers()); loadList(); }),
      footer: [{ text: "Total" }, { text: "" }, { text: litres(totL), num: true }, { text: "" }, { text: money(totC), num: true }, { text: "" }, { text: "" }],
      empty: "No purchases for this filter.",
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
        ], s.by_supplier, { empty: "—" }),
      ]));
    }
    container.append(dataTable([
      { header: "Date", key: "date" },
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
  box.append(el("h2", { text: purchase ? "Edit purchase" : "Add purchase" }));
  box.append(dl);
  box.append(field("Date", dateI));
  box.append(field("Supplier", supplierI));
  box.append(field("Quantity (litres)", qtyI));
  box.append(field("Price per litre (" + currency() + ")", priceI));
  box.append(field("Notes", notesI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        await rpc(A.purchaseSave({
          id: purchase?.id, date: dateI.value, supplier: supplierI.value,
          quantity_litres: qtyI.value, price_per_litre: priceI.value, supplier_notes: notesI.value,
        }));
        toast("Saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    purchase ? el("button", { class: "btn danger", onclick: async () => {
      if (await confirmBox("Delete this purchase?")) { await rpc(A.purchaseDelete(purchase.id)); toast("Deleted", "ok"); close(); onDone && onDone(); }
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
  for (const [v, label] of options) {
    wrap.append(el("button", {
      class: "btn sm " + (v === value ? "" : "secondary"),
      onclick: () => onChange(v),
    }, label));
  }
  return wrap;
}

function purchaseSheetHtml(s) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });
  const L = (n) => (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const rows = s.rows.map((r) => `<tr>
    <td>${esc(r.date)}</td><td class="r">${L(r.purchased_litres)}</td>
    <td class="r">${r.avg_rate ? m(r.avg_rate) : "—"}</td><td class="r">${m(r.purchased_cost)}</td>
    <td class="r">${L(r.delivered_litres)}</td><td class="r">${L(r.difference_litres)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Milk Purchase Sheet ${esc(s.from)} — ${esc(s.to)}</title>
  <style>${STATEMENT_CSS} body{margin:0;background:#fff} @media print{.sheet{box-shadow:none;margin:0}}</style></head>
  <body><div class="sheet">
    <div class="hd">
      <div><h1>${esc(s.settings.shop_name || "Wahga Dairy Farm")}</h1>
      <div class="muted">${esc(s.settings.shop_address || "")}</div></div>
      <div class="ttl"><div class="big">MILK PURCHASE SHEET</div>
      <div class="muted">${esc(s.from)} &nbsp;to&nbsp; ${esc(s.to)}</div>
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
    const tot = real.reduce((a, r) => a + r.amount, 0);
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
            { header: "Date", key: "date" },
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
      { header: "Date", key: "date" },
      { header: "Category", render: (r) => el("span", { class: "badge gray", text: titleCase(r.category) }) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.amount) }) },
      { header: "Notes", key: "notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this expense?")) { await rpc(A.expenseDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], real, {
      onRowClick: (r) => expenseModal(r, load),
      footer: [{ text: "Total" }, { text: "" }, { text: money(tot), num: true }, { text: "" }, { text: "" }],
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
      kpi("Cost of milk sold (est.)", money(d.costMilkSold)),
      kpi("Margin on sales", money(d.marginOnSales), d.marginOnSales >= 0 ? "good" : "bad"),
      kpi("Expenses", money(d.totalExpenses), "bad"),
      kpi("Operating profit", money(d.operatingProfit), d.operatingProfit >= 0 ? "good" : "bad"),
      kpi("Litres sold / bought", litres(d.litresSold) + " / " + litres(d.litresBought)),
    ]));

    container.append(el("div", { class: "card", style: "margin-top:14px" }, [
      el("h2", { text: "Home milk (GHAR) & samples — kept separate" }),
      el("div", { class: "row", style: "gap:28px;margin-top:10px;flex-wrap:wrap" }, [
        el("div", {}, [
          el("div", { class: "mini", text: "🏠 Home use (GHAR)" }),
          el("strong", { text: `${litres(d.homeMilkLitres)}` }),
          el("div", { class: "mini", text: `worth ${money(d.homeMilkValue)} at selling price · milk cost ${money(d.homeMilkCost)} taken out of the business` }),
        ]),
        el("div", {}, [
          el("div", { class: "mini", text: "🧪 Free samples given" }),
          el("strong", { text: `${litres(d.sampleMilkLitres)}` }),
          el("div", { class: "mini", text: `cost ${money(d.sampleMilkCost)} — already inside "Cost of milk sold" above · ${money(d.sampleMilkValue)} of sales given up` }),
        ]),
      ]),
      el("div", { class: "row between", style: "margin-top:14px;border-top:2px solid var(--border);padding-top:12px;flex-wrap:wrap;gap:12px" }, [
        el("div", { class: "mini", style: "max-width:58%" },
          "Sample milk is milk you already bought — its cost is in the milk cost, so it is NOT deducted again. Home milk (GHAR) is your own use: its milk cost is taken out of the business and it's shown here valued at what you'd have sold it for."),
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
        d.litresSold >= d.litresBought
          ? `Delivered ${litres(d.litresSold)} vs purchased ${litres(d.litresBought)} — a small gap usually means a purchase entry is missing. Cost of milk sold = total spent on milk (${money(d.cogs)}).`
          : `Purchased ${litres(d.litresBought)}, delivered ${litres(d.litresSold)} — the rest is home use, samples, wastage or stock. Cost of milk sold values the delivered litres at ${money2(d.avgPurchaseRate)}/L.`
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
        { header: "Date", key: "date" },
        { header: "Billed", num: true, render: (r) => money(r.revenue) },
        { header: "Milk bought", num: true, render: (r) => money(r.cogs) },
        { header: "Expenses", num: true, render: (r) => money(r.expenses) },
        { header: "Net", num: true, render: (r) => el("strong", { class: r.net >= 0 ? "" : "", text: money(r.net) }) },
      ], d.days, {
        footer: [
          { text: "Total" },
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
  const seg = segmented([["invoice", "New invoice"], ["statement", "Statement"], ["history", "Invoice history"]], tab.v, (v) => { tab.v = v; render(); });
  seg.style.marginBottom = "16px";
  main.append(seg);
  const body = el("div");
  main.append(body);

  function render() {
    body.innerHTML = "";
    if (tab.v === "invoice") invoiceMaker(body, clients, params);
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
  const clientSel = selectBox(clients.map((c) => ({ value: c.id, label: c.name })), state.clientId);
  const fromI = input({ type: "date", value: state.from });
  const toI = input({ type: "date", value: state.to });
  const noteI = input({ placeholder: "Optional note on the invoice" });
  clientSel.addEventListener("change", () => { state.clientId = clientSel.value; load(); });
  fromI.addEventListener("change", () => { state.from = fromI.value; load(); });
  toI.addEventListener("change", () => { state.to = toI.value; load(); });
  noteI.addEventListener("input", () => { state.note = noteI.value; });

  const controls = el("div", { class: "card" }, [
    el("div", { class: "row" }, [field("Client", clientSel), field("From", fromI), field("To", toI), field("Note", noteI)]),
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

async function statementMaker(root, clients, params) {
  const state = {
    clientId: params.clientId || clients[0]?.id || "",
    ...period("thismonth"),
  };
  const clientSel = selectBox(clients.map((c) => ({ value: c.id, label: c.name })), state.clientId);
  const fromI = input({ type: "date", value: state.from });
  const toI = input({ type: "date", value: state.to });
  clientSel.addEventListener("change", () => { state.clientId = clientSel.value; load(); });
  fromI.addEventListener("change", () => { state.from = fromI.value; load(); });
  toI.addEventListener("change", () => { state.to = toI.value; load(); });

  root.append(el("div", { class: "card" }, [
    el("div", { class: "row" }, [field("Client", clientSel), field("From", fromI), field("To", toI)]),
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
      { header: "Period", render: (r) => r.period_from + " → " + r.period_to },
      { header: "Issued", key: "issued_date" },
      { header: "Total due", num: true, render: (r) => el("strong", { text: money(r.total_due) }) },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete invoice " + r.invoice_no + "? (Deliveries and payments are not affected.)")) { await rpc(A.invoiceDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], rows, {
      onRowClick: async (r) => openInvoiceView(await rpc(A.invoiceGet(r.id))),
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
  const dayRows = (inv.by_day || []).map((d) => `
    <tr><td>${esc(d.date)}</td><td class="r">${L(d.litres)}</td><td class="r">${m(d.amount)}</td></tr>`).join("");
  const payLine = inv.period_paid
    ? `<tr><td colspan="2">Payments received in this period</td><td class="r">− ${m(inv.period_paid)}</td></tr>` : "";
  const prevLine = inv.previous_balance
    ? `<tr><td colspan="2">Previous balance</td><td class="r">${m(inv.previous_balance)}</td></tr>` : "";

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
        <div class="muted">Issued ${esc(inv.issued_date)}</div>
      </div>
    </div>
    <div class="to">
      <strong>Bill to: ${esc(inv.client.name)}</strong><br/>
      ${esc(inv.client.phone || "")}${inv.client.phone && inv.client.address ? " · " : ""}${esc(inv.client.address || "")}<br/>
      <span class="muted">Period: ${esc(inv.period_from)} to ${esc(inv.period_to)}</span>
    </div>
    <table>
      <thead><tr><th>Date</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead>
      <tbody>
        ${dayRows || `<tr><td colspan="3" class="muted c">No deliveries in this period</td></tr>`}
      </tbody>
      <tfoot>
        <tr><td colspan="2">Milk delivered this period (${L(inv.period_litres)} L)</td><td class="r">${m(inv.period_billed)}</td></tr>
        ${prevLine}
        ${payLine}
        <tr class="grand"><td colspan="2">TOTAL DUE</td><td class="r">${m(inv.total_due)}</td></tr>
      </tfoot>
    </table>
    ${inv.note ? `<p class="muted">${esc(inv.note)}</p>` : ""}
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

function statementHtml(s, { embedded = false } = {}) {
  const cur = s.settings.currency || "Rs";
  const m = (n) => cur + " " + (Number(n) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const entryRows = s.entries.map((e) => `
    <tr><td>${esc(e.date)}</td><td>${titleCase(e.milk_category)}</td>
    <td class="r">${(Number(e.quantity_litres) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })}</td>
    <td class="r">${m(e.price_per_litre)}</td><td class="r">${m(e.total_amount)}</td></tr>`).join("");
  const payRows = s.payments.map((p) => `
    <tr><td>${esc(p.date)}</td><td colspan="3">Payment received${p.method ? " (" + esc(titleCase(p.method)) + ")" : ""}</td>
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
        <div class="muted">${esc(s.from)} &nbsp;to&nbsp; ${esc(s.to)}</div>
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
  .sheet tfoot td{border-bottom:0;padding-top:9px}
  .sheet tfoot tr.grand td{border-top:2px solid #15803d;font-weight:800;font-size:15px;color:#15803d}
  .sheet .ft{margin-top:22px;border-top:1px solid #e2e8f0;padding-top:10px;text-align:center}
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
  const curI = input({ value: s.currency || "Rs", style: "width:90px" });
  const footI = input({ value: s.statement_footer || "" });
  const prefixI = input({ value: s.invoice_prefix || "INV-", style: "width:120px" });
  const nextNoI = input({ type: "number", min: "1", value: s.next_invoice_no || "1", style: "width:120px" });
  const sampleRateI = input({ type: "number", min: "0", step: "1", value: s.sample_rate || "205", style: "width:120px" });

  const shopCard = el("div", { class: "card" }, [
    el("h2", { text: "Shop / farm details" }),
    el("div", { class: "sub", text: "Shown at the top of every printed statement and invoice." }),
    el("div", { class: "stack" }, [
      field("Name", nameI), field("Address", addrI), field("Phone", phoneI),
      field("Currency label", curI), field("Statement / invoice footer line", footI),
      el("div", { class: "row" }, [field("Invoice number prefix", prefixI), field("Next invoice number", nextNoI)]),
      el("div", { class: "row" }, [field("Sample milk value (" + currency() + " / litre) — for tracking; not deducted from profit", sampleRateI)]),
    ]),
    el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
      try {
        SETTINGS = await rpc(A.settingsSave({
          shop_name: nameI.value, shop_address: addrI.value, shop_phone: phoneI.value,
          currency: curI.value || "Rs", statement_footer: footI.value,
          invoice_prefix: prefixI.value || "INV-",
          next_invoice_no: String(Math.max(1, parseInt(nextNoI.value, 10) || 1)),
          sample_rate: String(Math.max(0, parseFloat(sampleRateI.value) || 205)),
        }));
        toast("Saved", "ok");
      } catch (e) { toast(e.message, "err"); }
    } }, "Save details"),
  ]);
  main.append(shopCard);

  main.append(el("div", { class: "card", style: "margin-top:18px" }, [
    el("h2", { text: "Shared database" }),
    el("div", { class: "sub", text: "This file is what syncs between your computers. Keep it in a Google Drive / OneDrive / Dropbox folder." }),
    el("div", { class: "inline-note", text: status.path || "Not set" }),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn secondary", onclick: async () => { try { await rpc(A.dbOpenFolder()); } catch (e) { toast(e.message, "err"); } } }, "📂  Show file in folder"),
      el("button", { class: "btn secondary", onclick: async () => {
        try { const r = await rpc(A.dbBackup()); if (!r.canceled) toast("Backup saved: " + r.path, "ok"); }
        catch (e) { toast(e.message, "err"); }
      } }, "💾  Save a backup copy"),
      el("button", { class: "btn ghost", onclick: async () => {
        if (await confirmBox("Point this computer at a different database folder? The current data stays where it is.")) pickFolder();
      } }, "Change folder"),
      el("button", { class: "btn ghost", onclick: pickExisting }, "Open a different database file"),
    ]),
    el("div", { class: "mini", style: "margin-top:12px", text: "Tip: to avoid clashes, let one person finish entering a day's round before another opens the app to edit the same day." }),
  ]));

  main.append(el("div", { class: "mini", style: "margin-top:18px", text: "Wahga Dairy Farm · v" + (META.appVersion || "1.0.0") }));
};

/* ------------------------------------------------------------------ */
/*  boot                                                               */
/* ------------------------------------------------------------------ */
async function boot() {
  const status = await rpc(A.dbStatus());
  if (!status.open) {
    const reason = status.configuredPath ? "folder-missing" : "not-configured";
    return showSetup(reason, status.configuredPath);
  }
  META = await rpc(A.meta());
  SETTINGS = await rpc(A.settingsGet());
  $("#sidebar").classList.remove("hidden");
  await refreshDbInfo();
  go("dashboard");
}

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
