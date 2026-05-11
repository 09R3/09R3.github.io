-- Migration 013: Restructure pond_connections — explicit source/destination,
--   add river_outlets reference table, enforce source FK integrity.
--
-- Safe to run on a live database: ALTERs existing table in place so
-- pond_gates FK to pond_connections(connection_id) is unaffected.
--
-- After running this migration, update server.js:
--   Any JOIN/WHERE using  pc.pond_id = p.pond_id
--   must become           pc.destination_pond_id = p.pond_id

-- ── 1. River outlets reference table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS river_outlets (
  outlet_id   SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT  DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE,
  notes       TEXT
);

-- ── 2. Rename destination column to be explicit ──────────────────────────────
ALTER TABLE pond_connections
  RENAME COLUMN pond_id TO destination_pond_id;

-- ── 3. Add new source FK columns ─────────────────────────────────────────────
ALTER TABLE pond_connections
  ADD COLUMN source_river_id INT REFERENCES river_outlets(outlet_id),
  ADD COLUMN source_pond_id  INT REFERENCES ponds(pond_id);

-- ── 4. Clear source_type for rows where the matching FK was never set ────────
--   (existing seed rows all have source_type set but no FK value)
UPDATE pond_connections
SET source_type = NULL
WHERE (source_type = 'canal' AND source_canal_id IS NULL)
   OR (source_type = 'river' AND source_river_id IS NULL)
   OR (source_type = 'pond'  AND source_pond_id  IS NULL);

-- ── 5. Add CHECK constraints ─────────────────────────────────────────────────

-- Valid source_type values only
ALTER TABLE pond_connections
  ADD CONSTRAINT chk_pond_conn_source_type
    CHECK (source_type IN ('canal', 'river', 'pond') OR source_type IS NULL);

-- When source_type is set, exactly one source FK must be populated and the
-- other two must be NULL. Prevents mismatched or ambiguous source references.
ALTER TABLE pond_connections
  ADD CONSTRAINT chk_pond_conn_source_fk CHECK (
    source_type IS NULL
    OR (
      source_type = 'canal'
      AND source_canal_id IS NOT NULL
      AND source_river_id IS NULL
      AND source_pond_id  IS NULL
    )
    OR (
      source_type = 'river'
      AND source_river_id IS NOT NULL
      AND source_canal_id IS NULL
      AND source_pond_id  IS NULL
    )
    OR (
      source_type = 'pond'
      AND source_pond_id  IS NOT NULL
      AND source_canal_id IS NULL
      AND source_river_id IS NULL
    )
  );

-- ── 6. Index on destination for the main API query ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_pond_connections_dest
  ON pond_connections(destination_pond_id);
