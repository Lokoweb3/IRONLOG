# IRONLOG

A workout tracker with **Google Sign-In** and a **synced backend**, so your accounts
and workout history live on your server and follow you across devices.

- **Frontend:** Vite + React (`src/workout-tracker.jsx` is the whole UI), `lucide-react`, `recharts`
- **Backend:** Node + Express
- **Database:** SQLite via `better-sqlite3` (all DB access is isolated in `server/db.js` so you can swap to Postgres later)
- **Auth:** Google Identity Services (GIS) — the modern `https://accounts.google.com/gsi/client` library, FedCM-enabled. The backend verifies every ID token with `google-auth-library` and issues its own httpOnly session cookie.

---

## 1. Project layout

```
.
├── index.html              # loads the GIS script + the React app
├── vite.config.js          # dev server + /auth and /workouts proxy to Express
├── package.json            # one package.json for both frontend and backend
├── .env / .env.example     # config (see below)
├── src/
│   ├── main.jsx            # React entrypoint
│   ├── workout-tracker.jsx # your component (now auth- + API-wired)
│   └── api.js              # fetch wrapper that replaced window.storage
├── server/
│   ├── index.js            # Express app; serves the built frontend in prod
│   ├── auth.js             # GIS token verification, session cookie, requireAuth
│   ├── workouts.js         # workout routes (all require auth)
│   └── db.js               # the ONLY file with SQL — swap this for Postgres
└── data/                   # SQLite file lives here (git-ignored)
```

---

## 2. Create your Google OAuth Web client ID

1. Go to the **Google Cloud Console → APIs & Services → Credentials**:
   <https://console.cloud.google.com/apis/credentials>
2. Pick (or create) a project.
3. If prompted, configure the **OAuth consent screen**:
   - User type **External**, fill in app name + your email.
   - While testing, add your Google account under **Test users** (or publish the app).
   - Scopes: the default `openid`, `email`, `profile` are all you need.
4. Click **Create Credentials → OAuth client ID**.
5. Application type: **Web application**.
6. Fill in the two lists below, then click **Create**. Copy the **Client ID** it gives you.

### Authorized JavaScript origins

These are the origins the sign-in button is allowed to run on. **No paths, no trailing slash.**

| Environment | Value |
|-------------|-------|
| Local dev   | `http://localhost:5173` |
| Production  | `https://YOURDOMAIN`  ← **fill in your real domain** |

### Authorized redirect URIs

GIS with FedCM uses the JavaScript origins above and does **not** require a redirect
URI for this token flow. You can leave **Authorized redirect URIs empty**.
(If the console insists on at least one, add `https://YOURDOMAIN` — it won't be used.)

> **`YOURDOMAIN` is a placeholder.** Replace it everywhere with the real domain you'll
> deploy to (e.g. `workouts.example.com`). It appears here and is the only thing Google
> ties the sign-in button to.

---

## 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | What to put |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | The Client ID from step 2 (backend verifies tokens against it) |
| `VITE_GOOGLE_CLIENT_ID` | **The same** Client ID (frontend renders the button with it) |
| `SESSION_SECRET` | A long random string. Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PORT` | API port (default `8080`) |

**Values YOU must fill in:**
1. `GOOGLE_CLIENT_ID` **and** `VITE_GOOGLE_CLIENT_ID` → your real Google client ID.
2. `SESSION_SECRET` → your generated secret.
3. `YOURDOMAIN` in this README / the Google console → your real domain (only needed for production).

---

## 4. Run in development

```bash
npm install
npm run dev
```

- Vite dev server: <http://localhost:5173>  ← **open this**
- Express API: <http://localhost:8080> (Vite proxies `/auth` and `/workouts` to it)

Because everything is served through `localhost:5173`, the session cookie is first-party
and there's no CORS to deal with. Sign in with the Google account you added as a test user.

> The cookie is sent without the `Secure` flag in dev (plain `http://localhost`), and with
> `Secure` automatically in production.

---

## 5. Build & run in production (single origin)

```bash
npm run build     # outputs dist/
npm start         # NODE_ENV=production; Express serves dist/ AND the API on $PORT
```

Now the whole app — frontend and API — is served from one origin on `PORT`, so cookies
stay first-party. Put a reverse proxy with HTTPS in front of it (next section).

---

## 6. Deploy on a VPS

A minimal, robust setup: **Node app behind Nginx (or Caddy) with HTTPS.**

### a. Get the code + deps on the server

```bash
git clone <your repo> ironlog && cd ironlog
npm ci
cp .env.example .env   # then edit it with prod values
npm run build
```

Make sure `.env` has your real `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`,
`SESSION_SECRET`, and `PORT`. **Rebuild (`npm run build`) any time you change
`VITE_GOOGLE_CLIENT_ID`**, since it's baked into the frontend bundle.

### b. Keep it running with a process manager (PM2)

```bash
npm install -g pm2
pm2 start "npm start" --name ironlog
pm2 save
pm2 startup            # follow the printed command so it survives reboots
```

(Alternatively, a systemd unit running `npm start` with `EnvironmentFile=/path/.env`.)

### c. Reverse proxy + HTTPS

**Option A — Caddy (automatic HTTPS):** `/etc/caddy/Caddyfile`

```
YOURDOMAIN {
    reverse_proxy localhost:8080
}
```

```bash
sudo systemctl reload caddy
```

**Option B — Nginx + Certbot:** `/etc/nginx/sites-available/ironlog`

```nginx
server {
    server_name YOURDOMAIN;
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ironlog /etc/nginx/sites-enabled/
sudo certbot --nginx -d YOURDOMAIN   # provisions HTTPS automatically
sudo systemctl reload nginx
```

The app sets `app.set("trust proxy", 1)` so it trusts `X-Forwarded-Proto` from your
proxy — important for the `Secure` cookie to work correctly behind TLS termination.

### d. Final Google console check

Confirm `https://YOURDOMAIN` is in **Authorized JavaScript origins**, and that your
OAuth consent screen is either **published** or lists every tester under **Test users**.

---

## 7. npm scripts

| Script | Does |
|--------|------|
| `npm run dev` | Express (`:8080`) + Vite (`:5173`) together, with API proxy + hot reload |
| `npm run build` | Builds the frontend to `dist/` |
| `npm start` | Production: Express serves `dist/` and the API on `$PORT` |
| `npm run preview` | Vite's static preview of `dist/` (no backend) |
| `npm test` | Run the backend test suite (Node's built-in runner + supertest, in-memory DB) |

---

## 8. API reference

All workout routes require the session cookie (set after `POST /auth/google`).

| Method & path | Body | Returns |
|---------------|------|---------|
| `POST /auth/google` | `{ credential }` (GIS ID token) | `{ user }` + sets cookie |
| `POST /auth/logout` | – | `{ ok: true }`, clears cookie |
| `GET /auth/me` | – | `{ user }` or `401` |
| `GET /workouts` | – | array of sessions, newest first |
| `POST /workouts` | a session object | `{ workout }` |
| `DELETE /workouts/:id` | – | `{ ok: true }` (only your own) |
| `POST /workouts/import` | `{ sessions: [...] }` | `{ added, total }` (merge, never wipe) |
| `GET /program` | – | `{ days, onboarded }` (no longer auto-seeds; `onboarded:false` for new users) |
| `PUT /program` | `{ days: [...] }` | `{ days }` (save the user's edited program) |
| `POST /program/reset` | – | `{ days }` (restore the default program) |
| `GET /profile` | – | `{ profile }` (body stats, goal, macro targets; null if unset) |
| `PUT /profile` | profile object | `{ profile }` |
| `GET /meals?date=YYYY-MM-DD` | – | array of food entries for that day |
| `POST /meals` | `{ day, name, brand?, amount?, calories, protein, carbs, fat }` | `{ meal }` |
| `DELETE /meals/:id` | – | `{ ok: true }` (only your own) |
| `GET /foods/search?q=` | – | `{ results }` proxied from Open Food Facts (normalized per-100g macros) |

**Data model**

- `users`: `id, google_sub (unique), email, name, picture, created_at`
- `workouts`: `id, user_id, client_id, day_key, day_name, focus, tag, started_at, finished_at, exercises (JSON), created_at`
- `programs`: `user_id (unique), days (JSON array of day objects), updated_at` — each user's editable program; new users are seeded with the default 4-day split.
- `profiles`: `user_id (unique), data (JSON: sex, age, heightIn, weightLbs, activity, goal, targets), updated_at` — drives daily macro targets (Mifflin–St Jeor; computed client-side, overridable).
- `meals`: `id, user_id, day (YYYY-MM-DD), name, brand, amount, calories, protein, carbs, fat, created_at` — the per-day food log.

Food search/barcode is proxied through `server/foods.js`. It tries **Open Food Facts**
first (keyless **search-a-licious** API at `search.openfoodfacts.org` — the legacy
`cgi/search.pl` endpoint 503s datacenter IPs, so don't use it server-side), then falls back
to **USDA FoodData Central** when OFF has no match (far better coverage of US branded
groceries, incl. barcodes).

USDA uses `FOOD_API_KEY`; without it, it falls back to the rate-limited `DEMO_KEY`
(~30 requests/hour). Get a free key at <https://fdc.nal.usda.gov/api-key-signup.html> and
set it as a secret: `fly secrets set FOOD_API_KEY=...` (and add `FOOD_API_KEY=` to `.env`
for local dev).

> **Reliability note:** [fly.toml](fly.toml) keeps the machine always-on
> (`auto_stop_machines = "off"`, `min_machines_running = 1`) so saves never hit a cold
> start. Set autostop back to `"suspend"` if you'd rather save money and rely on the
> client-side retries in `src/api.js`.

### Backups (Litestream → Fly Tigris)

The SQLite DB is continuously replicated to object storage by **Litestream** (config in
[litestream.yml](litestream.yml); the [Dockerfile](Dockerfile) installs it and the
[scripts/run.sh](scripts/run.sh) entrypoint runs the app under
`litestream replicate -exec`). On boot, if the volume DB is missing it auto-restores from
the replica. Retention is 7 days with daily snapshots.

Set up (already done for this app):
```bash
fly storage create -a <app> -n <bucket> -o personal -y   # provisions Tigris + secrets
# If run.sh logs "Litestream disabled" afterwards, the secrets didn't inject —
# re-set them explicitly to force it, then redeploy:
fly secrets set BUCKET_NAME=<bucket> AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev \
  AWS_REGION=auto AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY=<secret>
```
Manual restore to a file: `litestream restore -config /etc/litestream.yml /tmp/app.db`.
Check backups: `litestream snapshots -config /etc/litestream.yml /data/app.db`.

The `exercises` JSON matches the frontend shape exactly:
`[{ name, variation, variations[], sets: [{ w, r, done, doneAt, restBefore }] }]`.

---

## 9. Migrating off your old on-device data

The old version stored everything in the browser via `window.storage`. To carry that
history into your account, use the **Export backup** button on the old build (History tab)
to get a JSON file, then sign in here and use **Import** — it `POST`s to `/workouts/import`,
which merges by id without wiping anything.

---

## 10. Troubleshooting: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / cert errors

If `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or sign-in fails with
`request to https://www.googleapis.com/oauth2/v1/certs failed ... unable to verify the
first certificate`, then **antivirus or a corporate proxy is intercepting HTTPS** on your
machine and presenting a certificate Node doesn't trust by default.

Fix (already applied on this dev machine): export the certificates your OS already trusts
into a PEM bundle and point Node at it via `NODE_EXTRA_CA_CERTS`.

```powershell
# 1. Export the Windows trust store (includes the AV/proxy root) to a PEM bundle
$out = "$PWD\certs\ca-bundle.pem"
New-Item -ItemType Directory -Force certs | Out-Null
$certs = Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root
$sb = New-Object System.Text.StringBuilder
foreach ($c in $certs) {
  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")
  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData,'InsertLineBreaks'))
  [void]$sb.AppendLine("-----END CERTIFICATE-----")
}
[System.IO.File]::WriteAllText($out, $sb.ToString())

# 2. Make every local Node process trust it (persists; restart the terminal after)
setx NODE_EXTRA_CA_CERTS "$out"
```

`certs/` is git-ignored, so this machine-specific bundle never reaches your VPS (which
won't have the interception and doesn't need it). To undo: delete the env var with
`setx NODE_EXTRA_CA_CERTS ""` (or remove it in *Environment Variables*). The cleaner
long-term fix is to disable HTTPS/SSL scanning for these hosts in your antivirus.

> `setx` only affects **new** processes — restart your terminal (and the IDE) once before
> running `npm run dev`.

**Deploying to Fly behind the same interceptor:** `flyctl` is a Go binary and ignores
`NODE_EXTRA_CA_CERTS`, and Fly's "Depot" builder uses a TLS/gRPC channel the interceptor
breaks (`x509: certificate signed by unknown authority`). Two fixes, both already applied:
point Go at the same bundle and skip Depot.

```powershell
setx SSL_CERT_FILE "$PWD\certs\ca-bundle.pem"   # Go reads this; restart terminal after
npm run deploy                                   # = fly deploy --depot=false
```

---

## 11. Swapping SQLite → Postgres later

Every SQL statement lives in `server/db.js`, behind these functions:
`findOrCreateUser`, `getUserById`, `listWorkouts`, `upsertWorkout`, `deleteWorkout`,
`importWorkouts`. Reimplement just those against `pg` (the `ON CONFLICT (user_id, client_id)`
upsert and JSON column both port directly to Postgres) and nothing else has to change.
