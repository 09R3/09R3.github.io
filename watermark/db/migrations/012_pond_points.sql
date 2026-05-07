-- 012_pond_points.sql
-- GPS polygon points for pond map outlines.
-- Each pond can have many ordered points that form a closed polygon shape.
-- Requires the PostGIS extension. Run once if not already enabled:
--   CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS pond_points (
  point_id    SERIAL PRIMARY KEY,
  pond_id     INT NOT NULL REFERENCES ponds(pond_id) ON DELETE CASCADE,
  name        TEXT,                 -- denormalized from ponds.name for easy querying
  point_order INT NOT NULL,         -- 1, 2, 3, … (corner order matters for polygon shape)
  geom        GEOMETRY(Point, 4326) -- lon/lat WGS-84
);

CREATE INDEX IF NOT EXISTS idx_pond_points_pond_id
  ON pond_points(pond_id, point_order);

CREATE INDEX IF NOT EXISTS idx_pond_points_geom
  ON pond_points USING GIST(geom);

-- ── Convenience view ─────────────────────────────────────────────────────────
-- Returns each pond's points as a GeoJSON FeatureCollection-ready row.
-- Useful for map rendering without a JOIN.

CREATE OR REPLACE VIEW pond_polygons AS
SELECT
  p.pond_id,
  p.name        AS pond_name,
  pl.name       AS location_name,
  ST_AsGeoJSON(
    ST_MakePolygon(
      ST_MakeLine(
        array_agg(pp.geom ORDER BY pp.point_order)
      )
    )
  )::json        AS polygon_geojson,
  COUNT(*)       AS point_count
FROM ponds p
JOIN pond_locations pl ON pl.location_id = p.location_id
JOIN pond_points pp    ON pp.pond_id = p.pond_id
GROUP BY p.pond_id, p.name, pl.name
HAVING COUNT(*) >= 3;   -- need at least 3 points for a valid polygon
