-- Treatment List: a shared spray/bait checklist anyone can add to.
-- Active (unchecked) tasks are shown; checked-off tasks are hidden but kept
-- for history. Tracks who created each task and who checked it off.
CREATE TABLE IF NOT EXISTS pest_tasks (
  task_id      SERIAL PRIMARY KEY,
  description  TEXT NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  done         BOOLEAN DEFAULT FALSE,
  done_by      TEXT,
  done_at      TIMESTAMPTZ
);
