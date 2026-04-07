-- ─────────────────────────────────────────────────────────────────────────────
--  Migration 005 — Building Issues
--
--  Run this once against your PostgreSQL database:
--    psql -U <user> -d <dbname> -f 005_building_issues.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS building_issues (
  issue_id          SERIAL       PRIMARY KEY,
  building_id       INTEGER      REFERENCES buildings(building_id),
  site_id           INTEGER      REFERENCES sites(site_id),
  building_name     TEXT,                           -- snapshot at time of report
  site_name         TEXT,                           -- snapshot at time of report
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
