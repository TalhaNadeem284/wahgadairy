# Wahga Dairy Farm — offline desktop app

A single Windows desktop app for the milk-delivery business: daily deliveries at
per-client prices, client payments and balances, milk purchases, expenses,
profit & loss, and printable / PDF client statements to send on WhatsApp.

No internet, no Firebase, no logins. **One SQLite database file** that lives in a
**cloud-synced folder** (Google Drive / OneDrive / Dropbox) so two or three
computers can work off the same data.

## Stack
- Electron 33 + **sql.js** (SQLite compiled to WebAssembly — no native build tools needed).
- Plain HTML/CSS/JS renderer, no framework.
- `db.js` holds the schema and every query; the file is written atomically
  (temp + rename) after each change, and reloaded automatically whenever the
  cloud folder syncs in an edit made on another PC.

## First run
1. `npm install`
2. `npm start`
3. The app asks for a folder for the shared database. Pick a folder **inside your
   Google Drive / OneDrive / Dropbox** (e.g. `…/Google Drive/WahgaDairy`). It
   creates `wahga-dairy.db` there.
4. On the second computer: install the app, run it, and choose **"Open existing
   database file"** → point at the same `wahga-dairy.db` in the synced folder.

Settings → *Shared database* lets you see the path, show it in Explorer, save a
backup copy, or point this PC at a different folder/file later.

## Sharing between PCs — how it behaves
- Each app is fully offline. The cloud drive does the syncing of the `.db` file.
- The app reloads the database whenever it notices the file changed on disk, and
  before every save, so you normally see each other's entries within seconds.
- A `.lock` sidecar file guards saves on the same machine.
- **Caveat:** if two people hit *Save* on the same data within the few seconds it
  takes the cloud to sync, one edit can overwrite the other. In practice let one
  person finish a day's round before another edits the same day. Google Drive /
  OneDrive / Dropbox all keep file version history as a safety net.

## Screens
| Screen | Purpose |
|---|---|
| Dashboard | litres & revenue today, month revenue / expenses / net profit, outstanding to receive |
| Daily Entry | one row per active client for a chosen date — type litres, save the whole round at once |
| Clients | name, phone, price/litre, milk category, opening balance, running balance; per-client payments |
| Milk Entries | full delivery log, filter by date/client, edit or delete |
| Purchases | bulk milk bought from suppliers (your cost of goods) |
| Expenses | petrol, salary, feed, etc. with category filter |
| Profit & Loss | date range: revenue − milk cost − expenses, by-category breakdown, day-by-day table |
| Statements | pick a client + month → preview → Print or Save as PDF (for WhatsApp) |
| Settings | shop details for the statement header, database location, backup |

## Data model (SQLite)
`settings`, `clients`, `milk_entries` (one per client+date+category, price
snapshotted), `payments`, `purchases`, `expenses`. Client balance =
opening_balance + Σ milk_entries − Σ payments.

## Packaging a Windows build
```
npm run pack     # -> dist/Wahga Dairy Farm-win32-x64/   (portable folder, ~300 MB)
npm run dist     # -> dist/Wahga-Dairy-Farm-Setup-1.0.0.exe  (NSIS installer)
```
`npm run dist` (electron-builder) may need Developer Mode or admin the first time
(winCodeSign symlink extraction) — see the note in `inventory-app`'s README for
the workaround. `npm run pack` always works.
