require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Auth ─────────────────────────────────────────────────────────────────────

const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'test';
// In-memory session store: token -> expiry timestamp
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
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
  if (isValidSession(cookies.waterops_session)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login.html');
}

// Login endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = createSession();
    res.setHeader('Set-Cookie', `waterops_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid username or password.' });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.waterops_session) sessions.delete(cookies.waterops_session);
  res.setHeader('Set-Cookie', 'waterops_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Serve login page without auth; protect everything else
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login.css' || req.path.startsWith('/auth/')) {
    return next();
  }
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── DB Connection ────────────────────────────────────────────────────────────

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

// POST /api/connect — save connection config and test it
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

async function fetchExportData(req) {
  const { sql, schema, table } = req.body;
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
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
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
      sheet.addRow(columns.map(col => {
        const v = row[col];
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v;
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      }));
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
        let val = row[col];
        if (val === null || val === undefined) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        else val = String(val);
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

    // Exclude auto-generated (serial/identity) columns — DB assigns these
    const importCols = colResult.rows
      .filter(c => !c.column_default || !c.column_default.startsWith('nextval('))
      .map(c => c.column_name);

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

// POST /api/import/:schema/:table — insert rows from uploaded CSV or Excel
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
    // Get table column metadata
    const colResult = await pool.query(`
      SELECT column_name, column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table]);

    if (!colResult.rows.length) return res.status(404).json({ error: 'Table not found.' });

    const tableColNames = new Set(colResult.rows.map(c => c.column_name));
    const serialCols = new Set(
      colResult.rows
        .filter(c => c.column_default && c.column_default.startsWith('nextval('))
        .map(c => c.column_name)
    );

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

    // Only insert non-serial columns that are present in the file
    const insertCols = fileColumns.filter(c => c && !serialCols.has(c));
    if (!insertCols.length) {
      return res.status(400).json({ error: 'No importable columns found in the file.' });
    }

    const quotedTable = `"${schema}"."${table}"`;
    const colList = insertCols.map(c => `"${c}"`).join(', ');
    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${quotedTable} (${colList}) VALUES (${placeholders})`;

    const client = await pool.connect();
    let imported = 0;
    const errors = [];

    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const values = insertCols.map(c => {
          const v = row[c];
          if (v === '' || v === null || v === undefined) return null;
          return v;
        });
        try {
          await client.query(sql, values);
          imported++;
        } catch (err) {
          errors.push({ row: i + 2, error: err.message }); // row 1 = headers, so data starts at 2
        }
      }
    } finally {
      client.release();
    }

    res.json({ imported, total: rows.length, errors });
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
      [name.trim(), sql.trim(), AUTH_USER]
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
