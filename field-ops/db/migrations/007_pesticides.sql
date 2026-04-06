-- Migration 007: Pesticide tracking
-- Run once against the shared Field Ops database.

CREATE TABLE IF NOT EXISTS pesticides (
  pesticide_id    SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  epa_reg_number  VARCHAR(50),
  unit_of_measure VARCHAR(30)  NOT NULL,
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pesticide_usage (
  usage_id             SERIAL PRIMARY KEY,
  pesticide_id         INTEGER      NOT NULL REFERENCES pesticides(pesticide_id),
  used_date            DATE         NOT NULL DEFAULT CURRENT_DATE,
  used_time            TIME         NOT NULL DEFAULT CURRENT_TIME,
  applied_by           INTEGER      REFERENCES users(user_id),
  quantity             NUMERIC(10,2) NOT NULL,
  location_description TEXT,
  notes                TEXT,
  created_at           TIMESTAMP    NOT NULL DEFAULT NOW()
);
