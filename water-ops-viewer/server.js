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
const AUTH_PASS = process.env.AUTH_PASS || '';
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

    const offsetParam = queryParams.length + 1;
    const limitParam = queryParams.length + 2;
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

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    // Title
    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#888888')
      .text(`Generated: ${new Date().toLocaleString()} — ${rows.length} rows`, { align: 'center' });
    doc.moveDown(0.5);

    const pageWidth = doc.page.width - 60;
    const colWidth = Math.min(120, Math.floor(pageWidth / columns.length));
    const rowHeight = 18;
    const headerHeight = 22;

    function drawTableHeader(y) {
      // Header background
      doc.rect(30, y, pageWidth, headerHeight).fill('#667eea');
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
      columns.forEach((col, i) => {
        doc.text(
          String(col).substring(0, 20),
          30 + i * colWidth + 3,
          y + 5,
          { width: colWidth - 6, ellipsis: true }
        );
      });
      return y + headerHeight;
    }

    function drawRow(row, y, isEven) {
      if (isEven) {
        doc.rect(30, y, pageWidth, rowHeight).fill('#f5f5f5');
      }
      doc.fillColor('#333333').fontSize(7).font('Helvetica');
      columns.forEach((col, i) => {
        let val = row[col];
        if (val === null || val === undefined) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        else val = String(val);
        doc.text(val.substring(0, 30), 30 + i * colWidth + 3, y + 5, { width: colWidth - 6, ellipsis: true });
      });
      // Row border
      doc.rect(30, y, pageWidth, rowHeight).stroke('#dddddd');
      return y + rowHeight;
    }

    let y = drawTableHeader(doc.y);
    const maxRowsPerPage = Math.floor((doc.page.height - 100) / rowHeight);

    let rowsOnPage = 0;
    rows.forEach((row, idx) => {
      if (rowsOnPage >= maxRowsPerPage) {
        doc.addPage();
        y = drawTableHeader(30);
        rowsOnPage = 0;
      }
      y = drawRow(row, y, idx % 2 === 1);
      rowsOnPage++;
    });

    // Footer on each page
    const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange().count : '?';
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/status — check connection status
app.get('/api/status', (req, res) => {
  res.json({ connected: !!pool });
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
