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
  { id: "entries", label: "Milk Entries", icon: "🥛" },
  { id: "purchases", label: "Purchases", icon: "🚚" },
  { id: "expenses", label: "Expenses", icon: "🧾" },
  { id: "pl", label: "Profit & Loss", icon: "📊" },
  { id: "statements", label: "Statements", icon: "📄" },
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
  main.append(pageHead("Dashboard", "Today at a glance, and this month so far."));
  main.append(el("div", { class: "kpis" }, [
    kpi("Litres delivered today", litres(d.today_litres)),
    kpi("Revenue today", money(d.today_revenue), "accent"),
    kpi("Revenue this month", money(d.month_revenue)),
    kpi("Expenses this month", money(d.month_expenses), "bad"),
    kpi("Net profit this month", money(d.month_net_profit), d.month_net_profit >= 0 ? "good" : "bad"),
    kpi("Outstanding (to receive)", money(d.receivable), d.receivable > 0 ? "bad" : "good"),
    kpi("Active clients", String(d.active_clients)),
  ]));
  main.append(el("div", { class: "card", style: "margin-top:18px" }, [
    el("h2", { text: "Quick actions" }),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn", onclick: () => go("daily") }, "📝  Enter today's round"),
      el("button", { class: "btn secondary", onclick: () => go("statements") }, "📄  Make a client statement"),
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
      quantity_litres: r.quantity_litres === "" ? "" : String(r.quantity_litres),
    }));

    const totalCell = el("strong", { text: money(0) });
    function recalc() {
      let sum = 0;
      for (const s of state) {
        const q = parseFloat(s.quantity_litres); const p = parseFloat(s.price_per_litre);
        if (q > 0 && p > 0) sum += q * p;
      }
      totalCell.textContent = money(sum);
    }

    const rowsUi = state.map((s) => {
      const qty = input({ type: "number", min: "0", step: "0.25", value: s.quantity_litres, placeholder: "—", style: "width:90px" });
      qty.addEventListener("input", () => { s.quantity_litres = qty.value; recalc(); });
      const cat = selectBox(META.milkCategories, s.milk_category, { style: "width:110px" });
      cat.addEventListener("change", () => { s.milk_category = cat.value; });
      const price = input({ type: "number", min: "0", step: "0.5", value: s.price_per_litre, style: "width:90px" });
      price.addEventListener("input", () => { s.price_per_litre = price.value; recalc(); });
      return { s, tr: [s.name, qty, cat, price] };
    });

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

    container.append(table);
    container.append(el("div", { class: "row between", style: "margin-top:16px" }, [
      el("div", { class: "mini" }, ["Round total: ", totalCell]),
      el("button", { class: "btn", onclick: save }, "💾  Save round"),
    ]));

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
      { header: currency() + " / litre", num: true, render: (c) => money(c.price_per_litre) },
      { header: "Balance", num: true, render: (c) => el("span", { class: c.balance > 0 ? "badge red" : "badge green", text: money(c.balance) }) },
      { header: "Status", render: (c) => el("span", { class: c.active ? "badge green" : "badge gray", text: c.active ? "Active" : "Inactive" }) },
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
  const openI = input({ type: "number", step: "1", value: f.opening_balance });
  const activeI = input({ type: "checkbox" }); activeI.checked = f.active;
  const noteI = el("textarea", { placeholder: "Optional" }, f.note);

  drawer.append(el("h2", { text: client ? "Edit client" : "Add client" }));
  drawer.append(field("Name", nameI));
  drawer.append(field("Phone", phoneI));
  drawer.append(field("Address", addrI));
  drawer.append(field("Price per litre (" + currency() + ")", priceI));
  drawer.append(field("Milk category", catI));
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
      el("button", { class: "btn sm secondary", onclick: () => paymentModal(client.id, null, refreshPayments) }, "＋ Record payment"),
    ]));
    const payBox = el("div", { style: "margin-top:10px" });
    drawer.append(payBox);
    drawer.append(el("button", { class: "btn secondary", style: "margin-top:14px", onclick: () => { close(); go("statements", { clientId: client.id }); } }, "📄  Open statement for this client"));
    async function refreshPayments() {
      const pays = await rpc(A.paymentsList({ clientId: client.id }));
      payBox.innerHTML = "";
      if (!pays.length) { payBox.append(el("div", { class: "mini", text: "No payments recorded." })); return; }
      payBox.append(dataTable([
        { header: "Date", key: "date" },
        { header: "Amount", num: true, render: (p) => money(p.amount) },
        { header: "Method", render: (p) => titleCase(p.method || "—") },
        { header: "", render: (p) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this payment?")) { await rpc(A.paymentDelete(p.id)); refreshPayments(); toast("Deleted", "ok"); } } }, "✕") },
      ], pays));
    }
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
        opening_balance: openI.value, active: activeI.checked, note: noteI.value,
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

function paymentModal(clientId, payment, onDone) {
  const box = el("div", { class: "modal", style: "width:420px" });
  const dateI = input({ type: "date", value: payment?.date || todayStr() });
  const amtI = input({ type: "number", min: "0", step: "1", value: payment?.amount || "", placeholder: "e.g. 5000" });
  const methodI = selectBox(META.paymentMethods, payment?.method || "cash");
  const noteI = input({ value: payment?.note || "", placeholder: "Optional" });
  box.append(el("h2", { text: payment ? "Edit payment" : "Record payment" }));
  box.append(field("Date", dateI));
  box.append(field("Amount (" + currency() + ")", amtI));
  box.append(field("Method", methodI));
  box.append(field("Note", noteI));
  const close = openOverlay(box, { center: true });
  box.append(el("div", { class: "drawer-actions" }, [
    el("button", { class: "btn", onclick: async () => {
      try {
        if (!(parseFloat(amtI.value) > 0)) throw new Error("Enter a valid amount.");
        await rpc(A.paymentSave({ id: payment?.id, client_id: clientId, date: dateI.value, amount: amtI.value, method: methodI.value, note: noteI.value }));
        toast("Payment saved", "ok"); close(); onDone && onDone();
      } catch (e) { toast(e.message, "err"); }
    } }, "Save"),
    el("button", { class: "btn ghost", onclick: close }, "Cancel"),
  ]));
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
  const state = { from: "", to: "" };
  main.innerHTML = "";
  main.append(pageHead("Purchases", "Bulk milk bought from suppliers — your cost of goods."));
  const formCard = el("div", { class: "card" });
  const dateI = input({ type: "date", value: todayStr() });
  const qtyI = input({ type: "number", min: "0", step: "1", placeholder: "e.g. 100" });
  const priceI = input({ type: "number", min: "0", step: "0.5", placeholder: "e.g. 180" });
  const notesI = input({ placeholder: "Optional" });
  const preview = el("strong", { text: money(0) });
  const recalc = () => { const q = parseFloat(qtyI.value), p = parseFloat(priceI.value); preview.textContent = money(q > 0 && p > 0 ? q * p : 0); };
  qtyI.addEventListener("input", recalc); priceI.addEventListener("input", recalc);
  formCard.append(el("h2", { text: "Record a purchase" }));
  formCard.append(el("div", { class: "form-grid", style: "margin-top:12px" }, [
    field("Date", dateI), field("Quantity (litres)", qtyI), field("Price / litre", priceI), field("Supplier notes", notesI),
    el("div", {}, [el("div", { class: "mini", text: "Total cost" }), el("div", { style: "font-size:18px" }, [preview])]),
  ]));
  formCard.append(el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
    try {
      await rpc(A.purchaseSave({ date: dateI.value, quantity_litres: qtyI.value, price_per_litre: priceI.value, supplier_notes: notesI.value }));
      toast("Purchase recorded", "ok"); qtyI.value = ""; priceI.value = ""; notesI.value = ""; recalc(); load();
    } catch (e) { toast(e.message, "err"); }
  } }, "Add purchase"));
  main.append(formCard);

  const filterRow = dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; load(); });
  filterRow.style.marginTop = "18px";
  main.append(filterRow);
  const container = el("div", { style: "margin-top:12px" });
  main.append(container);

  async function load() {
    container.innerHTML = "<div class='spin'>Loading…</div>";
    const rows = await rpc(A.purchasesList({ from: state.from || undefined, to: state.to || undefined }));
    const totC = rows.reduce((a, r) => a + r.total_cost, 0);
    const totL = rows.reduce((a, r) => a + r.quantity_litres, 0);
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Date", key: "date" },
      { header: "Litres", num: true, render: (r) => litres(r.quantity_litres) },
      { header: currency() + "/L", num: true, render: (r) => money(r.price_per_litre) },
      { header: "Total cost", num: true, render: (r) => el("strong", { text: money(r.total_cost) }) },
      { header: "Notes", key: "supplier_notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this purchase?")) { await rpc(A.purchaseDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], rows, {
      footer: [{ text: "Total" }, { text: litres(totL), num: true }, { text: "" }, { text: money(totC), num: true }, { text: "" }, { text: "" }],
      empty: "No purchases recorded.",
    }));
  }
  await load();
};

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

  const filterSel = selectBox([{ value: "all", label: "All categories" }, ...META.expenseCategories.map((c) => ({ value: c, label: titleCase(c) }))], "all");
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
    const rows = await rpc(A.expensesList({ from: state.from, to: state.to, category: state.category }));
    const tot = rows.reduce((a, r) => a + r.amount, 0);
    container.innerHTML = "";
    container.append(dataTable([
      { header: "Date", key: "date" },
      { header: "Category", render: (r) => el("span", { class: "badge gray", text: titleCase(r.category) }) },
      { header: "Amount", num: true, render: (r) => el("strong", { text: money(r.amount) }) },
      { header: "Notes", key: "notes" },
      { header: "", render: (r) => el("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete this expense?")) { await rpc(A.expenseDelete(r.id)); toast("Deleted", "ok"); load(); } } }, "✕") },
    ], rows, {
      footer: [{ text: "Total" }, { text: "" }, { text: money(tot), num: true }, { text: "" }, { text: "" }],
      empty: "No expenses for this period.",
    }));
  }
  await load();
};

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
      kpi("Revenue (milk sold)", money(d.revenue)),
      kpi("Cost of milk bought", money(d.cogs)),
      kpi("Gross profit", money(d.grossProfit), d.grossProfit >= 0 ? "good" : "bad"),
      kpi("Total expenses", money(d.totalExpenses), "bad"),
      kpi("Net profit", money(d.netProfit), d.netProfit >= 0 ? "good" : "bad"),
      kpi("Litres sold / bought", litres(d.litresSold) + "  /  " + litres(d.litresBought)),
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
      el("h2", { text: "Day by day" }),
      dataTable([
        { header: "Date", key: "date" },
        { header: "Revenue", num: true, render: (r) => money(r.revenue) },
        { header: "Milk cost", num: true, render: (r) => money(r.cogs) },
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

/* ---- statements ---- */
VIEWS.statements = async (main, params) => {
  const clients = await rpc(A.clientsList(true));
  const state = {
    clientId: params.clientId || clients[0]?.id || "",
    from: params.from || monthStartStr(),
    to: params.to || todayStr(),
  };
  main.innerHTML = "";
  main.append(pageHead("Client Statements", "Make a monthly bill to print or save as PDF and send on WhatsApp."));
  if (!clients.length) { main.append(el("div", { class: "card", text: "Add a client first." })); return; }

  const clientSel = selectBox(clients.map((c) => ({ value: c.id, label: c.name })), state.clientId);
  clientSel.addEventListener("change", () => { state.clientId = clientSel.value; load(); });
  main.append(el("div", { class: "row", style: "margin-bottom:14px" }, [
    field("Client", clientSel),
    dateRangeControls(state.from, state.to, (f, t) => { state.from = f; state.to = t; load(); }),
    el("button", { class: "btn secondary", onclick: () => setMonth(0) }, "This month"),
    el("button", { class: "btn secondary", onclick: () => setMonth(-1) }, "Last month"),
  ]));
  const preview = el("div");
  main.append(preview);

  function setMonth(offset) {
    const d = new Date();
    d.setMonth(d.getMonth() + offset, 1);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0");
    const last = new Date(y, d.getMonth() + 1, 0).getDate();
    go("statements", {
      clientId: state.clientId,
      from: `${y}-${m}-01`,
      to: `${y}-${m}-${String(last).padStart(2, "0")}`,
    });
  }

  async function load() {
    preview.innerHTML = "<div class='spin'>Building…</div>";
    const s = await rpc(A.statement(Number(state.clientId), state.from, state.to));
    preview.innerHTML = "";
    preview.append(el("div", { class: "row", style: "margin-bottom:12px" }, [
      el("button", { class: "btn", onclick: () => doPrint(s) }, "🖨  Print"),
      el("button", { class: "btn secondary", onclick: () => doPdf(s) }, "⬇  Save as PDF"),
    ]));
    const frame = el("div", { class: "card", style: "padding:0;overflow:hidden" });
    frame.append(el("div", { html: statementHtml(s, { embedded: true }) }));
    preview.append(frame);
  }
  await load();

  async function doPrint(s) {
    try { await rpc(A.statementPrint(statementHtml(s))); }
    catch (e) { toast(e.message, "err"); }
  }
  async function doPdf(s) {
    try {
      const name = `${s.client.name.replace(/[^\w]+/g, "-")}-${s.from}-to-${s.to}`;
      const r = await rpc(A.statementPdf(statementHtml(s), name));
      if (!r.canceled) toast("Saved: " + r.path, "ok");
    } catch (e) { toast(e.message, "err"); }
  }
};

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

  const shopCard = el("div", { class: "card" }, [
    el("h2", { text: "Shop / farm details" }),
    el("div", { class: "sub", text: "Shown at the top of every printed statement." }),
    el("div", { class: "stack" }, [
      field("Name", nameI), field("Address", addrI), field("Phone", phoneI),
      field("Currency label", curI), field("Statement footer line", footI),
    ]),
    el("button", { class: "btn", style: "margin-top:14px", onclick: async () => {
      try {
        SETTINGS = await rpc(A.settingsSave({
          shop_name: nameI.value, shop_address: addrI.value, shop_phone: phoneI.value,
          currency: curI.value || "Rs", statement_footer: footI.value,
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
