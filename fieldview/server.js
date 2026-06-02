require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { version: APP_VERSION } = require('./package.json');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── DB Pool ──────────────────────────────────────────────────────────────────

let pool = null;

function createPool(config) {
  if (pool) { pool.end().catch(() => {}); }
  pool = new Pool({
    host: config.host,
    port: parseInt(config.port) || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 5000,
    max: 5,
  });
  return pool;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
// In-memory session store: token -> { user, expires }
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s.user;
}

function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    list[k.trim()] = decodeURIComponent(v.join('='));
  }
  return list;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const user = getSession(cookies.waterops_session);
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login.html');
}

// ─── Public routes (no auth) ──────────────────────────────────────────────────

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// DB status — lets login page know if a connection is already active
app.get('/api/db-status', (req, res) => {
  if (!pool) return res.json({ connected: false });
  pool.query('SELECT current_database(), current_user')
    .then(r => res.json({
      connected: true,
      database: r.rows[0].current_database,
      user: r.rows[0].current_user,
    }))
    .catch(() => res.json({ connected: false }));
});

// Connect to DB — public so it can be called before login
app.post('/api/connect', async (req, res) => {
  const { host, port, database, user, password } = req.body;
  if (!host || !database || !user) {
    return res.status(400).json({ error: 'host, database, and user are required.' });
  }
  try {
    const testPool = createPool({ host, port, database, user, password });
    const client = await testPool.connect();
    const result = await client.query('SELECT current_database(), current_user, version()');
    client.release();
    pool = testPool;
    res.json({
      success: true,
      database: result.rows[0].current_database,
      user: result.rows[0].current_user,
      version: result.rows[0].version,
    });
  } catch (err) {
    pool = null;
    res.status(500).json({ error: err.message });
  }
});

// Active users list — public so login page can populate the dropdown
app.get('/api/users/active', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database connected.' });
  try {
    const { rows } = await pool.query(
      `SELECT username, full_name FROM users WHERE is_active = true AND role IN ('supervisor', 'admin') ORDER BY full_name ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login — authenticate against users table in the connected DB
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!pool) {
    return res.status(503).json({ error: 'No database connected. Set up the connection first.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND (is_active IS NULL OR is_active = true)`,
      [username]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    // Support bcrypt hashes and legacy plaintext
    let valid = false;
    if (user.password && user.password.startsWith('$2')) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      valid = user.password === password;
      if (valid) {
        // Upgrade plaintext to bcrypt on first successful login
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashed, user.user_id])
          .catch(() => {});
      }
    }

    if (!valid) return res.status(401).json({ error: 'Invalid username or password.' });

    if (!['supervisor', 'admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Access denied. FieldView is restricted to supervisors and admins.' });
    }

    const sessionUser = {
      user_id: user.user_id,
      username: user.username,
      full_name: user.full_name || user.username,
      role: user.role || 'viewer',
    };
    const token = createSession(sessionUser);
    res.setHeader('Set-Cookie', `waterops_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ success: true, user: sessionUser });
  } catch (err) {
    // If users table doesn't exist, give a helpful error
    if (err.code === '42P01') {
      return res.status(500).json({ error: 'No "users" table found in this database.' });
    }
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.waterops_session) sessions.delete(cookies.waterops_session);
  res.setHeader('Set-Cookie', 'waterops_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Current user info
app.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// Serve login page without auth; protect everything else
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login.css' || req.path.startsWith('/auth/') || req.path.startsWith('/icons/') || req.path === '/manifest.json') {
    return next();
  }
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// Middleware: ensure pool exists and is connected before DB routes
async function requireDB(req, res, next) {
  if (!pool) return res.status(400).json({ error: 'Not connected to a database. Configure the connection first.' });
  try {
    const client = await pool.connect();
    client.release();
    next();
  } catch (err) {
    res.status(500).json({ error: `Database connection failed: ${err.message}` });
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/tables — list all user tables and views
app.get('/api/tables', requireDB, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        table_schema,
        table_name,
        table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schema/:schema/:table — get column info for a table
app.get('/api/schema/:schema/:table', requireDB, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [req.params.schema, req.params.table]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/query — execute arbitrary SQL
app.post('/api/query', requireDB, async (req, res) => {
  const { sql, params = [] } = req.body;
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'No SQL provided.' });
  try {
    const start = Date.now();
    const result = await pool.query(sql, params);
    const duration = Date.now() - start;
    res.json({
      rows: result.rows,
      fields: result.fields ? result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) : [],
      rowCount: result.rowCount,
      duration,
      command: result.command,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/table/:schema/:table — paginated table browse with optional search
app.get('/api/table/:schema/:table', requireDB, async (req, res) => {
  const { schema, table } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const sortCol = req.query.sort || '';
  const sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  // Validate identifiers to prevent SQL injection
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    return res.status(400).json({ error: 'Invalid schema or table name.' });
  }

  try {
    // Get columns
    const colResult = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table]);

    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: 'Table not found.' });
    }

    const columns = colResult.rows;
    const quotedTable = `"${schema}"."${table}"`;

    let whereClause = '';
    const queryParams = [];

    if (search) {
      const textCols = columns
        .filter(c => ['text', 'character varying', 'character', 'varchar', 'char', 'name', 'uuid'].includes(c.data_type))
        .map(c => `"${c.column_name}"::text ILIKE $1`);
      if (textCols.length > 0) {
        whereClause = `WHERE (${textCols.join(' OR ')})`;
        queryParams.push(`%${search}%`);
      }
    }

    let orderClause = '';
    if (sortCol && columns.some(c => c.column_name === sortCol)) {
      orderClause = `ORDER BY "${sortCol}" ${sortDir}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${quotedTable} ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].count);

    const limitParam = queryParams.length + 1;
    const offsetParam = queryParams.length + 2;
    const dataResult = await pool.query(
      `SELECT * FROM ${quotedTable} ${whereClause} ${orderClause} LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...queryParams, limit, offset]
    );

    res.json({
      rows: dataResult.rows,
      columns: columns.map(c => c.column_name),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Export Routes ────────────────────────────────────────────────────────────

function formatExportVal(val) {
  if (val === null || val === undefined) return '';
  // pg Date object (direct DB query)
  if (val instanceof Date) {
    return `${val.getUTCMonth() + 1}-${val.getUTCDate()}-${val.getUTCFullYear()}`;
  }
  // ISO datetime string from JSON serialization ("2026-03-30T00:00:00.000Z")
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
    const d = new Date(val);
    return `${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
  }
  // Plain date-only string ("2026-03-30")
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    const [y, m, d] = val.split('-');
    return `${parseInt(m)}-${parseInt(d)}-${y}`;
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

async function fetchExportData(req) {
  const { sql, schema, table, rows, columns, title } = req.body;
  if (rows && columns) {
    return { rows, columns, title: title || 'Export' };
  }
  if (sql) {
    const result = await pool.query(sql);
    return {
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      title: 'Query Result',
    };
  }
  if (schema && table) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error('Invalid schema or table name.');
    }
    const result = await pool.query(`SELECT * FROM "${schema}"."${table}" LIMIT 10000`);
    return {
      rows: result.rows,
      columns: result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] || {}),
      title: `${schema}.${table}`,
    };
  }
  throw new Error('Provide either sql or schema+table in request body.');
}

// POST /api/export/csv
app.post('/api/export/csv', requireDB, async (req, res) => {
  try {
    const { rows, columns, title } = await fetchExportData(req);
    const filename = `${title.replace(/[^a-zA-Z0-9_.-]/g, '_')}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Header row
    res.write(columns.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n');

    for (const row of rows) {
      const line = columns.map(col => {
        const str = String(formatExportVal(row[col])).replace(/"/g, '""');
        return `"${str}"`;
      }).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/export/xlsx
app.post('/api/export/xlsx', requireDB, async (req, res) => {
  try {
    const { rows, columns, title } = await fetchExportData(req);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Water Ops Viewer';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(title.substring(0, 31));

    // Header row with styling
    sheet.addRow(columns);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 22;

    // Auto-fit column widths
    columns.forEach((col, i) => {
      const maxLen = Math.min(
        50,
        Math.max(
          col.length + 4,
          ...rows.slice(0, 100).map(r => String(r[col] ?? '').length)
        )
      );
      sheet.getColumn(i + 1).width = maxLen;
    });

    // Data rows
    for (const row of rows) {
      sheet.addRow(columns.map(col => formatExportVal(row[col])));
    }

    // Add table filter
    if (rows.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length },
      };
    }

    const filename = `${title.replace(/[^a-zA-Z0-9_.-]/g, '_')}_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/export/pdf
app.post('/api/export/pdf', requireDB, async (req, res) => {
  try {
    const { rows, columns, title } = await fetchExportData(req);
    const filename = `${title.replace(/[^a-zA-Z0-9_.-]/g, '_')}_${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape', autoFirstPage: true, bufferPages: true });
    doc.pipe(res);

    // Title
    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center', lineBreak: true });
    doc.fontSize(9).font('Helvetica').fillColor('#888888')
      .text(`Generated: ${new Date().toLocaleString()} — ${rows.length} rows`, { align: 'center', lineBreak: true });
    doc.moveDown(0.5);

    const margin = 30;
    const pageWidth = doc.page.width - margin * 2;
    const pageHeight = doc.page.height - margin * 2;
    const rowHeight = 18;
    const headerHeight = 22;

    // Compute column widths: cap at 120 but ensure total doesn't exceed pageWidth
    let colWidth = Math.floor(pageWidth / columns.length);
    if (colWidth > 120) colWidth = 120;
    // If total exceeds page, shrink to fit
    const totalColWidth = colWidth * columns.length;
    const effectiveColWidth = totalColWidth > pageWidth ? Math.floor(pageWidth / columns.length) : colWidth;

    function drawTableHeader(y) {
      doc.rect(margin, y, pageWidth, headerHeight).fill('#667eea');
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
      columns.forEach((col, i) => {
        const x = margin + i * effectiveColWidth + 3;
        const w = effectiveColWidth - 6;
        // lineBreak: false prevents PDFKit from advancing the internal cursor vertically
        doc.text(String(col).substring(0, 25), x, y + 6, { width: w, lineBreak: false, ellipsis: true });
      });
      return y + headerHeight;
    }

    function drawRow(row, y, isEven) {
      if (isEven) {
        doc.rect(margin, y, pageWidth, rowHeight).fill('#f5f5f5');
      }
      doc.fillColor('#333333').fontSize(7).font('Helvetica');
      columns.forEach((col, i) => {
        let val = String(formatExportVal(row[col]));
        const x = margin + i * effectiveColWidth + 3;
        const w = effectiveColWidth - 6;
        // lineBreak: false is critical — prevents PDFKit auto-adding pages mid-row
        doc.text(val.substring(0, 40), x, y + 5, { width: w, lineBreak: false, ellipsis: true });
      });
      doc.rect(margin, y, pageWidth, rowHeight).stroke('#dddddd');
      return y + rowHeight;
    }

    // First page: start table after the title block
    let y = drawTableHeader(doc.y);
    // Space available below header on first page
    const firstPageMaxY = doc.page.height - margin;
    const subsequentMaxY = doc.page.height - margin;

    let currentMaxY = firstPageMaxY;
    let rowsOnPage = 0;
    const maxRowsFirstPage = Math.floor((currentMaxY - y) / rowHeight);
    let maxRowsPerPage = maxRowsFirstPage;

    rows.forEach((row, idx) => {
      if (rowsOnPage >= maxRowsPerPage) {
        doc.addPage();
        y = drawTableHeader(margin);
        rowsOnPage = 0;
        maxRowsPerPage = Math.floor((subsequentMaxY - margin - headerHeight) / rowHeight);
      }
      y = drawRow(row, y, idx % 2 === 1);
      rowsOnPage++;
    });

    // Add page numbers
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor('#aaaaaa')
        .text(`Page ${i + 1} of ${totalPages}`, margin, doc.page.height - margin + 5, { align: 'right', lineBreak: false });
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Import / Template Routes ──────────────────────────────────────────────────

// Simple CSV parser (handles quoted fields with commas/newlines)
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else { field += c; }
      }
    }
    row.push(field);
    result.push(row);
  }
  if (!result.length) return { headers: [], rows: [] };
  const headers = result[0];
  const rows = result.slice(1).map(vals => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : null; });
    return obj;
  });
  return { headers, rows };
}

// GET /api/template/:schema/:table?fmt=csv|xlsx — blank import template
app.get('/api/template/:schema/:table', requireDB, async (req, res) => {
  const { schema, table } = req.params;
  const fmt = req.query.fmt === 'xlsx' ? 'xlsx' : 'csv';

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    return res.status(400).json({ error: 'Invalid schema or table name.' });
  }

  try {
    const colResult = await pool.query(`
      SELECT column_name, column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table]);

    if (!colResult.rows.length) return res.status(404).json({ error: 'Table not found.' });

    // Include all columns — serial PK columns are included so users can provide
    // existing IDs for upsert. Leave them blank in the file for new rows.
    const importCols = colResult.rows.map(c => c.column_name);

    const title = `${schema}.${table}`;
    const safeName = title.replace(/[^a-zA-Z0-9_.-]/g, '_');

    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_template.csv"`);
      res.end(importCols.map(c => `"${c.replace(/"/g, '""')}"`).join(',') + '\n');
    } else {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Water Ops Viewer';
      const sheet = workbook.addWorksheet(title.substring(0, 31));
      sheet.addRow(importCols);
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 22;
      importCols.forEach((col, i) => { sheet.getColumn(i + 1).width = Math.max(col.length + 4, 14); });
      // Add one blank example row so Excel doesn't collapse the sheet
      sheet.addRow(importCols.map(() => ''));

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_template.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/:schema/:table — upsert rows from uploaded CSV or Excel.
// Rows that include a non-null primary key use INSERT ... ON CONFLICT DO UPDATE
// so existing records are updated rather than duplicated. Rows without a PK
// value fall back to plain INSERT so the DB auto-assigns the key.
// Body: { filename: string, data: base64string }
app.post('/api/import/:schema/:table', requireDB, async (req, res) => {
  const { schema, table } = req.params;

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    return res.status(400).json({ error: 'Invalid schema or table name.' });
  }

  const { filename, data } = req.body;
  if (!filename || !data) return res.status(400).json({ error: 'filename and data are required.' });

  const ext = filename.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx'].includes(ext)) {
    return res.status(400).json({ error: 'Only CSV and XLSX files are supported.' });
  }

  try {
    // Get table column metadata + primary key columns in one round-trip
    const [colResult, pkResult] = await Promise.all([
      pool.query(`
        SELECT column_name, column_default, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table]),
      pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = $1 AND tc.table_name = $2
        ORDER BY kcu.ordinal_position
      `, [schema, table]),
    ]);

    if (!colResult.rows.length) return res.status(404).json({ error: 'Table not found.' });

    const tableColNames = new Set(colResult.rows.map(c => c.column_name));
    const serialCols = new Set(
      colResult.rows
        .filter(c => c.column_default && c.column_default.startsWith('nextval('))
        .map(c => c.column_name)
    );
    const pkCols = pkResult.rows.map(r => r.column_name);
    const pkSet = new Set(pkCols);

    // Parse uploaded file
    const buffer = Buffer.from(data, 'base64');
    let fileColumns = [];
    let rows = [];

    if (ext === 'csv') {
      const { headers, rows: parsed } = parseCSV(buffer.toString('utf8'));
      fileColumns = headers;
      rows = parsed;
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.worksheets[0];
      const headerVals = sheet.getRow(1).values; // 1-indexed; index 0 is undefined
      fileColumns = Array.from({ length: headerVals.length - 1 }, (_, i) =>
        headerVals[i + 1] != null ? String(headerVals[i + 1]) : ''
      );
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const obj = {};
        fileColumns.forEach((col, i) => {
          const v = row.values[i + 1];
          obj[col] = (v instanceof Date) ? v.toISOString() : (v != null ? v : null);
        });
        rows.push(obj);
      });
    }

    // Validate column names
    const unknownCols = fileColumns.filter(c => c && !tableColNames.has(c));
    if (unknownCols.length) {
      return res.status(400).json({ error: `Unknown columns in file: ${unknownCols.join(', ')}` });
    }

    // All valid columns from the file (serial cols allowed when user provides a value)
    const allFileCols = fileColumns.filter(c => c && tableColNames.has(c));
    if (!allFileCols.length) {
      return res.status(400).json({ error: 'No importable columns found in the file.' });
    }

    // pkInFile: PK columns that the file actually contains
    const pkInFile = pkCols.filter(c => allFileCols.includes(c));
    const canUpsert = pkInFile.length === pkCols.length && pkCols.length > 0;

    const quotedTable = `"${schema}"."${table}"`;

    // Build upsert SQL (used when all PK columns are present and non-null in a row)
    let upsertSQL = null;
    if (canUpsert) {
      // Non-PK cols that are in the file — these get updated on conflict
      const updateCols = allFileCols.filter(c => !pkSet.has(c));
      const colList = allFileCols.map(c => `"${c}"`).join(', ');
      const placeholders = allFileCols.map((_, i) => `$${i + 1}`).join(', ');
      const conflictCols = pkInFile.map(c => `"${c}"`).join(', ');
      const setClauses = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
      upsertSQL = `INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders})
        ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses}
        RETURNING (xmax = 0) AS inserted`;
    }

    // Plain insert SQL — excludes serial cols (DB assigns them)
    const plainCols = allFileCols.filter(c => !serialCols.has(c));
    const plainColList = plainCols.map(c => `"${c}"`).join(', ');
    const plainPlaceholders = plainCols.map((_, i) => `$${i + 1}`).join(', ');
    const plainSQL = `INSERT INTO ${quotedTable} (${plainColList}) VALUES (${plainPlaceholders})`;

    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    const errors = [];

    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const normalize = v => (v === '' || v === null || v === undefined) ? null : v;

        // Decide upsert vs plain insert based on whether all PK values are present
        const pkValuesPresent = canUpsert && pkInFile.every(c => normalize(row[c]) !== null);

        try {
          if (pkValuesPresent) {
            const values = allFileCols.map(c => normalize(row[c]));
            const result = await client.query(upsertSQL, values);
            if (result.rows[0]?.inserted) inserted++; else updated++;
          } else {
            const values = plainCols.map(c => normalize(row[c]));
            await client.query(plainSQL, values);
            inserted++;
          }
        } catch (err) {
          errors.push({ row: i + 2, error: err.message });
        }
      }
    } finally {
      client.release();
    }

    res.json({ inserted, updated, total: rows.length, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status — check connection status
app.get('/api/status', (req, res) => {
  res.json({ connected: !!pool });
});

// ─── Saved Queries ─────────────────────────────────────────────────────────────

const ENSURE_SAVED_TABLE = `
  CREATE TABLE IF NOT EXISTS _waterops_saved_queries (
    id         SERIAL       PRIMARY KEY,
    name       TEXT         NOT NULL,
    sql        TEXT         NOT NULL,
    created_by TEXT         NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`;

// GET /api/saved-queries
app.get('/api/saved-queries', requireDB, async (req, res) => {
  try {
    await pool.query(ENSURE_SAVED_TABLE);
    const result = await pool.query(
      'SELECT id, name, sql, created_by, created_at FROM _waterops_saved_queries ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/saved-queries
app.post('/api/saved-queries', requireDB, async (req, res) => {
  const { name, sql } = req.body;
  if (!name || !sql) return res.status(400).json({ error: 'name and sql are required.' });
  try {
    await pool.query(ENSURE_SAVED_TABLE);
    const result = await pool.query(
      'INSERT INTO _waterops_saved_queries (name, sql, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), sql.trim(), req.user?.username || 'admin']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/saved-queries/:id
app.delete('/api/saved-queries/:id', requireDB, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    await pool.query('DELETE FROM _waterops_saved_queries WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Reports ──────────────────────────────────────────────────────────────────

// GET /api/reports/pump-hours/plants — distinct sites from pump_positions for dropdown
app.get('/api/reports/pump-hours/plants', requireDB, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT site_id FROM pump_positions WHERE site_id IS NOT NULL ORDER BY site_id`
    );
    res.json(result.rows.map(r => r.site_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/pump-hours/pumps?site_id=X — distinct pump letters for a site
app.get('/api/reports/pump-hours/pumps', requireDB, async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id required.' });
  try {
    const result = await pool.query(
      `SELECT DISTINCT pump_letter FROM pump_positions
       WHERE site_id = $1 AND pump_letter IS NOT NULL
       ORDER BY pump_letter`,
      [site_id]
    );
    res.json(result.rows.map(r => r.pump_letter));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/pump-hours — readings joined to pump_positions, filtered by site_id and date range
app.get('/api/reports/pump-hours', requireDB, async (req, res) => {
  const { site_id, start, end, pump_letters } = req.query;
  if (!site_id || !start || !end) {
    return res.status(400).json({ error: 'site_id, start, and end are required.' });
  }
  const letters = pump_letters ? pump_letters.split(',').filter(Boolean) : [];
  try {
    const params = [site_id, start, end];
    let letterClause = '';
    if (letters.length) {
      params.push(letters);
      letterClause = ` AND p.pump_letter = ANY($4)`;
    }
    const result = await pool.query(
      `SELECT p.pump_letter, r.reading_date, r.reading_time, r.hour_reading
       FROM readings_pump_hours r
       JOIN pump_positions p ON p.position_id = r.position_id
       WHERE p.site_id = $1
         AND r.reading_date >= $2
         AND r.reading_date <= $3${letterClause}
       ORDER BY r.reading_date ASC, p.pump_letter ASC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/well-readings/areas — distinct areas from wells table
app.get('/api/reports/well-readings/areas', requireDB, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT area FROM wells WHERE area IS NOT NULL ORDER BY area`
    );
    res.json(result.rows.map(r => r.area));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/well-readings/pools — distinct discharge_pool values
app.get('/api/reports/well-readings/pools', requireDB, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT discharge_pool FROM wells WHERE discharge_pool IS NOT NULL ORDER BY discharge_pool`
    );
    res.json(result.rows.map(r => r.discharge_pool));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/well-readings/participants — distinct participant values
app.get('/api/reports/well-readings/participants', requireDB, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT participant FROM wells WHERE participant IS NOT NULL ORDER BY participant`
    );
    res.json(result.rows.map(r => r.participant));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/well-readings — readings joined to wells with optional area/pool/participant filters
app.get('/api/reports/well-readings', requireDB, async (req, res) => {
  const { area, pool: poolFilter, participant, start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end are required.' });
  }
  try {
    const params = [start, end];
    const clauses = ['r.reading_date >= $1', 'r.reading_date <= $2'];
    if (area) { params.push(area); clauses.push(`w.area = $${params.length}`); }
    if (poolFilter) { params.push(poolFilter); clauses.push(`w.discharge_pool = $${params.length}`); }
    if (participant) { params.push(participant); clauses.push(`w.participant = $${params.length}`); }

    const result = await pool.query(
      `SELECT r.reading_date,
              r.reading_time,
              w.state_well_number,
              w.common_name,
              r.hour_reading,
              r.flow_cfs,
              r.totalizer,
              CASE
                WHEN r.totalizer IS NULL
                  OR prev.totalizer IS NULL
                  OR prev.elapsed_secs IS NULL
                  OR prev.elapsed_secs <= 0
                THEN NULL
                ELSE ROUND(
                  ((r.totalizer - prev.totalizer) * 43560.0
                   / prev.elapsed_secs)::numeric, 2)
              END AS totalizer_calc,
              r.pge_kwh
       FROM readings_well r
       JOIN wells w ON w.well_id = r.well_id
       LEFT JOIN LATERAL (
         SELECT p.totalizer,
                EXTRACT(EPOCH FROM (
                  (r.reading_date + COALESCE(r.reading_time, '00:00:00'::time))::timestamp -
                  (p.reading_date + COALESCE(p.reading_time, '00:00:00'::time))::timestamp
                )) AS elapsed_secs
         FROM readings_well p
         WHERE p.well_id = r.well_id
           AND (p.reading_date + COALESCE(p.reading_time, '00:00:00'::time)) <
               (r.reading_date + COALESCE(r.reading_time, '00:00:00'::time))
         ORDER BY (p.reading_date + COALESCE(p.reading_time, '00:00:00'::time)) DESC
         LIMIT 1
       ) prev ON true
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.reading_date ASC, w.common_name ASC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Additional Reading Reports ───────────────────────────────────────────────

// Helper: build optional integer filter clause
function optIntFilter(val, col, nextParam) {
  if (!val) return { clause: '', param: null };
  return { clause: ` AND ${col} = $${nextParam}`, param: parseInt(val) };
}
function optTextFilter(val, col, nextParam) {
  if (!val) return { clause: '', param: null };
  return { clause: ` AND ${col} = $${nextParam}`, param: val };
}

// ── Canal Readings ──────────────────────────────────────────────────────────
app.get('/api/reports/canal-readings/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cs.structure_id::text AS value, cs.structure_name AS label
       FROM canal_structures cs
       WHERE cs.structure_id IN (SELECT DISTINCT structure_id FROM readings_canal WHERE structure_id IS NOT NULL)
       ORDER BY cs.structure_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/canal-readings', requireDB, async (req, res) => {
  const { structure_id, month } = req.query;
  if (!structure_id) return res.status(400).json({ error: 'structure_id is required.' });
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
  try {
    const { rows } = await pool.query(
      `WITH
         month_start AS (
           SELECT date_trunc('month', ($2 || '-01')::date)::date AS d
         ),
         days AS (
           SELECT generate_series(
             (SELECT d FROM month_start),
             (SELECT (d + interval '1 month' - interval '1 day')::date FROM month_start),
             interval '1 day'
           )::date AS day
         ),
         daily AS (
           SELECT DISTINCT ON (reading_date)
             reading_date, reading_time, totalizer_reading_af, instantaneous_flow_cfs
           FROM readings_canal
           WHERE structure_id = $1
             AND reading_date >= (SELECT d FROM month_start)
             AND reading_date < (SELECT (d + interval '1 month')::date FROM month_start)
           ORDER BY reading_date, reading_time DESC NULLS LAST
         ),
         pre_month AS (
           SELECT reading_date, reading_time, totalizer_reading_af, instantaneous_flow_cfs
           FROM readings_canal
           WHERE structure_id = $1
             AND reading_date < (SELECT d FROM month_start)
           ORDER BY reading_date DESC, reading_time DESC NULLS LAST
           LIMIT 1
         ),
         all_r AS (
           SELECT reading_date, reading_time, totalizer_reading_af, instantaneous_flow_cfs, false AS pre
           FROM daily
           UNION ALL
           SELECT reading_date, reading_time, totalizer_reading_af, instantaneous_flow_cfs, true AS pre
           FROM pre_month
         ),
         with_prev AS (
           SELECT *,
             LAG(totalizer_reading_af) OVER (ORDER BY reading_date, reading_time NULLS LAST) AS prev_af,
             LAG(reading_date)         OVER (ORDER BY reading_date, reading_time NULLS LAST) AS prev_date,
             LAG(reading_time)         OVER (ORDER BY reading_date, reading_time NULLS LAST) AS prev_time
           FROM all_r
         ),
         last_af AS (
           SELECT d.day,
             (SELECT r2.totalizer_reading_af
              FROM readings_canal r2
              WHERE r2.structure_id = $1
                AND r2.totalizer_reading_af IS NOT NULL
                AND r2.reading_date <= d.day
              ORDER BY r2.reading_date DESC, r2.reading_time DESC NULLS LAST
              LIMIT 1) AS af
           FROM days d
         )
       SELECT
         d.day                                                     AS date,
         wp.reading_time                                           AS time,
         COALESCE(wp.totalizer_reading_af, la.af)                 AS observed_reading,
         COALESCE(wp.totalizer_reading_af, la.af)                 AS adjusted_reading,
         CASE
           WHEN wp.totalizer_reading_af IS NULL THEN 0
           WHEN wp.prev_af IS NULL THEN NULL
           WHEN wp.totalizer_reading_af = wp.prev_af THEN 0
           ELSE ROUND(
             ((wp.totalizer_reading_af - wp.prev_af) * 43560.0 /
              GREATEST(EXTRACT(EPOCH FROM (
                (d.day + COALESCE(wp.reading_time, '00:00:00'::time))::timestamp -
                (wp.prev_date + COALESCE(wp.prev_time, '00:00:00'::time))::timestamp
              )), 1))::numeric, 4)
         END                                                       AS cfs_per_day,
         CASE
           WHEN wp.totalizer_reading_af IS NULL THEN 0
           WHEN wp.prev_af IS NULL THEN NULL
           WHEN wp.totalizer_reading_af = wp.prev_af THEN 0
           ELSE ROUND((wp.totalizer_reading_af - wp.prev_af)::numeric, 4)
         END                                                       AS af_per_day,
         wp.instantaneous_flow_cfs                                 AS flow_rate
       FROM days d
       LEFT JOIN with_prev wp ON wp.reading_date = d.day AND NOT wp.pre
       LEFT JOIN last_af la ON la.day = d.day
       ORDER BY d.day`,
      [parseInt(structure_id), month]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Compressor Hours ────────────────────────────────────────────────────────
app.get('/api/reports/compressor-hours/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.building_id::text AS value, b.building_name AS label
       FROM buildings b
       WHERE b.building_id IN (
         SELECT DISTINCT ac.building_id FROM air_compressors ac
         WHERE ac.compressor_id IN (SELECT DISTINCT compressor_id FROM readings_compressor_hours WHERE compressor_id IS NOT NULL)
           AND ac.building_id IS NOT NULL
       ) ORDER BY b.building_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/compressor-hours', requireDB, async (req, res) => {
  const { building_id, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optIntFilter(building_id, 'ac.building_id', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT b.building_name, ac.serial_number, r.reading_date, r.reading_time, r.hour_reading
       FROM readings_compressor_hours r
       JOIN air_compressors ac ON ac.compressor_id = r.compressor_id
       JOIN buildings b ON b.building_id = ac.building_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, b.building_name`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── KF Monthly ──────────────────────────────────────────────────────────────
app.get('/api/reports/kf-monthly/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT w.area AS value, w.area AS label
       FROM readings_kf_monthly r
       JOIN wells w ON w.well_id = r.well_id
       WHERE w.area IS NOT NULL ORDER BY w.area`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/kf-monthly', requireDB, async (req, res) => {
  const { area, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optTextFilter(area, 'w.area', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT r.common_name, r.reading_date, r.reading_time,
              r.dtw_reading, r.operator, r.plopper_sounder, r.well_on_off
       FROM readings_kf_monthly r
       JOIN wells w ON w.well_id = r.well_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, r.common_name`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PGE Meters ──────────────────────────────────────────────────────────────
app.get('/api/reports/pge-meters/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.building_id::text AS value, b.building_name AS label
       FROM buildings b
       WHERE b.building_id IN (
         SELECT DISTINCT pm.building_id FROM pge_meters pm
         WHERE pm.pge_meter_id IN (SELECT DISTINCT pge_meter_id FROM readings_pge_meters WHERE pge_meter_id IS NOT NULL)
           AND pm.building_id IS NOT NULL
       ) ORDER BY b.building_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/pge-meters', requireDB, async (req, res) => {
  const { building_id, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optIntFilter(building_id, 'pm.building_id', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT b.building_name, pm.meter_name, r.reading_date, r.reading_time, r.kwh_reading
       FROM readings_pge_meters r
       JOIN pge_meters pm ON pm.pge_meter_id = r.pge_meter_id
       JOIN buildings b ON b.building_id = pm.building_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, b.building_name, pm.meter_name`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Power Monitors ──────────────────────────────────────────────────────────
app.get('/api/reports/power-monitors/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.building_id::text AS value, b.building_name AS label
       FROM buildings b
       WHERE b.building_id IN (
         SELECT DISTINCT pw.building_id FROM power_monitors pw
         WHERE pw.monitor_id IN (SELECT DISTINCT monitor_id FROM readings_power_monitors WHERE monitor_id IS NOT NULL)
           AND pw.building_id IS NOT NULL
       ) ORDER BY b.building_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/power-monitors', requireDB, async (req, res) => {
  const { building_id, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optIntFilter(building_id, 'pw.building_id', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT b.building_name, pw.monitor_number, r.reading_date, r.reading_time, r.kwh_reading
       FROM readings_power_monitors r
       JOIN power_monitors pw ON pw.monitor_id = r.monitor_id
       JOIN buildings b ON b.building_id = pw.building_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, b.building_name, pw.monitor_number`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Run DWR ─────────────────────────────────────────────────────────────────
app.get('/api/reports/run-dwr/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT w.area AS value, w.area AS label
       FROM readings_run_dwr r
       JOIN wells w ON w.well_id = r.well_id
       WHERE w.area IS NOT NULL ORDER BY w.area`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/run-dwr', requireDB, async (req, res) => {
  const { area, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optTextFilter(area, 'w.area', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT w.common_name, w.state_well_number, r.reading_date, r.reading_time,
              r.depth_to_water, r.method, r.operator
       FROM readings_run_dwr r
       JOIN wells w ON w.well_id = r.well_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, w.common_name`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Vehicle Monthly ─────────────────────────────────────────────────────────
app.get('/api/reports/vehicle-monthly/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.vehicle_id::text AS value,
              v.vehicle_number || COALESCE(' — ' || v.year || ' ' || v.make || ' ' || v.model, '') AS label
       FROM vehicles v
       WHERE v.vehicle_id IN (SELECT DISTINCT vehicle_id FROM readings_vehicle_monthly WHERE vehicle_id IS NOT NULL)
       ORDER BY v.vehicle_number`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/vehicle-monthly', requireDB, async (req, res) => {
  const { vehicle_id, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optIntFilter(vehicle_id, 'r.vehicle_id', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT v.vehicle_number, v.make, v.model, r.reading_date, r.reading_time,
              r.odometer_miles, r.engine_hours
       FROM readings_vehicle_monthly r
       JOIN vehicles v ON v.vehicle_id = r.vehicle_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dripper Oil ──────────────────────────────────────────────────────────────
app.get('/api/reports/dripper-oil/areas', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT w.area
       FROM readings_well r
       JOIN wells w ON r.well_id = w.well_id
       WHERE r.dripper_oil IS NOT NULL AND w.area IS NOT NULL
       ORDER BY w.area`
    );
    res.json(rows.map(r => r.area));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/dripper-oil', requireDB, async (req, res) => {
  const { area, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optTextFilter(area, 'w.area', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT w.common_name, r.reading_date, r.reading_time, r.entered_by, r.dripper_oil
       FROM readings_well r
       JOIN wells w ON r.well_id = w.well_id
       WHERE r.dripper_oil IS NOT NULL
         AND r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, w.common_name`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pond Summary ────────────────────────────────────────────────────────────
app.get('/api/reports/pond-summary/options', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT pl.location_id::text AS value, pl.name AS label
       FROM readings_staff_gauge r
       JOIN ponds p ON p.pond_id = r.pond_id
       JOIN pond_locations pl ON pl.location_id = p.location_id
       ORDER BY pl.name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/reports/pond-summary', requireDB, async (req, res) => {
  const { location_id, start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required.' });
  try {
    const { clause, param } = optIntFilter(location_id, 'pl.location_id', 3);
    const params = [start, end, ...(param != null ? [param] : [])];
    const { rows } = await pool.query(
      `SELECT pl.name AS location_name, p.name AS pond_name,
              r.reading_date, r.reading_time, r.level_ft, r.entered_by, r.notes
       FROM readings_staff_gauge r
       JOIN ponds p ON p.pond_id = r.pond_id
       JOIN pond_locations pl ON pl.location_id = p.location_id
       WHERE r.reading_date >= $1 AND r.reading_date <= $2${clause}
       ORDER BY r.reading_date, r.reading_time, pl.name, p.sort_order`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Water Ops Viewer running at http://localhost:${PORT}`);
  if (process.env.DB_HOST) {
    const cfg = {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };
    createPool(cfg);
    console.log(`Auto-connecting to ${cfg.host}:${cfg.port}/${cfg.database}`);
  }
});
