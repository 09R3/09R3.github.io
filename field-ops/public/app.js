/* ── State ───────────────────────────────────────────────────────────────── */
let currentUser   = null;
let currentScreen = null;

// Pumping plant state
const pp = {
  siteId:    null,
  buildings: [],   // [{ building_id, building_letter, building_name, pumps, compressors, pgeMeters, powerMonitors }]
};

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
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
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

  // Lazy-load data on first visit
  if (name === 'wells')       initWellsScreen();
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

  // Init pumping plant site selector
  loadPPSites();
  showScreen('dashboard');
}

function onLogout() {
  currentUser = null;
  el('app-shell').classList.add('hidden');
  el('screen-login').classList.add('active');
  el('login-password').value = '';
  el('login-username').value = '';
  // Reset pumping plant
  pp.siteId = null;
  pp.buildings = [];
  el('pp-site').value = '';
  el('pp-form-body').innerHTML = '<div class="placeholder-msg">Select a site to load readings.</div>';
  el('pp-save-bar').classList.add('hidden');
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

/* ── Pumping Plant ───────────────────────────────────────────────────────── */
async function loadPPSites() {
  try {
    const sites = await api('GET', '/api/sites');
    const select = el('pp-site');
    select.innerHTML = '<option value="">Select site…</option>';
    sites.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.site_id;
      opt.textContent = s.site_name;
      select.appendChild(opt);
    });
  } catch (err) {
    showToast('Failed to load sites: ' + err.message, 'error');
  }
}

// Set default date/time for pumping plant
el('pp-date').value = todayISO();
el('pp-time').value = nowHHMM();

el('pp-site').addEventListener('change', async () => {
  const siteId = el('pp-site').value;
  if (!siteId) {
    el('pp-form-body').innerHTML = '<div class="placeholder-msg">Select a site to load readings.</div>';
    el('pp-save-bar').classList.add('hidden');
    return;
  }
  pp.siteId = siteId;
  el('pp-form-body').innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    await loadPPBuildings(siteId);
    renderPPForm();
    el('pp-save-bar').classList.remove('hidden');
  } catch (err) {
    el('pp-form-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">Error: ${err.message}</div>`;
  }
});

async function loadPPBuildings(siteId) {
  const buildings = await api('GET', `/api/buildings?site_id=${siteId}`);
  pp.buildings = [];

  await Promise.all(buildings.map(async b => {
    const [pumps, compressors, pgeMeters, powerMonitors] = await Promise.all([
      api('GET', `/api/pump-positions?building_id=${b.building_id}`),
      api('GET', `/api/air-compressors?building_id=${b.building_id}`),
      api('GET', `/api/pge-meters?building_id=${b.building_id}`),
      api('GET', `/api/power-monitors?building_id=${b.building_id}`),
    ]);
    pp.buildings.push({ ...b, pumps, compressors, pgeMeters, powerMonitors });
  }));

  // Sort buildings by letter
  pp.buildings.sort((a, b) => (a.building_letter || '').localeCompare(b.building_letter || ''));
}

function renderPPForm() {
  const body = el('pp-form-body');
  if (!pp.buildings.length) {
    body.innerHTML = '<div class="placeholder-msg">No buildings found for this site.</div>';
    return;
  }

  body.innerHTML = '';

  pp.buildings.forEach(building => {
    const hasAny = building.pumps.length || building.compressors.length ||
                   building.pgeMeters.length || building.powerMonitors.length;
    if (!hasAny) return;

    const section = document.createElement('div');
    section.className = 'building-section';
    section.innerHTML = `<div class="building-header">${building.building_name || building.building_letter + ' Plant'}</div>`;

    // Pump rows
    building.pumps.forEach(pump => {
      section.appendChild(createReadingRow({
        type:      'pump',
        id:        pump.position_id,
        label:     `${pump.pump_letter} Pump Hours`,
        prev:      pump.last_reading,
        prevDate:  pump.last_reading_date,
        unit:      'hrs',
      }));
    });

    // Air compressor rows
    building.compressors.forEach(comp => {
      const label = comp.manufacturer
        ? `Air Compressor (${comp.manufacturer})`
        : 'Air Compressor Hours';
      section.appendChild(createReadingRow({
        type:     'compressor',
        id:       comp.compressor_id,
        label,
        prev:     comp.last_reading,
        prevDate: comp.last_reading_date,
        unit:     'hrs',
      }));
    });

    // PG&E meter rows
    building.pgeMeters.forEach(m => {
      const label = m.meter_name || `PG&E kWh (${m.meter_number || m.pge_meter_id})`;
      section.appendChild(createReadingRow({
        type:     'pge',
        id:       m.pge_meter_id,
        label,
        prev:     m.last_reading,
        prevDate: m.last_reading_date,
        unit:     'kWh',
        decimals: 0,
      }));
    });

    // Power monitor rows
    building.powerMonitors.forEach(m => {
      const label = m.monitor_number
        ? `Power Monitor kWh (${m.monitor_number})`
        : 'Power Monitor kWh';
      section.appendChild(createReadingRow({
        type:     'monitor',
        id:       m.monitor_id,
        label,
        prev:     m.last_reading,
        prevDate: m.last_reading_date,
        unit:     'kWh',
        decimals: 0,
      }));
    });

    body.appendChild(section);
  });
}

function createReadingRow({ type, id, label, prev, prevDate, unit, decimals = 1 }) {
  const row = document.createElement('div');
  row.className = 'reading-row';
  row.dataset.type = type;
  row.dataset.id   = id;

  const prevVal  = prev != null ? Number(prev) : null;
  const prevDisp = prevVal != null ? Number(prevVal).toFixed(decimals) : '—';
  const dateDisp = prevDate ? fmtDate(prevDate) : '';

  row.innerHTML = `
    <div class="rr-label">
      <span>${label}</span>
      ${dateDisp ? `<span class="prev-date">${dateDisp}</span>` : ''}
    </div>
    <div class="rr-fields">
      <div class="rr-field-group">
        <label>Current</label>
        <input type="number" class="rr-input current rr-current" step="0.1"
               placeholder="" inputmode="decimal">
      </div>
      <div class="rr-field-group">
        <label>Difference</label>
        <input type="text" class="rr-input calc rr-diff" readonly placeholder="—">
      </div>
      <div class="rr-field-group">
        <label>Previous</label>
        <input type="text" class="rr-input prev rr-prev" readonly value="${prevDisp}">
      </div>
    </div>
    <div class="rr-notes-row">
      <input type="text" class="rr-notes-input rr-notes" placeholder="Notes…">
      <button class="notes-plus-btn" title="Expand notes">+</button>
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
  row.querySelector('.notes-plus-btn').addEventListener('click', () => {
    openNotesModal(label, notesInput);
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
let wellOnOff   = true;
let wellMotorOil = true;

async function initWellsScreen() {
  if (wellsLoaded) return;
  wellsLoaded = true;
  el('well-date').value = todayISO();
  el('well-time').value = nowHHMM();
  try {
    const wells = await api('GET', '/api/wells');
    const sel = el('well-select');
    sel.innerHTML = '<option value="">Select well…</option>';
    wells.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.well_id;
      opt.textContent = w.common_name + (w.area ? ` (${w.area})` : '');
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast('Failed to load wells: ' + err.message, 'error');
  }
}

// ON/OFF toggle
el('well-on-btn').addEventListener('click', () => {
  wellOnOff = true;
  el('well-on-btn').classList.add('active');
  el('well-off-btn').classList.remove('active');
});
el('well-off-btn').addEventListener('click', () => {
  wellOnOff = false;
  el('well-off-btn').classList.add('active');
  el('well-on-btn').classList.remove('active');
});

// Motor oil toggle
el('well-motoroil-yes').addEventListener('click', () => {
  wellMotorOil = true;
  el('well-motoroil-yes').classList.add('active');
  el('well-motoroil-no').classList.remove('active');
});
el('well-motoroil-no').addEventListener('click', () => {
  wellMotorOil = false;
  el('well-motoroil-no').classList.add('active');
  el('well-motoroil-yes').classList.remove('active');
});

el('well-save-btn').addEventListener('click', async () => {
  clearError('well-error');
  const well_id = el('well-select').value;
  if (!well_id) return showError('well-error', 'Please select a well');

  const body = {
    well_id:      parseInt(well_id),
    reading_date: el('well-date').value,
    reading_time: el('well-time').value,
    on_off:       wellOnOff,
    hour_reading: el('well-hours').value || null,
    flow_cfs:     el('well-flow').value || null,
    totalizer:    el('well-totalizer').value || null,
    motor_oil:    wellMotorOil,
    dripper_oil:  el('well-dripperoil').value || null,
    pge_kwh:      el('well-pge').value || null,
    notes:        el('well-notes').value || null,
  };

  try {
    await api('POST', '/api/readings/well', body);
    showToast('Well reading saved', 'success');
    el('well-hours').value = '';
    el('well-flow').value  = '';
    el('well-totalizer').value = '';
    el('well-pge').value   = '';
    el('well-dripperoil').value = '';
    el('well-notes').value = '';
  } catch (err) {
    showError('well-error', err.message);
  }
});

/* ── Canal ───────────────────────────────────────────────────────────────── */
let canalLoaded = false;

async function initCanalScreen() {
  if (canalLoaded) return;
  canalLoaded = true;
  el('canal-date').value = todayISO();
  el('canal-time').value = nowHHMM();
  try {
    const structures = await api('GET', '/api/canal-structures');
    const sel = el('canal-select');
    sel.innerHTML = '<option value="">Select structure…</option>';
    structures.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.structure_id;
      opt.textContent = s.structure_name + (s.structure_type ? ` (${s.structure_type})` : '');
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast('Failed to load structures: ' + err.message, 'error');
  }
}

el('canal-save-btn').addEventListener('click', async () => {
  clearError('canal-error');
  const structure_id = el('canal-select').value;
  if (!structure_id) return showError('canal-error', 'Please select a structure');

  const body = {
    structure_id:          parseInt(structure_id),
    reading_date:          el('canal-date').value,
    reading_time:          el('canal-time').value,
    instantaneous_flow_cfs:el('canal-flow').value || null,
    totalizer_reading_af:  el('canal-totalizer').value || null,
    gate_setting:          el('canal-gate').value || null,
    head_reading_ft:       el('canal-head').value || null,
    derived_flow_cfs:      el('canal-derived').value || null,
    notes:                 el('canal-notes').value || null,
  };

  try {
    await api('POST', '/api/readings/canal', body);
    showToast('Canal reading saved', 'success');
    ['canal-flow','canal-totalizer','canal-gate','canal-head','canal-derived','canal-notes']
      .forEach(id => { el(id).value = ''; });
  } catch (err) {
    showError('canal-error', err.message);
  }
});

/* ── Vehicles ────────────────────────────────────────────────────────────── */
let vehiclesLoaded = false;
let vehiclesList   = [];

async function initVehiclesScreen() {
  if (vehiclesLoaded) return;
  vehiclesLoaded = true;
  el('vehicle-date').value = todayISO();
  el('vehicle-time').value = nowHHMM();
  try {
    vehiclesList = await api('GET', '/api/vehicles');
    const sel = el('vehicle-select');
    sel.innerHTML = '<option value="">Select vehicle…</option>';
    vehiclesList.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.vehicle_id;
      opt.textContent = `${v.vehicle_number} — ${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim();
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast('Failed to load vehicles: ' + err.message, 'error');
  }
}

el('vehicle-select').addEventListener('change', () => {
  const id = parseInt(el('vehicle-select').value);
  const v  = vehiclesList.find(x => x.vehicle_id === id);
  const info = el('vehicle-info');
  if (v) {
    info.textContent = `${v.vehicle_type || ''} · Reading type: ${v.reading_type || 'both'}`.trim();
    info.classList.remove('hidden');
  } else {
    info.classList.add('hidden');
  }
});

el('vehicle-save-btn').addEventListener('click', async () => {
  clearError('vehicle-error');
  const vehicle_id = el('vehicle-select').value;
  if (!vehicle_id) return showError('vehicle-error', 'Please select a vehicle');

  const v = vehiclesList.find(x => x.vehicle_id === parseInt(vehicle_id));
  const body = {
    vehicle_id:     parseInt(vehicle_id),
    vehicle_number: v?.vehicle_number || null,
    reading_date:   el('vehicle-date').value,
    reading_time:   el('vehicle-time').value,
    odometer_miles: el('vehicle-odometer').value || null,
    engine_hours:   el('vehicle-hours').value || null,
    notes:          el('vehicle-notes').value || null,
  };

  try {
    await api('POST', '/api/readings/vehicle-monthly', body);
    showToast('Vehicle reading saved', 'success');
    el('vehicle-odometer').value = '';
    el('vehicle-hours').value    = '';
    el('vehicle-notes').value    = '';
  } catch (err) {
    showError('vehicle-error', err.message);
  }
});

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
}

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
        equipment_id:      parseInt(el('maint-equip-id').value) || null,
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
let kfLoaded  = false;
let kfOnOff   = true;
let kfAllWells = []; // full well list for client-side filtering

async function initKFScreen() {
  if (kfLoaded) return;
  kfLoaded = true;
  el('kf-date').value = todayISO();
  el('kf-time').value = nowHHMM();

  // Auto-fill operator from logged-in user
  if (currentUser) {
    el('kf-operator').value = currentUser.initials || currentUser.username;
  }

  try {
    // Load well sets for the set dropdown
    const sets = await api('GET', '/api/well-sets');
    const setSel = el('kf-set-select');
    setSel.innerHTML = '<option value="">All wells…</option>';
    sets.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.set_id;
      opt.textContent = s.set_name || `Set ${s.set_id}`;
      if (s.description) opt.title = s.description;
      setSel.appendChild(opt);
    });
  } catch { /* non-critical if no sets exist */ }

  try {
    // Load all KF-capable wells (those with a kf_set_id or kf well_type)
    kfAllWells = await api('GET', '/api/wells/kf');
    populateKFWells(null);
  } catch (err) {
    showToast('Failed to load KF wells: ' + err.message, 'error');
  }
}

function populateKFWells(setId) {
  const sel = el('kf-well-select');
  const filtered = setId
    ? kfAllWells.filter(w => String(w.kf_set_id) === String(setId))
    : kfAllWells;

  sel.innerHTML = '<option value="">Select well…</option>';
  filtered.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.well_id;
    opt.textContent = w.common_name + (w.area ? ` (${w.area})` : '');
    if (w.set_name) opt.textContent += ` — ${w.set_name}`;
    sel.appendChild(opt);
  });
}

el('kf-set-select').addEventListener('change', () => {
  const setId = el('kf-set-select').value || null;
  populateKFWells(setId);
});

el('kf-on-btn').addEventListener('click', () => {
  kfOnOff = true;
  el('kf-on-btn').classList.add('active');
  el('kf-off-btn').classList.remove('active');
});
el('kf-off-btn').addEventListener('click', () => {
  kfOnOff = false;
  el('kf-off-btn').classList.add('active');
  el('kf-on-btn').classList.remove('active');
});

el('kf-save-btn').addEventListener('click', async () => {
  clearError('kf-error');
  const well_id = el('kf-well-select').value;
  if (!well_id) return showError('kf-error', 'Please select a well');

  const dtw = el('kf-dtw').value;
  if (!dtw) return showError('kf-error', 'Depth to water reading is required');

  const body = {
    well_id:        parseInt(well_id),
    reading_date:   el('kf-date').value,
    reading_time:   el('kf-time').value,
    dtw_reading:    parseFloat(dtw),
    well_on_off:    kfOnOff,
    plopper_sounder:el('kf-plopper-sounder').value || null,
    operator:       el('kf-operator').value || null,
    notes:          el('kf-notes').value || null,
  };

  try {
    await api('POST', '/api/readings/kf-monthly', body);
    showToast('KF reading saved', 'success');
    el('kf-dtw').value   = '';
    el('kf-notes').value = '';
    // Reset date/time to now for next entry
    el('kf-date').value = todayISO();
    el('kf-time').value = nowHHMM();
  } catch (err) {
    showError('kf-error', err.message);
  }
});

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

/* ── Init ────────────────────────────────────────────────────────────────── */
checkAuth();
