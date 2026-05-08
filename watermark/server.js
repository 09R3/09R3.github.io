require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const XLSX         = require('xlsx');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── File Uploads ──────────────────────────────────────────────────────────────
const UPLOADS_ROOT = process.env.UPLOADS_PATH || '/app/uploads';
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

// /uploads static route registered after sessions Map is declared (see below)

const UPLOAD_CATEGORIES = ['pumps','motors','wells','vehicles','electrical',
                           'structures','siphon-breakers','air-compressors',
                           'canal','misc','general'];

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const cat = UPLOAD_CATEGORIES.includes(req.query.category)
      ? req.query.category : 'general';
    const now  = new Date();
    const dir  = path.join(UPLOADS_ROOT, cat,
                           String(now.getFullYear()),
                           String(now.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
                     .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    cb(null, `${base}${ext}`);
  },
});
const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|heic|heif|webp)|application\/pdf$/.test(file.mimetype);
    cb(null, ok);
  },
});

app.post('/api/tools/upload', requireAuth, requireRole('supervisor', 'admin'),
  upload.array('files', 20), (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error: 'No valid files' });
    const cat = UPLOAD_CATEGORIES.includes(req.query.category)
      ? req.query.category : 'general';
    res.json(req.files.map(f => ({
      name:     f.originalname,
      filename: f.filename,
      url:      '/uploads/' + path.relative(UPLOADS_ROOT, f.path).replace(/\\/g, '/'),
      size:     f.size,
      mime:     f.mimetype,
      category: cat,
    })));
  }
);

app.get('/api/tools/files', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const cat     = req.query.category;
  const scanDir = cat && UPLOAD_CATEGORIES.includes(cat)
    ? path.join(UPLOADS_ROOT, cat) : UPLOADS_ROOT;

  if (!fs.existsSync(scanDir)) return res.json([]);
  const results = [];
  (function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full); return; }
      const rel   = path.relative(UPLOADS_ROOT, full).replace(/\\/g, '/');
      const parts = rel.split('/');
      results.push({
        url:      '/uploads/' + rel,
        relPath:  rel,
        name:     e.name,
        category: parts[0] || 'general',
        year:     parts[1] || '',
        month:    parts[2] || '',
        size:     fs.statSync(full).size,
        mtime:    fs.statSync(full).mtime,
      });
    });
  })(scanDir);
  results.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(results);
});

app.delete('/api/tools/file', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const { relPath, filePath } = req.body;
  const target = relPath || filePath;
  if (!target) return res.status(400).json({ error: 'relPath required' });
  const abs = path.resolve(UPLOADS_ROOT, target.replace(/^\/uploads\//, ''));
  if (!abs.startsWith(path.resolve(UPLOADS_ROOT)))
    return res.status(403).json({ error: 'Invalid path' });
  try { fs.unlinkSync(abs); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000,
  max: 10,
});

// ── Auto-migration ────────────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS bug_reports (
    report_id    SERIAL PRIMARY KEY,
    submitted_by VARCHAR(100) NOT NULL,
    submitted_at TIMESTAMP DEFAULT NOW(),
    screen_area  VARCHAR(100),
    severity     VARCHAR(20) DEFAULT 'minor',
    is_repeatable BOOLEAN DEFAULT FALSE,
    description  TEXT NOT NULL,
    app_version  VARCHAR(20),
    resolved     BOOLEAN DEFAULT FALSE,
    resolved_by  VARCHAR(100),
    resolved_at  TIMESTAMP
  )
`).catch(err => console.error('Migration error:', err.message));

pool.query(`ALTER TABLE maintenance_vehicles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'`)
  .catch(err => console.error('Migration error (mv_status):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS readings_piezometers (
    piezometer_reading_id SERIAL PRIMARY KEY,
    piezometer_id         INTEGER REFERENCES piezometers(piezometer_id),
    reading_date          DATE,
    reading_time          TIME,
    dtw_reading           NUMERIC,
    operator              TEXT,
    plopper_sounder       TEXT CHECK (plopper_sounder IN ('plopper','sounder')),
    wet_dry_moist         TEXT CHECK (wet_dry_moist IN ('wet','dry','moist')),
    notes                 TEXT
  )
`).catch(err => console.error('Migration error (readings_piezometers):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS maintenance_attachments (
    attachment_id  SERIAL PRIMARY KEY,
    table_name     TEXT NOT NULL,
    record_id      INTEGER NOT NULL,
    rel_path       TEXT NOT NULL,
    original_name  TEXT NOT NULL,
    file_type      TEXT DEFAULT 'photo',
    mime_type      TEXT,
    uploaded_by    TEXT,
    uploaded_at    TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Migration error (maint_attachments):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS canal_issues (
    issue_id       SERIAL PRIMARY KEY,
    pool           TEXT,
    status         TEXT NOT NULL DEFAULT 'open',
    description    TEXT,
    reported_date  DATE,
    entered_by     TEXT,
    action_taken   TEXT,
    resolution_notes TEXT,
    po_number      TEXT,
    cost           NUMERIC(10,2),
    notes          TEXT,
    gps_lat        DOUBLE PRECISION,
    gps_lon        DOUBLE PRECISION,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Migration error (canal_issues):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS pond_locations (
    location_id SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INT DEFAULT 0
  )
`).catch(err => console.error('Migration error (pond_locations):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS ponds (
    pond_id     SERIAL PRIMARY KEY,
    location_id INT REFERENCES pond_locations(location_id),
    name        TEXT NOT NULL,
    sort_order  INT DEFAULT 0,
    notes       TEXT
  )
`).catch(err => console.error('Migration error (ponds):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS river_outlets (
    outlet_id   SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INT DEFAULT 0,
    active      BOOLEAN DEFAULT TRUE,
    notes       TEXT
  )
`).catch(err => console.error('Migration error (river_outlets):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS pond_connections (
    connection_id      SERIAL PRIMARY KEY,
    destination_pond_id INT REFERENCES ponds(pond_id),
    name               TEXT,
    source_type        TEXT CHECK (source_type IN ('canal', 'river', 'pond')),
    source_canal_id    INT REFERENCES canal_structures(structure_id),
    source_river_id    INT REFERENCES river_outlets(outlet_id),
    source_pond_id     INT REFERENCES ponds(pond_id),
    sort_order         INT DEFAULT 0,
    active             BOOLEAN DEFAULT TRUE,
    notes              TEXT
  )
`).catch(err => console.error('Migration error (pond_connections):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS pond_gates (
    gate_id       SERIAL PRIMARY KEY,
    connection_id INT REFERENCES pond_connections(connection_id),
    label         TEXT NOT NULL,
    gate_type     TEXT NOT NULL DEFAULT 'gate',
    width_in      NUMERIC,
    sort_order    INT DEFAULT 0,
    active        BOOLEAN DEFAULT TRUE,
    notes         TEXT
  )
`).catch(err => console.error('Migration error (pond_gates):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS readings_staff_gauge (
    reading_id   SERIAL PRIMARY KEY,
    pond_id      INT REFERENCES ponds(pond_id),
    reading_date DATE NOT NULL,
    reading_time TIME,
    level_ft     NUMERIC NOT NULL,
    entered_by   TEXT,
    notes        TEXT,
    created_at   TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('Migration error (readings_staff_gauge):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS readings_pond_gates (
    reading_id   SERIAL PRIMARY KEY,
    gate_id      INT REFERENCES pond_gates(gate_id),
    reading_date DATE NOT NULL,
    reading_time TIME,
    head_ft      NUMERIC,
    opening_in   NUMERIC,
    overpour_in  NUMERIC,
    flow_cfs     NUMERIC,
    entered_by   TEXT,
    notes        TEXT,
    created_at   TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('Migration error (readings_pond_gates):', err.message));

// Rename overpour column if it was created with the old name
pool.query(`
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='readings_pond_gates' AND column_name='overpour_ft'
    ) THEN
      ALTER TABLE readings_pond_gates RENAME COLUMN overpour_ft TO overpour_in;
    END IF;
  END $$
`).catch(err => console.error('Migration error (overpour rename):', err.message));

// ── Auth / Sessions ───────────────────────────────────────────────────────────
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map();

// Serve uploads behind session auth now that sessions Map exists
app.use('/uploads', (req, res, next) => {
  const session = sessions.get(req.cookies?.fo_session);
  if (!session || Date.now() > session.expires) return res.status(401).send('Unauthorized');
  next();
}, express.static(UPLOADS_ROOT));

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s.user;
}

function requireAuth(req, res, next) {
  const user = getSession(req.cookies?.fo_session);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function isSuperiorTo(requestingRole, targetRole) {
  const rank = { admin: 3, supervisor: 2, operator: 1 };
  return (rank[requestingRole] || 0) > (rank[targetRole] || 0);
}

function todayString() {
  return new Date().toISOString().split('T')[0];
}

function dateString(d) {
  return new Date(d).toISOString().split('T')[0];
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active = true',
      [username]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    // Support both bcrypt hashes and legacy plaintext passwords
    let valid = false;
    if (user.password && user.password.startsWith('$2')) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      valid = user.password === password;
      if (valid) {
        // Rehash plaintext on successful login
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashed, user.user_id]);
      }
    }

    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const sessionUser = {
      user_id: user.user_id,
      username: user.username,
      full_name: user.full_name || user.username,
      role: user.role || 'operator',
      initials: user.initials || user.username.slice(0, 2).toUpperCase(),
    };
    const token = createSession(sessionUser);
    res.cookie('fo_session', token, { httpOnly: true, maxAge: SESSION_TTL });
    res.json({ user: sessionUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/logout', (req, res) => {
  const token = req.cookies?.fo_session;
  if (token) sessions.delete(token);
  res.clearCookie('fo_session');
  res.json({ ok: true });
});

app.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ── Public: DB status + test (no auth — needed before login) ─────────────────
app.get('/api/db-status', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      connected: true,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.post('/api/db-test', requireAuth, requireRole('admin'), async (req, res) => {
  const { host, port, database, user, password } = req.body || {};
  if (!host || !database || !user) {
    return res.status(400).json({ error: 'host, database, and user are required' });
  }
  const testPool = new Pool({
    host, port: parseInt(port) || 5432, database, user, password,
    connectionTimeoutMillis: 5000, max: 1,
  });
  try {
    await testPool.query('SELECT 1');
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  } finally {
    testPool.end().catch(() => {});
  }
});

// ── Public: username list for login dropdown ──────────────────────────────────
app.get('/api/users/list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT username, full_name FROM users WHERE is_active = true ORDER BY full_name, username'
    );
    res.json(rows);
  } catch (err) {
    // Return empty list if DB not connected — login form falls back gracefully
    res.json([]);
  }
});

// ── Sites ─────────────────────────────────────────────────────────────────────
app.get('/api/sites', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT site_id, site_name, site_type FROM sites ORDER BY site_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Buildings ─────────────────────────────────────────────────────────────────
app.get('/api/buildings', requireAuth, async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id required' });
  try {
    const { rows } = await pool.query(
      'SELECT building_id, building_letter, building_name FROM buildings WHERE site_id = $1 ORDER BY building_letter',
      [site_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pumping Plant Equipment (with last reading) ───────────────────────────────
app.get('/api/pump-positions', requireAuth, async (req, res) => {
  const { building_id } = req.query;
  if (!building_id) return res.status(400).json({ error: 'building_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        pp.position_id, pp.pump_letter, pp.status,
        pu.status AS pump_unit_status,
        r.reading_id    AS last_reading_id,
        r.hour_reading  AS last_reading,
        r.reading_date  AS last_reading_date,
        r.entered_by    AS last_entered_by,
        r.notes         AS last_notes
      FROM pump_positions pp
      LEFT JOIN pump_units pu ON pu.pump_unit_id = pp.current_pump_unit_id
      LEFT JOIN LATERAL (
        SELECT reading_id, hour_reading, reading_date, entered_by, notes
        FROM readings_pump_hours
        WHERE position_id = pp.position_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE pp.building_id = $1
      ORDER BY pp.pump_letter
    `, [building_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All pump positions grouped for siphon breaker PM
app.get('/api/pump-positions/all', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pp.position_id,
        pp.pump_letter,
        b.building_id,
        b.building_letter,
        s.site_id,
        s.site_name,
        REGEXP_REPLACE(s.site_name, '[^0-9]', '', 'g') AS site_number
      FROM pump_positions pp
      JOIN buildings b ON pp.building_id = b.building_id
      JOIN sites     s ON b.site_id      = s.site_id
      WHERE LOWER(pp.status) != 'inactive' OR pp.status IS NULL
      ORDER BY s.site_name, b.building_letter, pp.pump_letter
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/air-compressors', requireAuth, async (req, res) => {
  const { building_id } = req.query;
  if (!building_id) return res.status(400).json({ error: 'building_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        ac.compressor_id, ac.manufacturer, ac.model_number, ac.status,
        r.reading_id    AS last_reading_id,
        r.hour_reading  AS last_reading,
        r.reading_date  AS last_reading_date,
        r.notes         AS last_notes
      FROM air_compressors ac
      LEFT JOIN LATERAL (
        SELECT reading_id, hour_reading, reading_date, notes
        FROM readings_compressor_hours
        WHERE compressor_id = ac.compressor_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE ac.building_id = $1
      ORDER BY ac.compressor_id
    `, [building_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pge-meters', requireAuth, async (req, res) => {
  const { building_id } = req.query;
  if (!building_id) return res.status(400).json({ error: 'building_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        pm.pge_meter_id, pm.meter_name, pm.meter_number,
        r.reading_id   AS last_reading_id,
        r.kwh_reading  AS last_reading,
        r.reading_date AS last_reading_date,
        r.notes        AS last_notes
      FROM pge_meters pm
      LEFT JOIN LATERAL (
        SELECT reading_id, kwh_reading, reading_date, notes
        FROM readings_pge_meters
        WHERE pge_meter_id = pm.pge_meter_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE pm.building_id = $1
      ORDER BY pm.pge_meter_id
    `, [building_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/power-monitors', requireAuth, async (req, res) => {
  const { building_id } = req.query;
  if (!building_id) return res.status(400).json({ error: 'building_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        pm.monitor_id, pm.monitor_number, pm.manufacturer,
        r.reading_id   AS last_reading_id,
        r.kwh_reading  AS last_reading,
        r.reading_date AS last_reading_date,
        r.notes        AS last_notes
      FROM power_monitors pm
      LEFT JOIN LATERAL (
        SELECT reading_id, kwh_reading, reading_date, notes
        FROM readings_power_monitors
        WHERE monitor_id = pm.monitor_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE pm.building_id = $1
      ORDER BY pm.monitor_id
    `, [building_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pumping Plant — All site data in one query (replaces N+1 per-building calls)
app.get('/api/pp-site-data', requireAuth, async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        b.building_id, b.building_letter, b.building_name,
        (
          SELECT COALESCE(json_agg(p ORDER BY p.pump_letter), '[]'::json)
          FROM (
            SELECT
              pp.position_id, pp.pump_letter, pp.status,
              r.reading_id   AS last_reading_id,
              r.hour_reading AS last_reading,
              r.reading_date AS last_reading_date,
              r.entered_by   AS last_entered_by,
              r.notes        AS last_notes
            FROM pump_positions pp
            LEFT JOIN LATERAL (
              SELECT reading_id, hour_reading, reading_date, entered_by, notes
              FROM readings_pump_hours
              WHERE position_id = pp.position_id
              ORDER BY reading_date DESC, reading_time DESC
              LIMIT 1
            ) r ON true
            WHERE pp.building_id = b.building_id
          ) p
        ) AS pumps,
        (
          SELECT COALESCE(json_agg(c ORDER BY c.compressor_id), '[]'::json)
          FROM (
            SELECT
              ac.compressor_id, ac.manufacturer, ac.model_number, ac.status,
              r.reading_id   AS last_reading_id,
              r.hour_reading AS last_reading,
              r.reading_date AS last_reading_date,
              r.notes        AS last_notes
            FROM air_compressors ac
            LEFT JOIN LATERAL (
              SELECT reading_id, hour_reading, reading_date, notes
              FROM readings_compressor_hours
              WHERE compressor_id = ac.compressor_id
              ORDER BY reading_date DESC, reading_time DESC
              LIMIT 1
            ) r ON true
            WHERE ac.building_id = b.building_id
          ) c
        ) AS compressors,
        (
          SELECT COALESCE(json_agg(m ORDER BY m.pge_meter_id), '[]'::json)
          FROM (
            SELECT
              pm.pge_meter_id, pm.meter_name, pm.meter_number,
              r.reading_id   AS last_reading_id,
              r.kwh_reading  AS last_reading,
              r.reading_date AS last_reading_date,
              r.notes        AS last_notes
            FROM pge_meters pm
            LEFT JOIN LATERAL (
              SELECT reading_id, kwh_reading, reading_date, notes
              FROM readings_pge_meters
              WHERE pge_meter_id = pm.pge_meter_id
              ORDER BY reading_date DESC, reading_time DESC
              LIMIT 1
            ) r ON true
            WHERE pm.building_id = b.building_id
          ) m
        ) AS pge_meters,
        (
          SELECT COALESCE(json_agg(mo ORDER BY mo.monitor_id), '[]'::json)
          FROM (
            SELECT
              pw.monitor_id, pw.monitor_number, pw.manufacturer,
              r.reading_id   AS last_reading_id,
              r.kwh_reading  AS last_reading,
              r.reading_date AS last_reading_date,
              r.notes        AS last_notes
            FROM power_monitors pw
            LEFT JOIN LATERAL (
              SELECT reading_id, kwh_reading, reading_date, notes
              FROM readings_power_monitors
              WHERE monitor_id = pw.monitor_id
              ORDER BY reading_date DESC, reading_time DESC
              LIMIT 1
            ) r ON true
            WHERE pw.building_id = b.building_id
          ) mo
        ) AS power_monitors
      FROM buildings b
      WHERE b.site_id = $1
      ORDER BY b.building_letter
    `, [site_id]);

    res.json(rows.map(({ pge_meters, power_monitors, ...b }) => ({
      ...b,
      pgeMeters: pge_meters,
      powerMonitors: power_monitors,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pumping Plant — Batch Save ────────────────────────────────────────────────
app.post('/api/readings/pumping-plant', requireAuth, async (req, res) => {
  const {
    reading_date, reading_time,
    pump_readings = [], compressor_readings = [],
    pge_readings = [], monitor_readings = [],
  } = req.body;

  if (!reading_date || !reading_time) {
    return res.status(400).json({ error: 'reading_date and reading_time are required' });
  }

  const entered_by = req.user.username;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = { pump: [], compressor: [], pge: [], monitor: [] };

    for (const r of pump_readings) {
      if (r.hour_reading === '' || r.hour_reading == null) continue;
      const { rows } = await client.query(
        `INSERT INTO readings_pump_hours (position_id, reading_date, reading_time, hour_reading, entered_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING reading_id`,
        [r.position_id, reading_date, reading_time, r.hour_reading, entered_by, r.notes || null]
      );
      saved.pump.push({ position_id: r.position_id, reading_id: rows[0].reading_id });
    }

    for (const r of compressor_readings) {
      if (r.hour_reading === '' || r.hour_reading == null) continue;
      const { rows } = await client.query(
        `INSERT INTO readings_compressor_hours (compressor_id, reading_date, reading_time, hour_reading, entered_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING reading_id`,
        [r.compressor_id, reading_date, reading_time, r.hour_reading, entered_by, r.notes || null]
      );
      saved.compressor.push({ compressor_id: r.compressor_id, reading_id: rows[0].reading_id });
    }

    for (const r of pge_readings) {
      if (r.kwh_reading === '' || r.kwh_reading == null) continue;
      const { rows } = await client.query(
        `INSERT INTO readings_pge_meters (pge_meter_id, reading_date, reading_time, kwh_reading, entered_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING reading_id`,
        [r.pge_meter_id, reading_date, reading_time, r.kwh_reading, entered_by, r.notes || null]
      );
      saved.pge.push({ pge_meter_id: r.pge_meter_id, reading_id: rows[0].reading_id });
    }

    for (const r of monitor_readings) {
      if (r.kwh_reading === '' || r.kwh_reading == null) continue;
      const { rows } = await client.query(
        `INSERT INTO readings_power_monitors (monitor_id, reading_date, reading_time, kwh_reading, entered_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING reading_id`,
        [r.monitor_id, reading_date, reading_time, r.kwh_reading, entered_by, r.notes || null]
      );
      saved.monitor.push({ monitor_id: r.monitor_id, reading_id: rows[0].reading_id });
    }

    await client.query('COMMIT');
    res.json({ ok: true, saved });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save pumping plant error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Delete helpers (permissions enforced) ─────────────────────────────────────
async function deleteReading(req, res, table, idCol) {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Reading not found' });

    const role = req.user.role;
    const username = req.user.username;
    const readingDT = new Date(`${dateString(row.reading_date)}T${(row.reading_time || '00:00').slice(0,5)}`);
    const within24h = (Date.now() - readingDT.getTime()) <= 24 * 60 * 60 * 1000;

    if (role === 'admin') {
      // admins: unrestricted
    } else if (role === 'supervisor') {
      if (!within24h) return res.status(403).json({ error: 'Supervisors can only delete readings within 24 hours' });
    } else {
      // operator (and any other role): own entry within 24h
      if (row.entered_by !== username || !within24h) {
        return res.status(403).json({ error: 'You can only delete your own readings within 24 hours' });
      }
    }

    await pool.query(`DELETE FROM ${table} WHERE ${idCol} = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.delete('/api/readings/pump-hours/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_pump_hours', 'reading_id'));

app.delete('/api/readings/compressor-hours/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_compressor_hours', 'reading_id'));

app.delete('/api/readings/pge-meters/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_pge_meters', 'reading_id'));

app.delete('/api/readings/power-monitors/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_power_monitors', 'reading_id'));

app.delete('/api/readings/well/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_well', 'reading_id'));

app.delete('/api/readings/canal/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_canal', 'reading_id'));

app.delete('/api/readings/vehicle-monthly/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_vehicle_monthly', 'reading_id'));

// ── Supervisor/Admin: Update readings ─────────────────────────────────────────
app.put('/api/readings/pump-hours/:id', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { hour_reading, notes } = req.body;
  try {
    await pool.query(
      'UPDATE readings_pump_hours SET hour_reading = $1, notes = $2 WHERE reading_id = $3',
      [hour_reading, notes, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Well Sets ─────────────────────────────────────────────────────────────────
app.get('/api/well-sets', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT set_id, set_name, description FROM well_sets ORDER BY set_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KF wells — includes GPS, last reading, days since reading
app.get('/api/wells/kf', requireAuth, async (req, res) => {
  const { start_date, end_date } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT
        w.well_id, w.common_name, w.state_well_number, w.area, w.kf_set_id, ws.set_name,
        w.gps_latitude, w.gps_longitude, w.is_important,
        -- Most recent reading ever (for pre-fill and hint display)
        prev.kf_reading_id   AS last_reading_id,
        prev.reading_date    AS last_reading_date,
        prev.dtw_reading     AS last_dtw,
        prev.plopper_sounder AS last_method,
        prev.notes           AS last_notes,
        (CURRENT_DATE - prev.reading_date)::int AS days_since_reading,
        -- Reading within widget date range (for done/not-read status only)
        rng.reading_date     AS range_reading_date
      FROM wells w
      LEFT JOIN well_sets ws ON w.kf_set_id = ws.set_id
      LEFT JOIN LATERAL (
        SELECT kf_reading_id, reading_date, dtw_reading, plopper_sounder, notes
        FROM readings_kf_monthly
        WHERE well_id = w.well_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) prev ON true
      LEFT JOIN LATERAL (
        SELECT reading_date
        FROM readings_kf_monthly
        WHERE well_id = w.well_id
          AND ($1::date IS NULL OR reading_date BETWEEN $1::date AND $2::date)
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) rng ON true
      WHERE w.kf_set_id IS NOT NULL
        AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
      ORDER BY ws.set_name, w.state_well_number, w.common_name
    `, [start_date || null, end_date || null]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Operational wells — for daily well readings screen, grouped by area with status
app.get('/api/wells/operational', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        w.well_id, w.common_name, w.area, w.well_type, w.status,
        w.gps_latitude, w.gps_longitude,
        r.reading_id        AS last_reading_id,
        r.reading_date      AS last_reading_date,
        r.reading_time      AS last_reading_time,
        r.hour_reading      AS last_hour_reading,
        r.flow_cfs          AS last_flow_cfs,
        r.totalizer         AS last_totalizer,
        r.dripper_oil       AS last_dripper_oil,
        r.pge_kwh           AS last_pge_kwh,
        r.notes             AS last_notes,
        EXTRACT(EPOCH FROM (NOW() - (r.reading_date + COALESCE(r.reading_time, '00:00'::time))))::int / 3600
                            AS hours_since_reading
      FROM wells w
      LEFT JOIN LATERAL (
        SELECT reading_id, reading_date, reading_time, hour_reading, flow_cfs, totalizer, dripper_oil, pge_kwh, notes
        FROM readings_well
        WHERE well_id = w.well_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE LOWER(w.well_type) LIKE '%operational%'
        AND (LOWER(w.status) NOT IN ('inactive','removed') OR w.status IS NULL)
      ORDER BY w.area, w.common_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KF Monthly Readings ───────────────────────────────────────────────────────
app.post('/api/readings/kf-monthly', requireAuth, async (req, res) => {
  const {
    well_id, reading_date, reading_time,
    dtw_reading, well_on_off, plopper_sounder, operator, notes,
  } = req.body;
  if (!well_id || dtw_reading == null) {
    return res.status(400).json({ error: 'well_id and dtw_reading are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_kf_monthly
         (well_id, common_name, reading_date, reading_time, dtw_reading, well_on_off, plopper_sounder, operator, notes)
       SELECT $1, common_name, $2, $3, $4, $5, $6, $7, $8
       FROM wells WHERE well_id = $1
       RETURNING kf_reading_id`,
      [well_id, reading_date, reading_time, dtw_reading,
       well_on_off ?? null, plopper_sounder || null, operator || null, notes || null]
    );
    res.json({ ok: true, kf_reading_id: rows[0].kf_reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/readings/kf-monthly/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_kf_monthly', 'kf_reading_id'));

// ── Piezometers ───────────────────────────────────────────────────────────────
app.get('/api/piezometers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.piezometer_id, p.piezometer_name, p.pool, p.sort_order,
        p.max_depth, p.gps_latitude, p.gps_longitude, p.notes,
        prev.piezometer_reading_id AS last_reading_id,
        prev.reading_date          AS last_reading_date,
        prev.dtw_reading           AS last_dtw,
        prev.plopper_sounder       AS last_method,
        prev.wet_dry_moist         AS last_wet_dry_moist,
        prev.notes                 AS last_reading_notes
      FROM piezometers p
      LEFT JOIN LATERAL (
        SELECT piezometer_reading_id, reading_date, dtw_reading, plopper_sounder, wet_dry_moist, notes
        FROM readings_piezometers
        WHERE piezometer_id = p.piezometer_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) prev ON true
      WHERE LOWER(p.status) = 'active'
      ORDER BY p.pool, p.sort_order, p.piezometer_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/piezometer', requireAuth, async (req, res) => {
  const {
    piezometer_id, reading_date, reading_time,
    dtw_reading, operator, plopper_sounder, wet_dry_moist, notes,
  } = req.body;
  if (!piezometer_id || !reading_date) {
    return res.status(400).json({ error: 'piezometer_id and reading_date are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_piezometers
         (piezometer_id, reading_date, reading_time, dtw_reading, operator, plopper_sounder, wet_dry_moist, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING piezometer_reading_id`,
      [piezometer_id, reading_date, reading_time || null, dtw_reading ?? null,
       operator || null, plopper_sounder || null, wet_dry_moist || null, notes || null]
    );
    res.json({ ok: true, piezometer_reading_id: rows[0].piezometer_reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DWR Well Run ──────────────────────────────────────────────────────────────
app.get('/api/wells/dwr', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        w.well_id, w.common_name, w.state_well_number, w.area,
        w.gps_latitude, w.gps_longitude,
        prev.reading_id      AS last_reading_id,
        prev.reading_date    AS last_reading_date,
        prev.depth_to_water  AS last_dtw,
        prev.method          AS last_method,
        prev.notes           AS last_notes,
        prev.no_measurement  AS last_no_measurement,
        (CURRENT_DATE - prev.reading_date)::int AS days_since_reading
      FROM wells w
      LEFT JOIN LATERAL (
        SELECT reading_id, reading_date, depth_to_water, method, notes, no_measurement
        FROM readings_run_dwr
        WHERE well_id = w.well_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) prev ON true
      WHERE w.well_run = 'DWR'
        AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
      ORDER BY w.state_well_number, w.common_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/run-dwr', requireAuth, async (req, res) => {
  const {
    well_id, reading_date, reading_time,
    depth_to_water, method, operator,
    no_measurement, questionable_measurement, notes,
  } = req.body;
  if (!well_id || !reading_date) {
    return res.status(400).json({ error: 'well_id and reading_date are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_run_dwr
         (well_id, reading_date, reading_time, depth_to_water, method, operator,
          no_measurement, questionable_measurement, notes, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING reading_id`,
      [
        well_id, reading_date, reading_time || null,
        depth_to_water != null ? depth_to_water : null,
        method || null, operator || null,
        no_measurement?.length ? no_measurement : null,
        questionable_measurement?.length ? questionable_measurement : null,
        notes || null, req.user.username,
      ]
    );
    res.json({ reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/readings/run-dwr/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_run_dwr', 'reading_id'));


app.get('/api/wells', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT well_id, common_name, area, status,
        (SELECT hour_reading FROM readings_well WHERE well_id = w.well_id ORDER BY reading_date DESC, reading_time DESC LIMIT 1) AS last_hours,
        (SELECT totalizer FROM readings_well WHERE well_id = w.well_id ORDER BY reading_date DESC, reading_time DESC LIMIT 1) AS last_totalizer
       FROM wells w
       WHERE status != 'inactive' OR status IS NULL
       ORDER BY common_name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/well', requireAuth, async (req, res) => {
  const {
    well_id, reading_date, reading_time, on_off, hour_reading,
    flow_cfs, totalizer, motor_oil, dripper_oil, pge_kwh, notes,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_well
         (well_id, common_name, reading_date, reading_time, on_off, hour_reading, flow_cfs, totalizer, motor_oil, dripper_oil, pge_kwh, entered_by, notes)
       SELECT $1, common_name, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       FROM wells WHERE well_id = $1
       RETURNING reading_id`,
      [well_id, reading_date, reading_time, on_off ?? null, hour_reading ?? null,
       flow_cfs ?? null, totalizer ?? null, motor_oil ?? null, dripper_oil ?? null,
       pge_kwh ?? null, req.user.username, notes || null]
    );
    res.json({ ok: true, reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Canal ─────────────────────────────────────────────────────────────────────
app.get('/api/canal-structures', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cs.structure_id, cs.structure_name, cs.structure_type, cs.flow_direction,
        r.instantaneous_flow_cfs AS last_flow,
        r.totalizer_reading_af   AS last_totalizer,
        r.gate_setting           AS last_gate,
        r.head_reading_ft        AS last_head,
        r.derived_flow_cfs       AS last_derived,
        r.reading_date           AS last_reading_date,
        r.reading_time           AS last_reading_time,
        r.notes                  AS last_notes
      FROM canal_structures cs
      LEFT JOIN LATERAL (
        SELECT instantaneous_flow_cfs, totalizer_reading_af, gate_setting,
               head_reading_ft, derived_flow_cfs, reading_date, reading_time, notes
        FROM readings_canal
        WHERE structure_id = cs.structure_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE cs.in_service = true
      ORDER BY cs.structure_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/canal', requireAuth, async (req, res) => {
  const {
    structure_id, reading_date, reading_time,
    instantaneous_flow_cfs, totalizer_reading_af, gate_setting,
    head_reading_ft, derived_flow_cfs, notes,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_canal
         (structure_id, reading_date, reading_time, instantaneous_flow_cfs,
          totalizer_reading_af, gate_setting, head_reading_ft, derived_flow_cfs, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING reading_id`,
      [structure_id, reading_date, reading_time, instantaneous_flow_cfs ?? null,
       totalizer_reading_af ?? null, gate_setting || null, head_reading_ft ?? null,
       derived_flow_cfs ?? null, req.user.username, notes || null]
    );
    res.json({ ok: true, reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ponds ─────────────────────────────────────────────────────────────────────
app.get('/api/ponds', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pl.location_id,
        pl.name            AS location_name,
        pl.sort_order      AS location_sort,
        p.pond_id,
        p.name             AS pond_name,
        p.sort_order       AS pond_sort,
        sg.reading_id      AS last_gauge_id,
        sg.level_ft        AS last_gauge_level,
        sg.reading_date    AS last_gauge_date,
        pc.connection_id,
        pc.name            AS connection_name,
        pc.sort_order      AS connection_sort,
        pg.gate_id,
        pg.label           AS gate_label,
        pg.gate_type,
        pg.width_in,
        pg.notes           AS gate_notes,
        pg.sort_order      AS gate_sort,
        gr.reading_id      AS last_gate_reading_id,
        gr.head_ft         AS last_head,
        gr.opening_in      AS last_opening,
        gr.overpour_in     AS last_overpour,
        gr.flow_cfs        AS last_flow,
        gr.reading_date    AS last_gate_date
      FROM pond_locations pl
      JOIN ponds p ON p.location_id = pl.location_id
      LEFT JOIN LATERAL (
        SELECT reading_id, level_ft, reading_date
        FROM readings_staff_gauge
        WHERE pond_id = p.pond_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) sg ON true
      LEFT JOIN pond_connections pc ON pc.source_pond_id = p.pond_id AND pc.active = true
      LEFT JOIN pond_gates pg ON pg.connection_id = pc.connection_id AND pg.active = true
      LEFT JOIN LATERAL (
        SELECT reading_id, head_ft, opening_in, overpour_in, flow_cfs, reading_date
        FROM readings_pond_gates
        WHERE gate_id = pg.gate_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) gr ON pg.gate_id IS NOT NULL
      ORDER BY pl.sort_order, p.sort_order, pc.sort_order, pg.sort_order
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/staff-gauge', requireAuth, async (req, res) => {
  const { pond_id, reading_date, reading_time, level_ft, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_staff_gauge
         (pond_id, reading_date, reading_time, level_ft, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING reading_id`,
      [pond_id, reading_date, reading_time || null, level_ft,
       req.user.username, notes || null]
    );
    res.json({ ok: true, reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/pond-gate', requireAuth, async (req, res) => {
  const { gate_id, reading_date, reading_time, head_ft, opening_in, overpour_in, flow_cfs, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_pond_gates
         (gate_id, reading_date, reading_time, head_ft, opening_in, overpour_in, flow_cfs, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING reading_id`,
      [gate_id, reading_date, reading_time || null, head_ft ?? null,
       opening_in ?? null, overpour_in ?? null, flow_cfs ?? null,
       req.user.username, notes || null]
    );
    res.json({ ok: true, reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/readings/staff-gauge/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_staff_gauge', 'reading_id'));

app.delete('/api/readings/pond-gate/:id', requireAuth, (req, res) =>
  deleteReading(req, res, 'readings_pond_gates', 'reading_id'));

app.get('/api/ponds/:id/polygon', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT
        p.pond_id,
        p.name                                                        AS pond_name,
        ST_AsGeoJSON(
          ST_MakePolygon(ST_MakeLine(array_agg(pp.geom ORDER BY pp.point_order)))
        )                                                             AS polygon_geojson,
        ST_AsGeoJSON(
          ST_Centroid(ST_MakePolygon(ST_MakeLine(array_agg(pp.geom ORDER BY pp.point_order))))
        )                                                             AS centroid_geojson
      FROM ponds p
      JOIN pond_points pp ON pp.pond_id = p.pond_id
      WHERE p.pond_id = $1
      GROUP BY p.pond_id, p.name
      HAVING COUNT(*) >= 3
    `, [id]);
    if (!rows.length) return res.json({ has_polygon: false });
    const row = rows[0];
    res.json({
      has_polygon:    true,
      pond_name:      row.pond_name,
      polygon:        JSON.parse(row.polygon_geojson),
      centroid:       JSON.parse(row.centroid_geojson),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ponds/polygons', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.pond_id,
        p.name                                                        AS pond_name,
        pl.location_id,
        pl.name                                                       AS location_name,
        ST_AsGeoJSON(
          ST_MakePolygon(ST_MakeLine(array_agg(pp.geom ORDER BY pp.point_order)))
        )                                                             AS polygon_geojson,
        ST_AsGeoJSON(
          ST_Centroid(ST_MakePolygon(ST_MakeLine(array_agg(pp.geom ORDER BY pp.point_order))))
        )                                                             AS centroid_geojson
      FROM ponds p
      JOIN pond_locations pl ON pl.location_id = p.location_id
      JOIN pond_points pp    ON pp.pond_id = p.pond_id
      GROUP BY p.pond_id, p.name, pl.location_id, pl.name, pl.sort_order, p.sort_order
      HAVING COUNT(*) >= 3
      ORDER BY pl.sort_order, p.sort_order
    `);
    res.json(rows.map(r => ({
      pond_id:       r.pond_id,
      pond_name:     r.pond_name,
      location_id:   r.location_id,
      location_name: r.location_name,
      polygon:       JSON.parse(r.polygon_geojson),
      centroid:      JSON.parse(r.centroid_geojson),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reading History ────────────────────────────────────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  try {
    let rows;
    const LIMIT = 5;
    if (type === 'pump') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, hour_reading AS value, entered_by, notes
         FROM readings_pump_hours WHERE position_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'compressor') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, hour_reading AS value, entered_by, notes
         FROM readings_compressor_hours WHERE compressor_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'pge') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, kwh_reading AS value, entered_by, notes
         FROM readings_pge_meters WHERE pge_meter_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'monitor') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, kwh_reading AS value, entered_by, notes
         FROM readings_power_monitors WHERE monitor_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'well') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, hour_reading, flow_cfs, totalizer, entered_by, notes
         FROM readings_well WHERE well_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'kf') {
      ({ rows } = await pool.query(
        `SELECT kf_reading_id AS id, reading_date, reading_time, dtw_reading AS value, plopper_sounder AS method, operator AS entered_by, notes
         FROM readings_kf_monthly WHERE well_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'canal') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, instantaneous_flow_cfs AS flow,
                totalizer_reading_af AS totalizer, gate_setting, entered_by, notes
         FROM readings_canal WHERE structure_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'vehicle') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time, odometer_miles, engine_hours, entered_by, notes
         FROM readings_vehicle_monthly WHERE vehicle_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'dwr') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time,
                depth_to_water AS value, method, operator AS entered_by,
                no_measurement, questionable_measurement, notes
         FROM readings_run_dwr WHERE well_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'piezometer') {
      ({ rows } = await pool.query(
        `SELECT piezometer_reading_id AS id, reading_date, reading_time,
                dtw_reading AS value, plopper_sounder AS method, wet_dry_moist,
                operator AS entered_by, notes
         FROM readings_piezometers WHERE piezometer_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'staff-gauge') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time,
                level_ft AS value, entered_by, notes
         FROM readings_staff_gauge WHERE pond_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else if (type === 'pond-gate') {
      ({ rows } = await pool.query(
        `SELECT reading_id AS id, reading_date, reading_time,
                head_ft, opening_in, overpour_in, flow_cfs, entered_by, notes
         FROM readings_pond_gates WHERE gate_id = $1
         ORDER BY reading_date DESC, reading_time DESC LIMIT $2`, [id, LIMIT]));
    } else {
      return res.status(400).json({ error: 'unknown type' });
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete History Reading ─────────────────────────────────────────────────────
app.delete('/api/history/:type/:id', requireAuth, async (req, res) => {
  const { type, id } = req.params;
  const TABLE_MAP = {
    pump:       { table: 'readings_pump_hours',       pk: 'reading_id' },
    compressor: { table: 'readings_compressor_hours', pk: 'reading_id' },
    pge:        { table: 'readings_pge_meters',       pk: 'reading_id' },
    monitor:    { table: 'readings_power_monitors',   pk: 'reading_id' },
    well:       { table: 'readings_well',             pk: 'reading_id' },
    kf:         { table: 'readings_kf_monthly',       pk: 'kf_reading_id' },
    canal:      { table: 'readings_canal',            pk: 'reading_id' },
    vehicle:    { table: 'readings_vehicle_monthly',  pk: 'reading_id' },
    dwr:          { table: 'readings_run_dwr',          pk: 'reading_id' },
    piezometer:   { table: 'readings_piezometers',      pk: 'piezometer_reading_id' },
    'staff-gauge':{ table: 'readings_staff_gauge',      pk: 'reading_id' },
    'pond-gate':  { table: 'readings_pond_gates',       pk: 'reading_id' },
  };
  const map = TABLE_MAP[type];
  if (!map) return res.status(400).json({ error: 'unknown type' });

  const role = req.user.role;
  const username = req.user.username;

  try {
    if (role === 'admin') {
      // Admins: unrestricted
      const { rows } = await pool.query(
        `DELETE FROM ${map.table} WHERE ${map.pk} = $1 RETURNING ${map.pk}`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Reading not found' });
    } else if (role === 'supervisor') {
      // Supervisors: any reading within 24 hours
      const { rows } = await pool.query(
        `DELETE FROM ${map.table}
         WHERE ${map.pk} = $1
           AND (reading_date + COALESCE(reading_time, '00:00'::time)) >= NOW() - INTERVAL '24 hours'
         RETURNING ${map.pk}`,
        [id]
      );
      if (!rows.length) return res.status(403).json({ error: 'Supervisors can only delete readings within 24 hours' });
    } else {
      // Operators: own entry only, within 24 hours
      const { rows } = await pool.query(
        `DELETE FROM ${map.table}
         WHERE ${map.pk} = $1
           AND entered_by = $2
           AND (reading_date + COALESCE(reading_time, '00:00'::time)) >= NOW() - INTERVAL '24 hours'
         RETURNING ${map.pk}`,
        [id, username]
      );
      if (!rows.length) return res.status(403).json({ error: 'You can only delete your own readings within 24 hours' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Vehicles ──────────────────────────────────────────────────────────────────
app.get('/api/vehicles', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        v.vehicle_id, v.vehicle_number, v.vehicle_type, v.year, v.make, v.model,
        v.vin, v.license_plate, v.fuel_type, v.assigned_user, v.reading_type, v.status,
        r.odometer_miles  AS last_odometer,
        r.engine_hours    AS last_engine_hours,
        r.reading_date    AS last_reading_date,
        r.notes           AS last_notes,
        m.next_service_miles,
        m.next_service_hours
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT odometer_miles, engine_hours, reading_date, notes
        FROM readings_vehicle_monthly
        WHERE vehicle_id = v.vehicle_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT next_service_miles, next_service_hours
        FROM maintenance_vehicles
        WHERE vehicle_id = v.vehicle_id
          AND (next_service_miles IS NOT NULL OR next_service_hours IS NOT NULL)
        ORDER BY work_date DESC
        LIMIT 1
      ) m ON true
      WHERE LOWER(v.status) != 'inactive' OR v.status IS NULL
      ORDER BY
        CASE LOWER(v.vehicle_type)
          WHEN 'truck'           THEN 1
          WHEN 'heavy_equipment' THEN 2
          WHEN 'trailer'         THEN 99
          ELSE 3
        END,
        v.vehicle_number
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Equipment by type (for maintenance form) ──────────────────────────────────
app.get('/api/equipment/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  try {
    let rows;
    if (type === 'pump') {
      ({ rows } = await pool.query(`
        SELECT pp.position_id::text AS id,
          REPLACE(s.site_name, 'Site', 'Plant') || ' — ' ||
          COALESCE(b.building_name, b.building_letter) || ' — Pump ' || pp.pump_letter AS name
        FROM pump_positions pp
        JOIN buildings b ON pp.building_id = b.building_id
        JOIN sites s ON pp.site_id = s.site_id
        WHERE LOWER(pp.status) != 'inactive' OR pp.status IS NULL
        ORDER BY s.site_name, b.building_letter, pp.pump_letter
      `));
    } else if (type === 'motor') {
      ({ rows } = await pool.query(`
        SELECT motor_id::text AS id,
          COALESCE(manufacturer,'') || ' ' || COALESCE(model_number,'') ||
          CASE WHEN current_location IS NOT NULL AND current_location != '' THEN ' (' || current_location || ')' ELSE '' END AS name
        FROM motors
        WHERE LOWER(status) != 'inactive' OR status IS NULL
        ORDER BY manufacturer, model_number
      `));
    } else if (type === 'compressor') {
      ({ rows } = await pool.query(`
        SELECT ac.compressor_id::text AS id,
          COALESCE(b.building_name, b.building_letter) || ' Air Compressor' ||
          CASE WHEN ac.manufacturer IS NOT NULL THEN ' (' || ac.manufacturer || ')' ELSE '' END AS name
        FROM air_compressors ac
        JOIN buildings b ON ac.building_id = b.building_id
        JOIN sites s ON b.site_id = s.site_id
        WHERE LOWER(ac.status) != 'inactive' OR ac.status IS NULL
        ORDER BY b.building_letter
      `));
    } else if (type === 'siphon_breaker') {
      ({ rows } = await pool.query(`
        SELECT pump_unit_id::text AS id,
          'SB-' || current_location || ' (' || manufacturer || ' ' || model_number || ')' AS name
        FROM siphon_breakers
        WHERE LOWER(status) != 'inactive' OR status IS NULL
        ORDER BY current_location
      `));
    } else {
      rows = [];
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Siphon Breaker Units (for swap form) ──────────────────────────────────────
app.get('/api/siphon-breakers/units', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pump_unit_id AS id, manufacturer, model_number, current_location, status,
        'SB-' || current_location || ' (' || manufacturer || ' ' || model_number || ')' AS name
      FROM siphon_breakers
      WHERE LOWER(status) != 'inactive'
      ORDER BY status, current_location
    `);
    const active = rows.filter(r => r.status?.toLowerCase() === 'active');
    const spares = rows.filter(r => r.status?.toLowerCase() === 'spare');
    res.json({ active, spares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/siphon-breakers/swap', requireAuth, async (req, res) => {
  const { remove_id, install_id, swap_date, performed_by, notes } = req.body;
  if (!remove_id || !install_id || !swap_date) {
    return res.status(400).json({ error: 'remove_id, install_id, and swap_date are required' });
  }
  if (remove_id === install_id) {
    return res.status(400).json({ error: 'Cannot swap a unit with itself' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get the removed unit's current location
    const { rows: [removed] } = await client.query(
      'SELECT current_location FROM siphon_breakers WHERE pump_unit_id = $1', [remove_id]
    );
    if (!removed) throw new Error('Removed unit not found');
    const location = removed.current_location;
    // Move removed unit to spare
    await client.query(
      `UPDATE siphon_breakers SET status = 'Spare', current_location = NULL WHERE pump_unit_id = $1`,
      [remove_id]
    );
    // Install spare at the freed location
    await client.query(
      `UPDATE siphon_breakers SET status = 'active', current_location = $1 WHERE pump_unit_id = $2`,
      [location, install_id]
    );
    // Log the swap
    await client.query(
      `INSERT INTO siphon_breaker_swaps
         (swap_date, location, unit_removed_id, unit_installed_id, performed_by, notes, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [swap_date, location, remove_id, install_id, performed_by || null, notes || null, req.user.username]
    );
    await client.query('COMMIT');
    res.json({ ok: true, location });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Well Issues ───────────────────────────────────────────────────────────────
app.get('/api/well-issues', requireAuth, async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT wi.issue_id, wi.well_id, wi.well_name, wi.well_area,
             wi.status, wi.description, wi.reported_date, wi.resolved_date,
             wi.action_taken, wi.resolution_notes, wi.po_number, wi.cost,
             wi.entered_by, wi.assigned_to, wi.notes, wi.created_at,
             (SELECT COUNT(*) FROM maintenance_attachments
              WHERE table_name = 'well_issues' AND record_id = wi.issue_id) AS attachment_count
      FROM well_issues wi
      WHERE $1 OR wi.status != 'resolved'
      ORDER BY
        CASE wi.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
        wi.reported_date DESC
    `, [includeResolved]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/well-issues', requireAuth, async (req, res) => {
  const { well_id, well_name, well_area, description,
          reported_date, assigned_to, notes } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO well_issues
        (well_id, well_name, well_area, description,
         reported_date, assigned_to, notes, entered_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING issue_id
    `, [well_id || null, well_name || null, well_area || null, description,
        reported_date || null, assigned_to || null, notes || null, req.user.username]);
    res.json({ ok: true, issue_id: rows[0].issue_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/well-issues/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, action_taken, resolution_notes, po_number, cost, assigned_to, notes } = req.body;
  try {
    await pool.query(`
      UPDATE well_issues SET
        status           = COALESCE($1, status),
        action_taken     = COALESCE($2, action_taken),
        resolution_notes = COALESCE($3, resolution_notes),
        po_number        = COALESCE($4, po_number),
        cost             = COALESCE($5, cost),
        assigned_to      = COALESCE($6, assigned_to),
        notes            = COALESCE($7, notes),
        resolved_date    = CASE WHEN $1 = 'resolved' THEN CURRENT_DATE
                                WHEN $1 IN ('open','in_progress') THEN NULL
                                ELSE resolved_date END,
        updated_at       = NOW()
      WHERE issue_id = $8
    `, [status || null, action_taken ?? null, resolution_notes ?? null,
        po_number ?? null, cost ?? null, assigned_to ?? null, notes ?? null, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Building Issues ───────────────────────────────────────────────────────────
app.get('/api/building-issues', requireAuth, async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT bi.issue_id, bi.building_id, bi.site_id, bi.building_name, bi.site_name,
             bi.status, bi.description, bi.reported_date, bi.resolved_date,
             bi.action_taken, bi.resolution_notes, bi.po_number, bi.cost,
             bi.entered_by, bi.assigned_to, bi.notes, bi.created_at,
             (SELECT COUNT(*) FROM maintenance_attachments
              WHERE table_name = 'building_issues' AND record_id = bi.issue_id) AS attachment_count
      FROM building_issues bi
      WHERE $1 OR bi.status != 'resolved'
      ORDER BY
        CASE bi.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
        bi.reported_date DESC
    `, [includeResolved]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/building-issues', requireAuth, async (req, res) => {
  const { building_id, site_id, building_name, site_name,
          description, reported_date, assigned_to, notes } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO building_issues
        (building_id, site_id, building_name, site_name,
         description, reported_date, assigned_to, notes, entered_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING issue_id
    `, [building_id || null, site_id || null, building_name || null, site_name || null,
        description, reported_date || null, assigned_to || null, notes || null, req.user.username]);
    res.json({ ok: true, issue_id: rows[0].issue_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/building-issues/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, action_taken, resolution_notes, po_number, cost, assigned_to, notes } = req.body;
  try {
    await pool.query(`
      UPDATE building_issues SET
        status           = COALESCE($1, status),
        action_taken     = COALESCE($2, action_taken),
        resolution_notes = COALESCE($3, resolution_notes),
        po_number        = COALESCE($4, po_number),
        cost             = COALESCE($5, cost),
        assigned_to      = COALESCE($6, assigned_to),
        notes            = COALESCE($7, notes),
        resolved_date    = CASE WHEN $1 = 'resolved' THEN CURRENT_DATE
                                WHEN $1 IN ('open','in_progress') THEN NULL
                                ELSE resolved_date END,
        updated_at       = NOW()
      WHERE issue_id = $8
    `, [status || null, action_taken ?? null, resolution_notes ?? null,
        po_number ?? null, cost ?? null, assigned_to ?? null, notes ?? null, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Equipment Issues ──────────────────────────────────────────────────────────
app.get('/api/equipment-issues', requireAuth, async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT ei.issue_id, ei.equipment_type, ei.equipment_id, ei.equipment_name,
             ei.status, ei.description, ei.reported_date, ei.resolved_date,
             ei.action_taken, ei.resolution_notes, ei.po_number, ei.cost,
             ei.entered_by, ei.assigned_to, ei.notes, ei.created_at,
             (SELECT COUNT(*) FROM maintenance_attachments
              WHERE table_name = 'equipment_issues' AND record_id = ei.issue_id) AS attachment_count
      FROM equipment_issues ei
      WHERE $1 OR ei.status != 'resolved'
      ORDER BY
        CASE ei.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
        ei.reported_date DESC
    `, [includeResolved]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/equipment-issues', requireAuth, async (req, res) => {
  const { equipment_type, equipment_id, equipment_name, description,
          reported_date, assigned_to, notes } = req.body;
  if (!equipment_type || !description) {
    return res.status(400).json({ error: 'equipment_type and description are required' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO equipment_issues
        (equipment_type, equipment_id, equipment_name, description,
         reported_date, assigned_to, notes, entered_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING issue_id
    `, [equipment_type, equipment_id || null, equipment_name || null, description,
        reported_date || null, assigned_to || null, notes || null, req.user.username]);
    res.json({ ok: true, issue_id: rows[0].issue_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/equipment-issues/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, action_taken, resolution_notes, po_number, cost, assigned_to, notes } = req.body;
  try {
    await pool.query(`
      UPDATE equipment_issues SET
        status           = COALESCE($1, status),
        action_taken     = COALESCE($2, action_taken),
        resolution_notes = COALESCE($3, resolution_notes),
        po_number        = COALESCE($4, po_number),
        cost             = COALESCE($5, cost),
        assigned_to      = COALESCE($6, assigned_to),
        notes            = COALESCE($7, notes),
        resolved_date    = CASE WHEN $1 = 'resolved' THEN CURRENT_DATE
                                WHEN $1 IN ('open','in_progress') THEN NULL
                                ELSE resolved_date END,
        updated_at       = NOW()
      WHERE issue_id = $8
    `, [status || null, action_taken ?? null, resolution_notes ?? null,
        po_number ?? null, cost ?? null, assigned_to ?? null, notes ?? null, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Canal Issues ──────────────────────────────────────────────────────────────
app.get('/api/canal-issues', requireAuth, async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT ci.*,
             (SELECT COUNT(*) FROM maintenance_attachments
              WHERE table_name = 'canal_issues' AND record_id = ci.issue_id) AS attachment_count
      FROM canal_issues ci
      WHERE $1 OR ci.status != 'resolved'
      ORDER BY
        CASE ci.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        ci.reported_date DESC
    `, [includeResolved]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/canal-issues', requireAuth, async (req, res) => {
  const { pool: poolNum, description, reported_date, gps_lat, gps_lon } = req.body;
  const entered_by = req.user.username;
  try {
    const { rows } = await pool.query(`
      INSERT INTO canal_issues (pool, description, reported_date, entered_by, gps_lat, gps_lon)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [poolNum || null, description || null, reported_date || null, entered_by,
        gps_lat != null ? parseFloat(gps_lat) : null,
        gps_lon != null ? parseFloat(gps_lon) : null]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/canal-issues/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, action_taken, resolution_notes, po_number, cost, notes, gps_lat, gps_lon } = req.body;
  try {
    await pool.query(`
      UPDATE canal_issues SET
        status           = COALESCE($1, status),
        action_taken     = COALESCE($2, action_taken),
        resolution_notes = COALESCE($3, resolution_notes),
        po_number        = COALESCE($4, po_number),
        cost             = COALESCE($5, cost),
        notes            = COALESCE($6, notes),
        gps_lat          = CASE WHEN $8::boolean THEN $9::double precision ELSE gps_lat END,
        gps_lon          = CASE WHEN $8::boolean THEN $10::double precision ELSE gps_lon END,
        updated_at       = NOW()
      WHERE issue_id = $7
    `, [status || null, action_taken ?? null, resolution_notes ?? null,
        po_number ?? null, cost ?? null, notes ?? null, id,
        gps_lat != null && gps_lon != null,
        gps_lat != null ? parseFloat(gps_lat) : null,
        gps_lon != null ? parseFloat(gps_lon) : null]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Equipment Swap Units (unified, by category) ───────────────────────────────
app.get('/api/equipment-swap-units/:category', requireAuth, async (req, res) => {
  const { category } = req.params;

  const TABLE_MAP = {
    siphon_breaker: { table: 'siphon_breakers', id: 'pump_unit_id',  wellJoin: false },
    motor:          { table: 'motors',          id: 'motor_id',       wellJoin: false },
    pp_pump:        { table: 'pump_units',      id: 'pump_unit_id',   wellJoin: false },
    well_motor:     { table: 'well_motors',     id: 'well_motor_id',  wellJoin: true  },
    well_meter:     { table: 'well_meters',     id: 'well_meter_id',  wellJoin: true  },
  };

  const mapping = TABLE_MAP[category];
  if (!mapping) return res.status(400).json({ error: 'Unknown category' });

  try {
    let rows;
    if (mapping.wellJoin) {
      ({ rows } = await pool.query(`
        SELECT t.${mapping.id} AS id, t.manufacturer, t.model_number, t.well_id, t.status,
          COALESCE(t.manufacturer,'') || ' ' || COALESCE(t.model_number,'') ||
          CASE WHEN w.common_name IS NOT NULL THEN ' (' || w.common_name || ')' ELSE ' (spare)' END AS name,
          w.common_name AS current_location
        FROM ${mapping.table} t
        LEFT JOIN wells w ON t.well_id = w.well_id
        WHERE LOWER(t.status) != 'inactive'
        ORDER BY t.status, w.common_name, t.manufacturer, t.model_number
      `));
    } else {
      let nameExpr;
      if (category === 'siphon_breaker') {
        nameExpr = `'SB-' || COALESCE(current_location,'?') || ' (' || COALESCE(manufacturer,'') || ' ' || COALESCE(model_number,'') || ')'`;
      } else {
        nameExpr = `COALESCE(manufacturer,'') || ' ' || COALESCE(model_number,'') ||
          CASE WHEN current_location IS NOT NULL AND current_location != ''
               THEN ' (' || current_location || ')' ELSE ' (spare)' END`;
      }
      ({ rows } = await pool.query(`
        SELECT ${mapping.id} AS id, manufacturer, model_number, current_location, status,
          ${nameExpr} AS name
        FROM ${mapping.table}
        WHERE LOWER(status) != 'inactive'
        ORDER BY status, current_location, manufacturer, model_number
      `));
    }

    const active = rows.filter(r => r.status?.toLowerCase() === 'active');
    const spares = rows.filter(r => r.status?.toLowerCase() !== 'active');
    res.json({ active, spares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Equipment Swap — unified (siphon_breaker / motor / pp_pump / well_motor / well_meter)
app.post('/api/equipment-swaps', requireAuth, async (req, res) => {
  const { category, remove_id, install_id, swap_date, performed_by, notes } = req.body;
  if (!category || !remove_id || !install_id || !swap_date) {
    return res.status(400).json({ error: 'category, remove_id, install_id, and swap_date are required' });
  }
  if (remove_id === install_id) {
    return res.status(400).json({ error: 'Cannot swap a unit with itself' });
  }

  const TABLE_MAP = {
    siphon_breaker: { table: 'siphon_breakers', id: 'pump_unit_id',  wellJoin: false },
    motor:          { table: 'motors',          id: 'motor_id',       wellJoin: false },
    pp_pump:        { table: 'pump_units',      id: 'pump_unit_id',   wellJoin: false },
    well_motor:     { table: 'well_motors',     id: 'well_motor_id',  wellJoin: true  },
    well_meter:     { table: 'well_meters',     id: 'well_meter_id',  wellJoin: true  },
  };

  const mapping = TABLE_MAP[category];
  if (!mapping) return res.status(400).json({ error: 'Unknown category' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let location, removedDesc;
    if (mapping.wellJoin) {
      const { rows: [removed] } = await client.query(
        `SELECT t.well_id, w.common_name, t.manufacturer, t.model_number
         FROM ${mapping.table} t
         LEFT JOIN wells w ON t.well_id = w.well_id
         WHERE t.${mapping.id} = $1`,
        [remove_id]
      );
      if (!removed) throw new Error('Unit being removed not found');
      location    = removed.common_name || String(removed.well_id || '');
      removedDesc = `${removed.manufacturer || ''} ${removed.model_number || ''} from ${location}`.trim();

      await client.query(
        `UPDATE ${mapping.table} SET status = 'spare', well_id = NULL WHERE ${mapping.id} = $1`,
        [remove_id]
      );
      await client.query(
        `UPDATE ${mapping.table} SET status = 'active', well_id = $1 WHERE ${mapping.id} = $2`,
        [removed.well_id, install_id]
      );
    } else {
      const { rows: [removed] } = await client.query(
        `SELECT current_location, manufacturer, model_number FROM ${mapping.table} WHERE ${mapping.id} = $1`,
        [remove_id]
      );
      if (!removed) throw new Error('Unit being removed not found');
      location    = removed.current_location;
      removedDesc = `${removed.manufacturer || ''} ${removed.model_number || ''} from ${location}`.trim();

      await client.query(
        `UPDATE ${mapping.table} SET status = 'spare', current_location = NULL WHERE ${mapping.id} = $1`,
        [remove_id]
      );
      await client.query(
        `UPDATE ${mapping.table} SET status = 'active', current_location = $1 WHERE ${mapping.id} = $2`,
        [location, install_id]
      );
    }

    const { rows: [installed] } = await client.query(
      `SELECT manufacturer, model_number FROM ${mapping.table} WHERE ${mapping.id} = $1`,
      [install_id]
    );
    if (!installed) throw new Error('Unit being installed not found');
    const installedDesc = `${installed.manufacturer || ''} ${installed.model_number || ''}`.trim();

    await client.query(
      `INSERT INTO equipment_swaps
         (category, swap_date, location, item_removed_id, item_installed_id,
          removed_description, installed_description, performed_by, notes, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [category, swap_date, location, remove_id, install_id,
       removedDesc, installedDesc, performed_by || null, notes || null, req.user.username]
    );

    await client.query('COMMIT');
    res.json({ ok: true, location });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Maintenance badge counts ──────────────────────────────────────────────────
app.get('/api/maintenance/badge-counts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM equipment_issues
         WHERE status IN ('open','in_progress')) AS equipment,
        (SELECT COUNT(*) FROM building_issues
         WHERE status IN ('open','in_progress')) AS buildings,
        (SELECT COUNT(*) FROM well_issues
         WHERE status IN ('open','in_progress')) AS wells,
        (SELECT COUNT(*) FROM maintenance_vehicles
         WHERE status IN ('open','in-progress')) AS vehicles,
        (SELECT COUNT(*) FROM canal_issues
         WHERE status IN ('open','in_progress')) AS canal
    `);
    const counts = rows[0];
    res.json({
      equipment: parseInt(counts.equipment) || 0,
      buildings: parseInt(counts.buildings) || 0,
      wells:     parseInt(counts.wells)     || 0,
      vehicles:  parseInt(counts.vehicles)  || 0,
      canal:     parseInt(counts.canal)     || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/maintenance/vehicles-list', requireAuth, async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT mv.maintenance_id, mv.work_date, mv.work_type, mv.description,
             mv.status, mv.notes, mv.performed_by, mv.entered_by,
             mv.parts_used, mv.cost, mv.po_number,
             v.vehicle_number, v.make, v.model,
             (SELECT COUNT(*) FROM maintenance_attachments
              WHERE table_name = 'maintenance_vehicles' AND record_id = mv.maintenance_id
             ) AS attachment_count
      FROM maintenance_vehicles mv
      JOIN vehicles v ON v.vehicle_id = mv.vehicle_id
      WHERE ($1 OR mv.status NOT IN ('resolved'))
      ORDER BY mv.work_date DESC, mv.maintenance_id DESC
      LIMIT 100
    `, [includeResolved]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/maintenance/vehicle/:id', requireAuth, async (req, res) => {
  const { status, notes, performed_by, po_number, cost } = req.body;
  try {
    await pool.query(
      `UPDATE maintenance_vehicles
       SET status=$1, notes=$2, performed_by=$3, po_number=$4, cost=$5
       WHERE maintenance_id=$6`,
      [status, notes || null, performed_by || null, po_number || null,
       cost != null && cost !== '' ? parseFloat(cost) : null,
       parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard stats ───────────────────────────────────────────────────────────
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    // Load KF widget date range from app_settings (fall back to current month)
    const settingsRes = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('kf_widget_start','kf_widget_end')`
    ).catch(() => ({ rows: [] }));
    const settingsMap = Object.fromEntries(settingsRes.rows.map(r => [r.key, r.value]));
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const defaultStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const defaultEnd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
    const kfStart = settingsMap['kf_widget_start'] || defaultStart;
    const kfEnd   = settingsMap['kf_widget_end']   || defaultEnd;

    const [kf, wells] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                              AS total,
          COUNT(*) FILTER (WHERE is_done)       AS done,
          COUNT(*) FILTER (WHERE NOT is_done)   AS due
        FROM (
          SELECT w.well_id,
            EXISTS (
              SELECT 1 FROM readings_kf_monthly r
              WHERE r.well_id = w.well_id
                AND r.reading_date BETWEEN $1 AND $2
            ) AS is_done
          FROM wells w
          WHERE w.kf_set_id IS NOT NULL
            AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
        ) s
      `, [kfStart, kfEnd]),
      pool.query(`
        SELECT
          COUNT(*)                                                 AS total,
          COUNT(*) FILTER (WHERE last_date = CURRENT_DATE)        AS read_today,
          COUNT(*) FILTER (WHERE last_date IS NULL OR last_date < CURRENT_DATE) AS unread_today
        FROM (
          SELECT w.well_id,
            (SELECT reading_date FROM readings_well WHERE well_id = w.well_id
             ORDER BY reading_date DESC LIMIT 1) AS last_date
          FROM wells w
          WHERE LOWER(w.well_type) LIKE '%operational%'
            AND (LOWER(w.status) NOT IN ('inactive','removed') OR w.status IS NULL)
        ) s
      `),
    ]);
    res.json({
      kf_total:         parseInt(kf.rows[0].total),
      kf_done:          parseInt(kf.rows[0].done),
      kf_due:           parseInt(kf.rows[0].due),
      kf_widget_start:  kfStart,
      kf_widget_end:    kfEnd,
      wells_total:      parseInt(wells.rows[0].total),
      wells_read_today: parseInt(wells.rows[0].read_today),
      wells_due_today:  parseInt(wells.rows[0].unread_today),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KF Widget Settings ────────────────────────────────────────────────────────
app.get('/api/settings/kf-widget', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('kf_widget_start','kf_widget_end')`
    );
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ start_date: m['kf_widget_start'] || null, end_date: m['kf_widget_end'] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/kf-widget', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { start_date, end_date } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES
         ('kf_widget_start', $1, NOW()),
         ('kf_widget_end',   $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [start_date, end_date]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/readings/vehicle-monthly', requireAuth, async (req, res) => {
  const { vehicle_id, vehicle_number, reading_date, reading_time, odometer_miles, engine_hours, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO readings_vehicle_monthly
         (vehicle_id, vehicle_number, reading_date, reading_time, entered_by, odometer_miles, engine_hours, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING reading_id`,
      [vehicle_id, vehicle_number || null, reading_date, reading_time,
       req.user.username, odometer_miles ?? null, engine_hours ?? null, notes || null]
    );
    res.json({ ok: true, reading_id: rows[0].reading_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Maintenance ───────────────────────────────────────────────────────────────
app.post('/api/maintenance/equipment', requireAuth, async (req, res) => {
  const {
    equipment_type, equipment_id, work_date, work_type, performed_by,
    is_contractor, location_at_time, description, parts_used, cost, po_number,
    hours_at_service, next_service_date, notes,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_equipment
         (equipment_type, equipment_id, work_date, work_type, performed_by, is_contractor,
          entered_by, location_at_time, description, parts_used, cost, po_number,
          hours_at_service, next_service_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING maintenance_id`,
      [equipment_type, equipment_id, work_date, work_type, performed_by,
       is_contractor ?? false, req.user.username, location_at_time || null,
       description || null, parts_used || null, cost ?? null, po_number || null,
       hours_at_service ?? null, next_service_date || null, notes || null]
    );
    res.json({ ok: true, maintenance_id: rows[0].maintenance_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance/vehicle', requireAuth, async (req, res) => {
  const {
    vehicle_id, work_date, work_type, performed_by, is_contractor,
    description, odometer_at_service, engine_hours_at_service,
    parts_used, cost, po_number, next_service_date, next_service_miles, next_service_hours,
    notes, status,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_vehicles
         (vehicle_id, work_date, work_type, performed_by, is_contractor, entered_by,
          description, odometer_at_service, engine_hours_at_service, parts_used, cost,
          po_number, next_service_date, next_service_miles, next_service_hours, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING maintenance_id`,
      [vehicle_id, work_date, work_type, performed_by, is_contractor ?? false,
       req.user.username, description || null, odometer_at_service ?? null,
       engine_hours_at_service ?? null, parts_used || null, cost ?? null,
       po_number || null, next_service_date || null, next_service_miles ?? null,
       next_service_hours ?? null, notes || null, status || 'open']
    );
    res.json({ ok: true, maintenance_id: rows[0].maintenance_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance/building', requireAuth, async (req, res) => {
  const {
    building_id, work_date, work_type, record_type, description,
    performed_by, is_contractor, severity, status, cost, po_number,
    resolution_notes, next_service_date, notes,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_buildings
         (building_id, work_date, work_type, record_type, description, performed_by,
          is_contractor, entered_by, severity, status, cost, po_number,
          resolution_notes, next_service_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING record_id`,
      [building_id, work_date, work_type, record_type || null, description || null,
       performed_by, is_contractor ?? false, req.user.username, severity || null,
       status || null, cost ?? null, po_number || null, resolution_notes || null,
       next_service_date || null, notes || null]
    );
    res.json({ ok: true, record_id: rows[0].record_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Maintenance History ────────────────────────────────────────────────────────
app.get('/api/maintenance/history', requireAuth, async (req, res) => {
  const { type, id, equip_type } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  try {
    let rows;
    if (type === 'equipment') {
      ({ rows } = await pool.query(
        `SELECT work_date, work_type, description, performed_by, is_contractor,
                parts_used, cost, notes, entered_by
         FROM maintenance_equipment
         WHERE equipment_type = $1 AND equipment_id = $2
         ORDER BY work_date DESC LIMIT 15`,
        [equip_type, id]
      ));
    } else if (type === 'vehicle') {
      ({ rows } = await pool.query(
        `SELECT mv.maintenance_id, mv.work_date, mv.work_type, mv.description,
                mv.performed_by, mv.is_contractor, mv.parts_used, mv.cost,
                mv.odometer_at_service, mv.engine_hours_at_service,
                mv.next_service_miles, mv.next_service_hours, mv.notes,
                mv.entered_by, mv.status,
                (SELECT COUNT(*) FROM maintenance_attachments
                 WHERE table_name = 'maintenance_vehicles' AND record_id = mv.maintenance_id
                ) AS attachment_count
         FROM maintenance_vehicles mv
         WHERE mv.vehicle_id = $1
         ORDER BY mv.work_date DESC LIMIT 15`,
        [id]
      ));
    } else if (type === 'building') {
      ({ rows } = await pool.query(
        `SELECT work_date, work_type, record_type, description, performed_by,
                is_contractor, severity, status, cost, notes, entered_by
         FROM maintenance_buildings
         WHERE building_id = $1
         ORDER BY work_date DESC LIMIT 15`,
        [id]
      ));
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Maintenance Attachments ───────────────────────────────────────────────────
app.post('/api/maintenance/attachment', requireAuth,
  upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const { table_name, record_id, file_type } = req.query;
    const rel = path.relative(UPLOADS_ROOT, req.file.path).replace(/\\/g, '/');
    try {
      const { rows } = await pool.query(
        `INSERT INTO maintenance_attachments
           (table_name, record_id, rel_path, original_name, file_type, mime_type, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING attachment_id`,
        [table_name || 'maintenance_vehicles', parseInt(record_id), rel,
         req.file.originalname, file_type || 'photo', req.file.mimetype, req.user.username]
      );
      res.json({ ok: true, attachment_id: rows[0].attachment_id, rel_path: rel });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/maintenance/attachments', requireAuth, async (req, res) => {
  const { table_name, record_id } = req.query;
  if (!table_name || !record_id) return res.status(400).json({ error: 'table_name and record_id required' });
  try {
    const { rows } = await pool.query(
      `SELECT attachment_id, rel_path, original_name, file_type, mime_type, uploaded_by, uploaded_at
       FROM maintenance_attachments
       WHERE table_name = $1 AND record_id = $2
       ORDER BY uploaded_at`,
      [table_name, parseInt(record_id)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/maintenance/attachment/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rel_path, uploaded_by FROM maintenance_attachments WHERE attachment_id = $1`,
      [parseInt(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rel_path, uploaded_by } = rows[0];
    if (req.user.username !== uploaded_by && !['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Cannot delete another user\'s attachment' });
    }
    await pool.query(`DELETE FROM maintenance_attachments WHERE attachment_id = $1`, [parseInt(req.params.id)]);
    const abs = path.join(UPLOADS_ROOT, rel_path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports ────────────────────────────────────────────────────────────────────
const downloadTokens = new Map();

// Issue a short-lived one-time download token (30s) — solves iOS PWA cookie issue
app.post('/api/reports/download-token', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  downloadTokens.set(token, { ...req.body, expires: Date.now() + 30000 });
  setTimeout(() => downloadTokens.delete(token), 30000);
  res.json({ token });
});

app.get('/api/reports/mileage', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (v.vehicle_id)
         v.vehicle_id, v.vehicle_number, v.make, v.model, v.assigned_user,
         v.reading_type, r.odometer_miles, r.engine_hours, r.reading_date
       FROM vehicles v
       LEFT JOIN readings_vehicle_monthly r
         ON r.vehicle_id = v.vehicle_id
         AND EXTRACT(YEAR  FROM r.reading_date) = $1
         AND EXTRACT(MONTH FROM r.reading_date) = $2
       WHERE (LOWER(v.status) != 'inactive' OR v.status IS NULL)
       ORDER BY v.vehicle_id, r.reading_date DESC NULLS LAST, r.reading_time DESC NULLS LAST`,
      [parseInt(year), parseInt(month)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/mileage/export', async (req, res) => {
  const { year, month, format, token } = req.query;
  if (!year || !month || !format) return res.status(400).json({ error: 'year, month and format required' });

  // Accept either session auth or a valid one-time token
  if (token) {
    const t = downloadTokens.get(token);
    if (!t || Date.now() > t.expires) return res.status(401).json({ error: 'Invalid or expired token' });
    downloadTokens.delete(token); // one-time use
  } else {
    // Fall back to session auth
    const sessionUser = getSession(req.cookies?.fo_session);
    if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });
    if (sessionUser.role !== 'admin' && sessionUser.role !== 'supervisor')
      return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (v.vehicle_id)
         v.vehicle_id, v.vehicle_number, v.make, v.model, v.assigned_user,
         v.reading_type, r.odometer_miles, r.engine_hours, r.reading_date
       FROM vehicles v
       LEFT JOIN readings_vehicle_monthly r
         ON r.vehicle_id = v.vehicle_id
         AND EXTRACT(YEAR  FROM r.reading_date) = $1
         AND EXTRACT(MONTH FROM r.reading_date) = $2
       WHERE (LOWER(v.status) != 'inactive' OR v.status IS NULL)
       ORDER BY v.vehicle_id, r.reading_date DESC NULLS LAST, r.reading_time DESC NULLS LAST`,
      [parseInt(year), parseInt(month)]
    );

    const monthName = new Date(parseInt(year), parseInt(month) - 1, 1)
      .toLocaleString('en-US', { month: 'long' });
    const label = `${monthName} ${year}`;

    const assignedVal = u => (u && u.trim().toLowerCase() !== 'ops & maint') ? u : '';

    const trucks = rows.filter(r => !r.reading_type || r.reading_type === 'odometer');
    const heavy  = rows.filter(r => r.reading_type === 'hours' || r.reading_type === 'both');

    if (format === 'csv') {
      const lines = [`CVC Mileage — ${label}`, ''];
      lines.push('TRUCKS');
      lines.push('Unit #,Make,Model,Operator,Odometer');
      trucks.forEach(v => lines.push(
        [v.vehicle_number, v.make, v.model, assignedVal(v.assigned_user),
         v.odometer_miles ?? ''].join(',')
      ));
      lines.push('');
      lines.push('HEAVY EQUIPMENT');
      lines.push('Unit #,Make,Model,Operator,Odometer,Engine Hours');
      heavy.forEach(v => lines.push(
        [v.vehicle_number, v.make, v.model, assignedVal(v.assigned_user),
         v.odometer_miles ?? '', v.engine_hours ?? ''].join(',')
      ));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="CVC_Mileage_${year}_${month}.csv"`);
      return res.send(lines.join('\r\n'));
    }

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();

      const truckData = [
        [`CVC Mileage — ${label}`],
        ['TRUCKS'],
        ['Unit #', 'Make', 'Model', 'Operator', 'Odometer'],
        ...trucks.map(v => [v.vehicle_number, v.make || '', v.model || '',
          assignedVal(v.assigned_user), v.odometer_miles != null ? Number(v.odometer_miles) : '']),
        [],
        ['HEAVY EQUIPMENT'],
        ['Unit #', 'Make', 'Model', 'Operator', 'Odometer', 'Engine Hours'],
        ...heavy.map(v => [v.vehicle_number, v.make || '', v.model || '',
          assignedVal(v.assigned_user),
          v.odometer_miles != null ? Number(v.odometer_miles) : '',
          v.engine_hours   != null ? Number(v.engine_hours)   : '']),
      ];

      const ws = XLSX.utils.aoa_to_sheet(truckData);
      ws['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Mileage');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="CVC_Mileage_${year}_${month}.xlsx"`);
      return res.send(buf);
    }

    res.status(400).json({ error: 'Invalid format' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KF Breakdown Report ───────────────────────────────────────────────────────
app.get('/api/reports/kf-operators', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const { rows } = await pool.query(
      `WITH total_wells AS (
         SELECT COUNT(*) AS cnt
         FROM wells
         WHERE kf_set_id IS NOT NULL
           AND (LOWER(status) != 'inactive' OR status IS NULL)
       ),
       distinct_read AS (
         SELECT COUNT(DISTINCT well_id) AS cnt
         FROM readings_kf_monthly
         WHERE reading_date BETWEEN $1 AND $2
       )
       SELECT
         COALESCE(r.operator, '(no operator)') AS operator,
         COUNT(DISTINCT r.well_id)             AS wells_read,
         (SELECT cnt FROM total_wells)         AS total_wells,
         (SELECT cnt FROM distinct_read)       AS distinct_read
       FROM readings_kf_monthly r
       WHERE r.reading_date BETWEEN $1 AND $2
       GROUP BY r.operator
       ORDER BY wells_read DESC`,
      [start_date, end_date]
    );
    const totalWells = rows[0]?.total_wells ? parseInt(rows[0].total_wells) : 0;
    const distinctRead = rows[0]?.distinct_read ? parseInt(rows[0].distinct_read) : 0;
    res.json({ rows, distinctRead, totalWells });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vehicle last-service report
app.get('/api/reports/vehicle-service', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        v.vehicle_id, v.vehicle_number, v.vehicle_type, v.make, v.model,
        v.assigned_user, v.reading_type,
        r.odometer_miles        AS current_odometer,
        r.engine_hours          AS current_engine_hours,
        r.reading_date          AS current_reading_date,
        m.work_date             AS last_service_date,
        m.work_type             AS last_service_type,
        m.odometer_at_service,
        m.engine_hours_at_service,
        m.next_service_miles,
        m.next_service_hours
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT odometer_miles, engine_hours, reading_date
        FROM readings_vehicle_monthly
        WHERE vehicle_id = v.vehicle_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT work_date, work_type, odometer_at_service,
               engine_hours_at_service, next_service_miles, next_service_hours
        FROM maintenance_vehicles
        WHERE vehicle_id = v.vehicle_id
        ORDER BY work_date DESC
        LIMIT 1
      ) m ON true
      WHERE LOWER(v.status) != 'inactive' OR v.status IS NULL
      ORDER BY
        CASE LOWER(v.vehicle_type)
          WHEN 'truck'           THEN 1
          WHEN 'heavy_equipment' THEN 2
          WHEN 'trailer'         THEN 99
          ELSE 3
        END,
        v.vehicle_number
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Piezometer readings report — latest reading per piezometer within date range
app.get('/api/reports/piezometers', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        p.piezometer_id, p.piezometer_name, p.pool, p.sort_order,
        r.reading_date, r.reading_time, r.dtw_reading,
        r.operator, r.plopper_sounder, r.wet_dry_moist, r.notes
      FROM piezometers p
      LEFT JOIN LATERAL (
        SELECT reading_date, reading_time, dtw_reading, operator,
               plopper_sounder, wet_dry_moist, notes
        FROM readings_piezometers
        WHERE piezometer_id = p.piezometer_id
          AND reading_date BETWEEN $1 AND $2
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE LOWER(p.status) != 'inactive'
      ORDER BY p.pool NULLS LAST, p.sort_order, p.piezometer_name
    `, [start_date, end_date]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Canal readings report — all readings for a date range
app.get('/api/reports/canal', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        cs.structure_name, cs.structure_type,
        r.reading_date, r.reading_time,
        r.instantaneous_flow_cfs, r.totalizer_reading_af,
        r.gate_setting, r.head_reading_ft, r.derived_flow_cfs,
        r.entered_by, r.notes
      FROM readings_canal r
      JOIN canal_structures cs ON cs.structure_id = r.structure_id
      WHERE r.reading_date BETWEEN $1 AND $2
      ORDER BY r.reading_date, r.reading_time, cs.structure_name
    `, [start_date, end_date]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/ponds', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const { rows: gauges } = await pool.query(`
      SELECT
        pl.name  AS location_name,
        pl.sort_order AS location_sort,
        p.pond_id, p.name AS pond_name, p.sort_order AS pond_sort,
        sg.level_ft, sg.reading_time, sg.entered_by, sg.notes AS gauge_notes
      FROM ponds p
      JOIN pond_locations pl ON pl.location_id = p.location_id
      LEFT JOIN readings_staff_gauge sg
        ON sg.pond_id = p.pond_id AND sg.reading_date = $1
      ORDER BY pl.sort_order, p.sort_order
    `, [date]);
    res.json({ gauges });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Piezometer status/compare XLSX export (token-authenticated)
app.get('/api/reports/piezometers/export', async (req, res) => {
  const { start_date, end_date, token } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  if (token) {
    const t = downloadTokens.get(token);
    if (!t || Date.now() > t.expires) return res.status(401).json({ error: 'Invalid or expired token' });
    downloadTokens.delete(token);
  } else {
    const sessionUser = getSession(req.cookies?.fo_session);
    if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });
    if (sessionUser.role !== 'admin' && sessionUser.role !== 'supervisor')
      return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT p.piezometer_name, p.pool, p.sort_order,
             r.reading_date, r.dtw_reading, r.operator, r.plopper_sounder, r.wet_dry_moist
      FROM piezometers p
      LEFT JOIN LATERAL (
        SELECT reading_date, dtw_reading, operator, plopper_sounder, wet_dry_moist
        FROM readings_piezometers
        WHERE piezometer_id = p.piezometer_id
          AND reading_date BETWEEN $1 AND $2
        ORDER BY reading_date DESC, reading_time DESC LIMIT 1
      ) r ON true
      WHERE LOWER(p.status) != 'inactive'
      ORDER BY p.pool NULLS LAST, p.sort_order, p.piezometer_name
    `, [start_date, end_date]);

    const wb = XLSX.utils.book_new();
    const data = [
      ['Piezometer Readings', `${start_date} to ${end_date}`],
      [],
      ['Pool', 'Name', 'DTW (ft)', 'Method', 'Operator', 'Date'],
      ...rows.map(r => [
        r.pool || '', r.piezometer_name,
        r.dtw_reading != null ? Number(r.dtw_reading) : '',
        [r.plopper_sounder, r.wet_dry_moist].filter(Boolean).join(' / ') || '',
        r.operator || '',
        r.reading_date ? r.reading_date.toISOString().slice(0, 10) : '',
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Piezometers');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Piezometers_${start_date}_${end_date}.xlsx"`);
    return res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/piezometers/compare/export', async (req, res) => {
  const { s1, e1, s2, e2, token } = req.query;
  if (!s1 || !e1 || !s2 || !e2) return res.status(400).json({ error: 'Four date params required' });
  if (token) {
    const t = downloadTokens.get(token);
    if (!t || Date.now() > t.expires) return res.status(401).json({ error: 'Invalid or expired token' });
    downloadTokens.delete(token);
  } else {
    const sessionUser = getSession(req.cookies?.fo_session);
    if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });
    if (sessionUser.role !== 'admin' && sessionUser.role !== 'supervisor')
      return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const latestReading = (piezId, start, end) => pool.query(`
      SELECT dtw_reading FROM readings_piezometers
      WHERE piezometer_id = $1 AND reading_date BETWEEN $2 AND $3
      ORDER BY reading_date DESC, reading_time DESC LIMIT 1
    `, [piezId, start, end]);

    const { rows: piez } = await pool.query(`
      SELECT piezometer_id, piezometer_name, pool, sort_order
      FROM piezometers WHERE LOWER(status) != 'inactive'
      ORDER BY pool NULLS LAST, sort_order, piezometer_name
    `);

    const rows = await Promise.all(piez.map(async p => {
      const [r1, r2] = await Promise.all([latestReading(p.piezometer_id, s1, e1), latestReading(p.piezometer_id, s2, e2)]);
      const d1 = r1.rows[0]?.dtw_reading != null ? Number(r1.rows[0].dtw_reading) : null;
      const d2 = r2.rows[0]?.dtw_reading != null ? Number(r2.rows[0].dtw_reading) : null;
      const diff = d1 != null && d2 != null ? d2 - d1 : null;
      return [p.pool || '', p.piezometer_name, d1 ?? '', d2 ?? '', diff != null ? Number(diff.toFixed(2)) : ''];
    }));

    const wb = XLSX.utils.book_new();
    const data = [
      ['Piezometer Comparison', `${s1}–${e1}  vs  ${s2}–${e2}`],
      [],
      ['Pool', 'Name', `DTW 1 (${s1}–${e1})`, `DTW 2 (${s2}–${e2})`, 'Difference'],
      ...rows,
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Comparison');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Piezometers_Compare_${s1}_${s2}.xlsx"`);
    return res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// KF set-by-set breakdown
app.get('/api/reports/kf-sets', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        ws.set_name,
        COUNT(DISTINCT w.well_id)                                              AS total_wells,
        COUNT(DISTINCT CASE WHEN r.well_id IS NOT NULL THEN r.well_id END)     AS wells_read
      FROM well_sets ws
      JOIN wells w ON w.kf_set_id = ws.set_id
        AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
      LEFT JOIN readings_kf_monthly r
        ON r.well_id = w.well_id
        AND r.reading_date BETWEEN $1 AND $2
      GROUP BY ws.set_id, ws.set_name
      ORDER BY ws.set_name
    `, [start_date, end_date]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open maintenance issues across all three categories
app.get('/api/reports/maintenance-issues', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 'Wells' AS category, issue_id,
        COALESCE(well_name, 'Unknown') AS location_name,
        description, status, reported_date, assigned_to, action_taken
      FROM well_issues
      WHERE status IN ('open','in_progress')
      UNION ALL
      SELECT 'Buildings', issue_id,
        TRIM(COALESCE(site_name,'') ||
          CASE WHEN building_name IS NOT NULL THEN ' — ' || building_name ELSE '' END
        ) AS location_name,
        description, status, reported_date, assigned_to, action_taken
      FROM building_issues
      WHERE status IN ('open','in_progress')
      UNION ALL
      SELECT 'Equipment', issue_id,
        COALESCE(equipment_name, equipment_type, 'Unknown') AS location_name,
        description, status, reported_date, assigned_to, action_taken
      FROM equipment_issues
      WHERE status IN ('open','in_progress')
      ORDER BY category, reported_date ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PM Grid report — latest per-plant siphon breaker + air compressor records + positions
app.get('/api/reports/pm-grid', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { year, month } = req.query;
  let dateClause = '';
  const params = [];
  if (year && month) {
    const from = `${parseInt(year)}-${String(parseInt(month)).padStart(2,'0')}-01`;
    const d = new Date(parseInt(year), parseInt(month), 0); // last day of month
    const to = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    dateClause = `AND p.completed_date >= '${from}' AND p.completed_date <= '${to}'`;
  }
  try {
    const [sbRes, acRes, posRes] = await Promise.all([
      pool.query(`
        SELECT DISTINCT ON (p.building)
          p.building, p.completed_date, p.completed_time,
          u.full_name AS applied_by, p.checklist
        FROM pm_records p
        LEFT JOIN users u ON u.user_id = p.completed_by
        WHERE p.pm_type = 'siphon_breaker' AND p.building IS NOT NULL ${dateClause}
        ORDER BY p.building, p.completed_date DESC, p.completed_time DESC
      `),
      pool.query(`
        SELECT DISTINCT ON (p.building)
          p.building, p.completed_date, p.completed_time,
          u.full_name AS applied_by, p.checklist
        FROM pm_records p
        LEFT JOIN users u ON u.user_id = p.completed_by
        WHERE p.pm_type = 'air_compressor' AND p.building IS NOT NULL ${dateClause}
        ORDER BY p.building, p.completed_date DESC, p.completed_time DESC
      `),
      pool.query(`
        SELECT pp.position_id, pp.pump_letter, b.building_letter,
               s.site_id, s.site_name,
               REGEXP_REPLACE(s.site_name, '[^0-9]', '', 'g') AS site_number
        FROM pump_positions pp
        JOIN buildings b ON pp.building_id = b.building_id
        JOIN sites     s ON b.site_id = s.site_id
        WHERE LOWER(pp.status) != 'inactive' OR pp.status IS NULL
        ORDER BY s.site_name, b.building_letter, pp.pump_letter
      `),
    ]);
    const sbRecords = {}, acRecords = {};
    sbRes.rows.forEach(r => { sbRecords[r.building] = r; });
    acRes.rows.forEach(r => { acRecords[r.building] = r; });
    res.json({ sbRecords, acRecords, positions: posRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pesticides ────────────────────────────────────────────────────────────────

// List pesticides (active only for operators; all for supervisor/admin)
app.get('/api/pesticides', requireAuth, async (req, res) => {
  try {
    const supervisorRoles = ['supervisor', 'admin'];
    const showAll = supervisorRoles.includes(req.user.role);
    const { rows } = await pool.query(
      `SELECT pesticide_id, name, epa_reg_number, unit_of_measure, active, created_at
       FROM pesticides
       ${showAll ? '' : 'WHERE active = TRUE'}
       ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new pesticide (all roles)
app.post('/api/pesticides', requireAuth, async (req, res) => {
  const { name, epa_reg_number, unit_of_measure } = req.body;
  if (!name || !unit_of_measure) return res.status(400).json({ error: 'name and unit_of_measure required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO pesticides (name, epa_reg_number, unit_of_measure)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name.trim(), epa_reg_number?.trim() || null, unit_of_measure.trim()]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deactivate / reactivate a pesticide (supervisor/admin only)
app.patch('/api/pesticides/:id', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ error: 'active required' });
  try {
    const { rows } = await pool.query(
      `UPDATE pesticides SET active = $1 WHERE pesticide_id = $2 RETURNING *`,
      [active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List usage entries (most recent first, joined with pesticide name)
app.get('/api/pesticide-usage', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.usage_id, u.pesticide_id, p.name AS pesticide_name, p.unit_of_measure,
              u.used_date, u.used_time, u.applied_by,
              usr.full_name AS applicator_name,
              u.quantity, u.location_description, u.notes, u.created_at
       FROM pesticide_usage u
       JOIN pesticides p ON p.pesticide_id = u.pesticide_id
       LEFT JOIN users usr ON usr.user_id = u.applied_by
       ORDER BY u.used_date DESC, u.used_time DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log new usage entry (date/time/user auto from server)
app.post('/api/pesticide-usage', requireAuth, async (req, res) => {
  const { pesticide_id, quantity } = req.body;
  if (!pesticide_id || quantity == null) return res.status(400).json({ error: 'pesticide_id and quantity required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO pesticide_usage (pesticide_id, quantity, applied_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [pesticide_id, quantity, req.user.user_id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update location/notes on a usage entry
app.patch('/api/pesticide-usage/:id', requireAuth, async (req, res) => {
  const { location_description, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE pesticide_usage
       SET location_description = $1, notes = $2
       WHERE usage_id = $3
       RETURNING *`,
      [location_description || null, notes || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monthly totals report
app.get('/api/pesticide-usage/monthly', requireAuth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    const { rows } = await pool.query(
      `SELECT p.name AS pesticide_name, p.unit_of_measure,
              SUM(u.quantity) AS total_quantity,
              COUNT(*) AS entry_count
       FROM pesticide_usage u
       JOIN pesticides p ON p.pesticide_id = u.pesticide_id
       WHERE EXTRACT(YEAR  FROM u.used_date) = $1
         AND EXTRACT(MONTH FROM u.used_date) = $2
       GROUP BY p.pesticide_id, p.name, p.unit_of_measure
       ORDER BY p.name`,
      [parseInt(year), parseInt(month)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PM Records ────────────────────────────────────────────────────────────────

// Last completed date per PM type (for tile badges)
app.get('/api/pm-records/last-completed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (pm_type)
         pm_type, completed_date, completed_time, u.full_name AS completed_by_name
       FROM pm_records p
       LEFT JOIN users u ON u.user_id = p.completed_by
       ORDER BY pm_type, completed_date DESC, completed_time DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List records for a PM type
app.get('/api/pm-records', requireAuth, async (req, res) => {
  const { type, building } = req.query;
  if (!type) return res.status(400).json({ error: 'type required' });
  try {
    const params = [type];
    const buildingClause = building ? ` AND LOWER(p.building) = LOWER($2)` : '';
    if (building) params.push(building);
    const { rows } = await pool.query(
      `SELECT p.pm_id, p.pm_type, p.building, p.completed_date, p.completed_time,
              u.full_name AS completed_by_name, p.checklist, p.notes, p.created_at
       FROM pm_records p
       LEFT JOIN users u ON u.user_id = p.completed_by
       WHERE p.pm_type = $1${buildingClause}
       ORDER BY p.completed_date DESC, p.completed_time DESC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a new PM record (date/time/user auto from server)
app.post('/api/pm-records', requireAuth, async (req, res) => {
  const { pm_type, building, checklist, notes } = req.body;
  if (!pm_type || !checklist) return res.status(400).json({ error: 'pm_type and checklist required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO pm_records (pm_type, building, completed_by, checklist, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [pm_type, building || null, req.user.user_id, JSON.stringify(checklist), notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Change Password ────────────────────────────────────────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  try {
    const { rows } = await pool.query('SELECT password FROM users WHERE user_id = $1', [req.user.user_id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const stored = rows[0].password;
    let valid = false;
    if (stored && stored.startsWith('$2')) {
      valid = await bcrypt.compare(current_password, stored);
    } else {
      valid = stored === current_password;
    }
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashed, req.user.user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Today's Readings ───────────────────────────────────────────────────────────
app.get('/api/readings/today', requireAuth, async (req, res) => {
  const username = req.user.username;
  try {
    const { rows } = await pool.query(`
      SELECT type, id, name, reading_time, summary FROM (
        SELECT 'well' AS type, reading_id::text AS id, common_name AS name, reading_time,
          CONCAT_WS(' / ',
            CASE WHEN hour_reading IS NOT NULL THEN 'Hrs: '||hour_reading END,
            CASE WHEN flow_cfs IS NOT NULL THEN 'Flow: '||flow_cfs||' cfs' END,
            CASE WHEN totalizer IS NOT NULL THEN 'Total: '||totalizer END
          ) AS summary
        FROM readings_well
        WHERE reading_date = CURRENT_DATE AND entered_by = $1

        UNION ALL

        SELECT 'kf', kf_reading_id::text, common_name, reading_time,
          'DTW: '||dtw_reading
        FROM readings_kf_monthly
        WHERE reading_date = CURRENT_DATE AND operator = $1

        UNION ALL

        SELECT 'pump', rph.reading_id::text,
          COALESCE(s.site_name,'Plant')||' — Pump '||pp.pump_letter,
          rph.reading_time, 'Hrs: '||rph.hour_reading
        FROM readings_pump_hours rph
        JOIN pump_positions pp ON pp.position_id = rph.position_id
        LEFT JOIN sites s ON s.site_id = pp.site_id
        WHERE rph.reading_date = CURRENT_DATE AND rph.entered_by = $1

        UNION ALL

        SELECT 'compressor', rch.reading_id::text,
          COALESCE(ac.manufacturer,'Air Compressor'),
          rch.reading_time, 'Hrs: '||rch.hour_reading
        FROM readings_compressor_hours rch
        JOIN air_compressors ac ON ac.compressor_id = rch.compressor_id
        WHERE rch.reading_date = CURRENT_DATE AND rch.entered_by = $1

        UNION ALL

        SELECT 'pge', rpm.reading_id::text,
          COALESCE(pm.meter_name,'PG&E Meter'),
          rpm.reading_time, 'kWh: '||rpm.kwh_reading
        FROM readings_pge_meters rpm
        JOIN pge_meters pm ON pm.pge_meter_id = rpm.pge_meter_id
        WHERE rpm.reading_date = CURRENT_DATE AND rpm.entered_by = $1

        UNION ALL

        SELECT 'monitor', rmon.reading_id::text,
          COALESCE(pmon.manufacturer,'Power Monitor'),
          rmon.reading_time, 'kWh: '||rmon.kwh_reading
        FROM readings_power_monitors rmon
        JOIN power_monitors pmon ON pmon.monitor_id = rmon.monitor_id
        WHERE rmon.reading_date = CURRENT_DATE AND rmon.entered_by = $1

        UNION ALL

        SELECT 'vehicle', rvm.reading_id::text,
          v.vehicle_number||' '||COALESCE(v.make,'')||' '||COALESCE(v.model,''),
          rvm.reading_time,
          CONCAT_WS(' / ',
            CASE WHEN rvm.odometer_miles IS NOT NULL THEN 'Odo: '||to_char(rvm.odometer_miles,'FM999,999') END,
            CASE WHEN rvm.engine_hours IS NOT NULL THEN 'Hrs: '||rvm.engine_hours END
          )
        FROM readings_vehicle_monthly rvm
        JOIN vehicles v ON v.vehicle_id = rvm.vehicle_id
        WHERE rvm.reading_date = CURRENT_DATE AND rvm.entered_by = $1
      ) t
      ORDER BY reading_time DESC NULLS LAST
    `, [username]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bug Reports ───────────────────────────────────────────────────────────────
app.post('/api/bug-reports', requireAuth, async (req, res) => {
  const { screen_area, severity, is_repeatable, description, app_version } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO bug_reports (submitted_by, screen_area, severity, is_repeatable, description, app_version)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING report_id`,
      [req.user.username, screen_area || null, severity || 'minor',
       is_repeatable ?? false, description.trim(), app_version || null]
    );
    res.json({ ok: true, report_id: rows[0].report_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bug-reports', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT report_id, submitted_by, submitted_at, screen_area, severity,
              is_repeatable, description, app_version, resolved, resolved_by, resolved_at
       FROM bug_reports ORDER BY resolved ASC, submitted_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bug-reports/:id/resolve', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { resolved } = req.body;
  try {
    await pool.query(
      `UPDATE bug_reports SET resolved=$1, resolved_by=$2, resolved_at=$3 WHERE report_id=$4`,
      [resolved, resolved ? req.user.username : null, resolved ? new Date() : null, parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── User Management ───────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id, username, full_name, role, initials, email, is_active FROM users ORDER BY full_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, full_name, role, initials, email, password } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, full_name, role, initials, email, password, is_active)
       VALUES (LOWER($1), $2, $3, $4, $5, $6, true) RETURNING user_id`,
      [username, full_name || null, role, initials || null, email || null, hashed]
    );
    res.json({ ok: true, user_id: rows[0].user_id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { full_name, role, initials, email, is_active } = req.body;

  // Role / active changes: admin only
  if ((role !== undefined || is_active !== undefined) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can change role or active status' });
  }
  // Operators can only edit themselves
  if (req.user.role === 'operator' && req.user.user_id !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await pool.query(
      `UPDATE users SET
         full_name  = COALESCE($1, full_name),
         role       = COALESCE($2, role),
         initials   = COALESCE($3, initials),
         email      = COALESCE($4, email),
         is_active  = COALESCE($5, is_active)
       WHERE user_id = $6`,
      [full_name ?? null, role ?? null, initials ?? null, email ?? null, is_active ?? null, targetId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/password', requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });

  if (req.user.role !== 'admin' && req.user.user_id !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashed, targetId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Field Ops server running on http://localhost:${PORT}`);
  pool.query('SELECT 1').then(() => console.log('Database connected')).catch(e => console.error('DB connection failed:', e.message));
});
