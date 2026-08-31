# Wahga Dairy Farm — install on a second laptop & share the data

## The installer

`dist\Wahga-Dairy-Farm-Setup-1.0.0.exe` — send this one file to your brother
(WhatsApp / Google Drive / USB). Double-click → choose where to install →
Install. Makes a desktop shortcut and a Start-menu entry.

Windows SmartScreen may say "unknown publisher" (the app isn't code-signed) —
click **More info → Run anyway**.

The installer already carries a copy of the current data (clients, deliveries,
purchases, expenses), so the app is usable the moment it opens.

---

## How the data works

- The data is one file: **`wahga-dairy.db`**.
- Each computer just remembers which `wahga-dairy.db` it uses. That path is in
  `C:\Users\<user>\AppData\Roaming\wahga-dairy-desktop\config.json` (written by
  the app — you never touch it).
- To share, that file has to sit in a **cloud-synced folder** (Google Drive,
  OneDrive or Dropbox) that reaches both laptops. The cloud app does all the
  uploading/downloading; this app just reads and writes the file and reloads it
  when it changes.

---

## Sharing — step by step

### 1. On YOUR laptop: move the database into the cloud

1. Make sure **Google Drive for Desktop** (or OneDrive) is installed and signed
   in — you should have a `Google Drive` / `OneDrive` folder under
   `C:\Users\<you>\`.
2. Open the app → **Settings → Database & sharing**.
3. If it says "⚠️ local folder", click **☁️ Move to Google Drive** (or OneDrive).
   The app copies the whole database into
   `…\Google Drive\Wahga Dairy Farm\wahga-dairy.db` and switches to it.
4. Wait a minute for the cloud app to finish uploading (green tick on the
   folder).

### 2. Give your brother access to that folder

- **Same account:** sign his Google Drive / OneDrive into the **same account** —
  the `Wahga Dairy Farm` folder appears on his PC automatically.
- **Or share it:** right-click the `Wahga Dairy Farm` folder → Share → add his
  email. On his PC he opens it and chooses **"Add shortcut to My Drive"** (Google)
  or **"Add to my files"** (OneDrive) so it syncs down locally.

### 3. On your brother's laptop

1. Install the app.
2. Launch it. If the shared folder has already synced down, the first screen
   shows **"☁️ Open the shared database from Google Drive"** — click it. Done.
3. If it's not there yet, wait for the cloud app to finish, then reopen — or use
   **"📂 Open an existing database file"** and browse to
   `C:\Users\<brother>\Google Drive\Wahga Dairy Farm\wahga-dairy.db`.

You now both see the same clients, deliveries, settlements and profit.

---

## Day to day

- Both apps work offline; the cloud app syncs the file in the background.
- When one of you saves, the other's app notices within a few seconds and
  refreshes. You can also hit **Settings → 🔄 Check for updates now**.
- **Don't both save the same thing at the same moment.** If two saves land
  inside the few seconds the cloud takes to sync, one can overwrite the other.
  Let one person finish a day's round before the other edits that day.
  Google Drive / OneDrive keep old versions of the file if you ever need them.
- **Settings → 💾 Save a backup copy** whenever you want an extra copy.

---

## If your brother just wants his OWN separate data

Install → on the first screen pick **"☁️ Put a new database in …"** or
**"Choose another folder"**. He gets his own copy (starting from the same
bundled data) and works independently.

---

## Rebuilding the installer later

```
npm run build:seed     # refresh the bundled data from this PC's current database
npm run dist            # -> dist\Wahga-Dairy-Farm-Setup-1.0.0.exe
```

## About "upload straight to a Google account" (no Google Drive app)

Doing that inside the app would need a Google API project plus Google's OAuth
verification (weeks, limited users) for very little gain. Google Drive for
Desktop already does exactly this — a folder that syncs both ways — for free,
which is why the app uses the folder approach.
