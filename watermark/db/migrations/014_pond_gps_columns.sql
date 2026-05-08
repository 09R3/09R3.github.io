-- Migration 014: Add GPS columns to pond_connections and ponds

-- Gate/structure location on each connection
ALTER TABLE pond_connections
  ADD COLUMN IF NOT EXISTS gate_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS gate_lon NUMERIC;

-- Staff gauge location on each pond
ALTER TABLE ponds
  ADD COLUMN IF NOT EXISTS gauge_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS gauge_lon NUMERIC;
