-- Migration 016: Allow pond_points to store polygon points for river outlets

ALTER TABLE pond_points
  ALTER COLUMN pond_id DROP NOT NULL;

ALTER TABLE pond_points
  ADD COLUMN IF NOT EXISTS outlet_id INT REFERENCES river_outlets(outlet_id) ON DELETE CASCADE;

-- Enforce: every row must belong to exactly one entity
ALTER TABLE pond_points
  ADD CONSTRAINT pond_points_entity_check CHECK (
    (pond_id IS NOT NULL AND outlet_id IS NULL) OR
    (pond_id IS NULL AND outlet_id IS NOT NULL)
  );
