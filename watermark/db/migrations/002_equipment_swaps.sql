-- ─────────────────────────────────────────────────────────────────────────────
--  Migration 002 — Equipment Swap Inventory & Unified Swap History
--
--  Run this once against your PostgreSQL database:
--    psql -U <user> -d <dbname> -f 002_equipment_swaps.sql
--
--  Tables created:
--    well_motors      — Well motor inventory (active / spare)
--    well_meters      — Well meter inventory (active / spare)
--    equipment_swaps  — Unified swap history for all categories
--
--  NOTE: pump_units already exists in the DB and is used directly for
--        PP pump swaps. No new pump table is needed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Well motor inventory ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS well_motors (
  well_motor_id    SERIAL       PRIMARY KEY,
  manufacturer     TEXT,
  model_number     TEXT,
  serial_number    TEXT,
  hp               NUMERIC,
  status           TEXT         NOT NULL DEFAULT 'spare',  -- 'active', 'spare', 'inactive'
  current_location TEXT,        -- e.g. well common_name
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Well meter inventory ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS well_meters (
  well_meter_id    SERIAL       PRIMARY KEY,
  manufacturer     TEXT,
  model_number     TEXT,
  serial_number    TEXT,
  meter_type       TEXT,        -- e.g. 'flow', 'totalizer'
  status           TEXT         NOT NULL DEFAULT 'spare',  -- 'active', 'spare', 'inactive'
  current_location TEXT,        -- e.g. well common_name
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Unified swap history ──────────────────────────────────────────────────────
-- Covers all 5 categories: siphon_breaker, motor, pp_pump, well_motor, well_meter
-- item_removed_id / item_installed_id reference the category-specific inventory table.
-- removed_description / installed_description are text snapshots for readable history
-- even if the inventory record is later changed.
CREATE TABLE IF NOT EXISTS equipment_swaps (
  swap_id               SERIAL       PRIMARY KEY,
  category              TEXT         NOT NULL,   -- see categories above
  swap_date             DATE         NOT NULL,
  location              TEXT,                    -- location where swap occurred
  item_removed_id       INTEGER,                 -- id in category inventory table
  item_installed_id     INTEGER,                 -- id in category inventory table
  removed_description   TEXT,                    -- snapshot: "[mfr] [model] from [location]"
  installed_description TEXT,                    -- snapshot: "[mfr] [model]"
  performed_by          TEXT,
  notes                 TEXT,
  entered_by            TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
