# Field Ops Audit — April 2026

---

## 1. Dead CSS — Old Navigation Button Styles
*From v1.29 navigation refactor — buttons removed from HTML but CSS left behind*

- [ ] `.pm-back-btn` + styles — style.css ~line 1504
- [ ] `.settings-back-btn` + styles — style.css ~line 1760
- [ ] `.maint-back-btn` + styles — style.css ~line 1798
- [ ] `.wr-back-btn` + `.wr-back-btn:active` + `.wr-panel-title` — style.css ~line 2183

None of these classes appear in index.html or app.js anymore. Safe to delete.

---

## 2. Dead CSS — Old Notes Modal Button
*From v1.28 notes refactor — "+" button removed but CSS never cleaned up*

- [ ] `.notes-plus-btn` + `.notes-plus-btn:hover` — style.css ~lines 603–620

---

## 3. Dead CSS — Misc Orphaned Classes
*Defined in style.css, never referenced in index.html or app.js*

- [ ] `.sticky-controls` — style.css ~line 469 (old layout wrapper)
- [ ] `.control-row` + `.control-row:last-child` — style.css ~lines 479–486 (old layout pattern)
- [ ] `.ctrl-select.ctrl-site` — style.css ~line 496 (leftover from old building select UI)
- [ ] `.building-section` — style.css ~line 498 (never used anywhere)
- [ ] `.info-chip` — style.css ~line 709 (undefined purpose)
- [ ] `.notes-ta` — style.css ~line 834 (old notes textarea style)

Note: `.ctrl-label` is NOT dead — used in 10 places in the dashboard date/time stat cards.

---

## 4. Undefined CSS Variable
*`var(--text-secondary)` used but never defined in `:root`*

- [ ] style.css ~line 1265: `.maint-issue-report-desc { color: var(--text-secondary); }`
- [ ] style.css ~line 1370: another rule using `var(--text-secondary)`

Defined text variables are `--text`, `--text-dim`, `--text-muted`. Both lines should use `var(--text-dim)`.

---

## 5. Inconsistent "Open Form" Button Colors
*Buttons that just show/hide a form inline — no save action — using two different colors*

**Currently green `btn-save`:**
- `+ New Record` — Vehicle Maintenance
- `+ New Issue` — Equipment Issues, Building Issues, Well Issues

**Currently blue `btn-primary`:**
- `+ Log Usage` — Pesticide Usage
- `+ Add Product` — Pesticide Products
- `+ Add User` — User Management

All six just toggle a form's visibility. None of them save anything directly.
Options: all `btn-save` / all `btn-primary` / all `btn-secondary` (grey — nothing is saved yet)

---

## 6. Duplicate Listeners on Well Runs Tiles
*`initWellRunsScreen()` is called unconditionally on every visit to the Well Runs screen*

- [ ] app.js line 436: `if (name === 'well-runs') initWellRunsScreen();`

This attaches a new `click` listener to every `[data-wr-panel]` tile on every visit.
After visiting Well Runs twice, each tile fires two click handlers.

Currently harmless (setPanelNav uses `onclick` so last-writer wins, and DWR/KCWA have
load guards) but it will accumulate silently on repeated visits.

Fix: add a `let wellRunsInited = false;` guard like other screens use.

---

## 7. Wrong CSS Class on Pesticide Location Notes Textarea

- [ ] index.html: `<textarea id="pest-location-notes" class="ctrl-input" rows="2">`

Uses `.ctrl-input` instead of `.ctrl-textarea`. The `.ctrl-textarea` class handles
`resize` and `min-height` correctly for multi-line inputs. As-is it renders as
a textarea styled like a single-line input.

---

## Notes / Things That Are Fine (Not Issues)

- All empty/loading/error states correctly use `.placeholder-msg` ✓
- All date/time inputs correctly use `.ctrl-input-sm` ✓
- No static `panel-nav-bar` HTML in sub-panels (all injected by JS) ✓
- Back button navigation + swipe-back working correctly ✓
- Operator auto-fill working for KF Monthly, Piezometers, DWR ✓
- Performed By auto-fill working for maintenance records and swaps ✓
- All notes fields are inline textareas ✓
- Version numbers match across sw.js and index.html ✓
- Well Readings has no "Operator" form field — `entered_by` is server-side, no violation ✓
- Canal Readings same — `entered_by` server-side ✓

---

*Generated April 2026*
