# Wahga Dairy Farm — installing on a second laptop & sharing the data

## The installer

`dist\Wahga-Dairy-Farm-Setup-1.0.0.exe` — send this file to your brother
(WhatsApp / Google Drive / USB). Double-click → Next → choose where to install
→ Install. It makes a desktop shortcut and a Start-menu entry.

Windows SmartScreen may say "unknown publisher" (the app isn't code-signed) —
click **More info → Run anyway**.

---

## Where the database lives

The app itself does NOT contain the data. The data is a single file:

    wahga-dairy.db

Right now on **your** laptop it is at:

    C:\Users\Musa Nadeem\Documents\haider\wahga-dairy.db

Each computer remembers which database file it uses in its own small settings
file (nothing important, just the path):

    C:\Users\<that user>\AppData\Roaming\wahga-dairy-desktop\config.json

You never edit that by hand — the app writes it when you pick a folder/file.

---

## Option A — Both laptops share the SAME data (recommended)

The database file must sit in a folder that syncs to both laptops
(OneDrive / Google Drive / Dropbox). Then each app just opens that file.

### 1. On YOUR laptop — move the database into a synced folder (one time)

1. **Close the Wahga Dairy Farm app.**
2. Make a folder inside your cloud drive, e.g.
   `C:\Users\Musa Nadeem\OneDrive\WahgaDairy`
3. **Copy** `wahga-dairy.db` from `Documents\haider` into that `WahgaDairy` folder.
4. Open the app → it may show the old location or the setup screen →
   **Settings → Shared database → "Open a different database file"** →
   pick `...\OneDrive\WahgaDairy\wahga-dairy.db`.
5. Check the app still shows all your clients / August data — it should.
6. Wait until OneDrive shows a green tick on the `WahgaDairy` folder
   (fully uploaded). You can now delete the old copy in `Documents\haider`.

### 2. Give your brother access to that folder

- **Easiest:** sign his laptop's OneDrive into the **same Microsoft account**
  you use — the `WahgaDairy` folder appears automatically.
- **Or share it:** in OneDrive (onedrive.com or the folder → *Share*), share
  `WahgaDairy` with his email, then on his laptop he opens the link and
  clicks **"Add shortcut to My files"** so it syncs down to
  `C:\Users\<brother>\OneDrive\WahgaDairy`.
- Google Drive / Dropbox work the same way — put `wahga-dairy.db` in a shared
  folder that syncs to both PCs.

### 3. On your brother's laptop

1. Install the app (above).
2. Launch it → the first screen asks for the database.
3. Click **"Open existing database file"** → browse to his synced copy:
   `C:\Users\<brother>\OneDrive\WahgaDairy\wahga-dairy.db`
4. Done — he sees the same clients, deliveries, settlements as you.

### How the sharing behaves

- Both apps work fully offline. The cloud drive quietly syncs the `.db` file.
- When one of you saves, the other's app notices within a few seconds and
  refreshes ("Data updated from another computer").
- **Don't both save the exact same thing at the exact same moment** — if two
  saves land inside the few seconds the cloud takes to sync, one can
  overwrite the other. In practice: let one person finish a day's round
  before the other edits the same day. OneDrive/Drive/Dropbox keep old
  versions of the file as a safety net.
- Settings → **"Save a backup copy"** any time to keep an extra copy.

---

## Option B — Your brother keeps his OWN separate data

If he just wants his own copy and does not need to see yours:

1. Install the app.
2. Launch → **"Choose shared folder (new database)"** → pick any folder →
   it creates a fresh empty `wahga-dairy.db` there.
3. He starts entering his own clients.

(You can still send him a one-off copy of your `wahga-dairy.db` to import as a
starting point — he'd use "Open existing database file" and point at it.)

---

## Moving / checking the database later

Open the app → **Settings → Shared database**. It shows the exact path in use,
plus buttons to show the file in Explorer, save a backup, or point this
computer at a different folder/file.
