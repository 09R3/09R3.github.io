-- Migration 009: Preventive Maintenance records
-- Run once against the shared Field Ops database.

CREATE TABLE IF NOT EXISTS pm_records (
  pm_id          SERIAL PRIMARY KEY,
  pm_type        VARCHAR(50)   NOT NULL,
  building       VARCHAR(100),
  completed_date DATE          NOT NULL DEFAULT CURRENT_DATE,
  completed_time TIME          NOT NULL DEFAULT CURRENT_TIME,
  completed_by   INTEGER       REFERENCES users(user_id),
  checklist      JSONB         NOT NULL DEFAULT '{}',
  notes          TEXT,
  created_at     TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pm_records_type_date
  ON pm_records (pm_type, completed_date DESC);
