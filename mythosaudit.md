# WaterMark Project Audit — `mythosaudit.md`

**Date:** 2026-06-09
**Scope:** `watermark/` (server.js v2.36, app.js, index.html, style.css, sw.js, deploy scripts, Dockerfile) plus repo root files.
**Not covered:** `water-ops-viewer/` (FieldView) — it is not checked out in this working copy. `watermark/public/marv-site` is an external submodule (icons) and was not audited.

> No changes have been made. Every item below is a proposal awaiting approval.
> Findings marked ✅ were manually verified in code; line numbers reference current `Watermark-beta`.

---

## 1. Security

### 1.1 High

| # | Finding | Location | Detail |
|---|---------|----------|--------|
| S-1 | **Legacy plaintext password fallback** ✅ | `server.js:415-426` | Login compares `user.password === password` when the stored value isn't a bcrypt hash, and auto-upgrades on success. Any user who hasn't logged in since hashing was added still has a plaintext password in the DB. A DB leak exposes those directly. **Fix:** one-time migration — force-hash or force-reset all non-`$2…` passwords, then delete the fallback branch. |
| S-2 | **No rate limiting on login or download-token endpoints** ✅ | `server.js` (`/auth/login`, `/api/reports/download-token`) | Unlimited password guesses; download tokens are only 16 bytes (`crypto.randomBytes(16)`, line ~2922) and brute-forceable in principle. **Fix:** add `express-rate-limit` (e.g. 5 attempts / 15 min on login), bump tokens to 32 bytes. |
| S-3 | **DB error messages returned to clients** ✅ | ~80 endpoints, e.g. `server.js:925` | `res.status(500).json({ error: err.message })` leaks table/column names and constraint details. **Fix:** log full error server-side, return a generic message. (One sweep with a small helper.) |
| S-4 | **CDN scripts loaded without Subresource Integrity** ✅ | `index.html:15-17`; `app.js:3991, 5117`; `tools/exif.html:7,9` | Leaflet (unpkg), html2pdf, jspdf, exif-js (cdnjs) load with no `integrity`/`crossorigin`. A CDN compromise = full app compromise (and this app handles auth cookies). **Fix:** pin SRI hashes, or better, self-host these four libraries (also improves offline behavior for a field PWA). |
| S-5 | **Service worker caches all `/api/` GET responses and never clears them on logout** ✅ | `sw.js:28-39` | User lists, readings, report data persist in the Cache API after logout on a shared device. **Fix:** message the SW from the logout handler to purge the cache (or use a per-session cache name). |

### 1.2 Medium

| # | Finding | Location | Detail |
|---|---------|----------|--------|
| S-6 | **Upload file-type check trusts client mimetype; extension preserved** ✅ | `server.js:46-71` | `fileFilter` tests `file.mimetype` (client-controlled) but the saved filename keeps the original extension. An attacker can upload `evil.html` with mimetype `image/png`; `express.static` then serves it as `text/html` → stored XSS for any logged-in viewer. Mitigated by `/uploads` requiring auth, but still in-session XSS. **Fix:** whitelist extensions too, and/or serve `/uploads` with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`. |
| S-7 | **Upload filename collisions silently overwrite** ✅ | `server.js:57-62` | Filename = sanitized original name only — two uploads named `invoice.pdf` in the same category/month overwrite each other. **Fix:** append a short timestamp/random suffix. |
| S-8 | **Sessions and download tokens in in-memory Maps** ✅ | `server.js:350, ~2920` | Container restart logs out everyone; expired entries are never evicted (slow memory growth). **Fix (cheap):** periodic sweep of expired entries. **Fix (proper):** persist sessions (DB table or Redis). |
| S-9 | **No security headers** | `server.js:30-34` | No `helmet`: missing CSP, `X-Content-Type-Options`, `X-Frame-Options`, etc. The 81 inline styles and 2 inline scripts in index.html would need `unsafe-inline` or refactoring for a strict CSP — start with the easy headers. |
| S-10 | **`/api/db-status` leaks raw DB error text pre-auth** | `server.js:~502` | Intentional pre-login endpoint, but it returns `err.message` (can include host/credential hints). Return a boolean only. |
| S-11 | **No session-cookie `sameSite` set** ✅ | `server.js:438, 487` | `httpOnly` ✓, `secure: req.secure` ✓, but `sameSite` unset (browser-default Lax). With cookie auth and no CSRF tokens, state-changing POSTs rely on that default. **Fix:** set `sameSite: 'lax'` explicitly (one-word change). |
| S-12 | **Migration errors silently swallowed** ✅ | `server.js:141-346` | Every `CREATE TABLE/ALTER` ends in `.catch(err => console.error(...))`. A failed migration leaves the app running against a half-migrated schema with cryptic downstream errors. **Fix:** run migrations sequentially in one async function; exit (or at least loudly flag) on failure. |

### 1.3 Low / informational

- **`tools/exif.html`** — standalone EXIF debug page in production `public/`, with its own CDN deps and Google-Fonts import. If it's no longer used (app.js now reads EXIF natively), delete it.
- **Synchronous `fs` calls in request handlers** (`server.js:54, 97-110, 125, 2910`) — `readdirSync` + double `statSync` per file in `/api/tools/files` blocks the event loop; also a minor DoS vector on big directories. Switch to `fs.promises`.
- **No `process.on('unhandledRejection')` handler** — add one for crash diagnostics.
- **Connection pool has no idle/statement timeouts** (`server.js:130-138`) — add `idleTimeoutMillis` and a `statement_timeout`.
- **Deploy scripts / Dockerfile contain no real secrets** ✅ (only `your_password` placeholders) — good. Dockerfile runs as root; adding a `USER node` line is cheap hardening.
- **False positive corrected:** an automated pass flagged `deleteReading()` (`server.js:899-927`) as critical SQL injection. Verified ✅: `table`/`idCol` are hardcoded literals at all 11 call sites — **not injectable**. It's still a fragile pattern; a one-line whitelist assertion inside the helper would future-proof it. Same verdict for the TABLE_MAP-validated equipment-swap queries.
- **Frontend XSS posture is good** ✅ — `escHtml()` is used consistently across the ~355 `innerHTML` interpolations sampled; no unescaped user-data sink was found. No passwords/tokens in localStorage (only the non-sensitive user object).

---

## 2. Redundancy / Dead Code

| # | Finding | Location | Detail |
|---|---------|----------|--------|
| R-1 | **Four near-identical issue-CRUD blocks (frontend)** | `app.js` ~1880-3025 | Wells / Buildings / Equipment / Canal issues each repeat ~250-300 LOC of init/load/render/badge/listener code. A config-driven factory would cut ~1,200 LOC to ~400 and make the next issue type (and the new filter bars) one config entry instead of a copy-paste. |
| R-2 | **Four near-identical issue-CRUD endpoint groups (backend)** | `server.js:2128-2410` | Same GET/POST/PATCH shape for the four issue tables. A shared handler parameterized by a whitelist config halves ~300 LOC. |
| R-3 | **Attachment-card rendering duplicated 5×** | `app.js:2092, 2369, 2654, 2987, +1` | Identical map-to-HTML + listener block. Extract `renderAttachmentCards(area, atts)`. |
| R-4 | **Dead "equipment" maintenance branch** | `index.html:779-783` + `app.js:4111-4118` | Hidden stub inputs and a save-handler branch the UI can never reach (`maintType` is never `'equipment'`). Already noted in `todo.md` 2.1.2. Remove both, or wire up the UI. |
| R-5 | **Duplicate `.placeholder-msg` rule with conflicting padding** ✅ | `style.css:820` and `:1994` | Second definition (24px) silently overrides the first (48px 16px) — placeholder spacing isn't what the first rule says. Keep one. |
| R-6 | **81 inline `style=""` attributes** | `index.html` throughout | Mostly small dim-label/spacing tweaks duplicating existing utility patterns. Worth consolidating opportunistically (also a prerequisite for a real CSP). |
| R-7 | **Stale `todo.md`** | `watermark/todo.md` | Items 1.1.1, 1.2.1, 2.1.1, 3.1.1 verified done; entries not cleaned up. |
| R-8 | **`deleteReading` vs `deleteHistoryReading`** | `server.js:899, 1907-1963` | Two implementations of the same role/24-hour permission logic. Consolidate so a future permission change can't drift. |

---

## 3. Efficiency

| # | Finding | Location | Detail |
|---|---------|----------|--------|
| E-1 | **Listener accumulation in `renderCanalNewPhotoList()`** ✅ | `app.js:2841-2889` | Each render re-attaches `.canal-new-aq-remove` / `.canal-aq-map-btn` click listeners without cleanup, and the function re-runs once per photo as EXIF GPS resolves — handlers can fire multiple times per tap. **Fix:** event delegation on the container, render once after `Promise.all`. *(This one is an actual bug, not just inefficiency.)* |
| E-2 | **Full list re-fetch + re-render after every issue save** | `app.js:2136, 2411, 2698, 3016` | Saving one issue reloads and rebuilds the whole list. Fine at current data sizes; becomes sluggish as issue history grows. Low priority unless operators notice. |
| E-3 | **Service worker SHELL doesn't pre-cache icons** ✅ | `sw.js:2` | `SHELL = ['/', '/app.js', '/style.css', '/manifest.json']` — KCWA seal PNGs and the marv-site SVG icons aren't pre-cached, so first offline launch shows broken icons. Add them (or a runtime image-cache rule). |
| E-4 | **`kcwa-seal.png` is 888 KB** ✅ | `public/icons/` | The 512px variant (352 KB) already exists; the 888 KB original likely never needs to be served. Compress or stop referencing it. |
| E-5 | **`/api/tools/files` does sync I/O + double `statSync` per file** | `server.js:97-110` | Same as S-list note; one `stat` per file, async. |
| E-6 | **Report queries without pagination** | several `/api/reports/*` | Acceptable today; flag for when tables hit tens of thousands of rows. |

---

## 4. Reliability

| # | Finding | Location | Detail |
|---|---------|----------|--------|
| Q-1 | **Silently swallowed dropdown-load errors** | `app.js:1891, 2158, 11743, …` | `.catch(() => {})` on dropdown population — a failed load leaves an empty select with no feedback. Show a toast or placeholder option. |
| Q-2 | **Version string maintained in 3 places by hand** | `index.html` ×2, `sw.js` | Known process (documented in CLAUDE.md) but it has already drifted once this session (agent bumped to v2.24 against a v2.34 remote). Lowest-effort guard: a tiny pre-commit/CI check that the three strings match. |
| Q-3 | **Rollback failures masked in batch-save transaction** | `server.js:843-895` | If `ROLLBACK` itself throws (dead connection), the original error is replaced. Wrap rollback in its own try/catch. |
| Q-4 | **Mixed date-handling helpers** | `app.js:53-80` | `todayISO` / `localDateStr` / `fmtDate` use three different timezone strategies. Currently correct, but consolidation would prevent the classic off-by-one-day bug from re-appearing. |

---

## 5. Recommended Action Plan (prioritized)

**Phase 1 — Security quick wins (small diffs, high value)**
1. ✔️ **DONE (v2.41)** S-3: error-message sanitization sweep — `handleErr()` helper, 125 endpoints now return "Server error. Check Docker logs for more information."
2. ✔️ **DONE (v2.41)** S-2: login rate limit (5 failures / 15 min per username+IP, no external dependency); 32-byte download tokens. Lockout clears instantly when an admin resets the user's password (or on any successful login).
3. ✔️ **DONE (v2.41)** S-11: `sameSite: 'lax'` on the session cookie (both set locations).
4. ✔️ **DONE (v2.41)** S-5: SW purges cached `/api/` data on logout **and** when an expired session is detected at app launch. App shell stays cached for offline.
5. ✔️ **DONE (v2.41)** S-6/S-7: extension whitelist + unique filename suffix + `nosniff` on `/uploads`.
6. ⏸ **HANDLED MANUALLY** S-1: admin will reset any plaintext accounts directly; code fallback left in place. Check who's affected with: `SELECT username FROM users WHERE password NOT LIKE '$2%';`

**Phase 2 — Hardening & hygiene**
7. ⏳ **PENDING DECISION** S-4: SRI hashes or self-host the 4 CDN libraries. (Self-hosting stores files on the *server*, not user devices — see discussion.)
8. ✔️ **DONE (v2.41)** E-1: canal-photo listeners converted to event delegation (real bug).
9. ⏸ **DEFERRED** S-12: sequential, fail-loud migrations — waiting per owner.
10. R-4, R-5, R-7: delete dead equipment branch, dup CSS rule, stale todo items; remove `tools/exif.html` if unused.
11. E-3/E-4: SW icon caching + seal compression.
12. S-8: expired-session sweep; helmet baseline (S-9).

**Phase 3 — Structural refactors (bigger diffs, do incrementally)**
13. R-1/R-3: frontend issue-panel factory + shared attachment renderer.
14. R-2/R-8: backend issue-endpoint and delete-permission consolidation.
15. Q-1, Q-3, Q-4, E-2, E-5 as opportunistic cleanups.

---

## 6. Explicitly *not* recommended right now

- Framework migration / TypeScript rewrite — vanilla JS is working and the team knows it.
- Pagination everywhere (E-6) — premature at current data volume.
- Strict CSP — blocked on inline style/script cleanup (R-6); do the cheap headers first.
- Redis session store — a DB-backed sessions table is plenty at this scale, and only if restart-logouts actually bother operators.
