ALTER TABLE wells ADD COLUMN IF NOT EXISTS access TEXT CHECK (access IN ('Tube', 'Plug'));
