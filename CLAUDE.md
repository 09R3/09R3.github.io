# Claude Instructions for 09R3.github.io

## Project Context

### WaterMark (`watermark/`)
A mobile-friendly PWA used by field operators to take readings, log maintenance
and report issues from the field. Readings are saved into a PostgreSQL
database; it also has a live SCADA dashboard (InfluxDB), reference charts,
reports with CSV/Excel/PDF export, safety records (meetings + JHA), pesticide
tracking and HR tools. Works offline and queues entries for later sync.
See `README.md` for a fuller tour.

### FieldView (`water-ops-viewer/`)
A database viewer used to access, organize, sort, and analyze the data entered
by field operators. Includes report generation and CSV/Excel/PDF export.

---

## Ports & Deployments

| App | Branch | Appdata Path | Port |
|-----|--------|-------------|------|
| WaterMark | `main` | `/mnt/user/appdata/watermark` | 3067 |
| WaterMark | beta (`Watermark-beta`) | `/mnt/user/appdata/watermark-beta` | 3066 |
| FieldView | `Fieldview` | `/mnt/user/appdata/fieldview` | 3069 |
| FieldView | beta (`Fieldview-beta`) | `/mnt/user/appdata/fieldview-beta` | 3068 |

---
If any deploy.sh files are updated remind me to update the one on the server.

---

## Branch Strategy

- **water-ops-viewer** changes → branch `Fieldview-beta`
- **watermark** changes → branch `Watermark-beta`
- Never push directly to `main` or `Fieldview`

---

## Version Bumping

**Whenever changes are made to files inside `water-ops-viewer/`**, bump the
patch version in `water-ops-viewer/package.json` before committing.

Use semantic versioning — patch for fixes/small changes, minor for new features:
- Bug fix or tweak → `1.1.0` → `1.1.1`
- New feature → `1.1.0` → `1.2.0`

The version is displayed in the app UI (sidebar footer) and read from
`package.json` via the `/api/version` endpoint — no other files need updating.

**Whenever changes are made to files inside `watermark/`**, bump the version in
both `watermark/public/index.html` (two places: login footer and settings row)
and `watermark/public/sw.js` (cache name) before committing.

Use simple incrementing minor versions — bump for any change:
- Any fix or feature → `v 3.17` → `v 3.18`

Both files must match. The cache name in `sw.js` controls service worker
invalidation, so it must always be updated alongside `index.html`.

## Field Ops UI/UX Standards

These standards apply to all current and future work on `watermark/`. When
adding new screens or features, match the patterns below. When fixing bugs,
bring the affected area into compliance if it isn't already.

---

### Save Buttons

- All save/submit actions use `.btn-save` (green background).
- Never use `.btn-primary` (blue) for a save or submit action — blue is for
  non-destructive navigation or secondary actions only.
- **Pumping Plant** is the only screen that uses a single batch-save button
  for all readings at once. This is intentional — all PP readings are taken at
  the same location at the same time. All other reading screens save each item
  individually from within its expanded row.

---

### Status Indicators

Each reading type has its own status logic. The pattern is always: a colored
dot (`.status-dot`) for at-a-glance status + a badge (`.status-badge`) for
detail text. Specific rules per screen:

- **Wells** (daily readings): dot + badge. Green dot = read within 8 hours,
  yellow = not yet read today, no red needed. Badge shows time ago in hours
  (e.g., "2h ago") or "Not read".
- **Vehicles / KF Monthly** (monthly readings): dot + badge. Green = read
  within the expected cycle, yellow = not yet read this cycle. Badge shows the
  **date** of the last reading (e.g., "Apr 10"), not days-ago text.
- **Canal Structures**: badge only (no dot). Badge shows the last recorded
  flow value. Badge turns green if read the same day, orange otherwise. Do not
  add a dot — the flow value itself is the useful indicator.
- **Pumping Plant**: no dot or badge. Instead, the row label text (e.g.,
  "Pump Hours A") turns green if that reading was saved within the last
  10 hours. No red or orange state — PP readings are only entered when the
  pump has run, so missing readings are normal and should not be flagged.
- **Well Runs (DWR / KCWA Piezometers)**: no dot. Show the previous reading
  date as plain text. Text turns green if read within the last 30 days.

---

### Notes Fields

- All screens use an **inline multi-line textarea** for notes. No modal, no
  "+" expand button.
- The textarea is always visible within the expanded item form (not hidden
  behind a button).
- If a note is long and gets clipped, operators can tap the History button to
  see the full note in the history modal.
- The Pumping Plant notes modal (`#notes-modal`) and its "+" trigger button are
  removed — PP notes are inline like everything else, except this section notes are only one line. 

---

### Navigation & Back Buttons

Every non-dashboard screen shows a **single "‹ Back" button** as the first
element inside the screen content area (injected by JS, not in HTML). The
hamburger menu stays in the fixed header unchanged.

**Back button rules:**
- Button text is always just `‹ Back` — no parent label, no current location.
- Back always goes exactly one level up regardless of navigation depth.
- Button has `min-height: 44px` so it is comfortably tappable on mobile.
- For quick jumps to any screen, operators use the hamburger menu.

**App header title (yellow strip at top):**
- The header title updates dynamically on every navigation transition via
  `el('screen-title').textContent`.
- Main screens: show the screen name (e.g., `"Maintenance Log"`).
- Sub-panels: show `"Screen - Sub-panel"` (e.g., `"Maintenance Log - Vehicle Maintenance"`).
- Three-level depth: `"Maintenance Log - PM Records - A Plant Electrical PM"`.
- Dashboard always shows `"Field Ops"`.

**Swipe to go back:**
- Left-edge swipe gesture on every screen container.
- Triggers the same action as tapping Back — one level up.
- Use `touchstart` / `touchend`; only trigger if `touchstart.clientX < 30px`
  and horizontal delta > 60px.

**Implementation — two shared helpers in `app.js`:**

```javascript
// Call on every screen/panel transition. Updates header title, injects or
// updates the ‹ Back button at the top of screenEl, wires swipe-back.
function setPanelNav(screenEl, backFn, headerTitle)

// Attaches a left-edge swipe-back gesture to a container. Cleans up any
// previous listener on the same element before re-attaching.
function addSwipeBack(containerEl, backFn)
```

`setPanelNav` finds or creates a `.panel-nav-bar > .panel-nav-back` inside
`screenEl` and always updates `btn.onclick = backFn` so subsequent calls
always point back to the right level.

Do **not** put static `panel-nav-bar` HTML inside sub-panels — the nav bar
lives only at the screen level and is fully managed by JS.

---

### Date/Time Inputs

- All date and time inputs use the **small variant** (`.ctrl-input-sm` class).
- This applies everywhere: reading screens, sub-panels, maintenance forms.
- Do not use full-size inputs for date/time.

---

### Operator / Performed By Auto-fill

- Any field labeled **"Operator"** auto-fills with `currentUser.initials` on
  item expand (if the field is empty).
- Any field labeled **"Performed By"** in maintenance forms auto-fills with
  `currentUser.full_name` on form open (if the field is empty).
- Auto-fill only sets a default — the operator can always change it.

---

### Form Validation

- Required fields should be kept minimal. Each screen only enforces what is
  truly necessary for the record to be useful.
- **KF Monthly**: DTW is not required. However, if DTW is left blank, the
  **notes field becomes required** (operator must explain why no reading was
  taken). Show an inline error if both are empty on save.
- Other reading screens: no required fields beyond what the data model demands.
- Each screen is allowed to have its own specific validation rules as needed —
  just document them in a comment near the save function.

---

### Empty / Loading / Error States

Always use the `.placeholder-msg` CSS class. Never use screen-specific classes
like `.issue-empty` for this purpose. Text conventions:

| State   | Text                                 |
|---------|--------------------------------------|
| Loading | `"Loading…"`                         |
| Empty   | `"No [items] found."`                |
| Error   | `"Failed to load."`                  |

Example: `<div class="placeholder-msg">Loading…</div>`

---

### Attachments (Invoice / Photo)

- Attachments (invoice PDF + photos) are supported on: Vehicle Maintenance,
  Equipment Issues, Building Issues, Well Issues.
- Well Readings and PM Records do **not** have attachments — issues are logged
  in the appropriate maintenance section instead.
- **Layout order within a card**: Add Invoice button → Add Photo button →
  pending upload queue → already-uploaded files list. Uploaded files always
  appear **below** the add buttons, not above or mixed in.
- Filename convention: use the entity name (equipment name, building name,
  well name) in the filename, not `issue{id}`. Sanitize to alphanumeric +
  hyphens, max 40 chars.

---

### Permissions

- Roles come from `SUPERVISOR_ROLES` on the server (`supervisor`, `admin`,
  `water-planner`) and `isSupervisorLevel()` on the client.
- Several records use a **creator-or-supervisor** rule for editing: the record's
  `entered_by` matches the signed-in user, or the user is supervisor level.
  Used by vehicle maintenance records and purge readings.
- Hiding a button is never the control. Any UI gate must be mirrored with
  `requireRole(...)` or an explicit check in the endpoint.

---

### Reports & Exports

- The export modal always shows **CSV / Excel / PDF**. Each `exportContext`
  needs a branch in **all three** handlers — a missing branch falls through to
  the vehicles default and silently exports the wrong report.
- CSV and PDF are built client-side; Excel is generated server-side with the
  `xlsx` package behind a one-time download token (`/api/reports/download-token`).
- Wide tables get wrapped in `.report-scroll` so they scroll sideways rather
  than compressing columns off-screen.
- Destructive buttons use `.btn-danger`.

---

### Files & Sharing

- `shareFile()` uses the Web Share sheet **only on touch devices**
  (`(hover: none) and (pointer: coarse)`). Desktop Chrome reports
  `canShare({files})` as true but its flyout self-dismisses with an
  `AbortError`, which used to swallow the export. Desktop always downloads.
- Use `downloadBlob()` for downloads — it appends the anchor to the DOM before
  clicking (a detached anchor is ignored by some browsers) and revokes the URL.
- Uploads reuse `maintenance_attachments` keyed by `table_name` + `record_id`,
  served from `/uploads` behind session auth.

---

### Schema Changes

New tables and columns are created at server boot with
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` near
the top of `server.js`. There is no migration runner — adding one of these is
all that's needed, and it applies on the next restart.

Table and column names must never come from a request. Where an endpoint is
generic (history, notes, calibration logs, pesticide docs) the identifiers are
looked up from a server-side map and the request only supplies a key.

---

## Database Schema

Generated from the live `waterops` dump (PostgreSQL 17.5). Column notation:
`col(PK)` = primary key, `col(→table)` = foreign key, and a type is noted only
where it matters (`jsonb`, `text[]`, `NUMERIC`, `DOUBLE`, geometry).

```
_waterops_saved_queries    id(PK), name, sql, created_by, created_at
air_compressors            compressor_id(PK), building_id(→buildings), serial_number, manufacturer, model_number, install_date, certification_expiry_date, status, notes
app_settings               key(PK), value, updated_at
bug_reports                report_id(PK), submitted_by, submitted_at, screen_area, severity, is_repeatable, description, app_version, resolved, resolved_by, resolved_at
building_issues            issue_id(PK), building_id(→buildings), site_id(→sites), building_name, site_name, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost(NUMERIC)
buildings                  building_id(PK), site_id(→sites), building_letter, building_name, notes
cal_log_ec                 cal_id(PK), cal_date, cal_time, cal_std_lot, cal_pass, check_std_lot, check_value(NUMERIC), tech, notes, entered_by, created_at
cal_log_ph                 cal_id(PK), cal_date, cal_time, buffer_401_lot, buffer_700_lot, buffer_1001_lot, errors, cv_lot, cv_value(NUMERIC), tech, notes, entered_by, created_at
canal_issues               issue_id(PK), pool, status, description, reported_date, entered_by, action_taken, resolution_notes, po_number, cost(NUMERIC), notes, gps_lat(DOUBLE), gps_lon(DOUBLE), created_at, updated_at
canal_structures           structure_id(PK), structure_name, structure_type, flow_direction, in_service, constructed_date, gate_capacity(NUMERIC), design_capacity(NUMERIC), operational_capacity(NUMERIC), owner, who_maintains, gps_latitude(NUMERIC), gps_longitude(NUMERIC), has_flow_meter, meter_type, meter_model, meter_status, formula_or_chart_ref, notes
charge_code_splits         split_id(PK), name, components(jsonb), status, created_by, created_at, updated_at
charge_codes               code_id(PK), code, description, status, created_by, created_at, updated_at
dirt_work_issues           issue_id(PK), pool, work_type, description, location_notes, reported_date, resolved_date, status, action_taken, resolution_notes, po_number, cost(NUMERIC), assigned_to, entered_by, notes, gps_lat(DOUBLE), gps_lon(DOUBLE), created_at, updated_at
equipment_issues           issue_id(PK), equipment_type, equipment_id, equipment_name, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost(NUMERIC)
equipment_swaps            swap_id(PK), category, swap_date, location, item_removed_id, item_installed_id, removed_description, installed_description, performed_by, notes, entered_by, created_at
jha                        jha_id(PK), title, work_location, jha_date, template_key, data(jsonb), completed_by, completed_by_date, status, created_by(→users), created_at, updated_at
jha_signatures             sig_id(PK), jha_id(→jha), full_name, signature_data, signed_date, created_at
maintenance_attachments    attachment_id(PK), table_name, record_id, rel_path, original_name, file_type, mime_type, uploaded_by, uploaded_at
maintenance_buildings      record_id(PK), building_id(→buildings), work_date, work_type, record_type, description, performed_by, is_contractor, entered_by, severity, status, cost(NUMERIC), po_number, resolution_notes, next_service_date, notes
maintenance_equipment      maintenance_id(PK), equipment_type, equipment_id, work_date, work_type, performed_by, is_contractor, entered_by, location_at_time, description, parts_used, cost(NUMERIC), po_number, hours_at_service(NUMERIC), next_service_date, notes
maintenance_vehicles       maintenance_id(PK), vehicle_id(→vehicles), work_date, work_type, performed_by, is_contractor, entered_by, description, odometer_at_service(NUMERIC), engine_hours_at_service(NUMERIC), parts_used, cost(NUMERIC), po_number, next_service_date, next_service_miles(NUMERIC), notes, next_service_hours(NUMERIC), status
motors                     motor_id(PK), serial_number, manufacturer, model_number, rated_hp(NUMERIC), frame_type, oil_capacity_upper_qt(NUMERIC), oil_capacity_lower_qt(NUMERIC), install_date_current, current_location, status, notes
pest_tasks                 task_id(PK), description, created_by, created_at, done, done_by, done_at
pesticide_usage            usage_id(PK), pesticide_id(→pesticides), used_date, used_time, applied_by(→users), quantity(NUMERIC), location_description, notes, created_at
pesticides                 pesticide_id(PK), name, epa_reg_number, unit_of_measure, active, created_at
pge_meters                 pge_meter_id(PK), building_id(→buildings), meter_name, meter_number, account_number, utility_provider, notes
piezometers                piezometer_id(PK), piezometer_name, pool, sort_order(NUMERIC), max_depth(NUMERIC), status, gps_latitude(NUMERIC), gps_longitude(NUMERIC), notes, original_name
pm_records                 pm_id(PK), pm_type, building, completed_date, completed_time, completed_by(→users), checklist(jsonb), notes, created_at
pond_connections           connection_id(PK), destination_pond_id(→ponds), name, source_type, source_canal_id(→canal_structures), sort_order, active, notes, source_river_id(→river_outlets), source_pond_id(→ponds), gate_lat(NUMERIC), gate_lon(NUMERIC)
pond_gates                 gate_id(PK), connection_id(→pond_connections), label, gate_type, width_in(NUMERIC), sort_order, active, notes
pond_locations             location_id(PK), name, sort_order
pond_points                point_id(PK), pond_id(→ponds), name, point_order, geom(GEOMETRY Point 4326), outlet_id(→river_outlets)
ponds                      pond_id(PK), location_id(→pond_locations), name, sort_order, notes, gauge_lat(NUMERIC), gauge_lon(NUMERIC)
power_monitors             monitor_id(PK), building_id(→buildings), monitor_number, manufacturer, ip_address, notes
pump_positions             position_id(PK), site_id(→sites), building_id(→buildings), pump_letter, rated_hp(NUMERIC), current_motor_id, current_pump_unit_id, status, notes
pump_units                 pump_unit_id(PK), serial_number, manufacturer, model_number, rated_hp(NUMERIC), frame_type, forward_flow_rating(NUMERIC), reverse_flow_rating(NUMERIC), install_date_current, current_location, status, notes
purge_readings             purge_id(PK), well_id(→wells), state_well_number, well_name, well_depth(NUMERIC), reading_date, casing_diameter, rp_to_water(NUMERIC), gallons_to_pump(NUMERIC), total_gallons_pumped(NUMERIC), start_time, start_meter(NUMERIC), rp_to_water_5min(NUMERIC), pumping_rate(NUMERIC), end_meter(NUMERIC), end_time, total_pump_min, ending_rp_to_water(NUMERIC), notes, entered_by, created_at, updated_at
readings_canal             reading_id(PK), structure_id(→canal_structures), reading_date, reading_time, entered_by, instantaneous_flow_cfs(NUMERIC), totalizer_reading_af(NUMERIC), gate_setting, head_reading_ft(NUMERIC), derived_flow_cfs(NUMERIC), notes
readings_compressor_hours  reading_id(PK), compressor_id(→air_compressors), reading_date, reading_time, hour_reading(NUMERIC), entered_by, notes
readings_kf_monthly        kf_reading_id(PK), well_id(→wells), reading_date, reading_time, dtw_reading(NUMERIC), operator, plopper_sounder, well_on_off, notes, common_name, wet_dry_moist, sounder_number
readings_pge_meters        reading_id(PK), pge_meter_id(→pge_meters), reading_date, reading_time, kwh_reading(NUMERIC), entered_by, notes
readings_piezometers       piezometer_reading_id(PK), piezometer_id(→piezometers), reading_date, reading_time, dtw_reading(NUMERIC), operator, plopper_sounder, wet_dry_moist, notes, sounder_number
readings_pond_gates        reading_id(PK), gate_id(→pond_gates), reading_date, reading_time, head_ft(NUMERIC), opening_in(NUMERIC), overpour_in(NUMERIC), flow_cfs(NUMERIC), entered_by, notes, created_at
readings_power_monitors    reading_id(PK), monitor_id(→power_monitors), reading_date, reading_time, kwh_reading(NUMERIC), entered_by, notes
readings_pump_hours        reading_id(PK), position_id(→pump_positions), reading_date, reading_time, hour_reading(NUMERIC), entered_by, notes
readings_run_dwr           reading_id(PK), well_id(→wells), reading_date, reading_time, depth_to_water(NUMERIC), method, operator, no_measurement(text[]), questionable_measurement(text[]), notes, entered_by, created_at, sounder_number
readings_staff_gauge       reading_id(PK), pond_id(→ponds), reading_date, reading_time, level_ft(NUMERIC), entered_by, notes, created_at, outlet_id(→river_outlets)
readings_vehicle_monthly   reading_id(PK), vehicle_id(→vehicles), vehicle_number, reading_date, reading_time, entered_by, odometer_miles(NUMERIC), engine_hours(NUMERIC), notes
readings_well              reading_id(PK), well_id(→wells), common_name, reading_date, reading_time, on_off, hour_reading(NUMERIC), flow_cfs(NUMERIC), totalizer(NUMERIC), motor_oil, dripper_oil(NUMERIC), pge_kwh(NUMERIC), entered_by, notes
river_outlets              outlet_id(PK), name, sort_order, active, notes, location_id(→pond_locations), gauge_lat(NUMERIC), gauge_lon(NUMERIC)
safety_meeting_attendees   attendee_id(PK), meeting_id(→safety_meetings), full_name, signature_data, signed_date, created_at
safety_meetings            meeting_id(PK), meeting_date, meeting_time, presented_by, topic, link, notes, created_by(→users), created_at, duration_min
scada_equipment            scada_id(PK), building_id(→buildings), equipment_number, equipment_name, manufacturer, ip_address, notes
siphon_breaker_swaps       swap_id(PK), swap_date, location, unit_removed_id(→siphon_breakers), unit_installed_id(→siphon_breakers), performed_by, notes, entered_by, created_at
siphon_breakers            pump_unit_id(PK), serial_number, manufacturer, model_number, operating_psi(NUMERIC), max_psi(NUMERIC), install_date_current, current_location, status, notes
sites                      site_id(PK), site_name, site_type, gps_latitude(NUMERIC), gps_longitude(NUMERIC), notes
spatial_ref_sys            srid(PK), auth_name, auth_srid, srtext, proj4text
users                      user_id(PK), username, full_name, role, password, initials, email, is_active
vehicles                   vehicle_id(PK), vehicle_number, vehicle_type, year, make, model, vin, license_plate, fuel_type, assigned_user, reading_type, status, notes
well_issues                issue_id(PK), well_id(→wells), well_name, well_area, status, description, reported_date, resolved_date, resolution_notes, entered_by, assigned_to, notes, created_at, updated_at, action_taken, po_number, cost(NUMERIC)
well_meters                well_meter_id(PK), manufacturer, model_number, serial_number, meter_type, status, well_id(→wells), notes, created_at
well_motors                well_motor_id(PK), manufacturer, model_number, serial_number, hp(NUMERIC), status, well_id(→wells), notes, created_at, frame_size, runtime_hours(NUMERIC)
well_sets                  set_id(PK), set_name, description
wells                      well_id(PK), common_name, state_well_number, area, discharge_pool, participant, agency, kf_set_id(→well_sets), well_type, total_depth_ft(NUMERIC), pump_hp(NUMERIC), pump_frame_size, pump_unit_id, status, gps_latitude(NUMERIC), gps_longitude(NUMERIC), notes, is_important, well_run, rp_elev(NUMERIC), gs_elev(NUMERIC), access, purge
```

Views (not tables): `pond_polygons` (pond points assembled into GeoJSON
polygons), plus the PostGIS `geometry_columns` / `geography_columns` system
views.
