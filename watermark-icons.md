# Field Ops — Icon Migration Plan

## Technical Setup

### Folder
```
watermark/public/icons/
```

### File Format
SVG — scales perfectly at all resolutions (important for mobile/retina),
small file size, no pixelation. Draw each icon on a **24×24 viewBox**. for the 
stroke size lets use 1.

### Color
Use `fill="currentColor"` in the SVG source. This lets CSS control the icon
color via the `color` property, so icons automatically match light/dark
themes and active states without needing separate color variants.

### Displayed Size (set via CSS, not the SVG itself)
| Context                          | CSS size    |
|----------------------------------|-------------|
| Nav drawer list items            | 20 × 20 px  |
| App header buttons (☰ refresh ⚙) | 20 × 20 px  |
| Dashboard / sub-dashboard tiles  | 28 × 28 px  |
| Inline action buttons (History, Map, Invoice, Photo…) | 16 × 16 px |
| Pending sync banner              | 18 × 18 px  |

### Naming Convention
`icon-{purpose}.svg` — kebab-case, describes the *function* not the old emoji.

Example: the wrench emoji on Maintenance → `icon-maintenance.svg`, not `icon-wrench.svg`.

### Implementation
The app uses HTML strings built in JS, so the cleanest swap is a small
helper function added once to `app.js`:

```javascript
// Returns an <img> tag referencing an icon file.
// Size defaults to 20px; override via the sz argument.
function icon(name, sz = 20) {
  return `<img src="/icons/icon-${name}.svg" width="${sz}" height="${sz}"
               class="app-icon" alt="" aria-hidden="true">`;
}
```

Then in templates, replace e.g. `&#128200;` with `${icon('history')}` or
`${icon('history', 16)}` for a smaller button context.

For static HTML in `index.html`, use `<img>` directly:
```html
<img src="/icons/icon-dashboard.svg" width="20" height="20"
     class="app-icon" alt="" aria-hidden="true">
```

Add one CSS rule to `style.css`:
```css
.app-icon {
  display: inline-block;
  vertical-align: middle;
  /* If using currentColor via CSS mask instead of <img>:
     background-color: currentColor;
     -webkit-mask-image: url(...);  */
}
```

---

## Icon Inventory

Status key: `[ ]` = not done, `[x]` = done, `[-]` = decided to keep emoji

---

### 1. App Header

| Status | Current      | Emoji         | File name              | Where it appears                              |
|--------|--------------|---------------|------------------------|-----------------------------------------------|
| [ ]    | `&#9776;`  ☰ | Hamburger     | `icon-menu.svg`        | Hamburger menu toggle button (fixed header)   |
| [ ]    | `&#8635;`  ↻ | Refresh       | `icon-refresh.svg`     | Refresh button (fixed header, top right)      |

---

### 2. Navigation Drawer

| Status | Current        | Emoji   | File name                  | Screen                    |
|--------|----------------|---------|----------------------------|---------------------------|
| [ ]    | `&#127968;` 🏠 | House   | `icon-dashboard.svg`       | Dashboard                 |
| [ ]    | `&#128167;` 💧 | Droplet | `icon-pumping-plant.svg`   | Pumping Plant Readings    |
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-wells.svg`           | Well Readings             |
| [ ]    | `&#127754;` 🌊 | Wave    | `icon-canal.svg`           | Canal Readings            |
| [ ]    | `&#128664;` 🚗 | Car     | `icon-vehicles.svg`        | Vehicle Monthly           |
| [ ]    | `&#128200;` 📈 | Chart   | `icon-kf-monthly.svg`      | KF Monthly                |
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-well-runs.svg`       | Well Runs (same emoji as Wells — needs its own icon) |
| [ ]    | `&#128295;` 🔧 | Wrench  | `icon-maintenance.svg`     | Maintenance Log           |
| [ ]    | `&#127807;` 🌿 | Herb    | `icon-pesticides.svg`      | Pesticides                |
| [ ]    | `&#128202;` 📊 | Chart   | `icon-reports.svg`         | Reports                   |
| [ ]    | `&#9881;`   ⚙  | Gear    | `icon-settings.svg`        | Settings                  |
| [ ]    | `&#128030;` 🐛 | Bug     | `icon-bug-report.svg`      | Report a Bug              |

> Note: Wells and Well Runs both use the pushpin emoji — this is a good
> opportunity to give them distinct icons (e.g. a gauge/meter for Wells,
> a flow arrow or depth indicator for Well Runs).

---

### 3. Main Dashboard Tiles

Same icons as nav drawer — the tiles mirror the nav list exactly.
Using the same files as section 2 (no separate tile-specific files needed).

| Status | Screen tile                 | File name                  |
|--------|-----------------------------|----------------------------|
| [ ]    | Pumping Plant               | `icon-pumping-plant.svg`   |
| [ ]    | Well Readings               | `icon-wells.svg`           |
| [ ]    | Canal Readings              | `icon-canal.svg`           |
| [ ]    | Vehicle Monthly             | `icon-vehicles.svg`        |
| [ ]    | KF Monthly                  | `icon-kf-monthly.svg`      |
| [ ]    | Maintenance Log             | `icon-maintenance.svg`     |
| [ ]    | Pesticides                  | `icon-pesticides.svg`      |
| [ ]    | Well Runs                   | `icon-well-runs.svg`       |
| [ ]    | Reports                     | `icon-reports.svg`         |
| [ ]    | Settings (gear tile)        | `icon-settings.svg`        |

---

### 4. Maintenance Sub-Dashboard Tiles

| Status | Current        | Emoji          | File name                  | Tile                 |
|--------|----------------|----------------|----------------------------|----------------------|
| [ ]    | `&#9881;`   ⚙  | Gear           | `icon-equipment.svg`       | Equipment            |
| [ ]    | `&#128664;` 🚗 | Car            | `icon-vehicles.svg`        | Vehicles (reuse)     |
| [ ]    | `&#127970;` 🏢 | Building       | `icon-buildings.svg`       | Buildings            |
| [ ]    | `&#128204;` 📌 | Pushpin        | `icon-wells.svg`           | Wells (reuse)        |
| [ ]    | `&#128260;` 🔄 | Arrows         | `icon-swaps.svg`           | Equipment Swaps      |
| [ ]    | `&#128203;` 📋 | Clipboard      | `icon-pm-records.svg`      | PMs                  |

---

### 5. PM Sub-Dashboard Tiles

| Status | Current        | Emoji     | File name                  | Tile                    |
|--------|----------------|-----------|----------------------------|-------------------------|
| [ ]    | `&#9889;`   ⚡  | Lightning | `icon-electrical.svg`      | A Plant Electrical      |
| [ ]    | `&#9889;`   ⚡  | Lightning | `icon-electrical.svg`      | B Plant Electrical (reuse) |
| [ ]    | `&#128204;` 📌 | Pushpin   | `icon-siphon-breaker.svg`  | Siphon Breaker          |
| [ ]    | `&#128168;` 💨 | Wind/Air  | `icon-air-compressor.svg`  | Air Compressor          |
| [ ]    | `&#128167;` 💧 | Droplet   | `icon-wells.svg`           | Wells PM (reuse)        |
| [ ]    | `&#128221;` 📝 | Notepad   | `icon-annual-pm.svg`       | Annual Pumping Plant    |

---

### 6. Pesticides Sub-Dashboard Tiles

| Status | Current        | Emoji  | File name                  | Tile     |
|--------|----------------|--------|----------------------------|----------|
| [ ]    | `&#128200;` 📈 | Chart  | `icon-usage.svg`           | Usage    |
| [ ]    | `&#128205;` 📍 | Pin    | `icon-location.svg`        | Location |
| [ ]    | `&#128202;` 📊 | Chart  | `icon-reports.svg`         | Reports (reuse) |
| [ ]    | `&#127797;` 🌵 | Cactus | `icon-products.svg`        | Products (cactus was a placeholder — replace with something like a container/bottle/leaf) |

---

### 7. Well Runs Sub-Dashboard Tiles

| Status | Current        | Emoji   | File name              | Tile             |
|--------|----------------|---------|------------------------|------------------|
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-dwr.svg`         | DWR              |
| [ ]    | `&#128200;` 📈 | Chart   | `icon-piezometers.svg` | KCWA Piezometers |
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-well-runs.svg`   | Shallow (reuse)  |
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-well-runs.svg`   | IWV (reuse)      |
| [ ]    | `&#128204;` 📌 | Pushpin | `icon-well-runs.svg`   | Purge (reuse)    |

---

### 8. Reports Sub-Dashboard Tiles

| Status | Current       | Emoji   | File name               | Tile                  |
|--------|---------------|---------|-------------------------|-----------------------|
| [ ]    | `&#128665;` 🚙 | Car    | `icon-vehicles.svg`     | Vehicles (reuse)      |
| [ ]    | `&#128200;` 📈 | Chart  | `icon-kf-monthly.svg`   | KF (reuse)            |
| [ ]    | `&#128295;` 🔧 | Wrench | `icon-maintenance.svg`  | Maintenance Issues (reuse) |
| [ ]    | `&#9989;`   ✅  | Check  | `icon-pm-records.svg`   | Siphon & AC PMs (reuse) |

---

### 9. Inline Action Buttons

These appear throughout content areas, inside reading rows, issue cards, etc.

| Status | Current        | Emoji       | File name              | Where used                                                         |
|--------|----------------|-------------|------------------------|--------------------------------------------------------------------|
| [ ]    | `&#128200;` 📈 | Chart       | `icon-history.svg`     | History buttons on every reading screen and maintenance records    |
| [ ]    | `&#128205;` 📍 | Pin         | `icon-map-pin.svg`     | "Map" buttons on KF Monthly, Piezometers, DWR items               |
| [ ]    | `&#128506;` 🗺  | World map   | `icon-map.svg`         | "Map" group view buttons (KF set map, DWR map panel button)        |
| [ ]    | `&#128196;` 📄 | Document    | `icon-invoice.svg`     | "Invoice" upload button on maintenance records and issue cards     |
| [ ]    | `&#128247;` 📷 | Camera      | `icon-photo.svg`       | "Photo(s)" upload button; EXIF/upload tool drop zone               |
| [ ]    | `&#128206;` 📎 | Paperclip   | `icon-attachments.svg` | "X files" attachment count button on records/issues               |
| [ ]    | `&#128203;` 📋 | Clipboard   | `icon-pm-records.svg`  | PM history buttons in siphon breaker / air compressor grid (reuse) |
| [ ]    | `&#128438;` 🖾  | Print       | `icon-print.svg`       | "Print / PDF" export button in Reports                             |
| [ ]    | `&#11015;`  ⬇  | Download    | `icon-download.svg`    | "Save / Download" in attachment preview modal                      |
| [ ]    | `&#128228;` 📤 | Outbox tray | `icon-sync.svg`        | Pending Sync banner                                                |
| [ ]    | `&#128030;` 🐛 | Bug         | `icon-bug-report.svg`  | Bug report button (nav drawer — reuse)                            |
| [ ]    | `🗑`           | Trash       | `icon-delete.svg`      | Delete button in history modal rows                                |

---

### 10. Keep as-Is (Unicode / Text Symbols)

These are structural UI symbols — not really icons. Recommend keeping them
as CSS-styled text characters rather than image files.

| Character  | Code       | Where used                              | Recommendation               |
|------------|------------|-----------------------------------------|------------------------------|
| `▼`        | `&#9660;`  | Expand/collapse chevron on sections     | Keep — replace with CSS `▾` or border triangle |
| `←`        | `&#8592;`  | Previous month button                   | Keep as text                 |
| `→`        | `&#8594;`  | Next month button                       | Keep as text                 |
| `↧`        | `&#8615;`  | Export button label                     | Keep as text, or use `icon-download.svg` |
| `‹`        | `&#8249;`  | Back button in tools screens            | Keep — matches `‹ Back` style |
| `–`        | `&#8211;`  | Date range separator                    | Keep as text                 |
| `✓`        | plain text | Save confirmation, PM pass              | Keep as text                 |
| `✗`        | plain text | Error, PM fail                          | Keep as text                 |
| `☑` / `☐` | `&#9745;`/`&#9744;` | PM checklist checked/unchecked | Keep as text                |

---

## Unique File List (no duplicates)

Icons you actually need to create — 27 files:

```
icon-menu.svg
icon-refresh.svg
icon-dashboard.svg
icon-pumping-plant.svg
icon-wells.svg
icon-canal.svg
icon-vehicles.svg
icon-kf-monthly.svg
icon-well-runs.svg
icon-maintenance.svg
icon-pesticides.svg
icon-reports.svg
icon-settings.svg
icon-bug-report.svg
icon-equipment.svg
icon-buildings.svg
icon-swaps.svg
icon-pm-records.svg
icon-electrical.svg
icon-siphon-breaker.svg
icon-air-compressor.svg
icon-annual-pm.svg
icon-usage.svg
icon-location.svg
icon-products.svg
icon-dwr.svg
icon-piezometers.svg
icon-history.svg
icon-map-pin.svg
icon-map.svg
icon-invoice.svg
icon-photo.svg
icon-attachments.svg
icon-print.svg
icon-download.svg
icon-sync.svg
icon-delete.svg
```

---

## SVG Template

Each file should follow this pattern (24×24 viewBox, currentColor fill):

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
     fill="currentColor" width="24" height="24">
  <!-- your path(s) here -->
</svg>
```

The `width="24" height="24"` in the SVG are fallback defaults; the CSS or
`<img>` tag attributes will override them.

---

## Icon Source Suggestions

Good free sources for professional SVG icons (MIT / Apache licensed):

- **Heroicons** — heroicons.com — clean, minimal, stroke-based, MIT
- **Lucide** — lucide.dev — fork of Feather, 1000+ icons, MIT
- **Phosphor** — phosphoricons.com — multiple weights, MIT
- **Tabler Icons** — tabler.io/icons — 5000+ icons, MIT
- **Material Symbols** — fonts.google.com/icons — Google, Apache 2.0

All support SVG download. Heroicons and Lucide are probably the best fit for
a clean professional utility app.

---

*Created April 2026*
