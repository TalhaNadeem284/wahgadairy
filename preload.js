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

  paymentsList: (filter) => invoke("payments:list", filter),
  paymentSave: (p) => invoke("payments:save", p),
  paymentDelete: (id) => invoke("payments:delete", id),

  purchasesList: (filter) => invoke("purchases:list", filter),
  purchaseSave: (p) => invoke("purchases:save", p),
  purchaseDelete: (id) => invoke("purchases:delete", id),

  expensesList: (filter) => invoke("expenses:list", filter),
  expenseSave: (x) => invoke("expenses:save", x),
  expenseDelete: (id) => invoke("expenses:delete", id),

  profitLoss: (from, to) => invoke("reports:profitLoss", from, to),
  dashboard: () => invoke("reports:dashboard"),

  statement: (clientId, from, to) => invoke("statement:get", clientId, from, to),
  dailyMilkSheet: (from, to) => invoke("sheet:milk", from, to),

  invoicesList: (filter) => invoke("invoices:list", filter),
  invoicePreview: (clientId, from, to) => invoke("invoices:preview", clientId, from, to),
  invoiceCreate: (inv) => invoke("invoices:create", inv),
  invoiceGet: (id) => invoke("invoices:get", id),
  invoiceDelete: (id) => invoke("invoices:delete", id),

  printHtml: (html) => invoke("print:html", html),
  savePdf: (html, suggestedName) => invoke("print:pdf", html, suggestedName),
  // kept for existing callers
  statementPrint: (html) => invoke("print:html", html),
  statementPdf: (html, suggestedName) => invoke("print:pdf", html, suggestedName),
});
