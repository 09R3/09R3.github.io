-- Migration 008: App settings key/value store + KF widget defaults
-- Run once against the shared Field Ops database.

CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Default KF widget date range = current calendar month
INSERT INTO app_settings (key, value) VALUES
  ('kf_widget_start', TO_CHAR(DATE_TRUNC('month', CURRENT_DATE), 'YYYY-MM-DD')),
  ('kf_widget_end',   TO_CHAR((DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date, 'YYYY-MM-DD'))
ON CONFLICT (key) DO NOTHING;
