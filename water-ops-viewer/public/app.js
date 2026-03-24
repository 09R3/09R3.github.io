/* ── Water Ops Viewer Frontend ── */

const API = '';  // same origin

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  connected: false,
  dbLabel: '',
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

// ── Elements ───────────────────────────────────────────────────────────────
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
const dbLabel = $('db-label');
const sqlPanel = $('sql-panel');
const sqlEditor = $('sql-editor');
const sqlResult = $('sql-result');
const sqlStatus = $('sql-status');

// ── Caps Lock warning on DB password field ─────────────────────────────────
const dbPass = $('db-pass');
const dbCapsWarn = $('db-caps-warn');
dbPass.addEventListener('keyup', e => {
  dbCapsWarn.classList.toggle('hidden', !e.getModifierState('CapsLock'));
});
dbPass.addEventListener('blur', () => dbCapsWarn.classList.add('hidden'));

// ── Connect ────────────────────────────────────────────────────────────────
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
    state.dbLabel = `${res.user}@${res.database}`;
    dbLabel.textContent = state.dbLabel;
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

$('disconnect-btn').addEventListener('click', () => {
  state = { ...state, connected: false, currentSchema: null, currentTable: null };
  connectOverlay.classList.remove('hidden');
  connectOverlay.classList.add('active');
  appEl.classList.add('hidden');
  gridContainer.innerHTML = emptyState('Select a table from the sidebar\nor open the SQL Editor');
  filterBar.classList.add('hidden');
  pagination.classList.add('hidden');
  viewTitle.textContent = 'Select a table';
  rowCount.textContent = '';
  tableList.innerHTML = '<div class="loading-tables">Loading tables…</div>';
});

// Sign-out button (logs out of the app entirely)
$('sign-out-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

function setConnecting(on) {
  connectBtn.querySelector('.btn-text').classList.toggle('hidden', on);
  connectBtn.querySelector('.btn-spinner').classList.toggle('hidden', !on);
  connectBtn.disabled = on;
}

function showError(msg) {
  connectError.textContent = msg;
  connectError.classList.toggle('hidden', !msg);
}

// ── Tables ─────────────────────────────────────────────────────────────────
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

// ── Browse Table ───────────────────────────────────────────────────────────
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
        const dateOnly = str.length === 10 ||
          (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
        const label = dateOnly ? d.toLocaleDateString() : d.toLocaleString();
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

// ── Search / Filter ────────────────────────────────────────────────────────
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

// ── Exports (table) ────────────────────────────────────────────────────────
$('export-btn').addEventListener('click', () => {
  if (!state.currentTable) return alert('Select a table first.');
  showExportPreview(
    `${state.currentSchema}.${state.currentTable}`,
    { schema: state.currentSchema, table: state.currentTable }
  );
});

// ── SQL Editor ─────────────────────────────────────────────────────────────
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

// ── Exports (SQL result) ───────────────────────────────────────────────────
$('sql-export-btn').addEventListener('click', () => {
  const sql = sqlEditor.value.trim();
  if (!sql) return alert('Write and run a SQL query first.');
  if (!state.sqlResult) return alert('Run the query first to preview results.');
  showExportPreview('Query Result', { sql }, state.sqlResult);
});

// ── Export Preview ──────────────────────────────────────────────────────────
const previewBackdrop = $('preview-backdrop');
const previewTitle = $('preview-title');
const previewMeta = $('preview-meta');
const previewGrid = $('preview-grid');
const previewDownloadBtns = $('preview-download-btns');

$('preview-close').addEventListener('click', closePreview);
$('preview-cancel').addEventListener('click', closePreview);
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
      // SQL result already in memory
      rows = cachedResult.rows;
      columns = cachedResult.fields.map(f => f.name);
      total = cachedResult.rowCount;
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

// ── Saved Queries ───────────────────────────────────────────────────────────

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

// ── Export Helper ──────────────────────────────────────────────────────────
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

// ── Import ─────────────────────────────────────────────────────────────────

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

    let msg = `✓ Imported ${result.imported} of ${result.total} row${result.total !== 1 ? 's' : ''}.`;
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
    if (result.imported > 0) {
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

// ── Helpers ────────────────────────────────────────────────────────────────
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
  return `<div class="empty-state"><div class="empty-icon">⬡</div><p>${msg}</p></div>`;
}
function errorState(msg) {
  return `<div class="empty-state"><div class="empty-icon" style="color:var(--error)">✕</div><p style="color:var(--error)">${esc(msg)}</p></div>`;
}
function loadingGrid() {
  return '<div class="empty-state"><div class="empty-icon loading-row">⬡</div><p>Loading…</p></div>';
}
