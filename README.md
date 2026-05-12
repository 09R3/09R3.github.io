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
