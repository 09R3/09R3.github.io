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

// Parse a YYYY-MM-DD string as local midnight (avoids UTC-offset day-behind bug)
function localDateStr(isoDate, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!isoDate) return '—';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
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

async function api(method, path, body, offlineLabel) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (method === 'POST' && offlineLabel && res.status >= 500) {
        await offlineEnqueue(path, body, offlineLabel);
        return { ok: true, queued: true };
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    const isNetworkError = !navigator.onLine ||
      err instanceof TypeError ||
      err.message?.includes('Failed to fetch') ||
      err.message?.includes('NetworkError') ||
      err.message?.includes('Load failed');
    if (method === 'POST' && offlineLabel && isNetworkError) {
      await offlineEnqueue(path, body, offlineLabel);
      return { ok: true, queued: true };
    }
    throw err;
  }
}

/* ── Offline Queue (IndexedDB) ───────────────────────────────────────────── */
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('field-ops-offline', 1);
    req.onupgradeneeded = e =>
      e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function offlineEnqueue(endpoint, body, label) {
  const db = await openOfflineDB();
  await new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({
      endpoint, body, label,
      queued_at: new Date().toISOString(),
      username: currentUser?.username,
    });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  refreshPendingSync();
}
async function offlineGetAll() {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const req = db.transaction('queue', 'readonly').objectStore('queue').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function offlineRemove(id) {
  const db = await openOfflineDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function refreshPendingSync() {
  try {
    const items = await offlineGetAll();
    const card  = el('pending-sync-card');
    const badge = el('sync-status-badge');
    if (!items.length) {
      card.classList.add('hidden');
      // Only clear the badge if it isn't showing an error
      if (!badge.classList.contains('sync-error')) badge.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    el('pending-count').textContent = items.length;
    el('pending-list').innerHTML = items.map(i => {
      const d = i.queued_at ? fmtDate(i.queued_at.slice(0, 10)) : '';
      const t = i.queued_at ? i.queued_at.slice(11, 16) : '';
      return `<div class="pending-item">
        <span>${i.label}</span>
        <span class="pending-time">${d}${t ? ' ' + t : ''}</span>
      </div>`;
    }).join('');
    badge.textContent = items.length;
    badge.className = 'sync-badge sync-pending';
  } catch { /* non-critical */ }
}
async function syncPendingQueue() {
  const btn = el('sync-now-btn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const items = await offlineGetAll();
    let synced = 0, failed = 0;
    for (const item of items) {
      try {
        const res = await fetch(item.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.body),
        });
        if (res.ok) { await offlineRemove(item.id); synced++; }
        else { failed++; }
      } catch { failed++; }
    }
    if (synced) showToast(`Synced ${synced} item${synced > 1 ? 's' : ''}`, 'success');
    if (failed) {
      showToast(`${failed} item${failed > 1 ? 's' : ''} failed to sync`, 'error');
      const badge = el('sync-status-badge');
      badge.textContent = '!';
      badge.className = 'sync-badge sync-error';
    }
    await refreshPendingSync();
  } finally {
    btn.disabled = false; btn.textContent = 'Sync Now';
  }
}
window.addEventListener('online', () => {
  showToast('Back online — syncing…', 'warn');
  syncPendingQueue();
});

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
  // Use maps:// deep link in iOS PWA to open Maps app directly (avoids white screen crash)
  if (isIOS && window.navigator.standalone) return `maps://?ll=${lat},${lon}&q=${encodeURIComponent(label)}`;
  if (isIOS) return `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(label)}`;
  return `https://maps.google.com/maps?q=${lat},${lon}`;
}

/* ── Location Modal ──────────────────────────────────────────────────────── */
let _locationModalUrl = '';
function openLocationModal(lat, lon, name) {
  _locationModalUrl = mapsUrl(lat, lon, name);
  el('location-modal-name').textContent = name;
  el('location-modal-coords').textContent = `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
  el('location-modal').classList.remove('hidden');
}
el('location-modal-close').addEventListener('click', () => el('location-modal').classList.add('hidden'));
el('location-modal').addEventListener('click', e => { if (e.target === el('location-modal')) el('location-modal').classList.add('hidden'); });
el('location-modal-open-btn').addEventListener('click', () => {
  el('location-modal').classList.add('hidden');
  // Use location.href for maps:// deep links on iOS PWA — window.open() crashes
  window.location.href = _locationModalUrl;
});

/* ── Set Map Modal ───────────────────────────────────────────────────────── */
let _setLeafletMap = null;
let _setLeafletMarkers = [];
let _setLocationMarker = null;

function openSetMapModal(setName, wells) {
  const validWells = wells.filter(w => w.gps_latitude && w.gps_longitude);
  if (!validWells.length) { showToast('No GPS coordinates for this set', 'error'); return; }
  el('set-map-title').textContent = setName;
  el('set-map-modal').classList.remove('hidden');

  setTimeout(() => {
    if (!_setLeafletMap) {
      _setLeafletMap = L.map('set-map-container');
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '© Esri, Maxar, Earthstar Geographics'
      }).addTo(_setLeafletMap);
    }
    _setLeafletMarkers.forEach(m => m.remove());
    if (_setLocationMarker) { _setLocationMarker.remove(); _setLocationMarker = null; }

    _setLeafletMarkers = validWells.map(w => {
      const done = w.range_reading_date != null
        || dwrDoneThisSession.has(w.well_id)
        || (w.days_since_reading != null && w.days_since_reading <= 30);
      const color = done ? '#22c55e' : '#ef4444';
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.4);box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        popupAnchor: [0, -8],
      });
      const label = [w.state_well_number, w.common_name].filter(Boolean).join(' | ') || 'Well';
      const readDate = w.range_reading_date || w.last_reading_date;
      const status = done && readDate
        ? `<span style="color:#16a34a">✓ Read ${localDateStr(readDate, {month:'short',day:'numeric'})}</span>`
        : done ? `<span style="color:#16a34a">✓ Read</span>`
        : `<span style="color:#dc2626">Not read</span>`;
      const m = L.marker([w.gps_latitude, w.gps_longitude], { icon }).addTo(_setLeafletMap);
      m.bindPopup(`<strong>${label}</strong><br>${status}`);
      return m;
    });

    const group = L.featureGroup(_setLeafletMarkers);
    _setLeafletMap.fitBounds(group.getBounds().pad(0.15));
    _setLeafletMap.invalidateSize();

    // Add current location if available
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        if (_setLocationMarker) _setLocationMarker.remove();
        const { latitude, longitude } = pos.coords;
        const locationIcon = L.divIcon({
          className: '',
          html: '<div class="map-my-location"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        _setLocationMarker = L.marker([latitude, longitude], { icon: locationIcon })
          .addTo(_setLeafletMap);
        _setLocationMarker.bindPopup('<strong>You are here</strong>');
        // Re-fit bounds to include current location
        const allMarkers = [..._setLeafletMarkers, _setLocationMarker];
        _setLeafletMap.fitBounds(L.featureGroup(allMarkers).getBounds().pad(0.15));
      }, () => { /* permission denied or unavailable — silent */ });
    }
  }, 50);
}
el('set-map-close').addEventListener('click', () => el('set-map-modal').classList.add('hidden'));
el('set-map-modal').addEventListener('click', e => { if (e.target === el('set-map-modal')) el('set-map-modal').classList.add('hidden'); });

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
    'well-runs':    'Well Runs',
    admin:          'Settings',
  };
  el('screen-title').textContent = titles[name] || 'Field Ops';
  closeDrawer();

  // Block supervisor/admin-only screens for operators
  if (name === 'reports') {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'supervisor')) {
      showScreen('dashboard');
      return;
    }
  }

  // Lazy-load data on first visit
  if (name === 'dashboard')     { loadDashboardStats(); refreshPendingSync(); refreshMaintenanceBadges(); }
  if (name === 'pumping-plant') initPPScreen();
  if (name === 'wells')         initWellsScreen();
  if (name === 'canal')         initCanalScreen();
  if (name === 'vehicles')      initVehiclesScreen();
  if (name === 'kf-monthly')    initKFScreen();
  if (name === 'maintenance')   initMaintenanceScreen();
  if (name === 'pesticides')    initPesticideScreen();
  if (name === 'well-runs')     initWellRunsScreen();
  if (name === 'reports')       initReportsScreen();
  if (name === 'admin')         { initAdminScreen(); initSettingsScreen(); }

  // Refresh time to current on every screen visit
  const screenTimeIds = {
    'pumping-plant': 'pp-time',
    'wells':         'well-time',
    'canal':         'canal-time',
    'vehicles':      'vehicle-time',
    'kf-monthly':    'kf-time',
  };
  const timeFieldId = screenTimeIds[name];
  if (timeFieldId) {
    const tf = el(timeFieldId);
    if (tf) tf.value = nowHHMM();
  }
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
el('header-refresh-btn').addEventListener('click', () => location.reload());

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
  localStorage.setItem('field-ops-user', JSON.stringify(user));
  el('screen-login').classList.remove('active');
  el('app-shell').classList.remove('hidden');
  el('user-badge').textContent = user.initials || user.username.slice(0, 2).toUpperCase();
  el('drawer-user').innerHTML = `<strong>${user.full_name || user.username}</strong>${user.role}`;

  // Reset all role-gated elements before applying role
  el('nav-reports-item').classList.add('hidden');
  el('dash-reports-tile').classList.add('hidden');
  el('settings-admin-section').classList.add('hidden');
  el('settings-widgets-section').classList.add('hidden');
  if (user.role === 'admin' || user.role === 'supervisor') {
    el('nav-reports-item').classList.remove('hidden');
    el('dash-reports-tile').classList.remove('hidden');
    el('settings-admin-section').classList.remove('hidden');
    el('settings-widgets-section').classList.remove('hidden');
  }
  // Populate account info on settings screen
  el('settings-full-name').textContent = user.full_name || '—';
  el('settings-username').textContent  = user.username;
  el('settings-role').textContent      = user.role.charAt(0).toUpperCase() + user.role.slice(1);

  showScreen('dashboard');
  loadDashboardStats();
  refreshPendingSync();
}

/* ── Pending Sync Buttons ────────────────────────────────────────────────── */
el('sync-now-btn').addEventListener('click', syncPendingQueue);
el('export-pending-btn').addEventListener('click', async () => {
  const items = await offlineGetAll();
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `field-ops-pending-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

/* ── Dashboard Stats ─────────────────────────────────────────────────────── */
async function loadDashboardStats() {
  try {
    const s = await api('GET', '/api/dashboard/stats');
    const fmtDate = str => {
      if (!str) return '';
      const [y, m, d] = str.split('-');
      return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    kfWidgetStart = s.kf_widget_start || null;
    kfWidgetEnd   = s.kf_widget_end   || null;
    const rangeLabel = (s.kf_widget_start && s.kf_widget_end)
      ? `${fmtDate(s.kf_widget_start)} – ${fmtDate(s.kf_widget_end)}`
      : 'This Month';
    const grid = el('dashboard-stats');
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${s.kf_done} / ${s.kf_total}</div>
        <div class="stat-label">KF Complete</div>
        <div class="stat-sublabel">${rangeLabel}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.kf_total - s.kf_done}</div>
        <div class="stat-label">KF Remaining</div>
        <div class="stat-sublabel">${rangeLabel}</div>
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
  localStorage.removeItem('field-ops-user');
  el('app-shell').classList.add('hidden');
  el('screen-login').classList.add('active');
  el('login-password').value = '';
  el('login-username').value = '';
  // Hide role-gated elements so next login starts clean
  el('nav-reports-item').classList.add('hidden');
  el('dash-reports-tile').classList.add('hidden');
  el('settings-admin-section').classList.add('hidden');
  el('settings-widgets-section').classList.add('hidden');
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
  } catch (err) {
    const isNetworkError = !navigator.onLine ||
      err instanceof TypeError ||
      err.message?.includes('Failed to fetch') ||
      err.message?.includes('Load failed');
    const cached = localStorage.getItem('field-ops-user');
    if (isNetworkError && cached) {
      try { onLogin(JSON.parse(cached)); } catch { /* bad cache, ignore */ }
    }
    // Otherwise: not logged in — show login screen (already visible by default)
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

function isWithin24h(dateStr, timeStr) {
  if (!dateStr) return false;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const t = (timeStr || '00:00').slice(0, 5).split(':').map(Number);
  const readingDT = new Date(y, m - 1, d, t[0], t[1]);
  return (Date.now() - readingDT.getTime()) <= 24 * 60 * 60 * 1000;
}

const HIST_COLS = {
  pump:        [{ key: 'value',         label: 'Hours' }],
  compressor:  [{ key: 'value',         label: 'Hours' }],
  pge:         [{ key: 'value',         label: 'kWh' }],
  monitor:     [{ key: 'value',         label: 'kWh' }],
  well:        [{ key: 'hour_reading',  label: 'Hours' }, { key: 'flow_cfs', label: 'Flow (cfs)' }, { key: 'totalizer', label: 'Totalizer' }],
  kf:          [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }, { key: 'entered_by', label: 'Operator' }],
  dwr:         [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }, { key: 'entered_by', label: 'Operator' }],
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

    const role = currentUser?.role;
    const username = currentUser?.username;
    const canDeleteAll = role === 'admin';

    const cols = HIST_COLS[type] || [];
    const headCells = cols.map(c => `<th>${c.label}</th>`).join('');

    const table = document.createElement('table');
    table.className = 'hist-table';
    table.innerHTML = `<thead><tr><th>Date</th>${headCells}<th>Notes</th><th></th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    rows.forEach(r => {
      const d = fmtDate(r.reading_date);
      const t = r.reading_time ? r.reading_time.slice(0, 5) : '';
      const valCells = cols.map(c => `<td>${r[c.key] != null ? r[c.key] : '—'}</td>`).join('');

      const showDel = canDeleteAll ||
        (role === 'supervisor' && isWithin24h(r.reading_date, r.reading_time)) ||
        (r.entered_by === username && isWithin24h(r.reading_date, r.reading_time));

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${d}${t ? `<div class="hist-time">${t}</div>` : ''}</td>
        ${valCells}
        <td class="hist-notes">${r.notes || ''}</td>
        <td>${showDel ? `<button class="hist-del-btn" data-id="${r.id}">🗑</button>` : ''}</td>`;
      tbody.appendChild(tr);

      if (showDel) {
        tr.querySelector('.hist-del-btn').addEventListener('click', async () => {
          if (!confirm('Delete this reading?')) return;
          try {
            await api('DELETE', `/api/history/${type}/${r.id}`);
            tr.remove();
            if (!tbody.children.length) {
              body.innerHTML = '<div class="placeholder-msg" style="padding:16px">No history found.</div>';
            }
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });
      }
    });

    body.innerHTML = '';
    body.appendChild(table);
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

  // Sort O&M to end; exclude Service Truck entirely
  pp.sites = pp.sites.filter(s => !/service.truck/i.test(s.site_name));
  pp.sites.sort((a, b) => {
    const aOm = /o\s*&\s*m/i.test(a.site_name);
    const bOm = /o\s*&\s*m/i.test(b.site_name);
    return aOm - bOm;
  });

  // Build site tabs — no "All" tab
  const tabsEl = el('pp-site-tabs');
  tabsEl.innerHTML = '';
  const makeTab = (label, siteId) => {
    const btn = document.createElement('button');
    btn.className = 'set-tab';
    btn.textContent = label;
    btn.dataset.siteId = String(siteId);
    tabsEl.appendChild(btn);
  };
  pp.sites.forEach(s => makeTab(s.site_name.replace('Site', 'Plant'), s.site_id));

  // Default to first tab
  if (tabsEl.children.length) {
    tabsEl.children[0].classList.add('active');
    pp.activeTab = tabsEl.children[0].dataset.siteId;
  }

  tabsEl.addEventListener('click', async e => {
    const tab = e.target.closest('.set-tab');
    if (!tab) return;
    tabsEl.querySelectorAll('.set-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    pp.activeTab = tab.dataset.siteId || null;
    el('pp-time').value = nowHHMM();
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

    buildings.forEach(building => {
      const items = buildBuildingRows(building);
      if (!items.length) return;
      const section = makeCollapsibleSection(
        building.building_name || (building.building_letter + ' Plant'),
        items
      );
      section.classList.remove('collapsed'); // auto-expand when viewing a specific plant
      body.appendChild(section);
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
    if (/spare/i.test(pump.status)) return; // spare pumps don't need hour readings
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
      label: 'Air Compressor',
      prev: comp.last_reading, prevDate: comp.last_reading_date,
      prevNotes: comp.last_notes, unit: 'hrs',
    }));
  });
  building.pgeMeters.forEach(m => {
    rows.push(createReadingRow({
      type: 'pge', id: m.pge_meter_id,
      label: 'PG&E kWh',
      prev: m.last_reading, prevDate: m.last_reading_date,
      prevNotes: m.last_notes, unit: 'kWh', decimals: 0,
    }));
  });
  building.powerMonitors.forEach(m => {
    rows.push(createReadingRow({
      type: 'monitor', id: m.monitor_id,
      label: 'Power Monitor',
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
      <input type="number" class="rr-input current rr-current" step="0.1" placeholder="—">
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
    }, 'Pumping Plant');

    if (result.queued) {
      status.textContent = '⏳ Saved offline — will sync when connected';
      status.className = 'save-status warn';
      showToast(`Pumping Plant queued offline`, 'warn');
      // Clear all filled inputs so they can't be re-submitted
      document.querySelectorAll('.reading-row').forEach(row => {
        row.querySelector('.rr-current').value = '';
        row.querySelector('.rr-notes').value = '';
        row.classList.add('saved');
      });
    } else {
      // Mark saved rows green and clear their inputs
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
        if (shouldMark) {
          const curInput = row.querySelector('.rr-current');
          const newVal   = curInput.value.trim();
          row.classList.add('saved');
          curInput.value = '';
          row.querySelector('.rr-notes').value = '';
          // Update Prev column and date hint with the just-saved value
          if (newVal !== '') {
            const prevInput = row.querySelector('.rr-prev');
            const dateDisp  = row.querySelector('.prev-date');
            if (prevInput) prevInput.value = newVal;
            if (dateDisp)  dateDisp.textContent = fmtDate(readingDate);
          }
        }
      });

      const count = result.saved.pump.length + result.saved.compressor.length +
                    result.saved.pge.length + result.saved.monitor.length;
      status.textContent = `✓ ${count} reading${count !== 1 ? 's' : ''} saved`;
      status.className = 'save-status success';
      showToast(`Saved ${count} reading${count !== 1 ? 's' : ''}`, 'success');
    }
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
          <input type="number" class="ctrl-input w-hours" step="0.1" placeholder="0.0">
        </div>
        <div class="form-group">
          <label>Flow (cfs)</label>
          <input type="number" class="ctrl-input w-flow" step="0.01" placeholder="0.00">
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label>Totalizer (AF)</label>
          <input type="number" class="ctrl-input w-totalizer" step="1" placeholder="0">
        </div>
        <div class="form-group">
          <label>Dripper Oil</label>
          <input type="number" class="ctrl-input w-dripperoil" step="0.01" placeholder="0.00">
        </div>
      </div>
      <div class="form-group">
        <label>PG&amp;E kWh</label>
        <input type="number" class="ctrl-input w-pge" step="1" placeholder="0">
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

  // Hours, Flow, Dripper Oil, PG&E: prev + live Δ
  attachDiffDisplay(div.querySelector('.w-hours'),     w.last_hour_reading, 'hrs', 1);
  attachDiffDisplay(div.querySelector('.w-flow'),      w.last_flow_cfs,     'cfs', 2);
  attachDiffDisplay(div.querySelector('.w-dripperoil'),w.last_dripper_oil,  '',    2);
  attachDiffDisplay(div.querySelector('.w-pge'),       w.last_pge_kwh,      'kWh', 0);

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
    if (open) el('well-time').value = nowHHMM();
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
      const r = await api('POST', '/api/readings/well', body, `Well — ${w.common_name}`);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : 'Just saved';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      showToast(r.queued ? `${w.common_name} queued offline` : `${w.common_name} saved`, r.queued ? 'warn' : 'success');
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
  head_gate:          { flow: true,  totalizer: false, gate: true,  head: true,  headLabel: 'Head (ft)', derived: false },
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
      ${f.flow ? `<div class="form-group"><label>Flow (cfs)</label>
        <input type="number" class="ctrl-input c-flow" step="0.01" placeholder="0.00"></div>` : ''}
      ${f.totalizer ? `<div class="form-group"><label>Totalizer (AF)</label>
        <input type="number" class="ctrl-input c-totalizer" step="0.01" placeholder="0.00"></div>` : ''}
      ${f.gate ? `<div class="form-group"><label>Gate Setting</label>
        <input type="text" class="ctrl-input c-gate" inputmode="decimal" placeholder="e.g. 2.5"></div>` : ''}
      ${f.head ? `<div class="form-group"><label>${f.headLabel || 'Head (ft)'}</label>
        <input type="number" class="ctrl-input c-head" step="0.01" placeholder="0.00"></div>` : ''}
      ${f.derived ? `<div class="form-group"><label>Derived Flow (cfs)</label>
        <input type="number" class="ctrl-input c-derived" step="0.01" placeholder="0.00"></div>` : ''}
      <div class="form-group"><label>Notes</label>
        <textarea class="ctrl-textarea c-notes" rows="2" placeholder="Optional notes…"></textarea></div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm c-hist-btn">&#128200; History</button>
        <button class="btn btn-save c-save-btn">Save Reading</button>
      </div>
    </div>`;

  if (s.last_notes) div.querySelector('.c-notes').value = s.last_notes;

  // Prev + live Δ for flow, gate, head/overpour, derived
  const cFlow = div.querySelector('.c-flow');
  if (cFlow) attachDiffDisplay(cFlow, s.last_flow, 'cfs', 2);

  const cGate = div.querySelector('.c-gate');
  if (cGate) attachDiffDisplay(cGate, s.last_gate != null ? parseFloat(s.last_gate) : null, '', 2);

  const cHead = div.querySelector('.c-head');
  if (cHead) attachDiffDisplay(cHead, s.last_head, 'ft', 2);

  const cDerived = div.querySelector('.c-derived');
  if (cDerived) attachDiffDisplay(cDerived, s.last_derived, 'cfs', 2);

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
    if (open) el('canal-time').value = nowHHMM();
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
      const r = await api('POST', '/api/readings/canal', payload, `Canal — ${s.structure_name}`);
      const newFlow = payload.instantaneous_flow_cfs;
      const badge   = div.querySelector('.status-badge');
      const badgeText = r.queued
        ? 'Offline'
        : (newFlow ? `${Number(newFlow).toFixed(2)} cfs · now` : 'Saved');
      if (badge) { badge.textContent = badgeText; badge.className = 'status-badge done'; }
      else {
        const b = document.createElement('span');
        b.className = 'status-badge done';
        b.textContent = badgeText;
        div.querySelector('.list-item-header').insertBefore(b, div.querySelector('.expand-chevron'));
      }
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      showToast(r.queued ? `${s.structure_name} queued offline` : `${s.structure_name} saved`, r.queued ? 'warn' : 'success');
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

function daysSinceDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const then  = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.floor((today - then) / 86400000);
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

  const days  = daysSinceDate(v.last_reading_date);
  const sc    = days == null ? 'due' : days <= 7 ? 'done' : days <= 25 ? 'due' : 'overdue';
  const badge = days == null ? 'Not read' : days === 0 ? 'Today' : `${days}d ago`;

  const rt = v.reading_type;
  const showOdo = !rt || rt === 'odometer' || rt === 'both';
  const showHrs = !rt || rt === 'hours' || rt === 'both';
  const odoField = `<div class="form-group">
    <label>Odometer (mi)${lastOdo ? `<span class="prev-hint"> · Prev: ${lastOdo}</span>` : ''}</label>
    <input type="number" class="ctrl-input v-odo" step="1" placeholder="0">
    <div class="v-service-hint hidden"></div>
  </div>`;
  const hrsField = `<div class="form-group">
    <label>Engine Hours${lastHrs ? `<span class="prev-hint"> · Prev: ${lastHrs}</span>` : ''}</label>
    <input type="number" class="ctrl-input v-hrs" step="0.1" placeholder="0.0">
    <div class="v-service-hrs-hint hidden"></div>
  </div>`;
  const fieldsHtml = (showOdo && showHrs)
    ? `<div class="two-col">${odoField}${hrsField}</div>`
    : `${showOdo ? odoField : ''}${showHrs ? hrsField : ''}`;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name">${label}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-meta">
      ${prevText ? `<span>Prev: ${prevText}</span>` : ''}
      ${v.vin ? `<span>VIN: …${v.vin.slice(-6)}</span>` : ''}
      ${v.license_plate ? `<span>Plate: ${v.license_plate}</span>` : ''}
    </div>
    <div class="list-item-form">
      ${fieldsHtml}
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

  if (v.next_service_miles) {
    const hint = div.querySelector('.v-service-hint');
    div.querySelector('.v-odo')?.addEventListener('input', function() {
      const cur = parseFloat(this.value);
      if (isNaN(cur)) { hint.classList.add('hidden'); return; }
      const remaining = v.next_service_miles - cur;
      hint.textContent = remaining >= 0
        ? `${Math.round(remaining).toLocaleString()} mi until service (@ ${Number(v.next_service_miles).toLocaleString()} mi)`
        : `${Math.abs(Math.round(remaining)).toLocaleString()} mi overdue for service`;
      hint.className = 'v-service-hint ' + (remaining > 1000 ? 'ok' : remaining >= 0 ? 'due' : 'overdue');
    });
  }

  if (v.next_service_hours) {
    const hint = div.querySelector('.v-service-hrs-hint');
    div.querySelector('.v-hrs')?.addEventListener('input', function() {
      const cur = parseFloat(this.value);
      if (isNaN(cur)) { hint.classList.add('hidden'); return; }
      const remaining = v.next_service_hours - cur;
      hint.textContent = remaining >= 0
        ? `${Math.round(remaining).toLocaleString()} hrs until service (@ ${Number(v.next_service_hours).toLocaleString()} hrs)`
        : `${Math.abs(Math.round(remaining)).toLocaleString()} hrs overdue for service`;
      hint.className = 'v-service-hrs-hint ' + (remaining > 50 ? 'ok' : remaining >= 0 ? 'due' : 'overdue');
    });
  }

  div.querySelector('.v-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('vehicle', v.vehicle_id, label);
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
    if (open) el('vehicle-time').value = nowHHMM();
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
      odometer_miles: div.querySelector('.v-odo')?.value || null,
      engine_hours:   div.querySelector('.v-hrs')?.value || null,
      notes:          div.querySelector('.v-notes').value || null,
    };
    try {
      const r = await api('POST', '/api/readings/vehicle-monthly', body, `Vehicle — ${label}`);
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      div.querySelector('.status-dot').className   = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : 'Today';
      div.querySelector('.status-badge').className   = 'status-badge done';
      if (!r.queued) {
        const odoVal  = body.odometer_miles ? `${Number(body.odometer_miles).toLocaleString()} mi` : lastOdo;
        const hrsVal  = body.engine_hours   ? `${Number(body.engine_hours).toFixed(1)} hrs`       : lastHrs;
        const newPrev = [odoVal, hrsVal].filter(Boolean).join(' / ');
        const meta = div.querySelector('.list-item-meta span');
        if (meta && newPrev) meta.textContent = `Prev: ${newPrev}`;
      }
      showToast(r.queued ? `${label} queued offline` : `${label} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Well Issues ─────────────────────────────────────────────────────────── */
let wellIssuesLoaded  = false;
let wellIssues        = [];
let wellShowResolved  = false;

function initMaintWellsPanel() {
  if (wellIssuesLoaded) return;
  wellIssuesLoaded = true;
  el('well-issue-date').value = todayISO();
  loadWellIssues();
  // Populate well dropdown
  api('GET', '/api/wells/operational').then(wells => {
    const sel = el('well-issue-select');
    sel.innerHTML = '<option value="">Select well…</option>';
    wells.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.well_id;
      opt.dataset.area = w.area || '';
      opt.textContent  = w.area ? `${w.common_name} (${w.area})` : w.common_name;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

async function loadWellIssues() {
  try {
    wellIssues = await api('GET', `/api/well-issues?include_resolved=${wellShowResolved}`);
    renderWellIssues();
    updateWellBadge();
  } catch {
    el('well-issue-list').innerHTML = `<div class="issue-empty">Failed to load issues</div>`;
  }
}

function updateWellBadge() {
  const count = wellIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-wells', count);
}

function renderWellIssues() {
  const list = el('well-issue-list');
  if (!wellIssues.length) {
    list.innerHTML = `<div class="issue-empty">No ${wellShowResolved ? '' : 'open '}issues</div>`;
    return;
  }
  list.innerHTML = wellIssues.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const title   = issue.well_area ? `${issue.well_name} (${issue.well_area})` : (issue.well_name || 'Unknown Well');
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${escHtml(title)}</div>
            <div class="equip-issue-snippet">${escHtml(snippet)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-pill ${statusClass}">${issue.status.replace('_',' ')}</span>
            <span class="equip-issue-date">${issue.reported_date?.slice(0,10) || ''}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.description)}</div>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select class="ctrl-select issue-status-select">
              <option value="open"        ${issue.status==='open'        ?'selected':''}>Open</option>
              <option value="in_progress" ${issue.status==='in_progress' ?'selected':''}>In Progress</option>
              <option value="resolved"    ${issue.status==='resolved'    ?'selected':''}>Resolved</option>
            </select>
          </div>
          <div class="form-group issue-action-group" style="${issue.status==='in_progress' ? '' : 'display:none'}">
            <label>Action Taken</label>
            <textarea class="ctrl-textarea issue-action-taken" rows="2" placeholder="Describe the action being taken…">${escHtml(issue.action_taken || '')}</textarea>
          </div>
          <div class="issue-res-group" style="${issue.status==='resolved' ? '' : 'display:none'}">
            <div class="form-group">
              <label>Resolution Notes</label>
              <textarea class="ctrl-textarea issue-res-notes" rows="2" placeholder="Describe how it was resolved…">${escHtml(issue.resolution_notes || '')}</textarea>
            </div>
            <div class="form-group">
              <label>PO Number</label>
              <input type="text" class="ctrl-input issue-po-number" value="${escHtml(issue.po_number || '')}" placeholder="Optional">
            </div>
            <div class="form-group">
              <label>Cost ($)</label>
              <input type="number" class="ctrl-input issue-cost" value="${issue.cost != null ? issue.cost : ''}" placeholder="0.00" min="0" step="0.01">
            </div>
          </div>
          <div class="form-group">
            <label>Assigned To</label>
            <input type="text" class="ctrl-input issue-assigned" value="${escHtml(issue.assigned_to || '')}" placeholder="Optional">
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <button class="btn btn-save btn-full issue-save-btn">Save Changes</button>
        </div>
      </div>`;
  }).join('');
}

// New issue form toggle
el('well-new-issue-btn').addEventListener('click', () => {
  el('well-new-issue-form').classList.remove('hidden');
  el('well-new-issue-btn').classList.add('hidden');
});
el('well-cancel-btn').addEventListener('click', () => {
  el('well-new-issue-form').classList.add('hidden');
  el('well-new-issue-btn').classList.remove('hidden');
  el('well-new-error').classList.add('hidden');
});

// Submit new well issue
el('well-submit-btn').addEventListener('click', async () => {
  clearError('well-new-error');
  const desc = el('well-issue-desc').value.trim();
  if (!desc) return showError('well-new-error', 'Issue description is required');

  const sel      = el('well-issue-select');
  const wellId   = sel.value || null;
  const wellName = sel.options[sel.selectedIndex]?.textContent?.replace(/\s*\(.*\)$/, '').trim() || null;
  const wellArea = sel.options[sel.selectedIndex]?.dataset.area || null;
  if (!wellId) return showError('well-new-error', 'Please select a well');

  el('well-submit-btn').disabled = true;
  try {
    await api('POST', '/api/well-issues', {
      well_id:       parseInt(wellId),
      well_name:     wellName,
      well_area:     wellArea || null,
      description:   desc,
      reported_date: el('well-issue-date').value || null,
      assigned_to:   el('well-issue-assigned').value.trim() || null,
    });
    el('well-issue-desc').value     = '';
    el('well-issue-assigned').value = '';
    el('well-issue-date').value     = todayISO();
    el('well-issue-select').value   = '';
    el('well-new-issue-form').classList.add('hidden');
    el('well-new-issue-btn').classList.remove('hidden');
    wellIssuesLoaded = false;
    await loadWellIssues();
    showToast('Issue submitted', 'success');
    refreshMaintenanceBadges();
  } catch (err) {
    showError('well-new-error', err.message);
  } finally {
    el('well-submit-btn').disabled = false;
  }
});

// Show/hide resolved toggle
el('well-show-resolved-btn').addEventListener('click', () => {
  wellShowResolved = !wellShowResolved;
  el('well-show-resolved-btn').textContent = wellShowResolved ? 'Hide Resolved' : 'Show Resolved';
  wellIssuesLoaded = false;
  loadWellIssues();
});

// Shared: instantly show/hide action-taken or resolution fields when status dropdown changes
function onIssueStatusChange(e) {
  const item = e.target.closest('.equip-issue-item');
  if (!item || !e.target.classList.contains('issue-status-select')) return;
  item.querySelector('.issue-action-group').style.display = e.target.value === 'in_progress' ? '' : 'none';
  item.querySelector('.issue-res-group').style.display    = e.target.value === 'resolved'    ? '' : 'none';
}
['well-issue-list','bldg-issue-list','equip-issue-list'].forEach(id =>
  el(id).addEventListener('change', onIssueStatusChange)
);

// Issue list interactions (delegated)
el('well-issue-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  if (e.target.closest('.equip-issue-header')) {
    item.querySelector('.equip-issue-body').classList.toggle('hidden');
    return;
  }

  if (e.target.classList.contains('issue-save-btn')) {
    const issueId     = item.dataset.issueId;
    const status      = item.querySelector('.issue-status-select').value;
    const actionTaken = item.querySelector('.issue-action-taken').value.trim() || null;
    const resNotes    = item.querySelector('.issue-res-notes').value.trim()    || null;
    const poNumber    = item.querySelector('.issue-po-number').value.trim()    || null;
    const costVal     = item.querySelector('.issue-cost').value;
    const cost        = costVal !== '' ? parseFloat(costVal) : null;
    const assigned    = item.querySelector('.issue-assigned').value.trim()     || null;
    const errEl       = item.querySelector('.issue-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      await api('PATCH', `/api/well-issues/${issueId}`, { status, action_taken: actionTaken, resolution_notes: resNotes, po_number: poNumber, cost, assigned_to: assigned });
      wellIssuesLoaded = false;
      await loadWellIssues();
      showToast('Issue updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

/* ── Building Issues ─────────────────────────────────────────────────────── */
let bldgIssuesLoaded  = false;
let bldgIssues        = [];
let bldgShowResolved  = false;

function initMaintBuildingsPanel() {
  if (bldgIssuesLoaded) return;
  bldgIssuesLoaded = true;
  el('bldg-issue-date').value = todayISO();
  loadBldgIssues();
  // Load sites for new-issue form
  api('GET', '/api/sites').then(sites => {
    const sel = el('bldg-issue-site');
    sel.innerHTML = '<option value="">Select site…</option>';
    sites.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.site_id;
      opt.textContent = s.site_name;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

async function loadBldgIssues() {
  try {
    bldgIssues = await api('GET', `/api/building-issues?include_resolved=${bldgShowResolved}`);
    renderBldgIssues();
    updateBldgBadge();
  } catch {
    el('bldg-issue-list').innerHTML = `<div class="issue-empty">Failed to load issues</div>`;
  }
}

function updateBldgBadge() {
  const count = bldgIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-buildings', count);
}

function renderBldgIssues() {
  const list = el('bldg-issue-list');
  if (!bldgIssues.length) {
    list.innerHTML = `<div class="issue-empty">No ${bldgShowResolved ? '' : 'open '}issues</div>`;
    return;
  }
  list.innerHTML = bldgIssues.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const title   = [issue.site_name, issue.building_name].filter(Boolean).join(' — ') || 'Unknown Building';
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${escHtml(title)}</div>
            <div class="equip-issue-snippet">${escHtml(snippet)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-pill ${statusClass}">${issue.status.replace('_',' ')}</span>
            <span class="equip-issue-date">${issue.reported_date?.slice(0,10) || ''}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.description)}</div>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select class="ctrl-select issue-status-select">
              <option value="open"        ${issue.status==='open'        ?'selected':''}>Open</option>
              <option value="in_progress" ${issue.status==='in_progress' ?'selected':''}>In Progress</option>
              <option value="resolved"    ${issue.status==='resolved'    ?'selected':''}>Resolved</option>
            </select>
          </div>
          <div class="form-group issue-action-group" style="${issue.status==='in_progress' ? '' : 'display:none'}">
            <label>Action Taken</label>
            <textarea class="ctrl-textarea issue-action-taken" rows="2" placeholder="Describe the action being taken…">${escHtml(issue.action_taken || '')}</textarea>
          </div>
          <div class="issue-res-group" style="${issue.status==='resolved' ? '' : 'display:none'}">
            <div class="form-group">
              <label>Resolution Notes</label>
              <textarea class="ctrl-textarea issue-res-notes" rows="2" placeholder="Describe how it was resolved…">${escHtml(issue.resolution_notes || '')}</textarea>
            </div>
            <div class="form-group">
              <label>PO Number</label>
              <input type="text" class="ctrl-input issue-po-number" value="${escHtml(issue.po_number || '')}" placeholder="Optional">
            </div>
            <div class="form-group">
              <label>Cost ($)</label>
              <input type="number" class="ctrl-input issue-cost" value="${issue.cost != null ? issue.cost : ''}" placeholder="0.00" min="0" step="0.01">
            </div>
          </div>
          <div class="form-group">
            <label>Assigned To</label>
            <input type="text" class="ctrl-input issue-assigned" value="${escHtml(issue.assigned_to || '')}" placeholder="Optional">
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <button class="btn btn-save btn-full issue-save-btn">Save Changes</button>
        </div>
      </div>`;
  }).join('');
}

// Site → Building cascade for new building issue
el('bldg-issue-site').addEventListener('change', async () => {
  const siteId  = el('bldg-issue-site').value;
  const bldgSel = el('bldg-issue-building');
  bldgSel.innerHTML = '<option value="">Select building…</option>';
  bldgSel.disabled  = !siteId;
  if (!siteId) return;
  try {
    const buildings = await api('GET', `/api/buildings?site_id=${siteId}`);
    buildings.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.building_id;
      opt.textContent = b.building_name || b.building_letter;
      bldgSel.appendChild(opt);
    });
  } catch { /* non-critical */ }
});

// New issue form toggle
el('bldg-new-issue-btn').addEventListener('click', () => {
  el('bldg-new-issue-form').classList.remove('hidden');
  el('bldg-new-issue-btn').classList.add('hidden');
});
el('bldg-cancel-btn').addEventListener('click', () => {
  el('bldg-new-issue-form').classList.add('hidden');
  el('bldg-new-issue-btn').classList.remove('hidden');
  el('bldg-new-error').classList.add('hidden');
});

// Submit new building issue
el('bldg-submit-btn').addEventListener('click', async () => {
  clearError('bldg-new-error');
  const desc = el('bldg-issue-desc').value.trim();
  if (!desc) return showError('bldg-new-error', 'Issue description is required');

  const siteSel  = el('bldg-issue-site');
  const bldgSel  = el('bldg-issue-building');
  const siteId   = siteSel.value   || null;
  const bldgId   = bldgSel.value   || null;
  const siteName = siteSel.options[siteSel.selectedIndex]?.textContent || null;
  const bldgName = bldgSel.options[bldgSel.selectedIndex]?.textContent || null;

  el('bldg-submit-btn').disabled = true;
  try {
    await api('POST', '/api/building-issues', {
      building_id:   bldgId   ? parseInt(bldgId)   : null,
      site_id:       siteId   ? parseInt(siteId)   : null,
      building_name: bldgName,
      site_name:     siteName,
      description:   desc,
      reported_date: el('bldg-issue-date').value || null,
      assigned_to:   el('bldg-issue-assigned').value.trim() || null,
    });
    el('bldg-issue-desc').value     = '';
    el('bldg-issue-assigned').value = '';
    el('bldg-issue-date').value     = todayISO();
    el('bldg-issue-building').innerHTML = '<option value="">Select building…</option>';
    el('bldg-issue-building').disabled  = true;
    el('bldg-issue-site').value = '';
    el('bldg-new-issue-form').classList.add('hidden');
    el('bldg-new-issue-btn').classList.remove('hidden');
    bldgIssuesLoaded = false;
    await loadBldgIssues();
    showToast('Issue submitted', 'success');
    refreshMaintenanceBadges();
  } catch (err) {
    showError('bldg-new-error', err.message);
  } finally {
    el('bldg-submit-btn').disabled = false;
  }
});

// Show/hide resolved toggle
el('bldg-show-resolved-btn').addEventListener('click', () => {
  bldgShowResolved = !bldgShowResolved;
  el('bldg-show-resolved-btn').textContent = bldgShowResolved ? 'Hide Resolved' : 'Show Resolved';
  bldgIssuesLoaded = false;
  loadBldgIssues();
});

// Issue list interactions (delegated)
el('bldg-issue-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  if (e.target.closest('.equip-issue-header')) {
    item.querySelector('.equip-issue-body').classList.toggle('hidden');
    return;
  }

  if (e.target.classList.contains('issue-save-btn')) {
    const issueId     = item.dataset.issueId;
    const status      = item.querySelector('.issue-status-select').value;
    const actionTaken = item.querySelector('.issue-action-taken').value.trim() || null;
    const resNotes    = item.querySelector('.issue-res-notes').value.trim()    || null;
    const poNumber    = item.querySelector('.issue-po-number').value.trim()    || null;
    const costVal     = item.querySelector('.issue-cost').value;
    const cost        = costVal !== '' ? parseFloat(costVal) : null;
    const assigned    = item.querySelector('.issue-assigned').value.trim()     || null;
    const errEl       = item.querySelector('.issue-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      await api('PATCH', `/api/building-issues/${issueId}`, { status, action_taken: actionTaken, resolution_notes: resNotes, po_number: poNumber, cost, assigned_to: assigned });
      bldgIssuesLoaded = false;
      await loadBldgIssues();
      showToast('Issue updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

/* ── Equipment Issues ────────────────────────────────────────────────────── */
let equipIssuesLoaded = false;
let equipIssues       = [];
let equipShowResolved = false;
let equipNewType      = 'pump';

function initMaintEquipmentPanel() {
  if (equipIssuesLoaded) return;
  equipIssuesLoaded = true;
  el('equip-issue-date').value = todayISO();
  loadEquipIssues();
  loadEquipForNewIssue(equipNewType);
}

async function loadEquipIssues() {
  try {
    equipIssues = await api('GET', `/api/equipment-issues?include_resolved=${equipShowResolved}`);
    renderEquipIssues();
    updateEquipBadge();
  } catch (err) {
    el('equip-issue-list').innerHTML = `<div class="issue-empty">Failed to load issues</div>`;
  }
}

function updateEquipBadge() {
  const count = equipIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-equipment', count);
}

function renderEquipIssues() {
  const list = el('equip-issue-list');
  if (!equipIssues.length) {
    list.innerHTML = `<div class="issue-empty">No ${equipShowResolved ? '' : 'open '}issues</div>`;
    return;
  }
  list.innerHTML = equipIssues.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${escHtml(issue.equipment_name || issue.equipment_type)}</div>
            <div class="equip-issue-snippet">${escHtml(snippet)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-pill ${statusClass}">${issue.status.replace('_',' ')}</span>
            <span class="equip-issue-date">${issue.reported_date?.slice(0,10) || ''}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.description)}</div>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select class="ctrl-select issue-status-select">
              <option value="open"        ${issue.status==='open'        ?'selected':''}>Open</option>
              <option value="in_progress" ${issue.status==='in_progress' ?'selected':''}>In Progress</option>
              <option value="resolved"    ${issue.status==='resolved'    ?'selected':''}>Resolved</option>
            </select>
          </div>
          <div class="form-group issue-action-group" style="${issue.status==='in_progress' ? '' : 'display:none'}">
            <label>Action Taken</label>
            <textarea class="ctrl-textarea issue-action-taken" rows="2" placeholder="Describe the action being taken…">${escHtml(issue.action_taken || '')}</textarea>
          </div>
          <div class="issue-res-group" style="${issue.status==='resolved' ? '' : 'display:none'}">
            <div class="form-group">
              <label>Resolution Notes</label>
              <textarea class="ctrl-textarea issue-res-notes" rows="2" placeholder="Describe how it was resolved…">${escHtml(issue.resolution_notes || '')}</textarea>
            </div>
            <div class="form-group">
              <label>PO Number</label>
              <input type="text" class="ctrl-input issue-po-number" value="${escHtml(issue.po_number || '')}" placeholder="Optional">
            </div>
            <div class="form-group">
              <label>Cost ($)</label>
              <input type="number" class="ctrl-input issue-cost" value="${issue.cost != null ? issue.cost : ''}" placeholder="0.00" min="0" step="0.01">
            </div>
          </div>
          <div class="form-group">
            <label>Assigned To</label>
            <input type="text" class="ctrl-input issue-assigned" value="${escHtml(issue.assigned_to || '')}" placeholder="Optional">
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <button class="btn btn-save btn-full issue-save-btn">Save Changes</button>
        </div>
      </div>`;
  }).join('');
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadEquipForNewIssue(type) {
  const isOther = type === 'other';
  el('equip-select-group').classList.toggle('hidden', isOther);
  el('equip-other-group').classList.toggle('hidden', !isOther);
  if (isOther) return;
  const sel = el('equip-issue-select');
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
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

// New issue form toggle
el('equip-new-issue-btn').addEventListener('click', () => {
  el('equip-new-issue-form').classList.remove('hidden');
  el('equip-new-issue-btn').classList.add('hidden');
});
el('equip-cancel-btn').addEventListener('click', () => {
  el('equip-new-issue-form').classList.add('hidden');
  el('equip-new-issue-btn').classList.remove('hidden');
  el('equip-new-error').classList.add('hidden');
});

// Equipment type seg for new issue form
document.querySelectorAll('#equip-type-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#equip-type-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    equipNewType = btn.dataset.val;
    loadEquipForNewIssue(equipNewType);
  });
});

// Submit new issue
el('equip-submit-btn').addEventListener('click', async () => {
  clearError('equip-new-error');
  const desc = el('equip-issue-desc').value.trim();
  if (!desc) return showError('equip-new-error', 'Issue description is required');

  let equipId = null, equipName = null;
  if (equipNewType === 'other') {
    equipName = el('equip-issue-other').value.trim() || 'Other';
  } else {
    const sel = el('equip-issue-select');
    equipId   = sel.value || null;
    equipName = sel.options[sel.selectedIndex]?.textContent || null;
    if (!equipId) return showError('equip-new-error', 'Please select equipment');
  }

  el('equip-submit-btn').disabled = true;
  try {
    await api('POST', '/api/equipment-issues', {
      equipment_type: equipNewType,
      equipment_id:   equipId,
      equipment_name: equipName,
      description:    desc,
      reported_date:  el('equip-issue-date').value || null,
      assigned_to:    el('equip-issue-assigned').value.trim() || null,
    });
    // Reset form
    el('equip-issue-desc').value     = '';
    el('equip-issue-other').value    = '';
    el('equip-issue-assigned').value = '';
    el('equip-issue-date').value     = todayISO();
    el('equip-new-issue-form').classList.add('hidden');
    el('equip-new-issue-btn').classList.remove('hidden');
    equipIssuesLoaded = false; // force reload
    await loadEquipIssues();
    showToast('Issue submitted', 'success');
    refreshMaintenanceBadges();
  } catch (err) {
    showError('equip-new-error', err.message);
  } finally {
    el('equip-submit-btn').disabled = false;
  }
});

// Show/hide resolved toggle
el('equip-show-resolved-btn').addEventListener('click', () => {
  equipShowResolved = !equipShowResolved;
  el('equip-show-resolved-btn').textContent = equipShowResolved ? 'Hide Resolved' : 'Show Resolved';
  equipIssuesLoaded = false;
  loadEquipIssues();
});

// Issue list interactions (delegated)
el('equip-issue-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  // Toggle expand on header click
  if (e.target.closest('.equip-issue-header')) {
    const body = item.querySelector('.equip-issue-body');
    body.classList.toggle('hidden');
    return;
  }

  // Save changes
  if (e.target.classList.contains('issue-save-btn')) {
    const issueId     = item.dataset.issueId;
    const status      = item.querySelector('.issue-status-select').value;
    const actionTaken = item.querySelector('.issue-action-taken').value.trim() || null;
    const resNotes    = item.querySelector('.issue-res-notes').value.trim()    || null;
    const poNumber    = item.querySelector('.issue-po-number').value.trim()    || null;
    const costVal     = item.querySelector('.issue-cost').value;
    const cost        = costVal !== '' ? parseFloat(costVal) : null;
    const assigned    = item.querySelector('.issue-assigned').value.trim()     || null;
    const errEl       = item.querySelector('.issue-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      await api('PATCH', `/api/equipment-issues/${issueId}`, { status, action_taken: actionTaken, resolution_notes: resNotes, po_number: poNumber, cost, assigned_to: assigned });
      equipIssuesLoaded = false;
      await loadEquipIssues();
      showToast('Issue updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

/* ── Maintenance ─────────────────────────────────────────────────────────── */
let maintType       = 'vehicle';
let maintContractor = false;
let maintVehicles   = [];
let maintVehiclesLoaded = false;

function openMaintPanel(panelId) {
  el('maint-main').classList.add('hidden');
  document.querySelectorAll('.maint-panel').forEach(p => p.classList.add('hidden'));
  el('maint-panel-' + panelId).classList.remove('hidden');
  if (panelId === 'equipment') initMaintEquipmentPanel();
  if (panelId === 'buildings') initMaintBuildingsPanel();
  if (panelId === 'wells')     initMaintWellsPanel();
  if (panelId === 'vehicles')  initMaintVehiclesPanel();
  if (panelId === 'swaps')     initMaintSwapsPanel();
  if (panelId === 'pms')       initMaintPMsPanel();
}

function closeMaintPanel() {
  document.querySelectorAll('.maint-panel').forEach(p => p.classList.add('hidden'));
  el('maint-main').classList.remove('hidden');
}

function initMaintenanceScreen() {
  // Always reset to the sub-dashboard view on each visit
  closeMaintPanel();
  refreshMaintenanceBadges();
}

function setBadge(id, count) {
  const b = el(id);
  if (!b) return;
  b.textContent = count;
  b.classList.toggle('hidden', count === 0);
}

async function refreshMaintenanceBadges() {
  try {
    const counts = await api('GET', '/api/maintenance/badge-counts');
    setBadge('maint-badge-equipment', counts.equipment);
    setBadge('maint-badge-buildings', counts.buildings);
    setBadge('maint-badge-wells',     counts.wells);
    setBadge('maint-main-badge', counts.equipment + counts.buildings + counts.wells);
  } catch { /* non-critical — badges stay at last known value */ }
}

document.querySelectorAll('[data-maint-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    openMaintPanel(btn.dataset.maintPanel);
  });
});

document.querySelectorAll('.maint-back-btn').forEach(btn => {
  btn.addEventListener('click', closeMaintPanel);
});

async function initMaintVehiclesPanel() {
  if (maintVehiclesLoaded) return;
  maintVehiclesLoaded = true;
  maintType = 'vehicle';

  el('maint-date').value = todayISO();

  try {
    const vehicles = await api('GET', '/api/vehicles');
    maintVehicles = vehicles;
    const sel = el('maint-vehicle-select');
    sel.innerHTML = '<option value="">Select vehicle…</option>';
    vehicles.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.vehicle_id;
      const isShared = !v.assigned_user ||
        v.assigned_user.toLowerCase().replace(/\s/g, '') === 'ops&main';
      const parts = [v.vehicle_number, v.model || ''];
      if (!isShared) parts.push(v.assigned_user);
      opt.textContent = parts.filter(Boolean).join(' — ');
      sel.appendChild(opt);
    });
  } catch { /* non-critical */ }
}

// Show/hide next service fields and hints based on selected vehicle
el('maint-vehicle-select').addEventListener('change', () => {
  const vid = parseInt(el('maint-vehicle-select').value);
  const v = maintVehicles.find(x => x.vehicle_id === vid);

  // VIN / plate hint
  const vHint = el('maint-vehicle-hint');
  if (v && (v.vin || v.license_plate)) {
    const parts = [];
    if (v.vin)           parts.push(`VIN: ${v.vin}`);
    if (v.license_plate) parts.push(`Plate: ${v.license_plate}`);
    vHint.textContent = parts.join(' · ');
    vHint.classList.remove('hidden');
  } else {
    vHint.classList.add('hidden');
  }

  // Previous odometer hint
  const odoHint = el('maint-odo-hint');
  if (v?.last_odometer != null) {
    odoHint.textContent = `Previous: ${Number(v.last_odometer).toLocaleString()} mi`;
    odoHint.classList.remove('hidden');
  } else {
    odoHint.classList.add('hidden');
  }

  // Previous engine hours hint
  const hrsHint = el('maint-hrs-hint');
  if (v?.last_engine_hours != null) {
    hrsHint.textContent = `Previous: ${v.last_engine_hours} hrs`;
    hrsHint.classList.remove('hidden');
  } else {
    hrsHint.classList.add('hidden');
  }

  const rt = v?.reading_type;
  const showMiles = !rt || rt === 'odometer' || rt === 'both';
  const showHours = !rt || rt === 'hours' || rt === 'both';
  el('maint-next-miles-group').classList.toggle('hidden', !showMiles);
  el('maint-next-hours-group').classList.toggle('hidden', !showHours);
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

/* ── Equipment Swaps ─────────────────────────────────────────────────────── */
let swapCategory = 'siphon_breaker';
let swapPanelLoaded = false;

function initMaintSwapsPanel() {
  if (swapPanelLoaded) return;
  swapPanelLoaded = true;
  el('swap-date').value = todayISO();
  loadSwapUnits(swapCategory);
}

async function loadSwapUnits(category) {
  const removeSel  = el('swap-remove-select');
  const installSel = el('swap-install-select');
  removeSel.innerHTML  = '<option value="">Loading…</option>';
  installSel.innerHTML = '<option value="">Loading…</option>';
  el('swap-location-hint').classList.add('hidden');
  try {
    const { active, spares } = await api('GET', `/api/equipment-swap-units/${category}`);
    removeSel.innerHTML  = active.length  ? '<option value="">Select active unit…</option>'
                                          : '<option value="">No active units found</option>';
    installSel.innerHTML = spares.length  ? '<option value="">Select spare…</option>'
                                          : '<option value="">No spares found</option>';
    active.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      opt.dataset.location = u.current_location || '';
      removeSel.appendChild(opt);
    });
    spares.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      installSel.appendChild(opt);
    });
  } catch (err) {
    removeSel.innerHTML  = '<option value="">Failed to load</option>';
    installSel.innerHTML = '<option value="">Failed to load</option>';
    showToast('Failed to load swap units: ' + err.message, 'error');
  }
}

document.querySelectorAll('#swap-category-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#swap-category-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    swapCategory = btn.dataset.val;
    el('swap-remove-select').value  = '';
    el('swap-install-select').value = '';
    loadSwapUnits(swapCategory);
  });
});

el('swap-remove-select').addEventListener('change', () => {
  const sel = el('swap-remove-select');
  const opt = sel.options[sel.selectedIndex];
  const hint = el('swap-location-hint');
  if (opt && opt.dataset.location) {
    hint.textContent = `Will be removed from location ${opt.dataset.location}`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
});

el('swap-save-btn').addEventListener('click', async () => {
  clearError('swap-error');
  const remove_id  = parseInt(el('swap-remove-select').value);
  const install_id = parseInt(el('swap-install-select').value);
  const swap_date  = el('swap-date').value;
  if (!remove_id)  return showError('swap-error', 'Select the unit being removed');
  if (!install_id) return showError('swap-error', 'Select the spare being installed');
  if (!swap_date)  return showError('swap-error', 'Swap date is required');

  const btn = el('swap-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api('POST', '/api/equipment-swaps', {
      category: swapCategory,
      remove_id, install_id, swap_date,
      performed_by: el('swap-performed-by').value.trim() || null,
      notes: el('swap-notes').value.trim() || null,
    }, 'Equipment Swap');
    if (r.queued) {
      showToast('Swap queued offline — will sync when connected', 'warn');
    } else {
      showToast(`Swap complete — unit now at ${r.location}`, 'success');
    }
    // Reset form
    el('swap-remove-select').value  = '';
    el('swap-install-select').value = '';
    el('swap-notes').value = '';
    el('swap-location-hint').classList.add('hidden');
    // Reload units so dropdowns reflect the updated statuses
    if (!r.queued) loadSwapUnits(swapCategory);
  } catch (err) {
    showError('swap-error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Complete Swap';
  }
});

/* ── Maintenance Attachments ─────────────────────────────────────────────── */
let maintPendingAttachments = []; // { file, fileType }

function renderMaintAttachQueue() {
  const queue = el('maint-attach-queue');
  if (!maintPendingAttachments.length) { queue.innerHTML = ''; queue.classList.add('hidden'); return; }
  queue.classList.remove('hidden');
  queue.innerHTML = maintPendingAttachments.map((a, i) => {
    const isPdf = a.file.type === 'application/pdf' || a.file.name.endsWith('.pdf');
    const badge = a.fileType === 'invoice' ? 'INV' : 'PIC';
    const thumb = isPdf
      ? `<span class="maint-aq-icon">&#128196;</span>`
      : `<img src="${URL.createObjectURL(a.file)}" alt="">`;
    return `<div class="maint-aq-item">
      ${thumb}
      <span class="maint-aq-badge">${badge}</span>
      <button class="maint-aq-remove" data-idx="${i}">&times;</button>
      <div class="maint-aq-name">${a.file.name}</div>
    </div>`;
  }).join('');
  queue.querySelectorAll('.maint-aq-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      maintPendingAttachments.splice(parseInt(btn.dataset.idx), 1);
      renderMaintAttachQueue();
    });
  });
}

async function loadJsPDF() {
  if (window.jspdf) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function imageToPdf(file) {
  await loadJsPDF();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const maxPx = 2480;
        if (w > maxPx || h > maxPx) {
          const scale = maxPx / Math.max(w, h);
          w = Math.round(w * scale); h = Math.round(h * scale);
        }
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: w > h ? 'l' : 'p', unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
        pdf.addImage(e.target.result, 'JPEG', 0, 0, w, h, undefined, 'FAST');
        const name = file.name.replace(/\.[^.]+$/, '.pdf');
        resolve(new File([pdf.output('blob')], name, { type: 'application/pdf' }));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

el('maint-attach-invoice-btn').addEventListener('click', () => el('maint-attach-invoice-input').click());
el('maint-attach-photo-btn').addEventListener('click',   () => el('maint-attach-photo-input').click());

el('maint-attach-invoice-input').addEventListener('change', async () => {
  const files = [...el('maint-attach-invoice-input').files];
  el('maint-attach-invoice-input').value = '';
  const converting = el('maint-attach-converting');
  for (const f of files) {
    if (f.type.startsWith('image/')) {
      converting.classList.remove('hidden');
      try {
        const pdf = await imageToPdf(f);
        maintPendingAttachments.push({ file: pdf, fileType: 'invoice' });
      } catch {
        maintPendingAttachments.push({ file: f, fileType: 'invoice' });
      }
      converting.classList.add('hidden');
    } else {
      maintPendingAttachments.push({ file: f, fileType: 'invoice' });
    }
  }
  renderMaintAttachQueue();
});

el('maint-attach-photo-input').addEventListener('change', () => {
  [...el('maint-attach-photo-input').files].forEach(f =>
    maintPendingAttachments.push({ file: f, fileType: 'photo' })
  );
  el('maint-attach-photo-input').value = '';
  renderMaintAttachQueue();
});

async function uploadMaintAttachments(maintenanceId, tableName) {
  // Build naming context from the form at save time
  const vehicleOpt = el('maint-vehicle-select').options[el('maint-vehicle-select').selectedIndex];
  const vehicleNum = (vehicleOpt?.text || '').split('—')[0].trim()
    .replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '')
    || 'vehicle';
  const [y, m, d] = (el('maint-date').value || todayISO()).split('-');
  const dateStr = `${m}${d}${y}`;                   // MMDDYYYY
  const workType = el('maint-work-type').value || 'service';

  let invoiceIdx = 0, photoIdx = 0;
  for (const att of maintPendingAttachments) {
    const origExt = att.file.name.includes('.') ? att.file.name.split('.').pop().toLowerCase() : 'jpg';
    let newName;
    if (att.fileType === 'invoice') {
      invoiceIdx++;
      const sfx = invoiceIdx > 1 ? `_${invoiceIdx}` : '';
      newName = `invoice_${vehicleNum}_${dateStr}${sfx}.pdf`;
    } else {
      photoIdx++;
      const sfx = photoIdx > 1 ? `_${photoIdx}` : '';
      newName = `${vehicleNum}_${workType}_${dateStr}${sfx}.${origExt}`;
    }
    const renamed = new File([att.file], newName, { type: att.file.type });
    const fd = new FormData();
    fd.append('file', renamed);
    try {
      await fetch(
        `/api/maintenance/attachment?table_name=${tableName}&record_id=${maintenanceId}&file_type=${att.fileType}&category=vehicles`,
        { method: 'POST', body: fd }
      );
    } catch { /* non-fatal — record was saved, file upload failed */ }
  }
  maintPendingAttachments = [];
  renderMaintAttachQueue();
}

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
    let r;
    if (maintType === 'equipment') {
      r = await api('POST', '/api/maintenance/equipment', {
        ...common,
        equipment_type:    el('maint-equip-type').value,
        equipment_id:      parseInt(el('maint-equip-select').value) || null,
        location_at_time:  el('maint-equip-loc').value || null,
        hours_at_service:  el('maint-equip-hours').value || null,
      }, 'Maintenance — Equipment');
    } else if (maintType === 'vehicle') {
      const vehicleId = el('maint-vehicle-select').value;
      if (!vehicleId) return showError('maint-error', 'Please select a vehicle');
      r = await api('POST', '/api/maintenance/vehicle', {
        ...common,
        vehicle_id:               parseInt(vehicleId),
        odometer_at_service:      el('maint-vehicle-odometer').value || null,
        engine_hours_at_service:  el('maint-vehicle-hours').value || null,
        next_service_miles:       el('maint-vehicle-next-miles').value || null,
        next_service_hours:       el('maint-vehicle-next-hours').value || null,
        status:                   el('maint-vehicle-status').value,
      }, 'Maintenance — Vehicle');
      if (r.maintenance_id && maintPendingAttachments.length) {
        await uploadMaintAttachments(r.maintenance_id, 'maintenance_vehicles');
      }
    } else {
      const buildingId = el('maint-building-select').value;
      if (!buildingId) return showError('maint-error', 'Please select a building');
      r = await api('POST', '/api/maintenance/building', {
        ...common,
        building_id:      parseInt(buildingId),
        record_type:      el('maint-building-record-type').value,
        severity:         el('maint-severity').value || null,
        status:           el('maint-status').value || null,
        resolution_notes: el('maint-resolution-notes').value || null,
      }, 'Maintenance — Building');
    }
    showToast(r.queued ? 'Maintenance queued offline' : 'Maintenance record saved', r.queued ? 'warn' : 'success');
    // Clear entry fields (keep vehicle selected so user can quickly view history)
    el('maint-description').value = '';
    el('maint-parts').value = '';
    el('maint-cost').value  = '';
    el('maint-po').value    = '';
    el('maint-notes').value = '';
    el('maint-resolution-notes').value = '';
    el('maint-performed-by').value = '';
    el('maint-vehicle-odometer').value = '';
    el('maint-vehicle-hours').value = '';
    el('maint-vehicle-next-miles').value = '';
    el('maint-vehicle-next-hours').value = '';
    el('maint-next-service').value = '';
  } catch (err) {
    showError('maint-error', err.message);
  }
});

/* ── KF Monthly ─────────────────────────────────────────────────────────── */
let kfLoaded        = false;
let kfAllWells      = [];
let kfSets          = [];
let kfActiveSet     = null;
let kfWidgetStart   = null;
let kfWidgetEnd     = null;
let kfLoadedStart   = null;
let kfLoadedEnd     = null;
async function initKFScreen() {
  // Reload if widget date range has changed since last load
  if (kfLoaded && kfLoadedStart === kfWidgetStart && kfLoadedEnd === kfWidgetEnd) return;
  kfLoaded = true;

  el('kf-date').value = todayISO();
  el('kf-time').value = nowHHMM();

  try {
    const kfParams = kfWidgetStart && kfWidgetEnd
      ? `?start_date=${kfWidgetStart}&end_date=${kfWidgetEnd}` : '';
    [kfSets, kfAllWells] = await Promise.all([
      api('GET', '/api/well-sets'),
      api('GET', `/api/wells/kf${kfParams}`),
    ]);
    kfLoadedStart = kfWidgetStart;
    kfLoadedEnd   = kfWidgetEnd;
  } catch (err) {
    el('kf-list-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load KF data: ' + err.message, 'error');
    return;
  }

  // Build set tabs — no "All" tab, map button moves to title card
  const tabsEl = el('kf-set-tabs');
  tabsEl.innerHTML = '';
  const makeTab = (label, setId) => {
    const btn = document.createElement('button');
    btn.className = 'set-tab';
    btn.textContent = label;
    btn.dataset.setId = String(setId);
    tabsEl.appendChild(btn);
  };
  kfSets.forEach(s => {
    const raw = s.set_name || String(s.set_id);
    const label = /^set\s/i.test(raw) ? raw : `Set ${raw}`;
    makeTab(label, s.set_id);
  });

  // Default to first set
  if (tabsEl.children.length) {
    tabsEl.children[0].classList.add('active');
    kfActiveSet = tabsEl.children[0].dataset.setId;
  }

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.set-tab');
    if (!tab) return;
    tabsEl.querySelectorAll('.set-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    kfActiveSet = tab.dataset.setId || null;
    el('kf-time').value = nowHHMM();
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

  // Set title card with count and map button
  const currentSet = kfSets.find(s => String(s.set_id) === String(kfActiveSet));
  if (currentSet) {
    const raw = currentSet.set_name || String(currentSet.set_id);
    const setLabel = /^set\s/i.test(raw) ? raw : `Set ${raw}`;
    const doneCount = filtered.filter(w => w.range_reading_date != null).length;
    const totalCount = filtered.length;

    const card = document.createElement('div');
    card.className = 'kf-set-title-card';
    card.innerHTML = `
      <div class="kf-set-title-info">
        <span class="kf-set-title-name">${setLabel}</span>
        <span class="kf-set-title-count">${doneCount} / ${totalCount} complete</span>
      </div>
      <button class="btn btn-secondary btn-sm kf-set-map-card-btn">&#128506; Map</button>`;
    card.querySelector('.kf-set-map-card-btn').addEventListener('click', () => {
      openSetMapModal(setLabel, filtered);
    });
    body.appendChild(card);
  }

  filtered.forEach(w => body.appendChild(createKFItem(w, dateIn, timeIn)));
}

function createKFItem(w, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const inRange = w.range_reading_date != null;
  const sc      = inRange ? 'done' : 'due';
  const badge   = inRange
    ? localDateStr(w.range_reading_date, { month: 'short', day: 'numeric' })
    : 'Not read';
  const prevDTW    = w.last_dtw    != null ? `${Number(w.last_dtw).toFixed(2)} ft` : null;
  const prevMethod = w.last_method != null ? w.last_method.charAt(0).toUpperCase() + w.last_method.slice(1) : null;
  const prevMeta   = [prevDTW, prevMethod].filter(Boolean).join(' · ');
  const hasGPS     = w.gps_latitude && w.gps_longitude;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name${w.is_important ? ' well-important' : ''}">${w.state_well_number ? `${w.state_well_number} | ${w.common_name}` : w.common_name}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    ${prevMeta ? `<div class="list-item-meta"><span>Prev: ${prevMeta}</span></div>` : ''}
    <div class="list-item-form">
      <div class="form-group">
        <label>Depth to Water (ft)${prevDTW ? `<span class="prev-hint"> · Prev: ${prevDTW}</span>` : ''}</label>
        <input type="number" class="ctrl-input kf-dtw" step="0.01" placeholder="0.00">
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

  const mapBtn = div.querySelector('.kf-map-btn');
  if (mapBtn) {
    mapBtn.addEventListener('click', e => {
      e.stopPropagation();
      openLocationModal(w.gps_latitude, w.gps_longitude, w.common_name);
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
    if (open) el('kf-time').value = nowHHMM();
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
      const r = await api('POST', '/api/readings/kf-monthly', body, `KF — ${w.common_name}`);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : 'Today';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      if (!r.queued) {
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
      }
      showToast(r.queued ? `${w.common_name} queued offline` : `${w.common_name} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Settings Screen ─────────────────────────────────────────────────────── */

// Text size preference — apply on load
(function applyTextSize() {
  const saved = localStorage.getItem('field-ops-text-size');
  if (saved) document.documentElement.style.fontSize = saved + 'px';
})();

function updateTextSizeBtns() {
  const saved = localStorage.getItem('field-ops-text-size');
  const current = saved ? parseInt(saved) : 16;
  // Find closest button (in case saved size doesn't exactly match a button)
  const btns = [...document.querySelectorAll('.text-size-btn')];
  let closest = btns[0];
  let minDiff = Infinity;
  btns.forEach(b => {
    const diff = Math.abs(parseInt(b.dataset.size) - current);
    if (diff < minDiff) { minDiff = diff; closest = b; }
  });
  btns.forEach(b => b.classList.toggle('active', b === closest));
}

document.querySelectorAll('.text-size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.size;
    document.documentElement.style.fontSize = size + 'px';
    localStorage.setItem('field-ops-text-size', size);
    updateTextSizeBtns();
  });
});

// Settings panel navigation
function openSettingsPanel(panelId) {
  el('settings-main').classList.add('hidden');
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
  el('settings-panel-' + panelId).classList.remove('hidden');
  if (panelId === 'readings')   loadTodayReadings();
  if (panelId === 'bugreports') loadBugReports();
  if (panelId === 'kf-widget')  initKFWidgetPanel();
  if (panelId === 'appinfo') {
    const ls = localStorage.getItem('field-ops-last-sync');
    el('settings-last-sync').textContent = ls ? new Date(ls).toLocaleString() : 'Never';
    el('settings-db-status').textContent = el('db-dot').classList.contains('connected') ? 'Connected' : 'Disconnected';
  }
}

function closeSettingsPanel() {
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
  el('settings-main').classList.remove('hidden');
}

document.querySelectorAll('.settings-menu-row').forEach(btn => {
  btn.addEventListener('click', () => openSettingsPanel(btn.dataset.panel));
});

document.querySelectorAll('.settings-back-btn').forEach(btn => {
  btn.addEventListener('click', closeSettingsPanel);
});

// ── Secret tools menu (tap version number 5 times) ────────────────────────
(function () {
  let tapCount = 0, tapTimer = null;
  el('appinfo-version-tap').addEventListener('click', () => {
    tapCount++;
    clearTimeout(tapTimer);
    if (tapCount >= 5) {
      tapCount = 0;
      openSettingsPanel('tools');
    } else {
      tapTimer = setTimeout(() => { tapCount = 0; }, 1500);
    }
  });
})();

el('settings-panel-tools').addEventListener('click', e => {
  const btn = e.target.closest('[data-tool]');
  if (!btn) return;
  if (btn.dataset.tool === 'exif')   openExifTool();
  if (btn.dataset.tool === 'upload') openUploadTool();
});

el('exif-back-btn').addEventListener('click', () => {
  el('exif-tool-overlay').classList.add('hidden');
});

// ── EXIF Tool ─────────────────────────────────────────────────────────────────
(function () {
  let exifRows = [], exifFields = [], exifActive = new Set();
  let exifLibLoaded = false;

  function loadExifLib() {
    if (exifLibLoaded || window.EXIF) { exifLibLoaded = true; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exif-js/2.3.0/exif.min.js';
      s.onload = () => { exifLibLoaded = true; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  window.openExifTool = async function () {
    el('exif-tool-overlay').classList.remove('hidden');
    try { await loadExifLib(); } catch { showToast('Could not load EXIF library', 'error'); }
  };

  function gpsDD(coords, ref) {
    if (!Array.isArray(coords) || coords.length < 3) return '';
    const dd = coords[0] + coords[1] / 60 + coords[2] / 3600;
    return ((ref === 'S' || ref === 'W') ? -dd : dd).toFixed(6);
  }

  const FIELDS = {
    Make:'Make', Model:'Model', Software:'Software',
    DateTimeOriginal:'Date Taken', DateTime:'Date/Time',
    ExposureTime:'Exposure', FNumber:'F-Number', ISOSpeedRatings:'ISO',
    FocalLength:'Focal Length', FocalLengthIn35mmFilm:'Focal (35mm)',
    Flash:'Flash', WhiteBalance:'White Balance', ExposureMode:'Exp Mode',
    PixelXDimension:'Width', PixelYDimension:'Height',
    Orientation:'Orientation', GPSLatitude:'Latitude', GPSLongitude:'Longitude',
    GPSAltitude:'Altitude (m)', GPSSpeed:'GPS Speed', GPSDateStamp:'GPS Date',
    LensModel:'Lens', MeteringMode:'Metering', SceneCaptureType:'Scene',
    ColorSpace:'Color Space', UserComment:'Comment', ImageDescription:'Description',
  };
  const SKIP = new Set(['GPSLatitudeRef','GPSLongitudeRef','GPSAltitudeRef','GPSSpeedRef',
                        'GPSImgDirectionRef','GPSMapDatum','GPSVersionID']);

  function fmtVal(key, val, allData) {
    if (val === undefined || val === null || val === '') return '';
    if (key === 'ExposureTime') return val < 1 ? `1/${Math.round(1/val)}s` : `${val}s`;
    if (key === 'FNumber') return `f/${val}`;
    if (key === 'FocalLength' || key === 'FocalLengthIn35mmFilm') return `${val}mm`;
    if (key === 'GPSLatitude')  return gpsDD(val, allData.GPSLatitudeRef  || 'N');
    if (key === 'GPSLongitude') return gpsDD(val, allData.GPSLongitudeRef || 'E');
    if (Array.isArray(val)) return val.join(', ');
    return String(val);
  }

  function readExif(file) {
    return new Promise(resolve => {
      EXIF.getData(file, function () {
        const data = EXIF.getAllTags(this);
        const row = {
          'Filename':  file.name,
          'File Size': (file.size / 1024).toFixed(1) + ' KB',
          'File Type': file.type,
        };
        for (const key of Object.keys(FIELDS)) {
          if (data[key] !== undefined) row[FIELDS[key]] = fmtVal(key, data[key], data);
        }
        resolve(row);
      });
    });
  }

  function mergeFields(rows) {
    const seen = new Set(), out = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); out.push(k); }
    return out;
  }

  function renderTable() {
    const wrap = el('exif-table-wrap');
    const tbl  = el('exif-table');
    if (!exifRows.length) { wrap.classList.add('hidden'); return; }
    const cols = exifFields.filter(f => exifActive.has(f));
    let head = '<thead><tr>' + cols.map(f => `<th>${escHtml(f)}</th>`).join('') + '</tr></thead>';
    let body = '<tbody>' + exifRows.map(row =>
      '<tr>' + cols.map(f => {
        const v = row[f] || '';
        return v ? `<td title="${escHtml(v)}">${escHtml(v)}</td>` : '<td class="na">—</td>';
      }).join('') + '</tr>'
    ).join('') + '</tbody>';
    tbl.innerHTML = head + body;
    wrap.classList.remove('hidden');
  }

  function renderChips() {
    const box = el('exif-chips');
    box.innerHTML = '';
    const all = document.createElement('span');
    all.className = 'exif-chip chip-all';
    all.textContent = 'All / None';
    all.addEventListener('click', () => {
      if (exifFields.some(f => exifActive.has(f))) exifActive.clear();
      else exifFields.forEach(f => exifActive.add(f));
      renderChips(); renderTable(); updateStats();
    });
    box.appendChild(all);
    exifFields.forEach(f => {
      const c = document.createElement('span');
      c.className = 'exif-chip' + (exifActive.has(f) ? ' active' : '');
      c.textContent = f;
      c.addEventListener('click', () => {
        exifActive[exifActive.has(f) ? 'delete' : 'add'](f);
        c.classList.toggle('active');
        renderTable(); updateStats();
      });
      box.appendChild(c);
    });
    box.classList.remove('hidden');
  }

  function updateStats() {
    el('exif-stat-count').textContent = exifRows.length;
    const gpsCount = exifRows.filter(r => r['Latitude']).length;
    el('exif-stat-gps').textContent = gpsCount;
    el('exif-export-btn').style.display = exifRows.length ? '' : 'none';
  }

  async function processFiles(files) {
    if (!files.length) return;
    const progWrap = el('exif-progress-wrap');
    const progBar  = el('exif-progress-bar');
    progWrap.classList.remove('hidden');
    progBar.style.width = '0%';
    const newRows = [];
    for (let i = 0; i < files.length; i++) {
      newRows.push(await readExif(files[i]));
      progBar.style.width = ((i + 1) / files.length * 100) + '%';
    }
    exifRows   = [...exifRows, ...newRows];
    exifFields = mergeFields(exifRows);
    exifActive = new Set(exifFields);
    setTimeout(() => progWrap.classList.add('hidden'), 500);
    el('exif-stats').classList.remove('hidden');
    renderChips(); renderTable(); updateStats();
  }

  function exportCSV() {
    if (!exifRows.length) return;
    const cols = exifFields.filter(f => exifActive.has(f));
    const esc  = v => `"${String(v).replace(/"/g, '""')}"`;
    let csv = cols.map(esc).join(',') + '\n';
    for (const row of exifRows) csv += cols.map(f => esc(row[f] || '')).join(',') + '\n';
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `exif_${new Date().toISOString().slice(0,10)}.csv`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  }

  const dropzone = el('exif-dropzone');
  const fileInput = el('exif-file-input');

  fileInput.addEventListener('change', e => processFiles([...e.target.files]));
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('drag-over');
    processFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
  });
  el('exif-export-btn').addEventListener('click', exportCSV);
  el('exif-filter-btn').addEventListener('click', () => el('exif-chips').classList.toggle('hidden'));
  el('exif-clear-btn').addEventListener('click', () => {
    exifRows = []; exifFields = []; exifActive.clear();
    el('exif-stats').classList.add('hidden');
    el('exif-chips').classList.add('hidden');
    el('exif-table-wrap').classList.add('hidden');
    el('exif-export-btn').style.display = 'none';
    fileInput.value = '';
  });
})();

// Change password
el('pw-save-btn').addEventListener('click', async () => {
  const cur = el('pw-current').value;
  const nw  = el('pw-new').value;
  const con = el('pw-confirm').value;
  const errEl = el('pw-error');
  errEl.classList.add('hidden');
  if (!cur || !nw || !con) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
  if (nw !== con) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }
  try {
    await api('POST', '/api/auth/change-password', { current_password: cur, new_password: nw });
    el('pw-current').value = '';
    el('pw-new').value = '';
    el('pw-confirm').value = '';
    showToast('Password updated', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

function initSettingsScreen() {
  // Always return to main menu when entering Settings
  closeSettingsPanel();
  updateTextSizeBtns();
}

// ── KF Widget Settings ────────────────────────────────────────────────────────
let kfWidgetPanelLoaded = false;

async function initKFWidgetPanel() {
  if (kfWidgetPanelLoaded) return;
  kfWidgetPanelLoaded = true;
  try {
    const { start_date, end_date } = await api('GET', '/api/settings/kf-widget');
    if (start_date) el('kf-widget-start').value = start_date;
    if (end_date)   el('kf-widget-end').value   = end_date;
  } catch { /* leave inputs blank */ }
}

el('kf-widget-save-btn').addEventListener('click', async () => {
  const start_date = el('kf-widget-start').value;
  const end_date   = el('kf-widget-end').value;
  if (!start_date || !end_date) return showToast('Both dates are required', 'error');
  if (start_date > end_date)    return showToast('Start date must be before end date', 'error');
  try {
    await api('PUT', '/api/settings/kf-widget', { start_date, end_date });
    showToast('KF widget updated');
    // Reload dashboard stats on next visit
    loadDashboardStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadTodayReadings() {
  const list = el('today-readings-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/readings/today');
    if (!rows.length) {
      list.innerHTML = '<div class="settings-row"><span class="settings-label" style="font-style:italic">No readings entered today.</span></div>';
      return;
    }
    list.innerHTML = rows.map(r => `
      <div class="today-reading-row" data-type="${r.type}" data-id="${r.id}">
        <div class="today-reading-info">
          <div class="today-reading-name">${r.name}</div>
          <div class="today-reading-meta">${r.reading_time ? r.reading_time.slice(0,5) : ''} &bull; ${r.summary || ''}</div>
        </div>
        <button class="today-reading-del" data-type="${r.type}" data-id="${r.id}" title="Delete">&times;</button>
      </div>
    `).join('');
    list.querySelectorAll('.today-reading-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this reading?')) return;
        const typeToPath = {
          well: 'well', kf: 'kf-monthly',
          pump: 'pump-hours', compressor: 'compressor-hours',
          pge: 'pge-meters', monitor: 'power-monitors',
          vehicle: 'vehicle-monthly',
        };
        const path = typeToPath[btn.dataset.type] || btn.dataset.type;
        try {
          await api('DELETE', `/api/readings/${path}/${btn.dataset.id}`);
          btn.closest('.today-reading-row').remove();
          if (!list.querySelector('.today-reading-row'))
            list.innerHTML = '<div class="settings-row"><span class="settings-label" style="font-style:italic">No readings entered today.</span></div>';
          showToast('Reading deleted', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="settings-row"><span class="settings-label" style="color:var(--red-light)">${err.message}</span></div>`;
  }
}

/* ── Bug Reports ─────────────────────────────────────────────────────────── */
const BUG_VERSION = document.querySelector('.login-version')?.textContent?.trim() || '';

// Seg button wiring for repeatable
document.querySelectorAll('#bug-repeatable-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#bug-repeatable-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

el('bug-report-btn').addEventListener('click', () => {
  closeDrawer();
  el('bug-error').classList.add('hidden');
  el('bug-description').value = '';
  el('bug-screen').value = '';
  el('bug-severity').value = 'minor';
  document.querySelectorAll('#bug-repeatable-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === 'false'));
  el('bug-report-modal').classList.remove('hidden');
});
el('bug-modal-close').addEventListener('click',  () => el('bug-report-modal').classList.add('hidden'));
el('bug-modal-cancel').addEventListener('click', () => el('bug-report-modal').classList.add('hidden'));
el('bug-report-modal').addEventListener('click', e => { if (e.target === el('bug-report-modal')) el('bug-report-modal').classList.add('hidden'); });

el('bug-modal-submit').addEventListener('click', async () => {
  const description = el('bug-description').value.trim();
  const errEl = el('bug-error');
  errEl.classList.add('hidden');
  if (!description) { errEl.textContent = 'Please describe the issue.'; errEl.classList.remove('hidden'); return; }
  const is_repeatable = document.querySelector('#bug-repeatable-seg .seg-btn.active')?.dataset.val === 'true';
  el('bug-modal-submit').disabled = true;
  try {
    await api('POST', '/api/bug-reports', {
      screen_area: el('bug-screen').value || null,
      severity: el('bug-severity').value,
      is_repeatable,
      description,
      app_version: BUG_VERSION,
    });
    el('bug-report-modal').classList.add('hidden');
    showToast('Bug report submitted — thank you!', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    el('bug-modal-submit').disabled = false;
  }
});

async function loadBugReports() {
  const list = el('bug-reports-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/bug-reports');
    if (!rows.length) {
      list.innerHTML = '<div class="placeholder-msg">No bug reports yet.</div>';
      return;
    }
    const sevColor = { minor: 'var(--text-dim)', major: 'var(--yellow)', blocking: 'var(--red-light)' };
    const open   = rows.filter(r => !r.resolved);
    const closed = rows.filter(r =>  r.resolved);
    const renderGroup = (items, title) => {
      if (!items.length) return '';
      return `<div class="bug-group-title">${title}</div>` + items.map(r => `
        <div class="bug-report-card ${r.resolved ? 'bug-resolved' : ''}">
          <div class="bug-report-header">
            <span class="bug-severity" style="color:${sevColor[r.severity] || sevColor.minor}">${r.severity.toUpperCase()}</span>
            ${r.screen_area ? `<span class="bug-area">${r.screen_area}</span>` : ''}
            ${r.is_repeatable ? '<span class="bug-tag">Repeatable</span>' : ''}
            <span class="bug-meta">${r.submitted_by} &bull; ${new Date(r.submitted_at).toLocaleDateString()}</span>
          </div>
          <div class="bug-description">${r.description}</div>
          ${r.app_version ? `<div class="bug-version">${r.app_version}</div>` : ''}
          <div class="bug-resolve-row">
            <label class="bug-resolve-label">
              <input type="checkbox" class="bug-resolve-check" data-id="${r.report_id}" ${r.resolved ? 'checked' : ''}>
              ${r.resolved ? `Resolved by ${r.resolved_by} on ${new Date(r.resolved_at).toLocaleDateString()}` : 'Mark resolved'}
            </label>
          </div>
        </div>
      `).join('');
    };
    list.innerHTML = renderGroup(open, `Open (${open.length})`) + renderGroup(closed, `Resolved (${closed.length})`);
    list.querySelectorAll('.bug-resolve-check').forEach(chk => {
      chk.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/bug-reports/${chk.dataset.id}/resolve`, { resolved: chk.checked });
          loadBugReports();
        } catch (err) {
          showToast(err.message, 'error');
          chk.checked = !chk.checked;
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
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
      text.textContent = `Connected — ${status.database}`;
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
      opt.textContent = u.username;
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

/* ── Maintenance History ─────────────────────────────────────────────────── */
el('maint-history-close').addEventListener('click', () => {
  el('maint-history-modal').classList.add('hidden');
});
el('maint-history-modal').addEventListener('click', e => {
  if (e.target === el('maint-history-modal')) el('maint-history-modal').classList.add('hidden');
});

async function openMaintHistoryModal(type, id, label, equip_type) {
  el('maint-history-title').textContent = `Maintenance — ${label}`;
  const body = el('maint-history-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  el('maint-history-modal').classList.remove('hidden');

  try {
    let url = `/api/maintenance/history?type=${type}&id=${id}`;
    if (equip_type) url += `&equip_type=${encodeURIComponent(equip_type)}`;
    const rows = await api('GET', url);

    if (!rows.length) {
      body.innerHTML = '<div class="placeholder-msg">No maintenance records found.</div>';
      return;
    }

    const statusLabel = { open: 'Open', 'in-progress': 'In Progress', resolved: 'Resolved' };
    body.innerHTML = rows.map(r => {
      const details = [];
      if (r.odometer_at_service) details.push(`${Number(r.odometer_at_service).toLocaleString()} mi`);
      if (r.engine_hours_at_service) details.push(`${r.engine_hours_at_service} hrs`);
      if (r.hours_at_service) details.push(`${r.hours_at_service} hrs`);
      if (r.cost) details.push(`$${Number(r.cost).toFixed(2)}`);
      if (r.parts_used) details.push(`Parts: ${r.parts_used}`);
      if (r.next_service_miles) details.push(`Next svc: ${Number(r.next_service_miles).toLocaleString()} mi`);
      if (r.next_service_hours) details.push(`Next svc: ${r.next_service_hours} hrs`);
      const statusBadge = r.status
        ? `<span class="maint-status-badge maint-status-${r.status}">${statusLabel[r.status] || r.status}</span>` : '';
      const attachBtn = Number(r.attachment_count) > 0
        ? `<button class="btn btn-secondary btn-xs maint-hist-attach-btn" data-id="${r.maintenance_id}">&#128206; ${r.attachment_count} file${r.attachment_count > 1 ? 's' : ''}</button>` : '';
      return `
        <div class="maint-hist-row">
          <div class="maint-hist-header">
            <span class="maint-hist-date">${String(r.work_date).slice(0,10)}</span>
            <span class="maint-hist-type">${r.work_type || ''}${r.record_type ? ` · ${r.record_type}` : ''}${r.is_contractor ? ' · Contractor' : ''}</span>
            ${statusBadge}
          </div>
          ${r.description ? `<div class="maint-hist-desc">${r.description}</div>` : ''}
          ${details.length ? `<div class="maint-hist-details">${details.join(' · ')}</div>` : ''}
          ${r.notes ? `<div class="maint-hist-notes">${r.notes}</div>` : ''}
          <div class="maint-hist-footer">
            <span class="maint-hist-by">By: ${r.performed_by || r.entered_by || '—'}</span>
            ${attachBtn}
          </div>
          ${r.maintenance_id ? `<div class="maint-hist-attach-area hidden" data-id="${r.maintenance_id}"></div>` : ''}
        </div>`;
    }).join('');

    // Wire attachment expand buttons
    body.querySelectorAll('.maint-hist-attach-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const area = body.querySelector(`.maint-hist-attach-area[data-id="${id}"]`);
        if (!area) return;
        if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
        area.classList.remove('hidden');
        if (area.dataset.loaded) return;
        area.innerHTML = '<div class="placeholder-msg" style="font-size:0.8rem">Loading…</div>';
        try {
          const atts = await api('GET', `/api/maintenance/attachments?table_name=maintenance_vehicles&record_id=${id}`);
          area.dataset.loaded = '1';
          if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
          area.innerHTML = atts.map(a => {
            const isPdf = a.mime_type === 'application/pdf' || a.original_name.endsWith('.pdf');
            const url = `/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`;
            const thumb = isPdf
              ? `<span class="maint-att-pdf-icon">&#128196;</span>`
              : `<img src="${url}" alt="" loading="lazy">`;
            const typeLabel = a.file_type === 'invoice' ? 'INV' : 'PIC';
            return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}" data-id="${a.attachment_id}">
              <div class="maint-att-thumb">${thumb}</div>
              <span class="maint-att-type-badge">${typeLabel}</span>
              <div class="maint-att-name">${a.original_name}</div>
            </div>`;
          }).join('');
          area.querySelectorAll('.maint-att-item').forEach(card => {
            card.addEventListener('click', () => {
              const url = card.dataset.url;
              if (card.dataset.pdf === 'true') { window.open(url, '_blank'); }
              else {
                const a = document.createElement('a');
                a.href = url; a.download = card.dataset.name; a.click();
              }
            });
          });
        } catch (err) {
          area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`;
        }
      });
    });
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

el('maint-equip-hist-btn').addEventListener('click', () => {
  const id = el('maint-equip-select').value;
  const label = el('maint-equip-select').options[el('maint-equip-select').selectedIndex]?.text;
  const equip_type = el('maint-equip-type').value;
  if (!id) return showToast('Select an equipment item first', 'error');
  openMaintHistoryModal('equipment', id, label, equip_type);
});

el('maint-vehicle-hist-btn').addEventListener('click', () => {
  const id = el('maint-vehicle-select').value;
  const label = el('maint-vehicle-select').options[el('maint-vehicle-select').selectedIndex]?.text;
  if (!id) return showToast('Select a vehicle first', 'error');
  openMaintHistoryModal('vehicle', id, label);
});

el('maint-building-hist-btn').addEventListener('click', () => {
  const id = el('maint-building-select').value;
  const label = el('maint-building-select').options[el('maint-building-select').selectedIndex]?.text;
  if (!id) return showToast('Select a building first', 'error');
  openMaintHistoryModal('building', id, label);
});

/* ── PM (Preventive Maintenance) ─────────────────────────────────────────── */

// ── Checklist Definitions ─────────────────────────────────────────────────────
const PM_TYPES = {
  a_electrical: {
    title: 'A Plant Electrical PM',
    subtitle: 'CVC Pumping Plant Monthly Electrical Controls Surveillance and Inspection',
    formRef: 'M10-CVC',
    buildings: ['Pumping Plant 1','Pumping Plant 2','Pumping Plant 3','Pumping Plant 4',
                'Pumping Plant 5','Pumping Plant 6','Pumping Plant 7','O&M'],
    items: [
      { key: 'smells_noise',       label: 'Check for unusual smells or noise.' },
      { key: 'visual_motor_ctrl',  label: 'Visual inspection of motor controls.' },
      { key: 'dewebb_mcc_scada',   label: "De-webb / clean MCC's and SCADA panel." },
      { key: 'indicator_lamps',    label: 'Check and replace burned out indicator lamps.' },
      { key: 'panel_labels',       label: 'Replace missing panel labels.' },
      { key: 'motor_current',      label: 'Check motor current on running motors. Look for imbalance or current running ~10 amps or more. This indicates a failed power factor correction capacitor.', type: 'twc-area', placeholder: 'Amp readings (e.g. Pump 1: 45A, Pump 2: 48A…)' },
      { key: 'station_voltage',    label: 'Check station voltage at main breaker panel PMX-1000. Should be ~2300 volts.', type: 'twc', placeholder: 'Voltage reading' },
      { key: 'relay_flags',        label: 'Check for flags on Overload, Reverse Power and Ground Fault relays.' },
      { key: 'breaker_counter',    label: 'Log Main Breaker Operation Counter', type: 'twc', placeholder: 'Counter value' },
      { key: 'scada_screen',       label: 'Clean SCADA touch screen.' },
      { key: 'building_lighting',  label: 'Check building lighting.' },
      { key: 'compressor_hoa',     label: "Check station compressor operation — place H.O.A. in manual then back to auto." },
      { key: 'station_motors',     label: 'Check station motors — listen to running pumps and inspect all units.' },
      { key: 'yard_lights',        label: 'Place yard lights in "ON" position and check lighting.' },
      { key: 'summer_ac',          label: 'Summer — Check A.C. operation, building temp should be ~75°F. Check fan belts and filters.' },
      { key: 'generator_test',     label: 'Generator test.', condBuilding: 'O&M' },
    ],
  },
  b_electrical: {
    title: 'B Plant Electrical PM',
    subtitle: 'CVC Pumping Plant Monthly Electrical Controls Inspection',
    formRef: 'M10-CVC-B',
    buildings: ['Pumping Plant 1','Pumping Plant 2','Pumping Plant 3','Pumping Plant 4',
                'Pumping Plant 5','Pumping Plant 6'],
    items: [
      { key: 'notify_super',        label: 'Contact and Notify the CVC O&M Superintendent of start of Preventive Maintenance Tasks.' },
      { key: 'smells_noise',        label: 'Check for unusual smells or noise.' },
      { key: 'visual_motor_ctrl',   label: 'Visual inspection of motor controls.' },
      { key: 'mcc_scada_clean',     label: "Check MCC's and SCADA panels for cleanliness, dust and spider webs." },
      { key: 'indicator_lamps',     label: 'Check and replace burned out indicator lamps.' },
      { key: 'panel_labels',        label: 'Replace missing panel labels.' },
      { key: 'station_voltage',     label: 'Check station voltage at main breaker panel (GE Multilin). Should be approx. 4160 volts.', type: 'twc', textLabel: 'Record Voltage', placeholder: 'Voltage reading' },
      { key: 'relay_flags',         label: 'Check for flags on the main switchboard protective relay.' },
      { key: 'breaker_counter',     label: 'Log Main Breaker Operation Counter', type: 'twc', placeholder: 'Counter value' },
      { key: 'motor_current',       label: 'Check motor current on running motors. Look for imbalance or current running approx. 10 amps or more. This may indicate a failed power factor correction capacitor/s.', type: 'twc-area', placeholder: 'Amp readings (e.g. Pump 1: 45A, Pump 2: 48A…)' },
      { key: 'scada_screen',        label: 'Clean SCADA touch screen.' },
      { key: 'station_motors',      label: 'Check station motors — listen to running pumps and perform visual inspection on units not running.' },
      { key: 'yard_lights',         label: 'Place yard lights in "ON" position and check lighting. Put back into "AUTO" when done.' },
      { key: 'field_instrumentation', label: 'Check field instrumentation and attachment points — Level transducers/switches (Forebay and afterbay), conduits, junction boxes and underground pull boxes and "Condulet" Fittings and covers (LBs, LRs, TBs, Cs, etc...).' },
      { key: 'utility_provider',    label: 'Check all utility provider (PG&E) equipment, transformer, etc. Report any issues to Utility Provider and CVC O&M Superintendent.' },
      { key: 'smoke_fire',          label: 'Check status and operation of the Smoke / Fire detection systems.' },
    ],
  },
  siphon_breaker: {
    title: 'Siphon Breaker PM',
    customType: 'siphon',
  },
  air_compressor: {
    title: 'Air Compressor PM',
    customType: 'air_compressor',
    checks: [
      { key: 'leak_test',     label: '5 min Leak Test' },
      { key: 'bleed_sep',     label: 'Bleed Water Separator' },
      { key: 'auto_drain',    label: 'Test Tank Auto Drain' },
      { key: 'high_cutoff',   label: 'Confirm High Cutoff and Low Cut On Are Correct' },
      { key: 'inspect_leaks', label: 'Inspect for Leaks' },
    ],
  },
  wells:          { title: 'Wells PM',                stub: true },
  annual_pp:      { title: 'Annual Pumping Plant PM', stub: true },
};

// ── PM Helpers ────────────────────────────────────────────────────────────────
function pmPanelId(type) { return 'pm-panel-' + type.replace(/_/g, '-'); }
function pmLastId(type)  { return 'pm-last-'  + type.replace(/_/g, '-'); }

const pmHistoryCache = {}; // pm_id → record, for view/export without re-fetch

// ── PM Navigation ─────────────────────────────────────────────────────────────
function openPMType(pmType) {
  el('pm-main').classList.add('hidden');
  document.querySelectorAll('#maint-panel-pms .pm-panel').forEach(p => p.classList.add('hidden'));
  el(pmPanelId(pmType)).classList.remove('hidden');
  initPMTypePanel(pmType);
}

function closePMType() {
  document.querySelectorAll('#maint-panel-pms .pm-panel').forEach(p => p.classList.add('hidden'));
  el('pm-main').classList.remove('hidden');
}

el('maint-panel-pms').addEventListener('click', e => {
  if (e.target.matches('.pm-back-btn') || e.target.closest('.pm-back-btn')) closePMType();
});

document.querySelectorAll('[data-pm-type]').forEach(btn => {
  btn.addEventListener('click', () => openPMType(btn.dataset.pmType));
});

// ── PM Sub-dashboard ──────────────────────────────────────────────────────────
async function initMaintPMsPanel() {
  closePMType();
  await loadPMLastCompleted();
}

async function loadPMLastCompleted() {
  try {
    const rows = await api('GET', '/api/pm-records/last-completed');
    rows.forEach(r => {
      const labelEl = el(pmLastId(r.pm_type));
      if (!labelEl) return;
      const d = localDateStr(r.completed_date, { month: 'short', day: 'numeric' });
      labelEl.textContent = d;
    });
  } catch { /* non-critical */ }
}

// ── PM Type Panel ─────────────────────────────────────────────────────────────
async function initPMTypePanel(pmType) {
  const def = PM_TYPES[pmType];
  const contentEl = el(pmPanelId(pmType)).querySelector('.pm-type-content');

  // Build structure on first open only
  if (!contentEl.firstElementChild) {
    if (def.stub) {
      contentEl.innerHTML = `<h2 class="panel-heading">${escHtml(def.title)}</h2>
        <div class="placeholder-msg">Checklist coming in a future update.</div>`;
      return;
    }
    if (def.customType === 'siphon')       { buildSiphonBreakerPM(pmType, def, contentEl); return; }
    if (def.customType === 'air_compressor') { buildAirCompressorPM(pmType, def, contentEl); return; }
    buildPMTypeStructure(pmType, def, contentEl);
  }

  if (!def.stub && !def.customType) await loadPMHistory(pmType, contentEl);
  if (def.customType) await loadPMHistory(pmType, contentEl);
}

function buildPMTypeStructure(pmType, def, contentEl) {
  contentEl.innerHTML = `
    <h2 class="panel-heading">${escHtml(def.title)}</h2>
    <div class="issue-toolbar">
      <button class="btn btn-primary btn-sm pm-new-btn">+ New PM</button>
    </div>
    <div class="pm-form-wrap" style="display:none">
      <div class="settings-card" style="margin-bottom:14px">
        <div class="settings-pad">
          <div class="form-group">
            <label>Location</label>
            <select class="ctrl-select pm-building-select">
              <option value="">— select location —</option>
              ${def.buildings.map(b => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join('')}
            </select>
          </div>
          <div class="pm-progress hidden"></div>
          <div class="pm-checklist-area"><p class="placeholder-msg" style="font-style:normal">Select a location to load the checklist.</p></div>
          <div class="form-group" style="margin-top:10px">
            <label>Notes</label>
            <textarea class="ctrl-input pm-notes-field" rows="3" placeholder="Any additional comments…"></textarea>
          </div>
          <div class="form-row">
            <button class="btn btn-primary pm-submit-btn">Submit PM</button>
            <button class="btn btn-secondary pm-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
    <div class="report-section-title" style="margin-top:4px">History</div>
    <div class="pm-history-area"></div>`;

  const newBtn      = contentEl.querySelector('.pm-new-btn');
  const formWrap    = contentEl.querySelector('.pm-form-wrap');
  const buildingSel = contentEl.querySelector('.pm-building-select');
  const progressEl  = contentEl.querySelector('.pm-progress');
  const checklistEl = contentEl.querySelector('.pm-checklist-area');
  const notesEl     = contentEl.querySelector('.pm-notes-field');
  const submitBtn   = contentEl.querySelector('.pm-submit-btn');
  const cancelBtn   = contentEl.querySelector('.pm-cancel-btn');

  newBtn.addEventListener('click', () => {
    formWrap.style.display = '';
    newBtn.style.display   = 'none';
    buildingSel.value = '';
    notesEl.value     = '';
    checklistEl.innerHTML = '<p class="placeholder-msg" style="font-style:normal">Select a location to load the checklist.</p>';
    progressEl.classList.add('hidden');
  });

  cancelBtn.addEventListener('click', () => {
    formWrap.style.display = 'none';
    newBtn.style.display   = '';
  });

  buildingSel.addEventListener('change', () => {
    const building = buildingSel.value;
    if (!building) {
      checklistEl.innerHTML = '<p class="placeholder-msg" style="font-style:normal">Select a location to load the checklist.</p>';
      progressEl.classList.add('hidden');
      return;
    }
    checklistEl.innerHTML = renderChecklistItems(def, building);
    progressEl.classList.remove('hidden');
    updatePMProgress(checklistEl, progressEl, def, building);
    checklistEl.addEventListener('change', () => updatePMProgress(checklistEl, progressEl, def, building));
  });

  submitBtn.addEventListener('click', async () => {
    const building = buildingSel.value;
    if (!building) return showToast('Select a location first', 'error');
    const checklist = collectChecklist(checklistEl, def, building);
    const notes = notesEl.value.trim();
    submitBtn.disabled = true;
    try {
      await api('POST', '/api/pm-records', { pm_type: pmType, building, checklist, notes });
      formWrap.style.display = 'none';
      newBtn.style.display = '';
      showToast('PM submitted');
      loadPMLastCompleted();
      await loadPMHistory(pmType, contentEl);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ── Siphon Breaker PM ─────────────────────────────────────────────────────────
async function buildSiphonBreakerPM(pmType, def, contentEl) {
  contentEl.innerHTML = `<h2 class="panel-heading">${escHtml(def.title)}</h2>
    <div class="issue-toolbar">
      <button class="btn btn-primary btn-sm pm-new-btn">+ New PM</button>
    </div>
    <div class="pm-form-wrap" style="display:none">
      <div class="settings-card" style="margin-bottom:14px">
        <div class="settings-pad">
          <div class="form-group">
            <label>Pumping Plant</label>
            <select class="ctrl-input pm-plant-sel">
              <option value="">— Select Pumping Plant —</option>
            </select>
          </div>
          <div class="pm-sb-checklist"></div>
          <div class="form-group" style="margin-top:10px">
            <label>Notes</label>
            <textarea class="ctrl-input pm-notes-field" rows="2" placeholder="Any additional comments…"></textarea>
          </div>
          <div class="form-row">
            <button class="btn btn-primary pm-submit-btn">Submit PM</button>
            <button class="btn btn-secondary pm-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
    <div class="report-section-title" style="margin-top:4px">History</div>
    <div class="pm-history-area"></div>`;

  const newBtn    = contentEl.querySelector('.pm-new-btn');
  const formWrap  = contentEl.querySelector('.pm-form-wrap');
  const plantSel  = contentEl.querySelector('.pm-plant-sel');
  const listEl    = contentEl.querySelector('.pm-sb-checklist');
  const notesEl   = contentEl.querySelector('.pm-notes-field');
  const submitBtn = contentEl.querySelector('.pm-submit-btn');
  const cancelBtn = contentEl.querySelector('.pm-cancel-btn');

  let positions = [], allPositions = [];

  newBtn.addEventListener('click', async () => {
    formWrap.style.display = '';
    newBtn.style.display   = 'none';
    notesEl.value = '';
    listEl.innerHTML = '';
    positions = [];

    // Populate plant dropdown on first open
    if (plantSel.options.length <= 1) {
      plantSel.innerHTML = '<option value="">Loading…</option>';
      try {
        const [posData, sites] = await Promise.all([
          api('GET', '/api/pump-positions/all'),
          api('GET', '/api/sites'),
        ]);
        allPositions = posData;
        const plants = sites
          .filter(s => !/o\s*&\s*m|service.truck/i.test(s.site_name))
          .sort((a, b) => a.site_name.localeCompare(b.site_name));
        plantSel.innerHTML = '<option value="">— Select Pumping Plant —</option>' +
          plants.map(s => {
            const label = s.site_name.replace(/\bSite\b/g, 'Pumping Plant');
            return `<option value="${s.site_id}" data-name="${label}">${escHtml(label)}</option>`;
          }).join('');
      } catch (err) {
        plantSel.innerHTML = '<option value="">— Error loading plants —</option>';
        showToast('Could not load plants: ' + err.message, 'error');
      }
    } else {
      plantSel.value = '';
    }
  });

  plantSel.addEventListener('change', () => {
    const siteId = plantSel.value;
    if (!siteId) { listEl.innerHTML = ''; positions = []; return; }
    positions = allPositions.filter(p => String(p.site_id) === String(siteId));
    listEl.innerHTML = positions.length
      ? renderSiphonBreakerChecklist(positions)
      : '<div class="issue-empty">No pump positions at this plant.</div>';
  });

  cancelBtn.addEventListener('click', () => {
    formWrap.style.display = 'none';
    newBtn.style.display   = '';
  });

  submitBtn.addEventListener('click', async () => {
    const opt = plantSel.options[plantSel.selectedIndex];
    const plantName = opt?.dataset.name;
    if (!plantName) { showToast('Please select a pumping plant', 'error'); return; }
    if (!positions.length) { showToast('No pump positions loaded', 'error'); return; }
    const checklist = collectSiphonChecklist(listEl, positions);
    const notes = notesEl.value.trim();
    submitBtn.disabled = true;
    try {
      await api('POST', '/api/pm-records', { pm_type: pmType, building: plantName, checklist, notes });
      formWrap.style.display = 'none';
      newBtn.style.display   = '';
      showToast('PM submitted');
      loadPMLastCompleted();
      await loadPMHistory(pmType, contentEl);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  await loadPMHistory(pmType, contentEl);
}

function renderSiphonBreakerChecklist(positions, existingData = {}) {
  return positions.map(p => {
    const locKey = `pos_${p.position_id}`;
    const val    = existingData[locKey] || {};
    const label  = `${p.site_number}${p.pump_letter}`;
    return `<div class="sb-pm-row">
      <label class="pm-check-row sb-check-label">
        <input type="checkbox" class="sb-cb" data-pos="${p.position_id}" ${val.checked ? 'checked' : ''}>
        <span class="sb-loc-label">${escHtml(label)}</span>
      </label>
      <textarea class="ctrl-input pm-textarea sb-notes" data-pos="${p.position_id}"
                rows="1" placeholder="Notes…">${escHtml(val.notes || '')}</textarea>
    </div>`;
  }).join('');
}

function collectSiphonChecklist(listEl, positions) {
  const result = {};
  positions.forEach(p => {
    const cb    = listEl.querySelector(`input.sb-cb[data-pos="${p.position_id}"]`);
    const notes = listEl.querySelector(`textarea.sb-notes[data-pos="${p.position_id}"]`);
    result[`pos_${p.position_id}`] = {
      checked: cb?.checked || false,
      notes:   notes?.value.trim() || '',
    };
  });
  return result;
}

// Sites without a Building B compressor
function acHasBBuilding(label) {
  return !/pumping plant 7|o\s*[&]\s*m|service truck/i.test(label);
}

// ── Air Compressor PM ─────────────────────────────────────────────────────────
async function buildAirCompressorPM(pmType, def, contentEl) {
  const makeChecks = bld => def.checks.map(c => `
    <label class="pm-check-row">
      <input type="checkbox" data-bld="${bld}" data-check="${c.key}">
      <span>${escHtml(c.label)}</span>
    </label>`).join('');

  contentEl.innerHTML = `<h2 class="panel-heading">${escHtml(def.title)}</h2>
    <div class="issue-toolbar">
      <button class="btn btn-primary btn-sm pm-new-btn">+ New PM</button>
    </div>
    <div class="pm-form-wrap" style="display:none">
      <div class="settings-card" style="margin-bottom:14px">
        <div class="settings-pad">
          <div class="form-group">
            <label>Location</label>
            <select class="ctrl-input pm-plant-sel">
              <option value="">— Select Location —</option>
            </select>
          </div>
          <div class="pm-ac-checklist">
            <div class="ac-compressor-group" data-bld-group="a">
              <div class="sb-site-header">Building A Compressor</div>
              ${makeChecks('a')}
            </div>
            <div class="ac-compressor-group" data-bld-group="b">
              <div class="sb-site-header">Building B Compressor</div>
              ${makeChecks('b')}
            </div>
          </div>
          <div class="form-group" style="margin-top:10px">
            <label>Notes</label>
            <textarea class="ctrl-input pm-notes-field" rows="2" placeholder="Any additional comments…"></textarea>
          </div>
          <div class="form-row">
            <button class="btn btn-primary pm-submit-btn">Submit PM</button>
            <button class="btn btn-secondary pm-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
    <div class="report-section-title" style="margin-top:4px">History</div>
    <div class="pm-history-area"></div>`;

  const newBtn      = contentEl.querySelector('.pm-new-btn');
  const formWrap    = contentEl.querySelector('.pm-form-wrap');
  const plantSel    = contentEl.querySelector('.pm-plant-sel');
  const bGroupB     = contentEl.querySelector('[data-bld-group="b"]');
  const notesEl     = contentEl.querySelector('.pm-notes-field');
  const submitBtn   = contentEl.querySelector('.pm-submit-btn');
  const cancelBtn   = contentEl.querySelector('.pm-cancel-btn');

  function updateBuildingB() {
    const label = plantSel.options[plantSel.selectedIndex]?.dataset.name || '';
    const show  = acHasBBuilding(label);
    bGroupB.style.display = show ? '' : 'none';
    if (!show) bGroupB.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  }

  newBtn.addEventListener('click', async () => {
    formWrap.style.display = '';
    newBtn.style.display   = 'none';
    notesEl.value = '';
    contentEl.querySelectorAll('.pm-ac-checklist input[type="checkbox"]').forEach(cb => cb.checked = false);
    bGroupB.style.display = 'none';

    if (plantSel.options.length <= 1) {
      plantSel.innerHTML = '<option value="">Loading…</option>';
      try {
        const sites = await api('GET', '/api/sites');
        // Sort: pumping plants first (by number), then others alphabetically
        const sorted = sites.slice().sort((a, b) => {
          const aNum = parseInt(a.site_name.replace(/\D/g, '')) || 999;
          const bNum = parseInt(b.site_name.replace(/\D/g, '')) || 999;
          return aNum - bNum || a.site_name.localeCompare(b.site_name);
        });
        plantSel.innerHTML = '<option value="">— Select Location —</option>' +
          sorted.map(s => {
            const label = s.site_name.replace(/\bSite\b/g, 'Pumping Plant');
            return `<option value="${s.site_id}" data-name="${label}">${escHtml(label)}</option>`;
          }).join('');
      } catch (err) {
        plantSel.innerHTML = '<option value="">— Error loading locations —</option>';
        showToast('Could not load locations: ' + err.message, 'error');
      }
    } else {
      plantSel.value = '';
      bGroupB.style.display = 'none';
    }
  });

  plantSel.addEventListener('change', updateBuildingB);

  cancelBtn.addEventListener('click', () => {
    formWrap.style.display = 'none';
    newBtn.style.display   = '';
  });
  submitBtn.addEventListener('click', async () => {
    const opt = plantSel.options[plantSel.selectedIndex];
    const plantName = opt?.dataset.name;
    if (!plantName) { showToast('Please select a location', 'error'); return; }
    const hasBBld = acHasBBuilding(plantName);
    const checklist = {};
    ['a', ...(hasBBld ? ['b'] : [])].forEach(bld => {
      checklist[bld] = {};
      def.checks.forEach(c => {
        const cb = contentEl.querySelector(`input[data-bld="${bld}"][data-check="${c.key}"]`);
        checklist[bld][c.key] = cb?.checked || false;
      });
    });
    const notes = notesEl.value.trim();
    submitBtn.disabled = true;
    try {
      await api('POST', '/api/pm-records', { pm_type: pmType, building: plantName, checklist, notes });
      formWrap.style.display = 'none';
      newBtn.style.display   = '';
      showToast('PM submitted');
      loadPMLastCompleted();
      await loadPMHistory(pmType, contentEl);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  await loadPMHistory(pmType, contentEl);
}

// ── Checklist Rendering ───────────────────────────────────────────────────────
function renderChecklistItems(def, building, existingData = {}) {
  let n = 0;
  return def.items.map(item => {
    n++;
    const hidden = item.condBuilding && item.condBuilding !== building;
    const val = existingData[item.key];
    let inner = '';

    if (item.type === 'twc') {
      const checked = val?.checked || false;
      const tv = escHtml(val?.value || '');
      const ph = escHtml(item.textLabel || item.placeholder || 'Value');
      inner = `<label class="pm-check-row">
        <input type="checkbox" data-key="${item.key}" data-type="twc" ${checked ? 'checked' : ''}>
        <span>${n}. ${escHtml(item.label)}</span>
      </label>
      <input type="text" class="ctrl-input pm-text-input" data-key="${item.key}" data-type="twc-val"
             placeholder="${ph}" value="${tv}">`;
    } else if (item.type === 'twc-area') {
      const checked = val?.checked || false;
      const tv = escHtml(val?.value || '');
      const ph = escHtml(item.placeholder || 'Notes');
      inner = `<label class="pm-check-row">
        <input type="checkbox" data-key="${item.key}" data-type="twc" ${checked ? 'checked' : ''}>
        <span>${n}. ${escHtml(item.label)}</span>
      </label>
      <textarea class="ctrl-input pm-text-input pm-textarea" data-key="${item.key}" data-type="twc-val"
                rows="2" placeholder="${ph}">${tv}</textarea>`;
    } else if (item.type === 'text') {
      const tv = escHtml(typeof val === 'string' ? val : '');
      inner = `<div class="pm-text-only-row">
        <span class="pm-text-only-label">${n}. ${escHtml(item.label)}</span>
        <input type="text" class="ctrl-input pm-text-input" data-key="${item.key}" data-type="text-only"
               placeholder="${escHtml(item.placeholder || '')}" value="${tv}">
      </div>`;
    } else {
      const checked = val === true;
      inner = `<label class="pm-check-row">
        <input type="checkbox" data-key="${item.key}" ${checked ? 'checked' : ''}>
        <span>${n}. ${escHtml(item.label)}</span>
      </label>`;
    }

    return `<div class="pm-item${hidden ? ' hidden' : ''}"
                 ${item.condBuilding ? `data-cond-building="${item.condBuilding}"` : ''}>
      ${inner}
    </div>`;
  }).join('');
}

function updatePMProgress(checklistEl, progressEl, def, building) {
  const visibleCBs = checklistEl.querySelectorAll('.pm-item:not(.hidden) input[type="checkbox"]');
  const total   = visibleCBs.length;
  const checked = Array.from(visibleCBs).filter(cb => cb.checked).length;
  progressEl.textContent = `${checked} / ${total} items checked`;
  progressEl.style.color = checked === total && total > 0 ? 'var(--green-light, #4caf50)' : 'var(--text-dim)';
}

function collectChecklist(checklistEl, def, building) {
  const result = {};
  def.items.forEach(item => {
    if (item.condBuilding && item.condBuilding !== building) return;
    if (item.type === 'twc') {
      const cb  = checklistEl.querySelector(`input[data-key="${item.key}"][data-type="twc"]`);
      const txt = checklistEl.querySelector(`input[data-key="${item.key}"][data-type="twc-val"]`);
      result[item.key] = { checked: cb?.checked || false, value: txt?.value.trim() || '' };
    } else if (item.type === 'text') {
      const txt = checklistEl.querySelector(`input[data-key="${item.key}"][data-type="text-only"]`);
      result[item.key] = txt?.value.trim() || '';
    } else {
      const cb = checklistEl.querySelector(`input[data-key="${item.key}"]`);
      result[item.key] = cb?.checked || false;
    }
  });
  return result;
}

// ── PM History ────────────────────────────────────────────────────────────────
async function loadPMHistory(pmType, contentEl) {
  const histEl = contentEl.querySelector('.pm-history-area');
  if (!histEl) return;
  histEl.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', `/api/pm-records?type=${pmType}`);
    rows.forEach(r => { pmHistoryCache[r.pm_id] = r; });
    if (!rows.length) { histEl.innerHTML = '<div class="issue-empty">No PM records yet.</div>'; return; }
    const def = PM_TYPES[pmType];
    histEl.innerHTML = rows.map(r => {
      const d  = localDateStr(r.completed_date, { month: 'short', day: 'numeric', year: 'numeric' });
      const t  = r.completed_time?.slice(0, 5) || '';
      let totalItems, checkedCount;
      if (def.customType === 'siphon') {
        const vals = Object.values(r.checklist);
        totalItems   = vals.length;
        checkedCount = vals.filter(v => v?.checked === true).length;
      } else if (def.customType === 'air_compressor') {
        let tot = 0, done = 0;
        Object.values(r.checklist).forEach(comp => {
          if (comp && typeof comp === 'object') Object.values(comp).forEach(v => { tot++; if (v === true) done++; });
        });
        totalItems = tot; checkedCount = done;
      } else {
        totalItems   = def.items.filter(i => !i.type || i.type !== 'text').length;
        checkedCount = Object.values(r.checklist).filter(v => v === true || v?.checked === true).length;
      }
      return `<div class="pm-history-item">
        <div class="pm-history-header">
          <span class="pm-history-date">${d}${t ? ' · ' + t : ''}</span>
          <span class="pm-history-loc">${escHtml(r.building || '—')}</span>
        </div>
        <div class="pm-history-meta">
          ${escHtml(r.completed_by_name || 'Unknown')} · ${checkedCount}/${totalItems} items
          ${r.notes ? ' · Notes included' : ''}
        </div>
        <div class="pm-history-actions">
          <button class="btn btn-secondary btn-xs" data-pm-view="${r.pm_id}">View</button>
        </div>
      </div>`;
    }).join('');

    histEl.querySelectorAll('[data-pm-view]').forEach(btn => {
      btn.addEventListener('click', () => showPMRecord(pmHistoryCache[parseInt(btn.dataset.pmView)], PM_TYPES[pmType]));
    });
  } catch (err) {
    histEl.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── PM Record View Modal ──────────────────────────────────────────────────────
el('pm-view-modal-close').addEventListener('click', () => el('pm-view-modal').classList.add('hidden'));
el('pm-view-modal').addEventListener('click', e => {
  if (e.target === el('pm-view-modal')) el('pm-view-modal').classList.add('hidden');
});

function renderSBRecordView(record) {
  const entries = Object.entries(record.checklist);
  if (!entries.length) return '<div class="issue-empty">No checklist data.</div>';
  return entries.map(([, val]) => {
    const sym = val.checked ? '✓' : '✗';
    const cls = val.checked ? 'pass' : 'fail';
    return `<div class="pm-view-row">
      <span class="pv-loc ${cls}">${sym}</span>
      ${val.notes ? `<span class="pv-note">${escHtml(val.notes)}</span>` : ''}
    </div>`;
  }).join('');
}

function renderACRecordView(record, def) {
  const cl = record.checklist || {};
  const checks = def.checks || [];
  return ['a', 'b'].map(bld => {
    const data = cl[bld] || {};
    const rows = checks.map(c => {
      const v = data[c.key];
      const dotCls = v === true ? 'pass' : (v === false ? 'fail' : 'empty');
      const sym    = v === true ? '✓'    : (v === false ? '✗'    : '—');
      return `<div class="pm-view-row">
        <span class="pv-loc ${dotCls}">${sym}</span>
        <span>${escHtml(c.label)}</span>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:10px">
      <div style="font-weight:700;font-size:0.82rem;margin-bottom:4px">Building ${bld.toUpperCase()} Compressor</div>
      ${rows}
    </div>`;
  }).join('');
}

function showPMRecord(record, def) {
  const d = localDateStr(record.completed_date, { month: 'long', day: 'numeric', year: 'numeric' });
  const t = record.completed_time?.slice(0, 5) || '';
  el('pm-view-modal-title').textContent = def.title;
  el('pm-view-modal-body').innerHTML = `
    <div class="pm-view-meta">
      <span>${escHtml(record.building || '—')}</span>
      <span>${d}${t ? ' · ' + t : ''}</span>
      <span>${escHtml(record.completed_by_name || 'Unknown')}</span>
    </div>
    <div class="pm-view-list">${
      def.customType === 'siphon'        ? renderSBRecordView(record) :
      def.customType === 'air_compressor'? renderACRecordView(record, def) :
      renderChecklistItems(def, record.building, record.checklist)
    }</div>
    ${record.notes ? `<div class="pm-view-notes"><strong>Notes:</strong> ${escHtml(record.notes)}</div>` : ''}`;
  el('pm-view-modal-body').querySelectorAll('input').forEach(i => i.disabled = true);
  el('pm-view-modal').classList.remove('hidden');
}

// ── PM PDF Export ─────────────────────────────────────────────────────────────
function exportPMRecordAsPDF(record, def) {
  const w = window.open('', '_blank');
  if (!w) { showToast('Allow pop-ups to export PDF', 'error'); return; }
  const d = localDateStr(record.completed_date, { month: 'long', day: 'numeric', year: 'numeric' });
  const t = record.completed_time?.slice(0, 5) || '';
  if (def.customType) {
    const body = def.customType === 'siphon' ? renderSBRecordView(record) : renderACRecordView(record, def);
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escHtml(def.title)} — ${d}</title>
<style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px 40px;color:#000}
h1{font-size:14px;margin:0 0 2px}.sub{font-size:11px;color:#555;margin:0 0 12px}
table{border-collapse:collapse;margin-bottom:14px}td{padding:2px 14px 2px 0}
.pm-view-row{display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #eee}
.pv-loc{font-weight:600;min-width:40px}.pv-note{color:#555;font-style:italic}
.pass{color:#388e3c}.fail{color:#d32f2f}.ac-group{margin-bottom:12px}
.ac-title{font-weight:700;font-size:11px;text-transform:uppercase;margin-bottom:4px}
.ac-row{display:flex;gap:6px;padding:2px 0}.ac-dot{width:10px;height:10px;border-radius:50%;margin-top:2px}
.ac-dot.pass{background:#388e3c}.ac-dot.fail{background:#d32f2f}.ac-dot.empty{background:#ccc}
@media print{body{margin:10mm 15mm}}</style></head><body>
<h1>${escHtml(def.title)}</h1>
<table><tr><td><strong>Location:</strong></td><td>${escHtml(record.building||'—')}</td>
<td><strong>Date:</strong></td><td>${d}${t?' · '+t:''}</td>
<td><strong>By:</strong></td><td>${escHtml(record.completed_by_name||'—')}</td></tr></table>
${body}
${record.notes?`<div style="margin-top:14px;border-top:1px solid #ccc;padding-top:10px"><strong>Notes:</strong><br>${escHtml(record.notes).replace(/\n/g,'<br>')}</div>`:''}
</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
    return;
  }
  let itemNum = 0;
  const itemsHTML = def.items.map(item => {
    if (item.condBuilding && item.condBuilding !== record.building) return '';
    itemNum++;
    const val = record.checklist[item.key];
    let checked = false, extra = '';
    if (item.type === 'twc' || item.type === 'twc-area') {
      checked = val?.checked || false;
      if (val?.value) extra = ` — <strong>${escHtml(val.value)}</strong>`;
    } else if (item.type === 'text') {
      extra = val ? `: <strong>${escHtml(val)}</strong>` : '';
      checked = !!val;
    } else {
      checked = val === true;
    }
    const sym = checked ? '&#9745;' : '&#9744;';
    return `<div class="item">${sym} <strong>${itemNum}.</strong> ${escHtml(item.label)}${extra}</div>`;
  }).filter(Boolean).join('');

  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escHtml(def.title)} — ${d}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;margin:20px 40px;color:#000}
  h1{font-size:14px;margin:0 0 2px}
  .sub{font-size:11px;color:#555;margin:0 0 12px}
  table{border-collapse:collapse;margin-bottom:14px}
  td{padding:2px 14px 2px 0;font-size:12px}
  .item{margin:5px 0;line-height:1.5}
  .notes{margin-top:14px;border-top:1px solid #ccc;padding-top:10px}
  .footer{margin-top:20px;border-top:2px solid #000;padding-top:8px;font-weight:bold}
  @media print{body{margin:10mm 15mm}}
</style></head><body>
<h1>${escHtml(def.subtitle || def.title)}</h1>
<div class="sub">${escHtml(def.formRef || '')}</div>
<table>
  <tr><td><strong>Inspector:</strong></td><td>${escHtml(record.completed_by_name || '—')}</td>
      <td><strong>Location:</strong></td><td>${escHtml(record.building || '—')}</td></tr>
  <tr><td><strong>Date:</strong></td><td>${d}</td>
      <td><strong>Time:</strong></td><td>${t}</td></tr>
</table>
${itemsHTML}
${record.notes ? `<div class="notes"><strong>Notes:</strong><br>${escHtml(record.notes).replace(/\n/g,'<br>')}</div>` : ''}
<div class="footer">INITIAL: Completed in accordance with ${escHtml(def.formRef || 'PM Checklist')} &nbsp;&nbsp; Date: ${d} &nbsp;&nbsp; Time: ${t}</div>
</body></html>`);
  w.document.close();
  w.setTimeout(() => w.print(), 400);
}

/* ── Pesticides ──────────────────────────────────────────────────────────── */
let pestUsageLoaded   = false;
let pestLocationLoaded = false;
let pestReportLoaded  = false;
let pestProductsLoaded = false;
let pestReportMonth   = new Date().getMonth() + 1;
let pestReportYear    = new Date().getFullYear();
let pestLocationEditId = null;

function openPestPanel(panelId) {
  el('pest-main').classList.add('hidden');
  document.querySelectorAll('.maint-panel[id^="pest-panel-"]').forEach(p => p.classList.add('hidden'));
  el(`pest-panel-${panelId}`).classList.remove('hidden');
  if (panelId === 'usage')    initPestUsagePanel();
  if (panelId === 'location') initPestLocationPanel();
  if (panelId === 'reports')  initPestReportsPanel();
  if (panelId === 'products') initPestProductsPanel();
}

function closePestPanel() {
  document.querySelectorAll('.maint-panel[id^="pest-panel-"]').forEach(p => p.classList.add('hidden'));
  el('pest-main').classList.remove('hidden');
}

function initPesticideScreen() {
  closePestPanel();
}

// Sub-tile click
document.querySelectorAll('[data-pest-panel]').forEach(btn => {
  btn.addEventListener('click', () => openPestPanel(btn.dataset.pestPanel));
});

// Back buttons inside pest panels
document.querySelectorAll('#screen-pesticides .maint-back-btn').forEach(btn => {
  btn.addEventListener('click', closePestPanel);
});

// ── Usage Panel ───────────────────────────────────────────────────────────────
async function initPestUsagePanel() {
  if (pestUsageLoaded) return;
  pestUsageLoaded = true;
  await loadPestUsageList();
  await populatePestUsageSelect();
}

async function populatePestUsageSelect() {
  const products = await api('GET', '/api/pesticides');
  const sel = el('pest-usage-select');
  sel.innerHTML = '<option value="">— select pesticide —</option>' +
    products.filter(p => p.active).map(p =>
      `<option value="${p.pesticide_id}" data-uom="${escHtml(p.unit_of_measure)}">${escHtml(p.name)}</option>`
    ).join('');
}

el('pest-usage-select').addEventListener('change', () => {
  const opt = el('pest-usage-select').selectedOptions[0];
  el('pest-usage-uom-label').textContent = opt?.dataset.uom ? `(${opt.dataset.uom})` : '';
});

el('pest-usage-new-btn').addEventListener('click', () => {
  el('pest-usage-form').classList.remove('hidden');
  el('pest-usage-select').value = '';
  el('pest-usage-qty').value = '';
  el('pest-usage-uom-label').textContent = '';
  el('pest-usage-new-btn').style.display = 'none';
});

el('pest-usage-cancel-btn').addEventListener('click', () => {
  el('pest-usage-form').classList.add('hidden');
  el('pest-usage-new-btn').style.display = '';
});

el('pest-usage-save-btn').addEventListener('click', async () => {
  const pesticide_id = el('pest-usage-select').value;
  const quantity = parseFloat(el('pest-usage-qty').value);
  if (!pesticide_id) return showToast('Select a pesticide', 'error');
  if (!quantity || quantity <= 0) return showToast('Enter a valid quantity', 'error');
  try {
    await api('POST', '/api/pesticide-usage', { pesticide_id: parseInt(pesticide_id), quantity });
    el('pest-usage-form').classList.add('hidden');
    el('pest-usage-new-btn').style.display = '';
    pestUsageLoaded = false;
    pestLocationLoaded = false;
    await loadPestUsageList();
    pestUsageLoaded = true;
    showToast('Usage logged');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadPestUsageList() {
  const list = el('pest-usage-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/pesticide-usage');
    if (!rows.length) { list.innerHTML = '<div class="issue-empty">No usage entries yet.</div>'; return; }
    list.innerHTML = rows.map(r => {
      const d = localDateStr(r.used_date);
      const t = r.used_time ? r.used_time.slice(0, 5) : '';
      return `<div class="pest-usage-item">
        <div class="pest-usage-main">
          <span class="pest-usage-name">${escHtml(r.pesticide_name)}</span>
          <span class="pest-usage-qty">${Number(r.quantity).toLocaleString()} ${escHtml(r.unit_of_measure)}</span>
        </div>
        <div class="pest-usage-meta">${d}${t ? ' · ' + t : ''} · ${escHtml(r.applicator_name || 'Unknown')}</div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Location Panel ────────────────────────────────────────────────────────────
async function initPestLocationPanel() {
  if (pestLocationLoaded) return;
  pestLocationLoaded = true;
  await loadPestLocationList();
}

async function loadPestLocationList() {
  const list = el('pest-location-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/pesticide-usage');
    if (!rows.length) { list.innerHTML = '<div class="issue-empty">No usage entries yet.</div>'; return; }
    list.innerHTML = rows.map(r => {
      const d = localDateStr(r.used_date);
      const hasLoc = !!r.location_description;
      return `<div class="pest-loc-item ${hasLoc ? 'has-location' : 'no-location'}" data-id="${r.usage_id}">
        <div class="pest-usage-main">
          <span class="pest-usage-name">${escHtml(r.pesticide_name)}</span>
          <span class="pest-usage-qty">${Number(r.quantity).toLocaleString()} ${escHtml(r.unit_of_measure)}</span>
        </div>
        <div class="pest-usage-meta">${d} · ${escHtml(r.applicator_name || 'Unknown')}</div>
        <div class="pest-loc-desc">${hasLoc ? escHtml(r.location_description) : '<em style="color:var(--text-dim)">No location added — tap to add</em>'}</div>
        ${r.notes ? `<div class="pest-loc-notes">${escHtml(r.notes)}</div>` : ''}
      </div>`;
    }).join('');
    // Attach click handlers
    list.querySelectorAll('.pest-loc-item').forEach(item => {
      item.addEventListener('click', () => openPestLocationModal(item.dataset.id, rows.find(r => r.usage_id == item.dataset.id)));
    });
  } catch (err) {
    list.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

function openPestLocationModal(usageId, row) {
  pestLocationEditId = usageId;
  const d = localDateStr(row.used_date);
  el('pest-location-modal-meta').textContent =
    `${row.pesticide_name} · ${Number(row.quantity).toLocaleString()} ${row.unit_of_measure} · ${d}`;
  el('pest-location-desc').value  = row.location_description || '';
  el('pest-location-notes').value = row.notes || '';
  el('pest-location-modal').classList.remove('hidden');
}

el('pest-location-modal-close').addEventListener('click', () => el('pest-location-modal').classList.add('hidden'));
el('pest-location-cancel-btn').addEventListener('click', () => el('pest-location-modal').classList.add('hidden'));
el('pest-location-modal').addEventListener('click', e => {
  if (e.target === el('pest-location-modal')) el('pest-location-modal').classList.add('hidden');
});

el('pest-location-save-btn').addEventListener('click', async () => {
  const location_description = el('pest-location-desc').value.trim();
  const notes = el('pest-location-notes').value.trim();
  try {
    await api('PATCH', `/api/pesticide-usage/${pestLocationEditId}`, { location_description, notes });
    el('pest-location-modal').classList.add('hidden');
    pestLocationLoaded = false;
    await loadPestLocationList();
    pestLocationLoaded = true;
    showToast('Location saved');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Reports Panel ─────────────────────────────────────────────────────────────
function updatePestReportLabel() {
  const d = new Date(pestReportYear, pestReportMonth - 1, 1);
  el('pest-report-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

el('pest-report-prev').addEventListener('click', () => {
  pestReportMonth--;
  if (pestReportMonth < 1) { pestReportMonth = 12; pestReportYear--; }
  updatePestReportLabel();
  pestReportLoaded = false;
  loadPestReport();
});

el('pest-report-next').addEventListener('click', () => {
  pestReportMonth++;
  if (pestReportMonth > 12) { pestReportMonth = 1; pestReportYear++; }
  updatePestReportLabel();
  pestReportLoaded = false;
  loadPestReport();
});

async function initPestReportsPanel() {
  updatePestReportLabel();
  if (pestReportLoaded) return;
  pestReportLoaded = true;
  await loadPestReport();
}

async function loadPestReport() {
  const out = el('pest-report-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', `/api/pesticide-usage/monthly?year=${pestReportYear}&month=${pestReportMonth}`);
    if (!rows.length) {
      out.innerHTML = '<div class="issue-empty">No usage recorded for this month.</div>';
      return;
    }
    const tbody = rows.map(r =>
      `<tr>
        <td>${escHtml(r.pesticide_name)}</td>
        <td class="report-num">${Number(r.total_quantity).toLocaleString()}</td>
        <td>${escHtml(r.unit_of_measure)}</td>
        <td class="report-num">${r.entry_count}</td>
      </tr>`
    ).join('');
    out.innerHTML = `<table class="report-table">
      <thead><tr>
        <th>Pesticide</th>
        <th class="report-num">Total Used</th>
        <th>Unit</th>
        <th class="report-num">Entries</th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
  } catch (err) {
    out.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Products Panel ────────────────────────────────────────────────────────────
async function initPestProductsPanel() {
  if (pestProductsLoaded) return;
  pestProductsLoaded = true;
  await loadPestProductList();
}

el('pest-product-new-btn').addEventListener('click', () => {
  el('pest-product-form').classList.remove('hidden');
  el('pest-product-name').value = '';
  el('pest-product-epa').value  = '';
  el('pest-product-uom').value  = '';
  el('pest-product-new-btn').style.display = 'none';
});

el('pest-product-cancel-btn').addEventListener('click', () => {
  el('pest-product-form').classList.add('hidden');
  el('pest-product-new-btn').style.display = '';
});

el('pest-product-save-btn').addEventListener('click', async () => {
  const name = el('pest-product-name').value.trim();
  const epa_reg_number = el('pest-product-epa').value.trim();
  const unit_of_measure = el('pest-product-uom').value.trim();
  if (!name) return showToast('Product name is required', 'error');
  if (!unit_of_measure) return showToast('Unit of measure is required', 'error');
  try {
    await api('POST', '/api/pesticides', { name, epa_reg_number, unit_of_measure });
    el('pest-product-form').classList.add('hidden');
    el('pest-product-new-btn').style.display = '';
    pestProductsLoaded = false;
    await loadPestProductList();
    pestProductsLoaded = true;
    showToast('Product added');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadPestProductList() {
  const list = el('pest-product-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const products = await api('GET', '/api/pesticides');
    if (!products.length) { list.innerHTML = '<div class="issue-empty">No products added yet.</div>'; return; }
    const isSupervisor = currentUser && (currentUser.role === 'supervisor' || currentUser.role === 'admin');
    list.innerHTML = products.map(p => `
      <div class="pest-product-item ${p.active ? '' : 'pest-product-inactive'}">
        <div class="pest-product-main">
          <span class="pest-product-name">${escHtml(p.name)}</span>
          ${!p.active ? '<span class="pest-inactive-badge">Inactive</span>' : ''}
        </div>
        <div class="pest-product-meta">
          ${p.epa_reg_number ? `EPA: ${escHtml(p.epa_reg_number)} · ` : ''}${escHtml(p.unit_of_measure)}
        </div>
        ${isSupervisor ? `<div class="pest-product-actions">
          <button class="btn btn-secondary btn-xs pest-toggle-btn" data-id="${p.pesticide_id}" data-active="${p.active}">
            ${p.active ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>` : ''}
      </div>`
    ).join('');
    if (isSupervisor) {
      list.querySelectorAll('.pest-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const newActive = btn.dataset.active === 'true' ? false : true;
          try {
            await api('PATCH', `/api/pesticides/${btn.dataset.id}`, { active: newActive });
            pestProductsLoaded = false;
            pestUsageLoaded = false; // refresh select on next open
            await loadPestProductList();
            pestProductsLoaded = true;
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });
    }
  } catch (err) {
    list.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

/* ── Reports ─────────────────────────────────────────────────────────────── */
let reportsMonth    = new Date().getMonth() + 1;
let reportsYear     = new Date().getFullYear();
let kfReportMonth   = new Date().getMonth() + 1;
let kfReportYear    = new Date().getFullYear();
let kfStartDate     = '';
let kfEndDate       = '';
let vehicleReportType = 'mileage';
let lastReportRows  = [];

// ── Navigation ────────────────────────────────────────────────────────────────
function initReportsScreen() {
  // Just ensure main tile grid is visible and panels are closed
  el('report-main').classList.remove('hidden');
  ['vehicles','kf','maintenance','pms'].forEach(c => el(`report-panel-${c}`).classList.add('hidden'));
}

function openReportPanel(cat) {
  el('report-main').classList.add('hidden');
  el(`report-panel-${cat}`).classList.remove('hidden');
  if (cat === 'vehicles')    initVehicleReportPanel();
  if (cat === 'kf')          initKFReportPanel();
  if (cat === 'maintenance') initMaintenanceReportPanel();
  if (cat === 'pms')         initPMReportPanel();
}

function closeReportPanel() {
  ['vehicles','kf','maintenance','pms'].forEach(c => el(`report-panel-${c}`).classList.add('hidden'));
  el('report-main').classList.remove('hidden');
}

el('screen-reports').addEventListener('click', e => {
  const tile = e.target.closest('[data-report-cat]');
  if (tile) openReportPanel(tile.dataset.reportCat);
});
el('report-vehicles-back').addEventListener('click', closeReportPanel);
el('report-kf-back').addEventListener('click', closeReportPanel);
el('report-maint-back').addEventListener('click', closeReportPanel);
el('report-pms-back').addEventListener('click', closeReportPanel);

// ── Vehicles Panel ────────────────────────────────────────────────────────────
function updateReportsMonthLabel() {
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  el('report-month-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function initVehicleReportPanel() {
  updateReportsMonthLabel();
  runVehicleReport();
}

async function runVehicleReport() {
  el('report-export-btn').style.display = vehicleReportType === 'mileage' ? '' : 'none';
  if (vehicleReportType === 'mileage') await renderMileageReport();
  else                                  await renderVehicleServiceReport();
}

document.querySelectorAll('#vehicle-report-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#vehicle-report-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    vehicleReportType = btn.dataset.val;
    runVehicleReport();
  });
});

el('report-prev-month').addEventListener('click', () => {
  reportsMonth--;
  if (reportsMonth < 1) { reportsMonth = 12; reportsYear--; }
  updateReportsMonthLabel();
  runVehicleReport();
});
el('report-next-month').addEventListener('click', () => {
  reportsMonth++;
  if (reportsMonth > 12) { reportsMonth = 1; reportsYear++; }
  updateReportsMonthLabel();
  runVehicleReport();
});

function buildMileageHTML(rows, year, month) {
  const d = new Date(year, month - 1, 1);
  const monthName = d.toLocaleDateString('en-US', { month: 'long' });
  const trucks = rows.filter(r => !r.reading_type || r.reading_type === 'odometer');
  const heavy  = rows.filter(r => r.reading_type === 'hours' || r.reading_type === 'both');
  const ac = v => (v.assigned_user && v.assigned_user.trim().toLowerCase() !== 'ops & maint') ? v.assigned_user : '';
  const miss = `<span style="color:var(--red-light);font-weight:600">✗</span>`;
  const truckRows = trucks.map(v => `<tr>
    <td>${v.vehicle_number||''}</td><td>${v.make||''}</td><td>${v.model||''}</td><td>${ac(v)}</td>
    <td class="report-num">${v.odometer_miles!=null?Number(v.odometer_miles).toLocaleString():miss}</td>
  </tr>`).join('');
  const heavyRows = heavy.map(v => `<tr>
    <td>${v.vehicle_number||''}</td><td>${v.make||''}</td><td>${v.model||''}</td><td>${ac(v)}</td>
    <td class="report-num">${v.odometer_miles!=null?Number(v.odometer_miles).toLocaleString():(v.reading_type==='hours'?'—':miss)}</td>
    <td class="report-num">${v.engine_hours!=null?Number(v.engine_hours).toFixed(1):miss}</td>
  </tr>`).join('');
  return `
    <div class="report-title">CVC Mileage</div>
    <div class="report-subtitle">${monthName} ${year}</div>
    <div class="report-section-title">Trucks</div>
    ${trucks.length ? `<table class="report-table trucks">
      <colgroup><col><col><col><col><col></colgroup>
      <thead><tr><th>Unit #</th><th>Make</th><th>Model</th><th>Operator</th><th class="report-num">Odometer</th></tr></thead>
      <tbody>${truckRows}</tbody></table>`
    : '<div class="report-empty">No active trucks.</div>'}
    <div class="report-section-title">Heavy Equipment</div>
    ${heavy.length ? `<table class="report-table heavy">
      <colgroup><col><col><col><col><col><col></colgroup>
      <thead><tr><th>Unit #</th><th>Make</th><th>Model</th><th>Operator</th><th class="report-num">Odometer</th><th class="report-num">Eng. Hours</th></tr></thead>
      <tbody>${heavyRows}</tbody></table>`
    : '<div class="report-empty">No active heavy equipment.</div>'}`;
}

async function renderMileageReport() {
  const out = el('report-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    lastReportRows = await api('GET', `/api/reports/mileage?year=${reportsYear}&month=${reportsMonth}`);
    out.innerHTML = `<div class="report-card">${buildMileageHTML(lastReportRows, reportsYear, reportsMonth)}</div>`;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

async function renderVehicleServiceReport() {
  const out = el('report-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/reports/vehicle-service');
    const trucks = rows.filter(r => !r.reading_type || r.reading_type === 'odometer' || r.reading_type === 'both');
    const heavy  = rows.filter(r => r.reading_type === 'hours');

    const fmtOdo  = v => v != null ? Number(v).toLocaleString() + ' mi' : '—';
    const fmtHrs  = v => v != null ? Number(v).toFixed(1) + ' hrs' : '—';
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const diffCell = (cur, svc) => {
      if (cur == null || svc == null) return '<td class="report-num">—</td>';
      const diff = Number(cur) - Number(svc);
      const cls  = diff > 0 ? '' : '';
      return `<td class="report-num">${Number(diff).toLocaleString()}</td>`;
    };
    const nextCell = (cur, next) => {
      if (next == null) return '<td class="report-num">—</td>';
      const remaining = cur != null ? Number(next) - Number(cur) : null;
      const remColor = remaining < 0 ? 'var(--red-light)' : 'var(--text-dim)';
      const remText  = remaining >= 0 ? `${remaining.toLocaleString()} to go` : 'OVERDUE';
      const rem = remaining != null ? ` <span style="color:${remColor};font-size:0.8em">(${remText})</span>` : '';
      return `<td class="report-num">${Number(next).toLocaleString()}${rem}</td>`;
    };

    const truckRows = trucks.map(v => `<tr>
      <td>${v.vehicle_number||''}</td>
      <td>${fmtOdo(v.current_odometer)}<br><small style="color:var(--text-dim)">${fmtDate(v.current_reading_date)}</small></td>
      <td>${fmtOdo(v.odometer_at_service)}<br><small style="color:var(--text-dim)">${fmtDate(v.last_service_date)}</small></td>
      ${diffCell(v.current_odometer, v.odometer_at_service)}
      ${nextCell(v.current_odometer, v.next_service_miles)}
    </tr>`).join('');

    const heavyRows = heavy.map(v => `<tr>
      <td>${v.vehicle_number||''}</td>
      <td>${fmtHrs(v.current_engine_hours)}<br><small style="color:var(--text-dim)">${fmtDate(v.current_reading_date)}</small></td>
      <td>${fmtHrs(v.engine_hours_at_service)}<br><small style="color:var(--text-dim)">${fmtDate(v.last_service_date)}</small></td>
      ${diffCell(v.current_engine_hours, v.engine_hours_at_service)}
      ${nextCell(v.current_engine_hours, v.next_service_hours)}
    </tr>`).join('');

    out.innerHTML = `<div class="report-card">
      <div class="report-title">Last Service</div>
      <div class="report-section-title">Trucks</div>
      ${trucks.length ? `<table class="report-table">
        <thead><tr><th>Unit #</th><th class="report-num">Current Odo</th><th class="report-num">Service Odo</th><th class="report-num">Difference</th><th class="report-num">Next Service</th></tr></thead>
        <tbody>${truckRows}</tbody></table>`
      : '<div class="report-empty">No trucks.</div>'}
      <div class="report-section-title">Heavy Equipment</div>
      ${heavy.length ? `<table class="report-table">
        <thead><tr><th>Unit #</th><th class="report-num">Current Hrs</th><th class="report-num">Service Hrs</th><th class="report-num">Difference</th><th class="report-num">Next Service</th></tr></thead>
        <tbody>${heavyRows}</tbody></table>`
      : '<div class="report-empty">No heavy equipment.</div>'}
    </div>`;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── KF Panel ──────────────────────────────────────────────────────────────────
function kfMonthBounds() {
  const y = kfReportYear, m = kfReportMonth;
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  kfStartDate = `${y}-${pad(m)}-01`;
  kfEndDate   = `${y}-${pad(m)}-${pad(lastDay)}`;
  el('report-start-date').value = kfStartDate;
  el('report-end-date').value   = kfEndDate;
}

function syncKfDatesFromInputs() {
  kfStartDate = el('report-start-date').value;
  kfEndDate   = el('report-end-date').value;
}

function updateKFReportMonthLabel() {
  const d = new Date(kfReportYear, kfReportMonth - 1, 1);
  el('kf-report-month-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function initKFReportPanel() {
  if (!kfStartDate) {
    // Default to widget dates if available, else current month
    if (kfWidgetStart && kfWidgetEnd) {
      kfStartDate = kfWidgetStart;
      kfEndDate   = kfWidgetEnd;
      const [y, m] = kfWidgetStart.split('-').map(Number);
      kfReportYear = y; kfReportMonth = m;
      el('report-start-date').value = kfStartDate;
      el('report-end-date').value   = kfEndDate;
    } else {
      kfMonthBounds();
    }
  }
  updateKFReportMonthLabel();
  renderKFReport();
}

el('kf-report-prev-month').addEventListener('click', () => {
  kfReportMonth--;
  if (kfReportMonth < 1) { kfReportMonth = 12; kfReportYear--; }
  kfMonthBounds();
  updateKFReportMonthLabel();
  renderKFReport();
});
el('kf-report-next-month').addEventListener('click', () => {
  kfReportMonth++;
  if (kfReportMonth > 12) { kfReportMonth = 1; kfReportYear++; }
  kfMonthBounds();
  updateKFReportMonthLabel();
  renderKFReport();
});
el('report-start-date').addEventListener('change', () => { syncKfDatesFromInputs(); renderKFReport(); });
el('report-end-date').addEventListener('change',   () => { syncKfDatesFromInputs(); renderKFReport(); });

async function renderKFReport() {
  if (!kfStartDate || !kfEndDate) kfMonthBounds();
  const out = el('report-kf-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const fmtDate = s => localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' });
    const subtitle = kfStartDate === kfEndDate
      ? fmtDate(kfStartDate)
      : `${fmtDate(kfStartDate)} – ${fmtDate(kfEndDate)}`;

    const [{ rows, distinctRead, totalWells }, sets] = await Promise.all([
      api('GET', `/api/reports/kf-operators?start_date=${kfStartDate}&end_date=${kfEndDate}`),
      api('GET', `/api/reports/kf-sets?start_date=${kfStartDate}&end_date=${kfEndDate}`),
    ]);

    const completePct = totalWells > 0 ? (distinctRead / totalWells * 100).toFixed(0) : 0;

    const opRowsHTML = rows.length
      ? rows.map(r => {
          const pct = totalWells > 0 ? (parseInt(r.wells_read) / totalWells * 100).toFixed(1) : '0.0';
          return `<tr>
            <td>${r.operator}</td>
            <td class="report-num">${r.wells_read}</td>
            <td class="report-num">${pct}%</td>
            <td><div class="kf-op-bar-wrap"><div class="kf-op-bar" style="width:${pct}%"></div></div></td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No readings for this period</td></tr>`;

    const setRowsHTML = sets.map(s => {
      const read  = parseInt(s.wells_read);
      const total = parseInt(s.total_wells);
      const pct   = total > 0 ? (read / total * 100).toFixed(0) : 0;
      const raw   = s.set_name || '';
      const label = /^set\s/i.test(raw) ? raw : `Set ${raw}`;
      return `<tr>
        <td>${label}</td>
        <td class="report-num">${read} / ${total}</td>
        <td class="report-num">${pct}%</td>
        <td><div class="kf-op-bar-wrap"><div class="kf-op-bar" style="width:${pct}%"></div></div></td>
      </tr>`;
    }).join('');

    out.innerHTML = `<div class="report-card">
      <div class="report-title">KF Breakdown</div>
      <div class="report-subtitle">${subtitle}</div>
      <div class="kf-complete-banner">
        <span class="kf-complete-fraction">${distinctRead} / ${totalWells}</span>
        <span class="kf-complete-label">wells complete</span>
        <span class="kf-complete-pct">${completePct}%</span>
      </div>
      <div class="report-section-title">By Operator</div>
      <table class="report-table">
        <thead><tr><th>Operator</th><th class="report-num">Wells</th><th class="report-num">% of Total</th><th></th></tr></thead>
        <tbody>${opRowsHTML}</tbody>
      </table>
      <div class="report-section-title">By Set</div>
      <table class="report-table">
        <thead><tr><th>Set</th><th class="report-num">Complete</th><th class="report-num">%</th><th></th></tr></thead>
        <tbody>${setRowsHTML}</tbody>
      </table>
    </div>`;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Maintenance Issues Panel ───────────────────────────────────────────────────
function initMaintenanceReportPanel() {
  renderMaintenanceIssuesReport();
}

async function renderMaintenanceIssuesReport() {
  const out = el('report-maint-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/reports/maintenance-issues');
    const categories = ['Wells', 'Buildings', 'Equipment'];
    let html = '<div class="report-card"><div class="report-title">Open Maintenance Issues</div>';
    categories.forEach(cat => {
      const issues = rows.filter(r => r.category === cat);
      html += `<div class="report-section-title">${cat}</div>`;
      if (!issues.length) {
        html += '<div class="report-empty">No open issues.</div>';
      } else {
        issues.forEach(r => {
          const statusCls = r.status === 'in_progress' ? 'in-progress' : 'open';
          html += `<div class="maint-issue-report-row">
            <div class="maint-issue-report-header">
              <span class="status-pill ${statusCls}">${r.status.replace('_',' ')}</span>
              <span class="maint-issue-report-name">${escHtml(r.location_name)}</span>
              <span class="maint-issue-report-date">${localDateStr(r.reported_date, {month:'short',day:'numeric',year:'numeric'})}</span>
            </div>
            <div class="maint-issue-report-desc">${escHtml(r.description)}</div>
            ${r.action_taken ? `<div class="maint-issue-report-action">Action: ${escHtml(r.action_taken)}</div>` : ''}
            ${r.assigned_to  ? `<div class="maint-issue-report-meta">Assigned: ${escHtml(r.assigned_to)}</div>` : ''}
          </div>`;
        });
      }
    });
    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── PM Grid Panel ─────────────────────────────────────────────────────────────
let pmsYear  = new Date().getFullYear();
let pmsMonth = new Date().getMonth() + 1;
let pmsAllTime = true;

function updatePMsMonthLabel() {
  const d = new Date(pmsYear, pmsMonth - 1, 1);
  el('pms-month-label').textContent = pmsAllTime
    ? 'All Time'
    : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

el('pms-prev-month').addEventListener('click', () => {
  pmsAllTime = false;
  pmsMonth--;
  if (pmsMonth < 1) { pmsMonth = 12; pmsYear--; }
  updatePMsMonthLabel();
  renderPMGridReport();
});
el('pms-next-month').addEventListener('click', () => {
  pmsAllTime = false;
  pmsMonth++;
  if (pmsMonth > 12) { pmsMonth = 1; pmsYear++; }
  updatePMsMonthLabel();
  renderPMGridReport();
});
el('pms-all-time').addEventListener('click', () => {
  pmsAllTime = true;
  updatePMsMonthLabel();
  renderPMGridReport();
});

function initPMReportPanel() {
  updatePMsMonthLabel();
  renderPMGridReport();
}

async function renderPMGridReport() {
  const out = el('report-pms-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  const qs = pmsAllTime ? '' : `?year=${pmsYear}&month=${pmsMonth}`;
  try {
    const { sbRecords, acRecords, positions } = await api('GET', `/api/reports/pm-grid${qs}`);

    // Build ordered plant list from positions; normalize "Site N" → "Pumping Plant N"
    const toPlantName = n => n.replace(/\bSite\b/g, 'Pumping Plant');
    const plantMap = {};
    positions.forEach(p => {
      const key = toPlantName(p.site_name);
      if (!plantMap[key]) plantMap[key] = { name: key, rawName: p.site_name, num: p.site_number || '' };
    });
    const plants = Object.values(plantMap).sort((a, b) => Number(a.num) - Number(b.num));

    // All unique pump letters sorted
    const pumpLetters = [...new Set(positions.map(p => p.pump_letter))].sort();

    // ── Siphon Breakers: rows = plants, columns = pump letters ───────────────
    const sbCols = pumpLetters.map(l => `<th class="pmgrid-th">${l}</th>`).join('');
    let sbRows = '';
    plants.forEach(plant => {
      const checklist = sbRecords[plant.name]?.checklist || null;
      sbRows += `<tr><td class="pmgrid-plant-label">PP ${plant.num}</td>`;
      pumpLetters.forEach(letter => {
        const pos = positions.find(p => p.site_name === plant.rawName && p.pump_letter === letter);
        if (!pos) { sbRows += '<td></td>'; return; }
        const val = checklist?.[`pos_${pos.position_id}`];
        let cls, text;
        if (!checklist)     { cls = 'empty'; text = '—'; }
        else if (!val)      { cls = 'empty'; text = '—'; }
        else if (val.checked) { cls = val.notes ? 'note' : 'pass'; text = val.notes ? '!' : '✓'; }
        else                { cls = 'fail';  text = '✗'; }
        const noteAttr = val?.notes ? ` data-note="${escHtml(val.notes)}"` : '';
        sbRows += `<td><span class="pmgrid-badge ${cls}"${noteAttr} title="${escHtml(val?.notes||'')}">${text}</span></td>`;
      });
      const sbRec = sbRecords[plant.name];
      const recDate = sbRec ? localDateStr(sbRec.completed_date, {month:'short',day:'numeric'}) : '—';
      sbRows += `<td class="pmgrid-date-col">${recDate}</td>`;
      sbRows += `<td><button class="pmgrid-hist-btn" data-pm-type="siphon_breaker" data-pm-building="${escHtml(plant.name)}" data-pm-label="PP ${escHtml(plant.num)} Siphon Breakers" title="View history">&#128203;</button></td></tr>`;
    });

    const sbHtml = `<div class="pmgrid-section-title">Siphon Breakers</div>
      <div class="pmgrid-scroll"><table class="pmgrid-table">
        <thead><tr><th class="pmgrid-th pmgrid-th-left">Plant</th>${sbCols}<th class="pmgrid-th">Last PM</th><th class="pmgrid-th">Hist</th></tr></thead>
        <tbody>${sbRows || '<tr><td colspan="99" class="report-empty">No positions found.</td></tr>'}</tbody>
      </table></div>`;

    // ── Air Compressors: rows = checks, columns = plants ─────────────────────
    const acChecks = PM_TYPES.air_compressor.checks;
    const acCols = plants.map(p => `<th class="pmgrid-th">PP ${p.num}</th>`).join('');
    let acRows = '';
    acChecks.forEach(check => {
      acRows += `<tr><td class="pmgrid-check-label">${escHtml(check.label)}</td>`;
      plants.forEach(plant => {
        const cl   = acRecords[plant.name]?.checklist || null;
        const aVal = cl?.['a']?.[check.key];
        const bVal = cl?.['b']?.[check.key];
        const aCls = aVal === true ? 'pass' : (aVal === false ? 'fail' : 'empty');
        const bCls = bVal === true ? 'pass' : (bVal === false ? 'fail' : 'empty');
        acRows += `<td><div class="pmgrid-ac-cell">
          <span class="pmgrid-ac-dot ${aCls}" title="Bldg A"></span>
          <span class="pmgrid-ac-dot ${bCls}" title="Bldg B"></span>
        </div></td>`;
      });
      acRows += '</tr>';
    });
    // Last PM date row
    acRows += `<tr><td class="pmgrid-check-label" style="font-style:italic;color:var(--text-dim)">Last PM</td>`;
    plants.forEach(plant => {
      const rec = acRecords[plant.name];
      acRows += `<td class="pmgrid-date-col">${rec ? localDateStr(rec.completed_date, {month:'short',day:'numeric'}) : '—'}</td>`;
    });
    acRows += '</tr>';
    // History row
    acRows += `<tr><td class="pmgrid-check-label" style="font-style:italic;color:var(--text-dim)">History</td>`;
    plants.forEach(plant => {
      acRows += `<td><button class="pmgrid-hist-btn" data-pm-type="air_compressor" data-pm-building="${escHtml(plant.name)}" data-pm-label="PP ${escHtml(plant.num)} Air Compressors" title="View history">&#128203;</button></td>`;
    });
    acRows += '</tr>';

    const acHtml = `<div class="pmgrid-section-title" style="margin-top:20px">Air Compressors
      <span class="pmgrid-legend"> &nbsp;●A &nbsp;●B per plant</span></div>
      <div class="pmgrid-scroll"><table class="pmgrid-table">
        <thead><tr><th class="pmgrid-th pmgrid-th-left">Check</th>${acCols}</tr></thead>
        <tbody>${acRows}</tbody>
      </table></div>`;

    out.innerHTML = `<div class="report-card">${sbHtml}${acHtml}</div>`;

    // Tappable ! badges — show note popup
    out.querySelectorAll('.pmgrid-badge.note[data-note]').forEach(badge => {
      badge.style.cursor = 'pointer';
      badge.addEventListener('click', e => {
        e.stopPropagation();
        showPMNotePopup(badge, badge.dataset.note);
      });
    });

    out.querySelectorAll('.pmgrid-hist-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        openPMGridHistory(btn.dataset.pmType, btn.dataset.pmBuilding, btn.dataset.pmLabel)
      );
    });
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

function showPMNotePopup(anchor, noteText) {
  const popup = el('pmgrid-note-popup');
  popup.textContent = noteText;
  popup.classList.remove('hidden');
  // Position below the badge
  const rect = anchor.getBoundingClientRect();
  const scrollY = window.scrollY || window.pageYOffset;
  const scrollX = window.scrollX || window.pageXOffset;
  popup.style.top  = `${rect.bottom + scrollY + 6}px`;
  popup.style.left = `${Math.min(rect.left + scrollX, window.innerWidth - 220)}px`;
  // Dismiss on next tap/click anywhere
  const dismiss = () => { popup.classList.add('hidden'); document.removeEventListener('click', dismiss, true); };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

async function openPMGridHistory(pmType, building, label) {
  const def = PM_TYPES[pmType];
  el('pm-view-modal-title').textContent = label || def.title;
  const body = el('pm-view-modal-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  el('pm-view-modal').classList.remove('hidden');

  try {
    const rows = await api('GET', `/api/pm-records?type=${pmType}&building=${encodeURIComponent(building)}`);
    rows.forEach(r => { pmHistoryCache[r.pm_id] = r; });
    if (!rows.length) {
      body.innerHTML = '<div class="issue-empty">No records for this plant yet.</div>';
      return;
    }
    body.innerHTML = rows.map(r => {
      const d = localDateStr(r.completed_date, { month: 'short', day: 'numeric', year: 'numeric' });
      const t = r.completed_time?.slice(0, 5) || '';
      let totalItems = 0, checkedCount = 0;
      if (def.customType === 'siphon') {
        const vals = Object.values(r.checklist);
        totalItems   = vals.length;
        checkedCount = vals.filter(v => v?.checked === true).length;
      } else if (def.customType === 'air_compressor') {
        Object.values(r.checklist).forEach(comp => {
          if (comp && typeof comp === 'object') Object.values(comp).forEach(v => { totalItems++; if (v === true) checkedCount++; });
        });
      }
      const hasNotes = r.notes || Object.values(r.checklist).some(v => v?.notes);
      return `<div class="pm-history-item">
        <div class="pm-history-header">
          <span class="pm-history-date">${d}${t ? ' · ' + t : ''}</span>
          ${hasNotes ? '<span class="pmgrid-badge note" style="font-size:0.75rem">!</span>' : ''}
        </div>
        <div class="pm-history-meta">${escHtml(r.completed_by_name || 'Unknown')} · ${checkedCount}/${totalItems} items${r.notes ? ' · ' + escHtml(r.notes) : ''}</div>
        <div class="pm-history-actions"><button class="btn btn-secondary btn-xs" data-pm-view="${r.pm_id}">View</button></div>
      </div>`;
    }).join('');

    body.querySelectorAll('[data-pm-view]').forEach(btn => {
      btn.addEventListener('click', () => showPMRecord(pmHistoryCache[parseInt(btn.dataset.pmView)], def));
    });
  } catch (err) {
    body.innerHTML = `<div class="issue-empty" style="color:var(--red-light)">${err.message}</div>`;
  }
}

/* ── Export Modal ────────────────────────────────────────────────────────── */
el('report-export-btn').addEventListener('click', () => {
  if (!lastReportRows.length) return showToast('No report data to export', 'error');
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  el('export-modal-subtitle').textContent = `CVC Mileage — ${label}`;
  el('export-modal').classList.remove('hidden');
});

el('export-modal-close').addEventListener('click', () => el('export-modal').classList.add('hidden'));
el('export-modal').addEventListener('click', e => {
  if (e.target === el('export-modal')) el('export-modal').classList.add('hidden');
});

function triggerBlobDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

el('export-csv-btn').addEventListener('click', () => {
  el('export-modal').classList.add('hidden');
  // CSV generated entirely client-side — no server call, no session issues
  const ac = v => (v.assigned_user && v.assigned_user.trim().toLowerCase() !== 'ops & maint') ? v.assigned_user : '';
  const trucks = lastReportRows.filter(r => !r.reading_type || r.reading_type === 'odometer');
  const heavy  = lastReportRows.filter(r => r.reading_type === 'hours' || r.reading_type === 'both');
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const lines = [`CVC Mileage — ${label}`, '', 'TRUCKS', 'Unit #,Make,Model,Operator,Odometer'];
  trucks.forEach(v => lines.push([v.vehicle_number, v.make, v.model, ac(v), v.odometer_miles ?? ''].join(',')));
  lines.push('', 'HEAVY EQUIPMENT', 'Unit #,Make,Model,Operator,Odometer,Engine Hours');
  heavy.forEach(v => lines.push([v.vehicle_number, v.make, v.model, ac(v), v.odometer_miles ?? '', v.engine_hours ?? ''].join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  triggerBlobDownload(blob, `CVC_Mileage_${reportsYear}_${reportsMonth}.csv`);
});

el('export-xlsx-btn').addEventListener('click', async () => {
  el('export-modal').classList.add('hidden');
  try {
    // Get a one-time token so fetch works without relying on session cookie
    const { token } = await api('POST', '/api/reports/download-token',
      { year: reportsYear, month: reportsMonth });
    const url = `/api/reports/mileage/export?format=xlsx&year=${reportsYear}&month=${reportsMonth}&token=${token}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    triggerBlobDownload(blob, `CVC_Mileage_${reportsYear}_${reportsMonth}.xlsx`);
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
});

el('export-pdf-btn').addEventListener('click', () => {
  // Clone report into a dedicated print area
  let printArea = document.getElementById('print-area');
  if (!printArea) {
    printArea = document.createElement('div');
    printArea.id = 'print-area';
    document.body.appendChild(printArea);
  }
  printArea.innerHTML = buildMileageHTML(lastReportRows, reportsYear, reportsMonth);
  el('export-modal').classList.add('hidden');
  setTimeout(() => window.print(), 100);
});

/* ── Left-edge swipe to go back (system-wide) ────────────────────────────── */
(function () {
  let startX = 0, startY = 0, tracking = false;
  const EDGE = 30, MIN_DIST = 60, MAX_VERT = 80;

  document.addEventListener('touchstart', e => {
    const t = e.touches[0];
    tracking = t.clientX <= EDGE;
    if (tracking) { startX = t.clientX; startY = t.clientY; }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (dx < MIN_DIST || dy > MAX_VERT) return;
    triggerContextualBack();
  }, { passive: true });

  function triggerContextualBack() {
    const activeScreen = document.querySelector('.screen-content.active');
    const id = activeScreen?.id;

    if (id === 'screen-maintenance') {
      if (document.querySelector('#maint-panel-pms .pm-panel:not(.hidden)')) return closePMType();
      if (document.querySelector('.maint-panel:not(.hidden)')) return closeMaintPanel();
      return showScreen('dashboard');
    }
    if (id === 'screen-pesticides') {
      if (document.querySelector('#screen-pesticides .maint-panel:not(.hidden)')) return closePestPanel();
      return showScreen('dashboard');
    }
    if (id === 'screen-reports') {
      if (document.querySelector('#screen-reports .maint-panel:not(.hidden)')) return closeReportPanel();
      return showScreen('dashboard');
    }
    if (id === 'screen-admin') {
      if (document.querySelector('.settings-panel:not(.hidden)')) return closeSettingsPanel();
      return showScreen('dashboard');
    }
    if (activeScreen && id !== 'screen-dashboard') {
      showScreen('dashboard');
    }
  }
})();

/* ── Well Runs ───────────────────────────────────────────────────────────── */
const DWR_NO_MEAS = [
  { code: '0', label: 'Meas. Discontinued' },
  { code: '1', label: 'Pumping' },
  { code: '2', label: 'Pump house locked' },
  { code: '3', label: 'Tape hung up' },
  { code: '4', label: "Can't get tape in" },
  { code: '5', label: 'Unable to locate' },
  { code: '6', label: 'Well destroyed' },
  { code: '7', label: 'Special' },
  { code: '8', label: 'Casing leaking or wet' },
  { code: '9', label: 'Temp. inaccessible' },
  { code: 'D', label: 'Dry' },
];
const DWR_QUEST_MEAS = [
  { code: '0', label: 'Caved or deepened' },
  { code: '1', label: 'Pumping' },
  { code: '2', label: 'Nearby pump operating' },
  { code: '3', label: 'Casing leaking or wet' },
  { code: '4', label: 'Pumped recently' },
  { code: '5', label: 'Air gauge meas.' },
  { code: '6', label: 'Other' },
  { code: '7', label: 'Recharge operation nearby' },
  { code: '8', label: 'Oil in casing' },
  { code: '9', label: 'Acoustic sounder meas.' },
];

let dwrWells = [];
let dwrDoneThisSession = new Set(); // well_ids saved this session

function initWellRunsScreen() {
  // Sub-dashboard tiles
  document.querySelectorAll('[data-wr-panel]').forEach(tile => {
    tile.addEventListener('click', () => {
      const panel = tile.dataset.wrPanel;
      el('well-runs-main').classList.add('hidden');
      if (panel === 'dwr') {
        el('wr-panel-dwr').classList.remove('hidden');
        initDWRScreen();
      } else {
        el('wr-panel-soon').classList.remove('hidden');
      }
    });
  });
  el('wr-dwr-back').addEventListener('click', () => {
    el('wr-panel-dwr').classList.add('hidden');
    el('well-runs-main').classList.remove('hidden');
  });
  el('wr-soon-back').addEventListener('click', () => {
    el('wr-panel-soon').classList.add('hidden');
    el('well-runs-main').classList.remove('hidden');
  });
}

let dwrLoaded = false;
async function initDWRScreen() {
  el('dwr-date').value = todayISO();
  el('dwr-time').value = nowHHMM();

  if (!dwrLoaded) {
    el('dwr-list-body').innerHTML = '<div class="placeholder-msg">Loading…</div>';
    try {
      dwrWells = await api('GET', '/api/wells/dwr');
      dwrLoaded = true;
    } catch (err) {
      el('dwr-list-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
      return;
    }
  }

  el('dwr-map-btn').onclick = () => openSetMapModal('DWR Wells', dwrWells);
  renderDWRList();
}

function renderDWRList() {
  const body    = el('dwr-list-body');
  const dateIn  = el('dwr-date');
  const timeIn  = el('dwr-time');

  body.innerHTML = '';
  el('dwr-total-count').textContent = dwrWells.length;
  updateDWRCounter();

  dwrWells.forEach(w => body.appendChild(createDWRItem(w, dateIn, timeIn)));
}

function updateDWRCounter() {
  // Count wells that are completed = saved this session OR reading within last 30 days
  const done = dwrWells.filter(w =>
    dwrDoneThisSession.has(w.well_id) ||
    (w.days_since_reading != null && w.days_since_reading <= 30)
  ).length;
  el('dwr-done-count').textContent = done;
}

function makeDWRMultiSelect(options, placeholder) {
  const wrap = document.createElement('div');
  wrap.className = 'dwr-ms-wrap form-group';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dwr-ms-btn';
  btn.textContent = placeholder;

  const panel = document.createElement('div');
  panel.className = 'dwr-ms-panel';

  options.forEach(opt => {
    const row = document.createElement('label');
    row.className = 'dwr-ms-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = opt.code;
    row.appendChild(cb);
    row.appendChild(document.createTextNode(`${opt.code}. ${opt.label}`));
    panel.appendChild(row);

    cb.addEventListener('change', () => {
      updateDWRMultiBtn(btn, panel, placeholder);
    });
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  // Close when clicking outside
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) panel.classList.remove('open');
  });

  wrap.appendChild(btn);
  wrap.appendChild(panel);

  wrap.getSelected = () =>
    [...panel.querySelectorAll('input:checked')].map(cb => cb.value);
  wrap.clearAll = () => {
    panel.querySelectorAll('input').forEach(cb => { cb.checked = false; });
    btn.textContent = placeholder;
    panel.querySelectorAll('.dwr-ms-option').forEach(r => r.classList.remove('selected'));
  };
  return wrap;
}

function updateDWRMultiBtn(btn, panel, placeholder) {
  const selected = [...panel.querySelectorAll('input:checked')];
  panel.querySelectorAll('.dwr-ms-option').forEach(r => {
    r.classList.toggle('selected', r.querySelector('input').checked);
  });
  if (!selected.length) {
    btn.textContent = placeholder;
  } else {
    btn.textContent = selected.map(cb => cb.value).join(', ');
  }
}

function createDWRItem(w, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const days = w.days_since_reading;
  const sessionDone = dwrDoneThisSession.has(w.well_id);
  const recent = sessionDone || (days != null && days <= 30);
  const noReading = days == null && !sessionDone;
  const pillCls = sessionDone || (days != null && days <= 30) ? 'wr-recent'
                : (days == null ? 'wr-none' : 'wr-old');
  const pillTxt = sessionDone ? 'Done'
                : (days != null ? localDateStr(w.last_reading_date, { month: 'short', day: 'numeric' }) : 'No reading');

  const prevDTW = w.last_dtw != null ? `${Number(w.last_dtw).toFixed(2)} ft`
                : (w.last_no_measurement?.length ? 'NM' : null);
  const wellLabel = w.state_well_number || w.common_name || 'Well';
  const hasGPS = w.gps_latitude && w.gps_longitude;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="list-item-name">${wellLabel}</span>
      <span class="status-badge ${pillCls}">${pillTxt}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    ${prevDTW ? `<div class="list-item-meta"><span>Prev: ${prevDTW}</span></div>` : ''}
    <div class="list-item-form" style="display:none">
      <div class="form-group">
        <label>Depth to Water (ft)${prevDTW ? `<span class="prev-hint"> · Prev: ${prevDTW}</span>` : ''}</label>
        <input type="number" class="ctrl-input dwr-dtw" step="0.01" placeholder="0.00">
      </div>
      <div class="dwr-ms-nm-slot"></div>
      <div class="dwr-ms-qm-slot"></div>
      <div class="form-group">
        <label>Method</label>
        <select class="ctrl-select dwr-method">
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
        <input type="text" class="ctrl-input dwr-op" placeholder="Initials" readonly>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea class="ctrl-textarea dwr-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${hasGPS ? `<button class="btn btn-secondary btn-sm dwr-map-item-btn">&#128205; Map</button>` : ''}
        <button class="btn btn-secondary btn-sm dwr-hist-btn">&#128200; History</button>
        <button class="btn btn-save dwr-save-btn">Save Reading</button>
      </div>
    </div>`;

  // Build multi-selects
  const nmWrap = makeDWRMultiSelect(DWR_NO_MEAS,    'No Measurement: none');
  const qmWrap = makeDWRMultiSelect(DWR_QUEST_MEAS, 'Questionable Measurement: none');
  div.querySelector('.dwr-ms-nm-slot').replaceWith(nmWrap);
  div.querySelector('.dwr-ms-qm-slot').replaceWith(qmWrap);

  // If any NM code selected → set DTW to NM
  const dtwInput = div.querySelector('.dwr-dtw');
  nmWrap.addEventListener('change', () => {
    const hasCodes = nmWrap.getSelected().length > 0;
    if (hasCodes) {
      dtwInput.value = '';
      dtwInput.placeholder = 'NM';
      dtwInput.classList.add('dwr-dtw-nm');
      dtwInput.disabled = true;
    } else {
      dtwInput.placeholder = '0.00';
      dtwInput.classList.remove('dwr-dtw-nm');
      dtwInput.disabled = false;
    }
  });

  // Auto-fill operator
  if (currentUser) div.querySelector('.dwr-op').value = currentUser.initials || currentUser.username;
  if (w.last_notes) div.querySelector('.dwr-notes').value = w.last_notes;

  // Map button (individual well)
  div.querySelector('.dwr-map-item-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const url = `https://maps.apple.com/?ll=${w.gps_latitude},${w.gps_longitude}&q=${encodeURIComponent(wellLabel)}`;
    window.open(url, '_blank');
  });

  // History button
  div.querySelector('.dwr-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('dwr', w.well_id, wellLabel);
  });

  // Expand/collapse — reset date/time on open
  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
    if (open) {
      dateInput.value = todayISO();
      timeInput.value = nowHHMM();
    }
  });

  // Save
  div.querySelector('.dwr-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');

    const nmCodes = nmWrap.getSelected();
    const qmCodes = qmWrap.getSelected();
    const dtwRaw  = dtwInput.value;
    const isNM    = nmCodes.length > 0;

    if (!isNM && dtwRaw === '') {
      errEl.textContent = 'Enter a depth or select a No Measurement code';
      errEl.classList.remove('hidden');
      return;
    }

    const body = {
      well_id:                  w.well_id,
      reading_date:             dateInput.value,
      reading_time:             timeInput.value,
      depth_to_water:           isNM ? null : parseFloat(dtwRaw),
      method:                   div.querySelector('.dwr-method').value || null,
      operator:                 div.querySelector('.dwr-op').value || null,
      no_measurement:           nmCodes,
      questionable_measurement: qmCodes,
      notes:                    div.querySelector('.dwr-notes').value || null,
    };

    try {
      await api('POST', '/api/readings/run-dwr', body, `DWR — ${w.common_name}`);

      // Mark as done in session
      dwrDoneThisSession.add(w.well_id);
      w.last_reading_date = body.reading_date;
      w.last_dtw = body.depth_to_water;
      w.days_since_reading = 0;

      // Update pill
      const pill = div.querySelector('.status-badge');
      pill.className = 'status-badge wr-recent';
      pill.textContent = 'Done';

      // Update prev hint
      const newPrev = isNM ? 'NM' : `${Number(dtwRaw).toFixed(2)} ft`;
      let meta = div.querySelector('.list-item-meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'list-item-meta';
        div.querySelector('.list-item-header').after(meta);
      }
      meta.innerHTML = `<span>Prev: ${newPrev}</span>`;

      // Collapse and reset
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      dtwInput.value = ''; dtwInput.disabled = false;
      dtwInput.placeholder = '0.00'; dtwInput.classList.remove('dwr-dtw-nm');
      nmWrap.clearAll(); qmWrap.clearAll();
      div.querySelector('.dwr-notes').value = body.notes || '';

      updateDWRCounter();
      showToast(`${w.common_name} saved`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  return div;
}

// ── Upload Tool ───────────────────────────────────────────────────────────────
(function () {
  const CATEGORIES = ['pumps','wells','vehicles','electrical','structures','misc'];
  let pendingFiles = [];     // File objects waiting to upload
  let previewFile  = null;   // { url, name, isPdf }

  function show(id)  { el(id).classList.remove('hidden'); }
  function hide(id)  { el(id).classList.add('hidden'); }

  /* ── Open / close ── */
  window.openUploadTool = function () {
    el('upload-tool-overlay').classList.remove('hidden');
    switchTab('upload');
  };

  el('uptool-back-btn').addEventListener('click', () => {
    el('upload-tool-overlay').classList.add('hidden');
  });

  /* ── Tabs ── */
  function switchTab(name) {
    document.querySelectorAll('.uptool-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.uptab === name);
    });
    el('uptool-tab-upload').classList.toggle('hidden', name !== 'upload');
    el('uptool-tab-browse').classList.toggle('hidden', name !== 'browse');
    if (name === 'browse') loadBrowse();
  }

  document.querySelectorAll('.uptool-tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.uptab));
  });

  /* ── Upload tab: file selection ── */
  const dropzone   = el('uptool-dropzone');
  const fileInput  = el('uptool-file-input');

  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    addFiles([...e.dataTransfer.files]);
  });

  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  function addFiles(files) {
    pendingFiles.push(...files);
    renderQueue();
  }

  function renderQueue() {
    const queue = el('uptool-queue');
    const actions = el('uptool-actions');
    hide('uptool-result');
    if (!pendingFiles.length) {
      queue.innerHTML = '';
      hide('uptool-queue'); hide('uptool-actions'); return;
    }
    show('uptool-queue'); show('uptool-actions');
    queue.innerHTML = pendingFiles.map((f, i) => {
      const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      const thumb = isPdf
        ? `<span class="uptool-qi-pdf">&#128196;</span>`
        : `<img src="${URL.createObjectURL(f)}" alt="">`;
      return `<div class="uptool-queue-item">${thumb}<div class="uptool-qi-name">${f.name}</div></div>`;
    }).join('');
  }

  el('uptool-clear-btn').addEventListener('click', () => {
    pendingFiles = [];
    renderQueue();
  });

  /* ── Upload tab: submit ── */
  el('uptool-upload-btn').addEventListener('click', async () => {
    if (!pendingFiles.length) return;
    const category = el('uptool-category').value;
    const fd = new FormData();
    pendingFiles.forEach(f => fd.append('files', f));

    hide('uptool-actions'); show('uptool-progress-wrap');
    const bar = el('uptool-progress-bar');
    bar.style.width = '0%';

    try {
      // Animate bar while uploading (fake progress; real progress via XHR if desired)
      let fakeT = 0;
      const fakeInterval = setInterval(() => {
        fakeT = Math.min(fakeT + 15, 85);
        bar.style.width = fakeT + '%';
      }, 150);

      const res = await fetch(`/api/tools/upload?category=${encodeURIComponent(category)}`, {
        method: 'POST',
        body: fd
        // no Content-Type header — browser sets multipart boundary automatically
      });
      clearInterval(fakeInterval);
      bar.style.width = '100%';

      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();

      hide('uptool-progress-wrap');
      const resultEl = el('uptool-result');
      resultEl.innerHTML = `<span style="color:var(--green-light,#4caf50)">&#10003; Uploaded ${saved.length} file${saved.length !== 1 ? 's' : ''}</span>`;
      show('uptool-result');
      pendingFiles = [];
      renderQueue();
    } catch (err) {
      hide('uptool-progress-wrap');
      const resultEl = el('uptool-result');
      resultEl.innerHTML = `<span style="color:var(--red-light,#f44336)">Upload failed: ${err.message}</span>`;
      show('uptool-result');
      show('uptool-actions');
    }
  });

  /* ── Browse tab ── */
  async function loadBrowse() {
    const cat = el('uptool-browse-cat').value;
    const grid = el('uptool-file-grid');
    grid.innerHTML = '<div class="uptool-empty">Loading…</div>';
    try {
      const url = '/api/tools/files' + (cat ? `?category=${encodeURIComponent(cat)}` : '');
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      const files = await res.json();
      renderGrid(files);
    } catch (err) {
      grid.innerHTML = `<div class="uptool-empty" style="color:var(--red-light)">Error: ${err.message}</div>`;
    }
  }

  function renderGrid(files) {
    const grid = el('uptool-file-grid');
    if (!files.length) {
      grid.innerHTML = '<div class="uptool-empty">No files found</div>';
      return;
    }
    grid.innerHTML = files.map(f => {
      const isPdf = f.name.toLowerCase().endsWith('.pdf');
      const thumb = isPdf
        ? `<div class="uptool-fc-thumb"><span class="uptool-pdf-icon">&#128196;</span></div>`
        : `<div class="uptool-fc-thumb"><img src="/uploads/${encodePathSegments(f.relPath)}" loading="lazy" alt=""></div>`;
      return `<div class="uptool-file-card" data-rel="${escapeAttr(f.relPath)}" data-name="${escapeAttr(f.name)}" data-pdf="${isPdf}">
        ${thumb}
        <div class="uptool-fc-name">${escapeHtml(f.name)}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.uptool-file-card').forEach(card => {
      card.addEventListener('click', () => openPreview(card.dataset.rel, card.dataset.name, card.dataset.pdf === 'true'));
    });
  }

  function encodePathSegments(relPath) {
    return relPath.split('/').map(encodeURIComponent).join('/');
  }
  function escapeAttr(s) { return s.replace(/"/g,'&quot;'); }
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  el('uptool-browse-cat').addEventListener('change', loadBrowse);
  el('uptool-refresh-btn').addEventListener('click', loadBrowse);

  /* ── Preview modal ── */
  function openPreview(relPath, name, isPdf) {
    previewFile = { relPath, name, isPdf };
    el('uptool-preview-name').textContent = name;
    const body = el('uptool-preview-body');
    const url = `/uploads/${encodePathSegments(relPath)}`;
    if (isPdf) {
      body.innerHTML = `<div class="uptool-pdf-msg">
        <p>&#128196; ${escapeHtml(name)}</p>
        <p style="margin-top:8px;font-size:0.85rem;color:var(--text-dim)">Click "Save / Download" to open the PDF.</p>
      </div>`;
    } else {
      body.innerHTML = `<img src="${url}" alt="${escapeAttr(name)}">`;
    }
    el('uptool-preview-modal').classList.remove('hidden');
  }

  el('uptool-preview-close').addEventListener('click', () => {
    el('uptool-preview-modal').classList.add('hidden');
    previewFile = null;
  });

  el('uptool-preview-save').addEventListener('click', () => {
    if (!previewFile) return;
    const url = `/uploads/${encodePathSegments(previewFile.relPath)}`;
    if (previewFile.isPdf) {
      window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = previewFile.name;
      a.click();
    }
  });

  el('uptool-preview-delete').addEventListener('click', async () => {
    if (!previewFile) return;
    if (!confirm(`Delete "${previewFile.name}"?`)) return;
    try {
      const res = await fetch('/api/tools/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: previewFile.relPath })
      });
      if (!res.ok) throw new Error(await res.text());
      el('uptool-preview-modal').classList.add('hidden');
      previewFile = null;
      showToast('File deleted', 'success');
      loadBrowse();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  });
})();

/* ── Init ────────────────────────────────────────────────────────────────── */
checkDBStatus();
loadLoginUserList();
checkAuth();
