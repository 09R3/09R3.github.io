-- ─────────────────────────────────────────────────────────────────────────────
--  Migration 004 — Equipment Issues
--
--  Run this once against your PostgreSQL database:
--    psql -U <user> -d <dbname> -f 004_equipment_issues.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS equipment_issues (
  issue_id          SERIAL       PRIMARY KEY,
  equipment_type    TEXT         NOT NULL,          -- 'pump','motor','compressor','siphon_breaker','other'
  equipment_id      TEXT,                           -- id from the type-specific table (NULL for 'other')
  equipment_name    TEXT,                           -- snapshot of name at time of report
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
