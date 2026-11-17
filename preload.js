"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Every call returns { ok, data } | { ok:false, error }. The renderer's rpc()
 * helper unwraps that. NOTE: the renderer must not declare its own `api`.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  // database location / status
  dbStatus: () => invoke("db:status"),
  dbPick: () => invoke("db:pick"),
  dbPickExisting: () => invoke("db:pickExisting"),
  dbOpenFolder: () => invoke("db:openFolder"),
  dbBackup: () => invoke("db:backup"),
  dbCloudFolders: () => invoke("db:cloudFolders"),
  dbUseCloud: (cloudPath) => invoke("db:useCloud", cloudPath),
  dbOpenPath: (p) => invoke("db:openPath", p),
  dbMoveTo: (cloudPath) => invoke("db:moveTo", cloudPath),
  dbReload: () => invoke("db:reload"),
  onlineConnect: (url, password) => invoke("online:connect", url, password),
  onlineRetry: () => invoke("online:retry"),
  onlineDisconnect: () => invoke("online:disconnect"),
  onExternalChange: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("db:external-change", listener);
    return () => ipcRenderer.removeListener("db:external-change", listener);
  },

  settingsGet: () => invoke("settings:get"),
  settingsSave: (obj) => invoke("settings:save", obj),

  meta: () => invoke("meta:get"),

  clientsList: (includeInactive) => invoke("clients:list", includeInactive),
  clientGet: (id) => invoke("clients:get", id),
  clientSave: (c) => invoke("clients:save", c),
  clientDelete: (id) => invoke("clients:delete", id),

  entriesList: (filter) => invoke("entries:list", filter),
  entrySave: (e) => invoke("entries:save", e),
  entryDelete: (id) => invoke("entries:delete", id),
  dailyRound: (date) => invoke("entries:dailyRound", date),
  dailyRoundSave: (date, rows) => invoke("entries:dailyRoundSave", date, rows),
  milkPlan: (date) => invoke("plan:get", date),
  milkPlanSave: (date, rows, extra) => invoke("plan:save", date, rows, extra),
  milkPlanDelete: (date) => invoke("plan:delete", date),

  paymentsList: (filter) => invoke("payments:list", filter),
  paymentSave: (p) => invoke("payments:save", p),
  paymentDelete: (id) => invoke("payments:delete", id),
  settlements: (opts) => invoke("settlements:get", opts),

  purchasesList: (filter) => invoke("purchases:list", filter),
  purchaseSave: (p) => invoke("purchases:save", p),
  purchaseDelete: (id) => invoke("purchases:delete", id),
  purchaseSuppliers: () => invoke("purchases:suppliers"),
  purchaseCredit: () => invoke("purchases:credit"),
  supplierAccounts: (onlyOwing) => invoke("suppliers:accounts", onlyOwing),
  supplierPayList: (filter) => invoke("suppliers:payList", filter),
  supplierPaySave: (p) => invoke("suppliers:paySave", p),
  supplierPayDelete: (id) => invoke("suppliers:payDelete", id),
  loanAccounts: () => invoke("loans:accounts"),
  loansList: (filter) => invoke("loans:list", filter),
  loanSave: (l) => invoke("loans:save", l),
  loanDelete: (id) => invoke("loans:delete", id),
  staffAccounts: (opts) => invoke("staff:accounts", opts || {}),
  staffSave: (s) => invoke("staff:save", s),
  staffDelete: (id) => invoke("staff:delete", id),
  salaryList: (filter) => invoke("salary:list", filter || {}),
  salarySave: (p) => invoke("salary:save", p),
  salaryMonthSave: (m) => invoke("salary:monthSave", m),
  salaryMonthDelete: (id) => invoke("salary:monthDelete", id),

  homeMilkList: (filter) => invoke("homemilk:list", filter),
  homeMilkForDate: (date) => invoke("homemilk:forDate", date),
  homeMilkSave: (h) => invoke("homemilk:save", h),
  homeMilkDelete: (id) => invoke("homemilk:delete", id),

  expensesList: (filter) => invoke("expenses:list", filter),
  expenseSave: (x) => invoke("expenses:save", x),
  expenseDelete: (id) => invoke("expenses:delete", id),

  profitLoss: (from, to) => invoke("reports:profitLoss", from, to),
  dashboard: () => invoke("reports:dashboard"),

  statement: (clientId, from, to) => invoke("statement:get", clientId, from, to),
  dailyMilkSheet: (from, to, supplier) => invoke("sheet:milk", from, to, supplier),

  invoicesList: (filter) => invoke("invoices:list", filter),
  invoiceDues: (clientId) => invoke("invoices:dues", clientId),
  clientDueSplit: (clientId, excludePaymentId) => invoke("clients:dueSplit", clientId, excludePaymentId),
  invoicePreview: (clientId, from, to) => invoke("invoices:preview", clientId, from, to),
  invoicePreviewAll: (from, to, cycle) => invoke("invoices:previewAll", from, to, cycle),
  invoiceCreate: (inv) => invoke("invoices:create", inv),
  invoiceCreateBulk: (payload) => invoke("invoices:createBulk", payload),
  invoiceGet: (id) => invoke("invoices:get", id),
  invoiceDelete: (id) => invoke("invoices:delete", id),

  // morning milk — separate bulk-sale ledger
  morningBuyers: (includeInactive) => invoke("morning:buyers", includeInactive),
  morningBuyerGet: (id) => invoke("morning:buyerGet", id),
  morningBuyerSave: (b) => invoke("morning:buyerSave", b),
  morningBuyerDelete: (id) => invoke("morning:buyerDelete", id),
  morningSalesList: (filter) => invoke("morning:salesList", filter),
  morningSaleSave: (s) => invoke("morning:saleSave", s),
  morningSaleDelete: (id) => invoke("morning:saleDelete", id),
  morningPaymentsList: (filter) => invoke("morning:paymentsList", filter),
  morningPaymentSave: (p) => invoke("morning:paymentSave", p),
  morningPaymentDelete: (id) => invoke("morning:paymentDelete", id),
  morningSettlements: () => invoke("morning:settlements"),
  morningSheet: (from, to, buyerId) => invoke("morning:sheet", from, to, buyerId),

  printHtml: (html) => invoke("print:html", html),
  savePdf: (html, suggestedName) => invoke("print:pdf", html, suggestedName),
  savePdfMany: (docs, folderName) => invoke("print:pdfMany", docs, folderName),
  // kept for existing callers
  statementPrint: (html) => invoke("print:html", html),
  statementPdf: (html, suggestedName) => invoke("print:pdf", html, suggestedName),
});
