require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD
});

// DB set_id mapping:
// 1-6 = Sets 1-6, 7 = Pioneer (P), 8 = Hydrograph (H), 9 = ID4
// Spreadsheet well_ids: P=1-53, H=54-134, 1=135-166, 2=167-203,
// 3=204-239, 4=240-270, 5=271-290, 6=291-315, ID4=316-336

async function run() {
  const r = await pool.query(`
    UPDATE wells SET kf_set_id = CASE
      WHEN well_id BETWEEN 1   AND 53  THEN '7'
      WHEN well_id BETWEEN 54  AND 134 THEN '8'
      WHEN well_id BETWEEN 135 AND 166 THEN '1'
      WHEN well_id BETWEEN 167 AND 203 THEN '2'
      WHEN well_id BETWEEN 204 AND 239 THEN '3'
      WHEN well_id BETWEEN 240 AND 270 THEN '4'
      WHEN well_id BETWEEN 271 AND 290 THEN '5'
      WHEN well_id BETWEEN 291 AND 315 THEN '6'
      WHEN well_id BETWEEN 316 AND 336 THEN '9'
    END
    WHERE well_id BETWEEN 1 AND 336
  `);
  console.log(`wells updated: ${r.rowCount} rows`);

  const counts = await pool.query(`
    SELECT ws.set_name, COUNT(*) as cnt
    FROM wells w JOIN well_sets ws ON w.kf_set_id = ws.set_id
    WHERE w.well_id BETWEEN 1 AND 336
    GROUP BY ws.set_name ORDER BY ws.set_name
  `);
  console.log('Counts by set:', JSON.stringify(counts.rows));
}

run().catch(e => { console.error(e.message); }).finally(() => pool.end());
