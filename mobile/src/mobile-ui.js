/* Wahga Dairy Farm — phone menu: ☰ opens the sidebar, picking a page closes it. */
(function () {
  "use strict";
  const body = document.body;
  const close = () => body.classList.remove("nav-open");
  document.getElementById("menuBtn").addEventListener("click", () => body.classList.toggle("nav-open"));
  document.getElementById("navshade").addEventListener("click", close);
  document.getElementById("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    close();
    document.querySelector("#mobilebar .title").textContent = b.textContent.trim();
    window.scrollTo(0, 0);
  });
  // 🔄 in the top bar: always in reach, however far down the page you scrolled
  const rb = document.getElementById("refreshBtn");
  rb.addEventListener("click", async () => {
    if (rb.disabled || typeof refreshPage !== "function" || !currentView) return; // connect screen: nothing to refresh
    rb.disabled = true; rb.textContent = "⏳";
    try { await refreshPage(); } finally { rb.disabled = false; rb.textContent = "🔄"; }
  });
  // Android back button: close the menu, then a dialog, then go to the
  // Dashboard; only exit the app from the Dashboard.
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App) App.addListener("backButton", () => {
    const ov = document.querySelectorAll("#overlay-root .overlay");
    if (body.classList.contains("nav-open")) close();
    else if (ov.length) ov[ov.length - 1].remove();
    else if (typeof currentView !== "undefined" && currentView !== "dashboard" && typeof go === "function") {
      document.querySelector("#mobilebar .title").textContent = "Dashboard";
      go("dashboard");
    } else App.exitApp();
  });

  /* ---------- Google Drive ---------- */
  const S = window.WAHGA_SYNC;
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-PK", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
  const refreshView = () => { if (typeof currentView !== "undefined" && currentView && VIEWS[currentView] && !document.querySelector("#overlay-root .overlay")) go(currentView); };

  // sidebar line under the menu
  function paintDbInfo(st) {
    const box = document.getElementById("dbinfo");
    if (!box) return;
    box.innerHTML = "";
    box.append(el("div", { text: st.connected ? "Google Drive (shared data):" : "Data on this phone only" }));
    box.append(el("div", { style: "margin-top:2px", text: st.connected ? st.file : "Choose the Drive file in Settings" }));
    if (st.connected) box.append(el("div", { class: "sync", style: "margin-top:6px;display:block", text: st.dirty ? "⚠ Not saved to Drive yet" : "Synced " + when(st.lastSync) }));
  }
  // app.js calls refreshDbInfo() after boot — show the Drive status instead
  try { refreshDbInfo = async () => paintDbInfo(S.status()); } catch { /* not reassignable */ }
  S.onChange((st, kind) => {
    paintDbInfo(st);
    if (kind === "pulled") { toast("Latest data loaded from Google Drive", "ok"); refreshView(); }
  });

  // coming back to the app: get what others saved meanwhile
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.status().connected) S.pull().catch(() => {});
  });
  // every 2 minutes while the app is open
  setInterval(() => { if (!document.hidden && S.status().connected) S.pull().catch(() => {}); }, 120000);

  const WIFI_TIP = "Using mobile data? In the Google Drive app go to Settings → Data usage and turn OFF “Transfer files only over Wi-Fi”, otherwise changes wait for Wi-Fi before reaching the computers.";
  function driveCard() {
    const st = S.status();
    const card = el("div", { class: "card", style: "margin-bottom:16px" });
    card.append(el("h2", { text: "☁️ Google Drive — shared data" }));
    if (!st.connected) {
      card.append(el("p", { class: "sub", text: "Use the same data as the computers. Tap the button, choose “Drive” in the menu, open the “Wahga Dairy Farm” folder and pick wahga-dairy.db. This phone's own data is replaced by that file." }));
      card.append(el("button", { class: "btn", onclick: connect }, "📂  Choose wahga-dairy.db from Google Drive"));
      card.append(el("div", { class: "mini", style: "margin-top:8px", text: "Needs the Google Drive app on this phone, signed in to an account the folder is shared with (as Editor)." }));
      card.append(backupBtn());
      return card;
    }
    card.append(el("div", {}, [
      el("div", { text: "File: " + st.file + " (Google Drive)" }),
      el("div", { text: (st.dirty ? "⚠ Changes not saved to Drive yet · " : "") + "Last sync: " + when(st.lastSync), style: "margin-top:4px;color:var(--muted)" }),
    ]));
    card.append(el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn", onclick: syncNow }, "🔄  Sync now"),
      el("button", { class: "btn secondary", onclick: connect }, "Choose a different file"),
      el("button", { class: "btn ghost", onclick: disconnect }, "Disconnect"),
    ]));
    card.append(el("div", { class: "mini", style: "margin-top:10px", text: "📶 " + WIFI_TIP }));
    card.append(backupBtn());
    return card;
  }
  function backupBtn() {
    return el("div", { style: "margin-top:12px" }, [el("button", { class: "btn ghost", onclick: async () => {
      try { await rpc(A.dbBackup()); } catch (e) { toast(e.message, "err"); }
    } }, "💾  Save a backup copy")]);
  }
  async function syncNow() {
    try {
      if (S.status().dirty) await S.push();
      const changed = await S.pull();
      if (!changed) toast("Up to date with Google Drive", "ok");
      go("settings");
    } catch (e) { toast(e.message, "err"); }
  }
  async function disconnect() {
    if (!(await confirmBox("Stop using the Google Drive file on this phone? The app will show nothing until you connect again."))) return;
    S.disconnect();
    location.reload(); // back to the "connect" screen
  }

  // first start (or after Disconnect): nothing to show until the shared file is linked
  showSetup = function () {
    $("#sidebar").classList.add("hidden");
    document.querySelector("#mobilebar .title").textContent = "Wahga Dairy Farm";
    const main = $("#main");
    main.innerHTML = "";
    main.append(el("div", { class: "card", style: "max-width:520px;margin:24px auto" }, [
      el("h2", { text: "☁️ Connect to the shared data" }),
      el("p", { class: "sub", text: "This app works on the same data as the computers: the file wahga-dairy.db in Google Drive. Nothing is shown until you pick it." }),
      el("ol", { style: "padding-left:20px;line-height:1.7;margin:12px 0" }, [
        el("li", { text: "Tap the button below." }),
        el("li", { text: "In the file picker tap ☰ → Drive." }),
        el("li", { text: "Open “Shared with me” (or “My Drive”) → Wahga Dairy Farm → wahga-dairy.db." }),
      ]),
      el("button", { class: "btn", style: "width:100%", onclick: async () => {
        try {
          const info = await S.connect();
          if (!info) return; // picker closed
          toast("Connected — using the shared data from Google Drive", "ok");
          await boot();
        } catch (e) { toast(e.message, "err"); }
      } }, "📂  Choose wahga-dairy.db from Google Drive"),
      el("div", { class: "mini", style: "margin-top:12px", text: "Needs the Google Drive app on this phone, signed in to an account the “Wahga Dairy Farm” folder is shared with as Editor." }),
      el("div", { class: "mini", style: "margin-top:8px", text: "📶 " + WIFI_TIP }),
    ]));
  };
  // app.js may already have drawn the computer's setup screen before this file loaded
  if (!currentView) rpc(A.dbStatus()).then((st) => { if (!st.open) showSetup(); }).catch(() => {});
  async function connect() {
    try {
      const info = await S.connect();
      if (!info) return; // picker closed
      toast("Connected — using " + (info.name || "wahga-dairy.db") + " from Google Drive", "ok");
      go("settings");
    } catch (e) { toast(e.message, "err"); }
  }
  const _settings = VIEWS.settings;
  VIEWS.settings = async (main, params) => {
    await _settings(main, params);
    // the computer's "Database & sharing" card (folders, cloud warnings) means nothing on the phone
    for (const h of main.querySelectorAll(".card > h2")) if (h.textContent === "Database & sharing") h.parentElement.remove();
    const head = main.querySelector(".page-head");
    if (head) head.after(driveCard()); else main.prepend(driveCard());
  };
})();
