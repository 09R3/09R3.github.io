# Field Ops Design System

## Color Palette

All colors are CSS custom properties defined in `:root`.

| Variable | Hex | Usage |
|---|---|---|
| `--bg` | `#080d14` | App background, header, drawer background |
| `--surface` | `#0f1923` | Cards, tiles, panels, modals, list items |
| `--surface2` | `#162333` | Inputs, hover states, nested elements |
| `--surface3` | `#1e2d42` | Button hover backgrounds, deeper nesting |
| `--border` | `#253548` | All borders, dividers, input borders |
| `--accent` | `#2196f3` | Primary actions, active states, links, stat values |
| `--accent-dark` | `#1565c0` | Button hover, accent-dark variant |
| `--icon-bg` | `#1a2e47` | Tile icon container background |
| `--green` | `#2e7d32` | Save buttons, success states |
| `--green-light` | `#1b5e20` | Save button hover |
| `--green-bg` | `#0a2e0a` | Success row highlight background |
| `--red` | `#c62828` | Error state border |
| `--red-light` | `#ef5350` | Error text, danger labels |
| `--yellow` | `#f57f17` | Warning/due status color |
| `--text` | `#e8edf4` | Primary text |
| `--text-dim` | `#8fa3bc` | Secondary text, labels, meta |
| `--text-muted` | `#4a6080` | Placeholder, tertiary, disabled |

## Spacing & Sizing

| Variable | Value | Usage |
|---|---|---|
| `--radius` | `12px` | Standard card/button radius |
| `--radius-sm` | `7px` | Inputs, small buttons, badges |
| `--radius-lg` | `16px` | Dashboard tiles |
| `--header-h` | `56px` | Fixed app header height |
| `--transition` | `0.15s ease` | All transitions |

## Typography

- **Base font**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
- **Base size**: `16px` (controlled via `html { font-size }`)
- **Text sizes**: `0.95rem` (tile labels), `0.9rem` (nav items, body), `0.82rem` (form hints), `0.78rem` (uppercase labels), `0.72rem` (badges, meta), `0.68rem` (section headers), `0.65rem` (stat labels)
- **Uppercase labels**: `font-weight: 700; text-transform: uppercase; letter-spacing: 0.05–0.12em`
- **Stat values**: `1.5rem; font-weight: 700; font-variant-numeric: tabular-nums`

## Component Patterns

### Dashboard Tiles (`.dash-tile`)
- Full-column layout via CSS grid (2 cols default, 3 cols at 900px+)
- `flex-direction: column; align-items: flex-start; gap: 14px`
- Min height: `130px`, padding `18px`, radius `var(--radius-lg)`
- Contains: `.dash-icon-wrap` (44×44px rounded container) + `.dash-label`
- Hover: background → `var(--surface2)`, border → accent, icon-wrap bg → `rgba(33,150,243,0.18)`, label → `var(--accent)`
- Badge positioning: `.maint-badge` is `position: absolute; top: 8px; right: 8px`

### Icon Containers (`.dash-icon-wrap`)
- `44×44px; background: var(--icon-bg); border-radius: 10px`
- Transition: background on hover
- Icon inside: 24×24px SVG img

### Stats Cards (`.stat-card`)
- 3-column grid on dashboard
- First card uses `.stat-accent` class: left border `3px solid var(--accent)`
- `.stat-bar` / `.stat-bar-fill`: 3px tall progress bar at bottom of first card

### Buttons
- `.btn-save` (green) — all save/submit actions
- `.btn-primary` (blue) — navigation, secondary actions only (never save)
- `.btn-secondary` — cancel, back, utility
- `.btn-sm` — `min-height: 38px; padding: 8px 14px; font-size: 0.875rem`
- All save actions must use `.btn-save`, never `.btn-primary`

### Status Indicators
- `.status-dot` + `.status-badge` — Wells (daily), Vehicles (monthly)
- `.status-badge` only (no dot) — Canal structures (shows flow value)
- Row label color change — Pumping Plant (green if saved within 10h)
- Plain text date — Well Runs DWR/Piezometers (green if within 30 days)

### Nav Drawer (`.nav-btn`)
- `display: flex; align-items: center; gap: 12px; padding: 12px 20px`
- Icon wrapped in `.nav-btn-icon` (20×20px flex container)
- Section headers: `.drawer-section-hdr` — uppercase, muted, `0.62rem`

### App Header Buttons
- `.hamburger` / `.header-refresh-btn`: circular (`border-radius: 50%`), 36×36px
- Background: `var(--surface2)`, hover: `var(--surface3)`, border accent on hover

### Section Headers
- `.dash-section-header`: uppercase, `0.68rem`, with `::after` rule (flex `1px` line)
- `.drawer-section-hdr`: uppercase, `0.62rem`, padding only (no line)
- `.list-section-header`: collapsible section headers in list screens

### Form Controls
- `.ctrl-input`, `.ctrl-select`, `.ctrl-textarea`: full-width, `var(--surface2)` bg
- `.ctrl-input-sm`: small variant for date/time inputs (`padding: 6px 8px; max-width: 140px`)
- Date/time inputs always use `.ctrl-input-sm` class

### Notes Fields
- Always inline multi-line `<textarea>` — no modal, no expand button
- Pumping Plant section notes: single-line (exception)

### Navigation Bars
- `.panel-nav-bar` / `.panel-nav-back`: injected by JS via `setPanelNav()`
- Back button: `min-height: 44px`, accent color text, always just "‹ Back"
- Swipe-back: left-edge swipe (`clientX < 30px`, delta > 60px)

### Loading / Empty / Error States
- Always use `.placeholder-msg` class
- Loading: `"Loading…"`, Empty: `"No [items] found."`, Error: `"Failed to load."`

### Modals
- `.modal-overlay` + `.modal-card` — bottom sheet on mobile, centered on 480px+
- `.modal-header` / `.modal-body` / `.modal-footer`
- Close: × button + tap-outside

### Attachments
- Supported on: Vehicle Maintenance, Equipment Issues, Building Issues, Well Issues
- Layout order: Add Invoice → Add Photo → pending queue → uploaded files list
- Filename uses entity name (sanitized, max 40 chars), not issue ID

## Icon System

### CDN URL
```
https://cdn.jsdelivr.net/gh/09R3/Marv-s-site@main/icons/icon-{name}.svg
```

### JavaScript Helper
```javascript
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/09R3/Marv-s-site@main/icons';
function icon(name, sz = 16) {
  return `<img src="${ICON_CDN}/icon-${name}.svg" width="${sz}" height="${sz}" class="app-icon" alt="" aria-hidden="true">`;
}
```

### `.app-icon` CSS Class
```css
.app-icon { display: inline-block; vertical-align: middle; }
```

### Available Icon Names
`dashboard`, `pumping-plant`, `wells`, `canal`, `vehicles`, `kf-monthly`, `well-runs`, `maintenance`, `pesticides`, `reports`, `settings`, `bug-report`, `equipment`, `buildings`, `swaps`, `pm-records`, `electrical`, `siphon-breaker`, `air-compressor`, `annual-pm`, `usage`, `location`, `products`, `dwr`, `piezometers`, `history`, `map-pin`, `map`, `invoice`, `photo`, `attachments`, `print`, `download`, `sync`, `delete`, `refresh`, `menu`, `IWV`, `wells-2`, `wells-3`

### Icon Size Guidelines
- Dashboard tiles: `24×24`
- Nav drawer items: `18×18`
- Header buttons: `20×20` (menu), `18×18` (refresh)
- Button icons: `16×16`
- PDF placeholders: `28×28` or `32×32`
- Small buttons: `14×14`

## Hover / Interactive States

- **Tiles**: bg → `surface2`, border → accent, icon-wrap bg → `rgba(33,150,243,0.18)`, label → accent
- **Nav buttons**: bg → `surface2`, text → `--text`
- **Header buttons**: bg → `surface3`, border → accent
- **List items**: border-color → accent (`.expanded` state)
- **Buttons**: `.btn-save` → green-light, `.btn-primary` → accent-dark, `.btn-secondary` → border color

## Responsive Breakpoints

| Breakpoint | Changes |
|---|---|
| `480px` | Modals become centered (not bottom sheet) |
| `520px` | Reading row inputs wider, labels larger |
| `900px` | Dashboard grid: 2 cols → 3 cols; PP screen max-width 940px |

## Version Tracking

- Version displayed in login footer and Settings > App Info
- Location: `field-ops/public/index.html` (two places) and `field-ops/public/sw.js` (cache name)
- Format: `v 1.33` in HTML, `field-ops-v1.33` in sw.js
- Bump for any change; cache name controls service worker invalidation
