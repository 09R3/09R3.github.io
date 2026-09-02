# WaterMark — Deployment & Operations Guide

How the system is built, deployed, started, authenticated, run and recovered.
Companion to [`README.md`](README.md) (what the app is) and
[`CLAUDE.md`](CLAUDE.md) (contributor conventions + database schema).

Covers `watermark/` only. FieldView (`water-ops-viewer/`) lives on the
`Fieldview` / `Fieldview-beta` branches and is documented separately.

---

## 1. Topology

```
   phones / tablets / desktop browsers  (LAN or VPN)
                    │
                    │  HTTP  ── no reverse proxy in front by default
                    ▼
   ┌────────────────────────────────────────────────┐
   │  Unraid host                                   │
   │                                                │
   │   docker: watermark        :3067   (main)      │
   │   docker: watermark-beta   :3066   (Watermark-beta)
   │      └── node:22-alpine, --network host        │
   │      └── volume /mnt/user/watermark-uploads    │
   │              → /app/uploads                    │
   └────────────────────────────────────────────────┘
          │                    │                  │
          ▼                    ▼                  ▼
     PostgreSQL           InfluxDB           /app/uploads
     `waterops`          `plc-data` +        photos, invoices,
     all records         `power_meters`      label/SDS PDFs
     (operational        (SCADA history,
      source of truth)    written by
                          external Python
                          pollers — not in
                          this repo)
```

Both containers run with `--network host`, so there is no Docker port mapping —
the app binds `PORT` directly on the host. `EXPOSE 4000` in the Dockerfile is
vestigial under host networking.

**Beta and production share the same PostgreSQL database.** This is stated
explicitly in `deploy-beta.sh`. Anything saved while testing on `:3066` is a
real production record.

---

## 2. External dependencies

| Dependency | Required? | Consequence if unavailable |
|---|---|---|
| PostgreSQL (`waterops`) | **Yes** | Server still starts and serves the login page, but every data route 500s. Login screen shows a red DB indicator. |
| InfluxDB (`plc-data`) | No | `/api/scada/*` returns `503`; the SCADA screen shows "source unavailable". Everything else works. |
| InfluxDB (`power_meters`) | No | Power monitoring tab returns `503`. Can point at a separate Influx via `POWER_INFLUX_*`. |
| `Marv-s-site` repo (icons) | Effectively yes | All dashboard/nav icons render blank. Fetched as a **separate clone**, not a submodule update, during deploy. |
| `unpkg.com` (Leaflet 1.9.4) | Yes, for maps | GPS/pond map screens fail to render. |
| `cdnjs.cloudflare.com` (html2pdf 0.10.1) | Yes, for PDF export | PDF exports fail. CSV and Excel still work. |
| GitHub (raw + clone) | Yes, at deploy time | Deploy cannot fetch source. Runtime is unaffected. |

> **Note the last three.** Despite being an offline-first PWA, Leaflet and
> html2pdf are loaded from public CDNs in `public/index.html` and are **not** in
> the service worker's shell cache. Maps and PDF export therefore do not work
> offline, and they break entirely if the host loses internet egress even while
> the LAN is fine. Chart.js *is* vendored locally under `public/vendor/`.

---

## 3. Configuration reference

All configuration is environment variables, read by `dotenv` from
`$APPDATA_DIR/.env` and injected with `docker run --env-file`. The `.env` file
lives on the host and is **never** baked into the image.

### Documented in `.env.example`

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host. See Docker note below. |
| `DB_PORT` | `5432` | PostgreSQL port. |
| `DB_NAME` | — | Database name (`waterops`). |
| `DB_USER` | — | PostgreSQL user. |
| `DB_PASSWORD` | — | PostgreSQL password. |
| `PORT` | `4000` | HTTP listen port. **Overwritten by the deploy script** to 3067 (prod) / 3066 (beta). |

> **Docker networking:** if PostgreSQL runs on the same Unraid box, do *not*
> use `localhost` — use the host LAN IP or `172.17.0.1`.

### Read by `server.js` but *not* in `.env.example`

| Variable | Default | Purpose |
|---|---|---|
| `INFLUX_URL` | — | SCADA InfluxDB endpoint. Missing ⇒ SCADA routes 503. |
| `INFLUX_TOKEN` | — | SCADA InfluxDB token. Missing ⇒ SCADA routes 503. |
| `INFLUX_ORG` | `scada-org` | Influx organisation. |
| `INFLUX_BUCKET` | `plc-data` | Bucket holding `plc_tags` measurements. |
| `POWER_INFLUX_URL` | falls back to `INFLUX_URL` | Power-monitor Influx endpoint. |
| `POWER_INFLUX_TOKEN` | falls back to `INFLUX_TOKEN` | Power-monitor token. |
| `POWER_INFLUX_ORG` | falls back to `INFLUX_ORG` | Power-monitor org. |
| `POWER_BUCKET` | `power_meters` | Power-meter bucket. **`scada-config.json`'s `power.bucket` takes precedence over this env var**, so it usually has no effect. |
| `UPLOADS_PATH` | `/app/uploads` | Upload root inside the container. |
| `AZURE_CLIENT_ID` | — | Microsoft Entra ID SSO. |
| `AZURE_TENANT_ID` | — | Microsoft Entra ID SSO. |
| `AZURE_CLIENT_SECRET` | — | Microsoft Entra ID SSO. |
| `AZURE_REDIRECT_URI` | — | OAuth callback URL. |

SSO activates only when `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` **and**
`AZURE_CLIENT_SECRET` are all set (`msalEnabled`). Otherwise `/auth/microsoft`
returns 404 and the login screen hides the button.

> `SESSION_SECRET` is suggested in a `deploy-beta.sh` comment but **`server.js`
> never reads it**. Session tokens are 32 random bytes from `crypto`; setting
> the variable does nothing. Beta and prod sessions are already isolated because
> each process holds its own in-memory session map.

### Non-env configuration

`watermark/scada-config.json` defines the SCADA plant tree — 13 plants, their
pumps and pump-letter labels, sensor sets, computed sensors, the power-meter
list, field groups and alarm thresholds. Editing this file changes the SCADA UI
with no code change. It is copied into the image, so a change requires a
redeploy.

---

## 4. Deployment

### 4.1 First run

```bash
# on the Unraid host
mkdir -p /mnt/user/appdata/watermark
# place deploy.sh there, then:
bash /mnt/user/appdata/watermark/deploy.sh
```

The first invocation detects no `.env`, downloads `.env.example` from GitHub
(falling back to an inline heredoc if `curl` fails), prints an **ACTION
REQUIRED** box and exits `0` without deploying. Fill in the database
credentials, then re-run.

Beta is identical with `deploy-beta.sh` in `/mnt/user/appdata/watermark-beta`.

### 4.2 Routine deploy

```bash
bash /mnt/user/appdata/watermark/deploy.sh          # prod, main,           :3067
bash /mnt/user/appdata/watermark-beta/deploy-beta.sh # beta, Watermark-beta, :3066
```

Both scripts are `set -e`, so any failing step aborts the run.

| Step | Action | Notes |
|---|---|---|
| 2b | Rewrite `PORT=` in `.env` to `HOST_PORT` | Your `.env` PORT value is overwritten every deploy. |
| 1/5 | `docker stop` + `docker rm` the existing container | **The app is down from here until step 5/5.** Expect ~1–3 min. |
| 2/5 | `git clone --depth 1 --sparse --branch $BRANCH`, then `sparse-checkout set watermark` | Shallow, single-branch, watermark subtree only. |
| 2/5 | `git clone --depth 1 Marv-s-site` into `public/marv-site` | Icons. Failure only prints a warning — **the deploy continues and ships an iconless UI.** |
| 3/5 | `docker build --quiet` from `_source/watermark` | Image tag `watermark` / `watermark-beta`. |
| 4/5 | `rm -rf _source` | Clone is discarded; the image is the artifact. |
| 5/5 | `docker run --detach --restart unless-stopped --network host --env-file .env -v $UPLOADS_SHARE:/app/uploads` | Prints the URL and log command. |

### 4.3 What ends up in the image

`Dockerfile` copies only `package.json`, `package-lock.json`, `server.js`,
`scada-config.json` and `public/`, then `npm ci --omit=dev`.

Consequently **`db/migrations/` is not in the image** and is never executed at
runtime. Those 17 numbered SQL files are historical/manual — see §6.

### 4.4 Rollback

There is no versioned image tagging; each build overwrites the `watermark` tag.
To roll back, check out the previous commit's branch state and redeploy, or
`docker run` a previously retained image if one exists. Consider tagging images
by version if rollback speed matters.

---

## 5. Server boot sequence

`server.js` executes top to bottom on `node server.js`:

1. `dotenv` loads `.env`.
2. **MSAL init** — builds a `ConfidentialClientApplication` if all three Azure
   vars are present.
3. **Express setup** — `express.json()`, `cookieParser()`, `trust proxy = 1`,
   and `express.static('public')`.
4. **SCADA config load** — `scada-config.json` parsed into `SCADA_CONFIG`. A
   parse failure logs a warning and leaves it `null`; SCADA routes then 503.
   The Influx client is lazy (`getInfluxQuery()`), created on first use.
5. **Uploads root** — `fs.mkdirSync(UPLOADS_ROOT, { recursive: true })`.
6. **PostgreSQL pool** — `max: 10`, `connectionTimeoutMillis: 5000`. Every new
   connection runs `SET timezone = 'America/Los_Angeles'` (see §10).
7. **Schema bootstrap** — ~21 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE …
   ADD COLUMN IF NOT EXISTS` statements fired as **unawaited promises**, each
   with its own `.catch(err => console.error('Migration error: …'))`.
8. **Session map + `/uploads` guard** registered.
9. **199 routes** registered.
10. `app.listen(PORT)` → logs `Field Ops server running on http://localhost:PORT`
    then `Database connected` or `DB connection failed: …`.

> **Boot is non-blocking on schema.** Step 7 does not gate step 10. The server
> can begin serving requests while `ADD COLUMN` statements are still running.
> In practice this window is milliseconds, but a request landing inside it can
> fail against a column that does not exist yet. If a deploy adds a column,
> give it a few seconds before hammering the affected screen.

**Startup is healthy when `docker logs` shows both lines:**

```
Field Ops server running on http://localhost:3067
Database connected
```

---

## 6. Schema management

Two mechanisms exist; only one runs.

**Authoritative — bootstrap in `server.js`.** New tables and columns are added
as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` near
the top of `server.js`. They self-apply on every container start. This is the
only path that executes in production.

**Historical — `watermark/db/migrations/*.sql`.** 17 numbered files
(`002_equipment_swaps.sql` … `018_pest_tasks.sql`). There is no runner, no
`schema_version` table, and the directory is not copied into the image. Treat
these as a record of past changes, applied manually with `psql`, not as a
migration system.

**To add a column:** add an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` line to the
bootstrap block in `server.js`. It applies on the next deploy. Nothing else is
needed.

**Identifier safety:** table and column names must never come from a request.
Generic endpoints (history, notes, calibration logs, pesticide docs) look
identifiers up from a server-side map; the request supplies only a key. The same
rule protects SCADA — tag paths are interpolated into Flux, so
`scadaAllowedTagSet()` allow-lists every queryable path.

---

## 7. Authentication, sessions and roles

### 7.1 Local login (`POST /auth/login`)

1. Rate-limit check — 5 failed attempts per `username|IP` per 15 minutes,
   `429` when tripped. Cleared by a successful login **or** by an admin
   changing that user's password (instant unlock).
2. `SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active = true`.
3. Password compare — bcrypt if the stored hash starts with `$2`; otherwise a
   plaintext comparison, and on success the password is **transparently
   rehashed** with bcrypt cost 10 and written back. Legacy rows self-heal on
   first login.
4. Session created: `crypto.randomBytes(32).toString('hex')` → stored in an
   in-process `Map` with an 8-hour TTL.
5. Cookie set: `fo_session`, `httpOnly`, `sameSite: 'lax'`,
   `secure: req.secure`, `maxAge` 8h.

### 7.2 Microsoft Entra ID SSO

`GET /auth/microsoft/status` reports whether it is configured. `/auth/microsoft`
redirects to Microsoft; `/auth/microsoft/callback` exchanges the code, reads the
account email, and looks up `users WHERE LOWER(email) = LOWER($1) AND is_active`.

SSO **does not provision users** — the account must already exist in the `users`
table with a matching email. Failures redirect to `/?ms_error=…`
(`no_email`, `no_account`, `auth_failed`).

### 7.3 Sessions are in-memory

`const sessions = new Map()`. There is no shared or persisted session store.

- **Every deploy or restart logs every user out.** This is expected behaviour,
  not a fault. Warn operators before a mid-shift deploy.
- No cross-instance sharing, so the app cannot be scaled to multiple replicas
  as written.
- "Force logout everyone" = restart the container.

### 7.4 Roles

Eight roles. `SUPERVISOR_ROLES = ['supervisor', 'admin', 'water-planner']` is
supervisor-level; `operator`, `systems-operator`, `heavy-equipment-operator`,
`pump-tech`, `elec-tech` are not. `isSuperiorTo()` ranks admin 3, supervisor and
water-planner 2, everything else 1 — used to stop a user editing a peer or
senior.

Enforcement is `requireAuth` then `requireRole(...)` per route. Client-side
`isSupervisorLevel()` only drives visibility; **hiding a button is never the
control.**

Several records use a **creator-or-supervisor** rule: the row's `entered_by`
matches the signed-in user, or the user is supervisor-level. Applies to vehicle
maintenance records and purge readings.

**SCADA access is separately configurable.** `requireScadaAccess` consults the
`scada_roles` row in `app_settings`, admin-managed via Settings → SCADA Access,
defaulting to `['admin']`. `admin` is always forced into the list.

---

## 8. Client boot and the service worker cache contract

### 8.1 Boot

1. Browser loads `/` → `public/index.html`. An inline `<head>` script applies
   the saved theme before first paint (anti-FOUC).
2. Leaflet CSS/JS and html2pdf load from CDN; `style.css`, `app.js`, `scada.js`
   and vendored Chart.js load locally.
3. `navigator.serviceWorker.register('/sw.js')`.
4. `checkAuth()` calls `GET /auth/me`.
   - **200** → `onLogin(user)`, dashboard renders.
   - **Network error + cached user in `localStorage`** → logs in from the cache
     so the app works with no signal.
   - **401/403** → clears the cached user and posts `clear-api-cache` to the SW.
5. `applyScadaVisibility()` fetches the SCADA allow-list and shows/hides the
   SCADA nav item and dashboard widget.

Screens are `<div class="screen-content">` elements toggled by `showScreen()`;
nothing is routed or lazy-loaded.

### 8.2 The cache contract — why the version bump is mandatory

`sw.js` uses two strategies:

| Path | Strategy |
|---|---|
| `/api/scada/stream` | Bypassed entirely — never cache an open SSE stream. |
| `/`, `/app.js`, `/scada.js`, `/style.css`, `/manifest.json`, `/vendor/*` | **Cache-first.** Served from cache without ever hitting the network. |
| `/api/**` GET | Network-first, cached on `res.ok`, falls back to cache offline. |
| Everything else (POST, auth) | Network only; offline handling is `app.js`'s queue. |

The app shell is **cache-first**, so the only thing that ever delivers new
front-end code is the `activate` handler deleting caches whose key ≠ `CACHE`.
`CACHE` is the version string on line 1 of `sw.js`.

> **If you deploy without changing `CACHE` in `sw.js`, every already-installed
> device keeps running the old `app.js` and `index.html` indefinitely.** The
> server is new, the clients are not — which surfaces as "the fix didn't work"
> reports from the field and, when the API has changed shape, as errors.

This is why `CLAUDE.md` requires that every change under `watermark/` bump the
version in **all three** places, kept identical:

- `public/index.html` — login footer (`.login-version`)
- `public/index.html` — Settings → Version row (`#appinfo-version-tap`)
- `public/sw.js` — line 1, `const CACHE = 'watermark-vX.YZ'`

Current: **v3.18** in all three. Verify before every deploy:

```bash
grep -n 'v 3\.' watermark/public/index.html; head -1 watermark/public/sw.js
```

### 8.3 Cache purge on logout

`onLogout()` and a rejected session both post `{type:'clear-api-cache'}` to the
service worker, which deletes every cached entry under `/api/`. The app shell
stays cached so offline launch still works. This keeps one operator's data off a
shared device after the next person signs in.

---

## 9. Offline behaviour — exactly what queues

Reads work offline through the SW's API cache. Writes work offline **only where
the call site opts in** by passing a fourth `offlineLabel` argument to `api()`.
With a label, a network error or a 5xx enqueues the POST into IndexedDB
(`watermark-offline`, store `queue`) and returns `{ok: true, queued: true}`.
Without one, the save throws and the operator sees an error.

**Queues offline (11 endpoints):**

| Endpoint | Queue label |
|---|---|
| `/api/readings/well` | `Well — {common_name}` |
| `/api/readings/canal` | `Canal — {structure_name}` |
| `/api/readings/kf-monthly` | `KF — {common_name}` |
| `/api/readings/piezometer` | `Piez — {piezometer_name}` |
| `/api/readings/run-dwr` | `DWR — {common_name}` |
| `/api/readings/vehicle-monthly` | `Vehicle — {label}` |
| `/api/readings/pumping-plant` | `Pumping Plant` |
| `/api/maintenance/vehicle` | `Maintenance — Vehicle` |
| `/api/maintenance/equipment` | `Maintenance — Equipment` |
| `/api/maintenance/building` | `Maintenance — Building` |
| `/api/equipment-swaps` | `Equipment Swap` |

**Does *not* queue — these fail outright with no signal:**

`/api/readings/staff-gauge`, `/api/readings/pond-gate`, `/api/purge/readings`,
`/api/cal-log/*`, `/api/pm-records`, `/api/well-issues`,
`/api/building-issues`, `/api/equipment-issues`, `/api/canal-issues`,
`/api/dirt-work-issues`, `/api/safety-meetings` (and `/attend`), `/api/jha`
(and `/sign`), `/api/pesticides`, `/api/pesticide-usage`, `/api/pest-tasks`,
`/api/bug-reports`, `/api/charge-codes`, `/api/charge-code-splits`,
`/api/users`, `/api/auth/change-password`.

> One nuance: `/api/readings/canal` is saved from two places. The **Canal
> Readings screen** queues offline; the **canal-source save inside the Ponds
> screen** does not. Ponds work has no offline write path at all.

### Sync

- The dashboard shows a pending-sync card with the queued count, a per-item
  list, an Export button and Sync Now.
- `window.addEventListener('online', …)` fires `syncPendingQueue()`
  automatically.
- Sync replays each item as a plain `fetch` POST, deleting on `res.ok` and
  leaving failures in the queue. Failures raise a red `!` badge.
- Queue items are **not attributed on the server by their original author** —
  replay is a normal POST under whatever session is active. Sync while signed in
  as the operator who captured the readings.
- Attachments (photos, invoices) are multipart uploads and are **not** part of
  the offline queue.

---

## 10. Time handling

Reading timestamps are stored as `DATE` + `TIME WITHOUT TIME ZONE` — naive
Pacific local. To make interval maths against `NOW()` behave, the pool sets
`SET timezone = 'America/Los_Angeles'` on **every** connection
(`pool.on('connect')`).

Client-side, `todayISO()` uses `toLocaleDateString('en-CA')` (local), and
date formatting slices `YYYY-MM-DD` off the string **before** constructing a
`Date`, to dodge the UTC-midnight day-behind bug on `DATE` columns returned as
full ISO strings.

Server-side `todayString()` still uses `new Date().toISOString()` (**UTC**). If
the container's clock/TZ is not Pacific, the server's idea of "today" can differ from
the client's near midnight. Keep the host on Pacific time.

---

## 11. SCADA data path

```
PLCs → Python pollers (external repo) → InfluxDB `plc-data`
                                          measurement: plc_tags
                                          field: value, tag: tag
                                              │
                              server.js Flux queries
                                              │
                     ┌────────────────────────┴───────────────┐
                     ▼                                        ▼
      GET /api/scada/stream (SSE)            GET /api/scada/history, /power/history
      pushes every pollMs (5000ms)           range or start/end windows
                     │
                     ▼
      scada.js EventSource → applyScadaCurrent() → patch overview / plant detail
```

- Tag paths are built server-side from `scada-config.json`
  (`{influxSite}.{sensor}.SCL.PV`, `{influxSite}.{pump}.MTR.Cntrl.Run`, …). The
  browser never sees a raw Influx tag path.
- Current-value queries chunk tags in groups of 20 to stay under Flux's
  "program nested too deep" limit, with `range(start: -5m) |> last()`.
- **One `setInterval` per open SSE connection.** Each viewer polls Influx
  independently — 10 people on the SCADA screen means 10× the Flux load. The
  interval is cleared on `req.on('close')`, and `showScreen()` calls
  `stopScadaStream()` when navigating away, so connections do not accumulate
  per user.
- Influx unreachable → an `event: sourceError` frame; the client shows an
  "Offline — last update Ns ago" bar rather than blanking the screen.

---

## 12. Reports, exports and uploads

### Export flow

CSV and PDF are built client-side. Excel is generated server-side with the
`xlsx` package, which means the browser must perform a plain navigation the
cookie may not accompany — hence one-time tokens:

1. `POST /api/reports/download-token` (supervisor-level) → 32-byte hex token,
   stored in an in-memory `Map` with a **30-second** expiry.
2. Browser hits `GET /api/reports/<name>/export?…&token=…`.
3. Server validates and **immediately deletes** the token — single use.
4. If no token is supplied, the endpoint falls back to session auth.

Tokens die with the process, as with sessions. A 30-second window means a stalled
device on a slow link can fail an export; retrying issues a fresh token.

There are 8 export contexts (`vehicles`, `vehicle-service`, `wells-daily`,
`wells-monthly`, `wells-dripper`, `canal`, `piezometers-compare`,
`piezometers-status`). Each needs a branch in **all three** of the CSV, Excel
and PDF handlers — a missing branch silently falls through to the vehicles
default and exports the wrong report.

### Uploads

- Root `/app/uploads`, bind-mounted from `/mnt/user/watermark-uploads`, so files
  survive container rebuilds. **This share is not backed up by the deploy
  script — include it in your Unraid backup plan.**
- Layout: `{category}/{YYYY}/{MM}/{sanitised-base}-{base36 timestamp}{ext}`.
  The timestamp suffix stops same-name uploads overwriting each other.
- 11 categories (`pumps`, `motors`, `wells`, `vehicles`, `electrical`,
  `structures`, `siphon-breakers`, `air-compressors`, `canal`, `misc`,
  `general`); an unknown category falls back to `general`.
- Limits: 50 MB per file, 20 files per request.
- Accepted: `.jpg .jpeg .png .heic .heif .webp .pdf` — and the **extension and
  MIME type must both pass**, since MIME alone is client-controlled and an
  `.html` declared as `image/png` would be served back as a live page.
- `/uploads` is behind a session check and sets `X-Content-Type-Options:
  nosniff`. Deletion resolves the path and rejects anything escaping the root.
- Records link via `maintenance_attachments` keyed on `table_name` +
  `record_id`.

---

## 13. Day-2 operations

### Health check

```bash
docker ps --filter name=watermark
docker logs -f watermark            # expect: "Field Ops server running" + "Database connected"
curl -s localhost:3067/api/db-status
```

### Restart / stop

```bash
docker restart watermark            # also clears all sessions and download tokens
docker stop watermark
```

`--restart unless-stopped` means the container returns after a host reboot.

### Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Login page loads, red DB indicator, every screen errors | `DB_HOST` set to `localhost` inside a container, wrong credentials, or Postgres down | Set `DB_HOST` to the LAN IP or `172.17.0.1`; check `docker logs` for `DB connection failed` |
| Field devices still show the old version after a deploy | `CACHE` in `sw.js` was not bumped | Bump all three version strings, redeploy. Interim: users can force-refresh or reinstall the PWA |
| All icons blank | `Marv-s-site` clone failed during deploy (warning only — deploy still succeeded) | Re-run the deploy with GitHub reachable |
| Everyone logged out | Container restarted; sessions are in-memory | Expected. Sign back in |
| `429 Too many failed attempts` | 5 bad passwords in 15 min for that user+IP | Wait 15 min, or an admin changes the user's password to clear it instantly |
| SCADA screen "source unavailable" | `INFLUX_URL`/`INFLUX_TOKEN` unset, or Influx down | Add the vars to `.env` (they are absent from `.env.example`) and redeploy |
| Maps blank / PDF export fails, CSV fine | No egress to `unpkg.com` / `cdnjs.cloudflare.com` | Restore outbound internet, or vendor both libraries locally |
| Excel export 401 | Download token older than 30s | Retry the export |
| Save fails in the field with no signal | Endpoint is not offline-enabled (see §9) | Re-enter once back in coverage |

### Reading the logs

`handleErr()` logs the full error server-side and returns only
`"Server error. Check Docker logs for more information."` to the client — so
`docker logs watermark` is always the place to diagnose a 500. Schema bootstrap
problems appear as `Migration error (…): …` at startup.

---

## 14. Release procedure

1. Branch: WaterMark work goes to **`Watermark-beta`**. Never push to `main`.
2. Make the change under `watermark/`.
3. **Bump the version in all three places** (§8.2), keeping them identical.
4. Commit with a descriptive message (history convention:
   `WaterMark v3.18: name canal exports by turnout and date range`).
5. `git push -u origin Watermark-beta`.
6. Deploy beta: `bash /mnt/user/appdata/watermark-beta/deploy-beta.sh`.
7. Verify on `:3066` — remembering it writes to the **production database**.
8. Promote to `main` and run `deploy.sh` for production.
9. If either `deploy.sh` or `deploy-beta.sh` changed in the repo, **copy the new
   file to the server** — the scripts live on the host and are not updated by
   running them.

---

## 15. Known gaps and risks

Operational, in rough order of impact.

1. **Beta writes to the production database.** No isolation between test and
   real records. A separate `waterops_beta` database would fix it.
2. **CDN dependency in an offline-first app.** Leaflet and html2pdf come from
   `unpkg` and `cdnjs`, are not in the SW shell cache, and break maps and PDF
   export both offline and during any internet outage. Chart.js is already
   vendored — these two should be too.
3. **Missed version bump ships an invisible non-deploy.** The cache-first shell
   means clients silently keep old code. Worth a pre-push check or CI guard.
4. **Sessions and download tokens are in-memory.** Every restart logs everyone
   out and the app cannot be scaled beyond one replica.
5. **Uploads share is outside the deploy's concern.** `/mnt/user/watermark-uploads`
   holds every photo, invoice, label and SDS. Confirm it is in the backup plan.
6. **`.env.example` documents 6 of the 19 variables `server.js` reads.** Anyone
   provisioning a new instance from it gets no SCADA and no SSO with no
   indication why.
7. **Icon fetch failure is a warning, not an error.** A deploy can "succeed"
   and ship a UI with no icons.
8. **Schema bootstrap does not gate `listen()`.** A brief window at startup where
   requests can hit a not-yet-added column.
9. **`GET /api/db-status` is unauthenticated and returns `DB_HOST`, `DB_PORT`
   and `DB_NAME`.** The login indicator only needs `connected: true/false`.
   (`todo.md` 1.3.1, still open.)
10. **Minimum password length is 4 characters** (`server.js`, change-password
    route). (`todo.md` 1.3.2, still open.)
11. **No image tagging, so no fast rollback.** Each build overwrites the tag.
12. **Offline bypass for deactivated users.** A user whose account is set
    `is_active = false` can still enter the app offline from the cached
    `localStorage` user blob. (`todo.md` 1.3.4, still open.)

### Corrections to `todo.md`

`watermark/todo.md` has drifted from the code. Verified against the current
branch:

- **1.2.3 "No rate limiting on `/auth/login`" — fixed.** 5 attempts per
  username+IP per 15 minutes is implemented (`loginBlocked` /
  `recordLoginFailure`), marked `(S-2)` in the source but not struck through in
  `todo.md`.
- **1.2.1 "Unauthenticated `/api/db-test`" — fixed**, and correctly struck
  through. It is now `requireAuth` + `requireRole('admin')`.
- **2.2.3 "`deploy.sh` curl URL missing the repo name" — fixed.** Both scripts
  now use `raw.githubusercontent.com/09r3/09r3.github.io/$BRANCH/…`.
- **4.3 "Version number hardcoded in 3 places"** still says `v 1.11`; the app is
  on `v 3.18`. The finding stands, the example is stale.
- **4.6 "`server.js` is a single ~2,276-line file"** — it is now ~6,100 lines
  with 199 routes. The finding is considerably more true than when written.
