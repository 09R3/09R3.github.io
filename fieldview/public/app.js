/* ── Water Ops Viewer Frontend ── */

const API = '';  // same origin

// ── State ──────────────────────────────────────────────────────────────────────
let state = {
  connected: false,
  dbHost: '', dbPort: '', dbName: '', dbUser: '',
  tables: [],
  currentSchema: null,
  currentTable: null,
  page: 1,
  limit: 50,
  total: 0,
  pages: 0,
  search: '',
  sort: '',
  sortDir: 'asc',
  sqlResult: null,
};

// ── Elements ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connectOverlay = $('connect-overlay');
const appEl = $('app');
const connectForm = $('connect-form');
const connectBtn = $('connect-btn');
const connectError = $('connect-error');
const tableList = $('table-list');
const tableSearch = $('table-search');
const viewTitle = $('view-title');
const rowCount = $('row-count');
const gridContainer = $('grid-container');
const filterBar = $('filter-bar');
const pagination = $('pagination');
const dataSearch = $('data-search');
const pageSize = $('page-size');
const sqlPanel = $('sql-panel');
const sqlEditor = $('sql-editor');
const sqlResult = $('sql-result');
const sqlStatus = $('sql-status');
const nlPanel = $('nl-panel');
const nlResult = $('nl-result');
const nlStatus = $('nl-status');
const nlSqlBlock = $('nl-sql-block');
const nlSqlText = $('nl-sql-text');

// ── Caps Lock warning on DB password field ───────────────────────────────────────────
const dbPass = $('db-pass');
const dbCapsWarn = $('db-caps-warn');
dbPass.addEventListener('keyup', e => {
  dbCapsWarn.classList.toggle('hidden', !e.getModifierState('CapsLock'));
});
dbPass.addEventListener('blur', () => dbCapsWarn.classList.add('hidden'));

// ── Connect ──────────────────────────────────────────────────────────────────────────
connectForm.addEventListener('submit', async e => {
  e.preventDefault();
  setConnecting(true);
  showError('');
  try {
    const res = await post('/api/connect', {
      host: $('db-host').value.trim(),
      port: $('db-port').value.trim(),
      database: $('db-name').value.trim(),
      user: $('db-user').value.trim(),
      password: $('db-pass').value,
    });
    state.connected = true;
    state.dbHost = $('db-host').value.trim();
    state.dbPort = $('db-port').value.trim();
    state.dbName = $('db-name').value.trim();
    state.dbUser = $('db-user').value.trim();
    connectOverlay.classList.remove('active');
    connectOverlay.classList.add('hidden');
    appEl.classList.remove('hidden');
    loadTables();
  } catch (err) {
    showError(err.message);
  } finally {
    setConnecting(false);
  }
});

$('sidebar-toggle-btn').addEventListener('click', () => {
  const collapsed = appEl.classList.toggle('sidebar-collapsed');
  $('sidebar-toggle-btn').textContent = collapsed ? '›' : '‹';
  $('sidebar-toggle-btn').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
});

function disconnectDB() {
  state = { ...state, connected: false, currentSchema: null, currentTable: null,
            dbHost: '', dbPort: '', dbName: '', dbUser: '' };
  appEl.classList.remove('sidebar-collapsed');
  $('sidebar-toggle-btn').textContent = '‹';
  connectOverlay.classList.remove('hidden');
  connectOverlay.classList.add('active');
  appEl.classList.add('hidden');
  gridContainer.innerHTML = emptyState('Select a table from the sidebar\nor open the SQL Editor');
  filterBar.classList.add('hidden');
  pagination.classList.add('hidden');
  viewTitle.textContent = 'Select a table';
  rowCount.textContent = '';
  tableList.innerHTML = '<div class="loading-tables">Loading tables…</div>';
}

// Sign-out button (logs out of the app entirely)
$('sign-out-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

function setConnecting(on) {
  connectBtn.textContent = on ? 'Connecting…' : 'Connect';
  connectBtn.disabled = on;
}

function showError(msg) {
  connectError.textContent = msg;
  connectError.classList.toggle('hidden', !msg);
}

// ── Tables ─────────────────────────────────────────────────────────────────────────
async function loadTables() {
  tableList.innerHTML = '<div class="loading-tables">Loading tables…</div>';
  try {
    state.tables = await get('/api/tables');
    renderTableList(state.tables);
  } catch (err) {
    tableList.innerHTML = `<div class="loading-tables" style="color:var(--error)">${err.message}</div>`;
  }
}

function renderTableList(tables) {
  if (!tables.length) {
    tableList.innerHTML = '<div class="loading-tables">No tables found.</div>';
    return;
  }
  const schemas = {};
  for (const t of tables) {
    if (!schemas[t.table_schema]) schemas[t.table_schema] = [];
    schemas[t.table_schema].push(t);
  }
  let html = '';
  for (const [schema, rows] of Object.entries(schemas)) {
    html += `<div class="schema-group"><div class="schema-label">${esc(schema)}</div>`;
    for (const t of rows) {
      const isActive = t.table_schema === state.currentSchema && t.table_name === state.currentTable;
      const badge = t.table_type === 'VIEW' ? '<span class="table-type-badge">VIEW</span>' : '';
      html += `<button class="table-item${isActive ? ' active' : ''}" data-schema="${esc(t.table_schema)}" data-table="${esc(t.table_name)}">
        <span class="table-name">${esc(t.table_name)}</span>${badge}
      </button>`;
    }
    html += '</div>';
  }
  tableList.innerHTML = html;
  tableList.querySelectorAll('.table-item').forEach(btn => {
    btn.addEventListener('click', () => {
      hideReport();
      state.page = 1;
      state.search = '';
      state.sort = '';
      state.sortDir = 'asc';
      dataSearch.value = '';
      loadTable(btn.dataset.schema, btn.dataset.table);
    });
  });
}

tableSearch.addEventListener('input', () => {
  const q = tableSearch.value.toLowerCase();
  const filtered = state.tables.filter(t =>
    t.table_name.toLowerCase().includes(q) || t.table_schema.toLowerCase().includes(q)
  );
  renderTableList(filtered);
});

// ── Browse Table ─────────────────────────────────────────────────────────────────────
async function loadTable(schema, table) {
  state.currentSchema = schema;
  state.currentTable = table;

  // Highlight active table
  tableList.querySelectorAll('.table-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.schema === schema && btn.dataset.table === table);
  });

  viewTitle.textContent = `${schema}.${table}`;
  rowCount.textContent = '…';
  filterBar.classList.remove('hidden');
  gridContainer.innerHTML = loadingGrid();
  pagination.classList.add('hidden');

  try {
    const params = new URLSearchParams({
      page: state.page,
      limit: state.limit,
      search: state.search,
      sort: state.sort,
      dir: state.sortDir,
    });
    const data = await get(`/api/table/${encodeURIComponent(schema)}/${encodeURIComponent(table)}?${params}`);
    state.total = data.total;
    state.pages = data.pages;
    renderGrid(data.rows, data.columns);
    rowCount.textContent = `${data.total.toLocaleString()} rows`;
    renderPagination(data.page, data.pages, data.total);
  } catch (err) {
    gridContainer.innerHTML = errorState(err.message);
    rowCount.textContent = '';
  }
}

function renderGrid(rows, columns) {
  if (!rows.length) {
    gridContainer.innerHTML = emptyState('No rows found');
    return;
  }
  let html = '<table class="data-table"><thead><tr>';
  for (const col of columns) {
    const isSorted = state.sort === col;
    const arrow = isSorted ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
    html += `<th class="${isSorted ? 'sorted' : ''}" data-col="${esc(col)}">${esc(col)}<span class="sort-arrow">${arrow}</span></th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (const col of columns) {
      html += `<td>${formatCell(row[col])}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  gridContainer.innerHTML = html;

  gridContainer.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sort === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = col;
        state.sortDir = 'asc';
      }
      state.page = 1;
      loadTable(state.currentSchema, state.currentTable);
    });
  });
}

function formatCell(val) {
  if (val === null || val === undefined) return '<span class="null-val">NULL</span>';
  if (typeof val === 'boolean') return `<span class="${val ? 'bool-true' : 'bool-false'}">${val}</span>`;
  if (typeof val === 'number') return `<span class="num-val">${val}</span>`;
  if (typeof val === 'object') return `<span class="json-val">${esc(JSON.stringify(val))}</span>`;
  const str = String(val);
  // Format ISO date/datetime strings from the pg driver (e.g. "2026-03-06T00:00:00.000Z")
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(str)) {
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        // Date-only string (10 chars) or timestamp at exactly midnight UTC → show date only
        // Use timeZone:'UTC' so a DATE like 2026-03-06T00:00:00Z doesn't shift back a day
        const dateOnly = str.length === 10 ||
          (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
        const label = dateOnly ? d.toLocaleDateString(undefined, { timeZone: 'UTC' }) : d.toLocaleString();
        return `<span class="date-val" title="${esc(str)}">${esc(label)}</span>`;
      }
    } catch (_) { /* fall through to plain string */ }
  }
  return esc(str);
}

function renderPagination(page, pages, total) {
  if (pages <= 1) { pagination.classList.add('hidden'); return; }
  pagination.classList.remove('hidden');
  $('pg-info').textContent = `Page ${page} of ${pages} (${total.toLocaleString()} rows)`;
  $('pg-first').disabled = page <= 1;
  $('pg-prev').disabled = page <= 1;
  $('pg-next').disabled = page >= pages;
  $('pg-last').disabled = page >= pages;
}

$('pg-first').addEventListener('click', () => { state.page = 1; loadTable(state.currentSchema, state.currentTable); });
$('pg-prev').addEventListener('click', () => { state.page--; loadTable(state.currentSchema, state.currentTable); });
$('pg-next').addEventListener('click', () => { state.page++; loadTable(state.currentSchema, state.currentTable); });
$('pg-last').addEventListener('click', () => { state.page = state.pages; loadTable(state.currentSchema, state.currentTable); });

// ── Search / Filter ────────────────────────────────────────────────────────────────────
let searchTimer;
dataSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = dataSearch.value;
    state.page = 1;
    if (state.currentTable) loadTable(state.currentSchema, state.currentTable);
  }, 350);
});

pageSize.addEventListener('change', () => {
  state.limit = parseInt(pageSize.value);
  state.page = 1;
  if (state.currentTable) loadTable(state.currentSchema, state.currentTable);
});

// ── Exports (table) ────────────────────────────────────────────────────────────────────
$('export-btn').addEventListener('click', () => {
  if (!state.currentTable) return alert('Select a table first.');
  showExportPreview(
    `${state.currentSchema}.${state.currentTable}`,
    { schema: state.currentSchema, table: state.currentTable }
  );
});

// ── SQL Editor ─────────────────────────────────────────────────────────────────────────
$('sql-editor-btn').addEventListener('click', () => sqlPanel.classList.remove('hidden'));
$('sql-close-btn').addEventListener('click', () => sqlPanel.classList.add('hidden'));

$('sql-run-btn').addEventListener('click', runSQL);
sqlEditor.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSQL(); }
  // Tab key inserts spaces
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = sqlEditor.selectionStart, end = sqlEditor.selectionEnd;
    sqlEditor.value = sqlEditor.value.substring(0, s) + '  ' + sqlEditor.value.substring(end);
    sqlEditor.selectionStart = sqlEditor.selectionEnd = s + 2;
  }
});

async function runSQL() {
  const sql = sqlEditor.value.trim();
  if (!sql) return;
  sqlStatus.textContent = 'Running…';
  sqlStatus.className = 'sql-status';
  sqlResult.innerHTML = '<div class="empty-state-sm">Running query…</div>';

  try {
    const data = await post('/api/query', { sql });
    state.sqlResult = data;
    renderSQLResult(data);
    sqlStatus.className = 'sql-status ok';
    sqlStatus.textContent = `✓ ${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} — ${data.duration}ms — ${data.command}`;
  } catch (err) {
    sqlResult.innerHTML = `<div class="empty-state-sm" style="color:var(--error)">${esc(err.message)}</div>`;
    sqlStatus.className = 'sql-status err';
    sqlStatus.textContent = `✗ ${err.message}`;
  }
}

function renderSQLResult(data) {
  if (!data.rows || !data.rows.length) {
    sqlResult.innerHTML = '<div class="empty-state-sm">Query returned no rows.</div>';
    return;
  }
  const cols = data.fields.map(f => f.name);
  let html = '<table class="data-table"><thead><tr>';
  for (const col of cols) html += `<th>${esc(col)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of data.rows) {
    html += '<tr>';
    for (const col of cols) html += `<td>${formatCell(row[col])}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  sqlResult.innerHTML = html;
}

// ── Ask Claude ─────────────────────────────────────────────────────────────────────────
$('nl-ask-btn').addEventListener('click', () => {
  nlPanel.classList.remove('hidden');
  $('nl-question').focus();
});
$('nl-close-btn').addEventListener('click', () => nlPanel.classList.add('hidden'));
$('nl-run-btn').addEventListener('click', runNlQuery);
$('nl-question').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runNlQuery(); }
});

let nlLastResult = null;

async function runNlQuery() {
  const question = $('nl-question').value.trim();
  if (!question) return;
  nlStatus.textContent = 'Asking Claude…';
  nlStatus.className = 'sql-status';
  nlSqlBlock.classList.add('hidden');
  nlResult.innerHTML = '<div class="empty-state-sm">Running…</div>';
  $('nl-export-btn').style.display = 'none';
  nlLastResult = null;

  try {
    const data = await post('/api/nl-query', { question });
    nlLastResult = data;
    nlSqlText.textContent = data.sql;
    nlSqlBlock.classList.remove('hidden');
    nlStatus.className = 'sql-status ok';
    nlStatus.textContent = `✓ ${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} — ${data.duration}ms`;

    if (data.rows.length) {
      let html = '<table class="data-table"><thead><tr>';
      for (const col of data.columns) html += `<th>${esc(col)}</th>`;
      html += '</tr></thead><tbody>';
      for (const row of data.rows) {
        html += '<tr>';
        for (const col of data.columns) html += `<td>${formatCell(row[col])}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table>';
      nlResult.innerHTML = html;
      $('nl-export-btn').style.display = '';
    } else {
      nlResult.innerHTML = '<div class="empty-state-sm">Query returned no rows.</div>';
    }
  } catch (err) {
    nlResult.innerHTML = `<div class="empty-state-sm" style="color:var(--error)">${esc(err.message)}</div>`;
    nlStatus.className = 'sql-status err';
    nlStatus.textContent = `✗ ${err.message}`;
  }
}

$('nl-export-btn').addEventListener('click', () => {
  if (!nlLastResult) return;
  showExportPreview('Ask Claude Result', { sql: nlLastResult.sql }, {
    rows: nlLastResult.rows,
    columns: nlLastResult.columns,
    rowCount: nlLastResult.rowCount,
  });
});

// ── Exports (SQL result) ───────────────────────────────────────────────────────────────────
$('sql-export-btn').addEventListener('click', () => {
  const sql = sqlEditor.value.trim();
  if (!sql) return alert('Write and run a SQL query first.');
  if (!state.sqlResult) return alert('Run the query first to preview results.');
  showExportPreview('Query Result', { sql }, state.sqlResult);
});

// ── Export Preview ──────────────────────────────────────────────────────────────────────
const previewBackdrop = $('preview-backdrop');
const previewTitle = $('preview-title');
const previewMeta = $('preview-meta');
const previewGrid = $('preview-grid');
const previewDownloadBtns = $('preview-download-btns');

$('preview-close').addEventListener('click', closePreview);
previewBackdrop.addEventListener('click', e => { if (e.target === previewBackdrop) closePreview(); });

function closePreview() {
  previewBackdrop.classList.add('hidden');
  previewGrid.innerHTML = '<div class="empty-state-sm">Loading preview…</div>';
  previewDownloadBtns.innerHTML = '';
}

async function showExportPreview(title, exportBody, cachedResult = null) {
  previewTitle.textContent = `Export Preview — ${title}`;
  previewMeta.textContent = 'Loading…';
  previewGrid.innerHTML = '<div class="empty-state-sm loading-row">Loading preview…</div>';
  previewDownloadBtns.innerHTML = '';
  previewBackdrop.classList.remove('hidden');

  try {
    let rows, columns, total;

    if (cachedResult) {
      rows    = cachedResult.rows;
      columns = cachedResult.fields ? cachedResult.fields.map(f => f.name) : (cachedResult.columns || []);
      total   = cachedResult.rowCount ?? rows.length;
    } else {
      // Table browse — fetch preview respecting current search/sort
      const params = new URLSearchParams({
        page: 1,
        limit: 100,
        search: state.search,
        sort: state.sort,
        dir: state.sortDir,
      });
      const data = await get(`/api/table/${encodeURIComponent(exportBody.schema)}/${encodeURIComponent(exportBody.table)}?${params}`);
      rows = data.rows;
      columns = data.columns;
      total = data.total;
    }

    // Render preview meta
    const showing = Math.min(rows.length, 100);
    previewMeta.textContent = total > showing
      ? `Showing first ${showing} of ${total.toLocaleString()} total rows — full data will be exported`
      : `${total.toLocaleString()} row${total !== 1 ? 's' : ''} — all data will be exported`;

    // Render preview table
    if (!rows.length) {
      previewGrid.innerHTML = '<div class="empty-state-sm">No rows to preview.</div>';
    } else {
      let html = '<table class="data-table"><thead><tr>';
      for (const col of columns) html += `<th>${esc(col)}</th>`;
      html += '</tr></thead><tbody>';
      for (const row of rows.slice(0, 100)) {
        html += '<tr>';
        for (const col of columns) html += `<td>${formatCell(row[col])}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table>';
      previewGrid.innerHTML = html;
    }

    // Render download buttons
    for (const fmt of ['csv', 'xlsx', 'pdf']) {
      const label = fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase();
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = `↓ ${label}`;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = `Exporting…`;
        try {
          await exportData(fmt, exportBody);
          closePreview();
        } finally {
          btn.disabled = false;
          btn.textContent = `↓ ${label}`;
        }
      });
      previewDownloadBtns.appendChild(btn);
    }

  } catch (err) {
    previewGrid.innerHTML = `<div class="empty-state-sm" style="color:var(--error)">${esc(err.message)}</div>`;
    previewMeta.textContent = 'Failed to load preview';
  }
}

// ── Saved Queries ─────────────────────────────────────────────────────────────────────────

async function renderSavedQueriesList() {
  const list = $('saved-queries-list');
  list.innerHTML = '<div class="saved-empty">Loading…</div>';
  try {
    const queries = await get('/api/saved-queries');
    if (!queries.length) {
      list.innerHTML = '<div class="saved-empty">No saved queries yet.<br>Write a query and save it below.</div>';
      return;
    }
    list.innerHTML = '';
    for (const q of queries) {
      const date = new Date(q.created_at).toLocaleDateString();
      const item = document.createElement('div');
      item.className = 'saved-query-item';
      item.innerHTML = `
        <div class="saved-query-info">
          <span class="saved-query-name" title="${esc(q.sql)}">${esc(q.name)}</span>
          <span class="saved-query-meta">${esc(q.created_by)} · ${date}</span>
        </div>
        <div class="saved-query-actions">
          <button class="btn btn-ghost btn-sm" data-id="${q.id}" data-sql="${esc(q.sql)}" data-action="load">Load</button>
          <button class="icon-btn saved-del" data-id="${q.id}" data-action="delete" title="Delete">✕</button>
        </div>`;
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<div class="saved-empty" style="color:var(--error)">${esc(err.message)}</div>`;
  }
}

$('saved-queries-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'load') {
    sqlEditor.value = btn.dataset.sql;
    sqlEditor.focus();
  } else if (btn.dataset.action === 'delete') {
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/saved-queries/${btn.dataset.id}`, { method: 'DELETE' });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      renderSavedQueriesList();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
      btn.disabled = false;
    }
  }
});

$('save-query-btn').addEventListener('click', async () => {
  const name = $('save-query-name').value.trim();
  const sql = sqlEditor.value.trim();
  if (!name) { $('save-query-name').focus(); return; }
  if (!sql) return alert('Write a query in the editor first.');
  const saveBtn = $('save-query-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    await post('/api/saved-queries', { name, sql });
    $('save-query-name').value = '';
    renderSavedQueriesList();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '↑ Save current query';
  }
});

$('sql-saved-btn').addEventListener('click', () => {
  const panel = $('saved-queries-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  $('sql-saved-btn').classList.toggle('active', opening);
  if (opening) renderSavedQueriesList();
});

// ── Export Helper ────────────────────────────────────────────────────────────────────────
async function exportData(format, body) {
  try {
    const res = await fetch(`${API}/api/export/${format}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `export.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
}

// ── Import ─────────────────────────────────────────────────────────────────────────────

const importBackdrop = $('import-backdrop');
const importTitle = $('import-title');
const importMeta = $('import-meta');
const importPreviewSection = $('import-preview-section');
const importPreviewGrid = $('import-preview-grid');
const importPreviewCount = $('import-preview-count');
const importConfirmBtn = $('import-confirm-btn');
const importStatus = $('import-status');
const dropZone = $('drop-zone');
const fileInput = $('file-input');

let importParsed = null; // { filename, data (base64), rows, columns }

$('import-btn').addEventListener('click', () => {
  if (!state.currentTable) return alert('Select a table first.');
  openImportModal();
});

function openImportModal() {
  importTitle.textContent = `Import — ${state.currentSchema}.${state.currentTable}`;
  importMeta.textContent = 'Download a template, fill it in, then upload it here.';
  importPreviewSection.classList.add('hidden');
  importPreviewGrid.innerHTML = '';
  importConfirmBtn.classList.add('hidden');
  importConfirmBtn.textContent = '↑ Import';
  importConfirmBtn.disabled = false;
  importStatus.className = 'import-status hidden';
  importStatus.innerHTML = '';
  fileInput.value = '';
  importParsed = null;
  importBackdrop.classList.remove('hidden');
}

function closeImportModal() {
  importBackdrop.classList.add('hidden');
  importParsed = null;
  fileInput.value = '';
}

$('import-close').addEventListener('click', closeImportModal);
$('import-cancel-btn').addEventListener('click', closeImportModal);
importBackdrop.addEventListener('click', e => { if (e.target === importBackdrop) closeImportModal(); });

// Template downloads
$('tmpl-csv-btn').addEventListener('click', () => downloadTemplate('csv'));
$('tmpl-xlsx-btn').addEventListener('click', () => downloadTemplate('xlsx'));

function downloadTemplate(fmt) {
  if (!state.currentTable) return;
  const url = `/api/template/${encodeURIComponent(state.currentSchema)}/${encodeURIComponent(state.currentTable)}?fmt=${fmt}`;
  const a = document.createElement('a');
  a.href = url;
  a.click();
}

// Drag & drop
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleImportFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleImportFile(fileInput.files[0]);
});
dropZone.addEventListener('click', e => {
  // Don't trigger if they clicked the browse label (it handles its own click)
  if (e.target.tagName !== 'LABEL') fileInput.click();
});

function handleImportFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx'].includes(ext)) {
    showImportStatus('error', 'Only CSV and XLSX files are supported.');
    return;
  }

  importStatus.className = 'import-status hidden';
  importPreviewSection.classList.add('hidden');
  importConfirmBtn.classList.add('hidden');
  importMeta.textContent = `Reading ${file.name}…`;

  const reader = new FileReader();
  reader.onload = e => {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(e.target.result)));
    // Parse client-side for preview
    let rows = [], columns = [];
    try {
      if (ext === 'csv') {
        const text = new TextDecoder().decode(e.target.result);
        const parsed = clientParseCSV(text);
        columns = parsed.columns;
        rows = parsed.rows;
      } else {
        // For Excel we can't parse client-side without a library;
        // send to server to preview via a lightweight parse check
        // We'll just show the filename and row count after import
        rows = null; // signal server-side only
        columns = null;
      }
    } catch (err) {
      showImportStatus('error', `Could not read file: ${err.message}`);
      return;
    }

    importParsed = { filename: file.name, data: base64, rows, columns };

    if (rows !== null && columns !== null) {
      renderImportPreview(rows, columns);
    } else {
      // Excel: show placeholder
      importPreviewSection.classList.remove('hidden');
      importPreviewCount.textContent = '';
      importPreviewGrid.innerHTML = '<div class="empty-state-sm">Excel file ready — preview will be shown after import.</div>';
    }

    importMeta.textContent = file.name;
    importConfirmBtn.classList.remove('hidden');
    const rowLabel = rows !== null ? `${rows.length} row${rows.length !== 1 ? 's' : ''}` : 'file';
    importConfirmBtn.textContent = `↑ Import ${rowLabel}`;
  };
  reader.readAsArrayBuffer(file);
}

function clientParseCSV(text) {
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
  if (!result.length) return { columns: [], rows: [] };
  const columns = result[0];
  const rows = result.slice(1).map(vals => {
    const obj = {};
    columns.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
    return obj;
  });
  return { columns, rows };
}

function renderImportPreview(rows, columns) {
  importPreviewSection.classList.remove('hidden');
  const preview = rows.slice(0, 10);
  importPreviewCount.textContent = `(${rows.length} row${rows.length !== 1 ? 's' : ''} — showing first ${Math.min(10, rows.length)})`;
  if (!rows.length) {
    importPreviewGrid.innerHTML = '<div class="empty-state-sm">No data rows found in file.</div>';
    return;
  }
  let html = '<table class="data-table"><thead><tr>';
  for (const col of columns) html += `<th>${esc(col)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of preview) {
    html += '<tr>';
    for (const col of columns) html += `<td>${formatCell(row[col])}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  importPreviewGrid.innerHTML = html;
}

importConfirmBtn.addEventListener('click', async () => {
  if (!importParsed) return;
  importConfirmBtn.disabled = true;
  importConfirmBtn.textContent = 'Importing…';
  importStatus.className = 'import-status hidden';

  try {
    const result = await post(
      `/api/import/${encodeURIComponent(state.currentSchema)}/${encodeURIComponent(state.currentTable)}`,
      { filename: importParsed.filename, data: importParsed.data }
    );

    const inserted = result.inserted ?? result.imported ?? 0;
    const updated = result.updated ?? 0;
    const parts = [];
    if (inserted > 0) parts.push(`${inserted} inserted`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (!parts.length) parts.push('0 rows changed');
    let msg = `✓ ${parts.join(', ')} (${result.total} total).`;
    let cls = 'import-status success';
    if (result.errors && result.errors.length) {
      cls = 'import-status warning';
      msg += ` ${result.errors.length} row${result.errors.length !== 1 ? 's' : ''} failed:`;
      msg += '<ul class="import-error-list">' +
        result.errors.slice(0, 5).map(e => `<li>Row ${e.row}: ${esc(e.error)}</li>`).join('') +
        (result.errors.length > 5 ? `<li>…and ${result.errors.length - 5} more</li>` : '') +
        '</ul>';
    }
    importStatus.className = cls;
    importStatus.innerHTML = msg;
    importConfirmBtn.classList.add('hidden');

    // Reload the table to show new rows
    if (inserted > 0 || updated > 0) {
      state.page = 1;
      loadTable(state.currentSchema, state.currentTable);
    }
  } catch (err) {
    showImportStatus('error', `Import failed: ${err.message}`);
    importConfirmBtn.disabled = false;
    importConfirmBtn.textContent = '↑ Retry Import';
  }
});

function showImportStatus(type, msg) {
  importStatus.className = `import-status ${type}`;
  importStatus.innerHTML = esc(msg);
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────
async function get(url) {
  const res = await fetch(API + url);
  if (!res.ok) { const e = await res.json(); throw new Error(e.error || res.statusText); }
  return res.json();
}

async function post(url, data) {
  const res = await fetch(API + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error || res.statusText); }
  return res.json();
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emptyState(msg) {
  return `<div class="empty-state"><div class="empty-icon"><img src="/icons/icon-FV.svg" alt="" style="width:48px;height:48px;opacity:0.3;" /></div><p>${msg}</p></div>`;
}
function errorState(msg) {
  return `<div class="empty-state"><div class="empty-icon" style="color:var(--error)">✕</div><p style="color:var(--error)">${esc(msg)}</p></div>`;
}
function loadingGrid() {
  return '<div class="empty-state"><div class="empty-icon loading-row"><img src="/icons/icon-FV.svg" alt="" style="width:48px;height:48px;opacity:0.3;" /></div><p>Loading…</p></div>';
}

// ── Sidebar Sections ───────────────────────────────────────────────────────────────────────
function initSidebarSections() {
  ['tables', 'reports'].forEach(name => {
    const toggle = $(`${name}-section-btn`);
    const body   = $(`${name}-section-body`);
    toggle.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed', collapsed);
    });
  });
  // Default: tables collapsed, reports open
  $('tables-section-body').classList.add('collapsed');
  $('tables-section-btn').classList.add('collapsed');
}
initSidebarSections();

// ── Settings Modal ───────────────────────────────────────────────────────────────────────
const settingsBackdrop = $('settings-backdrop');

$('settings-btn').addEventListener('click', () => {
  const hostEl = $('set-host');
  const dbEl   = $('set-db');
  const userEl = $('set-user');
  if (hostEl) hostEl.textContent = state.dbHost ? `${state.dbHost}:${state.dbPort || 5432}` : '—';
  if (dbEl)   dbEl.textContent   = state.dbName || '—';
  if (userEl) userEl.textContent = state.dbUser || '—';
  settingsBackdrop.classList.remove('hidden');
});

$('settings-close').addEventListener('click', () => settingsBackdrop.classList.add('hidden'));
settingsBackdrop.addEventListener('click', e => {
  if (e.target === settingsBackdrop) settingsBackdrop.classList.add('hidden');
});

$('disconnect-btn').addEventListener('click', () => {
  settingsBackdrop.classList.add('hidden');
  disconnectDB();
});

// ── Date range helpers ───────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function setDefaultDates(startEl, endEl) {
  startEl.value = daysAgoStr(30);
  endEl.value   = todayStr();
}

function buildMonthOptions() {
  const today = new Date();
  const opts = ['<option value="">Quick select month…</option>', '<option value="last30">Last 30 days</option>'];
  for (let i = 0; i < 24; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
    opts.push(`<option value="${y}-${String(m).padStart(2,'0')}">${label}</option>`);
  }
  return opts.join('');
}

function wireMonthSelect(selectId, startEl, endEl) {
  const sel = $(selectId);
  if (!sel) return;
  sel.innerHTML = buildMonthOptions();
  sel.addEventListener('change', () => {
    const val = sel.value;
    if (!val) return;
    if (val === 'last30') {
      startEl.value = daysAgoStr(30);
      endEl.value   = todayStr();
    } else {
      const [y, m] = val.split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      const last  = new Date(y, m, 0);
      const now   = new Date();
      startEl.value = first.toISOString().slice(0, 10);
      endEl.value   = last > now ? todayStr() : last.toISOString().slice(0, 10);
    }
    sel.value = '';
  });
}

// ── Reports ────────────────────────────────────────────────────────────────────────────
const reportPanel   = $('report-panel');
const rphPlant      = $('rph-site');
const rphStart      = $('rph-from');
const rphEnd        = $('rph-to');
const rphRunBtn     = $('rph-run');
const rphExportBtn  = $('rph-export');
const rphGrid       = $('rph-grid');
const rphStatus     = $('rph-status');
const rphChipsRow   = $('rph-chips-row');

let activeReport = null;
let rphData = [];
let rphSelectedLetters = new Set(); // empty = All
let rphDelta = { active: false };
let rwrDelta = { active: false };

// ── Column-select utility (shared by all report grids) ─────────────────────────────────
// Shared state — only one report grid is visible at a time
const colSel = { copy: null, clear: null };

// One-time button setup — avoids stacking listeners on re-runs
for (const pfx of ['rph', 'rwr', 'rcr', 'rch', 'rkf', 'rpge', 'rpm', 'rdwr', 'rvm', 'rdo']) {
  $(`${pfx}-col-copy`)?.addEventListener('click', () => colSel.copy?.());
  $(`${pfx}-col-clear`)?.addEventListener('click', () => colSel.clear?.());
  wireMonthSelect(`${pfx}-month`, $(`${pfx}-from`), $(`${pfx}-to`));
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && colSel.copy && !reportPanel.classList.contains('hidden')) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { e.preventDefault(); colSel.copy(); }
  }
});

function writeToClipboard(text) {
  // Check secure context synchronously so the fallback runs inside the user gesture
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

function initColSelect(gridEl, copyBarEl, labelEl) {
  copyBarEl.classList.add('hidden');
  const table = gridEl.querySelector('.data-table');
  if (!table) { colSel.copy = null; colSel.clear = null; return; }

  const headers = [...table.querySelectorAll('thead th')];
  const selectedCols = new Set();

  function updateHighlight() {
    table.querySelectorAll('.col-sel').forEach(el => el.classList.remove('col-sel'));
    if (!selectedCols.size) { copyBarEl.classList.add('hidden'); return; }
    selectedCols.forEach(idx => {
      headers[idx]?.classList.add('col-sel');
      table.querySelectorAll('tbody tr').forEach(tr => { tr.cells[idx]?.classList.add('col-sel'); });
    });
    labelEl.textContent = `${selectedCols.size} column${selectedCols.size > 1 ? 's' : ''} selected — Ctrl+C or`;
    copyBarEl.classList.remove('hidden');
  }

  function copyColumns() {
    if (!selectedCols.size) return;
    const cols = [...selectedCols].sort((a, b) => a - b);
    const lines = [cols.map(i => headers[i]?.textContent.trim() ?? '').join('\t')];
    table.querySelectorAll('tbody tr').forEach(tr => {
      lines.push(cols.map(i => tr.cells[i]?.textContent.trim() ?? '').join('\t'));
    });
    writeToClipboard(lines.join('\n'));
    const btn = $(`${copyBarEl.id.replace('-col-bar','-col-copy')}`);
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  headers.forEach((th, idx) => {
    th.classList.add('col-selectable');
    th.addEventListener('click', () => {
      selectedCols.has(idx) ? selectedCols.delete(idx) : selectedCols.add(idx);
      updateHighlight();
    });
  });

  colSel.copy = copyColumns;
  colSel.clear = () => { selectedCols.clear(); updateHighlight(); };
}

// ── Delta Column ─────────────────────────────────────────────────────────────────────────
function formatDelta(val) {
  if (val === null || val === undefined) return '<span class="null-val">—</span>';
  const n = parseFloat(val);
  if (isNaN(n)) return '<span class="null-val">—</span>';
  const cls = n > 0 ? 'delta-pos' : n < 0 ? 'delta-neg' : 'delta-zero';
  const sign = n > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>`;
}

function computeDeltaRows(data, valueKey, groupKey) {
  const prev = {};
  return data.map(row => {
    const grp = groupKey ? String(row[groupKey] ?? '') : '__all__';
    const cur = parseFloat(row[valueKey]);
    const p = prev[grp];
    let delta = null;
    if (p !== undefined && !isNaN(cur) && !isNaN(p)) delta = cur - p;
    if (!isNaN(cur)) prev[grp] = cur;
    return { ...row, _delta: delta };
  });
}

function renderReportTable(gridEl, data, colKeys, colHdrs, copyBar, copyLbl, deltaLabel = null, colFormatters = {}) {
  const allKeys = deltaLabel ? [...colKeys, '_delta'] : colKeys;
  const allHdrs = deltaLabel ? [...colHdrs, deltaLabel] : colHdrs;
  let html = `<table class="data-table"><thead><tr>${allHdrs.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`;
  for (const row of data) {
    html += `<tr>${allKeys.map(k => `<td>${k === '_delta' ? formatDelta(row._delta) : (colFormatters[k] || formatCell)(row[k])}</td>`).join('')}</tr>`;
  }
  html += '</tbody></table>';
  gridEl.innerHTML = html;
  if (copyBar) initColSelect(gridEl, copyBar, copyLbl);
}

function setupDeltaBar(pfx, gridEl, getData, colKeys, colHdrs, copyBar, copyLbl, onDeltaChange, colFormatters = {}) {
  const old = document.getElementById(pfx + '-delta-bar');
  if (old) old.remove();

  const bar = document.createElement('div');
  bar.id = pfx + '-delta-bar';
  bar.className = 'delta-bar';

  const colOpts = colKeys.map((k, i) => `<option value="${k}">${esc(colHdrs[i])}</option>`).join('');
  bar.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="${pfx}-dtoggle">∑ Delta Column</button>
    <div class="delta-config hidden" id="${pfx}-dcfg">
      <span class="delta-config-label">Value</span>
      <select class="report-select delta-sel" id="${pfx}-dval">${colOpts}</select>
      <span class="delta-config-label">Group by</span>
      <select class="report-select delta-sel" id="${pfx}-dgrp">
        <option value="">— none —</option>${colOpts}
      </select>
      <input type="text" class="report-date" id="${pfx}-dlbl" value="Change" placeholder="Label" style="width:90px" />
      <button class="btn btn-primary btn-sm" id="${pfx}-dapply">Apply</button>
      <button class="btn btn-ghost btn-sm" id="${pfx}-dremove" style="display:none">✕ Remove</button>
    </div>`;

  gridEl.parentElement.insertBefore(bar, gridEl);

  document.getElementById(pfx + '-dtoggle').addEventListener('click', () => {
    document.getElementById(pfx + '-dcfg').classList.toggle('hidden');
  });

  document.getElementById(pfx + '-dapply').addEventListener('click', () => {
    const valueKey = document.getElementById(pfx + '-dval').value;
    const groupKey = document.getElementById(pfx + '-dgrp').value;
    const label    = document.getElementById(pfx + '-dlbl').value.trim() || 'Change';
    const delta = computeDeltaRows(getData(), valueKey, groupKey);
    renderReportTable(gridEl, delta, colKeys, colHdrs, copyBar, copyLbl, label, colFormatters);
    document.getElementById(pfx + '-dremove').style.display = '';
    if (onDeltaChange) onDeltaChange({ active: true, valueKey, groupKey, label });
  });

  document.getElementById(pfx + '-dremove').addEventListener('click', () => {
    renderReportTable(gridEl, getData(), colKeys, colHdrs, copyBar, copyLbl, null, colFormatters);
    document.getElementById(pfx + '-dremove').style.display = 'none';
    if (onDeltaChange) onDeltaChange({ active: false });
  });
}

function showSubPanel(id) {
  document.querySelectorAll('#report-panel > div').forEach(el => el.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function showReport(name, title) {
  colSel.copy = null; colSel.clear = null;
  gridContainer.classList.add('hidden');
  filterBar.classList.add('hidden');
  pagination.classList.add('hidden');
  state.currentTable = null;
  state.currentSchema = null;
  document.querySelectorAll('.table-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.report-item').forEach(el => el.classList.remove('active'));
  activeReport = name;
  reportPanel.classList.remove('hidden');
  $(`report-${name}`)?.classList.add('active');
  viewTitle.textContent = title || 'Report';
  rowCount.textContent = '';
}

function hideReport() {
  activeReport = null;
  reportPanel.classList.add('hidden');
  gridContainer.classList.remove('hidden');
  if (!state.currentTable) {
    gridContainer.innerHTML = emptyState('Select a table from the sidebar\nor open the SQL Editor');
  }
}

async function rphLoadPumps(siteId) {
  rphChipsRow.classList.add('hidden');
  rphSelectedLetters.clear();
  if (!siteId) return;
  try {
    const letters = await get(`/api/reports/pump-hours/pumps?site_id=${encodeURIComponent(siteId)}`);
    if (!letters.length) return;
    rphChipsRow.innerHTML =
      `<button class="pump-chip active" data-letter="ALL">All</button>` +
      letters.map(l => `<button class="pump-chip" data-letter="${esc(l)}">${esc(l)}</button>`).join('');
    rphChipsRow.classList.remove('hidden');
  } catch { /* ignore — pump filter just won't show */ }
}

rphChipsRow.addEventListener('click', e => {
  const chip = e.target.closest('.pump-chip');
  if (!chip) return;
  const letter = chip.dataset.letter;

  if (letter === 'ALL') {
    rphSelectedLetters.clear();
    rphChipsRow.querySelectorAll('.pump-chip').forEach(c => c.classList.toggle('active', c.dataset.letter === 'ALL'));
    return;
  }

  // Toggle individual letter
  if (rphSelectedLetters.has(letter)) {
    rphSelectedLetters.delete(letter);
  } else {
    rphSelectedLetters.add(letter);
  }
  // If nothing selected → fall back to All
  if (!rphSelectedLetters.size) {
    rphChipsRow.querySelectorAll('.pump-chip').forEach(c => c.classList.toggle('active', c.dataset.letter === 'ALL'));
    return;
  }
  // Deactivate All chip, update individual chips
  rphChipsRow.querySelectorAll('.pump-chip').forEach(c => {
    if (c.dataset.letter === 'ALL') {
      c.classList.remove('active');
    } else {
      c.classList.toggle('active', rphSelectedLetters.has(c.dataset.letter));
    }
  });
});

// Open Pump Hours report
$('report-pump-hours').addEventListener('click', async () => {
  showReport('pump-hours', 'Pump Hours Report');
  showSubPanel('rph-panel');
  setDefaultDates(rphStart, rphEnd);
  rphStatus.textContent = 'Loading pumping plants…';
  rphGrid.innerHTML = emptyState('Select a pumping plant and date range,\nthen click Run Report');
  rphExportBtn.classList.add('hidden');
  rphChipsRow.classList.add('hidden');
  try {
    const sites = await get('/api/reports/pump-hours/plants');
    rphPlant.innerHTML = sites.map(s =>
      `<option value="${esc(s)}">Pumping Plant ${esc(s)}</option>`
    ).join('');
    rphStatus.textContent = `${sites.length} pumping plant(s) found.`;
    if (sites.length) rphLoadPumps(sites[0]);
  } catch (err) {
    rphStatus.textContent = `Error loading plants: ${err.message}`;
  }
});

rphPlant.addEventListener('change', () => rphLoadPumps(rphPlant.value));

// Run the report
rphRunBtn.addEventListener('click', async () => {
  const siteId = rphPlant.value;
  const start  = rphStart.value;
  const end    = rphEnd.value;
  if (!siteId) { rphStatus.textContent = 'Select a pumping plant.'; return; }
  if (!start)  { rphStatus.textContent = 'Select a start date.'; return; }
  if (!end)    { rphStatus.textContent = 'Select an end date.'; return; }
  if (start > end) { rphStatus.textContent = 'Start date must be before end date.'; return; }

  rphStatus.textContent = 'Running…';
  rphGrid.innerHTML = loadingGrid();
  rphExportBtn.classList.add('hidden');
  $('rph-col-bar').classList.add('hidden');
  rphData = [];

  try {
    const params = new URLSearchParams({ site_id: siteId, start, end });
    if (rphSelectedLetters.size) params.set('pump_letters', [...rphSelectedLetters].join(','));
    rphData = await get(`/api/reports/pump-hours?${params}`);

    if (!rphData.length) {
      rphGrid.innerHTML = emptyState('No readings found for this selection.');
      rphStatus.textContent = 'No results.';
      return;
    }

    const cols    = ['pump_letter', 'reading_date', 'reading_time', 'hour_reading'];
    const headers = ['Pump', 'Reading Date', 'Reading Time', 'Hour Reading'];

    rphDelta = { active: false };
    renderReportTable(rphGrid, rphData, cols, headers, $('rph-col-bar'), $('rph-col-label'));
    rphStatus.textContent = `${rphData.length} reading${rphData.length !== 1 ? 's' : ''} found.`;
    rphExportBtn.classList.remove('hidden');
    setupDeltaBar('rph', rphGrid, () => rphData, cols, headers,
      $('rph-col-bar'), $('rph-col-label'), p => { rphDelta = p; });
  } catch (err) {
    rphGrid.innerHTML = errorState(err.message);
    rphStatus.textContent = 'Error running report.';
  }
});

// Export report results
rphExportBtn.addEventListener('click', () => {
  if (!rphData.length) return;
  const plantLabel = rphPlant.options[rphPlant.selectedIndex]?.text || rphPlant.value;
  const start = rphStart.value;
  const end   = rphEnd.value;
  const colMap = [['pump_letter','Pump'],['reading_date','Reading Date'],['reading_time','Reading Time'],['hour_reading','Hour Reading']];
  let exportData = rphData;
  if (rphDelta.active) {
    exportData = computeDeltaRows(rphData, rphDelta.valueKey, rphDelta.groupKey);
    colMap.push(['_delta', rphDelta.label]);
  }
  const hdrs = colMap.map(([,h]) => h);
  const title = `Pump_Hours_${plantLabel}_${start}_to_${end}`;
  const exportRows = exportData.map(r => Object.fromEntries(colMap.map(([k,h]) => [h, k === '_delta' ? (r._delta ?? '') : r[k]])));
  const body  = { rows: exportRows, columns: hdrs, title };
  showExportPreview(`Pump Hours — ${plantLabel} (${start} to ${end})`, body,
    { rows: exportRows, columns: hdrs, rowCount: exportRows.length });
});

// ── Well Readings Report ─────────────────────────────────────────────────────────────────────
const rwrArea        = $('rwr-area');
const rwrPool        = $('rwr-pool');
const rwrParticipant = $('rwr-participant');
const rwrStart       = $('rwr-from');
const rwrEnd         = $('rwr-to');
const rwrRunBtn      = $('rwr-run');
const rwrExportBtn   = $('rwr-export');
const rwrGrid        = $('rwr-grid');
const rwrStatus      = $('rwr-status');
let rwrData = [];

const RWR_COLS = ['reading_date', 'reading_time', 'state_well_number', 'common_name', 'hour_reading', 'flow_cfs', 'totalizer', 'totalizer_calc', 'pge_kwh'];
const RWR_HDRS = ['Date', 'Time', 'State Well #', 'Common Name', 'Hour Reading', 'Flow (cfs)', 'Totalizer', 'Totalizer CFS', 'PG&E kWh'];
const RWR_FORMATTERS = {
  totalizer_calc: val => val === null || val === undefined
    ? '<span class="null-val">N/A</span>'
    : `<span class="num-val">${Number(val).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>`,
};

$('report-well-readings').addEventListener('click', async () => {
  showReport('well-readings', 'Well Readings Report');
  showSubPanel('rwr-panel');
  setDefaultDates(rwrStart, rwrEnd);
  rwrStatus.textContent = 'Loading filters…';
  rwrGrid.innerHTML = emptyState('Select filters and date range,\nthen click Run Report');
  rwrExportBtn.classList.add('hidden');
  try {
    const [areas, pools, participants] = await Promise.all([
      get('/api/reports/well-readings/areas'),
      get('/api/reports/well-readings/pools'),
      get('/api/reports/well-readings/participants'),
    ]);
    rwrArea.innerHTML = '<option value="">All</option>' +
      areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    rwrPool.innerHTML = '<option value="">All</option>' +
      pools.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    rwrParticipant.innerHTML = '<option value="">All</option>' +
      participants.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    rwrStatus.textContent = `${areas.length} area(s) loaded.`;
  } catch (err) {
    rwrStatus.textContent = `Error loading filters: ${err.message}`;
  }
});

rwrRunBtn.addEventListener('click', async () => {
  const area        = rwrArea.value;
  const pool        = rwrPool.value;
  const participant = rwrParticipant.value;
  const start       = rwrStart.value;
  const end         = rwrEnd.value;
  if (!start) { rwrStatus.textContent = 'Select a start date.'; return; }
  if (!end)   { rwrStatus.textContent = 'Select an end date.'; return; }
  if (start > end) { rwrStatus.textContent = 'Start date must be before end date.'; return; }

  rwrStatus.textContent = 'Running…';
  rwrGrid.innerHTML = loadingGrid();
  rwrExportBtn.classList.add('hidden');
  $('rwr-col-bar').classList.add('hidden');
  rwrData = [];

  try {
    const params = new URLSearchParams({ start, end });
    if (area)        params.set('area', area);
    if (pool)        params.set('pool', pool);
    if (participant) params.set('participant', participant);
    rwrData = await get(`/api/reports/well-readings?${params}`);

    if (!rwrData.length) {
      rwrGrid.innerHTML = emptyState('No readings found for the selected filters and date range.');
      rwrStatus.textContent = 'No results.';
      return;
    }

    rwrDelta = { active: false };
    renderReportTable(rwrGrid, rwrData, RWR_COLS, RWR_HDRS, $('rwr-col-bar'), $('rwr-col-label'), null, RWR_FORMATTERS);
    rwrStatus.textContent = `${rwrData.length} reading${rwrData.length !== 1 ? 's' : ''} found.`;
    rwrExportBtn.classList.remove('hidden');
    setupDeltaBar('rwr', rwrGrid, () => rwrData, RWR_COLS, RWR_HDRS,
      $('rwr-col-bar'), $('rwr-col-label'), p => { rwrDelta = p; }, RWR_FORMATTERS);
  } catch (err) {
    rwrGrid.innerHTML = errorState(err.message);
    rwrStatus.textContent = 'Error running report.';
  }
});

rwrExportBtn.addEventListener('click', () => {
  if (!rwrData.length) return;
  const area        = rwrArea.value;
  const pool        = rwrPool.value;
  const participant = rwrParticipant.value;
  const start       = rwrStart.value;
  const end         = rwrEnd.value;
  const colMap = RWR_COLS.map((k, i) => [k, RWR_HDRS[i]]);
  let exportData = rwrData;
  if (rwrDelta.active) {
    exportData = computeDeltaRows(rwrData, rwrDelta.valueKey, rwrDelta.groupKey);
    colMap.push(['_delta', rwrDelta.label]);
  }
  const hdrs = colMap.map(([,h]) => h);
  const filterLabel = [area || 'All Areas', pool ? `Pool:${pool}` : '', participant ? `Part:${participant}` : ''].filter(Boolean).join('_');
  const title = `Well_Readings_${filterLabel}_${start}_to_${end}`;
  const displayLabel = [area || 'All Areas', pool ? `Pool: ${pool}` : '', participant ? `Participant: ${participant}` : ''].filter(Boolean).join(', ');
  const exportRows = exportData.map(r => Object.fromEntries(colMap.map(([k,h]) => [h, k === '_delta' ? (r._delta ?? '') : r[k]])));
  const body = { rows: exportRows, columns: hdrs, title };
  showExportPreview(`Well Readings — ${displayLabel} (${start} to ${end})`, body,
    { rows: exportRows, columns: hdrs, rowCount: exportRows.length });
});

// ── Generic Report Factory ───────────────────────────────────────────────────────────────────
function makeReport({ sidebarId, panelId, title, prefix, selectId, optionsUrl, reportUrl, filterParam, cols, hdrs, colFormatters = {} }) {
  const sel     = selectId ? $(selectId) : null;
  const startEl = $(prefix + '-from');
  const endEl   = $(prefix + '-to');
  const runBtn  = $(prefix + '-run');
  const expBtn  = $(prefix + '-export');
  const grid    = $(prefix + '-grid');
  const status  = $(prefix + '-status');
  const copyBar = $(prefix + '-col-bar');
  const copyLbl = $(prefix + '-col-label');
  let data = [];
  let deltaParams = { active: false };

  $(sidebarId).addEventListener('click', async () => {
    showReport(sidebarId.replace('report-', ''), title);
    showSubPanel(panelId);
    setDefaultDates(startEl, endEl);
    status.textContent = 'Loading options…';
    expBtn.classList.add('hidden');
    copyBar?.classList.add('hidden');
    data = [];
    try {
      const opts = await get(optionsUrl);
      sel.innerHTML = '<option value="">— All —</option>' +
        opts.map(o => typeof o === 'string'
          ? `<option value="${esc(o)}">${esc(o)}</option>`
          : `<option value="${esc(o.value)}">${esc(o.label)}</option>`
        ).join('');
      status.textContent = `${opts.length} option(s) loaded.`;
    } catch (err) {
      status.textContent = `Error loading options: ${err.message}`;
    }
  });

  runBtn.addEventListener('click', async () => {
    const filter = sel.value;
    const start  = startEl.value;
    const end    = endEl.value;
    if (!start) { status.textContent = 'Select a start date.'; return; }
    if (!end)   { status.textContent = 'Select an end date.'; return; }
    if (start > end) { status.textContent = 'Start must be before end.'; return; }
    status.textContent = 'Running…';
    grid.innerHTML = loadingGrid();
    expBtn.classList.add('hidden');
    copyBar?.classList.add('hidden');
    data = [];
    try {
      const params = new URLSearchParams({ start, end });
      if (filter) params.set(filterParam, filter);
      data = await get(`${reportUrl}?${params}`);
      if (!data.length) {
        grid.innerHTML = emptyState('No readings found for this selection.');
        status.textContent = 'No results.';
        return;
      }
      deltaParams = { active: false };
      renderReportTable(grid, data, cols, hdrs, copyBar, copyLbl, null, colFormatters);
      status.textContent = `${data.length} reading${data.length !== 1 ? 's' : ''} found.`;
      expBtn.classList.remove('hidden');
      setupDeltaBar(prefix, grid, () => data, cols, hdrs, copyBar, copyLbl, p => { deltaParams = p; }, colFormatters);
    } catch (err) {
      grid.innerHTML = errorState(err.message);
      status.textContent = 'Error running report.';
    }
  });

  expBtn.addEventListener('click', () => {
    if (!data.length) return;
    const filterText = sel.options[sel.selectedIndex]?.text || 'All';
    const start = startEl.value;
    const end   = endEl.value;
    const colMap = cols.map((k, i) => [k, hdrs[i]]);
    let exportData = data;
    if (deltaParams.active) {
      exportData = computeDeltaRows(data, deltaParams.valueKey, deltaParams.groupKey);
      colMap.push(['_delta', deltaParams.label]);
    }
    const expHdrs = colMap.map(([,h]) => h);
    const exportTitle = `${title.replace(/ /g,'_')}_${filterText.replace(/ /g,'_')}_${start}_to_${end}`;
    const exportRows  = exportData.map(r => Object.fromEntries(colMap.map(([k,h]) => [h, k === '_delta' ? (r._delta ?? '') : r[k]])));
    const body = { rows: exportRows, columns: expHdrs, title: exportTitle };
    showExportPreview(`${title} — ${filterText} (${start} to ${end})`, body,
      { rows: exportRows, columns: expHdrs, rowCount: exportRows.length });
  });
}

// ── Report Definitions ───────────────────────────────────────────────────────────────────────
makeReport({
  sidebarId: 'report-canal-readings', panelId: 'rcr-panel',
  title: 'Canal Readings Report', prefix: 'rcr', selectId: 'rcr-structure',
  optionsUrl: '/api/reports/canal-readings/options',
  reportUrl:  '/api/reports/canal-readings',
  filterParam: 'structure_id',
  cols: ['structure_name','reading_date','reading_time','instantaneous_flow_cfs','totalizer_reading_af','totalizer_calc','gate_setting','head_reading_ft','derived_flow_cfs'],
  hdrs: ['Structure','Date','Time','Flow (cfs)','Totalizer (af)','Totalizer CFS','Gate Setting','Head (ft)','Derived Flow (cfs)'],
  colFormatters: {
    totalizer_calc: val => val === null || val === undefined
      ? '<span class="null-val">N/A</span>'
      : `<span class="num-val">${Number(val).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>`,
  },
});

makeReport({
  sidebarId: 'report-compressor-hours', panelId: 'rch-panel',
  title: 'Compressor Hours Report', prefix: 'rch', selectId: 'rch-compressor',
  optionsUrl: '/api/reports/compressor-hours/options',
  reportUrl:  '/api/reports/compressor-hours',
  filterParam: 'building_id',
  cols: ['building_name','serial_number','reading_date','reading_time','hour_reading'],
  hdrs: ['Building','Serial #','Date','Time','Hour Reading'],
});

makeReport({
  sidebarId: 'report-kf-monthly', panelId: 'rkf-panel',
  title: 'KF Monthly Report', prefix: 'rkf', selectId: 'rkf-set',
  optionsUrl: '/api/reports/kf-monthly/options',
  reportUrl:  '/api/reports/kf-monthly',
  filterParam: 'area',
  cols: ['common_name','reading_date','reading_time','dtw_reading','operator','plopper_sounder','well_on_off'],
  hdrs: ['Well','Date','Time','DTW Reading','Operator','Plopper/Sounder','On/Off'],
});

makeReport({
  sidebarId: 'report-pge-meters', panelId: 'rpge-panel',
  title: 'PGE Meters Report', prefix: 'rpge', selectId: 'rpge-meter',
  optionsUrl: '/api/reports/pge-meters/options',
  reportUrl:  '/api/reports/pge-meters',
  filterParam: 'building_id',
  cols: ['building_name','meter_name','reading_date','reading_time','kwh_reading'],
  hdrs: ['Building','Meter','Date','Time','kWh Reading'],
});

makeReport({
  sidebarId: 'report-power-monitors', panelId: 'rpm-panel',
  title: 'Power Monitors Report', prefix: 'rpm', selectId: 'rpm-monitor',
  optionsUrl: '/api/reports/power-monitors/options',
  reportUrl:  '/api/reports/power-monitors',
  filterParam: 'building_id',
  cols: ['building_name','monitor_number','reading_date','reading_time','kwh_reading'],
  hdrs: ['Building','Monitor #','Date','Time','kWh Reading'],
});

makeReport({
  sidebarId: 'report-run-dwr', panelId: 'rdwr-panel',
  title: 'Run DWR Report', prefix: 'rdwr', selectId: 'rdwr-area',
  optionsUrl: '/api/reports/run-dwr/options',
  reportUrl:  '/api/reports/run-dwr',
  filterParam: 'area',
  cols: ['common_name','state_well_number','reading_date','reading_time','depth_to_water','method','operator'],
  hdrs: ['Well','State Well #','Date','Time','Depth to Water','Method','Operator'],
});

makeReport({
  sidebarId: 'report-dripper-oil', panelId: 'rdo-panel',
  title: 'Dripper Oil Report', prefix: 'rdo', selectId: 'rdo-area',
  optionsUrl: '/api/reports/dripper-oil/areas',
  reportUrl:  '/api/reports/dripper-oil',
  filterParam: 'area',
  cols: ['common_name', 'reading_date', 'reading_time', 'entered_by', 'dripper_oil'],
  hdrs: ['Well', 'Date', 'Time', 'Entered By', 'Dripper Oil (gal)'],
});

makeReport({
  sidebarId: 'report-vehicle-monthly', panelId: 'rvm-panel',
  title: 'Vehicle Monthly Report', prefix: 'rvm', selectId: 'rvm-vehicle',
  optionsUrl: '/api/reports/vehicle-monthly/options',
  reportUrl:  '/api/reports/vehicle-monthly',
  filterParam: 'vehicle_id',
  cols: ['vehicle_number','make','model','reading_date','reading_time','odometer_miles','engine_hours'],
  hdrs: ['Vehicle #','Make','Model','Date','Time','Odometer (mi)','Engine Hours'],
});

makeReport({
  sidebarId: 'report-pond-summary', panelId: 'rpond-panel',
  title: 'Pond Summary', prefix: 'rpond', selectId: 'rpond-location',
  optionsUrl: '/api/reports/pond-summary/options',
  reportUrl:  '/api/reports/pond-summary',
  filterParam: 'location_id',
  cols: ['location_name', 'pond_name', 'reading_date', 'reading_time', 'level_ft', 'entered_by'],
  hdrs: ['Location', 'Pond', 'Date', 'Time', 'Level (ft)', 'Entered By'],
});

// ── Version ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/version');
    if (res.ok) {
      const { version } = await res.json();
      const el = $('app-version');
      if (el) el.textContent = `v${version}`;
    }
  } catch (_) { /* ignore */ }
})();

// ── Init: skip connect overlay if DB already connected ───────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/db-status');
    if (res.ok) {
      const data = await res.json();
      if (data.connected) {
        state.connected = true;
        state.dbUser = data.user;
        state.dbName = data.database;
        connectOverlay.classList.remove('active');
        connectOverlay.classList.add('hidden');
        appEl.classList.remove('hidden');
        loadTables();
      }
    }
  } catch (_) { /* ignore — overlay stays visible */ }
})();
