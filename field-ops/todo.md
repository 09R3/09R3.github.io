# Field Ops — Review TODO

---

## 1. Security

### 1.1 High Severity

**1.1.1** ~~Wrong cookie name in export fallback~~
`server.js:1599` checks `req.cookies.session_id` but the cookie is named `fo_session`. The export session-fallback path permanently returns 401 for any request not using a download token.
Severity: **High**

---

### 1.2 Medium Severity

**1.2.1** ~~Unauthenticated `/api/db-test`~~
Accepts arbitrary host/port/database/user/password and opens a real PostgreSQL connection with no authentication required. Exposes the server as a credential-testing proxy for internal network hosts. Moved to post-login admin settings and protected with `requireAuth`.
Severity: **Medium**

**1.2.2** In-memory session store
Sessions are stored in a `Map()` in `server.js:45`. All sessions are lost on every server restart/redeploy, forcing all users to re-login. No cross-instance sharing. No "force logout all" mechanism without restarting the process.
Severity: **Medium**

**1.2.3** No rate limiting on `/auth/login`
No throttling or lockout mechanism exists on login attempts. An attacker with internal network access can brute-force passwords freely.
Severity: **Medium**

---

### 1.3 Low Severity

**1.3.1** `/api/db-status` leaks server configuration
Returns `DB_HOST`, `DB_PORT`, and `DB_NAME` to any unauthenticated client. Only `connected: true/false` is needed by the login screen indicator.
Severity: **Low**

**1.3.2** Minimum password length is 4 characters
`server.js:2055` — extremely permissive for any production system.
Severity: **Low**

**1.3.3** Service worker cache not cleared on logout
Cached API GET responses (user lists, readings) are not invalidated on logout. On a shared device, a previous user's data may remain readable offline until the next SW activation cycle.
Severity: **Low**

**1.3.4** Offline bypass for deactivated users
`checkAuth()` in `app.js` falls back to a `localStorage` cached user blob when offline. A user whose account was deactivated (`is_active = false`) can still access the app offline if they have a cached session.
Severity: **Low**

---

## 2. Bugs

### 2.1 Medium Severity

**2.1.1** Duplicate `#location-modal` element in HTML
Two elements share `id="location-modal"` in `index.html` (approx. lines 1213 and 1255). Invalid HTML — `getElementById` only returns the first. The second block (with an `<a>` tag instead of `<button>`) is dead markup and should be removed.
Severity: **Medium**

**2.1.2** `maint-save-btn` equipment branch reads hidden stub elements
`index.html` contains hidden `<select>` stubs (`maint-equip-type`, `maint-equip-select`, etc.) preserved to avoid breaking old JS listener IDs. The equipment branch of the `maint-save-btn` handler in `app.js:2493–2558` reads these stubs — that entire code path is dead since the UI no longer exposes the equipment flow. Should either be wired up or removed.
Severity: **Medium**

---

### 2.2 Low Severity

**2.2.1** UTC vs. local timezone mismatch for "today"
`server.js` uses `new Date().toISOString()` (UTC) for "today's" date checks; `app.js` uses `new Date().toLocaleDateString('en-CA')` (local time). If the server runs in a different timezone than users, the "today's readings" boundary can differ between server-side validation and what the client displays.
Severity: **Low**

**2.2.2** `adminLoaded` flag declared but never set to `true`
The flag is declared in `app.js` but `initAdminScreen()` never marks it as loaded. The user list is re-fetched from the server on every visit to the admin screen.
Severity: **Low**

**2.2.3** `deploy.sh` curl URL is missing the repo name
The URL `raw.githubusercontent.com/09r3/$BRANCH/field-ops/.env.example` interpolates without the repository segment. First-run `.env` creation always falls back to the heredoc template instead of pulling from GitHub.
Severity: **Low**

---

## 3. Performance

### 3.1 High Severity

**3.1.1** ~~N+1 HTTP requests on pumping plant load~~
`app.js:771–786` fires `1 + (buildings × 4)` separate API requests per site (1 for buildings, then for each building: pump-positions, air-compressors, pge-meters, power-monitors). For a site with 8 buildings that is 33 HTTP round-trips. Replaced with a single `/api/pp-site-data?site_id=X` endpoint that returns all data in one query.
Severity: **High**

---

### 3.2 Medium Severity

**3.2.1** Missing indexes on reading tables
The "Today's Readings" UNION (`server.js:2076–2148`) and the `LATERAL JOIN … LIMIT 1` "last reading" patterns on several GET endpoints depend on `(reading_date, entered_by)` index access. No such indexes appear in the migration files, so these queries do full table scans as row counts grow.
Severity: **Medium**

---

## 4. Duplication / Maintainability

**4.1** Three near-identical issue render functions
`renderWellIssues`, `renderBldgIssues`, and `renderEquipIssues` in `app.js` are ~150 lines of copy-paste, differing only in the title field and API path. A single `renderIssueList(issues, getTitleFn)` eliminates the duplication.

**4.2** Three near-identical PATCH issue handlers on the server
`PATCH /api/well-issues/:id`, `PATCH /api/building-issues/:id`, and `PATCH /api/equipment-issues/:id` (`server.js:998`, `1066`, `1134`) are structurally identical — same fields, same `COALESCE` logic, same `resolved_date CASE` expression. A shared `patchIssue(table, id, body)` helper cuts ~60 lines.

**4.3** Version number hardcoded in 3 places
`index.html` has `v 1.11` at two locations (lines ~80 and ~1070) and `sw.js` line 1 has `field-ops-v1.11`. All three must be updated in sync on every release; missing one causes stale service worker cache behavior.

**4.4** Status string case inconsistency
Status values (`'active'`, `'spare'`, `'inactive'`, etc.) are raw strings scattered through server and client. Siphon breakers insert `'Spare'` (capital S) in one code path and `'spare'` (lowercase) in another. Queries use `LOWER(status)` to compensate, leaving the underlying data inconsistent.

**4.5** No migration runner or schema version tracking
`db/migrations/` has 9 numbered SQL files but no runner, no schema version table, and no documentation of what state the DB is assumed to start from. Deployers must track applied migrations manually.

**4.6** `server.js` is a single ~2,276-line file
All routes, middleware, auth, helpers, and report generation live in one file. Splitting into route modules (`routes/auth.js`, `routes/readings.js`, `routes/maintenance.js`, `routes/reports.js`) would improve navigation as the app continues to grow.
