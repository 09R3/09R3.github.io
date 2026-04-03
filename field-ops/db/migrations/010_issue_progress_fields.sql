-- Migration 010: Add action_taken, po_number, cost to issue tables
-- Run once against the shared Field Ops database.

ALTER TABLE well_issues
  ADD COLUMN IF NOT EXISTS action_taken TEXT,
  ADD COLUMN IF NOT EXISTS po_number    TEXT,
  ADD COLUMN IF NOT EXISTS cost         NUMERIC(10,2);

ALTER TABLE building_issues
  ADD COLUMN IF NOT EXISTS action_taken TEXT,
  ADD COLUMN IF NOT EXISTS po_number    TEXT,
  ADD COLUMN IF NOT EXISTS cost         NUMERIC(10,2);

ALTER TABLE equipment_issues
  ADD COLUMN IF NOT EXISTS action_taken TEXT,
  ADD COLUMN IF NOT EXISTS po_number    TEXT,
  ADD COLUMN IF NOT EXISTS cost         NUMERIC(10,2);
