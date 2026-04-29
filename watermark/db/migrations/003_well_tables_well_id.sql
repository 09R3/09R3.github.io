-- ─────────────────────────────────────────────────────────────────────────────
--  Migration 003 — Add well_id FK to well_motors and well_meters
--
--  Run this once against your PostgreSQL database:
--    psql -U <user> -d <dbname> -f 003_well_tables_well_id.sql
--
--  Both tables were just created by 002 and are empty, so it's safe to
--  drop and recreate them with well_id replacing free-text current_location.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS well_motors;
DROP TABLE IF EXISTS well_meters;

-- ── Well motor inventory ──────────────────────────────────────────────────────
CREATE TABLE well_motors (
  well_motor_id  SERIAL       PRIMARY KEY,
  manufacturer   TEXT,
  model_number   TEXT,
  serial_number  TEXT,
  hp             NUMERIC,
  status         TEXT         NOT NULL DEFAULT 'spare',  -- 'active', 'spare', 'inactive'
  well_id        INTEGER      REFERENCES wells(well_id), -- NULL for spares
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Well meter inventory ──────────────────────────────────────────────────────
CREATE TABLE well_meters (
  well_meter_id  SERIAL       PRIMARY KEY,
  manufacturer   TEXT,
  model_number   TEXT,
  serial_number  TEXT,
  meter_type     TEXT,                                   -- e.g. 'flow', 'totalizer'
  status         TEXT         NOT NULL DEFAULT 'spare',  -- 'active', 'spare', 'inactive'
  well_id        INTEGER      REFERENCES wells(well_id), -- NULL for spares
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
