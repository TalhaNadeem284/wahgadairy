# Wahga Dairy Farm — going online (Turso + Render, free)

```
Desktop app (every PC) ──HTTPS + password──▶ API server (Render, free) ──▶ Turso (online SQLite)
                                              runs the same db.js           the real database
```

* The server keeps a copy in memory and writes **every save to Turso before it answers**, so nothing is lost when the free server sleeps or restarts.
* Every PC sees the same live data. Other PCs refresh within about 5 seconds.
* You need internet to save. Without it the app shows *"No internet … Nothing was saved"*.
* The free Render server sleeps after 15 minutes when no app is open. The first open of the day takes **about 30–60 seconds** to wake it up.

## 1. Turso (the database)
1. Sign up at https://turso.tech (free plan).
2. Create a database named `wahga-dairy` and pick the region closest to Pakistan (e.g. Mumbai or Singapore).
3. Copy the **Database URL** (`libsql://wahga-dairy-<you>.turso.io`) and create a **token**.
4. Create `server/.env` (this file is never committed):
   ```
   TURSO_DATABASE_URL=libsql://wahga-dairy-<you>.turso.io
   TURSO_AUTH_TOKEN=<token>
   ```

## 2. Upload the current data (cut-over day)
1. Close the app on **every** PC so nobody is saving to the Google Drive file.
2. From the project folder:
   ```
   npm install --prefix server
   node server/import-db.js "G:\My Drive\Wahga Dairy Farm\wahga-dairy.db"
   ```
   It must end with **"All tables match. ✅"**. To re-check later, run `node server/import-db.js <file> --verify`.

## 3. Render (the API server)
1. Push this project to a **private** GitHub repo.
2. At https://render.com, go to **New → Blueprint**, pick the repo, and it reads `render.yaml`.
3. Fill in the three secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `APP_PASSWORD` (the shared password, use a long one).
4. After the deploy, open `https://<name>.onrender.com/healthz`. It should show `{"ok":true,…}`.

## 4. Each PC
Install the new version. Then either click **🌐 Connect to the online database** on the start screen, or go to **Settings → Database & sharing → 🌐 Switch to the online database**, and enter the server address and the password.
The password is stored encrypted on the PC (Windows DPAPI).

## Backups
**Settings → 💾 Download a backup copy** saves the whole online database as a normal `.db` file. That file opens in the app's local mode too.
Turso also keeps its own point-in-time restore.

## Going back
**Settings → Use the local file instead** points that PC back at the Google Drive file. That file does NOT contain anything saved online after the cut-over.
