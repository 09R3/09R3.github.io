# 09R3.github.io
Website

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
