-- ─────────────────────────────────────────────────────────────────────────────
--  Migration 006 — Well Issues
--
--  Run this once against your PostgreSQL database:
--    psql -U <user> -d <dbname> -f 006_well_issues.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS well_issues (
  issue_id          SERIAL       PRIMARY KEY,
  well_id           INTEGER      REFERENCES wells(well_id),
  well_name         TEXT,                           -- snapshot at time of report
  well_area         TEXT,                           -- snapshot at time of report
  status            TEXT         NOT NULL DEFAULT 'open',  -- 'open','in_progress','resolved'
  description       TEXT         NOT NULL,
  reported_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
  resolved_date     DATE,
  resolution_notes  TEXT,
  entered_by        TEXT         NOT NULL,
  assigned_to       TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
