-- Migration 015: Add location and GPS to river_outlets; allow staff gauge readings on outlets

ALTER TABLE river_outlets
  ADD COLUMN IF NOT EXISTS location_id INT REFERENCES pond_locations(location_id),
  ADD COLUMN IF NOT EXISTS gauge_lat   NUMERIC,
  ADD COLUMN IF NOT EXISTS gauge_lon   NUMERIC;

-- Allow staff gauge readings to reference a river outlet instead of a pond
ALTER TABLE readings_staff_gauge
  ADD COLUMN IF NOT EXISTS outlet_id INT REFERENCES river_outlets(outlet_id);
