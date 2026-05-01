-- 011_ponds.sql
-- Pond spreading water measurement system.
-- Tables: pond_locations, ponds, pond_connections, pond_gates,
--         readings_staff_gauge, readings_pond_gates

-- ── Reference tables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pond_locations (
  location_id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ponds (
  pond_id     SERIAL PRIMARY KEY,
  location_id INT REFERENCES pond_locations(location_id),
  name        TEXT NOT NULL,
  sort_order  INT DEFAULT 0,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS pond_connections (
  connection_id   SERIAL PRIMARY KEY,
  pond_id         INT REFERENCES ponds(pond_id),
  name            TEXT,
  source_type     TEXT,
  source_canal_id INT REFERENCES canal_structures(structure_id),
  sort_order      INT DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS pond_gates (
  gate_id       SERIAL PRIMARY KEY,
  connection_id INT REFERENCES pond_connections(connection_id),
  label         TEXT NOT NULL,
  gate_type     TEXT NOT NULL DEFAULT 'gate',
  width_in      NUMERIC,
  sort_order    INT DEFAULT 0,
  active        BOOLEAN DEFAULT TRUE,
  notes         TEXT
);

-- ── Readings tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS readings_staff_gauge (
  reading_id   SERIAL PRIMARY KEY,
  pond_id      INT REFERENCES ponds(pond_id),
  reading_date DATE NOT NULL,
  reading_time TIME,
  level_ft     NUMERIC NOT NULL,
  entered_by   TEXT,
  notes        TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_readings_staff_gauge_pond_date
  ON readings_staff_gauge(pond_id, reading_date DESC);

CREATE TABLE IF NOT EXISTS readings_pond_gates (
  reading_id   SERIAL PRIMARY KEY,
  gate_id      INT REFERENCES pond_gates(gate_id),
  reading_date DATE NOT NULL,
  reading_time TIME,
  head_ft      NUMERIC,
  opening_in   NUMERIC,
  overpour_ft  NUMERIC,
  flow_cfs     NUMERIC,
  entered_by   TEXT,
  notes        TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_readings_pond_gates_gate_date
  ON readings_pond_gates(gate_id, reading_date DESC);

-- ── Seed: Locations ──────────────────────────────────────────────────────────

INSERT INTO pond_locations (location_id, name, sort_order) VALUES
  (1, 'Pioneer North',   1),
  (2, 'Pioneer Central', 2),
  (3, 'Pioneer South',   3),
  (4, 'Berrenda Mesa',   4)
ON CONFLICT DO NOTHING;

-- ── Seed: Ponds ──────────────────────────────────────────────────────────────

INSERT INTO ponds (pond_id, location_id, name, sort_order) VALUES
  -- Pioneer North
  ( 1, 1, 'East Pond',    1),
  ( 2, 1, 'West Pond',    2),
  ( 3, 1, 'Basin 9',      3),
  ( 4, 1, 'Basin 10',     4),
  ( 5, 1, 'Pond 1',       5),
  ( 6, 1, 'Pond 2',       6),
  ( 7, 1, 'Pond 3',       7),  -- gauge-only
  -- Pioneer Central
  ( 8, 2, 'Basin 1',      1),
  ( 9, 2, 'PC-2',         2),
  (10, 2, 'PC-3',         3),  -- gauge-only
  -- Pioneer South
  (11, 3, '5B',           1),
  (12, 3, '5C',           2),
  (13, 3, '5D',           3),
  (14, 3, '5A',           4),
  (15, 3, 'JW-5',         5),
  (16, 3, 'Unnamed 1',    6),
  (17, 3, '6C',           7),
  (18, 3, '6A',           8),
  (19, 3, '6B',           9),
  (20, 3, 'Woody''s',    10),
  (21, 3, 'JW-6',        11),
  (22, 3, 'Unnamed 2',   12),
  (23, 3, '7/SW',        13),
  (24, 3, 'BV McA',      14),
  (25, 3, 'JW-7',        15),
  (26, 3, 'McClung Weir',16),
  -- Berrenda Mesa
  (27, 4, 'BM Main',      1),
  (28, 4, 'BM Pond 1',    2),
  (29, 4, 'BM Pond 2',    3),
  (30, 4, 'BM Pond 3',    4),
  (31, 4, 'BM Pond 4',    5),
  (32, 4, 'BM Pond 5',    6),
  (33, 4, 'BM Pond 6',    7)
ON CONFLICT DO NOTHING;

SELECT setval('ponds_pond_id_seq', (SELECT MAX(pond_id) FROM ponds), true);

-- ── Seed: Connections ────────────────────────────────────────────────────────

INSERT INTO pond_connections (connection_id, pond_id, name, source_type, sort_order) VALUES
  -- Pioneer North
  ( 1,  1, 'East Pond Inlet',    'canal', 1),
  ( 2,  2, 'West Pond Inlet',    'canal', 1),
  ( 3,  3, 'Basin 9 Inlet',      'canal', 1),
  ( 4,  4, 'Basin 10 Inlet',     'canal', 1),
  ( 5,  5, 'Pond 1 Inlet',       'canal', 1),
  ( 6,  6, 'Pond 2 Inlet',       'canal', 1),
  -- pond 7 (Pond 3) is gauge-only: no connection
  -- Pioneer Central
  ( 7,  8, 'Basin 1 Inlet',      'canal', 1),
  ( 8,  9, 'PC-2 Inlet',         'canal', 1),
  -- pond 10 (PC-3) is gauge-only: no connection
  -- Pioneer South (one connection per pond)
  ( 9, 11, '5B Inlet',           'canal', 1),
  (10, 12, '5C Inlet',           'canal', 1),
  (11, 13, '5D Inlet',           'canal', 1),
  (12, 14, '5A Inlet',           'canal', 1),
  (13, 15, 'JW-5 Inlet',         'canal', 1),
  (14, 16, 'Unnamed 1 Inlet',    'canal', 1),
  (15, 17, '6C Inlet',           'canal', 1),
  (16, 18, '6A Inlet',           'canal', 1),
  (17, 19, '6B Inlet',           'canal', 1),
  (18, 20, 'Woody''s Inlet',     'canal', 1),
  (19, 21, 'JW-6 Inlet',         'canal', 1),
  (20, 22, 'Unnamed 2 Inlet',    'canal', 1),
  (21, 23, '7/SW Inlet',         'canal', 1),
  (22, 24, 'BV McA Inlet',       'canal', 1),
  (23, 25, 'JW-7 Inlet',         'canal', 1),
  (24, 26, 'McClung Weir Inlet', 'canal', 1),
  -- Berrenda Mesa
  (25, 27, 'BM Main Inlet',      'canal', 1),
  (26, 28, 'BM Pond 1 Inlet',    'pond',  1),
  (27, 29, 'BM Pond 2 Inlet',    'pond',  1),
  (28, 30, 'BM Pond 3 Inlet',    'pond',  1),
  (29, 31, 'BM Pond 4 Inlet',    'pond',  1),
  (30, 32, 'BM Pond 5 Inlet',    'pond',  1),
  (31, 33, 'BM Pond 6 Inlet',    'pond',  1)
ON CONFLICT DO NOTHING;

SELECT setval('pond_connections_connection_id_seq',
  (SELECT MAX(connection_id) FROM pond_connections), true);

-- ── Seed: Gates ──────────────────────────────────────────────────────────────

INSERT INTO pond_gates (connection_id, label, gate_type, width_in, sort_order) VALUES
  -- East Pond (c1) — 57"
  (1, 'E 1', 'gate', 57,   1),
  (1, 'E 2', 'gate', 57,   2),
  (1, 'E 3', 'gate', 57,   3),
  (1, 'E 4', 'gate', 57,   4),
  -- West Pond (c2) — 77"
  (2, '#1',  'gate', 77,   1),
  (2, '#2',  'gate', 77,   2),
  (2, '#3',  'gate', 77,   3),
  -- Basin 9 (c3) — 55.2"
  (3, '#1',  'gate', 55.2, 1),
  (3, '#2',  'gate', 55.2, 2),
  (3, '#3',  'gate', 55.2, 3),
  (3, '#4',  'gate', 55.2, 4),
  (3, '#5',  'gate', 55.2, 5),
  (3, '#6',  'gate', 55.2, 6),
  -- Basin 10 (c4) — 55.2"
  (4, '#1',  'gate', 55.2, 1),
  (4, '#2',  'gate', 55.2, 2),
  -- Pond 1 (c5) — 55"
  (5, '1A',  'gate', 55,   1),
  -- Pond 2 (c6) — 55"
  (6, 'B9',  'gate', 55,   1),
  (6, '2A',  'gate', 55,   2),
  -- Basin 1 / PC-2 (c7, c8)
  (7, 'Basin 1 to PC-2', 'gate', 88.8, 1),
  (8, 'Gate 1',          'gate', 88.8, 1),
  (8, 'Gate 2',          'gate', 54,   2),
  -- Pioneer South singles (c9–c23)
  ( 9, '5B',     'gate', 54,   1),
  (10, '5C',     'gate', 57.6, 1),
  (11, '5D',     'gate', 54,   1),
  (12, '5A',     'gate', 54,   1),
  (13, 'JW-5',   'gate', 56,   1),
  -- Unnamed 1 (c14) — two 56" gates
  (14, 'Gate A', 'gate', 56,   1),
  (14, 'Gate B', 'gate', 56,   2),
  (15, '6C',     'gate', 54,   1),
  (16, '6A',     'gate', 54,   1),
  (17, '6B',     'gate', 55,   1),
  (18, 'Woody''s','gate', 54,  1),
  (19, 'JW-6',   'gate', 56,   1),
  -- Unnamed 2 (c20) — two 56" gates
  (20, 'Gate A', 'gate', 56,   1),
  (20, 'Gate B', 'gate', 56,   2),
  (21, '7/SW',   'gate', 48,   1),
  (22, 'BV McA', 'gate', 42,   1),
  (23, 'JW-7',   'gate', 55,   1),
  -- McClung Weir (c24) — 4 gates under shared gauge
  (24, 'BV so. A', 'gate', 53,   1),
  (24, 'BV so. B', 'gate', 72,   2),
  (24, 'JW-8 A',   'gate', 55.2, 3),
  (24, 'JW-8 B',   'gate', 55.2, 4),
  -- BM Main (c25)
  (25, 'South',  'gate', 54, 1),
  (25, 'Middle', 'gate', 54, 2),
  (25, 'North',  'gate', 54, 3),
  -- BM Pond 1 (c26)
  (26, 'Gate A', 'gate', 48, 1),
  (26, 'Gate B', 'gate', 52, 2),
  -- BM Pond 2 (c27)
  (27, 'Gate A', 'gate', 48, 1),
  (27, 'Gate B', 'gate', 52, 2),
  -- BM Pond 3 (c28)
  (28, 'Gate A', 'gate', 52, 1),
  (28, 'Gate B', 'gate', 36, 2),
  (28, 'Gate C', 'gate', 36, 3),
  -- BM Pond 4 (c29)
  (29, 'Gate A', 'gate', 52, 1),
  (29, 'Gate B', 'gate', 36, 2),
  (29, 'Gate C', 'gate', 36, 3),
  -- BM Pond 5 (c30)
  (30, 'Gate A', 'gate', 24, 1),
  (30, 'Gate B', 'gate', 24, 2),
  -- BM Pond 6 (c31)
  (31, 'Gate A', 'gate', 48, 1);

SELECT setval('pond_gates_gate_id_seq', (SELECT MAX(gate_id) FROM pond_gates), true);
