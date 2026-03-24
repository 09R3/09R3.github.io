//3-24-26 0121
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Pool factory — recreatable when DB settings change ─────────────────────
let pool = createPool();

function createPool() {
  return new Pool({
    host:     process.env.DB_HOST     || '10.93.1.111',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'waterops',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

// Write key=value pairs back to .env file so settings survive restarts
function saveEnv(updates) {
  const envPath = path.join(__dirname, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* no .env yet */ }

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + line + '\n';
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      db_host: process.env.DB_HOST || '10.93.1.111',
      db_name: process.env.DB_NAME || '',
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ─── Settings ──────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json({
    db_host:      process.env.DB_HOST     || '10.93.1.111',
    db_port:      process.env.DB_PORT     || '5432',
    db_name:      process.env.DB_NAME     || '',
    db_user:      process.env.DB_USER     || '',
    has_password: !!(process.env.DB_PASSWORD),
    server_url:   process.env.SERVER_URL  || '',
  });
});

app.post('/api/settings', async (req, res) => {
  const { db_host, db_port, db_name, db_user, db_password, server_url } = req.body;

  const updates = {};
  if (db_host)     { process.env.DB_HOST     = db_host;     updates.DB_HOST     = db_host; }
  if (db_port)     { process.env.DB_PORT     = db_port;     updates.DB_PORT     = db_port; }
  if (db_name)     { process.env.DB_NAME     = db_name;     updates.DB_NAME     = db_name; }
  if (db_user)     { process.env.DB_USER     = db_user;     updates.DB_USER     = db_user; }
  if (db_password) { process.env.DB_PASSWORD = db_password; updates.DB_PASSWORD = db_password; }
  if (server_url)  { process.env.SERVER_URL  = server_url;  updates.SERVER_URL  = server_url; }

  try {
    if (Object.keys(updates).length > 0) saveEnv(updates);

    const oldPool = pool;
    pool = createPool();
    await pool.query('SELECT 1');
    oldPool.end().catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    pool = createPool();
    res.status(400).json({ ok: false, error: `DB connection failed: ${e.message}` });
  }
});

// ─── Users ─────────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT user_id, username, full_name, role, initials, email FROM users WHERE is_active = true ORDER BY full_name'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Assets ────────────────────────────────────────────────────────────────

app.get('/api/assets/sites', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM sites ORDER BY site_id');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/buildings', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT b.*, s.site_name
      FROM buildings b
      JOIN sites s ON b.site_id = s.site_id
      ORDER BY b.site_id, b.building_letter
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/pump-positions', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.position_id, p.site_id, p.building_id, p.pump_letter,
             p.rated_hp, p.status, p.notes,
             s.site_name, b.building_letter
      FROM pump_positions p
      JOIN sites s ON p.site_id = s.site_id
      JOIN buildings b ON p.building_id = b.building_id
      WHERE p.status = 'active'
      ORDER BY p.site_id, p.pump_letter
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/pge-meters', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pm.*, b.building_letter, s.site_id, s.site_name
      FROM pge_meters pm
      JOIN buildings b ON pm.building_id = b.building_id
      JOIN sites s ON b.site_id = s.site_id
      ORDER BY s.site_id, b.building_letter
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/power-monitors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pm.*, b.building_letter, s.site_id, s.site_name
      FROM power_monitors pm
      JOIN buildings b ON pm.building_id = b.building_id
      JOIN sites s ON b.site_id = s.site_id
      ORDER BY s.site_id, b.building_letter
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/compressors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT ac.*, b.building_letter, s.site_id, s.site_name
      FROM air_compressors ac
      JOIN buildings b ON ac.building_id = b.building_id
      JOIN sites s ON b.site_id = s.site_id
      WHERE ac.status = 'active'
      ORDER BY s.site_id, b.building_letter
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/wells', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT w.*, ws.set_name
      FROM wells w
      LEFT JOIN well_sets ws ON w.kf_set_id = ws.set_id
      WHERE w.status = 'active'
      ORDER BY w.well_id
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/well-sets', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM well_sets ORDER BY set_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/canal-structures', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM canal_structures ORDER BY structure_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/ponds', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ponds ORDER BY pond_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assets/vehicles', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM vehicles WHERE status = 'active' ORDER BY vehicle_number"
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Bulk cache pull — all assets in one request for offline caching ────────
app.get('/api/assets/all', async (req, res) => {
  try {
    const [sites, buildings, pumpPositions, pgeMeters, powerMonitors,
           compressors, wells, wellSets, kfWells, canals, ponds, vehicles, users] = await Promise.all([
      pool.query('SELECT * FROM sites ORDER BY site_id'),
      pool.query('SELECT b.*, s.site_name FROM buildings b JOIN sites s ON b.site_id = s.site_id ORDER BY b.site_id, b.building_letter'),
      pool.query(`SELECT p.*, s.site_name, b.building_letter FROM pump_positions p JOIN sites s ON p.site_id = s.site_id JOIN buildings b ON p.building_id = b.building_id WHERE p.status = 'active' ORDER BY p.site_id, p.pump_letter`),
      pool.query('SELECT pm.*, b.building_letter, s.site_id, s.site_name FROM pge_meters pm JOIN buildings b ON pm.building_id = b.building_id JOIN sites s ON b.site_id = s.site_id ORDER BY s.site_id, b.building_letter'),
      pool.query('SELECT pm.*, b.building_letter, s.site_id, s.site_name FROM power_monitors pm JOIN buildings b ON pm.building_id = b.building_id JOIN sites s ON b.site_id = s.site_id ORDER BY s.site_id, b.building_letter'),
      pool.query(`SELECT ac.*, b.building_letter, s.site_id, s.site_name FROM air_compressors ac JOIN buildings b ON ac.building_id = b.building_id JOIN sites s ON b.site_id = s.site_id WHERE ac.status = 'active' ORDER BY s.site_id, b.building_letter`),
      pool.query("SELECT w.*, ws.set_name FROM wells w LEFT JOIN well_sets ws ON w.kf_set_id = ws.set_id WHERE w.well_type IN ('operational','both') ORDER BY COALESCE(w.area,'Other'), w.common_name"),
      pool.query('SELECT * FROM well_sets ORDER BY set_name'),
      pool.query("SELECT w.*, ws.set_name FROM wells w LEFT JOIN well_sets ws ON w.kf_set_id = ws.set_id WHERE w.kf_set_id IS NOT NULL AND w.status = 'active' ORDER BY w.kf_set_id, w.common_name"),
      pool.query('SELECT * FROM canal_structures ORDER BY structure_name'),
      pool.query('SELECT 0 as pond_placeholder LIMIT 0'),
      pool.query("SELECT * FROM vehicles WHERE status = 'active' ORDER BY vehicle_number"),
      pool.query('SELECT user_id, username, full_name, role, initials, email FROM users WHERE is_active = true ORDER BY full_name'),
    ]);
    res.json({
      sites:         sites.rows,
      buildings:     buildings.rows,
      pumpPositions: pumpPositions.rows,
      pgeMeters:     pgeMeters.rows,
      powerMonitors: powerMonitors.rows,
      compressors:   compressors.rows,
      wells:         wells.rows,
      wellSets:      wellSets.rows,
      kfWells:       kfWells.rows,
      canals:        canals.rows,
      ponds:         ponds.rows,
      vehicles:      vehicles.rows,
      users:         users.rows,
      cachedAt:      new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── KF Wells read in last 30 days ─────────────────────────────────────────
app.get('/api/kf-wells/recent', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT well_id FROM readings_kf_monthly WHERE reading_date >= CURRENT_DATE - INTERVAL '30 days'`
    );
    res.json(r.rows.map(row => row.well_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Last 5 Readings ────────────────────────────────────────────────────────

const LAST5_QUERIES = {
  pge:                { table: 'readings_pge_meters',       id: 'pge_meter_id',  order: 'reading_date' },
  'power-monitor':    { table: 'readings_power_monitors',   id: 'monitor_id',    order: 'reading_date' },
  'pump-hours':       { table: 'readings_pump_hours',       id: 'position_id',   order: 'reading_date' },
  'compressor-hours': { table: 'readings_compressor_hours', id: 'compressor_id', order: 'reading_date' },
  'well-static':      { table: 'readings_kf_monthly',       id: 'well_id',       order: 'reading_date' },
  'well-operational': { table: 'readings_well',             id: 'well_id',       order: 'reading_date' },
  canal:              { table: 'readings_canal',            id: 'structure_id',  order: 'reading_date' },
  vehicle:            { table: 'readings_vehicle_monthly',  id: 'vehicle_id',    order: 'reading_date' },
};

app.get('/api/readings/:type/:id/last5', async (req, res) => {
  const cfg = LAST5_QUERIES[req.params.type];
  if (!cfg) return res.status(400).json({ error: 'Unknown reading type' });
  try {
    const r = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE ${cfg.id} = $1 ORDER BY ${cfg.order} DESC LIMIT 5`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Submit Readings ────────────────────────────────────────────────────────

app.post('/api/readings/pge', async (req, res) => {
  const { pge_meter_id, reading_date, reading_time, kwh_reading, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO readings_pge_meters (pge_meter_id, reading_date, reading_time, kwh_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [pge_meter_id, reading_date, reading_time || null, kwh_reading, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/power-monitor', async (req, res) => {
  const { monitor_id, reading_date, reading_time, kwh_reading, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO readings_power_monitors (monitor_id, reading_date, reading_time, kwh_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [monitor_id, reading_date, reading_time || null, kwh_reading, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/pump-hours', async (req, res) => {
  const { position_id, reading_date, reading_time, hour_reading, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO readings_pump_hours (position_id, reading_date, reading_time, hour_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [position_id, reading_date, reading_time || null, hour_reading, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/compressor-hours', async (req, res) => {
  const { compressor_id, reading_date, reading_time, hour_reading, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO readings_compressor_hours (compressor_id, reading_date, reading_time, hour_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [compressor_id, reading_date, reading_time || null, hour_reading, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/well-static', async (req, res) => {
  const { well_id, reading_date, reading_time, well_on_off,
          dtw_reading, plopper_sounder, operator, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO readings_kf_monthly
         (well_id, reading_date, reading_time, well_on_off,
          dtw_reading, plopper_sounder, operator, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [well_id, reading_date, reading_time || null,
       well_on_off === 'true' || well_on_off === true,
       dtw_reading || null, plopper_sounder || null, operator, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/well-operational', async (req, res) => {
  const { well_id, reading_date, reading_time, on_off, hour_reading,
          instantaneous_flow_cfs, totalizer_reading_af,
          motor_oil, dripper_oil, pge_kwh, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO readings_well
         (well_id, reading_date, reading_time, on_off, hour_reading,
          flow_cfs, totalizer, motor_oil, dripper_oil, pge_kwh, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [well_id, reading_date, reading_time || null,
       on_off === 'true' || on_off === true,
       hour_reading || null,
       instantaneous_flow_cfs || null, totalizer_reading_af || null,
       motor_oil === 'true' || motor_oil === true,
       dripper_oil || null, pge_kwh || null,
       entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/canal', async (req, res) => {
  const { structure_id, reading_date, reading_time, instantaneous_flow_cfs,
          totalizer_reading_af, gate_setting, head_reading_ft,
          derived_flow_cfs, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO readings_canal
         (structure_id, reading_date, reading_time, instantaneous_flow_cfs,
          totalizer_reading_af, gate_setting, head_reading_ft,
          derived_flow_cfs, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [structure_id, reading_date, reading_time || null, instantaneous_flow_cfs || null,
       totalizer_reading_af || null, gate_setting || null, head_reading_ft || null,
       derived_flow_cfs || null, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/pond', async (req, res) => {
  const { pond_id, reading_date, staff_gauge_ft, flow_in_cfs,
          flow_out_cfs, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO pond_readings
         (pond_id, reading_date, staff_gauge_ft, flow_in_cfs, flow_out_cfs,
          entered_by, entered_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7) RETURNING *`,
      [pond_id, reading_date, staff_gauge_ft || null, flow_in_cfs || null,
       flow_out_cfs || null, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/readings/vehicle', async (req, res) => {
  const { vehicle_id, vehicle_number, reading_date, reading_time,
          odometer_miles, engine_hours, entered_by, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO readings_vehicle_monthly
         (vehicle_id, vehicle_number, reading_date, reading_time,
          odometer_miles, engine_hours, entered_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [vehicle_id, vehicle_number || null, reading_date, reading_time || null,
       odometer_miles || null, engine_hours || null, entered_by, notes || null]
    );
    res.json({ ok: true, reading: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Submit Maintenance ─────────────────────────────────────────────────────

// Equipment maintenance (motors, pumps, compressors, etc.)
// work_type distinguishes routine maintenance vs unplanned issues in the description field
app.post('/api/maintenance/equipment', async (req, res) => {
  const { equipment_type, equipment_id, work_date, work_type, performed_by,
          is_contractor, entered_by, location_at_time, description,
          parts_used, cost, po_number, hours_at_service, next_service_date, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO maintenance_equipment
         (equipment_type, equipment_id, work_date, work_type, performed_by,
          is_contractor, entered_by, location_at_time, description,
          parts_used, cost, po_number, hours_at_service, next_service_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [equipment_type, equipment_id || null, work_date, work_type, performed_by,
       is_contractor === true || is_contractor === 'true',
       entered_by, location_at_time || null, description,
       parts_used || null, cost || null, po_number || null,
       hours_at_service || null, next_service_date || null, notes || null]
    );
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Vehicle maintenance
app.post('/api/maintenance/vehicle', async (req, res) => {
  const { vehicle_id, work_date, work_type, performed_by, is_contractor,
          entered_by, description, odometer_at_service, engine_hours_at_service,
          parts_used, cost, po_number, next_service_date, next_service_miles, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO maintenance_vehicles
         (vehicle_id, work_date, work_type, performed_by, is_contractor,
          entered_by, description, odometer_at_service, engine_hours_at_service,
          parts_used, cost, po_number, next_service_date, next_service_miles, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [vehicle_id, work_date, work_type, performed_by,
       is_contractor === true || is_contractor === 'true',
       entered_by, description || null,
       odometer_at_service || null, engine_hours_at_service || null,
       parts_used || null, cost || null, po_number || null,
       next_service_date || null, next_service_miles || null, notes || null]
    );
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Building maintenance and issues (record_type = 'maintenance' | 'issue')
app.post('/api/maintenance/building', async (req, res) => {
  const { building_id, work_date, work_type, record_type, description,
          performed_by, is_contractor, entered_by, severity, status,
          cost, po_number, resolution_notes, next_service_date, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO maintenance_buildings
         (building_id, work_date, work_type, record_type, description,
          performed_by, is_contractor, entered_by, severity, status,
          cost, po_number, resolution_notes, next_service_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [building_id, work_date, work_type, record_type || 'maintenance', description,
       performed_by, is_contractor === true || is_contractor === 'true',
       entered_by, severity || null, status || 'completed',
       cost || null, po_number || null, resolution_notes || null,
       next_service_date || null, notes || null]
    );
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Batch Sync ─────────────────────────────────────────────────────────────
// Accepts array of { localId, type, data } — inserts all in a transaction

const INSERT_SQL = {
  pge: {
    sql: 'INSERT INTO readings_pge_meters (pge_meter_id, reading_date, reading_time, kwh_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6)',
    params: d => [d.pge_meter_id, d.reading_date, d.reading_time || null, d.kwh_reading, d.entered_by, d.notes || null],
  },
  'power-monitor': {
    sql: 'INSERT INTO readings_power_monitors (monitor_id, reading_date, reading_time, kwh_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6)',
    params: d => [d.monitor_id, d.reading_date, d.reading_time || null, d.kwh_reading, d.entered_by, d.notes || null],
  },
  'pump-hours': {
    sql: 'INSERT INTO readings_pump_hours (position_id, reading_date, reading_time, hour_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6)',
    params: d => [d.position_id, d.reading_date, d.reading_time || null, d.hour_reading, d.entered_by, d.notes || null],
  },
  'compressor-hours': {
    sql: 'INSERT INTO readings_compressor_hours (compressor_id, reading_date, reading_time, hour_reading, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6)',
    params: d => [d.compressor_id, d.reading_date, d.reading_time || null, d.hour_reading, d.entered_by, d.notes || null],
  },
  'well-static': {
    sql: `INSERT INTO readings_kf_monthly (well_id, reading_date, reading_time, well_on_off, dtw_reading, plopper_sounder, operator, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    params: d => [d.well_id, d.reading_date, d.reading_time || null, d.well_on_off === 'true' || d.well_on_off === true, d.dtw_reading || null, d.plopper_sounder || null, d.operator || d.entered_by, d.notes || null],
  },
  'well-operational': {
    sql: `INSERT INTO readings_well (well_id, reading_date, reading_time, on_off, hour_reading, flow_cfs, totalizer, motor_oil, dripper_oil, pge_kwh, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    params: d => [d.well_id, d.reading_date, d.reading_time || null, d.on_off === 'true' || d.on_off === true, d.hour_reading || null, d.instantaneous_flow_cfs || null, d.totalizer_reading_af || null, d.motor_oil === 'true' || d.motor_oil === true, d.dripper_oil || null, d.pge_kwh || null, d.entered_by, d.notes || null],
  },
  canal: {
    sql: `INSERT INTO readings_canal (structure_id, reading_date, reading_time, instantaneous_flow_cfs, totalizer_reading_af, gate_setting, head_reading_ft, derived_flow_cfs, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    params: d => [d.structure_id, d.reading_date, d.reading_time || null, d.instantaneous_flow_cfs || null, d.totalizer_reading_af || null, d.gate_setting || null, d.head_reading_ft || null, d.derived_flow_cfs || null, d.entered_by, d.notes || null],
  },
  vehicle: {
    sql: `INSERT INTO readings_vehicle_monthly (vehicle_id, vehicle_number, reading_date, reading_time, odometer_miles, engine_hours, entered_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    params: d => [d.vehicle_id, d.vehicle_number || null, d.reading_date, d.reading_time || null, d.odometer_miles || null, d.engine_hours || null, d.entered_by, d.notes || null],
  },
  'maintenance-equipment': {
    sql: `INSERT INTO maintenance_equipment (equipment_type, equipment_id, work_date, work_type, performed_by, is_contractor, entered_by, location_at_time, description, parts_used, cost, po_number, hours_at_service, next_service_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    params: d => [d.equipment_type, d.equipment_id || null, d.work_date, d.work_type, d.performed_by, d.is_contractor === true || d.is_contractor === 'true', d.entered_by, d.location_at_time || null, d.description, d.parts_used || null, d.cost || null, d.po_number || null, d.hours_at_service || null, d.next_service_date || null, d.notes || null],
  },
  'maintenance-vehicle': {
    sql: `INSERT INTO maintenance_vehicles (vehicle_id, work_date, work_type, performed_by, is_contractor, entered_by, description, odometer_at_service, engine_hours_at_service, parts_used, cost, po_number, next_service_date, next_service_miles, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    params: d => [d.vehicle_id, d.work_date, d.work_type, d.performed_by, d.is_contractor === true || d.is_contractor === 'true', d.entered_by, d.description || null, d.odometer_at_service || null, d.engine_hours_at_service || null, d.parts_used || null, d.cost || null, d.po_number || null, d.next_service_date || null, d.next_service_miles || null, d.notes || null],
  },
  'maintenance-building': {
    sql: `INSERT INTO maintenance_buildings (building_id, work_date, work_type, record_type, description, performed_by, is_contractor, entered_by, severity, status, cost, po_number, resolution_notes, next_service_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    params: d => [d.building_id, d.work_date, d.work_type, d.record_type || 'maintenance', d.description, d.performed_by, d.is_contractor === true || d.is_contractor === 'true', d.entered_by, d.severity || null, d.status || 'completed', d.cost || null, d.po_number || null, d.resolution_notes || null, d.next_service_date || null, d.notes || null],
  },
};

app.post('/api/sync/batch', async (req, res) => {
  const readings = req.body; // array of { localId, type, data }
  if (!Array.isArray(readings) || readings.length === 0) {
    return res.json({ ok: true, synced: [], failed: [] });
  }

  const client = await pool.connect();
  const synced = [];
  const failed = [];

  try {
    await client.query('BEGIN');
    for (const item of readings) {
      const cfg = INSERT_SQL[item.type];
      if (!cfg) { failed.push({ localId: item.localId, error: 'Unknown type' }); continue; }
      await client.query('SAVEPOINT sp');
      try {
        await client.query(cfg.sql, cfg.params(item.data));
        synced.push(item.localId);
        await client.query('RELEASE SAVEPOINT sp');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        failed.push({ localId: item.localId, error: e.message });
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }

  res.json({ ok: true, synced, failed });
});

// ─── Daily Pumping Plant — last reading per asset at a site ─────────────────
app.get('/api/readings/daily/:site_id', async (req, res) => {
  const siteId = parseInt(req.params.site_id);
  try {
    const [pumpRes, compRes, pgeRes, pmRes] = await Promise.all([
      pool.query(`
        SELECT DISTINCT ON (phr.position_id)
          phr.position_id, phr.hour_reading, phr.reading_date, phr.notes
        FROM readings_pump_hours phr
        JOIN pump_positions pp ON phr.position_id = pp.position_id
        WHERE pp.site_id = $1
        ORDER BY phr.position_id, phr.reading_date DESC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT ON (chr.compressor_id)
          chr.compressor_id, chr.hour_reading, chr.reading_date, chr.notes
        FROM readings_compressor_hours chr
        JOIN air_compressors ac ON chr.compressor_id = ac.compressor_id
        JOIN buildings b ON ac.building_id = b.building_id
        WHERE b.site_id = $1
        ORDER BY chr.compressor_id, chr.reading_date DESC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT ON (pr.pge_meter_id)
          pr.pge_meter_id, pr.kwh_reading, pr.reading_date, pr.notes
        FROM readings_pge_meters pr
        JOIN pge_meters pm ON pr.pge_meter_id = pm.pge_meter_id
        JOIN buildings b ON pm.building_id = b.building_id
        WHERE b.site_id = $1
        ORDER BY pr.pge_meter_id, pr.reading_date DESC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT ON (pmr.monitor_id)
          pmr.monitor_id, pmr.kwh_reading, pmr.reading_date, pmr.notes
        FROM readings_power_monitors pmr
        JOIN power_monitors pm ON pmr.monitor_id = pm.monitor_id
        JOIN buildings b ON pm.building_id = b.building_id
        WHERE b.site_id = $1
        ORDER BY pmr.monitor_id, pmr.reading_date DESC
      `, [siteId]),
    ]);

    const pumpHours    = {};
    for (const r of pumpRes.rows) pumpHours[r.position_id]    = r;
    const compHours    = {};
    for (const r of compRes.rows) compHours[r.compressor_id]  = r;
    const pge          = {};
    for (const r of pgeRes.rows)  pge[r.pge_meter_id]         = r;
    const powerMonitors = {};
    for (const r of pmRes.rows)   powerMonitors[r.monitor_id] = r;

    res.json({ pumpHours, compHours, pge, powerMonitors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CSV Export ─────────────────────────────────────────────────────────────
app.get('/api/export/:type', async (req, res) => {
  const cfg = LAST5_QUERIES[req.params.type];
  if (!cfg) return res.status(400).json({ error: 'Unknown reading type' });

  const { from, to } = req.query;
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  try {
    const r = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE ${cfg.order} BETWEEN $1 AND $2 ORDER BY ${cfg.order} ASC`,
      [fromDate, toDate]
    );
    if (r.rows.length === 0) { return res.json([]); }

    const cols = Object.keys(r.rows[0]);
    const lines = [cols.join(',')];
    for (const row of r.rows) {
      lines.push(cols.map(c => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${fromDate}-to-${toDate}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`WaterOps server running at http://${HOST}:${PORT}`);
  console.log(`Connect from iPad: http://<this-machine-IP>:${PORT}`);
});
