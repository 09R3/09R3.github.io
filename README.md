# 09R3.github.io

Field operations software for the Kern County Water Agency / Cross Valley Canal.
This repo holds two apps; this README covers **WaterMark**.

---

# WaterMark

A mobile-first PWA (`watermark/`) that field operators use on phones and tablets
to record readings, log maintenance, and monitor plants in real time. It is the
data-entry side of the system — everything it captures lands in a shared
PostgreSQL database (`waterops`).

## How it fits together

```
 phone / tablet / desktop browser
        │  (installable PWA, works offline)
        ▼
 watermark/public/         static front end — no build step, no framework
   index.html              every screen, as hidden divs
   app.js                  screens, forms, offline queue, reports
   scada.js                SCADA dashboard (charts, live stream)
   style.css               theming (dark default, light option)
   sw.js                   service worker: app-shell + API cache
        │  fetch / SSE
        ▼
 watermark/server.js       single-file Express API (~199 routes)
        ├── PostgreSQL      all operational records
        ├── InfluxDB        SCADA tag history + live values
        └── /uploads        photos, invoices, label/SDS PDFs
```

There is **no build step**. The front end is plain HTML/CSS/JS served straight
from `watermark/public/`, so a change is live on reload. `server.js` is a single
Express file holding every endpoint, the schema bootstrap, and auth.

## Architecture notes

**No framework.** Screens are `<div>`s in one `index.html`, shown and hidden by
`showScreen()`. Lists and forms are built as HTML strings and injected with
`innerHTML` — always escaped through `escHtml()`.

**Schema bootstrap.** There is no migration runner. Tables and columns are
created at boot with `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` at the top of `server.js`, so a
deploy self-applies on restart.

**Offline first.** Operators frequently work with no signal. Saves that fail are
written to IndexedDB (`watermark-offline`) and replayed when the connection
returns; the dashboard shows a pending-sync card with the queued count. The
service worker caches the app shell plus successful API `GET`s.

**Auth.** Session cookie (`fo_session`), bcrypt passwords, per-role gating.
Roles: `admin`, `supervisor`, `water-planner` (all supervisor-level), plus
`operator`, `systems-operator`, `heavy-equipment-operator`, `pump-tech`,
`elec-tech`. UI gating is always mirrored by a server-side check.

## What's in it

**Readings** — the core daily work. Pumping plants (hours, kWh, air
compressors), wells, canal structures, vehicles/heavy equipment (odometer and
engine hours), KF monthly depth-to-water, ponds (staff gauges and gate flows),
and well runs (DWR, KCWA piezometers, and the Kern Fan purge program with its
EC/pH meter calibration logs). Each item expands to a form, saves individually,
and shows status at a glance plus history and notes.

**Maintenance** — vehicle, equipment and building maintenance records, well /
building / equipment / canal / dirt-work issue tracking, PM records and
checklists, and equipment swaps. Records carry status (open → in progress →
resolved), cost, PO number, and photo/invoice attachments.

**SCADA dashboard** — live plant data from InfluxDB over SSE. Plant overview
cards with pump counts, sensor levels and computed flow; per-plant detail with
sensor tiles, pump cards and trend charts; multi-tag trends; pump run-hour and
reverse-flow totals; and power monitoring. Charts support drag-select statistics
(high, low, difference, standard deviation).

**Reports** — vehicle mileage and last service, KF completion, maintenance
issues, PM grids, piezometers, canal readings, pond levels and well readings.
Every report exports to CSV, Excel or PDF.

**Charts** — lookup tables and calculators used in the field: overpour weirs,
gate discharge, pressure, open air, P-11, and the RRB T.O. and Pioneer Inlet
sharp-crested weir charts.

**Safety** — safety meetings with drawn-signature sign-in sheets, and JHAs
(Job Hazard Analysis) built from templates, signed on-device and exported to PDF.

**Pesticides** — product list with label and SDS PDFs, usage logging,
application locations, a treatment checklist, and monthly reporting.

**Water orders** — the Cross Valley Canal water order sheet. Supervisors enter
the CFS, time of change and comments for each inflow and outflow line for a
given date (including future dates) under Settings → Widgets → Water Orders. The
dashboard widget shows DWR Order, Inflow and Outflow totals for today and opens
the full order laid out like the paper sheet.

The Wells (Total Recovery) inflow line is not entered — it is computed from the
Running Wells setting (running wells in Pools 1–6 that are on, plus the per-pool
extras) and is always current, so a future-dated order shows present recovery
rather than a forecast. Tapping that line opens the Running Wells list.

DWR Order is the CA Aqueduct inflow; when that is zero or blank and water is
going back to the aqueduct instead, the widget shows the CA Aqueduct - Reverse
figure marked `(rev)`.

**HR** — time-off requests and a charge-code reference with a split calculator
that breaks hours across codes to the nearest quarter hour.

**Tools & admin** — user management, SCADA access control, GPS location and pond
GPS pickers, an EXIF reader, a SCADA scaling tester, bug reporting, and a global
search across wells, vehicles, piezometers and structures.

## Running it

```bash
cd watermark
npm install
node server.js          # serves the API and public/ on PORT (default 4000)
```

Configuration is via environment variables (`.env`):

| Variable | Purpose |
|----------|---------|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | PostgreSQL connection |
| `INFLUX_URL` `INFLUX_TOKEN` `INFLUX_ORG` `INFLUX_BUCKET` | SCADA history + live tags |
| `PORT` | HTTP port (defaults to 4000; deployed on 3067, beta on 3066) |

SCADA plant/tag layout lives in `watermark/scada-config.json`, so sites, pumps
and sensors can change without touching code.

Timestamps are stored as naive local (Pacific) date + time columns; the pool
sets `timezone = 'America/Los_Angeles'` on every connection so interval maths
against `NOW()` behaves.

## Conventions

Contributor rules — UI/UX standards, version bumping, branch policy and the
full database schema — live in [`CLAUDE.md`](CLAUDE.md). The short version:

- **Branches:** WaterMark work goes to `Watermark-beta`; never push to `main`.
- **Version bump:** every change to `watermark/` bumps the version in
  `public/index.html` (two places) **and** the cache name in `public/sw.js`.
  They must match — the cache name is what invalidates the service worker.

---

## WaterMark — Ponds Screen Sort Order

The ponds screen is ordered entirely by `sort_order` columns in the database.
Update these values directly in SQL to control the display order.

| Level | Table | Column | Controls |
|-------|-------|--------|----------|
| 1 — Section | `pond_locations` | `sort_order` | Order of location sections (e.g. Pioneer North, Pioneer South) |
| 2 — Card | `ponds` / `river_outlets` | `sort_order` | Order of pond/outlet cards within a section |
| 3 — Connection | `pond_connections` | `sort_order` | Order of connection rows within a card |
| 4 — Gate | `pond_gates` | `sort_order` | Order of gate rows within a connection |

All `sort_order` columns default to `0`. Rows with the same value sort in undefined order,
so use unique integers (1, 2, 3…) for anything that needs a guaranteed sequence.

### Example

```sql
-- Reorder location sections
UPDATE pond_locations SET sort_order = 1 WHERE name = 'Pioneer North';
UPDATE pond_locations SET sort_order = 2 WHERE name = 'Pioneer South';

-- Reorder pond/outlet cards within a section
UPDATE ponds        SET sort_order = 1 WHERE name = 'East Pond';
UPDATE ponds        SET sort_order = 2 WHERE name = 'West Pond';
UPDATE river_outlets SET sort_order = 3 WHERE name = 'Basin 9';

-- Reorder connections within a card
UPDATE pond_connections SET sort_order = 1 WHERE connection_id = 5;

-- Reorder gates within a connection
UPDATE pond_gates SET sort_order = 1 WHERE gate_id = 12;
```

### Staff gauge maximum and retiring a pond

`max_gauge` is editable in the app: **Settings → Staff Gauges** (supervisor and
admin only) lists every pond and river outlet grouped by location and saves
straight to the `max_gauge` column. `active` is still SQL-only.

| Column | Table | Effect |
|--------|-------|--------|
| `max_gauge` | `ponds`, `river_outlets` | `NUMERIC`. When set, the reading form shows `Max: 12.50 ft` under the **Staff Gauge** label. Leave `NULL` to show nothing. |
| `active` | `ponds` | `BOOLEAN DEFAULT TRUE`. Set `FALSE` to drop the pond off the Ponds reading screen without deleting it or its history. |

```sql
-- Staff gauge ceiling (or use Settings → Staff Gauges)
UPDATE ponds         SET max_gauge = 12.50 WHERE name = 'East Pond';
UPDATE river_outlets SET max_gauge = 15.75 WHERE name = 'Basin 9';

-- Retire a pond from the reading list (history is kept)
UPDATE ponds SET active = FALSE WHERE name = 'Retired Pond';
UPDATE ponds SET active = TRUE  WHERE name = 'Retired Pond';   -- bring it back
```

`active` is filtered as `IS NOT FALSE`, so a pond whose `active` is `NULL`
still appears — losing a pond off the reading screen is worse than showing a
retired one. `river_outlets` already had its own `active` column and is
unchanged (it filters on `= true`).

Scope: `active` hides the pond from the **Ponds reading screen only**. It still
appears in the ponds report, the polygon map and the GPS picker, so history
stays reachable and the pond can still be configured.

---

## WaterMark — Pond Map Locations (`pond_points`)

The polygon map shown when tapping a card's map button is built from points stored in
`pond_points`. Each row is one corner of the polygon. After migration 016, the table
supports both regular ponds and river outlets.

### Table structure

```
pond_points
  point_id    SERIAL PRIMARY KEY
  pond_id     INT REFERENCES ponds(pond_id) ON DELETE CASCADE      -- set for pond polygons
  outlet_id   INT REFERENCES river_outlets(outlet_id) ON DELETE CASCADE  -- set for outlet polygons
  name        TEXT        -- denormalized entity name (for easy querying)
  point_order INT         -- 1, 2, 3, … corner order matters for polygon shape
  geom        GEOMETRY(Point, 4326)  -- lon/lat WGS-84
```

Exactly one of `pond_id` or `outlet_id` must be set per row (enforced by CHECK constraint).

### Adding polygon points

```sql
-- Pond polygon (use pond_id)
INSERT INTO pond_points (pond_id, name, point_order, geom) VALUES
  (3, 'East Pond', 1, ST_SetSRID(ST_MakePoint(-119.4521, 35.3712), 4326)),
  (3, 'East Pond', 2, ST_SetSRID(ST_MakePoint(-119.4498, 35.3712), 4326)),
  (3, 'East Pond', 3, ST_SetSRID(ST_MakePoint(-119.4498, 35.3695), 4326)),
  (3, 'East Pond', 4, ST_SetSRID(ST_MakePoint(-119.4521, 35.3695), 4326));

-- River outlet polygon (use outlet_id)
INSERT INTO pond_points (outlet_id, name, point_order, geom) VALUES
  (2, 'Basin 9', 1, ST_SetSRID(ST_MakePoint(-119.4610, 35.3750), 4326)),
  (2, 'Basin 9', 2, ST_SetSRID(ST_MakePoint(-119.4585, 35.3750), 4326)),
  (2, 'Basin 9', 3, ST_SetSRID(ST_MakePoint(-119.4585, 35.3730), 4326)),
  (2, 'Basin 9', 4, ST_SetSRID(ST_MakePoint(-119.4610, 35.3730), 4326));
```

Use the **Pond GPS Picker** (Settings → tap version 5× → Pond GPS Picker) to capture
coordinates on a satellite map and generate the INSERT statements automatically.
Select `pond_id` or `outlet_id` from the Type dropdown before clicking points.

At least 3 points are required before a polygon is drawn. The map also shows:
- **Blue label** — staff gauge location (`ponds.gauge_lat/gauge_lon` or `river_outlets.gauge_lat/gauge_lon`)
- **Orange labels** — gate locations (`pond_connections.gate_lat/gate_lon`)

Use the GPS Picker's **UPDATE existing row** mode to set those lat/lon columns.
