require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const path         = require('path');
const XLSX         = require('xlsx');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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

// ── Auth / Sessions ───────────────────────────────────────────────────────────
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map();

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

app.post('/api/db-test', async (req, res) => {
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
        r.reading_id    AS last_reading_id,
        r.hour_reading  AS last_reading,
        r.reading_date  AS last_reading_date,
        r.entered_by    AS last_entered_by,
        r.notes         AS last_notes
      FROM pump_positions pp
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

    if (req.user.role === 'operator') {
      if (row.entered_by !== req.user.username || dateString(row.reading_date) !== todayString()) {
        return res.status(403).json({ error: 'Operators can only delete their own readings from today' });
      }
    }
    // supervisors and admins can delete any

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
  try {
    const { rows } = await pool.query(`
      SELECT
        w.well_id, w.common_name, w.area, w.kf_set_id, ws.set_name,
        w.gps_latitude, w.gps_longitude, w.is_important,
        r.kf_reading_id    AS last_reading_id,
        r.reading_date     AS last_reading_date,
        r.dtw_reading      AS last_dtw,
        r.plopper_sounder  AS last_method,
        r.notes            AS last_notes,
        (CURRENT_DATE - r.reading_date)::int AS days_since_reading
      FROM wells w
      LEFT JOIN well_sets ws ON w.kf_set_id = ws.set_id
      LEFT JOIN LATERAL (
        SELECT kf_reading_id, reading_date, dtw_reading, plopper_sounder, notes
        FROM readings_kf_monthly
        WHERE well_id = w.well_id
        ORDER BY reading_date DESC, reading_time DESC
        LIMIT 1
      ) r ON true
      WHERE w.kf_set_id IS NOT NULL
        AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
      ORDER BY ws.set_name, w.common_name
    `);
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

// ── Wells ─────────────────────────────────────────────────────────────────────
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
      ORDER BY cs.flow_direction, cs.structure_id
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
        `SELECT kf_reading_id AS id, reading_date, reading_time, dtw_reading AS value, plopper_sounder AS method, NULL AS entered_by, notes
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
  };
  const map = TABLE_MAP[type];
  if (!map) return res.status(400).json({ error: 'unknown type' });

  const role = req.user.role;
  const username = req.user.username;

  try {
    if (role === 'operator') {
      // Operators may only delete their own readings submitted within the last 24 hours
      const { rows } = await pool.query(
        `DELETE FROM ${map.table}
         WHERE ${map.pk} = $1
           AND entered_by = $2
           AND (reading_date + COALESCE(reading_time, '00:00'::time)) >= NOW() - INTERVAL '24 hours'
         RETURNING ${map.pk}`,
        [id, username]
      );
      if (!rows.length) return res.status(403).json({ error: 'Not authorized or outside 24-hour window' });
    } else if (role === 'supervisor' || role === 'admin') {
      const { rows } = await pool.query(
        `DELETE FROM ${map.table} WHERE ${map.pk} = $1 RETURNING ${map.pk}`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Reading not found' });
    } else {
      return res.status(403).json({ error: 'Insufficient permissions' });
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
      ORDER BY v.vehicle_type, v.vehicle_number
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

// ── Dashboard stats ───────────────────────────────────────────────────────────
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
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
              WHERE r.well_id = w.well_id AND (
                date_trunc('month', r.reading_date) = date_trunc('month', CURRENT_DATE)
                OR r.reading_date BETWEEN
                  (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date - INTERVAL '7 days'
                  AND (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date
              )
            ) AS is_done
          FROM wells w
          WHERE w.kf_set_id IS NOT NULL
            AND (LOWER(w.status) != 'inactive' OR w.status IS NULL)
        ) s
      `),
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
      wells_total:      parseInt(wells.rows[0].total),
      wells_read_today: parseInt(wells.rows[0].read_today),
      wells_due_today:  parseInt(wells.rows[0].unread_today),
    });
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
    parts_used, cost, po_number, next_service_date, next_service_miles, next_service_hours, notes,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_vehicles
         (vehicle_id, work_date, work_type, performed_by, is_contractor, entered_by,
          description, odometer_at_service, engine_hours_at_service, parts_used, cost,
          po_number, next_service_date, next_service_miles, next_service_hours, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING maintenance_id`,
      [vehicle_id, work_date, work_type, performed_by, is_contractor ?? false,
       req.user.username, description || null, odometer_at_service ?? null,
       engine_hours_at_service ?? null, parts_used || null, cost ?? null,
       po_number || null, next_service_date || null, next_service_miles ?? null,
       next_service_hours ?? null, notes || null]
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
        `SELECT work_date, work_type, description, performed_by, is_contractor,
                parts_used, cost, odometer_at_service, engine_hours_at_service,
                next_service_miles, next_service_hours, notes, entered_by
         FROM maintenance_vehicles
         WHERE vehicle_id = $1
         ORDER BY work_date DESC LIMIT 15`,
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
       FROM readings_vehicle_monthly r
       JOIN vehicles v ON v.vehicle_id = r.vehicle_id
       WHERE EXTRACT(YEAR  FROM r.reading_date) = $1
         AND EXTRACT(MONTH FROM r.reading_date) = $2
         AND (LOWER(v.status) != 'inactive' OR v.status IS NULL)
       ORDER BY v.vehicle_id, r.reading_date DESC, r.reading_time DESC`,
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
    if (!req.cookies?.session_id) return res.status(401).json({ error: 'Unauthorized' });
    const session = sessions.get(req.cookies.session_id);
    if (!session || Date.now() > session.expires) return res.status(401).json({ error: 'Unauthorized' });
    if (session.user.role !== 'admin' && session.user.role !== 'supervisor')
      return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (v.vehicle_id)
         v.vehicle_id, v.vehicle_number, v.make, v.model, v.assigned_user,
         v.reading_type, r.odometer_miles, r.engine_hours, r.reading_date
       FROM readings_vehicle_monthly r
       JOIN vehicles v ON v.vehicle_id = r.vehicle_id
       WHERE EXTRACT(YEAR  FROM r.reading_date) = $1
         AND EXTRACT(MONTH FROM r.reading_date) = $2
         AND (LOWER(v.status) != 'inactive' OR v.status IS NULL)
       ORDER BY v.vehicle_id, r.reading_date DESC, r.reading_time DESC`,
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

// ── KF Operator Breakdown Report ──────────────────────────────────────────────
app.get('/api/reports/kf-operators', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    const { rows } = await pool.query(
      `WITH total_wells AS (
         SELECT COUNT(*) AS cnt
         FROM wells
         WHERE kf_set_id IS NOT NULL
           AND (LOWER(status) != 'inactive' OR status IS NULL)
       )
       SELECT
         COALESCE(r.operator, '(no operator)') AS operator,
         COUNT(DISTINCT r.well_id)             AS wells_read,
         (SELECT cnt FROM total_wells)         AS total_wells
       FROM readings_kf_monthly r
       WHERE EXTRACT(YEAR  FROM r.reading_date) = $1
         AND EXTRACT(MONTH FROM r.reading_date) = $2
       GROUP BY r.operator
       ORDER BY wells_read DESC`,
      [parseInt(year), parseInt(month)]
    );
    // Also include total distinct wells read this month
    const totalRead = rows.reduce((s, r) => s + parseInt(r.wells_read), 0);
    res.json({ rows, totalRead, totalWells: rows[0]?.total_wells ? parseInt(rows[0].total_wells) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
