# Well Readings — Design Reference

**Screen ID:** `screen-wells`  
**Files:** `watermark/public/index.html`, `watermark/public/app.js`, `watermark/public/style.css`

---

## Screen Entry & Navigation

- Accessed from the dashboard.
- `showScreen('wells')` calls `initWellsScreen()`.
- Header title: `"Well Readings"` (set via `el('screen-title').textContent`).
- Back button: `‹ Back` injected by `setPanelNav()` → returns to dashboard.
- Swipe-left from left edge also navigates back.

---

## Date / Time Bar

HTML in `index.html`. Located at the top of the screen, above the well list.

```
[ Date: <date input> ]  [ Time: <time input> ]
```

- **IDs:** `well-date`, `well-time`
- **CSS:** `.date-bar` (flexbox, border-bottom, padding, gap)
- **Input size:** `.ctrl-input-sm` (small variant, per UI standards)
- **On screen init:** `well-date` = today (`todayISO()`), `well-time` = current time (`nowHHMM()`).
- **On card expand:** `well-time` is updated to current time (if empty or on each open).
- **After save:** Time is NOT reset. It persists until the user changes it or re-expands a card.

---

## Data Loading

**Function:** `initWellsScreen()` (`app.js` ~line 1141)

- Guarded by `wellsLoaded` flag — loads only once per session.
- **API:** `GET /api/wells/operational`
- **Response fields per well:**
  - `well_id`, `common_name`, `area`
  - `gps_latitude`, `gps_longitude`
  - `hours_since_reading` (null = never read)
  - `last_hour_reading`, `last_flow_cfs`, `last_totalizer`
  - `last_dripper_oil`, `last_pge_kwh`, `last_notes`
  - `last_reading_date`, `last_reading_time`

**States:**
| State | Output |
|-------|--------|
| Loading | `<div class="placeholder-msg">Loading wells…</div>` |
| Empty | `<div class="placeholder-msg">No operational wells found.</div>` |
| Error | `<div class="placeholder-msg" style="color:var(--red-light)">…</div>` |

---

## Grouping & Collapsible Sections

Wells are grouped by the `area` field (null → `'Other'`).

Each area renders as a collapsible section:

```
▼  Area Name (N)                    [Map]
   ├── Well A  ● 2h ago
   ├── Well B  ● Not read
   └── Well C  ● Just read
```

- **Header CSS:** `.list-section-header` — clickable, chevron rotates 180° when open.
- **Items CSS:** `.list-section-items`
- **Default state:** Collapsed.
- **Map button** appears in the header only if ≥1 well in the area has GPS coordinates. Calls `openSetMapModal(area, areaWells)`.

---

## Well Card Layout

```
[ ● ]  Well Name                    [ badge ]  [ ▼ ]
```

**Collapsed:**
- `.list-item` — border, padding, rounded.
- Left: status dot (`.status-dot`)
- Center: well name (`.list-item-name`)
- Right: status badge (`.status-badge`) + expand chevron

**Expanded:**
- Card border color → `var(--accent)` (`.list-item.expanded`).
- Chevron rotates 180°.
- `.list-item-form` visible.

---

## Status Indicators

### Status Dot (`.status-dot`)
- Size: 8×8px circle, 50% border-radius, box-shadow halo (6px blur).

### Status Badge (`.status-badge`)
- Padding: 3px 8px, border-radius 4px, font-size 0.75rem.

### Logic (based on `hours_since_reading` from API):

| State | Condition | Dot Color | Badge Class | Badge Text |
|-------|-----------|-----------|-------------|------------|
| `due` | `hours_since_reading == null` (never read) | Yellow `#f57f17` | `.status-badge.due` | `"Not read"` |
| `done` | `hours_since_reading <= 8` | Green `#4caf50` | `.status-badge.done` | `"Just read"` or `"Xh ago"` |
| `overdue` | `hours_since_reading > 8` | Red `#ef5350` | `.status-badge.overdue` | `"Xh ago"` |

**Badge text rule:** `hrs < 1` → `"Just read"`, else `"${Math.round(hrs)}h ago"`, null → `"Not read"`.

**Session override:** Wells saved in the current session are tracked in `wellReadingsThisSession` (Map keyed by `well_id`). These show as `done` on the area map regardless of `hours_since_reading`.

---

## Expanded Form — Field Order

All inputs use `.ctrl-input` (number fields) or `.ctrl-textarea` (notes).

### Row 1: ON/OFF · Motor Oil
```
[ ON ] [ OFF ]          Motor Oil  [ Y ] [ N ]
```
- Toggle buttons (`.toggle-group` > `.toggle-btn`, `.toggle-btn.active`).
- Default: ON = active, Motor Oil Y = active.
- State tracked in local `onOff` (bool) and `motorOil` (bool).

### Row 2: Hours · Flow — two columns
```
[ Hours ___._  ]   [ Flow (cfs) ___.__ ]
```
- Hours: `step="0.1"`, class `.w-hours`
- Flow: `step="0.01"`, class `.w-flow`

### Row 3: Totalizer · Dripper Oil — two columns
```
[ Totalizer (AF) ___ ]   [ Dripper Oil ___.__ ]
```
- Totalizer: `step="1"`, class `.w-totalizer`
- Dripper Oil: `step="0.01"`, class `.w-dripperoil`

### Row 4: PG&E kWh — full width
```
[ PG&E kWh ___ ]
```
- `step="1"`, class `.w-pge`

### Row 5: Notes — full width
```
[ Notes textarea (rows=2) ]
```
- Class `.w-notes`, placeholder `"Optional notes…"`
- Always visible inline — no modal, no expand button.
- Auto-populated with `w.last_notes` on expand (if present).

### Error display
```
[ error message — hidden by default ]
```
- Class `.lif-error.error-msg.hidden`

---

## Previous Value / Diff Displays

Shown below each numeric input. Powered by `attachDiffDisplay()` and `attachTotalizerCalc()`.

| Field | Format | Decimal Places |
|-------|--------|---------------|
| Hours | `Prev: X.X · Δ ±X.X` | 1 |
| Flow (cfs) | `Prev: X.XX · Δ ±X.XX` | 2 |
| Dripper Oil | `Prev: X.XX · Δ ±X.XX` | 2 |
| PG&E kWh | `Prev: X · Δ ±X` | 0 |
| Totalizer | `Prev: X.XX AF · [date] · Δ ±X.XX AF · X.XX cfs avg (X.X days)` | 2 |

- Δ text turns **red** when negative.
- Totalizer CFS calc: `(Δ AF × 43560) / elapsed_seconds`. Returns null if elapsed ≤ 0.
- Totalizer recalculates when `well-date` or `well-time` changes.

---

## Footer Buttons

Layout: `[ Map ]  [ History ]  [ Save Well Reading ]`

CSS: `.lif-footer` (flexbox). Save button has `flex: 1`.

### Map Button (`.w-map-btn`)
- **Visible only if** well has both `gps_latitude` and `gps_longitude`.
- Opens **Location Modal** — single-well map.
- CSS: `.btn.btn-secondary.btn-sm`

### History Button (`.w-hist-btn`)
- Always visible.
- Opens **History Modal** for this well.
- CSS: `.btn.btn-secondary.btn-sm`

### Save Button (`.w-save-btn`)
- CSS: `.btn.btn-save` (green — never `.btn-primary`).
- See Save Behavior below.

---

## Save Behavior

**Function:** anonymous click handler on `.w-save-btn` (~line 1312)

**Payload sent to `POST /api/readings/well`:**
```json
{
  "well_id": 123,
  "reading_date": "2026-05-15",
  "reading_time": "08:30",
  "on_off": true,
  "hour_reading": 1234.5,
  "flow_cfs": 2.50,
  "totalizer": 500,
  "motor_oil": true,
  "dripper_oil": 0.25,
  "pge_kwh": 1200,
  "notes": "…or null"
}
```
- All numeric fields are `null` if left blank.

**On success:**
1. Status dot → `done` (green).
2. Status badge text → `"Offline"` (queued) or `"Just saved"`.
3. Status badge class → `done`.
4. Add to `wellReadingsThisSession` Map with `{ date, time, flow_cfs }`.
5. Collapse card (remove `.expanded`, hide form).
6. Show toast: `"Well Name saved"` (green) or `"Well Name queued offline"` (yellow).

**On error:**
- Show message in `.lif-error` element inside the card.
- Show toast with error context.

**Time reset:** None — time bar preserves its value after save.

---

## Auto-fill

- **Notes:** Pre-filled with `w.last_notes` on expand (if value exists).
- **No Operator field** on well readings (unlike KF Monthly / DWR screens).
- **No currentUser auto-fill** on this screen.

---

## History Modal

**ID:** `history-modal`  
**Title:** `"History — [Well Name]"`

**Columns displayed:**

| Date | Hours | Flow (cfs) | Totalizer | Notes | Delete |
|------|-------|------------|-----------|-------|--------|

- Date shows on one line; time below in `.hist-time`.
- Delete visible to: Admin, OR Supervisor (within 24h), OR record owner (within 24h).
- Delete requires confirmation.
- **API:** `GET /api/history?type=well&id=[well_id]` · `DELETE /api/history/well/[id]`

---

## Location Modal (Single Well Map)

**ID:** `location-modal`  
**Triggered by:** Map button on individual well card.

| Property | Value |
|----------|-------|
| Modal max-width | 400px |
| Modal width | `calc(100vw - 32px)` |
| Map container ID | `location-modal-map` |
| Map height | **220px** |
| Map border-radius | 8px |
| Map library | Leaflet.js |
| Tile layer | Esri World Imagery (maxZoom: 20) |
| Zoom level | 16 |
| Attribution control | Off |
| Marker | Single default marker at well coordinates |
| Init delay | 50ms setTimeout (ensures DOM is ready) |
| Cleanup | Map instance destroyed on modal close |

**Coordinates display:** `Lat, Lng` to 6 decimal places.

**"Open in Maps" button:**
- iOS PWA → `maps://` deep link
- iOS web → `maps.apple.com`
- Other → Google Maps web link

---

## Set Map Modal (Area Map)

**ID:** `set-map-modal`  
**Triggered by:** Map button in area section header.  
**CSS card class:** `.set-map-card`

| Property | Value |
|----------|-------|
| Markers | One per well with GPS in the area |
| Marker size | 14×14px circle, 2px border, box-shadow |
| Read marker color | Green `#22c55e` |
| Unread marker color | Red `#ef4444` |
| Bounds | Auto-fit all markers, 15% padding |
| Current location | Blue circle if geolocation available |

**"Read" definition for map markers:**
- Well was saved in `wellReadingsThisSession`, OR
- `hours_since_reading != null && hours_since_reading <= 8`

**Popup content:**
- Read: `"[State Well #] | [Common Name]"` + `"✓ Read [date] [time] · X.XX cfs"`
- Unread: `"Not read"`

---

## No Search / Filter UI

The wells screen has no search bar or filter controls. Filtering is done server-side — `/api/wells/operational` returns only operational wells.

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/wells/operational` | Load all wells with latest reading metadata |
| POST | `/api/readings/well` | Save a new well reading |
| GET | `/api/history?type=well&id=X` | Load reading history for a well |
| DELETE | `/api/history/well/:id` | Delete a single reading record |

---

## Session State

**`wellReadingsThisSession`** — `Map<well_id, { date, time, flow_cfs }>`  
Tracks which wells have been read in the current browser session.  
Used by: dashboard badge count, area map marker colors.
