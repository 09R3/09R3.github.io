/* ── State ───────────────────────────────────────────────────────────────── */
let currentUser   = null;
let currentScreen = null;

// Pumping plant state
const pp = {
  sites:       [],
  buildings:   {},     // keyed by site_id
  loadedSites: new Set(),
  activeTab:   null,   // null = All
};
let ppLoaded = false;

// Notes modal state
let notesTarget = null; // { rowEl, notesInput }

// Admin edit state
let editingUserId = null;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function todayISO() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function nowHHMM() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}

function fmt(val, decimals = 1) {
  if (val == null || val === '') return '—';
  return Number(val).toFixed(decimals);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  // Slice to YYYY-MM-DD first — avoids UTC-midnight timezone shift
  // when pg returns DATE as a full ISO string like "2026-03-23T00:00:00.000Z"
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${parseInt(m)}/${parseInt(d)}/${String(y).slice(2)}`;
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showToast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast${type ? ' ' + type : ''}`;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function showError(elId, msg) {
  const e = el(elId);
  e.textContent = msg;
  e.classList.remove('hidden');
}

function clearError(elId) {
  const e = el(elId);
  e.textContent = '';
  e.classList.add('hidden');
}

/* ── List Screen Helpers ─────────────────────────────────────────────────── */
function makeCollapsibleSection(title, items) {
  const section = document.createElement('div');
  section.className = 'list-section collapsed';

  const hdr = document.createElement('div');
  hdr.className = 'list-section-header';
  hdr.innerHTML = `<span>${title} <span style="color:var(--text-muted);font-weight:400">(${items.length})</span></span><span class="section-chevron">&#9660;</span>`;
  hdr.addEventListener('click', () => section.classList.toggle('collapsed'));

  const itemsEl = document.createElement('div');
  itemsEl.className = 'list-section-items';
  items.forEach(item => itemsEl.appendChild(item));

  section.appendChild(hdr);
  section.appendChild(itemsEl);
  return section;
}

// Returns { diff, cfs, elapsedDays } or null if not computable
function totalizerCFS(prevVal, prevDate, prevTime, curVal, curDate, curTime) {
  if (prevVal == null || !prevDate || isNaN(curVal)) return null;
  const prevDT    = new Date(`${String(prevDate).slice(0,10)}T${(prevTime || '00:00').slice(0,5)}:00`);
  const curDT     = new Date(`${String(curDate).slice(0,10)}T${(curTime  || '00:00').slice(0,5)}:00`);
  const elapsedSec = (curDT - prevDT) / 1000;
  if (elapsedSec <= 0) return null;
  const diff       = curVal - Number(prevVal);
  const cfs        = (diff * 43560) / elapsedSec;
  return { diff, cfs, elapsedDays: elapsedSec / 86400 };
}

// Renders the always-visible totalizer info block and wires live CFS calc
function attachTotalizerCalc(inputEl, prevVal, prevDate, prevTime, dateInput, timeInput) {
  const wrap = document.createElement('div');
  wrap.className = 'totalizer-calc-wrap';

  const prevLine = document.createElement('div');
  prevLine.className = 'totalizer-prev';
  prevLine.textContent = prevVal != null
    ? `Prev: ${Number(prevVal).toFixed(2)} AF${prevDate ? '  ·  ' + fmtDate(prevDate) : ''}`
    : 'No previous reading';
  wrap.appendChild(prevLine);

  const calcLine = document.createElement('div');
  calcLine.className = 'totalizer-calc';
  wrap.appendChild(calcLine);

  inputEl.after(wrap);

  function update() {
    const cur = parseFloat(inputEl.value);
    if (isNaN(cur) || prevVal == null) { calcLine.textContent = ''; calcLine.className = 'totalizer-calc'; return; }
    const r = totalizerCFS(prevVal, prevDate, prevTime, cur, dateInput.value, timeInput.value);
    if (!r) { calcLine.textContent = ''; calcLine.className = 'totalizer-calc'; return; }
    const sign = r.diff >= 0 ? '+' : '';
    const days = r.elapsedDays.toFixed(1);
    calcLine.textContent = `Δ ${sign}${r.diff.toFixed(2)} AF  ·  ${Math.abs(r.cfs).toFixed(2)} cfs avg  (${days} days)`;
    calcLine.className = `totalizer-calc${r.diff < 0 ? ' neg' : ''}`;
  }

  inputEl.addEventListener('input', update);
  // Recalculate if operator changes the reading date/time
  dateInput.addEventListener('change', update);
  timeInput.addEventListener('change', update);
}

// Simple prev + Δ display for non-totalizer fields (hours, flow, dripper oil, etc.)
function attachDiffDisplay(inputEl, prevVal, unit, decimals = 1) {
  const wrap = document.createElement('div');
  wrap.className = 'totalizer-calc-wrap';

  const prevLine = document.createElement('div');
  prevLine.className = 'totalizer-prev';
  prevLine.textContent = prevVal != null
    ? `Prev: ${Number(prevVal).toFixed(decimals)}${unit ? ' ' + unit : ''}`
    : 'No previous reading';
  wrap.appendChild(prevLine);

  const calcLine = document.createElement('div');
  calcLine.className = 'totalizer-calc';
  wrap.appendChild(calcLine);

  inputEl.after(wrap);

  inputEl.addEventListener('input', () => {
    const cur = parseFloat(inputEl.value);
    if (isNaN(cur) || prevVal == null) { calcLine.textContent = ''; calcLine.className = 'totalizer-calc'; return; }
    const diff = cur - Number(prevVal);
    const sign = diff >= 0 ? '+' : '';
    calcLine.textContent = `Δ ${sign}${diff.toFixed(decimals)}${unit ? ' ' + unit : ''}`;
    calcLine.className   = `totalizer-calc${diff < 0 ? ' neg' : ''}`;
  });
}

function mapsUrl(lat, lon, label) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS) return `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(label)}`;
  return `https://maps.google.com/maps?q=${lat},${lon}`;
}

/* ── Screen Navigation ───────────────────────────────────────────────────── */
function showScreen(name) {
  document.querySelectorAll('.screen-content').forEach(s => s.classList.remove('active'));
  const target = el(`screen-${name}`);
  if (target) {
    target.classList.add('active');
    currentScreen = name;
  }
  const titles = {
    dashboard:      'Field Ops',
    'pumping-plant':'Pumping Plant Readings',
    wells:          'Well Readings',
    canal:          'Canal Readings',
    vehicles:       'Vehicle Monthly',
    'kf-monthly':   'KF Monthly Readings',
    maintenance:    'Maintenance Log',
    admin:          'Admin',
  };
  el('screen-title').textContent = titles[name] || 'Field Ops';
  closeDrawer();

  // Block admin screen for operators
  if (name === 'admin') {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'supervisor')) {
      showScreen('dashboard');
      return;
    }
  }

  // Lazy-load data on first visit
  if (name === 'dashboard')     loadDashboardStats();
  if (name === 'pumping-plant') initPPScreen();
  if (name === 'wells')         initWellsScreen();
  if (name === 'canal')       initCanalScreen();
  if (name === 'vehicles')    initVehiclesScreen();
  if (name === 'kf-monthly')  initKFScreen();
  if (name === 'maintenance') initMaintenanceScreen();
  if (name === 'admin')       initAdminScreen();
}

/* ── Drawer ──────────────────────────────────────────────────────────────── */
function openDrawer() {
  el('drawer').classList.add('open');
  el('drawer-overlay').classList.add('open');
}
function closeDrawer() {
  el('drawer').classList.remove('open');
  el('drawer-overlay').classList.remove('open');
}

el('menu-toggle').addEventListener('click', () => {
  el('drawer').classList.contains('open') ? closeDrawer() : openDrawer();
});
el('drawer-overlay').addEventListener('click', closeDrawer);

document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.screen));
});
document.querySelectorAll('.dash-tile[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.screen));
});

/* ── Auth ────────────────────────────────────────────────────────────────── */
el('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('login-error');
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  try {
    const { user } = await api('POST', '/auth/login', { username, password });
    onLogin(user);
  } catch (err) {
    showError('login-error', err.message);
  }
});

el('logout-btn').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  onLogout();
});

function onLogin(user) {
  currentUser = user;
  el('screen-login').classList.remove('active');
  el('app-shell').classList.remove('hidden');
  el('user-badge').textContent = user.initials || user.username.slice(0, 2).toUpperCase();
  el('drawer-user').innerHTML = `<strong>${user.full_name || user.username}</strong>${user.role}`;

  // Show admin nav if applicable
  if (user.role === 'admin' || user.role === 'supervisor') {
    el('nav-admin-item').classList.remove('hidden');
    el('dash-admin-tile').classList.remove('hidden');
  }

  showScreen('dashboard');
  loadDashboardStats();
}

/* ── Dashboard Stats ─────────────────────────────────────────────────────── */
async function loadDashboardStats() {
  try {
    const s = await api('GET', '/api/dashboard/stats');
    const grid = el('dashboard-stats');
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${s.kf_total - s.kf_done}</div>
        <div class="stat-label">KF Remaining</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.kf_done} / ${s.kf_total}</div>
        <div class="stat-label">KF Done (month)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.wells_read_today} / ${s.wells_total}</div>
        <div class="stat-label">Wells Read Today</div>
      </div>
    `;
  } catch { /* non-critical */ }
}

function onLogout() {
  currentUser = null;
  el('app-shell').classList.add('hidden');
  el('screen-login').classList.add('active');
  el('login-password').value = '';
  el('login-username').value = '';
  // Reset pumping plant
  pp.sites = []; pp.buildings = {}; pp.loadedSites = new Set(); pp.activeTab = null;
  ppLoaded = false;
  el('pp-site-tabs').innerHTML = '';
  el('pp-form-body').innerHTML = '<div class="placeholder-msg">Loading plants…</div>';
  el('pp-save-bar').classList.add('hidden');
  // Refresh DB status on logout
  checkDBStatus();
}

async function checkAuth() {
  try {
    const { user } = await api('GET', '/auth/me');
    onLogin(user);
  } catch {
    // Not logged in — show login screen (already visible by default)
  }
}

/* ── Notes Modal ─────────────────────────────────────────────────────────── */
el('notes-modal-close').addEventListener('click', closeNotesModal);
el('notes-modal-cancel').addEventListener('click', closeNotesModal);
el('notes-modal-ok').addEventListener('click', () => {
  if (notesTarget) {
    notesTarget.notesInput.value = el('notes-modal-text').value;
    notesTarget = null;
  }
  closeNotesModal();
});

function openNotesModal(label, notesInput) {
  notesTarget = { notesInput };
  el('notes-modal-title').textContent = `Notes — ${label}`;
  el('notes-modal-text').value = notesInput.value;
  el('notes-modal').classList.remove('hidden');
  setTimeout(() => el('notes-modal-text').focus(), 50);
}
function closeNotesModal() {
  el('notes-modal').classList.add('hidden');
  notesTarget = null;
}

/* ── History Modal ───────────────────────────────────────────────────────── */
el('history-modal-close').addEventListener('click', () => el('history-modal').classList.add('hidden'));
el('history-modal').addEventListener('click', e => {
  if (e.target === el('history-modal')) el('history-modal').classList.add('hidden');
});

const HIST_COLS = {
  pump:        [{ key: 'value',         label: 'Hours' }],
  compressor:  [{ key: 'value',         label: 'Hours' }],
  pge:         [{ key: 'value',         label: 'kWh' }],
  monitor:     [{ key: 'value',         label: 'kWh' }],
  well:        [{ key: 'hour_reading',  label: 'Hours' }, { key: 'flow_cfs', label: 'Flow (cfs)' }, { key: 'totalizer', label: 'Totalizer' }],
  kf:          [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }],
  canal:       [{ key: 'flow',          label: 'Flow (cfs)' }, { key: 'totalizer', label: 'Totalizer (AF)' }, { key: 'gate_setting', label: 'Gate' }],
  vehicle:     [{ key: 'odometer_miles',label: 'Odometer' }, { key: 'engine_hours', label: 'Eng. Hrs' }],
};

async function openHistoryModal(type, id, label) {
  const body = el('history-modal-body');
  el('history-modal-title').textContent = `History — ${label}`;
  body.innerHTML = '<div class="placeholder-msg" style="padding:16px">Loading…</div>';
  el('history-modal').classList.remove('hidden');

  try {
    const rows = await api('GET', `/api/history?type=${type}&id=${encodeURIComponent(id)}`);
    if (!rows.length) {
      body.innerHTML = '<div class="placeholder-msg" style="padding:16px">No history found.</div>';
      return;
    }

    const cols = HIST_COLS[type] || [];
    const headCells = cols.map(c => `<th>${c.label}</th>`).join('');
    const bodyRows  = rows.map(r => {
      const d = fmtDate(r.reading_date);
      const t = r.reading_time ? r.reading_time.slice(0, 5) : '';
      const valCells = cols.map(c => `<td>${r[c.key] != null ? r[c.key] : '—'}</td>`).join('');
      return `<tr>
        <td>${d}${t ? `<div class="hist-time">${t}</div>` : ''}</td>
        ${valCells}
        <td class="hist-notes">${r.notes || ''}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <table class="hist-table">
        <thead><tr><th>Date</th>${headCells}<th>Notes</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light);padding:16px">${err.message}</div>`;
  }
}

/* ── Pumping Plant ───────────────────────────────────────────────────────── */
async function initPPScreen() {
  if (ppLoaded) return;
  ppLoaded = true;

  el('pp-date').value = todayISO();
  el('pp-time').value = nowHHMM();

  try {
    pp.sites = await api('GET', '/api/sites');
  } catch (err) {
    el('pp-form-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load plants: ' + err.message, 'error');
    return;
  }

  // Build site tabs
  const tabsEl = el('pp-site-tabs');
  tabsEl.innerHTML = '';
  const makeTab = (label, siteId) => {
    const btn = document.createElement('button');
    btn.className = 'set-tab' + (siteId === null ? ' active' : '');
    btn.textContent = label;
    btn.dataset.siteId = siteId ?? '';
    tabsEl.appendChild(btn);
  };
  makeTab('All', null);
  pp.sites.forEach(s => makeTab(s.site_name.replace('Site', 'Plant'), s.site_id));

  tabsEl.addEventListener('click', async e => {
    const tab = e.target.closest('.set-tab');
    if (!tab) return;
    tabsEl.querySelectorAll('.set-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    pp.activeTab = tab.dataset.siteId || null;
    await renderPPBody();
  });

  await renderPPBody();
}

async function renderPPBody() {
  const body = el('pp-form-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';

  const sitesToShow = pp.activeTab
    ? pp.sites.filter(s => String(s.site_id) === String(pp.activeTab))
    : pp.sites;

  // Load buildings for any uncached sites
  try {
    await Promise.all(sitesToShow.map(async site => {
      if (pp.loadedSites.has(site.site_id)) return;
      pp.loadedSites.add(site.site_id);
      const buildings = await api('GET', `/api/buildings?site_id=${site.site_id}`);
      const withData = await Promise.all(buildings.map(async b => {
        const [pumps, compressors, pgeMeters, powerMonitors] = await Promise.all([
          api('GET', `/api/pump-positions?building_id=${b.building_id}`),
          api('GET', `/api/air-compressors?building_id=${b.building_id}`),
          api('GET', `/api/pge-meters?building_id=${b.building_id}`),
          api('GET', `/api/power-monitors?building_id=${b.building_id}`),
        ]);
        return { ...b, pumps, compressors, pgeMeters, powerMonitors };
      }));
      withData.sort((a, b) => (a.building_letter || '').localeCompare(b.building_letter || ''));
      pp.buildings[site.site_id] = withData;
    }));
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">Error: ${err.message}</div>`;
    showToast('Failed to load buildings: ' + err.message, 'error');
    return;
  }

  body.innerHTML = '';

  sitesToShow.forEach(site => {
    const buildings = pp.buildings[site.site_id] || [];

    // Site header divider when showing all plants
    if (!pp.activeTab && pp.sites.length > 1) {
      const hdr = document.createElement('div');
      hdr.className = 'pp-site-header';
      hdr.textContent = site.site_name.replace('Site', 'Plant');
      body.appendChild(hdr);
    }

    buildings.forEach(building => {
      const items = buildBuildingRows(building);
      if (!items.length) return;
      body.appendChild(makeCollapsibleSection(
        building.building_name || (building.building_letter + ' Plant'),
        items
      ));
    });
  });

  if (!body.children.length) {
    body.innerHTML = '<div class="placeholder-msg">No readings found.</div>';
    return;
  }

  el('pp-save-bar').classList.remove('hidden');
}

function buildBuildingRows(building) {
  const rows = [];
  building.pumps.forEach(pump => {
    rows.push(createReadingRow({
      type: 'pump', id: pump.position_id,
      label: `${pump.pump_letter} Pump Hours`,
      prev: pump.last_reading, prevDate: pump.last_reading_date,
      prevNotes: pump.last_notes, unit: 'hrs',
    }));
  });
  building.compressors.forEach(comp => {
    rows.push(createReadingRow({
      type: 'compressor', id: comp.compressor_id,
      label: comp.manufacturer ? `Air Compressor (${comp.manufacturer})` : 'Air Compressor Hours',
      prev: comp.last_reading, prevDate: comp.last_reading_date,
      prevNotes: comp.last_notes, unit: 'hrs',
    }));
  });
  building.pgeMeters.forEach(m => {
    rows.push(createReadingRow({
      type: 'pge', id: m.pge_meter_id,
      label: m.meter_name || `PG&E kWh (${m.meter_number || m.pge_meter_id})`,
      prev: m.last_reading, prevDate: m.last_reading_date,
      prevNotes: m.last_notes, unit: 'kWh', decimals: 0,
    }));
  });
  building.powerMonitors.forEach(m => {
    rows.push(createReadingRow({
      type: 'monitor', id: m.monitor_id,
      label: m.monitor_number ? `Power Monitor kWh (${m.monitor_number})` : 'Power Monitor kWh',
      prev: m.last_reading, prevDate: m.last_reading_date,
      prevNotes: m.last_notes, unit: 'kWh', decimals: 0,
    }));
  });
  return rows;
}

function createReadingRow({ type, id, label, prev, prevDate, prevNotes, unit, decimals = 1 }) {
  const row = document.createElement('div');
  row.className = 'reading-row';
  row.dataset.type = type;
  row.dataset.id   = id;

  const prevVal  = prev != null ? Number(prev) : null;
  const prevDisp = prevVal != null ? Number(prevVal).toFixed(decimals) : '—';
  const dateDisp = prevDate ? fmtDate(prevDate) : '';

  row.innerHTML = `
    <div class="rr-label" title="${label}">
      ${label}${dateDisp ? `<div class="prev-date">${dateDisp}</div>` : ''}
    </div>
    <div class="rr-field-group rr-cur-wrap">
      <span class="rr-col-hd">Current</span>
      <input type="number" class="rr-input current rr-current" step="0.1" inputmode="decimal" placeholder="—">
    </div>
    <div class="rr-field-group rr-diff-wrap">
      <span class="rr-col-hd">Diff</span>
      <input type="text" class="rr-input calc rr-diff" readonly placeholder="—">
    </div>
    <div class="rr-field-group rr-prev-wrap">
      <span class="rr-col-hd">Prev</span>
      <input type="text" class="rr-input prev rr-prev" readonly value="${prevDisp}">
    </div>
    <div class="rr-notes-wrap">
      <input type="text" class="rr-notes-input rr-notes" placeholder="Notes…">
      <button class="notes-plus-btn" title="Expand notes">+</button>
      <button class="hist-btn" title="View history">&#128200;</button>
    </div>
  `;

  // Auto-calculate difference
  const currentInput = row.querySelector('.rr-current');
  const diffInput    = row.querySelector('.rr-diff');

  currentInput.addEventListener('input', () => {
    const cur = parseFloat(currentInput.value);
    if (!isNaN(cur) && prevVal != null) {
      const diff = cur - prevVal;
      diffInput.value = (diff >= 0 ? '+' : '') + diff.toFixed(decimals);
      diffInput.classList.toggle('neg', diff < 0);
    } else {
      diffInput.value = '';
      diffInput.classList.remove('neg');
    }
  });

  // Notes + button
  const notesInput = row.querySelector('.rr-notes');
  if (prevNotes) notesInput.value = prevNotes;
  row.querySelector('.notes-plus-btn').addEventListener('click', () => {
    openNotesModal(label, notesInput);
  });
  row.querySelector('.hist-btn').addEventListener('click', () => {
    openHistoryModal(type, id, label);
  });

  return row;
}

el('pp-save-btn').addEventListener('click', savePPReadings);

async function savePPReadings() {
  const readingDate = el('pp-date').value;
  const readingTime = el('pp-time').value;

  if (!readingDate || !readingTime) {
    showToast('Date and time are required', 'error');
    return;
  }

  const pump_readings       = [];
  const compressor_readings = [];
  const pge_readings        = [];
  const monitor_readings    = [];

  document.querySelectorAll('.reading-row').forEach(row => {
    const cur = row.querySelector('.rr-current').value.trim();
    if (cur === '') return; // skip empty

    const notes = row.querySelector('.rr-notes').value.trim();
    const type  = row.dataset.type;
    const id    = row.dataset.id;

    if (type === 'pump')       pump_readings.push({ position_id: id, hour_reading: parseFloat(cur), notes });
    if (type === 'compressor') compressor_readings.push({ compressor_id: parseInt(id), hour_reading: parseFloat(cur), notes });
    if (type === 'pge')        pge_readings.push({ pge_meter_id: parseInt(id), kwh_reading: parseFloat(cur), notes });
    if (type === 'monitor')    monitor_readings.push({ monitor_id: parseInt(id), kwh_reading: parseFloat(cur), notes });
  });

  const total = pump_readings.length + compressor_readings.length +
                pge_readings.length + monitor_readings.length;
  if (total === 0) {
    showToast('No readings entered', 'error');
    return;
  }

  const saveBtn = el('pp-save-btn');
  const status  = el('pp-save-status');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  status.textContent = '';
  status.className = 'save-status';

  try {
    const result = await api('POST', '/api/readings/pumping-plant', {
      reading_date: readingDate,
      reading_time: readingTime,
      pump_readings, compressor_readings, pge_readings, monitor_readings,
    });

    // Mark saved rows green
    const savedPumps    = new Set(result.saved.pump.map(r => r.position_id));
    const savedComps    = new Set(result.saved.compressor.map(r => String(r.compressor_id)));
    const savedPge      = new Set(result.saved.pge.map(r => String(r.pge_meter_id)));
    const savedMonitors = new Set(result.saved.monitor.map(r => String(r.monitor_id)));

    document.querySelectorAll('.reading-row').forEach(row => {
      const type = row.dataset.type;
      const id   = row.dataset.id;
      const shouldMark =
        (type === 'pump'       && savedPumps.has(id)) ||
        (type === 'compressor' && savedComps.has(id)) ||
        (type === 'pge'        && savedPge.has(id)) ||
        (type === 'monitor'    && savedMonitors.has(id));

      if (shouldMark) row.classList.add('saved');
    });

    const count = result.saved.pump.length + result.saved.compressor.length +
                  result.saved.pge.length + result.saved.monitor.length;
    status.textContent = `✓ ${count} reading${count !== 1 ? 's' : ''} saved`;
    status.className = 'save-status success';
    showToast(`Saved ${count} reading${count !== 1 ? 's' : ''}`, 'success');
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'save-status error';
    showToast('Save failed: ' + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Readings';
  }
}

/* ── Wells ───────────────────────────────────────────────────────────────── */
let wellsLoaded = false;

async function initWellsScreen() {
  if (wellsLoaded) return;
  wellsLoaded = true;

  const dateInput = el('well-date');
  const timeInput = el('well-time');
  dateInput.value = todayISO();
  timeInput.value = nowHHMM();

  const body = el('well-list-body');
  body.innerHTML = '<div class="placeholder-msg">Loading wells…</div>';

  try {
    const wells = await api('GET', '/api/wells/operational');
    if (!wells.length) {
      body.innerHTML = '<div class="placeholder-msg">No operational wells found.</div>';
      return;
    }

    // Group by area
    const byArea = {};
    wells.forEach(w => {
      const area = w.area || 'Other';
      if (!byArea[area]) byArea[area] = [];
      byArea[area].push(w);
    });

    body.innerHTML = '';
    Object.entries(byArea).forEach(([area, areaWells]) => {
      const items = areaWells.map(w => createWellItem(w, dateInput, timeInput));
      body.appendChild(makeCollapsibleSection(area, items));
    });
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load wells: ' + err.message, 'error');
  }
}

function createWellItem(w, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const hrs = w.hours_since_reading;
  const sc = hrs == null ? 'due' : hrs <= 8 ? 'done' : 'overdue';
  const badge = hrs == null ? 'Not read' : hrs < 1 ? 'Just read' : `${Math.round(hrs)}h ago`;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name">${w.common_name}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-form">
      <div class="lif-row">
        <div class="toggle-group">
          <button class="toggle-btn active" data-role="on">ON</button>
          <button class="toggle-btn" data-role="off">OFF</button>
        </div>
        <div class="toggle-group">
          <span class="lif-label">Motor Oil</span>
          <button class="toggle-btn active" data-role="oil-y">Y</button>
          <button class="toggle-btn" data-role="oil-n">N</button>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label>Hours</label>
          <input type="number" class="ctrl-input w-hours" step="0.1" inputmode="decimal" placeholder="0.0">
        </div>
        <div class="form-group">
          <label>Flow (cfs)</label>
          <input type="number" class="ctrl-input w-flow" step="0.01" inputmode="decimal" placeholder="0.00">
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label>Totalizer (AF)</label>
          <input type="number" class="ctrl-input w-totalizer" step="1" inputmode="decimal" placeholder="0">
        </div>
        <div class="form-group">
          <label>Dripper Oil</label>
          <input type="number" class="ctrl-input w-dripperoil" step="0.01" inputmode="decimal" placeholder="0.00">
        </div>
      </div>
      <div class="form-group">
        <label>PG&amp;E kWh</label>
        <input type="number" class="ctrl-input w-pge" step="1" inputmode="decimal" placeholder="0">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="ctrl-textarea w-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm w-hist-btn">&#128200; History</button>
        <button class="btn btn-save w-save-btn">Save Well Reading</button>
      </div>
    </div>`;

  if (w.last_notes) div.querySelector('.w-notes').value = w.last_notes;
  div.querySelector('.w-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('well', w.well_id, w.common_name);
  });

  // Hours, Flow, Dripper Oil: prev + live Δ
  attachDiffDisplay(div.querySelector('.w-hours'),     w.last_hour_reading, 'hrs', 1);
  attachDiffDisplay(div.querySelector('.w-flow'),      w.last_flow_cfs,     'cfs', 2);
  attachDiffDisplay(div.querySelector('.w-dripperoil'),w.last_dripper_oil,  '',    2);

  // Totalizer: always show previous + live CFS calc
  attachTotalizerCalc(
    div.querySelector('.w-totalizer'),
    w.last_totalizer, w.last_reading_date, w.last_reading_time,
    dateInput, timeInput
  );

  let onOff = true, motorOil = true;

  div.querySelector('[data-role="on"]').addEventListener('click', e => {
    onOff = true;
    e.currentTarget.classList.add('active');
    div.querySelector('[data-role="off"]').classList.remove('active');
  });
  div.querySelector('[data-role="off"]').addEventListener('click', e => {
    onOff = false;
    e.currentTarget.classList.add('active');
    div.querySelector('[data-role="on"]').classList.remove('active');
  });
  div.querySelector('[data-role="oil-y"]').addEventListener('click', e => {
    motorOil = true;
    e.currentTarget.classList.add('active');
    div.querySelector('[data-role="oil-n"]').classList.remove('active');
  });
  div.querySelector('[data-role="oil-n"]').addEventListener('click', e => {
    motorOil = false;
    e.currentTarget.classList.add('active');
    div.querySelector('[data-role="oil-y"]').classList.remove('active');
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
  });

  div.querySelector('.w-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const body = {
      well_id:      w.well_id,
      reading_date: dateInput.value,
      reading_time: timeInput.value,
      on_off:       onOff,
      hour_reading: div.querySelector('.w-hours').value || null,
      flow_cfs:     div.querySelector('.w-flow').value || null,
      totalizer:    div.querySelector('.w-totalizer').value || null,
      motor_oil:    motorOil,
      dripper_oil:  div.querySelector('.w-dripperoil').value || null,
      pge_kwh:      div.querySelector('.w-pge').value || null,
      notes:        div.querySelector('.w-notes').value || null,
    };
    try {
      await api('POST', '/api/readings/well', body);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = 'Just saved';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      showToast(`${w.common_name} saved`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Start collapsed
  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Canal ───────────────────────────────────────────────────────────────── */
let canalLoaded = false;

// Which fields each structure type uses
const CANAL_FIELDS = {
  metered_turnout:    { flow: true,  totalizer: true,  gate: true,  head: false, derived: false },
  head_gate:          { flow: true,  totalizer: false, gate: true,  head: false, derived: false },
  sharp_crested_weir: { flow: true,  totalizer: false, gate: false, head: true,  headLabel: 'Overpour (ft)', derived: false },
};
const CANAL_TYPE_LABELS = {
  metered_turnout:    'Metered Turnout',
  head_gate:          'Head Gate',
  sharp_crested_weir: 'Sharp Crested Weir',
};

function canalFields(type) {
  return CANAL_FIELDS[(type || '').toLowerCase()]
    || { flow: true, totalizer: true, gate: true, head: true, headLabel: 'Head (ft)', derived: true };
}

async function initCanalScreen() {
  if (canalLoaded) return;
  canalLoaded = true;

  const dateInput = el('canal-date');
  const timeInput = el('canal-time');
  dateInput.value = todayISO();
  timeInput.value = nowHHMM();

  const body = el('canal-list-body');
  body.innerHTML = '<div class="placeholder-msg">Loading structures…</div>';

  try {
    const structures = await api('GET', '/api/canal-structures');
    if (!structures.length) {
      body.innerHTML = '<div class="placeholder-msg">No active canal structures found.</div>';
      return;
    }

    // Inflow: direction is inflow, both, or null
    // Outflow: direction is outflow or both
    const inflow  = structures.filter(s => !s.flow_direction || ['inflow','both'].includes(s.flow_direction));
    const outflow = structures.filter(s => ['outflow','both'].includes(s.flow_direction));

    body.innerHTML = '';
    if (inflow.length)  body.appendChild(makeCollapsibleSection('Inflow',  inflow.map(s  => createCanalItem(s,  dateInput, timeInput))));
    if (outflow.length) body.appendChild(makeCollapsibleSection('Outflow', outflow.map(s => createCanalItem(s, dateInput, timeInput))));
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load structures: ' + err.message, 'error');
  }
}

function createCanalItem(s, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const f        = canalFields(s.structure_type);
  const typeDisp = CANAL_TYPE_LABELS[(s.structure_type || '').toLowerCase()] || s.structure_type || null;
  const prevFlow = s.last_flow != null ? `${Number(s.last_flow).toFixed(2)} cfs` : null;
  const prevDate = s.last_reading_date ? fmtDate(s.last_reading_date) : null;

  function prevHint(val, unit = '', decimals = 2) {
    if (val == null) return '';
    return `<span class="prev-hint"> · Prev: ${Number(val).toFixed(decimals)}${unit ? ' ' + unit : ''}</span>`;
  }

  div.innerHTML = `
    <div class="list-item-header">
      <span class="list-item-name">${s.structure_name}</span>
      ${prevFlow ? `<span class="status-badge due">${prevFlow}${prevDate ? ' · ' + prevDate : ''}</span>` : ''}
      <span class="expand-chevron">&#9660;</span>
    </div>
    ${typeDisp ? `<div class="list-item-meta"><span>${typeDisp}</span></div>` : ''}
    <div class="list-item-form">
      ${f.flow ? `<div class="form-group"><label>Flow (cfs)${prevHint(s.last_flow, 'cfs')}</label>
        <input type="number" class="ctrl-input c-flow" step="0.01" inputmode="decimal" placeholder="0.00"></div>` : ''}
      ${f.totalizer ? `<div class="form-group"><label>Totalizer (AF)${prevHint(s.last_totalizer, 'AF')}</label>
        <input type="number" class="ctrl-input c-totalizer" step="0.01" inputmode="decimal" placeholder="0.00"></div>` : ''}
      ${f.gate ? `<div class="form-group"><label>Gate Setting${s.last_gate != null ? `<span class="prev-hint"> · Prev: ${s.last_gate}</span>` : ''}</label>
        <input type="text" class="ctrl-input c-gate" placeholder="e.g. 2.5"></div>` : ''}
      ${f.head ? `<div class="form-group"><label>${f.headLabel || 'Head (ft)'}${prevHint(s.last_head, 'ft')}</label>
        <input type="number" class="ctrl-input c-head" step="0.01" inputmode="decimal" placeholder="0.00"></div>` : ''}
      ${f.derived ? `<div class="form-group"><label>Derived Flow (cfs)${prevHint(s.last_derived, 'cfs')}</label>
        <input type="number" class="ctrl-input c-derived" step="0.01" inputmode="decimal" placeholder="0.00"></div>` : ''}
      <div class="form-group"><label>Notes</label>
        <textarea class="ctrl-textarea c-notes" rows="2" placeholder="Optional notes…"></textarea></div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm c-hist-btn">&#128200; History</button>
        <button class="btn btn-save c-save-btn">Save Reading</button>
      </div>
    </div>`;

  if (s.last_notes) div.querySelector('.c-notes').value = s.last_notes;

  // Totalizer: always show previous + live CFS calc
  const cTotInput = div.querySelector('.c-totalizer');
  if (cTotInput) {
    attachTotalizerCalc(
      cTotInput,
      s.last_totalizer, s.last_reading_date, s.last_reading_time,
      dateInput, timeInput
    );
  }

  div.querySelector('.c-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('canal', s.structure_id, s.structure_name);
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
  });

  div.querySelector('.c-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');

    const payload = {
      structure_id:           s.structure_id,
      reading_date:           dateInput.value,
      reading_time:           timeInput.value,
      instantaneous_flow_cfs: div.querySelector('.c-flow')?.value       || null,
      totalizer_reading_af:   div.querySelector('.c-totalizer')?.value   || null,
      gate_setting:           div.querySelector('.c-gate')?.value        || null,
      head_reading_ft:        div.querySelector('.c-head')?.value        || null,
      derived_flow_cfs:       div.querySelector('.c-derived')?.value     || null,
      notes:                  div.querySelector('.c-notes').value        || null,
    };

    try {
      await api('POST', '/api/readings/canal', payload);
      // Update badge with new flow
      const newFlow = payload.instantaneous_flow_cfs;
      const badge   = div.querySelector('.status-badge');
      if (newFlow) {
        const fl = `${Number(newFlow).toFixed(2)} cfs`;
        if (badge) { badge.textContent = fl + ' · now'; badge.className = 'status-badge done'; }
        else {
          const b = document.createElement('span');
          b.className = 'status-badge done';
          b.textContent = fl + ' · now';
          div.querySelector('.list-item-header').insertBefore(b, div.querySelector('.expand-chevron'));
        }
      }
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      showToast(`${s.structure_name} saved`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Vehicles ────────────────────────────────────────────────────────────── */
let vehiclesLoaded = false;

const VTYPE_ORDER  = ['truck', 'heavy_equipment', 'other'];
const VTYPE_LABELS = { truck: 'Trucks', heavy_equipment: 'Heavy Equipment', other: 'Other' };

async function initVehiclesScreen() {
  if (vehiclesLoaded) return;
  vehiclesLoaded = true;

  const dateInput = el('vehicle-date');
  const timeInput = el('vehicle-time');
  dateInput.value = todayISO();
  timeInput.value = nowHHMM();

  const body = el('vehicle-list-body');
  body.innerHTML = '<div class="placeholder-msg">Loading vehicles…</div>';

  try {
    const vehicles = await api('GET', '/api/vehicles');
    if (!vehicles.length) {
      body.innerHTML = '<div class="placeholder-msg">No vehicles found.</div>';
      return;
    }

    const byType = {};
    vehicles.forEach(v => {
      const t = (v.vehicle_type || 'other').toLowerCase();
      if (t === 'trailer') return; // trailers are maintenance-only
      if (!byType[t]) byType[t] = [];
      byType[t].push(v);
    });

    body.innerHTML = '';
    [...new Set([...VTYPE_ORDER, ...Object.keys(byType)])].forEach(type => {
      if (!byType[type] || !byType[type].length) return;
      const label = VTYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const items = byType[type].map(v => createVehicleItem(v, dateInput, timeInput));
      body.appendChild(makeCollapsibleSection(label, items));
    });
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load vehicles: ' + err.message, 'error');
  }
}

function createVehicleItem(v, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const parts = [v.vehicle_number];
  if (v.year || v.model) parts.push([v.year, v.model].filter(Boolean).join(' '));
  if (v.assigned_user) parts.push(v.assigned_user);
  const label = parts.filter(Boolean).join(' - ');
  const lastOdo = v.last_odometer != null ? `${Number(v.last_odometer).toLocaleString()} mi` : null;
  const lastHrs = v.last_engine_hours != null ? `${Number(v.last_engine_hours).toFixed(1)} hrs` : null;
  const prevText = [lastOdo, lastHrs].filter(Boolean).join(' / ');

  div.innerHTML = `
    <div class="list-item-header">
      <span class="list-item-name">${label}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-meta">
      ${prevText ? `<span>Prev: ${prevText}</span>` : ''}
      ${v.vin ? `<span>VIN: …${v.vin.slice(-6)}</span>` : ''}
      ${v.license_plate ? `<span>Plate: ${v.license_plate}</span>` : ''}
    </div>
    <div class="list-item-form">
      <div class="two-col">
        <div class="form-group">
          <label>Odometer (mi)${lastOdo ? `<span class="prev-hint"> · Prev: ${lastOdo}</span>` : ''}</label>
          <input type="number" class="ctrl-input v-odo" step="1" inputmode="numeric" placeholder="0">
        </div>
        <div class="form-group">
          <label>Engine Hours${lastHrs ? `<span class="prev-hint"> · Prev: ${lastHrs}</span>` : ''}</label>
          <input type="number" class="ctrl-input v-hrs" step="0.1" inputmode="decimal" placeholder="0.0">
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="ctrl-textarea v-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm v-hist-btn">&#128200; History</button>
        <button class="btn btn-save v-save-btn">Save Reading</button>
      </div>
    </div>`;

  if (v.last_notes) div.querySelector('.v-notes').value = v.last_notes;
  div.querySelector('.v-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('vehicle', v.vehicle_id, label);
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
  });

  div.querySelector('.v-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const body = {
      vehicle_id:     v.vehicle_id,
      vehicle_number: v.vehicle_number,
      reading_date:   dateInput.value,
      reading_time:   timeInput.value,
      odometer_miles: div.querySelector('.v-odo').value || null,
      engine_hours:   div.querySelector('.v-hrs').value || null,
      notes:          div.querySelector('.v-notes').value || null,
    };
    try {
      await api('POST', '/api/readings/vehicle-monthly', body);
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      // Update meta preview
      const odoVal  = body.odometer_miles ? `${Number(body.odometer_miles).toLocaleString()} mi` : lastOdo;
      const hrsVal  = body.engine_hours   ? `${Number(body.engine_hours).toFixed(1)} hrs`       : lastHrs;
      const newPrev = [odoVal, hrsVal].filter(Boolean).join(' / ');
      const meta = div.querySelector('.list-item-meta span');
      if (meta && newPrev) meta.textContent = `Prev: ${newPrev}`;
      showToast(`${label} saved`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Maintenance ─────────────────────────────────────────────────────────── */
let maintLoaded   = false;
let maintType     = 'equipment';
let maintContractor = false;

async function initMaintenanceScreen() {
  if (maintLoaded) return;
  maintLoaded = true;
  el('maint-date').value = todayISO();

  // Load vehicles for maintenance dropdown
  try {
    const vehicles = await api('GET', '/api/vehicles');
    const sel = el('maint-vehicle-select');
    sel.innerHTML = '<option value="">Select vehicle…</option>';
    vehicles.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.vehicle_id;
      opt.textContent = `${v.vehicle_number} — ${v.make || ''} ${v.model || ''}`.trim();
      sel.appendChild(opt);
    });
  } catch { /* non-critical */ }

  // Load sites for building maintenance
  try {
    const sites = await api('GET', '/api/sites');
    const sel = el('maint-site-select');
    sel.innerHTML = '<option value="">Select site…</option>';
    sites.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.site_id;
      opt.textContent = s.site_name;
      sel.appendChild(opt);
    });
  } catch { /* non-critical */ }

  // Load equipment for the equipment dropdown (default: pump)
  await loadMaintEquipment(el('maint-equip-type').value);
}

async function loadMaintEquipment(type) {
  const sel = el('maint-equip-select');
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const list = await api('GET', `/api/equipment/${type}`);
    sel.innerHTML = '<option value="">Select equipment…</option>';
    list.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      sel.appendChild(opt);
    });
  } catch {
    sel.innerHTML = '<option value="">Select equipment…</option>';
  }
}

el('maint-equip-type').addEventListener('change', () => {
  loadMaintEquipment(el('maint-equip-type').value);
});

// Maintenance type segmented control
document.querySelectorAll('#maint-type-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#maint-type-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    maintType = btn.dataset.val;
    el('maint-equipment-fields').classList.toggle('hidden', maintType !== 'equipment');
    el('maint-vehicle-fields').classList.toggle('hidden', maintType !== 'vehicle');
    el('maint-building-fields').classList.toggle('hidden', maintType !== 'building');
  });
});

// Show/hide resolution notes based on status selection
el('maint-status').addEventListener('change', () => {
  const showResolution = ['resolved', 'closed'].includes(el('maint-status').value);
  el('maint-resolution-group').style.display = showResolution ? '' : 'none';
});

// Contractor toggle
el('maint-contractor-yes').addEventListener('click', () => {
  maintContractor = true;
  el('maint-contractor-yes').classList.add('active');
  el('maint-contractor-no').classList.remove('active');
});
el('maint-contractor-no').addEventListener('click', () => {
  maintContractor = false;
  el('maint-contractor-no').classList.add('active');
  el('maint-contractor-yes').classList.remove('active');
});

// Load buildings when site changes in maintenance form
el('maint-site-select').addEventListener('change', async () => {
  const siteId = el('maint-site-select').value;
  const buildingSel = el('maint-building-select');
  buildingSel.innerHTML = '<option value="">Select building…</option>';
  buildingSel.disabled = !siteId;
  if (!siteId) return;
  try {
    const buildings = await api('GET', `/api/buildings?site_id=${siteId}`);
    buildings.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.building_id;
      opt.textContent = b.building_name || b.building_letter;
      buildingSel.appendChild(opt);
    });
  } catch { /* non-critical */ }
});

el('maint-save-btn').addEventListener('click', async () => {
  clearError('maint-error');
  const common = {
    work_date:        el('maint-date').value,
    work_type:        el('maint-work-type').value,
    performed_by:     el('maint-performed-by').value,
    is_contractor:    maintContractor,
    description:      el('maint-description').value,
    parts_used:       el('maint-parts').value || null,
    cost:             el('maint-cost').value || null,
    po_number:        el('maint-po').value || null,
    next_service_date:el('maint-next-service').value || null,
    notes:            el('maint-notes').value || null,
  };

  try {
    if (maintType === 'equipment') {
      await api('POST', '/api/maintenance/equipment', {
        ...common,
        equipment_type:    el('maint-equip-type').value,
        equipment_id:      parseInt(el('maint-equip-select').value) || null,
        location_at_time:  el('maint-equip-loc').value || null,
        hours_at_service:  el('maint-equip-hours').value || null,
      });
    } else if (maintType === 'vehicle') {
      const vehicleId = el('maint-vehicle-select').value;
      if (!vehicleId) return showError('maint-error', 'Please select a vehicle');
      await api('POST', '/api/maintenance/vehicle', {
        ...common,
        vehicle_id:               parseInt(vehicleId),
        odometer_at_service:      el('maint-vehicle-odometer').value || null,
        engine_hours_at_service:  el('maint-vehicle-hours').value || null,
      });
    } else {
      const buildingId = el('maint-building-select').value;
      if (!buildingId) return showError('maint-error', 'Please select a building');
      await api('POST', '/api/maintenance/building', {
        ...common,
        building_id:      parseInt(buildingId),
        record_type:      el('maint-building-record-type').value,
        severity:         el('maint-severity').value || null,
        status:           el('maint-status').value || null,
        resolution_notes: el('maint-resolution-notes').value || null,
      });
    }
    showToast('Maintenance record saved', 'success');
    // Clear key fields
    el('maint-description').value = '';
    el('maint-parts').value = '';
    el('maint-cost').value  = '';
    el('maint-po').value    = '';
    el('maint-notes').value = '';
    el('maint-resolution-notes').value = '';
    el('maint-performed-by').value = '';
  } catch (err) {
    showError('maint-error', err.message);
  }
});

/* ── KF Monthly ─────────────────────────────────────────────────────────── */
let kfLoaded   = false;
let kfAllWells = [];
let kfSets     = [];
let kfActiveSet = null;

async function initKFScreen() {
  if (kfLoaded) return;
  kfLoaded = true;

  el('kf-date').value = todayISO();
  el('kf-time').value = nowHHMM();

  try {
    [kfSets, kfAllWells] = await Promise.all([
      api('GET', '/api/well-sets'),
      api('GET', '/api/wells/kf'),
    ]);
  } catch (err) {
    el('kf-list-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load KF data: ' + err.message, 'error');
    return;
  }

  // Build set tabs
  const tabsEl = el('kf-set-tabs');
  tabsEl.innerHTML = '';
  const makeTab = (label, setId) => {
    const btn = document.createElement('button');
    btn.className = 'set-tab' + (setId === null ? ' active' : '');
    btn.textContent = label;
    btn.dataset.setId = setId ?? '';
    tabsEl.appendChild(btn);
  };
  makeTab('All', null);
  kfSets.forEach(s => makeTab(s.set_name || `Set ${s.set_id}`, s.set_id));

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.set-tab');
    if (!tab) return;
    tabsEl.querySelectorAll('.set-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    kfActiveSet = tab.dataset.setId || null;
    renderKFList();
  });

  renderKFList();
}

function renderKFList() {
  const body    = el('kf-list-body');
  const dateIn  = el('kf-date');
  const timeIn  = el('kf-time');
  const filtered = kfActiveSet
    ? kfAllWells.filter(w => String(w.kf_set_id) === String(kfActiveSet))
    : kfAllWells;

  if (!filtered.length) {
    body.innerHTML = '<div class="placeholder-msg">No wells in this set.</div>';
    return;
  }

  body.innerHTML = '';

  if (!kfActiveSet) {
    // Group by set with collapsible sections
    const bySets = {};
    filtered.forEach(w => {
      const key = w.set_name || 'No Set';
      if (!bySets[key]) bySets[key] = [];
      bySets[key].push(w);
    });
    Object.entries(bySets).forEach(([setName, wells]) => {
      const items = wells.map(w => createKFItem(w, dateIn, timeIn));
      body.appendChild(makeCollapsibleSection(setName, items));
    });
  } else {
    filtered.forEach(w => body.appendChild(createKFItem(w, dateIn, timeIn)));
  }
}

function createKFItem(w, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const days = w.days_since_reading;
  const sc   = days == null ? 'due' : days <= 25 ? 'done' : 'overdue';
  const badge = days == null ? 'Never' : days === 0 ? 'Today' : `${days}d ago`;
  const prevDTW    = w.last_dtw    != null ? `${Number(w.last_dtw).toFixed(2)} ft` : null;
  const prevMethod = w.last_method != null ? w.last_method.charAt(0).toUpperCase() + w.last_method.slice(1) : null;
  const prevMeta   = [prevDTW, prevMethod].filter(Boolean).join(' · ');
  const hasGPS     = w.gps_latitude && w.gps_longitude;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name${w.is_important ? ' well-important' : ''}">${w.common_name}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    ${prevMeta ? `<div class="list-item-meta"><span>Prev: ${prevMeta}</span></div>` : ''}
    <div class="list-item-form">
      <div class="form-group">
        <label>Depth to Water (ft)${prevDTW ? `<span class="prev-hint"> · Prev: ${prevDTW}</span>` : ''}</label>
        <input type="number" class="ctrl-input kf-dtw" step="0.01" inputmode="decimal" placeholder="0.00">
      </div>
      <div class="form-group toggle-row">
        <label>Status</label>
        <div class="toggle-group">
          <button class="toggle-btn active kf-on">ON</button>
          <button class="toggle-btn kf-off">OFF</button>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label>Method</label>
          <select class="ctrl-select kf-method">
            <option value="">Select…</option>
            <option value="plopper">Plopper</option>
            <option value="sounder">Sounder</option>
            <option value="tape">Tape</option>
            <option value="transducer">Transducer</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label>Operator</label>
          <input type="text" class="ctrl-input kf-op" placeholder="Initials">
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="ctrl-textarea kf-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${hasGPS ? `<button class="btn btn-secondary btn-sm kf-map-btn">&#128205; Map</button>` : ''}
        <button class="btn btn-secondary btn-sm kf-hist-btn">&#128200; History</button>
        <button class="btn btn-save kf-save">Save Reading</button>
      </div>
    </div>`;

  // Auto-fill operator and pre-populate last notes
  if (currentUser) {
    div.querySelector('.kf-op').value = currentUser.initials || currentUser.username;
  }
  if (w.last_notes) div.querySelector('.kf-notes').value = w.last_notes;

  // Map button
  const mapBtn = div.querySelector('.kf-map-btn');
  if (mapBtn) {
    mapBtn.addEventListener('click', e => {
      e.stopPropagation();
      window.open(mapsUrl(w.gps_latitude, w.gps_longitude, w.common_name), '_blank');
    });
  }

  div.querySelector('.kf-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('kf', w.well_id, w.common_name);
  });

  let kfOnOff = true;
  div.querySelector('.kf-on').addEventListener('click', e => {
    kfOnOff = true;
    e.currentTarget.classList.add('active');
    div.querySelector('.kf-off').classList.remove('active');
  });
  div.querySelector('.kf-off').addEventListener('click', e => {
    kfOnOff = false;
    e.currentTarget.classList.add('active');
    div.querySelector('.kf-on').classList.remove('active');
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
  });

  div.querySelector('.kf-save').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const dtw = div.querySelector('.kf-dtw').value;
    if (!dtw) { errEl.textContent = 'Depth to water is required'; errEl.classList.remove('hidden'); return; }

    const body = {
      well_id:         w.well_id,
      reading_date:    dateInput.value,
      reading_time:    timeInput.value,
      dtw_reading:     parseFloat(dtw),
      well_on_off:     kfOnOff,
      plopper_sounder: div.querySelector('.kf-method').value || null,
      operator:        div.querySelector('.kf-op').value || null,
      notes:           div.querySelector('.kf-notes').value || null,
    };
    try {
      await api('POST', '/api/readings/kf-monthly', body);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = 'Today';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      // Update prev meta
      const method = div.querySelector('.kf-method').value;
      const newPrev = [
        `${Number(dtw).toFixed(2)} ft`,
        method ? method.charAt(0).toUpperCase() + method.slice(1) : null,
      ].filter(Boolean).join(' · ');
      let meta = div.querySelector('.list-item-meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'list-item-meta';
        div.querySelector('.list-item-header').after(meta);
      }
      meta.innerHTML = `<span>Prev: ${newPrev}</span>`;
      showToast(`${w.common_name} saved`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Admin ───────────────────────────────────────────────────────────────── */
let adminLoaded = false;

async function initAdminScreen() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'supervisor')) return;
  await loadUserList();
}

async function loadUserList() {
  try {
    const users = await api('GET', '/api/users');
    const list = el('admin-user-list');
    list.innerHTML = '';
    users.forEach(u => {
      const card = document.createElement('div');
      card.className = `user-card${u.is_active ? '' : ' user-inactive'}`;
      card.innerHTML = `
        <div class="user-avatar">${(u.initials || u.username.slice(0,2)).toUpperCase()}</div>
        <div class="user-info">
          <div class="user-name">${u.full_name || u.username}</div>
          <div class="user-sub">@${u.username}${u.is_active ? '' : ' · Inactive'}</div>
        </div>
        <span class="role-badge role-${u.role}">${u.role}</span>
        ${currentUser.role === 'admin'
          ? `<button class="user-edit-btn" data-id="${u.user_id}">Edit</button>`
          : ''}
      `;
      list.appendChild(card);
    });

    if (currentUser.role === 'admin') {
      list.querySelectorAll('.user-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openUserModal(users.find(u => u.user_id === parseInt(btn.dataset.id))));
      });
    }
  } catch (err) {
    showToast('Failed to load users: ' + err.message, 'error');
  }
}

el('admin-add-user-btn').addEventListener('click', () => openUserModal(null));

function openUserModal(user) {
  editingUserId = user ? user.user_id : null;
  el('user-modal-title').textContent = user ? 'Edit User' : 'Add User';
  el('um-username').value  = user?.username  || '';
  el('um-fullname').value  = user?.full_name || '';
  el('um-initials').value  = user?.initials  || '';
  el('um-role').value      = user?.role      || 'operator';
  el('um-email').value     = user?.email     || '';
  el('um-password').value  = '';
  el('um-username').disabled = !!user; // can't change username after creation
  el('um-password-group').querySelector('label').textContent = user ? 'New Password (leave blank to keep)' : 'Password';
  clearError('um-error');
  el('user-modal').classList.remove('hidden');
}

el('user-modal-close').addEventListener('click',  () => el('user-modal').classList.add('hidden'));
el('user-modal-cancel').addEventListener('click', () => el('user-modal').classList.add('hidden'));

el('user-modal-save').addEventListener('click', async () => {
  clearError('um-error');
  const username  = el('um-username').value.trim();
  const full_name = el('um-fullname').value.trim();
  const initials  = el('um-initials').value.trim();
  const role      = el('um-role').value;
  const email     = el('um-email').value.trim();
  const password  = el('um-password').value;

  try {
    if (editingUserId) {
      await api('PUT', `/api/users/${editingUserId}`, { full_name, initials, role, email });
      if (password) {
        await api('PUT', `/api/users/${editingUserId}/password`, { password });
      }
    } else {
      if (!username) return showError('um-error', 'Username is required');
      if (!password) return showError('um-error', 'Password is required for new users');
      await api('POST', '/api/users', { username, full_name, initials, role, email, password });
    }
    el('user-modal').classList.add('hidden');
    showToast(editingUserId ? 'User updated' : 'User created', 'success');
    await loadUserList();
  } catch (err) {
    showError('um-error', err.message);
  }
});

/* ── Login Page: DB status + username dropdown + settings modal ──────────── */
async function checkDBStatus() {
  try {
    const status = await api('GET', '/api/db-status');
    const dot  = el('db-dot');
    const text = el('db-status-text');
    if (status.connected) {
      dot.className  = 'db-dot connected';
      text.textContent = `Connected — ${status.host}:${status.port}/${status.database}`;
    } else {
      dot.className  = 'db-dot disconnected';
      text.textContent = 'Database not connected';
    }
  } catch {
    el('db-dot').className   = 'db-dot disconnected';
    el('db-status-text').textContent = 'Could not reach server';
  }
}

async function loadLoginUserList() {
  try {
    const users = await api('GET', '/api/users/list');
    const sel = el('login-username');
    sel.innerHTML = '<option value="">Select user…</option>';
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = u.full_name ? `${u.full_name} (${u.username})` : u.username;
      sel.appendChild(opt);
    });
    if (!users.length) {
      // DB not connected or no users — fall back to text input
      const input = document.createElement('input');
      input.type = 'text';
      input.id   = 'login-username';
      input.className = 'ctrl-input';
      input.autocomplete = 'username';
      input.autocapitalize = 'none';
      input.placeholder = 'Username';
      sel.replaceWith(input);
    }
  } catch { /* leave dropdown empty */ }
}

// DB Settings Modal
el('db-gear-btn').addEventListener('click', () => {
  el('db-test-result').className = 'db-test-result hidden';
  el('db-test-result').textContent = '';
  el('db-modal').classList.remove('hidden');
});
el('db-modal-close').addEventListener('click',  () => el('db-modal').classList.add('hidden'));
el('db-modal-cancel').addEventListener('click', () => el('db-modal').classList.add('hidden'));

el('db-test-btn').addEventListener('click', async () => {
  const btn = el('db-test-btn');
  const result = el('db-test-result');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  result.className = 'db-test-result hidden';

  const body = {
    host:     el('db-host').value.trim(),
    port:     el('db-port').value || '5432',
    database: el('db-name').value.trim(),
    user:     el('db-user').value.trim(),
    password: el('db-password').value,
  };

  try {
    const data = await api('POST', '/api/db-test', body);
    if (data.connected) {
      result.className = 'db-test-result success';
      result.textContent = '✓ Connection successful!';
    } else {
      result.className = 'db-test-result error';
      result.textContent = '✗ ' + (data.error || 'Connection failed');
    }
  } catch (err) {
    result.className = 'db-test-result error';
    result.textContent = '✗ ' + err.message;
  } finally {
    result.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
});

/* ── Init ────────────────────────────────────────────────────────────────── */
checkDBStatus();
loadLoginUserList();
checkAuth();
