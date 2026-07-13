/* ── Icon helper ─────────────────────────────────────────────────────────── */
// Icons are rendered as CSS-masked spans so `color` on any ancestor controls
// the icon tint — no filter math needed, works with black or white SVGs.
const ICON_CDN = '/marv-site/icons';
function icon(name, sz = 16) {
  const u = `${ICON_CDN}/icon-${name}.svg`;
  return `<span class="app-icon" style="width:${sz}px;height:${sz}px;-webkit-mask-image:url(${u});mask-image:url(${u})" aria-hidden="true"></span>`;
}

/* ── Theme ───────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.innerHTML = icon(theme === 'light' ? 'light' : 'moon', 20);
    btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }
  localStorage.setItem('watermark-theme', theme);
}

document.getElementById('theme-toggle-btn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
});

// Init from saved preference (anti-FOUC script in <head> already set the attribute;
// this just syncs the button icon on first load)
applyTheme(localStorage.getItem('watermark-theme') || 'dark');

/* ── State ───────────────────────────────────────────────────────────────── */
let currentUser   = null;
let currentScreen = null;
let _usersList    = null;
let _rolesList    = null;

// Pumping plant state
const pp = {
  sites:       [],
  buildings:   {},     // keyed by site_id
  loadedSites: new Set(),
  activeTab:   null,   // null = All
};
let ppLoaded = false;


// Admin edit state
let editingUserId = null;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function todayISO() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

const SUPERVISOR_ROLES = ['supervisor', 'admin', 'water-planner'];
function isSupervisorLevel(role) { return SUPERVISOR_ROLES.includes(role ?? ''); }

// Roles allowed to see the SCADA Dashboard — fetched from the server (admin-managed
// via Settings → SCADA Access). Defaults to admin until the fetch resolves. The
// server is the real gate; this only drives nav/tile visibility + the screen guard.
let scadaAllowedRoles = ['admin'];
function isScadaAllowed(role) { return scadaAllowedRoles.includes(role ?? ''); }

async function applyScadaVisibility(user) {
  try {
    const r = await api('GET', '/api/settings/scada-roles');
    if (Array.isArray(r.roles)) scadaAllowedRoles = r.roles;
  } catch { /* keep default */ }
  const ok = isScadaAllowed(user.role);
  el('nav-scada-item').classList.toggle('hidden', !ok);
  // Dashboard SCADA widget (3rd stat card) — may not be rendered yet; the
  // stats renderer also checks isScadaAllowed, so both paths converge.
  el('scada-flow-stat')?.classList.toggle('hidden', !ok);
  if (ok) loadScadaFlowWidget();
}

const ROLE_LABELS = {
  admin: 'Admin', supervisor: 'Supervisor', operator: 'Operator',
  'water-planner': 'Water Planner', 'systems-operator': 'Systems Operator',
  'heavy-equipment-operator': 'Heavy Equipment Operator',
  'pump-tech': 'Pump Tech', 'elec-tech': 'Elec Tech',
};
function formatRole(role) { return ROLE_LABELS[role] || role; }

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
    const req = indexedDB.open('watermark-offline', 1);
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

function showReadingAlert(title, bodyHtml, buttons) {
  // Cancel always renders last (bottom of the vertical stack)
  const ordered = [
    ...buttons.filter(b => b.key !== 'cancel'),
    ...buttons.filter(b => b.key === 'cancel'),
  ];
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card" style="max-width:340px">
      <div class="modal-header"><h2 style="font-size:1rem;margin:0">${title}</h2></div>
      <div class="modal-body" style="font-size:0.9rem">${bodyHtml}</div>
      <div class="modal-footer" style="display:flex;flex-direction:column;gap:8px;padding:12px 16px">
        ${ordered.map(b => `<button class="btn ${b.cls}" style="width:100%" data-key="${b.key}">${b.label}</button>`).join('')}
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelectorAll('button[data-key]').forEach(btn =>
      btn.addEventListener('click', () => { document.body.removeChild(ov); resolve(btn.dataset.key); }));
  });
}

// Double-submit guard: disable a save/submit button and show progress text on
// the first click. Returns a restore() that re-enables it and puts the original
// label back — call restore() in the catch/finally (or after a validation abort).
function beginSave(btn, savingText = 'Saving…') {
  if (!btn) return () => {};
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = savingText;
  return () => { btn.disabled = false; btn.textContent = orig; };
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
let _locationMap = null;
function openLocationModal(lat, lon, name) {
  _locationModalUrl = mapsUrl(lat, lon, name);
  el('location-modal-name').textContent = name;
  el('location-modal-coords').textContent = `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
  el('location-modal').classList.remove('hidden');
  if (_locationMap) { _locationMap.remove(); _locationMap = null; }
  setTimeout(() => {
    _locationMap = L.map('location-modal-map', { zoomControl: true, attributionControl: false })
      .setView([lat, lon], 16);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20
    }).addTo(_locationMap);
    L.marker([lat, lon]).addTo(_locationMap);
    _locationMap.invalidateSize();

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        if (!_locationMap) return;
        const { latitude, longitude } = pos.coords;
        const locationIcon = L.divIcon({
          className: '',
          html: '<div class="map-my-location"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        L.marker([latitude, longitude], { icon: locationIcon })
          .addTo(_locationMap)
          .bindPopup('<strong>You are here</strong>');
        _locationMap.fitBounds(
          L.latLngBounds([[lat, lon], [latitude, longitude]]).pad(0.2)
        );
      }, () => { /* permission denied or unavailable — silent */ });
    }
  }, 50);
}
function _closeLocationModal() {
  el('location-modal').classList.add('hidden');
  if (_locationMap) { _locationMap.remove(); _locationMap = null; }
}
el('location-modal-close').addEventListener('click', _closeLocationModal);
el('location-modal').addEventListener('click', e => { if (e.target === el('location-modal')) _closeLocationModal(); });
el('location-modal-open-btn').addEventListener('click', () => {
  _closeLocationModal();
  // Use location.href for maps:// deep links on iOS PWA — window.open() crashes
  window.location.href = _locationModalUrl;
});

/* ── Set Map Modal ───────────────────────────────────────────────────────── */
let _setLeafletMap = null;
let _setLeafletMarkers = [];
let _setLocationMarker = null;

// GPS Location Selector state
let _gpsLocMap = null;
let _gpsLocPinMarker = null;
let _gpsLocExistingMarker = null;
let _gpsLocUserMarker = null;
let _gpsLocPin = null;        // { lat, lng } of tapped point
let _gpsLocSelected = null;   // { type, id, name, existingLat, existingLng }
let _gpsLocWellData = [];     // cached well/piez list for current category

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
      const sessionR = wellReadingsThisSession.get(w.well_id);
      // KF: use range_reading_date; DWR: session set + recency; operational wells: session map + hours
      const done = 'range_reading_date' in w
        ? w.range_reading_date != null
        : sessionR != null || dwrDoneThisSession.has(w.well_id) ||
          (w.days_since_reading != null && w.days_since_reading <= 30) ||
          (w.hours_since_reading != null && w.hours_since_reading <= 8);
      const color = done ? '#22c55e' : '#ef4444';
      const dotIcon = L.divIcon({
        className: '',
        html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.4);box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        popupAnchor: [0, -8],
      });
      const label = [w.state_well_number, w.common_name].filter(Boolean).join(' | ') || 'Well';
      const fmtFlow = v => v == null ? null : Number(v) === 0 ? 'Off' : `${Number(v).toFixed(2)} cfs`;
      let status;
      if (!done) {
        const flowStr = fmtFlow(w.last_flow_cfs);
        status = `<span style="color:#dc2626">Not read</span>${flowStr ? `<br><span style="color:#888">Last: ${flowStr}</span>` : ''}`;
      } else if (sessionR) {
        const lines = [`✓ Read ${localDateStr(sessionR.date, {month:'short',day:'numeric'})}`];
        if (sessionR.time) lines.push(sessionR.time.slice(0, 5));
        if (sessionR.flow_cfs != null && sessionR.flow_cfs !== '') lines.push(`${Number(sessionR.flow_cfs).toFixed(2)} cfs`);
        status = `<span style="color:#16a34a">${lines.join('<br>')}</span>`;
      } else {
        const readDate = w.range_reading_date || w.last_reading_date;
        const flowStr = fmtFlow(w.last_flow_cfs);
        const dateStr = readDate ? `✓ Read ${localDateStr(readDate, {month:'short',day:'numeric'})}` : '✓ Read';
        status = `<span style="color:#16a34a">${dateStr}${flowStr ? `<br>${flowStr}` : ''}</span>`;
      }
      const m = L.marker([w.gps_latitude, w.gps_longitude], { icon: dotIcon }).addTo(_setLeafletMap);
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
  const prevScreen = currentScreen;
  document.querySelectorAll('.screen-content').forEach(s => s.classList.remove('active'));
  const target = el(`screen-${name}`);
  if (target) {
    target.classList.add('active');
    currentScreen = name;
  }
  const titles = {
    dashboard:       'WaterMark',
    'pumping-plant': 'Pumping Plant Readings',
    wells:           'Well Readings',
    canal:           'Canal Readings',
    vehicles:        'Vehicle Monthly',
    'kf-monthly':    'KF Monthly Readings',
    maintenance:     'Maintenance Log',
    pesticides:      'Pesticides',
    'dirt-work':     'Dirt Work',
    'well-runs':     'Well Runs',
    reports:         'Reports',
    admin:           'Settings',
    hr:              'HR',
    charts:          'Charts',
    ponds:           'Ponds',
    safety:          'Safety',
    scada:           'SCADA Dashboard',
  };
  closeDrawer();

  // Stop the SCADA live stream when navigating away from its screen
  if (prevScreen === 'scada' && name !== 'scada' && typeof stopScadaStream === 'function') {
    stopScadaStream();
  }

  // Add / update ‹ Back nav + swipe-back for non-dashboard screens.
  // Each sub-panel open/close will call setPanelNav again to update title + back target.
  if (name !== 'dashboard') {
    setPanelNav(el(`screen-${name}`), () => showScreen('dashboard'), titles[name] || 'WaterMark');
  } else {
    el('screen-title').textContent = 'WaterMark';
  }

  // Block supervisor/admin-only screens for operators
  if (name === 'reports') {
    if (!currentUser || !isSupervisorLevel(currentUser.role)) {
      showScreen('dashboard');
      return;
    }
  }
  // SCADA Dashboard is gated to admins for now (see SCADA_ROLES on server)
  if (name === 'scada') {
    if (!currentUser || !isScadaAllowed(currentUser.role)) {
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
  if (name === 'dirt-work')     initDirtWorkScreen();
  if (name === 'well-runs')     initWellRunsScreen();
  if (name === 'reports')       initReportsScreen();
  if (name === 'admin')         { initAdminScreen(); initSettingsScreen(); }
  if (name === 'hr')            initHRScreen();
  if (name === 'charts')        initChartsScreen();
  if (name === 'ponds')         initPondsScreen();
  if (name === 'safety')        initSafetyScreen();
  if (name === 'scada')         initScadaScreen();

  // Refresh time to current on every screen visit
  const screenTimeIds = {
    'pumping-plant': 'pp-time',
    'wells':         'well-time',
    'canal':         'canal-time',
    'vehicles':      'vehicle-time',
    'kf-monthly':    'kf-time',
    'ponds':         'ponds-time',
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
  localStorage.setItem('watermark-user', JSON.stringify(user));
  el('screen-login').classList.remove('active');
  el('app-shell').classList.remove('hidden');
  el('user-badge').textContent = user.initials || user.username.slice(0, 2).toUpperCase();
  el('drawer-user').innerHTML = `<strong>${escHtml(user.full_name || user.username)}</strong>${escHtml(user.role)}`;

  // Reset all role-gated elements before applying role
  el('nav-reports-item').classList.add('hidden');
  el('dash-reports-tile').classList.add('hidden');
  el('settings-admin-section').classList.add('hidden');
  el('settings-widgets-section').classList.add('hidden');
  if (isSupervisorLevel(user.role)) {
    el('nav-reports-item').classList.remove('hidden');
    el('dash-reports-tile').classList.remove('hidden');
    el('settings-admin-section').classList.remove('hidden');
    el('settings-widgets-section').classList.remove('hidden');
  }
  // SCADA Dashboard — start hidden, reveal if this role is in the server allow-list
  el('nav-scada-item').classList.add('hidden');
  el('settings-scada-roles-row')?.classList.toggle('hidden', user.role !== 'admin');
  applyScadaVisibility(user);
  // Populate account info on settings screen
  el('settings-full-name').textContent = user.full_name || '—';
  el('settings-username').textContent  = user.username;
  el('settings-role').textContent      = formatRole(user.role);

  showScreen('dashboard');
  loadDashboardStats();
  refreshPendingSync();
  loadAssignmentBadge();
}

/* ── Pending Sync Buttons ────────────────────────────────────────────────── */
el('sync-now-btn').addEventListener('click', syncPendingQueue);
el('export-pending-btn').addEventListener('click', async () => {
  const items = await offlineGetAll();
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `watermark-pending-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

/* ── Dashboard Stats ─────────────────────────────────────────────────────── */
async function loadDashboardStats() {
  try {
    const [s, rw] = await Promise.all([
      api('GET', '/api/dashboard/stats'),
      api('GET', '/api/dashboard/running-wells').catch(() => null),
    ]);
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
    const pct = s.kf_total > 0 ? Math.round((s.kf_done / s.kf_total) * 100) : 0;
    const rwCount = rw ? rw.read_today_count : 0;
    const rwTotal = rw ? rw.total_count      : 0;
    const rwCvc   = rw ? parseFloat(rw.cvc_total_cfs || 0).toFixed(2) : '0.00';
    const rwVal   = rwTotal > 0
      ? `${rwCount}<span style="font-size:1rem;color:var(--text-dim)">/${rwTotal}</span>`
      : `<span style="font-size:1rem;color:var(--text-muted)">—</span>`;
    const grid = el('dashboard-stats');
    grid.innerHTML = `
      <div class="stat-card stat-accent" id="kf-complete-stat" style="cursor:pointer">
        <div class="stat-value">${s.kf_done}<span style="font-size:1rem;color:var(--text-dim)">/${s.kf_total}</span></div>
        <div class="stat-label">KF Complete</div>
        <div class="stat-sublabel">${rangeLabel}</div>
        <div class="stat-sublabel" style="margin-top:2px">${s.kf_total - s.kf_done} Remaining</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="stat-card rw-stat-card" id="running-wells-stat" style="cursor:pointer">
        <div class="stat-value">${rwVal}</div>
        <div class="stat-label">Running Wells</div>
        <div class="stat-sublabel">CVC Well Inflow: ${rwCvc} cfs</div>
      </div>
      <div class="stat-card${isScadaAllowed(currentUser?.role) ? '' : ' hidden'}" id="scada-flow-stat" style="cursor:pointer">
        <div class="stat-value" id="scada-flow-value">—</div>
        <div class="stat-label">SCADA Dashboard</div>
        <div class="stat-sublabel">DWR Total Flow (cfs)</div>
        <svg id="scada-flow-spark" class="scada-flow-spark" viewBox="0 0 100 24" preserveAspectRatio="none"></svg>
      </div>
    `;
    el('running-wells-stat').addEventListener('click', openRunningWellsModal);
    el('kf-complete-stat').addEventListener('click', openKFSetsModal);
    el('scada-flow-stat').addEventListener('click', () => showScreen('scada'));
    loadScadaFlowWidget();
  } catch { /* non-critical */ }
}

// ── SCADA DWR flow widget (dashboard stat card) ─────────────────────────────
// Shows the live DWR total (sum of the computed flow sensors on the config'd
// site) plus an 8-hour sparkline. One history call supplies both: the summed
// series draws the sparkline and its last point is the current value.
let _scadaFlowCfg = null; // cached { tags } from /api/scada/config

async function loadScadaFlowWidget() {
  const card = el('scada-flow-stat');
  if (!card || card.classList.contains('hidden')) return;
  try {
    if (!_scadaFlowCfg) {
      const cfg = await api('GET', '/api/scada/config');
      const site = (cfg.sites || []).find(s =>
        (s.computedSensors || []).some(c => c.kind === 'flow' || /flow|dwr/i.test(c.label)));
      if (!site) { el('scada-flow-value').textContent = '—'; return; }
      const comp = site.computedSensors.find(c => c.kind === 'flow' || /flow|dwr/i.test(c.label));
      _scadaFlowCfg = { tags: comp.sum.map(s => `${site.influxSite}.${s}.SCL.PV`) };
    }
    const { tags } = _scadaFlowCfg;
    const r = await api('GET', `/api/scada/history?tags=${encodeURIComponent(tags.join(','))}&range=8h`);
    const pts = new Map();
    tags.forEach(t => (r.series?.[t] || []).forEach(([tm, v]) => pts.set(tm, (pts.get(tm) || 0) + v)));
    const series = [...pts.entries()].sort((a, b) => a[0] - b[0]);
    if (!series.length) { el('scada-flow-value').textContent = '—'; return; }

    el('scada-flow-value').textContent = series[series.length - 1][1].toFixed(1);

    // Sparkline: map the summed series onto the 100×24 viewBox with 2px pad.
    const vals = series.map(p => p[1]);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = (max - min) || 1;
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const tSpan = (t1 - t0) || 1;
    const d = series.map(([t, v]) =>
      `${((t - t0) / tSpan * 100).toFixed(1)},${(22 - (v - min) / span * 20).toFixed(1)}`).join(' ');
    el('scada-flow-spark').innerHTML =
      `<polyline points="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
  } catch { /* non-critical — leave placeholder */ }
}

function onLogout() {
  currentUser = null;
  localStorage.removeItem('watermark-user');
  // Purge cached API data so it doesn't linger on shared devices (S-5)
  navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
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
    const cached = localStorage.getItem('watermark-user');
    if (isNetworkError && cached) {
      try { onLogin(JSON.parse(cached)); } catch { /* bad cache, ignore */ }
    } else if (!isNetworkError) {
      // Session rejected (expired/invalid) — purge cached API data (S-5)
      localStorage.removeItem('watermark-user');
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
    }
    // Otherwise: not logged in — show login screen (already visible by default)
  }
}

/* ── Swipe-back gesture ──────────────────────────────────────────────────── */
// Attach a left-edge swipe gesture to a panel or screen container.
// Only triggers if touchstart begins within 30px of left edge and swipes > 60px right.
function addSwipeBack(containerEl, backFn) {
  if (containerEl._swipeCleanup) containerEl._swipeCleanup();
  let startX = null;
  const onStart = e => { startX = e.touches[0].clientX < 30 ? e.touches[0].clientX : null; };
  const onEnd   = e => { if (startX !== null && e.changedTouches[0].clientX - startX > 60) backFn(); startX = null; };
  containerEl.addEventListener('touchstart', onStart, { passive: true });
  containerEl.addEventListener('touchend',   onEnd,   { passive: true });
  containerEl._swipeCleanup = () => {
    containerEl.removeEventListener('touchstart', onStart);
    containerEl.removeEventListener('touchend', onEnd);
  };
}

/* ── Panel nav bar ───────────────────────────────────────────────────────────
   Injects / updates a ‹ Back button at the top of a screen and updates the
   app header title. Call on every screen or panel transition so the button
   always goes back exactly one level and the header reflects where you are.  */
function setPanelNav(screenEl, backFn, headerTitle) {
  if (!screenEl) return;
  el('screen-title').textContent = headerTitle;
  // Store current back target so the swipe listener can always read the latest value
  screenEl._navBackFn = backFn;
  let nav = screenEl.querySelector(':scope > .panel-nav-bar');
  if (!nav) {
    nav = document.createElement('div');
    nav.className = 'panel-nav-bar';
    const btn = document.createElement('button');
    btn.className = 'panel-nav-back';
    btn.textContent = '‹ Back';
    nav.appendChild(btn);
    screenEl.insertBefore(nav, screenEl.firstChild);
  }
  nav.querySelector('.panel-nav-back').onclick = backFn;
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
  kf:          [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }, { key: 'on_off', label: 'On/Off' }, { key: 'entered_by', label: 'Operator' }],
  piezometer:  [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }, { key: 'wet_dry_moist', label: 'Condition' }, { key: 'entered_by', label: 'Operator' }],
  dwr:         [{ key: 'value',         label: 'DTW (ft)' }, { key: 'method', label: 'Method' }, { key: 'entered_by', label: 'Operator' }],
  canal:       [{ key: 'flow',          label: 'Flow (cfs)' }, { key: 'totalizer', label: 'Totalizer (AF)' }, { key: 'gate_setting', label: 'Gate' }],
  vehicle:       [{ key: 'odometer_miles', label: 'Odometer' }, { key: 'engine_hours', label: 'Eng. Hrs' }],
  'staff-gauge': [{ key: 'value',          label: 'Level (ft)' }, { key: 'entered_by', label: 'By' }],
  'pond-gate':   [{ key: 'head_ft', label: 'Head (ft)' }, { key: 'opening_in', label: 'Opening (in)' }, { key: 'overpour_in', label: 'Overpour (in)' }, { key: 'flow_cfs', label: 'Flow (cfs)' }],
};

/* ── Attachment Preview Modal ────────────────────────────────────────────── */
let _attPreviewCurrent = null;

function openAttachmentPreview(url, name, isPdf) {
  _attPreviewCurrent = { url, name, isPdf };
  el('att-preview-name').textContent = name;
  const body = el('att-preview-body');
  if (isPdf) {
    body.innerHTML = `<div class="uptool-pdf-msg">
      <p style="font-size:2rem">${icon('invoice', 32)}</p>
      <p style="margin-top:8px">${name}</p>
      <p style="margin-top:8px;font-size:0.85rem;color:var(--text-dim)">Click "Save / Download" to open the PDF.</p>
    </div>`;
  } else {
    body.innerHTML = `<img src="${url}" alt="${name.replace(/"/g,'&quot;')}">`;
  }
  el('att-preview-modal').classList.remove('hidden');
}

el('att-preview-close').addEventListener('click', () => {
  el('att-preview-modal').classList.add('hidden');
  _attPreviewCurrent = null;
});

el('att-preview-modal').addEventListener('click', e => {
  if (e.target === el('att-preview-modal')) {
    el('att-preview-modal').classList.add('hidden');
    _attPreviewCurrent = null;
  }
});

el('att-preview-download').addEventListener('click', () => {
  if (!_attPreviewCurrent) return;
  const { url, name, isPdf } = _attPreviewCurrent;
  if (isPdf) {
    window.open(url, '_blank');
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
  }
});

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

    function renderHistoryRows(rowList) {
      tbody.innerHTML = '';
      rowList.forEach(r => {
        const d = fmtDate(r.reading_date);
        const t = r.reading_time ? r.reading_time.slice(0, 5) : '';
        const valCells = cols.map(c => `<td>${r[c.key] != null ? r[c.key] : '—'}</td>`).join('');

        const showDel = canDeleteAll ||
          (isSupervisorLevel(role) && isWithin24h(r.reading_date, r.reading_time)) ||
          (r.entered_by === username && isWithin24h(r.reading_date, r.reading_time));

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${d}${t ? `<div class="hist-time">${t}</div>` : ''}</td>
          ${valCells}
          <td class="hist-notes">${r.notes || ''}</td>
          <td>${showDel ? `<button class="hist-del-btn" data-id="${r.id}">${icon('delete')}</button>` : ''}</td>`;
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
    }

    renderHistoryRows(rows);

    body.innerHTML = '';
    body.appendChild(table);

    if (type === 'well') {
      const showAllBtn = document.createElement('button');
      showAllBtn.className = 'btn btn-secondary';
      showAllBtn.style.cssText = 'width:100%;margin-top:12px';
      showAllBtn.textContent = 'Show All';
      showAllBtn.addEventListener('click', async () => {
        showAllBtn.disabled = true;
        showAllBtn.textContent = 'Loading…';
        try {
          const allRows = await api('GET', `/api/history-all?type=well&id=${encodeURIComponent(id)}`);
          renderHistoryRows(allRows);
          showAllBtn.remove();
        } catch (err) {
          showAllBtn.disabled = false;
          showAllBtn.textContent = 'Show All';
          alert('Failed to load: ' + err.message);
        }
      });
      body.appendChild(showAllBtn);
    }
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
      const buildings = await api('GET', `/api/pp-site-data?site_id=${site.site_id}`);
      pp.buildings[site.site_id] = buildings;
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
      section.querySelector('.list-section-header').addEventListener('click', () => {
        if (!section.classList.contains('collapsed')) el('pp-time').value = nowHHMM();
      });
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
    if (/spare/i.test(pump.status) || /spare/i.test(pump.pump_unit_status)) return; // spare pumps don't need hour readings
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
      ${prevNotes ? `<div class="prev-note-hint">${escHtml(prevNotes)}</div>` : ''}
      <textarea class="rr-notes-input rr-notes" rows="1" placeholder="Notes…"></textarea>
      <button class="hist-btn" title="View history">${icon('history')}</button>
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

  // Notes textarea
  const notesInput = row.querySelector('.rr-notes');
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

  document.querySelectorAll('.list-section:not(.collapsed) .reading-row').forEach(row => {
    const curInput = row.querySelector('.rr-current');
    let cur = curInput.value.trim();
    const notes = row.querySelector('.rr-notes').value.trim();
    const type  = row.dataset.type;
    const id    = row.dataset.id;

    if (type === 'pump' && cur === '') {
      // Auto-fill pump hours with previous reading if left blank
      const prevDisp = row.querySelector('.rr-prev').value.trim();
      if (prevDisp && prevDisp !== '—') {
        cur = prevDisp;
        curInput.value = cur;
      } else {
        return; // no previous to fall back on — skip
      }
    } else if (cur === '') {
      return; // PGE / compressor / monitor: skip if blank
    }

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
      // Clear expanded section inputs so they can't be re-submitted
      document.querySelectorAll('.list-section:not(.collapsed) .reading-row').forEach(row => {
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
let wellReadingsThisSession = new Map(); // well_id → { date, time, flow_cfs }

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
      const items   = areaWells.map(w => createWellItem(w, dateInput, timeInput));
      const section = makeCollapsibleSection(area, items);

      // Group Map button — only if at least one well in this area has GPS
      const gpsWells = areaWells.filter(w => w.gps_latitude && w.gps_longitude);
      if (gpsWells.length) {
        const hdr    = section.querySelector('.list-section-header');
        const mapBtn = document.createElement('button');
        mapBtn.className = 'btn btn-secondary btn-sm';
        mapBtn.style.cssText = 'margin-left:auto;margin-right:8px;padding:2px 10px;font-size:0.75rem;flex-shrink:0';
        mapBtn.innerHTML = `${icon('map')} Map`;
        mapBtn.addEventListener('click', e => {
          e.stopPropagation();
          openSetMapModal(area, areaWells);
        });
        hdr.insertBefore(mapBtn, hdr.querySelector('.section-chevron'));
      }

      body.appendChild(section);
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
  const badge = hrs == null ? 'Not read'
    : hrs < 1   ? 'Just read'
    : hrs >= 48 ? `${Math.round(hrs / 24)}d ago`
    : `${Math.round(hrs)}h ago`;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name">${w.common_name}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-form">
      <div class="two-col">
        <div class="form-group">
          <label>Well Status</label>
          <div class="toggle-group">
            <button class="toggle-btn" data-role="on">ON</button>
            <button class="toggle-btn" data-role="off">OFF</button>
          </div>
        </div>
        <div class="form-group">
          <label>Motor Oil Needed?</label>
          <div class="toggle-group">
            <button class="toggle-btn" data-role="oil-y">Yes</button>
            <button class="toggle-btn" data-role="oil-n">No</button>
          </div>
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
        ${w.last_notes ? `<div class="prev-note-hint">${escHtml(w.last_notes)}</div>` : ''}
        <textarea class="ctrl-textarea w-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${w.gps_latitude && w.gps_longitude ? `<button class="btn btn-secondary btn-sm w-map-btn">${icon('map-pin')} Map</button>` : ''}
        <button class="btn btn-secondary btn-sm w-hist-btn">${icon('history')} History</button>
        <button class="btn btn-save w-save-btn">Save Well Reading</button>
      </div>
    </div>`;
  div.querySelector('.w-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('well', w.well_id, w.common_name);
  });

  div.querySelector('.w-map-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openLocationModal(w.gps_latitude, w.gps_longitude, w.common_name);
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

  let onOff    = w.last_on_off    ?? true;
  let motorOil = w.last_motor_oil ?? true;

  div.querySelector(`[data-role="${onOff ? 'on' : 'off'}"]`).classList.add('active');
  div.querySelector(`[data-role="${motorOil ? 'oil-y' : 'oil-n'}"]`).classList.add('active');

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
    if (open) {
      const sb = div.querySelector('.w-save-btn');
      sb.disabled = false; sb.textContent = 'Save Reading';
      el('well-time').value = nowHHMM();
    }
  });

  div.querySelector('.w-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const saveBtn = e.currentTarget;

    const _wMissing = [
      { label: 'Hours',       inputEl: div.querySelector('.w-hours'),      prev: w.last_hour_reading },
      { label: 'Flow (cfs)',  inputEl: div.querySelector('.w-flow'),       prev: w.last_flow_cfs     },
      { label: 'Totalizer',   inputEl: div.querySelector('.w-totalizer'),  prev: w.last_totalizer    },
      { label: 'Dripper Oil', inputEl: div.querySelector('.w-dripperoil'), prev: w.last_dripper_oil  },
      { label: 'PG&E kWh',   inputEl: div.querySelector('.w-pge'),        prev: w.last_pge_kwh      },
    ].filter(f => f.prev != null && f.inputEl && f.inputEl.value.trim() === '');
    if (_wMissing.length) {
      const _listHtml = _wMissing.map(f => `<li><strong>${f.label}</strong>: prev <strong>${f.prev}</strong></li>`).join('');
      const _ra = await showReadingAlert('Incomplete Reading',
        `<p>These fields had a value last reading but are now blank:</p><ul>${_listHtml}</ul>`,
        [{ key: 'cancel', label: 'Cancel',             cls: 'btn-secondary' },
         { key: 'fill',   label: 'Fill with Previous', cls: 'btn-primary'   },
         { key: 'save',   label: 'Save Anyway',        cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
      if (_ra === 'fill') { _wMissing.forEach(f => { f.inputEl.value = f.prev; }); return; }
    }
    const _wDown = [
      { label: 'Hours',     prev: w.last_hour_reading, cur: parseFloat(div.querySelector('.w-hours').value)     },
      { label: 'Totalizer', prev: w.last_totalizer,    cur: parseFloat(div.querySelector('.w-totalizer').value) },
      { label: 'PG&E kWh', prev: w.last_pge_kwh,      cur: parseFloat(div.querySelector('.w-pge').value)       },
    ].filter(f => f.prev != null && !isNaN(f.cur) && f.cur < Number(f.prev));
    if (_wDown.length) {
      const _listHtml = _wDown.map(f => `<li><strong>${f.label}</strong>: ${f.prev} → ${f.cur}</li>`).join('');
      const _ra = await showReadingAlert('Reading Decreased',
        `<p>These readings are lower than the previous values:</p><ul>${_listHtml}</ul>` +
        `<p style="color:var(--text-dim);font-size:0.85rem">Cumulative readings normally only go up.</p>`,
        [{ key: 'cancel', label: 'Cancel',      cls: 'btn-secondary' },
         { key: 'save',   label: 'Save Anyway', cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
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
      if (!r.queued) {
        wellReadingsThisSession.set(w.well_id, {
          date: body.reading_date, time: body.reading_time, flow_cfs: body.flow_cfs,
        });
      }
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : 'Just saved';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      ['.w-hours', '.w-flow', '.w-totalizer', '.w-dripperoil', '.w-pge', '.w-notes']
        .forEach(sel => { const el2 = div.querySelector(sel); if (el2) el2.value = ''; });
      showToast(r.queued ? `${w.common_name} queued offline` : `${w.common_name} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
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
        ${s.last_notes ? `<div class="prev-note-hint">${escHtml(s.last_notes)}</div>` : ''}
        <textarea class="ctrl-textarea c-notes" rows="2" placeholder="Optional notes…"></textarea></div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm c-hist-btn">${icon('history')} History</button>
        <button class="btn btn-save c-save-btn">Save Reading</button>
      </div>
    </div>`;

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
    if (open) {
      const sb = div.querySelector('.c-save-btn');
      sb.disabled = false; sb.textContent = 'Save Reading';
      el('canal-time').value = nowHHMM();
    }
  });

  div.querySelector('.c-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const saveBtn = e.currentTarget;

    const _cMissing = [
      { label: 'Flow (cfs)',   inputEl: div.querySelector('.c-flow'),      prev: s.last_flow      },
      { label: 'Totalizer',    inputEl: div.querySelector('.c-totalizer'), prev: s.last_totalizer },
      { label: 'Gate Setting', inputEl: div.querySelector('.c-gate'),      prev: s.last_gate      },
      { label: 'Head (ft)',    inputEl: div.querySelector('.c-head'),      prev: s.last_head      },
    ].filter(f => f.prev != null && f.inputEl && f.inputEl.value.trim() === '');
    if (_cMissing.length) {
      const _listHtml = _cMissing.map(f => `<li><strong>${f.label}</strong>: prev <strong>${f.prev}</strong></li>`).join('');
      const _ra = await showReadingAlert('Incomplete Reading',
        `<p>These fields had a value last reading but are now blank:</p><ul>${_listHtml}</ul>`,
        [{ key: 'cancel', label: 'Cancel',             cls: 'btn-secondary' },
         { key: 'fill',   label: 'Fill with Previous', cls: 'btn-primary'   },
         { key: 'save',   label: 'Save Anyway',        cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
      if (_ra === 'fill') { _cMissing.forEach(f => { f.inputEl.value = f.prev; }); return; }
    }
    const _cTotEl = div.querySelector('.c-totalizer');
    const _cDown = (_cTotEl && s.last_totalizer != null)
      ? [{ label: 'Totalizer', prev: s.last_totalizer, cur: parseFloat(_cTotEl.value) }]
          .filter(f => !isNaN(f.cur) && f.cur < Number(f.prev))
      : [];
    if (_cDown.length) {
      const _listHtml = _cDown.map(f => `<li><strong>${f.label}</strong>: ${f.prev} → ${f.cur}</li>`).join('');
      const _ra = await showReadingAlert('Reading Decreased',
        `<p>These readings are lower than the previous values:</p><ul>${_listHtml}</ul>` +
        `<p style="color:var(--text-dim);font-size:0.85rem">Cumulative readings normally only go up.</p>`,
        [{ key: 'cancel', label: 'Cancel',      cls: 'btn-secondary' },
         { key: 'save',   label: 'Save Anyway', cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

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
      ['.c-flow', '.c-totalizer', '.c-gate', '.c-head', '.c-derived', '.c-notes']
        .forEach(sel => { const el2 = div.querySelector(sel); if (el2) el2.value = ''; });
      showToast(r.queued ? `${s.structure_name} queued offline` : `${s.structure_name} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
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
  const badge = days == null ? 'Not read' : localDateStr(v.last_reading_date, { month: 'short', day: 'numeric' });

  const rt = v.reading_type;
  const showOdo = !rt || rt === 'odometer' || rt === 'both';
  const showHrs = !rt || rt === 'hours' || rt === 'both';
  const odoField = `<div class="form-group">
    <label>Odometer (mi)${lastOdo ? `<span class="prev-hint"> · Prev: ${lastOdo}</span>` : ''}</label>
    <input type="number" class="ctrl-input v-odo" step="1" placeholder="0">
    <span class="v-odo-delta" style="display:block;font-size:0.75rem;font-weight:700;min-height:16px;margin-top:2px"></span>
    <div class="v-service-hint hidden"></div>
  </div>`;
  const hrsField = `<div class="form-group">
    <label>Engine Hours${lastHrs ? `<span class="prev-hint"> · Prev: ${lastHrs}</span>` : ''}</label>
    <input type="number" class="ctrl-input v-hrs" step="0.1" placeholder="0.0">
    <span class="v-hrs-delta" style="display:block;font-size:0.75rem;font-weight:700;min-height:16px;margin-top:2px"></span>
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
        ${v.last_notes ? `<div class="prev-note-hint">${escHtml(v.last_notes)}</div>` : ''}
        <textarea class="ctrl-textarea v-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        <button class="btn btn-secondary btn-sm v-hist-btn">${icon('history')} History</button>
        <button class="btn btn-save v-save-btn">Save Reading</button>
      </div>
    </div>`;

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

  // Live delta: show difference from previous reading while typing
  if (v.last_odometer != null) {
    const odoDeltaEl = div.querySelector('.v-odo-delta');
    div.querySelector('.v-odo')?.addEventListener('input', function() {
      const cur = parseFloat(this.value), prev = Number(v.last_odometer);
      if (isNaN(cur)) { odoDeltaEl.innerHTML = ''; return; }
      const d = cur - prev;
      if (Math.abs(d) < 0.5) { odoDeltaEl.innerHTML = ''; return; }
      const up = d > 0;
      odoDeltaEl.innerHTML = `<span class="${up ? 'delta-up' : 'delta-dn'}">${up ? '▲' : '▼'}${Math.abs(Math.round(d)).toLocaleString()} mi</span>`;
    });
  }

  if (v.last_engine_hours != null) {
    const hrsDeltaEl = div.querySelector('.v-hrs-delta');
    div.querySelector('.v-hrs')?.addEventListener('input', function() {
      const cur = parseFloat(this.value), prev = Number(v.last_engine_hours);
      if (isNaN(cur)) { hrsDeltaEl.innerHTML = ''; return; }
      const d = cur - prev;
      if (Math.abs(d) < 0.05) { hrsDeltaEl.innerHTML = ''; return; }
      const up = d > 0;
      hrsDeltaEl.innerHTML = `<span class="${up ? 'delta-up' : 'delta-dn'}">${up ? '▲' : '▼'}${Math.abs(d).toFixed(1)} hrs</span>`;
    });
  }

  div.querySelector('.v-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('vehicle', v.vehicle_id, label);
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
    if (open) {
      const sb = div.querySelector('.v-save-btn');
      sb.disabled = false; sb.textContent = 'Save Reading';
      el('vehicle-time').value = nowHHMM();
    }
  });

  div.querySelector('.v-save-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const saveBtn = e.currentTarget;

    const _vMissing = [
      { label: 'Odometer (mi)', inputEl: div.querySelector('.v-odo'), prev: v.last_odometer     },
      { label: 'Engine Hours',  inputEl: div.querySelector('.v-hrs'), prev: v.last_engine_hours },
    ].filter(f => f.prev != null && f.inputEl && f.inputEl.value.trim() === '');
    if (_vMissing.length) {
      const _listHtml = _vMissing.map(f => `<li><strong>${f.label}</strong>: prev <strong>${f.prev}</strong></li>`).join('');
      const _ra = await showReadingAlert('Incomplete Reading',
        `<p>These fields had a value last reading but are now blank:</p><ul>${_listHtml}</ul>`,
        [{ key: 'cancel', label: 'Cancel',             cls: 'btn-secondary' },
         { key: 'fill',   label: 'Fill with Previous', cls: 'btn-primary'   },
         { key: 'save',   label: 'Save Anyway',        cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
      if (_ra === 'fill') { _vMissing.forEach(f => { f.inputEl.value = f.prev; }); return; }
    }
    const _vDown = [
      { label: 'Odometer (mi)', prev: v.last_odometer,     cur: parseFloat(div.querySelector('.v-odo')?.value ?? '') },
      { label: 'Engine Hours',  prev: v.last_engine_hours, cur: parseFloat(div.querySelector('.v-hrs')?.value ?? '') },
    ].filter(f => f.prev != null && !isNaN(f.cur) && f.cur < Number(f.prev));
    if (_vDown.length) {
      const _listHtml = _vDown.map(f => `<li><strong>${f.label}</strong>: ${f.prev} → ${f.cur}</li>`).join('');
      const _ra = await showReadingAlert('Reading Decreased',
        `<p>These readings are lower than the previous values:</p><ul>${_listHtml}</ul>` +
        `<p style="color:var(--text-dim);font-size:0.85rem">Cumulative readings normally only go up.</p>`,
        [{ key: 'cancel', label: 'Cancel',      cls: 'btn-secondary' },
         { key: 'save',   label: 'Save Anyway', cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
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
      ['.v-odo', '.v-hrs', '.v-notes']
        .forEach(sel => { const el2 = div.querySelector(sel); if (el2) el2.value = ''; });
      showToast(r.queued ? `${label} queued offline` : `${label} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Shared helpers for assignment dropdowns ─────────────────────────────── */
async function loadUsersList() {
  if (_usersList) return _usersList;
  _usersList = await api('GET', '/api/users/list').catch(() => []);
  return _usersList;
}

async function loadRolesList() {
  if (_rolesList) return _rolesList;
  _rolesList = await api('GET', '/api/roles/list').catch(() => []);
  return _rolesList;
}

// Title-case a role slug for display, e.g. "water-planner" → "Water Planner"
function roleLabel(role) {
  return String(role).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Like userSelectOptions, but adds a "Roles" group. Role values are stored as
// "role:<rolename>" so we can distinguish a role assignment from a person's name.
// When an issue is assigned to a role, everyone with that role sees it as theirs.
function assigneeSelectOptions(currentValue) {
  const users = _usersList || [];
  const roles = _rolesList || [];
  let html = '<option value="">— Unassigned —</option>';

  if (users.length) {
    html += '<optgroup label="Users">';
    users.forEach(u => {
      const sel = u.full_name === currentValue ? ' selected' : '';
      html += `<option value="${escHtml(u.full_name)}"${sel}>${escHtml(u.full_name)}</option>`;
    });
    html += '</optgroup>';
  }

  if (roles.length) {
    html += '<optgroup label="Roles">';
    roles.forEach(r => {
      const val = `role:${r}`;
      const sel = val === currentValue ? ' selected' : '';
      html += `<option value="${escHtml(val)}"${sel}>\u{1F465} ${escHtml(roleLabel(r))}</option>`;
    });
    html += '</optgroup>';
  }

  // Keep a legacy/unknown value visible if it matches neither a user nor a role
  const known = users.some(u => u.full_name === currentValue) ||
                roles.some(r => `role:${r}` === currentValue);
  if (currentValue && !known) {
    const disp = currentValue.startsWith('role:') ? `\u{1F465} ${roleLabel(currentValue.slice(5))}` : currentValue;
    html += `<option value="${escHtml(currentValue)}" selected>${escHtml(disp)}</option>`;
  }
  return html;
}

function userSelectOptions(currentValue) {
  const users = _usersList || [];
  let html = '<option value="">— Unassigned —</option>';
  users.forEach(u => {
    const sel = u.full_name === currentValue ? ' selected' : '';
    html += `<option value="${escHtml(u.full_name)}"${sel}>${escHtml(u.full_name)}</option>`;
  });
  // Keep legacy free-text value visible even if not in active users list
  if (currentValue && !users.find(u => u.full_name === currentValue)) {
    html += `<option value="${escHtml(currentValue)}" selected>${escHtml(currentValue)}</option>`;
  }
  return html;
}

function populateAssignedSelect(selId) {
  const sel = el(selId);
  if (!sel) return;
  sel.innerHTML = userSelectOptions('');
}

/* ── Well Issues ─────────────────────────────────────────────────────────── */
let wellIssuesLoaded  = false;
let wellIssues        = [];
let wellShowResolved  = false;
let _wellFilterWell   = '';
let _wellFilterArea   = '';
let _wellFilterQ      = '';

function initMaintWellsPanel() {
  if (wellIssuesLoaded) return;
  wellIssuesLoaded = true;
  el('well-issue-date').value = todayISO();
  loadWellIssues();
  loadUsersList().then(() => populateAssignedSelect('well-issue-assigned')).catch(() => {});
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

  // Wire filter bar
  el('well-filter-well').addEventListener('change', () => {
    _wellFilterWell = el('well-filter-well').value;
    applyWellFilters();
  });
  el('well-filter-area').addEventListener('change', () => {
    _wellFilterArea = el('well-filter-area').value;
    applyWellFilters();
  });
  let _wfqTimer;
  el('well-filter-q').addEventListener('input', () => {
    clearTimeout(_wfqTimer);
    _wfqTimer = setTimeout(() => {
      _wellFilterQ = el('well-filter-q').value.trim();
      applyWellFilters();
    }, 250);
  });
}

async function loadWellIssues() {
  try {
    wellIssues = await api('GET', `/api/well-issues?include_resolved=${wellShowResolved}`);
    populateWellFilterDropdowns();
    applyWellFilters();
    updateWellBadge();
  } catch {
    el('well-issue-list').innerHTML = `<div class="placeholder-msg">Failed to load issues</div>`;
  }
}

function populateWellFilterDropdowns() {
  const wellSel = el('well-filter-well');
  const prevWell = wellSel.value;
  const seenWells = new Map();
  wellIssues.forEach(i => { if (i.well_id && !seenWells.has(i.well_id)) seenWells.set(i.well_id, i); });
  const sortedWells = [...seenWells.values()].sort((a, b) => (a.well_name || '').localeCompare(b.well_name || ''));
  wellSel.innerHTML = '<option value="">All Wells</option>' +
    sortedWells.map(i => `<option value="${i.well_id}"${String(i.well_id) === prevWell ? ' selected' : ''}>${escHtml(i.well_area ? `${i.well_name} (${i.well_area})` : i.well_name || '')}</option>`).join('');

  const areaSel = el('well-filter-area');
  const prevArea = areaSel.value;
  const areas = [...new Set(wellIssues.map(i => i.well_area).filter(Boolean))].sort();
  areaSel.innerHTML = '<option value="">All Areas</option>' +
    areas.map(a => `<option value="${escHtml(a)}"${a === prevArea ? ' selected' : ''}>${escHtml(a)}</option>`).join('');
}

function applyWellFilters() {
  let items = wellIssues;
  if (_wellFilterWell) items = items.filter(i => String(i.well_id) === _wellFilterWell);
  if (_wellFilterArea) items = items.filter(i => i.well_area === _wellFilterArea);
  if (_wellFilterQ) {
    const q = _wellFilterQ.toLowerCase();
    items = items.filter(i =>
      [i.well_name, i.well_area, i.description, i.action_taken,
       i.resolution_notes, i.assigned_to, i.entered_by_full_name, i.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderWellIssues(items);
}

function updateWellBadge() {
  const count = wellIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-wells', count);
}

function renderWellIssues(items) {
  items = items ?? wellIssues;
  const list = el('well-issue-list');
  if (!items.length) {
    const hasFilters = _wellFilterWell || _wellFilterArea || _wellFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasFilters ? 'No matching issues.' : `No ${wellShowResolved ? '' : 'open '}issues`}</div>`;
    return;
  }
  list.innerHTML = items.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const title   = issue.well_area ? `${issue.well_name} (${issue.well_area})` : (issue.well_name || 'Unknown Well');
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    const entityName = (issue.well_name || 'well').replace(/[^a-zA-Z0-9-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'').slice(0,30);
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}" data-entity-name="${entityName}">
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
            <select class="ctrl-select issue-assigned">${userSelectOptions(issue.assigned_to)}</select>
          </div>
          <div class="form-group">
            <label>Attachments</label>
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm issue-inv-btn">${icon('invoice')} Invoice</button>
              <button type="button" class="btn btn-secondary btn-sm issue-pic-btn">${icon('photo')} Photo(s)</button>
              ${Number(issue.attachment_count) > 0 ? `<button type="button" class="btn btn-secondary btn-sm issue-files-btn" data-table="well_issues">${icon('attachments')} ${issue.attachment_count} file${issue.attachment_count > 1 ? 's' : ''}</button>` : ''}
            </div>
            <div class="maint-attach-queue issue-attach-queue hidden"></div>
            <div class="maint-hist-attach-area issue-files-area hidden"></div>
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-save issue-save-btn" style="flex:1" data-table="well_issues">Save Changes</button>
            <button class="btn btn-secondary issue-share-btn">&#8679; Share</button>
          </div>
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

  const _save = beginSave(el('well-submit-btn'));
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
    _save();
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
['well-issue-list','bldg-issue-list','equip-issue-list','canal-issue-list'].forEach(id =>
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

  if (e.target.classList.contains('issue-inv-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'well_issues'; issueInvInput.click(); return;
  }
  if (e.target.classList.contains('issue-pic-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'well_issues'; issuePicInput.click(); return;
  }
  if (e.target.classList.contains('issue-files-btn')) {
    const area = item.querySelector('.issue-files-area');
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=well_issues&record_id=${item.dataset.issueId}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => { const isPdf = a.mime_type==='application/pdf'||a.original_name.endsWith('.pdf'); const url=`/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`; return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}"><div class="maint-att-thumb">${isPdf?`<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>`:`<img src="${url}" loading="lazy" alt="">`}</div><span class="maint-att-type-badge">${a.file_type==='invoice'?'INV':'PIC'}</span><div class="maint-att-name">${a.original_name}</div></div>`; }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card => card.addEventListener('click', () => openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf==='true')));
    } catch (err) { area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`; }
    return;
  }
  if (e.target.classList.contains('issue-share-btn')) {
    shareMaintenanceReport(item.dataset.issueId, item, {
      issueArray:  wellIssues,
      tableName:   'well_issues',
      reportLabel: 'Well Issue Report',
      getTitle:    i => i.well_area ? `${i.well_name} (${i.well_area})` : (i.well_name || 'Unknown Well'),
      getGPS:      i => i.gps_latitude != null ? { lat: i.gps_latitude, lon: i.gps_longitude } : null,
      getRows:     i => [
        ['Well',       escHtml(i.well_name || '—')],
        i.well_area ? ['Area', escHtml(i.well_area)] : null,
        ['Status',     i.status.replace('_',' ')],
        ['Reported',   i.reported_date?.slice(0,10) || '—'],
        ['Entered By', escHtml(i.entered_by_full_name || i.entered_by || '—')],
        i.assigned_to     ? ['Assigned To',     escHtml(i.assigned_to)]      : null,
        i.action_taken     ? ['Action Taken',     escHtml(i.action_taken)]     : null,
        i.resolution_notes ? ['Resolution Notes', escHtml(i.resolution_notes)] : null,
        i.po_number        ? ['PO Number',        escHtml(i.po_number)]        : null,
        i.cost != null     ? ['Cost',             `$${Number(i.cost).toFixed(2)}`] : null,
      ].filter(Boolean),
    }); return;
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
      const pending = issueCardFiles.get(issueId);
      if (pending?.length) { await doUploadIssueAttachments(issueId, 'well_issues', pending, item.dataset.entityName); issueCardFiles.delete(issueId); }
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
let _bldgFilterSite   = '';
let _bldgFilterQ      = '';

function initMaintBuildingsPanel() {
  if (bldgIssuesLoaded) return;
  bldgIssuesLoaded = true;

  el('bldg-filter-site').addEventListener('change', () => { _bldgFilterSite = el('bldg-filter-site').value; applyBldgFilters(); });
  let _bfqT;
  el('bldg-filter-q').addEventListener('input', () => { clearTimeout(_bfqT); _bfqT = setTimeout(() => { _bldgFilterQ = el('bldg-filter-q').value.trim(); applyBldgFilters(); }, 250); });

  el('bldg-issue-date').value = todayISO();
  loadBldgIssues();
  loadUsersList().then(() => populateAssignedSelect('bldg-issue-assigned')).catch(() => {});
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
    populateBldgFilterDropdowns();
    applyBldgFilters();
    updateBldgBadge();
  } catch {
    el('bldg-issue-list').innerHTML = `<div class="placeholder-msg">Failed to load issues</div>`;
  }
}

function updateBldgBadge() {
  const count = bldgIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-buildings', count);
}

function populateBldgFilterDropdowns() {
  const sSel = el('bldg-filter-site');
  const prev = sSel.value;
  const sites = [...new Set(bldgIssues.map(i => i.site_name).filter(Boolean))].sort();
  sSel.innerHTML = '<option value="">All Sites</option>' +
    sites.map(s => `<option value="${escHtml(s)}"${s === prev ? ' selected' : ''}>${escHtml(s)}</option>`).join('');
}

function applyBldgFilters() {
  let items = bldgIssues;
  if (_bldgFilterSite) items = items.filter(i => i.site_name === _bldgFilterSite);
  if (_bldgFilterQ) {
    const q = _bldgFilterQ.toLowerCase();
    items = items.filter(i =>
      [i.site_name, i.building_name, i.description, i.action_taken,
       i.resolution_notes, i.assigned_to, i.entered_by_full_name, i.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderBldgIssues(items);
}

function renderBldgIssues(items) {
  items = items ?? bldgIssues;
  const list = el('bldg-issue-list');
  if (!items.length) {
    const hasF = _bldgFilterSite || _bldgFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching issues.' : `No ${bldgShowResolved ? '' : 'open '}issues`}</div>`;
    return;
  }
  list.innerHTML = items.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const title   = [issue.site_name, issue.building_name].filter(Boolean).join(' — ') || 'Unknown Building';
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    const entityName = (issue.building_name || 'building').replace(/[^a-zA-Z0-9-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'').slice(0,30);
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}" data-entity-name="${entityName}">
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
            <select class="ctrl-select issue-assigned">${userSelectOptions(issue.assigned_to)}</select>
          </div>
          <div class="form-group">
            <label>Attachments</label>
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm issue-inv-btn">${icon('invoice')} Invoice</button>
              <button type="button" class="btn btn-secondary btn-sm issue-pic-btn">${icon('photo')} Photo(s)</button>
              ${Number(issue.attachment_count) > 0 ? `<button type="button" class="btn btn-secondary btn-sm issue-files-btn" data-table="building_issues">${icon('attachments')} ${issue.attachment_count} file${issue.attachment_count > 1 ? 's' : ''}</button>` : ''}
            </div>
            <div class="maint-attach-queue issue-attach-queue hidden"></div>
            <div class="maint-hist-attach-area issue-files-area hidden"></div>
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-save issue-save-btn" style="flex:1" data-table="building_issues">Save Changes</button>
            <button class="btn btn-secondary issue-share-btn">&#8679; Share</button>
          </div>
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

  const _save = beginSave(el('bldg-submit-btn'));
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
    _save();
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

  if (e.target.classList.contains('issue-inv-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'building_issues'; issueInvInput.click(); return;
  }
  if (e.target.classList.contains('issue-pic-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'building_issues'; issuePicInput.click(); return;
  }
  if (e.target.classList.contains('issue-files-btn')) {
    const area = item.querySelector('.issue-files-area');
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=building_issues&record_id=${item.dataset.issueId}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => { const isPdf = a.mime_type==='application/pdf'||a.original_name.endsWith('.pdf'); const url=`/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`; return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}"><div class="maint-att-thumb">${isPdf?`<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>`:`<img src="${url}" loading="lazy" alt="">`}</div><span class="maint-att-type-badge">${a.file_type==='invoice'?'INV':'PIC'}</span><div class="maint-att-name">${a.original_name}</div></div>`; }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card => card.addEventListener('click', () => openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf==='true')));
    } catch (err) { area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`; }
    return;
  }
  if (e.target.classList.contains('issue-share-btn')) {
    shareMaintenanceReport(item.dataset.issueId, item, {
      issueArray:  bldgIssues,
      tableName:   'building_issues',
      reportLabel: 'Building Issue Report',
      getTitle:    i => [i.site_name, i.building_name].filter(Boolean).join(' — ') || 'Unknown Building',
      getRows:     i => [
        ['Site',       escHtml(i.site_name || '—')],
        ['Building',   escHtml(i.building_name || '—')],
        ['Status',     i.status.replace('_',' ')],
        ['Reported',   i.reported_date?.slice(0,10) || '—'],
        ['Entered By', escHtml(i.entered_by_full_name || i.entered_by || '—')],
        i.assigned_to     ? ['Assigned To',     escHtml(i.assigned_to)]      : null,
        i.action_taken     ? ['Action Taken',     escHtml(i.action_taken)]     : null,
        i.resolution_notes ? ['Resolution Notes', escHtml(i.resolution_notes)] : null,
        i.po_number        ? ['PO Number',        escHtml(i.po_number)]        : null,
        i.cost != null     ? ['Cost',             `$${Number(i.cost).toFixed(2)}`] : null,
      ].filter(Boolean),
    }); return;
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
      const pending = issueCardFiles.get(issueId);
      if (pending?.length) { await doUploadIssueAttachments(issueId, 'building_issues', pending, item.dataset.entityName); issueCardFiles.delete(issueId); }
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
let _equipFilterType  = '';
let _equipFilterQ     = '';
let equipNewType      = 'pump';

function initMaintEquipmentPanel() {
  if (equipIssuesLoaded) return;
  equipIssuesLoaded = true;

  el('equip-filter-type').addEventListener('change', () => { _equipFilterType = el('equip-filter-type').value; applyEquipFilters(); });
  let _efqT;
  el('equip-filter-q').addEventListener('input', () => { clearTimeout(_efqT); _efqT = setTimeout(() => { _equipFilterQ = el('equip-filter-q').value.trim(); applyEquipFilters(); }, 250); });

  el('equip-issue-date').value = todayISO();
  loadEquipIssues();
  loadEquipForNewIssue(equipNewType);
  loadUsersList().then(() => populateAssignedSelect('equip-issue-assigned')).catch(() => {});
}

async function loadEquipIssues() {
  try {
    equipIssues = await api('GET', `/api/equipment-issues?include_resolved=${equipShowResolved}`);
    applyEquipFilters();
    updateEquipBadge();
  } catch (err) {
    el('equip-issue-list').innerHTML = `<div class="placeholder-msg">Failed to load issues</div>`;
  }
}

function applyEquipFilters() {
  let items = equipIssues;
  if (_equipFilterType) items = items.filter(i => i.equipment_type === _equipFilterType);
  if (_equipFilterQ) {
    const q = _equipFilterQ.toLowerCase();
    items = items.filter(i =>
      [i.equipment_name, i.equipment_type, i.description, i.action_taken,
       i.resolution_notes, i.assigned_to, i.entered_by_full_name, i.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderEquipIssues(items);
}

function updateEquipBadge() {
  const count = equipIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-equipment', count);
}

function renderEquipIssues(items) {
  items = items ?? equipIssues;
  const list = el('equip-issue-list');
  if (!items.length) {
    const hasF = _equipFilterType || _equipFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching issues.' : `No ${equipShowResolved ? '' : 'open '}issues`}</div>`;
    return;
  }
  list.innerHTML = items.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    const entityName = (issue.equipment_name || issue.equipment_type || 'equip').replace(/[^a-zA-Z0-9-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'').slice(0,30);
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}" data-entity-name="${entityName}">
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
            <select class="ctrl-select issue-assigned">${userSelectOptions(issue.assigned_to)}</select>
          </div>
          <div class="form-group">
            <label>Attachments</label>
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm issue-inv-btn">${icon('invoice')} Invoice</button>
              <button type="button" class="btn btn-secondary btn-sm issue-pic-btn">${icon('photo')} Photo(s)</button>
              ${Number(issue.attachment_count) > 0 ? `<button type="button" class="btn btn-secondary btn-sm issue-files-btn" data-table="equipment_issues">${icon('attachments')} ${issue.attachment_count} file${issue.attachment_count > 1 ? 's' : ''}</button>` : ''}
            </div>
            <div class="maint-attach-queue issue-attach-queue hidden"></div>
            <div class="maint-hist-attach-area issue-files-area hidden"></div>
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-save issue-save-btn" style="flex:1" data-table="equipment_issues">Save Changes</button>
            <button class="btn btn-secondary issue-share-btn">&#8679; Share</button>
          </div>
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

  const _save = beginSave(el('equip-submit-btn'));
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
    _save();
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

  if (e.target.classList.contains('issue-inv-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'equipment_issues'; issueInvInput.click(); return;
  }
  if (e.target.classList.contains('issue-pic-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'equipment_issues'; issuePicInput.click(); return;
  }
  if (e.target.classList.contains('issue-files-btn')) {
    const area = item.querySelector('.issue-files-area');
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=equipment_issues&record_id=${item.dataset.issueId}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => { const isPdf = a.mime_type==='application/pdf'||a.original_name.endsWith('.pdf'); const url=`/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`; return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}"><div class="maint-att-thumb">${isPdf?`<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>`:`<img src="${url}" loading="lazy" alt="">`}</div><span class="maint-att-type-badge">${a.file_type==='invoice'?'INV':'PIC'}</span><div class="maint-att-name">${a.original_name}</div></div>`; }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card => card.addEventListener('click', () => openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf==='true')));
    } catch (err) { area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`; }
    return;
  }
  if (e.target.classList.contains('issue-share-btn')) {
    shareMaintenanceReport(item.dataset.issueId, item, {
      issueArray:  equipIssues,
      tableName:   'equipment_issues',
      reportLabel: 'Equipment Issue Report',
      getTitle:    i => i.equipment_name || i.equipment_type || 'Unknown Equipment',
      resolveGPS:  resolveGPSFromBlobs,
      getRows:     i => [
        ['Equipment',  escHtml(i.equipment_name || i.equipment_type || '—')],
        i.equipment_name && i.equipment_type ? ['Type', escHtml(i.equipment_type)] : null,
        ['Status',     i.status.replace('_',' ')],
        ['Reported',   i.reported_date?.slice(0,10) || '—'],
        ['Entered By', escHtml(i.entered_by_full_name || i.entered_by || '—')],
        i.assigned_to     ? ['Assigned To',     escHtml(i.assigned_to)]      : null,
        i.action_taken     ? ['Action Taken',     escHtml(i.action_taken)]     : null,
        i.resolution_notes ? ['Resolution Notes', escHtml(i.resolution_notes)] : null,
        i.po_number        ? ['PO Number',        escHtml(i.po_number)]        : null,
        i.cost != null     ? ['Cost',             `$${Number(i.cost).toFixed(2)}`] : null,
      ].filter(Boolean),
    }); return;
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
      const pending = issueCardFiles.get(issueId);
      if (pending?.length) { await doUploadIssueAttachments(issueId, 'equipment_issues', pending, item.dataset.entityName); issueCardFiles.delete(issueId); }
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

/* ── Canal Issues ────────────────────────────────────────────────────────── */
let canalIssues       = [];
let canalIssuesLoaded = false;
let canalShowResolved = false;
let _canalFilterPool  = '';
let _canalFilterQ     = '';
let canalNewPhotos    = []; // [{file, gps}] for new-issue form, gps is null until extracted

function initMaintCanalPanel() {
  if (canalIssuesLoaded) return;
  canalIssuesLoaded = true;

  el('canal-filter-pool').addEventListener('change', () => { _canalFilterPool = el('canal-filter-pool').value; applyCanalFilters(); });
  let _cfqT;
  el('canal-filter-q').addEventListener('input', () => { clearTimeout(_cfqT); _cfqT = setTimeout(() => { _canalFilterQ = el('canal-filter-q').value.trim(); applyCanalFilters(); }, 250); });

  el('canal-issue-date').value = todayISO();
  loadCanalIssues();
}

async function loadCanalIssues() {
  try {
    canalIssues = await api('GET', `/api/canal-issues?include_resolved=${canalShowResolved}`);
    populateCanalFilterDropdowns();
    applyCanalFilters();
    updateCanalBadge();
  } catch {
    el('canal-issue-list').innerHTML = `<div class="placeholder-msg">Failed to load issues</div>`;
  }
}

function updateCanalBadge() {
  const count = canalIssues.filter(i => i.status === 'open' || i.status === 'in_progress').length;
  setBadge('maint-badge-canal', count);
}

function populateCanalFilterDropdowns() {
  const pSel = el('canal-filter-pool');
  const prev = pSel.value;
  const pools = [...new Set(canalIssues.map(i => i.pool).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  pSel.innerHTML = '<option value="">All Pools</option>' +
    pools.map(p => `<option value="${escHtml(p)}"${p === prev ? ' selected' : ''}>Pool ${escHtml(p)}</option>`).join('');
}

function applyCanalFilters() {
  let items = canalIssues;
  if (_canalFilterPool) items = items.filter(i => String(i.pool) === _canalFilterPool);
  if (_canalFilterQ) {
    const q = _canalFilterQ.toLowerCase();
    items = items.filter(i =>
      [i.pool ? `pool ${i.pool}` : '', i.description, i.action_taken,
       i.resolution_notes, i.assigned_to, i.entered_by_full_name, i.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderCanalIssues(items);
}

function renderCanalIssues(items) {
  items = items ?? canalIssues;
  const list = el('canal-issue-list');
  if (!items.length) {
    const hasF = _canalFilterPool || _canalFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching issues.' : `No ${canalShowResolved ? '' : 'open '}issues`}</div>`;
    return;
  }
  list.innerHTML = items.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const title   = issue.pool ? `Pool ${escHtml(issue.pool)}` : 'Canal';
    const snippet = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    const entityName = `canal-pool${issue.pool || 'x'}`.slice(0, 30);
    const hasGPS = issue.gps_lat != null && issue.gps_lon != null;
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}" data-entity-name="${entityName}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${title}</div>
            <div class="equip-issue-snippet">${escHtml(snippet)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-pill ${statusClass}">${issue.status.replace('_',' ')}</span>
            <span class="equip-issue-date">${issue.reported_date?.slice(0,10) || ''}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Pool</label>
            <div style="font-size:0.9rem;padding:6px 0">${issue.pool ? `Pool ${escHtml(issue.pool)}` : '—'}</div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.description || '')}</div>
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
            <div class="form-group">
              <label>Notes</label>
              <textarea class="ctrl-textarea issue-notes" rows="2" placeholder="Additional notes…">${escHtml(issue.notes || '')}</textarea>
            </div>
          </div>
          <div class="form-group">
            <label>Attachments</label>
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm issue-inv-btn">${icon('invoice')} Invoice</button>
              <button type="button" class="btn btn-secondary btn-sm issue-pic-btn">${icon('photo')} Photo(s)</button>
              ${hasGPS ? `<button type="button" class="btn btn-secondary btn-sm canal-map-btn" data-lat="${issue.gps_lat}" data-lon="${issue.gps_lon}">&#127757; Map</button>` : ''}
              ${Number(issue.attachment_count) > 0 ? `<button type="button" class="btn btn-secondary btn-sm issue-files-btn" data-table="canal_issues">${icon('attachments')} ${issue.attachment_count} file${issue.attachment_count > 1 ? 's' : ''}</button>` : ''}
            </div>
            <div class="maint-attach-queue issue-attach-queue hidden"></div>
            <div class="maint-hist-attach-area issue-files-area hidden"></div>
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-save issue-save-btn" style="flex:1" data-table="canal_issues">Save Changes</button>
            <button class="btn btn-secondary issue-share-btn">&#8679; Share</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// New issue form toggle
el('canal-new-issue-btn').addEventListener('click', () => {
  el('canal-new-issue-form').classList.remove('hidden');
  el('canal-new-issue-btn').classList.add('hidden');
});
el('canal-cancel-btn').addEventListener('click', () => {
  el('canal-new-issue-form').classList.add('hidden');
  el('canal-new-issue-btn').classList.remove('hidden');
  el('canal-new-error').classList.add('hidden');
  resetCanalNewForm();
});

function resetCanalNewForm() {
  canalNewPhotos = [];
  el('canal-issue-pool').value = '';
  el('canal-issue-desc').value = '';
  el('canal-issue-date').value = todayISO();
  renderCanalNewPhotoList();
}

function renderCanalNewPhotoList() {
  const listEl = el('canal-new-photo-list');
  if (!canalNewPhotos.length) { listEl.innerHTML = ''; return; }
  listEl.innerHTML = canalNewPhotos.map((p, i) => `
    <div class="maint-aq-item">
      <span class="maint-aq-badge">PIC</span>
      <span style="flex:1;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.file.name)}</span>
      ${p.gps ? `<button type="button" class="canal-aq-map-btn" data-idx="${i}" style="padding:2px 7px;font-size:0.8rem;border:1px solid var(--border);border-radius:6px;background:var(--surface2);cursor:pointer">&#127757;</button>` : ''}
      <button class="maint-aq-remove canal-new-aq-remove" data-idx="${i}">×</button>
    </div>`).join('');
}

// One delegated listener — render only sets innerHTML, so handlers can't
// stack across re-renders as EXIF GPS results come in (E-1)
el('canal-new-photo-list').addEventListener('click', e => {
  const rm = e.target.closest('.canal-new-aq-remove');
  if (rm) {
    e.stopPropagation();
    canalNewPhotos.splice(parseInt(rm.dataset.idx), 1);
    renderCanalNewPhotoList();
    return;
  }
  const mapBtn = e.target.closest('.canal-aq-map-btn');
  if (mapBtn) {
    e.stopPropagation();
    const p = canalNewPhotos[parseInt(mapBtn.dataset.idx)];
    if (p?.gps) openGPSMap(p.gps.lat, p.gps.lon);
  }
});

// Photo picker for new issue (multiple)
const canalNewPhotoInput = document.createElement('input');
canalNewPhotoInput.type = 'file';
canalNewPhotoInput.accept = 'image/*';
canalNewPhotoInput.multiple = true;
canalNewPhotoInput.style.display = 'none';
document.body.appendChild(canalNewPhotoInput);

el('canal-new-photo-btn').addEventListener('click', () => canalNewPhotoInput.click());

canalNewPhotoInput.addEventListener('change', async () => {
  const files = [...canalNewPhotoInput.files];
  canalNewPhotoInput.value = '';
  if (!files.length) return;
  const newEntries = files.map(f => ({ file: f, gps: null }));
  canalNewPhotos.push(...newEntries);
  renderCanalNewPhotoList();
  // Extract GPS from each photo, re-render as results come in
  await Promise.all(newEntries.map(async entry => {
    entry.gps = await readExifGPS(entry.file);
    if (entry.gps) renderCanalNewPhotoList();
  }));
});

// Submit new canal issue
el('canal-submit-btn').addEventListener('click', async () => {
  clearError('canal-new-error');
  const desc = el('canal-issue-desc').value.trim();
  if (!desc) return showError('canal-new-error', 'Issue description is required');

  const _save = beginSave(el('canal-submit-btn'));
  try {
    const firstGPS = canalNewPhotos.find(p => p.gps)?.gps ?? null;
    const body = {
      pool:          el('canal-issue-pool').value || null,
      description:   desc,
      reported_date: el('canal-issue-date').value || null,
      gps_lat:       firstGPS?.lat ?? null,
      gps_lon:       firstGPS?.lon ?? null,
    };
    const newIssue = await api('POST', '/api/canal-issues', body);

    // Upload all attached photos
    if (canalNewPhotos.length) {
      const entityName = `canal-pool${body.pool || 'x'}`;
      const pending = canalNewPhotos.map(p => ({ file: p.file, fileType: 'photo' }));
      await doUploadIssueAttachments(newIssue.issue_id, 'canal_issues', pending, entityName);
    }

    el('canal-new-issue-form').classList.add('hidden');
    el('canal-new-issue-btn').classList.remove('hidden');
    resetCanalNewForm();
    canalIssuesLoaded = false;
    await loadCanalIssues();
    showToast('Issue submitted', 'success');
    refreshMaintenanceBadges();
  } catch (err) {
    showError('canal-new-error', err.message);
  } finally {
    _save();
  }
});

// Show/hide resolved toggle
el('canal-show-resolved-btn').addEventListener('click', () => {
  canalShowResolved = !canalShowResolved;
  el('canal-show-resolved-btn').textContent = canalShowResolved ? 'Hide Resolved' : 'Show Resolved';
  canalIssuesLoaded = false;
  loadCanalIssues();
});

// Issue list interactions (delegated)
el('canal-issue-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  if (e.target.closest('.equip-issue-header')) {
    item.querySelector('.equip-issue-body').classList.toggle('hidden');
    return;
  }

  if (e.target.classList.contains('issue-inv-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'canal_issues'; issueInvInput.click(); return;
  }
  if (e.target.classList.contains('issue-pic-btn')) {
    issueCardActiveId = item.dataset.issueId; issueCardActiveTable = 'canal_issues'; issuePicInput.click(); return;
  }
  if (e.target.classList.contains('canal-map-btn')) {
    openGPSMap(parseFloat(e.target.dataset.lat), parseFloat(e.target.dataset.lon)); return;
  }
  if (e.target.classList.contains('issue-share-btn')) {
    shareMaintenanceReport(item.dataset.issueId, item, {
      issueArray:  canalIssues,
      tableName:   'canal_issues',
      reportLabel: 'Canal Report',
      getTitle:    i => i.pool ? `Pool ${i.pool}` : 'Canal',
      getGPS:      i => i.gps_lat != null ? { lat: i.gps_lat, lon: i.gps_lon } : null,
      getRows:     i => [
        ['Pool',       i.pool ? `Pool ${escHtml(i.pool)}` : '—'],
        ['Status',     i.status.replace('_',' ')],
        ['Reported',   i.reported_date?.slice(0,10) || '—'],
        ['Entered By', escHtml(i.entered_by_full_name || i.entered_by || '—')],
        i.action_taken     ? ['Action Taken',     escHtml(i.action_taken)]     : null,
        i.resolution_notes ? ['Resolution Notes', escHtml(i.resolution_notes)] : null,
        i.po_number        ? ['PO Number',        escHtml(i.po_number)]        : null,
        i.cost != null     ? ['Cost',             `$${Number(i.cost).toFixed(2)}`] : null,
        i.notes            ? ['Notes',            escHtml(i.notes)]            : null,
      ].filter(Boolean),
    }); return;
  }
  if (e.target.classList.contains('issue-files-btn')) {
    const area = item.querySelector('.issue-files-area');
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=canal_issues&record_id=${item.dataset.issueId}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => { const isPdf = a.mime_type==='application/pdf'||a.original_name.endsWith('.pdf'); const url=`/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`; return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}"><div class="maint-att-thumb">${isPdf?`<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>`:`<img src="${url}" loading="lazy" alt="">`}</div><span class="maint-att-type-badge">${a.file_type==='invoice'?'INV':'PIC'}</span><div class="maint-att-name">${a.original_name}</div></div>`; }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card => card.addEventListener('click', () => openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf==='true')));
    } catch (err) { area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`; }
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
    const notes       = item.querySelector('.issue-notes').value.trim()        || null;
    const errEl       = item.querySelector('.issue-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      const pending   = issueCardFiles.get(issueId) || [];
      const cardGPS   = pending.find(e => e.fileType === 'photo' && e.gps)?.gps ?? null;
      await api('PATCH', `/api/canal-issues/${issueId}`, {
        status, action_taken: actionTaken, resolution_notes: resNotes,
        po_number: poNumber, cost, notes,
        gps_lat: cardGPS?.lat ?? null,
        gps_lon: cardGPS?.lon ?? null,
      });
      if (pending.length) { await doUploadIssueAttachments(issueId, 'canal_issues', pending, item.dataset.entityName); issueCardFiles.delete(issueId); }
      canalIssuesLoaded = false;
      await loadCanalIssues();
      showToast('Issue updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

// ── Dirt Work Issues ─────────────────────────────────────────────────────────
let dirtWorkIssues    = [];
let dirtWorkLoaded    = false;
let dirtWorkShowResolved = false;
let _dirtFilterPool   = '';
let _dirtFilterType   = '';
let _dirtFilterQ      = '';
let dirtWorkNewLat    = null;
let dirtWorkNewLon    = null;
let dirtWorkNewPhotos = [];

async function initDirtWorkScreen() {
  // Refresh assignee options (users + roles) and data on every visit.
  await Promise.all([loadUsersList(), loadRolesList()]);
  el('dirt-issue-assigned').innerHTML = assigneeSelectOptions('');
  loadDirtWorkIssues();

  // Wire listeners only once.
  if (dirtWorkLoaded) return;
  dirtWorkLoaded = true;

  el('dirt-filter-pool').addEventListener('change', () => { _dirtFilterPool = el('dirt-filter-pool').value; applyDirtFilters(); });
  el('dirt-filter-type').addEventListener('change', () => { _dirtFilterType = el('dirt-filter-type').value; applyDirtFilters(); });
  let _dqT;
  el('dirt-filter-q').addEventListener('input', () => {
    clearTimeout(_dqT);
    _dqT = setTimeout(() => { _dirtFilterQ = el('dirt-filter-q').value.trim(); applyDirtFilters(); }, 250);
  });

  el('dirt-issue-date').value = todayISO();

  el('dirt-new-issue-btn').addEventListener('click', () => {
    el('dirt-new-issue-form').classList.remove('hidden');
    el('dirt-new-issue-btn').classList.add('hidden');
  });

  el('dirt-cancel-btn').addEventListener('click', () => {
    el('dirt-new-issue-form').classList.add('hidden');
    el('dirt-new-issue-btn').classList.remove('hidden');
    el('dirt-new-error').classList.add('hidden');
    resetDirtNewForm();
  });

  el('dirt-new-loc-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('Geolocation not available', 'error');
    el('dirt-new-loc-btn').disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      dirtWorkNewLat = pos.coords.latitude;
      dirtWorkNewLon = pos.coords.longitude;
      el('dirt-new-coords').textContent = `${dirtWorkNewLat.toFixed(6)}, ${dirtWorkNewLon.toFixed(6)}`;
      el('dirt-new-map-btn').classList.remove('hidden');
      el('dirt-new-loc-btn').disabled = false;
    }, () => {
      showToast('Could not get location', 'error');
      el('dirt-new-loc-btn').disabled = false;
    });
  });

  el('dirt-new-map-btn').addEventListener('click', () => {
    const lat = dirtWorkNewLat ?? 36.5;
    const lon = dirtWorkNewLon ?? -119.5;
    openGPSMapPick(lat, lon, (newLat, newLon) => {
      dirtWorkNewLat = newLat;
      dirtWorkNewLon = newLon;
      el('dirt-new-coords').textContent = `${newLat.toFixed(6)}, ${newLon.toFixed(6)}`;
    });
  });

  // Photo picker for new issue
  const dirtNewPhotoInput = document.createElement('input');
  dirtNewPhotoInput.type = 'file';
  dirtNewPhotoInput.accept = 'image/*';
  dirtNewPhotoInput.multiple = true;
  dirtNewPhotoInput.style.display = 'none';
  document.body.appendChild(dirtNewPhotoInput);

  el('dirt-new-photo-btn').addEventListener('click', () => dirtNewPhotoInput.click());

  dirtNewPhotoInput.addEventListener('change', async () => {
    const files = [...dirtNewPhotoInput.files];
    dirtNewPhotoInput.value = '';
    if (!files.length) return;
    const entries = files.map(f => ({ file: f, gps: null }));
    dirtWorkNewPhotos.push(...entries);
    renderDirtNewPhotoList();
    await Promise.all(entries.map(async entry => {
      entry.gps = await readExifGPS(entry.file);
      if (entry.gps) renderDirtNewPhotoList();
    }));
  });

  el('dirt-new-photo-list').addEventListener('click', e => {
    const rm = e.target.closest('.maint-aq-remove');
    if (rm) {
      dirtWorkNewPhotos.splice(parseInt(rm.dataset.idx), 1);
      renderDirtNewPhotoList();
    }
  });

  el('dirt-submit-btn').addEventListener('click', async () => {
    clearError('dirt-new-error');
    const desc = el('dirt-issue-desc').value.trim();
    if (!desc) return showError('dirt-new-error', 'Description is required');
    const _save = beginSave(el('dirt-submit-btn'));
    try {
      const photoGPS = dirtWorkNewPhotos.find(p => p.gps)?.gps ?? null;
      const lat = dirtWorkNewLat ?? photoGPS?.lat ?? null;
      const lon = dirtWorkNewLon ?? photoGPS?.lon ?? null;
      const body = {
        pool:           el('dirt-issue-pool').value || null,
        work_type:      el('dirt-issue-type').value || null,
        description:    desc,
        location_notes: el('dirt-issue-location').value.trim() || null,
        assigned_to:    el('dirt-issue-assigned').value || null,
        reported_date:  el('dirt-issue-date').value || null,
        notes:          el('dirt-issue-notes').value.trim() || null,
        gps_lat:        lat,
        gps_lon:        lon,
      };
      const newIssue = await api('POST', '/api/dirt-work-issues', body);
      if (dirtWorkNewPhotos.length) {
        const entityName = `dirt-pool${body.pool || 'x'}`;
        const pending = dirtWorkNewPhotos.map(p => ({ file: p.file, fileType: 'photo' }));
        await doUploadIssueAttachments(newIssue.issue_id, 'dirt_work_issues', pending, entityName);
      }
      el('dirt-new-issue-form').classList.add('hidden');
      el('dirt-new-issue-btn').classList.remove('hidden');
      resetDirtNewForm();
      await loadDirtWorkIssues();
      showToast('Issue submitted', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      showError('dirt-new-error', err.message);
    } finally {
      _save();
    }
  });

  el('dirt-show-resolved-btn').addEventListener('click', () => {
    dirtWorkShowResolved = !dirtWorkShowResolved;
    el('dirt-show-resolved-btn').textContent = dirtWorkShowResolved ? 'Hide Resolved' : 'Show Resolved';
    loadDirtWorkIssues();
  });
}

function resetDirtNewForm() {
  dirtWorkNewPhotos = [];
  dirtWorkNewLat = null;
  dirtWorkNewLon = null;
  el('dirt-issue-pool').value = '';
  el('dirt-issue-type').value = '';
  el('dirt-issue-desc').value = '';
  el('dirt-issue-location').value = '';
  el('dirt-issue-assigned').value = '';
  el('dirt-issue-date').value = todayISO();
  el('dirt-issue-notes').value = '';
  el('dirt-new-coords').textContent = '';
  el('dirt-new-map-btn').classList.add('hidden');
  renderDirtNewPhotoList();
}

function renderDirtNewPhotoList() {
  const listEl = el('dirt-new-photo-list');
  if (!dirtWorkNewPhotos.length) { listEl.innerHTML = ''; return; }
  listEl.innerHTML = dirtWorkNewPhotos.map((p, i) => `
    <div class="maint-aq-item">
      <span class="maint-aq-badge">PIC</span>
      <span style="flex:1;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.file.name)}</span>
      <button class="maint-aq-remove" data-idx="${i}">×</button>
    </div>`).join('');
}

async function loadDirtWorkIssues() {
  try {
    dirtWorkIssues = await api('GET', `/api/dirt-work-issues?include_resolved=${dirtWorkShowResolved}`);
    populateDirtFilterDropdowns();
    applyDirtFilters();
  } catch {
    el('dirt-issue-list').innerHTML = `<div class="placeholder-msg">Failed to load.</div>`;
  }
}

function populateDirtFilterDropdowns() {
  const pSel = el('dirt-filter-pool');
  const prevPool = pSel.value;
  const pools = [...new Set(dirtWorkIssues.map(i => i.pool).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  pSel.innerHTML = '<option value="">All Pools</option>' +
    pools.map(p => `<option value="${escHtml(p)}"${p === prevPool ? ' selected' : ''}>Pool ${escHtml(p)}</option>`).join('');

  const tSel = el('dirt-filter-type');
  const prevType = tSel.value;
  const types = [...new Set(dirtWorkIssues.map(i => i.work_type).filter(Boolean))].sort();
  tSel.innerHTML = '<option value="">All Types</option>' +
    types.map(t => `<option value="${escHtml(t)}"${t === prevType ? ' selected' : ''}>${escHtml(t)}</option>`).join('');
}

function applyDirtFilters() {
  let items = dirtWorkIssues;
  if (_dirtFilterPool) items = items.filter(i => String(i.pool) === _dirtFilterPool);
  if (_dirtFilterType) items = items.filter(i => i.work_type === _dirtFilterType);
  if (_dirtFilterQ) {
    const q = _dirtFilterQ.toLowerCase();
    items = items.filter(i =>
      [i.pool ? `pool ${i.pool}` : '', i.work_type, i.description, i.location_notes,
       i.action_taken, i.resolution_notes, i.assigned_to, i.entered_by_full_name, i.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderDirtWorkIssues(items);
}

function renderDirtWorkIssues(items) {
  const list = el('dirt-issue-list');
  if (!items.length) {
    const hasF = _dirtFilterPool || _dirtFilterType || _dirtFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching issues.' : `No ${dirtWorkShowResolved ? '' : 'open '}issues.`}</div>`;
    return;
  }
  list.innerHTML = items.map(issue => {
    const statusClass = issue.status.replace('_', '-');
    const poolLabel   = issue.pool ? `Pool ${escHtml(issue.pool)}` : 'No Pool';
    const typeLabel   = issue.work_type ? ` — ${escHtml(issue.work_type)}` : '';
    const snippet     = (issue.description || '').slice(0, 80) + (issue.description?.length > 80 ? '…' : '');
    const entityName  = `dirt-pool${issue.pool || 'x'}`.slice(0, 30);
    const hasGPS      = issue.gps_lat != null && issue.gps_lon != null;
    return `
      <div class="equip-issue-item" data-issue-id="${issue.issue_id}" data-entity-name="${entityName}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${poolLabel}${typeLabel}</div>
            <div class="equip-issue-snippet">${escHtml(snippet)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-pill ${statusClass}">${issue.status.replace('_',' ')}</span>
            <span class="equip-issue-date">${issue.reported_date?.slice(0,10) || ''}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Pool</label>
            <div style="font-size:0.9rem;padding:6px 0">${issue.pool ? `Pool ${escHtml(issue.pool)}` : '—'}</div>
          </div>
          <div class="form-group">
            <label>Work Type</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.work_type || '—')}</div>
          </div>
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.description || '')}</div>
          </div>
          ${issue.location_notes ? `<div class="form-group"><label>Location Notes</label><div style="font-size:0.9rem;padding:6px 0">${escHtml(issue.location_notes)}</div></div>` : ''}
          <div class="form-group">
            <label>Assigned To</label>
            <select class="ctrl-select issue-assigned">${assigneeSelectOptions(issue.assigned_to)}</select>
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
            <label>Notes</label>
            <textarea class="ctrl-textarea issue-notes" rows="2" placeholder="Additional notes…">${escHtml(issue.notes || '')}</textarea>
          </div>
          <div class="form-group">
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm issue-pic-btn">${icon('photo')} Photo(s)</button>
              ${hasGPS ? `<button type="button" class="btn btn-secondary btn-sm dirt-map-btn" data-lat="${issue.gps_lat}" data-lon="${issue.gps_lon}">&#127757; Map</button>
              <button type="button" class="btn btn-secondary btn-sm dirt-pick-btn" data-lat="${issue.gps_lat}" data-lon="${issue.gps_lon}">&#128204; Update Location</button>` : `<button type="button" class="btn btn-secondary btn-sm dirt-pick-btn" data-lat="" data-lon="">&#128204; Set Location</button>`}
              ${Number(issue.attachment_count) > 0 ? `<button type="button" class="btn btn-secondary btn-sm issue-files-btn">${icon('attachments')} ${issue.attachment_count} file${issue.attachment_count > 1 ? 's' : ''}</button>` : ''}
            </div>
            <div class="maint-attach-queue issue-attach-queue hidden"></div>
            <div class="maint-hist-attach-area issue-files-area hidden"></div>
          </div>
          <div class="error-msg hidden issue-update-error"></div>
          <button class="btn btn-save issue-save-btn" style="width:100%" data-table="dirt_work_issues">Save Changes</button>
        </div>
      </div>`;
  }).join('');

  // Wire status-change visibility for action/resolution groups
  list.querySelectorAll('.issue-status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const body = sel.closest('.equip-issue-body');
      body.querySelector('.issue-action-group').style.display = sel.value === 'in_progress' ? '' : 'none';
      body.querySelector('.issue-res-group').style.display    = sel.value === 'resolved'    ? '' : 'none';
    });
  });
}

// Issue list interactions for dirt work (delegated)
el('dirt-issue-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  if (e.target.closest('.equip-issue-header')) {
    item.querySelector('.equip-issue-body').classList.toggle('hidden');
    return;
  }

  if (e.target.classList.contains('issue-pic-btn')) {
    issueCardActiveId = item.dataset.issueId;
    issueCardActiveTable = 'dirt_work_issues';
    issuePicInput.click();
    return;
  }

  if (e.target.classList.contains('dirt-map-btn')) {
    openGPSMap(parseFloat(e.target.dataset.lat), parseFloat(e.target.dataset.lon));
    return;
  }

  if (e.target.classList.contains('dirt-pick-btn')) {
    const lat = parseFloat(e.target.dataset.lat) || 36.5;
    const lon = parseFloat(e.target.dataset.lon) || -119.5;
    const issueId = item.dataset.issueId;
    openGPSMapPick(lat, lon, async (newLat, newLon) => {
      try {
        await api('PATCH', `/api/dirt-work-issues/${issueId}`, { gps_lat: newLat, gps_lon: newLon });
        await loadDirtWorkIssues();
        showToast('Location updated', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });
    return;
  }

  if (e.target.classList.contains('issue-files-btn')) {
    const area = item.querySelector('.issue-files-area');
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=dirt_work_issues&record_id=${item.dataset.issueId}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => {
        const isPdf = a.mime_type === 'application/pdf' || a.original_name.endsWith('.pdf');
        const url   = `/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`;
        return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}">
          <div class="maint-att-thumb">${isPdf ? `<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>` : `<img src="${url}" loading="lazy" alt="">`}</div>
          <span class="maint-att-type-badge">PIC</span>
          <div class="maint-att-name">${a.original_name}</div>
        </div>`;
      }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card =>
        card.addEventListener('click', () => openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf === 'true'))
      );
    } catch (err) { area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`; }
    return;
  }

  if (e.target.classList.contains('issue-save-btn')) {
    const issueId     = item.dataset.issueId;
    const status      = item.querySelector('.issue-status-select').value;
    const actionTaken = item.querySelector('.issue-action-taken').value.trim() || null;
    const resNotes    = item.querySelector('.issue-res-notes').value.trim()    || null;
    const poNumber    = item.querySelector('.issue-po-number')?.value.trim()   || null;
    const costVal     = item.querySelector('.issue-cost')?.value;
    const cost        = costVal !== '' ? parseFloat(costVal) : null;
    const notes       = item.querySelector('.issue-notes').value.trim()        || null;
    const assignedTo  = item.querySelector('.issue-assigned').value             || null;
    const errEl       = item.querySelector('.issue-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      const pending = issueCardFiles.get(issueId) || [];
      await api('PATCH', `/api/dirt-work-issues/${issueId}`, {
        status, action_taken: actionTaken, resolution_notes: resNotes,
        po_number: poNumber, cost, notes, assigned_to: assignedTo,
      });
      if (pending.length) {
        await doUploadIssueAttachments(issueId, 'dirt_work_issues', pending, item.dataset.entityName);
        issueCardFiles.delete(issueId);
      }
      await loadDirtWorkIssues();
      showToast('Issue updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

// ── Issue Share / Report ──────────────────────────────────────────────────────

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function addPinToMapImage(dataUri, w, h) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      // shadow
      ctx.beginPath(); ctx.arc(cx + 1, cy + 1, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      // red circle
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#e53935'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      // white centre dot
      ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

async function resolveGPSFromBlobs(blobs) {
  for (const blob of blobs) {
    const gps = await readExifGPS(blob);
    if (gps) return gps;
  }
  return null;
}

// ── Generic maintenance report (used by all issue sections) ──────────────────
// cfg: { issueArray, tableName, reportLabel, getTitle(i), getRows(i), getGPS?(i), resolveGPS?(blobs) }
async function shareMaintenanceReport(issueId, item, cfg) {
  const btn = item.querySelector('.issue-share-btn');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const issue = cfg.issueArray.find(i => String(i.issue_id) === String(issueId));
    if (!issue) throw new Error('Issue not found');

    // Fetch photo blobs; keep blobs available for EXIF GPS extraction before converting
    const atts = await api('GET', `/api/maintenance/attachments?table_name=${cfg.tableName}&record_id=${issueId}`);
    const photos = atts.filter(a => a.file_type === 'photo' && !a.mime_type?.includes('pdf'));
    const photoBlobs = (await Promise.all(photos.map(async a => {
      try {
        const url = `/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`;
        return await (await fetch(url)).blob();
      } catch { return null; }
    }))).filter(Boolean);
    const photoUris = await Promise.all(photoBlobs.map(b => blobToDataUri(b)));

    // GPS: from issue record (getGPS) or scanned from photo EXIF (resolveGPS)
    let gps = cfg.getGPS ? cfg.getGPS(issue) : null;
    if (!gps && cfg.resolveGPS) gps = await cfg.resolveGPS(photoBlobs);

    // Optional GPS map with pin.
    // Use a Web Mercator (EPSG:3857) bbox so the GPS point falls exactly at the
    // image pixel center where the pin is drawn. A geographic (4326) bbox renders
    // in Mercator, making equal-degree lat/lon intervals map to unequal pixel
    // distances — which shifts the pin off the true location.
    let mapSrc = null;
    if (gps) {
      const R = 6378137;
      const mx = R * gps.lon * Math.PI / 180;
      const my = R * Math.log(Math.tan(Math.PI / 4 + gps.lat * Math.PI / 360));
      const padX = 250, padY = 125; // metres; 2:1 matches the 600×300 px image
      const bbox = `${mx-padX},${my-padY},${mx+padX},${my+padY}`;
      const esriUrl = `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=3857&size=600,300&imageSR=3857&f=image`;
      try {
        const resp = await fetch(esriUrl);
        if (resp.ok) mapSrc = await addPinToMapImage(await blobToDataUri(await resp.blob()), 600, 300);
        else mapSrc = esriUrl;
      } catch { mapSrc = esriUrl; }
    }

    // Filename: equipment name (well / building / equipment / pool) + date
    const reportDate = issue.reported_date ? String(issue.reported_date).slice(0, 10) : todayISO();
    const fileName = `${cfg.getTitle(issue)} ${reportDate}`
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || `${cfg.tableName}-${issueId}`;

    showMaintenanceReportPreview({
      reportLabel: cfg.reportLabel,
      title:       cfg.getTitle(issue),
      rows:        cfg.getRows(issue),
      description: issue.description || '',
      mapSrc, gps, photoUris,
      filename:    fileName,
    });
  } catch (err) {
    showToast('Failed to prepare report: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↑ Share';
  }
}

function buildMaintenanceReportHtml({ reportLabel, title, rows, description, mapSrc, gps, photoUris }) {
  const lat = gps ? Number(gps.lat).toFixed(6) : null;
  const lon = gps ? Number(gps.lon).toFixed(6) : null;

  // Location section: satellite map when GPS is available, first photo as fallback
  const locationImg   = mapSrc || (photoUris.length ? photoUris[0] : null);
  const photoFallback = !mapSrc && photoUris.length > 0;
  const galleryPhotos = photoFallback ? photoUris.slice(1) : photoUris;

  return `
    <div class="ir-logo-row"><img src="/icons/kcwa-seal-192.png" class="ir-logo" alt="KCWA"></div>
    <div class="ir-header">
      <div class="ir-title">${escHtml(reportLabel)} — ${escHtml(title)}</div>
      <div class="ir-meta">${new Date().toLocaleDateString()}</div>
    </div>
    <table class="ir-table">
      ${rows.map(([k,v]) => `<tr><th>${escHtml(k)}</th><td>${v}</td></tr>`).join('')}
    </table>
    <div class="ir-section">
      <div class="ir-section-label">Description</div>
      <div class="ir-text">${escHtml(description).replace(/\n/g,'<br>')}</div>
    </div>
    ${locationImg ? `
    <div class="ir-section">
      <div class="ir-section-label">Location${photoFallback ? ' (site photo)' : ''}</div>
      <img src="${locationImg}" class="${photoFallback ? 'ir-photo' : 'ir-map'}" alt="${photoFallback ? 'Site photo' : 'Location map'}" ${mapSrc ? 'crossorigin="anonymous"' : ''}>
      ${gps ? `<a href="#" class="ir-coords" data-lat="${lat}" data-lon="${lon}">${lat}, ${lon}</a>` : ''}
    </div>` : ''}
    ${galleryPhotos.length ? `
    <div class="ir-section">
      <div class="ir-section-label">Photos (${galleryPhotos.length})</div>
      <div class="ir-photos">
        ${galleryPhotos.map(uri => `<img src="${uri}" class="ir-photo" alt="">`).join('')}
      </div>
    </div>` : ''}`;
}

/* ── Share helpers ───────────────────────────────────────────────────────────
   All exports (CSV / Excel / PDF) flow through these so the user gets the OS
   share sheet (with Print, Save to Files, Mail, AirDrop, etc.) instead of a
   forced download or print dialog. On platforms without file-share support
   (most desktop browsers) they transparently fall back to a download. */

// Share a ready-made file blob, or download it if sharing isn't available.
async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user dismissed the sheet
      // any other share error → fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render an in-DOM element to a PDF blob and share it.
async function sharePdfFromElement(element, filename, title, opts = {}) {
  // html2canvas doesn't support object-fit — clamp .ir-photo elements to their
  // natural aspect ratio so photos don't stretch to fill their container width.
  const maxW = (element.offsetWidth || 754) - 20;
  const maxH = 340;
  element.querySelectorAll('.ir-photo').forEach(img => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    let w = Math.min(img.naturalWidth, maxW);
    let h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    img.style.cssText += `;width:${Math.round(w)}px;height:${Math.round(h)}px;max-width:none;max-height:none;object-fit:unset`;
  });
  const blob = await html2pdf()
    .set({
      margin: opts.margin ?? 8,
      image: { type: 'jpeg', quality: 0.92 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#fff', logging: false },
      jsPDF: { unit: 'mm', format: opts.format || 'a4', orientation: opts.orientation || 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .from(element)
    .outputPdf('blob');
  await shareFile(blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`, title);
}

// Wait for all <img> in a freshly-built off-screen node to finish loading,
// otherwise html2canvas can capture before the KCWA logo / map / photos paint.
function waitForImages(root) {
  const imgs = [...root.querySelectorAll('img')];
  return Promise.all(imgs.map(img =>
    (img.complete && img.naturalWidth)
      ? Promise.resolve()
      : new Promise(res => { img.onload = img.onerror = res; setTimeout(res, 3000); })
  ));
}

// Render an HTML string with its own print CSS off-screen (always on a white
// page, never the dark app theme) and share it as a PDF. A KCWA logo is added
// at the top-left unless opts.noLogo is set.
async function sharePdfFromHtml(innerHtml, cssText, filename, title, opts = {}) {
  const logo = opts.noLogo ? '' :
    `<div class="pdf-logo-row"><img src="/icons/kcwa-seal-192.png" class="pdf-logo" alt="KCWA"></div>`;
  const logoCss = `.pdf-logo-row{margin-bottom:8px}.pdf-logo{height:46px;width:auto;display:block}`;
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${opts.widthPx || 794}px;background:#fff;color:#000;`;
  holder.innerHTML = `<style>${cssText}${logoCss}</style><div class="pdf-root">${logo}${innerHtml}</div>`;
  document.body.appendChild(holder);
  try {
    await waitForImages(holder);
    await sharePdfFromElement(holder.querySelector('.pdf-root'), filename, title, opts);
  } finally {
    holder.remove();
  }
}

// Shared light-theme CSS for tabular report-card PDFs (wells, piezometers,
// ponds, mileage). page-break-inside:avoid keeps table rows whole across pages.
const REPORT_PDF_CSS = `
  /* resolve CSS vars that may appear in card.outerHTML inline styles */
  .pdf-root { --green:#16a34a; --text-dim:#6b7280; --border:#e5e7eb; --red-light:#ef4444; --accent:#3b82f6; }
  body { font-family: Arial, sans-serif; color: #000; font-size: 10pt; margin: 0; }
  .report-card { background: #fff; color: #000; }
  .report-title { font-size: 14pt; font-weight: 700; text-align: center; margin: 0 0 3px; }
  .report-subtitle { font-size: 9pt; text-align: center; color: #444; margin: 0 0 10px; }
  .report-section-title { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin: 10px 0 3px; border-bottom: 1px solid #000; padding-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 4px; }
  th { text-align: left; padding: 2px 5px; font-size: 8pt; font-weight: 700; text-transform: uppercase; border-bottom: 1.5px solid #000; }
  td { padding: 2px 5px; border-bottom: 0.5px solid #ddd; }
  tr { page-break-inside: avoid; }
  .report-num { text-align: right; }
  .dripper-check, .dripper-area-all { display: none !important; }
  [style*="border-top:2px"] { border-top: 2px solid #000 !important; padding-top: 10px; }`;

// Compact variant so the whole vehicle/mileage fleet fits one portrait page.
const MILEAGE_PDF_CSS = `
  body { font-family: Arial, sans-serif; color: #000; margin: 0; }
  .report-card { background: #fff; color: #000; }
  .pdf-logo-row { margin-bottom: 4px !important; }
  .report-title { font-size: 12pt; font-weight: 700; text-align: center; margin: 0 0 2px; }
  .report-subtitle { font-size: 7.5pt; text-align: center; color: #444; margin: 0 0 4px; }
  .report-section-title { font-size: 6.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0 1px; border-bottom: 1px solid #000; padding-bottom: 1px; }
  table { width: 100%; border-collapse: collapse; font-size: 6.5pt; margin-bottom: 2px; }
  th { text-align: left; padding: 1px 3px; font-size: 6pt; font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #000; }
  td { padding: 1px 3px; border-bottom: 0.5px solid #ddd; }
  tr { page-break-inside: avoid; }
  .report-num { text-align: right; }
  .report-empty { font-size: 6.5pt; color: #666; padding: 2px 0; }`;

function showMaintenanceReportPreview({ reportLabel, title, rows, description, mapSrc, gps, photoUris, filename }) {
  document.getElementById('issue-report-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'issue-report-modal';
  modal.className = 'report-preview-overlay';
  modal.innerHTML = `
    <div class="report-preview-bar">
      <button class="btn btn-secondary btn-sm" id="rp-close">&times; Close</button>
      <span class="report-preview-bar-title">${escHtml(title)}</span>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-save btn-sm" id="rp-share">&#8679; Share / Export</button>
      </div>
    </div>
    <div class="report-preview-scroll">
      <div class="ir-content" id="ir-body">
        ${buildMaintenanceReportHtml({ reportLabel, title, rows, description, mapSrc, gps, photoUris })}
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#rp-close').addEventListener('click', () => modal.remove());

  modal.querySelector('.ir-coords')?.addEventListener('click', e => {
    e.preventDefault();
    const { lat, lon } = e.currentTarget.dataset;
    const ua = navigator.userAgent;
    const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua) && !ua.includes('Windows');
    window.open(
      isApple ? `https://maps.apple.com/?ll=${lat},${lon}&t=k&z=17&q=Issue+Location`
              : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
      '_blank'
    );
  });

  modal.querySelector('#rp-share').addEventListener('click', async () => {
    const shareBtn = modal.querySelector('#rp-share');
    shareBtn.disabled = true;
    shareBtn.textContent = 'Generating…';
    try {
      await sharePdfFromElement(modal.querySelector('#ir-body'), filename, `${reportLabel} — ${title}`);
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Share failed: ' + err.message, 'error');
    } finally {
      shareBtn.disabled = false;
      shareBtn.innerHTML = '&#8679; Share';
    }
  });
}

// ── EXIF GPS reader ───────────────────────────────────────────────────────────
async function readExifGPS(file) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const buf  = await file.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return null;

    let markerOff = 2;
    while (markerOff + 4 < buf.byteLength) {
      const marker = view.getUint16(markerOff);
      const segLen = view.getUint16(markerOff + 2);
      if (marker === 0xFFE1 &&
          view.getUint32(markerOff + 4) === 0x45786966 &&
          view.getUint16(markerOff + 8) === 0) {
        const tiff = markerOff + 10;
        const le   = view.getUint16(tiff) === 0x4949;
        const u16  = o => view.getUint16(tiff + o, le);
        const u32  = o => view.getUint32(tiff + o, le);
        const rat  = o => { const n = u32(o), d = u32(o + 4); return d ? n / d : 0; };

        const ifd0    = u32(4);
        const n0      = u16(ifd0);
        let gpsDirOff = null;
        for (let i = 0; i < n0; i++) {
          const e = ifd0 + 2 + i * 12;
          if (u16(e) === 0x8825) { gpsDirOff = u32(e + 8); break; }
        }
        if (gpsDirOff === null) return null;

        const ng = u16(gpsDirOff);
        let latRef = 'N', lonRef = 'E', latDMS = null, lonDMS = null;
        for (let i = 0; i < ng; i++) {
          const e   = gpsDirOff + 2 + i * 12;
          const tag = u16(e);
          const vOff = u32(e + 8);
          if      (tag === 0x0001) latRef = String.fromCharCode(view.getUint8(tiff + e + 8));
          else if (tag === 0x0002) latDMS = [rat(vOff), rat(vOff + 8), rat(vOff + 16)];
          else if (tag === 0x0003) lonRef = String.fromCharCode(view.getUint8(tiff + e + 8));
          else if (tag === 0x0004) lonDMS = [rat(vOff), rat(vOff + 8), rat(vOff + 16)];
        }
        if (!latDMS || !lonDMS) return null;
        let lat = latDMS[0] + latDMS[1] / 60 + latDMS[2] / 3600;
        let lon = lonDMS[0] + lonDMS[1] / 60 + lonDMS[2] / 3600;
        if (latRef === 'S') lat = -lat;
        if (lonRef === 'W') lon = -lon;
        return { lat, lon };
      }
      if (segLen < 2) break;
      markerOff += 2 + segLen;
    }
    return null;
  } catch { return null; }
}

// ── GPS Map Modal ─────────────────────────────────────────────────────────────
let gpsLeafletMap = null;
let gpsLeafletMarker = null;

function openGPSMap(lat, lon) {
  el('gps-map-coords').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  el('gps-map-modal').classList.remove('hidden');

  // Init map lazily; always invalidate so tiles fill the now-visible container
  if (!gpsLeafletMap) {
    gpsLeafletMap = L.map('gps-map-container').setView([lat, lon], 18);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    }).addTo(gpsLeafletMap);
    gpsLeafletMarker = L.marker([lat, lon]).addTo(gpsLeafletMap);
    setTimeout(() => gpsLeafletMap.invalidateSize(), 50);
  } else {
    gpsLeafletMap.setView([lat, lon], 18);
    gpsLeafletMarker.setLatLng([lat, lon]);
    setTimeout(() => gpsLeafletMap.invalidateSize(), 50);
  }
}

el('gps-map-close').addEventListener('click', () => {
  el('gps-map-modal').classList.add('hidden');
  _cancelGPSMapPick();
});

// GPS Map pick mode — lets callers request a tap-to-place interaction
let _gpsPickCallback = null;
let _gpsPickClickHandler = null;

function _cancelGPSMapPick() {
  if (_gpsPickClickHandler && gpsLeafletMap) {
    gpsLeafletMap.off('click', _gpsPickClickHandler);
    _gpsPickClickHandler = null;
  }
  _gpsPickCallback = null;
  el('gps-map-title').textContent = 'Photo Location';
  el('gps-map-pick-hint').classList.add('hidden');
  el('gps-map-confirm').classList.add('hidden');
}

function openGPSMapPick(lat, lon, callback) {
  openGPSMap(lat, lon);
  _gpsPickCallback = callback;
  el('gps-map-title').textContent = 'Pick Location';
  el('gps-map-pick-hint').classList.remove('hidden');
  el('gps-map-confirm').classList.remove('hidden');
  _gpsPickClickHandler = e => {
    gpsLeafletMarker.setLatLng(e.latlng);
    el('gps-map-coords').textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
  };
  gpsLeafletMap.on('click', _gpsPickClickHandler);
}

el('gps-map-confirm').addEventListener('click', () => {
  if (_gpsPickCallback && gpsLeafletMarker) {
    const ll = gpsLeafletMarker.getLatLng();
    _gpsPickCallback(ll.lat, ll.lng);
  }
  el('gps-map-modal').classList.add('hidden');
  _cancelGPSMapPick();
});

/* ── Maintenance ─────────────────────────────────────────────────────────── */
let maintType       = 'vehicle';
let maintContractor = false;
let maintVehicles   = [];
let maintVehiclesLoaded = false;

// Vehicle record list state
let vehRecords       = [];
let vehShowResolved  = false;
let _vehFilterVehicle = '';
let _vehFilterType    = '';
let _vehFilterQ       = '';

async function loadVehRecords() {
  try {
    vehRecords = await api('GET', `/api/maintenance/vehicles-list?include_resolved=${vehShowResolved}`);
    populateVehFilterDropdowns();
    applyVehFilters();
    setBadge('maint-badge-vehicles', vehRecords.filter(r => r.status === 'open' || r.status === 'in-progress').length);
  } catch {
    el('veh-record-list').innerHTML = '<div class="placeholder-msg">Failed to load records</div>';
  }
}

function populateVehFilterDropdowns() {
  const vSel = el('veh-filter-vehicle');
  const prev = vSel.value;
  const seen = new Map();
  vehRecords.forEach(r => { if (r.vehicle_number && !seen.has(r.vehicle_number)) seen.set(r.vehicle_number, r); });
  const sorted = [...seen.values()].sort((a, b) => (a.vehicle_number || '').localeCompare(b.vehicle_number || ''));
  vSel.innerHTML = '<option value="">All Vehicles</option>' +
    sorted.map(r => `<option value="${escHtml(r.vehicle_number)}"${r.vehicle_number === prev ? ' selected' : ''}>${escHtml([r.vehicle_number, r.model].filter(Boolean).join(' — '))}</option>`).join('');
}

function applyVehFilters() {
  let items = vehRecords;
  if (_vehFilterVehicle) items = items.filter(r => r.vehicle_number === _vehFilterVehicle);
  if (_vehFilterType)    items = items.filter(r => r.work_type === _vehFilterType);
  if (_vehFilterQ) {
    const q = _vehFilterQ.toLowerCase();
    items = items.filter(r =>
      [r.vehicle_number, r.model, r.work_type, r.description, r.performed_by, r.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderVehRecords(items);
}

// Per-card pending files: Map<maintenance_id, [{file, fileType}]>
const vehCardFiles = new Map();
let vehCardActiveId = null;

// ── Issue card attachments (equipment / building / well issues) ───────────────
const issueCardFiles = new Map(); // Map<issueId, [{file, fileType}]>
let issueCardActiveId    = null;
let issueCardActiveTable = null;  // 'equipment_issues' | 'building_issues' | 'well_issues'

const issueInvInput = document.createElement('input');
issueInvInput.type = 'file'; issueInvInput.accept = 'image/*,.pdf'; issueInvInput.style.display = 'none';
document.body.appendChild(issueInvInput);

const issuePicInput = document.createElement('input');
issuePicInput.type = 'file'; issuePicInput.accept = 'image/*'; issuePicInput.multiple = true; issuePicInput.style.display = 'none';
document.body.appendChild(issuePicInput);

issueInvInput.addEventListener('change', async () => {
  const file = issueInvInput.files[0];
  issueInvInput.value = '';
  if (!file || !issueCardActiveId) return;
  let finalFile = file;
  if (file.type.startsWith('image/')) {
    showToast('Converting image to PDF…', 'info');
    try { finalFile = await imageToPdf(file); } catch { /* keep original */ }
  }
  const pending = issueCardFiles.get(issueCardActiveId) || [];
  pending.push({ file: finalFile, fileType: 'invoice' });
  issueCardFiles.set(issueCardActiveId, pending);
  renderIssueAttachQueue(issueCardActiveId);
});

issuePicInput.addEventListener('change', async () => {
  if (!issueCardActiveId) return;
  const files = [...issuePicInput.files];
  issuePicInput.value = '';
  if (!files.length) return;
  const pending = issueCardFiles.get(issueCardActiveId) || [];
  const newEntries = files.map(f => ({ file: f, fileType: 'photo' }));
  newEntries.forEach(e => pending.push(e));
  issueCardFiles.set(issueCardActiveId, pending);
  renderIssueAttachQueue(issueCardActiveId);
  // For canal issues, extract GPS from each photo; re-render as results arrive
  if (issueCardActiveTable === 'canal_issues') {
    const id = issueCardActiveId;
    await Promise.all(newEntries.map(async entry => {
      entry.gps = await readExifGPS(entry.file);
      if (entry.gps) renderIssueAttachQueue(id);
    }));
  }
});

function renderIssueAttachQueue(issueId) {
  const pending = issueCardFiles.get(issueId) || [];
  const queueEl = document.querySelector(`.equip-issue-item[data-issue-id="${issueId}"] .issue-attach-queue`);
  if (!queueEl) return;
  if (!pending.length) { queueEl.classList.add('hidden'); queueEl.innerHTML = ''; return; }
  queueEl.classList.remove('hidden');
  queueEl.innerHTML = pending.map((a, i) => `
    <div class="maint-aq-item">
      <span class="maint-aq-badge">${a.fileType === 'invoice' ? 'INV' : 'PIC'}</span>
      <span style="flex:1;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.file.name)}</span>
      ${a.gps ? `<button type="button" class="canal-aq-map-btn" data-lat="${a.gps.lat}" data-lon="${a.gps.lon}" style="padding:2px 7px;font-size:0.8rem;border:1px solid var(--border);border-radius:6px;background:var(--surface2);cursor:pointer">&#127757;</button>` : ''}
      <button class="maint-aq-remove" data-idx="${i}">×</button>
    </div>`).join('');
  queueEl.querySelectorAll('.canal-aq-map-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openGPSMap(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon));
    });
  });
  queueEl.querySelectorAll('.maint-aq-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const p = issueCardFiles.get(issueId) || [];
      p.splice(parseInt(btn.dataset.idx), 1);
      if (p.length) issueCardFiles.set(issueId, p); else issueCardFiles.delete(issueId);
      renderIssueAttachQueue(issueId);
    });
  });
}

async function doUploadIssueAttachments(issueId, tableName, pending, entityName) {
  const d = new Date();
  const dateStr = `${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${d.getFullYear()}`;
  const label = (entityName || `issue${issueId}`).replace(/[^a-zA-Z0-9-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/,'').slice(0,40);
  let invoiceIdx = 0, photoIdx = 0;
  for (const att of pending) {
    const origExt = att.file.name.includes('.') ? att.file.name.split('.').pop().toLowerCase() : 'jpg';
    let newName;
    if (att.fileType === 'invoice') {
      invoiceIdx++;
      newName = `invoice_${label}_${dateStr}${invoiceIdx > 1 ? `_${invoiceIdx}` : ''}.pdf`;
    } else {
      photoIdx++;
      newName = `${label}_photo_${dateStr}${photoIdx > 1 ? `_${photoIdx}` : ''}.${origExt}`;
    }
    const renamed = new File([att.file], newName, { type: att.file.type });
    const fd = new FormData();
    fd.append('file', renamed);
    try {
      await fetch(
        `/api/maintenance/attachment?table_name=${tableName}&record_id=${issueId}&file_type=${att.fileType}&category=general`,
        { method: 'POST', body: fd }
      );
    } catch { /* non-fatal */ }
  }
}

// Shared hidden inputs for card file picks
const vehCardInvInput = Object.assign(document.createElement('input'),
  { type: 'file', accept: 'image/*,.pdf', style: 'display:none' });
const vehCardPicInput = Object.assign(document.createElement('input'),
  { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
document.body.append(vehCardInvInput, vehCardPicInput);

vehCardInvInput.addEventListener('change', async () => {
  const files = [...vehCardInvInput.files];
  vehCardInvInput.value = '';
  if (!vehCardActiveId || !files.length) return;
  const id = vehCardActiveId;
  const queue = vehCardFiles.get(id) || [];
  const convertingEl = document.querySelector(`#veh-card-queue-${id}`);
  if (convertingEl) { convertingEl.classList.remove('hidden'); convertingEl.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Converting…</div>'; }
  for (const f of files) {
    if (f.type.startsWith('image/')) {
      try { queue.push({ file: await imageToPdf(f), fileType: 'invoice' }); }
      catch { queue.push({ file: f, fileType: 'invoice' }); }
    } else {
      queue.push({ file: f, fileType: 'invoice' });
    }
  }
  vehCardFiles.set(id, queue);
  renderVehCardQueue(id);
});

vehCardPicInput.addEventListener('change', () => {
  const files = [...vehCardPicInput.files];
  vehCardPicInput.value = '';
  if (!vehCardActiveId || !files.length) return;
  const id = vehCardActiveId;
  const queue = vehCardFiles.get(id) || [];
  files.forEach(f => queue.push({ file: f, fileType: 'photo' }));
  vehCardFiles.set(id, queue);
  renderVehCardQueue(id);
});

function renderVehCardQueue(id) {
  const el2 = document.getElementById(`veh-card-queue-${id}`);
  if (!el2) return;
  const queue = vehCardFiles.get(id) || [];
  if (!queue.length) { el2.classList.add('hidden'); el2.innerHTML = ''; return; }
  el2.classList.remove('hidden');
  el2.innerHTML = queue.map((a, i) => {
    const isPdf = a.file.type === 'application/pdf' || a.file.name.endsWith('.pdf');
    return `<div class="maint-aq-item">
      ${isPdf ? `<span class="maint-aq-icon">${icon('invoice', 28)}</span>` : `<img src="${URL.createObjectURL(a.file)}" alt="">`}
      <span class="maint-aq-badge">${a.fileType === 'invoice' ? 'INV' : 'PIC'}</span>
      <button class="maint-aq-remove" data-cardid="${id}" data-idx="${i}">&times;</button>
      <div class="maint-aq-name">${escHtml(a.file.name)}</div>
    </div>`;
  }).join('');
  el2.querySelectorAll('.maint-aq-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = vehCardFiles.get(btn.dataset.cardid) || [];
      q.splice(parseInt(btn.dataset.idx), 1);
      vehCardFiles.set(btn.dataset.cardid, q);
      renderVehCardQueue(btn.dataset.cardid);
    });
  });
}

function renderVehRecords(items) {
  items = items ?? vehRecords;
  const list = el('veh-record-list');
  if (!items.length) {
    const hasF = _vehFilterVehicle || _vehFilterType || _vehFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching records.' : `No ${vehShowResolved ? '' : 'open '}records`}</div>`;
    return;
  }
  const statusLabel = { open: 'Open', 'in-progress': 'In Progress', resolved: 'Resolved' };
  list.innerHTML = items.map(r => {
    const id = r.maintenance_id;
    const vehicleName = [r.vehicle_number, r.model].filter(Boolean).join(' — ');
    const snippet = (r.description || '').slice(0, 80) + ((r.description || '').length > 80 ? '…' : '');
    const existingFiles = Number(r.attachment_count) > 0
      ? `<div class="form-group">
           <label>Existing Files</label>
           <button class="btn btn-secondary btn-xs maint-hist-attach-btn" data-id="${id}">${icon('attachments')} ${r.attachment_count} file${r.attachment_count > 1 ? 's' : ''} — tap to view</button>
           <div class="maint-hist-attach-area hidden" data-id="${id}"></div>
         </div>` : '';
    return `
      <div class="equip-issue-item" data-record-id="${id}">
        <div class="equip-issue-header">
          <div class="equip-issue-meta">
            <div class="equip-issue-name">${escHtml(vehicleName)}</div>
            <div class="equip-issue-snippet">${escHtml(snippet) || escHtml(r.work_type || '')}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="maint-status-badge maint-status-${escHtml(r.status || 'open')}">${escHtml(statusLabel[r.status] || r.status || 'Open')}</span>
            <span class="equip-issue-date">${(r.work_date || '').slice(0,10)}</span>
          </div>
        </div>
        <div class="equip-issue-body hidden">
          <div class="form-group">
            <label>Description</label>
            <div style="font-size:0.9rem;padding:6px 0">${escHtml(r.description || '—')}</div>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select class="ctrl-select veh-status-select">
              <option value="open"        ${r.status==='open'        ?'selected':''}>Open</option>
              <option value="in-progress" ${r.status==='in-progress' ?'selected':''}>In Progress</option>
              <option value="resolved"    ${r.status==='resolved'    ?'selected':''}>Resolved</option>
            </select>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea class="ctrl-textarea veh-notes-input" rows="2">${escHtml(r.notes || '')}</textarea>
          </div>
          <div class="form-group">
            <label>Performed By</label>
            <input type="text" class="ctrl-input veh-perf-input" value="${escHtml(r.performed_by || '')}" placeholder="Name">
          </div>
          <div class="two-col">
            <div class="form-group">
              <label>PO Number</label>
              <input type="text" class="ctrl-input veh-po-input" value="${escHtml(r.po_number || '')}" placeholder="PO #">
            </div>
            <div class="form-group">
              <label>Cost ($)</label>
              <input type="number" class="ctrl-input veh-cost-input" value="${r.cost != null ? r.cost : ''}" step="0.01" min="0" placeholder="0.00">
            </div>
          </div>
          <div class="form-group">
            <label>Add Attachments</label>
            <div class="maint-attach-btns">
              <button type="button" class="btn btn-secondary btn-sm veh-card-inv-btn" data-id="${id}">${icon('invoice')} Invoice</button>
              <button type="button" class="btn btn-secondary btn-sm veh-card-pic-btn" data-id="${id}">${icon('photo')} Photo(s)</button>
            </div>
            <div class="maint-attach-queue veh-card-queue hidden" id="veh-card-queue-${id}"></div>
          </div>
          ${existingFiles}
          <div class="error-msg hidden veh-update-error"></div>
          <div class="maint-hist-footer">
            <span class="maint-hist-by">${escHtml(r.work_type || '')} &middot; ${(r.work_date || '').slice(0,10)}</span>
            <button class="btn btn-save btn-sm veh-record-save-btn">Save</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

el('veh-show-resolved-btn').addEventListener('click', () => {
  vehShowResolved = !vehShowResolved;
  el('veh-show-resolved-btn').textContent = vehShowResolved ? 'Hide Resolved' : 'Show Resolved';
  loadVehRecords();
});

el('veh-new-record-btn').addEventListener('click', () => {
  el('veh-new-record-form').classList.remove('hidden');
  el('veh-new-record-btn').classList.add('hidden');
  el('maint-date').value = todayISO();
  if (!el('maint-performed-by').value) el('maint-performed-by').value = currentUser?.full_name || '';
});

el('veh-cancel-btn').addEventListener('click', () => {
  el('veh-new-record-form').classList.add('hidden');
  el('veh-new-record-btn').classList.remove('hidden');
});

el('veh-record-list').addEventListener('click', async e => {
  const item = e.target.closest('.equip-issue-item');
  if (!item) return;

  // Expand/collapse header
  if (e.target.closest('.equip-issue-header')) {
    item.querySelector('.equip-issue-body').classList.toggle('hidden');
    return;
  }

  // Invoice / photo pick buttons on card
  if (e.target.classList.contains('veh-card-inv-btn')) {
    vehCardActiveId = e.target.dataset.id;
    vehCardInvInput.click();
    return;
  }
  if (e.target.classList.contains('veh-card-pic-btn')) {
    vehCardActiveId = e.target.dataset.id;
    vehCardPicInput.click();
    return;
  }

  // Existing files expand
  if (e.target.classList.contains('maint-hist-attach-btn')) {
    const id = e.target.dataset.id;
    const area = item.querySelector(`.maint-hist-attach-area[data-id="${id}"]`);
    if (!area) return;
    if (!area.classList.contains('hidden')) { area.classList.add('hidden'); return; }
    area.classList.remove('hidden');
    if (area.dataset.loaded) return;
    area.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">Loading…</div>';
    try {
      const atts = await api('GET', `/api/maintenance/attachments?table_name=maintenance_vehicles&record_id=${id}`);
      area.dataset.loaded = '1';
      if (!atts.length) { area.innerHTML = '<div class="maint-att-empty">No files</div>'; return; }
      area.innerHTML = atts.map(a => {
        const isPdf = a.mime_type === 'application/pdf' || a.original_name.endsWith('.pdf');
        const url = `/uploads/${a.rel_path.split('/').map(encodeURIComponent).join('/')}`;
        return `<div class="maint-att-item" data-url="${url}" data-pdf="${isPdf}" data-name="${a.original_name.replace(/"/g,'&quot;')}">
          <div class="maint-att-thumb">${isPdf ? `<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>` : `<img src="${url}" loading="lazy" alt="">`}</div>
          <span class="maint-att-type-badge">${a.file_type === 'invoice' ? 'INV' : 'PIC'}</span>
          <div class="maint-att-name">${escHtml(a.original_name)}</div>
        </div>`;
      }).join('');
      area.querySelectorAll('.maint-att-item').forEach(card => {
        card.addEventListener('click', () => {
          openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf === 'true');
        });
      });
    } catch (err) {
      area.innerHTML = `<div class="maint-att-empty" style="color:var(--red-light)">${err.message}</div>`;
    }
    return;
  }

  // Save card changes
  if (e.target.classList.contains('veh-record-save-btn')) {
    const recordId    = item.dataset.recordId;
    const status      = item.querySelector('.veh-status-select').value;
    const notes       = item.querySelector('.veh-notes-input').value.trim()  || null;
    const performed_by= item.querySelector('.veh-perf-input').value.trim()   || null;
    const po_number   = item.querySelector('.veh-po-input').value.trim()     || null;
    const costVal     = item.querySelector('.veh-cost-input').value;
    const cost        = costVal !== '' ? parseFloat(costVal) : null;
    const errEl       = item.querySelector('.veh-update-error');
    errEl.classList.add('hidden');
    e.target.disabled = true;
    try {
      // Find the record data for naming
      const rec = vehRecords.find(r => String(r.maintenance_id) === String(recordId)) || {};
      const vehicleNum = (rec.vehicle_number || 'vehicle').replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g,'_').replace(/^_|_$/,'');
      const [ry, rm, rd] = (rec.work_date || todayISO()).slice(0,10).split('-');
      const dateStr = `${rm}${rd}${ry}`;
      const workType = rec.work_type || 'service';
      await api('PATCH', `/api/maintenance/vehicle/${recordId}`, { status, notes, performed_by, po_number, cost });
      const pending = vehCardFiles.get(recordId) || [];
      if (pending.length) {
        await doUploadAttachments(parseInt(recordId), vehicleNum, dateStr, workType, pending);
        vehCardFiles.delete(recordId);
      }
      await loadVehRecords();
      showToast('Record updated', 'success');
      refreshMaintenanceBadges();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      e.target.disabled = false;
    }
  }
});

const MAINT_PANEL_NAMES = {
  vehicles:       'Vehicle Maintenance',
  equipment:      'Equipment Issues',
  buildings:      'Building Issues',
  wells:          'Well Issues',
  swaps:          'Equipment Swaps',
  pms:            'PM Records',
  'canal-issues': 'Canal Issues',
  assigned:       'Assigned to Me',
};
function openMaintPanel(panelId) {
  el('maint-main').classList.add('hidden');
  document.querySelectorAll('.maint-panel').forEach(p => p.classList.add('hidden'));
  el('maint-panel-' + panelId).classList.remove('hidden');
  setPanelNav(el('screen-maintenance'), closeMaintPanel,
    'Maintenance Log - ' + (MAINT_PANEL_NAMES[panelId] || panelId));
  if (panelId === 'equipment')    initMaintEquipmentPanel();
  if (panelId === 'buildings')    initMaintBuildingsPanel();
  if (panelId === 'wells')        initMaintWellsPanel();
  if (panelId === 'vehicles')     initMaintVehiclesPanel();
  if (panelId === 'swaps')        initMaintSwapsPanel();
  if (panelId === 'pms')          initMaintPMsPanel();
  if (panelId === 'canal-issues') initMaintCanalPanel();
  if (panelId === 'assigned')     initMaintAssignedPanel();
}

function closeMaintPanel() {
  document.querySelectorAll('.maint-panel').forEach(p => p.classList.add('hidden'));
  el('maint-main').classList.remove('hidden');
  setPanelNav(el('screen-maintenance'), () => showScreen('dashboard'), 'Maintenance Log');
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
    setBadge('maint-badge-vehicles',  counts.vehicles);
    setBadge('maint-badge-canal',      counts.canal);
    // Dirt Work is now its own top-level screen — its badge lives on the home tile,
    // not inside the Maintenance Log total.
    setBadge('maint-badge-dirt-work',  counts.dirt_work);
    setBadge('maint-main-badge', counts.equipment + counts.buildings + counts.wells + counts.vehicles + counts.canal);
  } catch { /* non-critical — badges stay at last known value */ }
}

document.querySelectorAll('[data-maint-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    openMaintPanel(btn.dataset.maintPanel);
  });
});

// .maint-back-btn buttons removed from HTML — navigation handled by setPanelNav()

/* ── Assigned Items + Bell Notification ──────────────────────────────────── */
const ASSIGN_TYPE_LABEL = { well: 'Well Issue', building: 'Building Issue', equipment: 'Equipment Issue', dirt_work: 'Dirt Work' };
const ASSIGN_TYPE_PANEL = { well: 'wells', building: 'buildings', equipment: 'equipment', dirt_work: 'dirt-work' };

// Navigate to the right place for an assignment "View" button. Dirt Work is its
// own top-level screen; the others are panels inside the Maintenance Log.
function goToAssignmentTarget(target) {
  if (target === 'dirt-work') { showScreen('dirt-work'); return; }
  showScreen('maintenance');
  openMaintPanel(target);
}

function updateBellBadge(items) {
  const lastChecked = localStorage.getItem('wm-assign-checked') || '1970-01-01T00:00:00.000Z';
  const newCount = (items || []).filter(i => (i.created_at || '') > lastChecked).length;
  setBadge('bell-badge', newCount);
}

async function loadAssignmentBadge() {
  try {
    const items = await api('GET', '/api/my-assignments');
    updateBellBadge(items);
    setBadge('maint-badge-assigned', items.length);
  } catch { /* non-critical */ }
}

// Bell button wired at top level (element is in the header, before app.js script tag)
el('header-bell-btn').addEventListener('click', openAssignModal);

let _assignModalInited = false;
function openAssignModal() {
  // Wire modal-internal listeners once on first open (modal HTML is after the script tag)
  if (!_assignModalInited) {
    _assignModalInited = true;
    el('assign-modal-close').addEventListener('click', closeAssignModal);
    el('assign-modal').addEventListener('click', e => {
      if (e.target === el('assign-modal')) closeAssignModal();
      const btn = e.target.closest('.assign-view-btn');
      if (btn) {
        closeAssignModal();
        goToAssignmentTarget(btn.dataset.panel);
      }
    });
  }
  el('assign-modal').classList.remove('hidden');
  renderAssignModal();
}

function closeAssignModal() {
  el('assign-modal').classList.add('hidden');
}

async function renderAssignModal() {
  const body = el('assign-modal-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  const lastChecked = localStorage.getItem('wm-assign-checked') || '1970-01-01T00:00:00.000Z';
  localStorage.setItem('wm-assign-checked', new Date().toISOString());
  try {
    const items = await api('GET', '/api/my-assignments');
    setBadge('bell-badge', 0);
    setBadge('maint-badge-assigned', items.length);
    if (!items.length) {
      body.innerHTML = '<div class="placeholder-msg">No items assigned to you.</div>';
      return;
    }
    body.innerHTML = items.map(i => {
      const isNew = (i.created_at || '') > lastChecked;
      const statusClass = (i.status || 'open').replace('_', '-');
      return `<div class="assign-item${isNew ? ' assign-new' : ''}">
        <div class="assign-item-type">${ASSIGN_TYPE_LABEL[i.issue_type] || i.issue_type}</div>
        <div class="assign-item-desc">${escHtml(i.entity_name || '')}${i.description ? ' — ' + escHtml(i.description.slice(0, 80)) : ''}</div>
        <div class="assign-item-meta">
          <span class="status-pill ${statusClass}">${(i.status || 'open').replace('_', ' ')}</span>
          ${i.reported_date ? `<span>${localDateStr(i.reported_date, { month: 'short', day: 'numeric' })}</span>` : ''}
          <button class="btn btn-secondary btn-sm assign-view-btn" data-panel="${escHtml(ASSIGN_TYPE_PANEL[i.issue_type] || 'equipment')}">View</button>
        </div>
      </div>`;
    }).join('');
  } catch {
    body.innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

function initMaintAssignedPanel() {
  const panel = el('maint-panel-assigned');
  const listEl = el('assigned-panel-list');
  // Wire delegated click once (first open)
  if (!panel.dataset.listenerAdded) {
    panel.dataset.listenerAdded = '1';
    listEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-go-panel]');
      if (btn) goToAssignmentTarget(btn.dataset.goPanel);
    });
  }
  loadAssignedPanel(listEl);
}

async function loadAssignedPanel(listEl) {
  listEl.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const items = await api('GET', '/api/my-assignments');
    updateBellBadge(items);
    setBadge('maint-badge-assigned', items.length);
    if (!items.length) {
      listEl.innerHTML = '<div class="placeholder-msg">No items assigned to you.</div>';
      return;
    }
    listEl.innerHTML = items.map(i => {
      const statusClass = (i.status || 'open').replace('_', '-');
      return `<div class="assign-item">
        <div class="assign-item-type">${ASSIGN_TYPE_LABEL[i.issue_type] || i.issue_type}</div>
        <div class="assign-item-desc">${escHtml(i.entity_name || '')}${i.description ? ' — ' + escHtml(i.description.slice(0, 100)) : ''}</div>
        <div class="assign-item-meta">
          <span class="status-pill ${statusClass}">${(i.status || 'open').replace('_', ' ')}</span>
          ${i.reported_date ? `<span>${localDateStr(i.reported_date, { month: 'short', day: 'numeric' })}</span>` : ''}
          <button class="btn btn-secondary btn-sm" data-go-panel="${escHtml(ASSIGN_TYPE_PANEL[i.issue_type] || 'equipment')}">View Issue</button>
        </div>
      </div>`;
    }).join('');
  } catch {
    listEl.innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

async function initMaintVehiclesPanel() {
  maintType = 'vehicle';
  loadVehRecords();

  if (maintVehiclesLoaded) return;
  maintVehiclesLoaded = true;

  el('veh-filter-vehicle').addEventListener('change', () => { _vehFilterVehicle = el('veh-filter-vehicle').value; applyVehFilters(); });
  el('veh-filter-type').addEventListener('change',   () => { _vehFilterType    = el('veh-filter-type').value;    applyVehFilters(); });
  let _vfqT;
  el('veh-filter-q').addEventListener('input', () => { clearTimeout(_vfqT); _vfqT = setTimeout(() => { _vehFilterQ = el('veh-filter-q').value.trim(); applyVehFilters(); }, 250); });

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
let swapHistory      = [];
let _swapFilterCat   = '';
let _swapFilterLoc   = '';
let _swapFilterQ     = '';
const SWAP_CAT_LABEL = { siphon_breaker: 'Siphon Breaker', motor: 'Motor', pp_pump: 'PP Pump', well_motor: 'Well Motor', well_meter: 'Well Meter' };

function initMaintSwapsPanel() {
  if (swapPanelLoaded) return;
  swapPanelLoaded = true;
  el('swap-date').value = todayISO();
  if (!el('swap-performed-by').value) el('swap-performed-by').value = currentUser?.full_name || '';
  loadSwapUnits(swapCategory);
  loadSwapHistory();

  el('swap-filter-cat').addEventListener('change', () => { _swapFilterCat = el('swap-filter-cat').value; applySwapFilters(); });
  el('swap-filter-loc').addEventListener('change', () => { _swapFilterLoc = el('swap-filter-loc').value; applySwapFilters(); });
  let _swqT;
  el('swap-filter-q').addEventListener('input', () => { clearTimeout(_swqT); _swqT = setTimeout(() => { _swapFilterQ = el('swap-filter-q').value.trim(); applySwapFilters(); }, 250); });
}

async function loadSwapHistory() {
  el('swap-history-list').innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    swapHistory = await api('GET', '/api/equipment-swaps');
    populateSwapHistoryDropdowns();
    applySwapFilters();
  } catch {
    el('swap-history-list').innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

function populateSwapHistoryDropdowns() {
  const lSel = el('swap-filter-loc');
  const prev = lSel.value;
  const locs = [...new Set(swapHistory.map(s => s.location).filter(Boolean))].sort();
  lSel.innerHTML = '<option value="">All Locations</option>' +
    locs.map(l => `<option value="${escHtml(l)}"${l === prev ? ' selected' : ''}>${escHtml(l)}</option>`).join('');
}

function applySwapFilters() {
  let items = swapHistory;
  if (_swapFilterCat) items = items.filter(s => s.category === _swapFilterCat);
  if (_swapFilterLoc) items = items.filter(s => s.location === _swapFilterLoc);
  if (_swapFilterQ) {
    const q = _swapFilterQ.toLowerCase();
    items = items.filter(s =>
      [s.location, s.category, s.removed_description, s.installed_description, s.performed_by, s.notes]
        .some(f => (f || '').toLowerCase().includes(q))
    );
  }
  renderSwapHistory(items);
}

function renderSwapHistory(items) {
  const list = el('swap-history-list');
  if (!items.length) {
    const hasF = _swapFilterCat || _swapFilterLoc || _swapFilterQ;
    list.innerHTML = `<div class="placeholder-msg">${hasF ? 'No matching swaps.' : 'No swaps recorded.'}</div>`;
    return;
  }
  list.innerHTML = items.map(s => `
    <div class="equip-issue-item" style="padding:10px 14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <div style="font-weight:600;font-size:0.9rem">${escHtml(s.location || '—')}</div>
          <div style="font-size:0.78rem;color:var(--text-dim);margin:2px 0">${escHtml(SWAP_CAT_LABEL[s.category] || s.category || '—')}</div>
          <div style="font-size:0.83rem;margin-top:4px">
            <span style="color:var(--text-dim)">Removed:</span> ${escHtml(s.removed_description || '—')}
          </div>
          <div style="font-size:0.83rem;margin-top:2px">
            <span style="color:var(--text-dim)">Installed:</span> ${escHtml(s.installed_description || '—')}
          </div>
          ${s.performed_by ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:4px">By: ${escHtml(s.performed_by)}</div>` : ''}
          ${s.notes ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:2px;font-style:italic">${escHtml(s.notes)}</div>` : ''}
        </div>
        <div style="white-space:nowrap;font-size:0.78rem;color:var(--text-dim);flex-shrink:0">${(s.swap_date || '').slice(0,10)}</div>
      </div>
    </div>`).join('');
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
    if (!r.queued) { loadSwapUnits(swapCategory); loadSwapHistory(); }
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
      ? `<span class="maint-aq-icon">${icon('invoice', 28)}</span>`
      : `<img src="${URL.createObjectURL(a.file)}" alt="">`;
    return `<div class="maint-aq-item">
      ${thumb}
      <span class="maint-aq-badge">${badge}</span>
      <button class="maint-aq-remove" data-idx="${i}">&times;</button>
      <div class="maint-aq-name">${escHtml(a.file.name)}</div>
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

// Shared upload helper used by both new-record form and card updates
async function doUploadAttachments(maintenanceId, vehicleNum, dateStr, workType, pending) {
  let invoiceIdx = 0, photoIdx = 0;
  for (const att of pending) {
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
        `/api/maintenance/attachment?table_name=maintenance_vehicles&record_id=${maintenanceId}&file_type=${att.fileType}&category=vehicles`,
        { method: 'POST', body: fd }
      );
    } catch { /* non-fatal */ }
  }
}

async function uploadMaintAttachments(maintenanceId) {
  const vehicleOpt = el('maint-vehicle-select').options[el('maint-vehicle-select').selectedIndex];
  const vehicleNum = (vehicleOpt?.text || '').split('—')[0].trim()
    .replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '') || 'vehicle';
  const [y, m, d] = (el('maint-date').value || todayISO()).split('-');
  const workType = el('maint-work-type').value || 'service';
  await doUploadAttachments(maintenanceId, vehicleNum, `${m}${d}${y}`, workType, maintPendingAttachments);
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

  const _save = beginSave(el('maint-save-btn'));
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
        await uploadMaintAttachments(r.maintenance_id);
      }
      // Collapse form, show button, reload list
      el('veh-new-record-form').classList.add('hidden');
      el('veh-new-record-btn').classList.remove('hidden');
      loadVehRecords();
      refreshMaintenanceBadges();
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
  } finally {
    _save();
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
      <button class="btn btn-secondary btn-sm kf-set-map-card-btn">${icon('map')} Map</button>`;
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
  const prevCond   = w.last_wet_dry_moist != null ? w.last_wet_dry_moist.charAt(0).toUpperCase() + w.last_wet_dry_moist.slice(1) : null;
  const prevMeta   = [prevDTW, prevMethod, prevCond].filter(Boolean).join(' · ');
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
      <div class="two-col">
        <div class="form-group toggle-row">
          <label>Status</label>
          <div class="toggle-group">
            <button class="toggle-btn active kf-on">ON</button>
            <button class="toggle-btn kf-off">OFF</button>
          </div>
        </div>
        <div class="form-group toggle-row">
          <label>Access</label>
          <div class="toggle-group">
            <button class="toggle-btn kf-access-tube${w.access === 'Tube' ? ' active' : ''}">Tube</button>
            <button class="toggle-btn kf-access-plug${w.access === 'Plug' ? ' active' : ''}">Plug</button>
          </div>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group toggle-row">
          <label>Method</label>
          <div class="toggle-group">
            <button class="toggle-btn kf-m-sounder">Sounder</button>
            <button class="toggle-btn kf-m-plopper">Plopper</button>
            <button class="toggle-btn kf-m-other">Other</button>
          </div>
        </div>
        <div class="form-group toggle-row">
          <label>Condition</label>
          <div class="toggle-group">
            <button class="toggle-btn kf-c-wet">Wet</button>
            <button class="toggle-btn kf-c-dry">Dry</button>
            <button class="toggle-btn kf-c-moist">Moist</button>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Operator</label>
        <input type="text" class="ctrl-input kf-op" placeholder="Initials">
      </div>
      <div class="form-group">
        <label>Notes</label>
        ${w.last_notes ? `<div class="prev-note-hint">${escHtml(w.last_notes)}</div>` : ''}
        <textarea class="ctrl-textarea kf-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${hasGPS ? `<button class="btn btn-secondary btn-sm kf-map-btn">${icon('map-pin')} Map</button>` : ''}
        <button class="btn btn-secondary btn-sm kf-hist-btn">${icon('history')} History</button>
        <button class="btn btn-save kf-save">Save Reading</button>
      </div>
    </div>`;

  // Auto-fill operator
  if (currentUser) {
    div.querySelector('.kf-op').value = currentUser.initials || currentUser.username;
  }

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

  // Status
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

  // Access
  let kfAccess = w.access || null;
  div.querySelector('.kf-access-tube').addEventListener('click', e => {
    if (kfAccess === 'Tube') { kfAccess = null; e.currentTarget.classList.remove('active'); return; }
    kfAccess = 'Tube';
    e.currentTarget.classList.add('active');
    div.querySelector('.kf-access-plug').classList.remove('active');
  });
  div.querySelector('.kf-access-plug').addEventListener('click', e => {
    if (kfAccess === 'Plug') { kfAccess = null; e.currentTarget.classList.remove('active'); return; }
    kfAccess = 'Plug';
    e.currentTarget.classList.add('active');
    div.querySelector('.kf-access-tube').classList.remove('active');
  });

  // Method toggles (Sounder / Plopper / Other) — tap again to deselect
  let kfMethod = null;
  const mSo = div.querySelector('.kf-m-sounder');
  const mPl = div.querySelector('.kf-m-plopper');
  const mOt = div.querySelector('.kf-m-other');
  [[' sounder', mSo, [mPl, mOt]], ['plopper', mPl, [mSo, mOt]], ['other', mOt, [mSo, mPl]]].forEach(([val, btn, rest]) => {
    btn.addEventListener('click', () => {
      const v = val.trim();
      if (kfMethod === v) { kfMethod = null; btn.classList.remove('active'); return; }
      kfMethod = v; btn.classList.add('active'); rest.forEach(b => b.classList.remove('active'));
    });
  });
  if (w.last_method && ['sounder', 'plopper', 'other'].includes(w.last_method)) {
    kfMethod = w.last_method;
    div.querySelector(`.kf-m-${kfMethod}`).classList.add('active');
  }

  // Condition toggles (Wet / Dry / Moist) — tap again to deselect
  let kfCond = null;
  const cWet = div.querySelector('.kf-c-wet');
  const cDry = div.querySelector('.kf-c-dry');
  const cMo  = div.querySelector('.kf-c-moist');
  [['wet', cWet, [cDry, cMo]], ['dry', cDry, [cWet, cMo]], ['moist', cMo, [cWet, cDry]]].forEach(([val, btn, rest]) => {
    btn.addEventListener('click', () => {
      if (kfCond === val) { kfCond = null; btn.classList.remove('active'); return; }
      kfCond = val; btn.classList.add('active'); rest.forEach(b => b.classList.remove('active'));
    });
  });
  if (w.last_wet_dry_moist && ['wet', 'dry', 'moist'].includes(w.last_wet_dry_moist)) {
    kfCond = w.last_wet_dry_moist;
    div.querySelector(`.kf-c-${kfCond}`).classList.add('active');
  }

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
    if (open) {
      const sb = div.querySelector('.kf-save');
      sb.disabled = false; sb.textContent = 'Save Reading';
      el('kf-time').value = nowHHMM();
    }
  });

  div.querySelector('.kf-save').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const dtw   = div.querySelector('.kf-dtw').value;
    const notes = div.querySelector('.kf-notes').value.trim();
    // DTW is optional, but if omitted the notes field is required
    if (!dtw && !notes) { errEl.textContent = 'Enter a DTW reading, or add a note explaining why no reading was taken'; errEl.classList.remove('hidden'); return; }

    const saveBtn = e.currentTarget;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const body = {
      well_id:         w.well_id,
      reading_date:    dateInput.value,
      reading_time:    timeInput.value,
      dtw_reading:     dtw ? parseFloat(dtw) : null,
      well_on_off:     kfOnOff,
      plopper_sounder: kfMethod || null,
      wet_dry_moist:   kfCond || null,
      operator:        div.querySelector('.kf-op').value || null,
      notes:           div.querySelector('.kf-notes').value || null,
      access:          kfAccess,
    };
    try {
      const r = await api('POST', '/api/readings/kf-monthly', body, `KF — ${w.common_name}`);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : localDateStr(dateInput.value, { month: 'short', day: 'numeric' });
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      if (!r.queued) {
        const newPrev = [
          dtw ? `${Number(dtw).toFixed(2)} ft` : null,
          kfMethod ? kfMethod.charAt(0).toUpperCase() + kfMethod.slice(1) : null,
          kfCond   ? kfCond.charAt(0).toUpperCase()   + kfCond.slice(1)   : null,
        ].filter(Boolean).join(' · ');
        let meta = div.querySelector('.list-item-meta');
        if (!meta) {
          meta = document.createElement('div');
          meta.className = 'list-item-meta';
          div.querySelector('.list-item-header').after(meta);
        }
        meta.innerHTML = `<span>Prev: ${newPrev}</span>`;
      }
      div.querySelector('.kf-dtw').value = '';
      div.querySelector('.kf-notes').value = '';
      showToast(r.queued ? `${w.common_name} queued offline` : `${w.common_name} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  div.querySelector('.list-item-form').style.display = 'none';
  return div;
}

/* ── Piezometer Readings ─────────────────────────────────────────────────── */
let piezLoaded      = false;
let piezAllItems    = [];
let piezPools       = [];
let piezActivePool  = null;

async function initPiezScreen() {
  if (piezLoaded) return;
  piezLoaded = true;

  el('piez-date').value = todayISO();
  el('piez-time').value = nowHHMM();

  try {
    piezAllItems = await api('GET', '/api/piezometers');
  } catch (err) {
    el('piez-list-body').innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load piezometers: ' + err.message, 'error');
    return;
  }

  // Derive unique pool list: Pool 1-8 numerically first, then everything else alphabetically
  const rawPools = [...new Set(piezAllItems.map(p => p.pool).filter(Boolean))];
  const poolNum  = n => { const m = /^Pool\s+(\d+)$/i.exec(n); return m ? parseInt(m[1]) : null; };
  piezPools = rawPools.sort((a, b) => {
    const na = poolNum(a), nb = poolNum(b);
    if (na !== null && nb !== null) return na - nb;          // both numbered: numeric order
    if (na !== null) return -1;                               // numbered before named
    if (nb !== null) return 1;
    return a.localeCompare(b);                                // both named: alpha
  });

  // Build pool tabs
  const tabsEl = el('piez-pool-tabs');
  tabsEl.innerHTML = '';
  piezPools.forEach(pool => {
    const btn = document.createElement('button');
    btn.className = 'set-tab';
    btn.textContent = pool;
    btn.dataset.pool = pool;
    tabsEl.appendChild(btn);
  });

  // Default to first pool
  if (tabsEl.children.length) {
    tabsEl.children[0].classList.add('active');
    piezActivePool = tabsEl.children[0].dataset.pool;
  }

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.set-tab');
    if (!tab) return;
    tabsEl.querySelectorAll('.set-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    piezActivePool = tab.dataset.pool || null;
    el('piez-time').value = nowHHMM();
    renderPiezList();
  });

  renderPiezList();
}

function renderPiezList() {
  const body   = el('piez-list-body');
  const dateIn = el('piez-date');
  const timeIn = el('piez-time');

  const filtered = piezActivePool
    ? piezAllItems.filter(p => p.pool === piezActivePool)
    : piezAllItems;

  if (!filtered.length) {
    body.innerHTML = '<div class="placeholder-msg">No active piezometers in this pool.</div>';
    return;
  }

  body.innerHTML = '';

  // Pool title card with count and map button
  const doneCount  = filtered.filter(p => p.last_reading_date != null).length;
  const totalCount = filtered.length;

  const titleCard = document.createElement('div');
  titleCard.className = 'kf-set-title-card';
  titleCard.innerHTML = `
    <div class="kf-set-title-info">
      <span class="kf-set-title-name">Pool: ${piezActivePool || 'All'}</span>
      <span class="kf-set-title-count">${doneCount} / ${totalCount} have readings</span>
    </div>
    <button class="btn btn-secondary btn-sm piez-pool-map-btn">${icon('map')} Map</button>`;
  titleCard.querySelector('.piez-pool-map-btn').addEventListener('click', () => {
    openSetMapModal(`Pool: ${piezActivePool}`, filtered.map(p => ({
      common_name:   p.piezometer_name,
      gps_latitude:  p.gps_latitude,
      gps_longitude: p.gps_longitude,
    })));
  });
  body.appendChild(titleCard);

  filtered.forEach(p => body.appendChild(createPiezItem(p, dateIn, timeIn)));
}

function createPiezItem(p, dateInput, timeInput) {
  const div = document.createElement('div');
  div.className = 'list-item';

  const daysSince  = daysSinceDate(p.last_reading_date);
  const sc    = daysSince == null ? 'due' : daysSince > 7 ? 'overdue' : 'done';
  const badge = daysSince == null
    ? 'No reading'
    : localDateStr(p.last_reading_date, { month: 'short', day: 'numeric' });
  const prevDTW    = p.last_dtw != null ? `${Number(p.last_dtw).toFixed(2)} ft` : null;
  const prevMethod = p.last_method ? p.last_method.charAt(0).toUpperCase() + p.last_method.slice(1) : null;
  const prevCond   = p.last_wet_dry_moist ? p.last_wet_dry_moist.charAt(0).toUpperCase() + p.last_wet_dry_moist.slice(1) : null;
  const prevParts  = [prevDTW, prevMethod, prevCond].filter(Boolean);
  const prevMeta   = prevParts.length ? prevParts.join(' · ') : null;
  const hasGPS     = p.gps_latitude && p.gps_longitude;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="status-dot ${sc}"></span>
      <span class="list-item-name">${p.piezometer_name}</span>
      <span class="status-badge ${sc}">${badge}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    ${prevMeta ? `<div class="list-item-meta"><span>Prev: ${prevMeta}</span></div>` : ''}
    <div class="list-item-form">
      ${p.notes ? `<div class="piez-perm-notes">${p.notes}</div>` : ''}
      <div class="form-group">
        <label>Depth to Water (ft)${prevDTW ? `<span class="prev-hint"> · Prev: ${prevDTW}</span>` : ''}</label>
        <input type="number" class="ctrl-input piez-dtw" step="0.01" placeholder="0.00">
      </div>
      <div class="two-col">
        <div class="form-group toggle-row">
          <label>Method</label>
          <div class="toggle-group">
            <button class="toggle-btn active piez-plopper">Plopper</button>
            <button class="toggle-btn piez-sounder">Sounder</button>
          </div>
        </div>
        <div class="form-group toggle-row">
          <label>Condition</label>
          <div class="toggle-group">
            <button class="toggle-btn active piez-wet">Wet</button>
            <button class="toggle-btn piez-dry">Dry</button>
            <button class="toggle-btn piez-moist">Moist</button>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Operator</label>
        <input type="text" class="ctrl-input piez-op" placeholder="Initials">
      </div>
      <div class="form-group">
        <label>Notes</label>
        ${p.last_reading_notes ? `<div class="prev-note-hint">${escHtml(p.last_reading_notes)}</div>` : ''}
        <textarea class="ctrl-textarea piez-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${hasGPS ? `<button class="btn btn-secondary btn-sm piez-map-btn">${icon('map-pin')} Map</button>` : ''}
        <button class="btn btn-secondary btn-sm piez-hist-btn">${icon('history')} History</button>
        <button class="btn btn-save piez-save">Save Reading</button>
      </div>
    </div>`;

  // Auto-fill operator
  if (currentUser) {
    div.querySelector('.piez-op').value = currentUser.initials || currentUser.username;
  }

  // Toggle state
  let piezMethod = 'plopper';
  let piezCond   = 'wet';

  const plBtn  = div.querySelector('.piez-plopper');
  const soBtn  = div.querySelector('.piez-sounder');
  const wetBtn = div.querySelector('.piez-wet');
  const dryBtn = div.querySelector('.piez-dry');
  const moBtn  = div.querySelector('.piez-moist');

  // Pre-fill previous method/condition if available
  if (p.last_method === 'sounder') {
    piezMethod = 'sounder';
    plBtn.classList.remove('active');
    soBtn.classList.add('active');
  }
  if (p.last_wet_dry_moist) {
    piezCond = p.last_wet_dry_moist;
    wetBtn.classList.remove('active');
    dryBtn.classList.remove('active');
    moBtn.classList.remove('active');
    div.querySelector(`.piez-${piezCond}`).classList.add('active');
  }

  plBtn.addEventListener('click', e => {
    piezMethod = 'plopper';
    plBtn.classList.add('active'); soBtn.classList.remove('active');
  });
  soBtn.addEventListener('click', e => {
    piezMethod = 'sounder';
    soBtn.classList.add('active'); plBtn.classList.remove('active');
  });
  wetBtn.addEventListener('click', e => {
    piezCond = 'wet';
    wetBtn.classList.add('active'); dryBtn.classList.remove('active'); moBtn.classList.remove('active');
  });
  dryBtn.addEventListener('click', e => {
    piezCond = 'dry';
    dryBtn.classList.add('active'); wetBtn.classList.remove('active'); moBtn.classList.remove('active');
  });
  moBtn.addEventListener('click', e => {
    piezCond = 'moist';
    moBtn.classList.add('active'); wetBtn.classList.remove('active'); dryBtn.classList.remove('active');
  });

  const mapBtn = div.querySelector('.piez-map-btn');
  if (mapBtn) {
    mapBtn.addEventListener('click', e => {
      e.stopPropagation();
      openLocationModal(p.gps_latitude, p.gps_longitude, p.piezometer_name);
    });
  }

  div.querySelector('.piez-hist-btn').addEventListener('click', e => {
    e.stopPropagation();
    openHistoryModal('piezometer', p.piezometer_id, p.piezometer_name);
  });

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = div.classList.toggle('expanded');
    div.querySelector('.list-item-form').style.display = open ? '' : 'none';
    if (open) {
      const sb = div.querySelector('.piez-save');
      sb.disabled = false; sb.textContent = 'Save Reading';
      el('piez-time').value = nowHHMM();
    }
  });

  div.querySelector('.piez-save').addEventListener('click', async e => {
    e.stopPropagation();
    const errEl = div.querySelector('.lif-error');
    errEl.classList.add('hidden');
    const dtw = div.querySelector('.piez-dtw').value;
    if (!dtw) { errEl.textContent = 'Depth to water is required'; errEl.classList.remove('hidden'); return; }

    const saveBtn = e.currentTarget;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const body = {
      piezometer_id:  p.piezometer_id,
      reading_date:   dateInput.value,
      reading_time:   timeInput.value,
      dtw_reading:    parseFloat(dtw),
      operator:       div.querySelector('.piez-op').value || null,
      plopper_sounder: piezMethod,
      wet_dry_moist:  piezCond,
      notes:          div.querySelector('.piez-notes').value || null,
    };
    try {
      const r = await api('POST', '/api/readings/piezometer', body, `Piez — ${p.piezometer_name}`);
      div.querySelector('.status-dot').className = 'status-dot done';
      div.querySelector('.status-badge').textContent = r.queued ? 'Offline' : 'Today';
      div.querySelector('.status-badge').className = 'status-badge done';
      div.classList.remove('expanded');
      div.querySelector('.list-item-form').style.display = 'none';
      if (!r.queued) {
        const condStr = piezCond.charAt(0).toUpperCase() + piezCond.slice(1);
        const methStr = piezMethod.charAt(0).toUpperCase() + piezMethod.slice(1);
        const newPrev = [`${Number(dtw).toFixed(2)} ft`, methStr, condStr].join(' · ');
        let meta = div.querySelector('.list-item-meta');
        if (!meta) {
          meta = document.createElement('div');
          meta.className = 'list-item-meta';
          div.querySelector('.list-item-header').after(meta);
        }
        meta.innerHTML = `<span>Prev: ${newPrev}</span>`;
      }
      div.querySelector('.piez-dtw').value = '';
      div.querySelector('.piez-notes').value = '';
      showToast(r.queued ? `${p.piezometer_name} queued offline` : `${p.piezometer_name} saved`, r.queued ? 'warn' : 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
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
  const saved = localStorage.getItem('watermark-text-size');
  if (saved) document.documentElement.style.fontSize = saved + 'px';
})();

function updateTextSizeBtns() {
  const saved = localStorage.getItem('watermark-text-size');
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
    localStorage.setItem('watermark-text-size', size);
    updateTextSizeBtns();
  });
});

// Settings panel navigation
const SETTINGS_PANEL_NAMES = {
  account:          'Account',
  password:         'Change Password',
  textsize:         'Text Size',
  readings:         "Today's Readings",
  'kf-widget':      'KF Widget',
  'running-wells':  'Running Wells',
  'gps-selector':   'GPS Location Selector',
  'scada-roles':    'SCADA Access',
  appinfo:          'App Info',
  tools:            'Tools',
  bugreports:       'Bug Reports',
  usermgmt:         'User Management',
  chargecodes:      'Charge Code Settings',
};
function openSettingsPanel(panelId) {
  el('settings-main').classList.add('hidden');
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
  el('settings-panel-' + panelId).classList.remove('hidden');
  setPanelNav(el('screen-admin'), closeSettingsPanel,
    'Settings - ' + (SETTINGS_PANEL_NAMES[panelId] || panelId));
  if (panelId === 'readings')       loadTodayReadings();
  if (panelId === 'bugreports')     loadBugReports();
  if (panelId === 'kf-widget')      initKFWidgetPanel();
  if (panelId === 'running-wells')  initRunningWellsPanel();
  if (panelId === 'gps-selector')   initGPSSelectorSettingsPanel();
  if (panelId === 'scada-roles')    initScadaRolesPanel();
  if (panelId === 'chargecodes')    initChargeCodesSettings();
  if (panelId === 'appinfo') {
    const ls = localStorage.getItem('watermark-last-sync');
    el('settings-last-sync').textContent = ls ? new Date(ls).toLocaleString() : 'Never';
    el('settings-db-status').textContent = el('db-dot').classList.contains('connected') ? 'Connected' : 'Disconnected';
  }
}

function closeSettingsPanel() {
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
  el('settings-main').classList.remove('hidden');
  setPanelNav(el('screen-admin'), () => showScreen('dashboard'), 'Settings');
}

document.querySelectorAll('.settings-menu-row[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => openSettingsPanel(btn.dataset.panel));
});

// .settings-back-btn buttons removed from HTML — navigation handled by setPanelNav()

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
  if (btn.dataset.tool === 'exif')      openExifTool();
  if (btn.dataset.tool === 'upload')    openUploadTool();
  if (btn.dataset.tool === 'gpspicker') openGpsPicker();
  if (btn.dataset.tool === 'scadatest') openScadaTestTool();
});

el('exif-back-btn').addEventListener('click', () => {
  el('exif-tool-overlay').classList.add('hidden');
});

// ── SCADA Scaling Test tool (raw-ADC tester) ──────────────────────────────────
// Reads each analog sensor's live .SCL.Raw ADC count, applies a user-entered
// Min/Max/Offset linear scaling between the configurable 4mA/20mA raw endpoints,
// and shows the result next to the live PV so scaling can be dialed in against
// real-time numbers. Inputs persist in localStorage. Read-only — never writes
// back to the PLC.
(function () {
  const SENSORS = [
    { key: 'FBLvl',  label: 'Forebay',    unit: 'ft'  },
    { key: 'ABLvl',  label: 'Afterbay',   unit: 'ft'  },
    { key: 'DSLvl',  label: 'Downstream', unit: 'ft'  },
    { key: 'TRLvl',  label: 'Trash Rack', unit: 'ft'  },
    { key: 'AirPSI', label: 'Air Press',  unit: 'psi' },
  ];
  // Default raw-count range for a 4-20mA analog input.
  const DEF_RAW4 = 4000, DEF_RAW20 = 20000;
  let config = null, plantNum = 1, pollTimer = null;

  function rawEndpoints() {
    const r4  = Number(localStorage.getItem('scadatestRaw4'));
    const r20 = Number(localStorage.getItem('scadatestRaw20'));
    return {
      raw4:  isFinite(r4)  && localStorage.getItem('scadatestRaw4')  != null && localStorage.getItem('scadatestRaw4')  !== '' ? r4  : DEF_RAW4,
      raw20: isFinite(r20) && localStorage.getItem('scadatestRaw20') != null && localStorage.getItem('scadatestRaw20') !== '' ? r20 : DEF_RAW20,
    };
  }

  function scaleKey(tag)   { return 'scadatestScale:' + tag; }
  function getScale(tag) {
    try { return JSON.parse(localStorage.getItem(scaleKey(tag))) || {}; }
    catch { return {}; }
  }
  function setScale(tag, s) { localStorage.setItem(scaleKey(tag), JSON.stringify(s)); }

  // Linear raw-ADC scaling between the 4mA/20mA count endpoints.
  // Returns null if inputs are incomplete or the span is degenerate.
  function scale(raw, min, max, offset) {
    if (raw == null || min === '' || max === '' || min == null || max == null) return null;
    const r = Number(raw), mn = Number(min), mx = Number(max), off = Number(offset) || 0;
    const { raw4, raw20 } = rawEndpoints();
    if (!isFinite(r) || !isFinite(mn) || !isFinite(mx) || raw20 === raw4) return null;
    return mn + ((r - raw4) / (raw20 - raw4)) * (mx - mn) + off;
  }

  function plantSites(n) {
    if (!config) return [];
    return config.sites.filter(s => s.influxSite === `CVC_PP${n}A` || s.influxSite === `CVC_PP${n}B`);
  }

  function rowHtml(site, sensor) {
    const tag = `${site.influxSite}.${sensor.key}.SCL.Raw`;
    const pvTag = `${site.influxSite}.${sensor.key}.SCL.PV`;
    const s = getScale(tag);
    return `<tr data-raw-tag="${tag}" data-pv-tag="${pvTag}">
      <td>${escHtml(sensor.label)}<span style="color:var(--text-dim);font-weight:400"> ${escHtml(sensor.unit)}</span></td>
      <td class="scadatest-raw" data-cell="raw">—</td>
      <td><input type="number" step="any" data-fld="min" value="${s.min ?? ''}"></td>
      <td><input type="number" step="any" data-fld="max" value="${s.max ?? ''}"></td>
      <td><input type="number" step="any" data-fld="offset" value="${s.offset ?? ''}"></td>
      <td class="scadatest-out" data-cell="out">—</td>
      <td class="scadatest-pv" data-cell="pv">—</td>
    </tr>`;
  }

  function render() {
    el('scadatest-pills').innerHTML = [1,2,3,4,5,6,7].map(n =>
      `<button class="scadatest-pill${n===plantNum?' active':''}" data-plant="${n}">PP ${n}</button>`).join('');

    const sites = plantSites(plantNum);
    el('scadatest-tables').innerHTML = sites.map(site => `
      <div class="scadatest-site-hdr">${escHtml(site.name)}</div>
      <div class="scadatest-table-wrap">
        <table class="scadatest-table">
          <thead><tr>
            <th>Signal</th><th>Raw ADC</th><th>Min</th><th>Max</th><th>Offset</th><th>Output</th><th>Live PV</th>
          </tr></thead>
          <tbody>${SENSORS.map(sn => rowHtml(site, sn)).join('')}</tbody>
        </table>
      </div>`).join('') || '<div class="scadatest-site-hdr">No sites for this plant.</div>';

    // Wire scaling inputs: persist + recompute that row's output on change
    el('scadatest-tables').querySelectorAll('tr[data-raw-tag]').forEach(tr => {
      tr.querySelectorAll('input[data-fld]').forEach(inp =>
        inp.addEventListener('input', () => {
          const tag = tr.dataset.rawTag;
          const s = getScale(tag);
          s[inp.dataset.fld] = inp.value;
          setScale(tag, s);
          recomputeRow(tr);
        }));
    });

    el('scadatest-pills').querySelectorAll('[data-plant]').forEach(p =>
      p.addEventListener('click', () => {
        plantNum = Number(p.dataset.plant);
        render();
        poll();
      }));
  }

  function recomputeRow(tr) {
    const rawCell = tr.querySelector('[data-cell="raw"]');
    const raw = rawCell._raw;
    const min = tr.querySelector('[data-fld="min"]').value;
    const max = tr.querySelector('[data-fld="max"]').value;
    const off = tr.querySelector('[data-fld="offset"]').value;
    const out = scale(raw, min, max, off);
    tr.querySelector('[data-cell="out"]').textContent = out == null ? '—' : out.toFixed(2);
  }

  async function poll() {
    if (!config) return;
    const sites = plantSites(plantNum);
    if (!sites.length) return;
    const siteParam = sites.map(s => s.influxSite).join(',');
    let data;
    try { data = await api('GET', `/api/scada/raw-current?sites=${encodeURIComponent(siteParam)}`); }
    catch { return; }
    if (el('scadatest-tool-overlay').classList.contains('hidden')) return;
    el('scadatest-tables').querySelectorAll('tr[data-raw-tag]').forEach(tr => {
      const raw = data[tr.dataset.rawTag]?.v;
      const pv  = data[tr.dataset.pvTag]?.v;
      const rawCell = tr.querySelector('[data-cell="raw"]');
      rawCell._raw = raw ?? null;
      rawCell.textContent = raw == null ? '—' : Number(raw).toFixed(Number.isInteger(raw) ? 0 : 1);
      tr.querySelector('[data-cell="pv"]').textContent = pv == null ? '—' : Number(pv).toFixed(2);
      recomputeRow(tr);
    });
  }

  function recomputeAll() {
    el('scadatest-tables').querySelectorAll('tr[data-raw-tag]').forEach(recomputeRow);
    updateCalc();
  }

  function updateCalc() {
    const out = scale(
      el('scadatest-calc-raw').value === '' ? null : el('scadatest-calc-raw').value,
      el('scadatest-calc-min').value,
      el('scadatest-calc-max').value,
      el('scadatest-calc-offset').value,
    );
    el('scadatest-calc-result').textContent = out == null ? '—' : out.toFixed(2);
  }

  window.openScadaTestTool = async function () {
    el('scadatest-tool-overlay').classList.remove('hidden');
    const { raw4, raw20 } = rawEndpoints();
    el('scadatest-raw4').value  = raw4;
    el('scadatest-raw20').value = raw20;
    if (!config) {
      el('scadatest-tables').innerHTML = '<div class="scadatest-site-hdr">Loading…</div>';
      try { config = await api('GET', '/api/scada/config'); }
      catch (e) {
        el('scadatest-tables').innerHTML =
          `<div class="scadatest-site-hdr">SCADA source unavailable.</div>`;
        return;
      }
    }
    render();
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, config.pollMs || 5000);
  };

  el('scadatest-back-btn').addEventListener('click', () => {
    el('scadatest-tool-overlay').classList.add('hidden');
    clearInterval(pollTimer); pollTimer = null;
  });

  // Global ADC endpoints — persist and recompute every row + the calculator.
  el('scadatest-raw4').addEventListener('input', () => {
    localStorage.setItem('scadatestRaw4', el('scadatest-raw4').value);
    recomputeAll();
  });
  el('scadatest-raw20').addEventListener('input', () => {
    localStorage.setItem('scadatestRaw20', el('scadatest-raw20').value);
    recomputeAll();
  });

  ['raw','min','max','offset'].forEach(f =>
    el('scadatest-calc-' + f).addEventListener('input', updateCalc));
})();

// ── Pond GPS Picker ───────────────────────────────────────────────────────────
(function () {
  let gpsMap = null, points = [], markers = [], fmt = 'latlng', isClosed = false;
  let gpsMode = 'polygon', updatePoint = null, updateMarker = null;

  function makeIcon(n, color) {
    color = color || '#1D9E75';
    return L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.4)">${n}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
  }

  function getPondName()   { return el('gps-pond-name').value.trim(); }
  function getEntityType() { return el('gps-entity-type').value; }
  function getPondId()     { return el('gps-entity-id').value || ''; }

  async function loadEntityDropdown() {
    const type = getEntityType();
    const sel = el('gps-entity-id');
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
      const url = type === 'outlet' ? '/api/outlets/list' : '/api/ponds/list';
      const items = await api('GET', url);
      sel.innerHTML = items.map(item => {
        const id = type === 'outlet' ? item.outlet_id : item.pond_id;
        return `<option value="${escHtml(String(id))}">${escHtml(item.name)} (${escHtml(String(id))})</option>`;
      }).join('');
      onEntitySelect();
    } catch (e) {
      sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  function onEntitySelect() {
    const sel = el('gps-entity-id');
    const opt = sel.options[sel.selectedIndex];
    if (opt && opt.value) {
      el('gps-pond-name').value = opt.text.replace(/\s*\(\d+\)$/, '');
    }
    gpsRender();
  }

  function buildUpdateSQL() {
    if (!updatePoint) return '';
    const tbl   = el('gps-update-table').value;
    const pk    = el('gps-update-pk').value.trim() || '<pk_value>';
    const pkCol = tbl === 'ponds' ? 'pond_id' : tbl === 'river_outlets' ? 'outlet_id' : 'connection_id';
    const latC  = tbl === 'pond_connections' ? 'gate_lat' : 'gauge_lat';
    const lonC  = tbl === 'pond_connections' ? 'gate_lon' : 'gauge_lon';
    return `UPDATE ${tbl}\nSET ${latC} = ${updatePoint.lat},\n    ${lonC} = ${updatePoint.lng}\nWHERE ${pkCol} = ${pk};`;
  }

  function buildPolygonOutput() {
    if (!points.length) return '';
    const idCol = getEntityType() === 'outlet' ? 'outlet_id' : 'pond_id';
    const name = getPondName(), id = getPondId();
    if (fmt === 'single') {
      const p = points[0];
      return name ? `${name}\t${p.lat}\t${p.lng}` : `${p.lat}\t${p.lng}`;
    }
    if (fmt === 'latlng') {
      return `${idCol}: ${id} | ${name || 'Unnamed'}\n` +
        points.map((p, i) => `Point ${i + 1}: ${p.lat}, ${p.lng}`).join('\n');
    }
    const label = name || 'Unnamed';
    const rows = points.map((p, i) =>
      `  (${id}, '${label}', ${i + 1}, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326))`
    ).join(',\n');
    return `-- ${label} (${idCol}: ${id})\nINSERT INTO pond_points (${idCol}, name, point_order, geom) VALUES\n${rows};`;
  }

  function updateCloseBtn() {
    const ok = points.length >= 3 && fmt !== 'single' && !isClosed;
    const btn = el('gps-close-btn');
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '0.4';
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
  }

  function renderUpdate() {
    const tbl = el('gps-update-table').value;
    const pkMap = { ponds: 'pond_id', river_outlets: 'outlet_id', pond_connections: 'connection_id' };
    el('gps-pk-label').textContent = (pkMap[tbl] || 'id') + ':';
    const display = el('gps-update-point-display');
    const preview = el('gps-preview');
    const copyBtn = el('gps-copy-btn');
    if (!updatePoint) {
      display.textContent = 'No point selected — tap the map';
      display.style.fontStyle = 'italic';
      preview.textContent = '';
      copyBtn.disabled = true; copyBtn.style.opacity = '0.4'; copyBtn.style.cursor = 'not-allowed';
      return;
    }
    display.innerHTML = `<span style="color:var(--text-dim)">Lat</span> <strong>${updatePoint.lat}</strong> &nbsp; <span style="color:var(--text-dim)">Lng</span> <strong>${updatePoint.lng}</strong>`;
    display.style.fontStyle = 'normal';
    preview.textContent = buildUpdateSQL();
    copyBtn.disabled = false; copyBtn.style.opacity = '1'; copyBtn.style.cursor = 'pointer';
  }

  function renderPolygon() {
    const isSingle = fmt === 'single';
    el('gps-name-label').textContent = isSingle ? 'Name:' : 'Pond name:';
    el('gps-single-hint').style.display = isSingle ? 'block' : 'none';
    el('gps-close-row').style.display  = isSingle ? 'none' : 'flex';
    const list    = el('gps-points-list');
    const preview = el('gps-preview');
    const copyBtn = el('gps-copy-btn');
    if (!points.length) {
      list.innerHTML = '<span style="font-style:italic;color:var(--text-dim)">No points yet — tap the map to add</span>';
      preview.textContent = ''; copyBtn.disabled = true; copyBtn.style.opacity = '0.4'; copyBtn.style.cursor = 'not-allowed';
      updateCloseBtn(); return;
    }
    if (isSingle) {
      const p = points[0], name = getPondName();
      let cols = name ? `<span><span style="color:var(--text-dim)">Name</span> <strong>${name}</strong></span><span style="color:var(--border);margin:0 4px">|</span>` : '';
      cols += `<span><span style="color:var(--text-dim)">Lat</span> <strong>${p.lat}</strong></span><span style="color:var(--border);margin:0 4px">|</span><span><span style="color:var(--text-dim)">Lng</span> <strong>${p.lng}</strong></span>`;
      list.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cols}</div>`;
    } else {
      list.innerHTML = points.map((p, i) => {
        const closing = isClosed && i === points.length - 1;
        return `<div style="display:flex;align-items:center;gap:8px;">
          <span style="color:var(--text);min-width:62px;">Point ${i + 1}${closing ? ' ⬡' : ''}</span>
          <span style="color:var(--text-dim)">${p.lat}, ${p.lng}</span>
          ${!closing ? `<button onclick="gpsRemovePoint(${i})" class="btn btn-secondary btn-sm" style="font-size:10px;padding:1px 7px;">×</button>` : ''}
        </div>`;
      }).join('');
    }
    preview.textContent = buildPolygonOutput();
    copyBtn.disabled = false; copyBtn.style.opacity = '1'; copyBtn.style.cursor = 'pointer';
    updateCloseBtn();
  }

  function gpsRender() { gpsMode === 'update' ? renderUpdate() : renderPolygon(); }

  window.gpsRemovePoint = function (i) {
    markers[i].remove(); markers.splice(i, 1); points.splice(i, 1);
    markers.forEach((m, j) => {
      const d = m.getElement()?.querySelector('div');
      if (d) d.textContent = j + 1;
    });
    gpsRender();
  };

  window.openGpsPicker = function () {
    el('gpspicker-overlay').classList.remove('hidden');
    loadEntityDropdown();
    setTimeout(() => {
      if (!gpsMap) {
        gpsMap = L.map('gpspicker-map', { zoomControl: true, attributionControl: false })
          .setView([35.37, -119.02], 14);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20 }).addTo(gpsMap);
        gpsMap.on('click', function (e) {
          const lat = e.latlng.lat.toFixed(7), lng = e.latlng.lng.toFixed(7);
          if (gpsMode === 'update') {
            if (updateMarker) updateMarker.remove();
            updatePoint = { lat, lng };
            updateMarker = L.marker([lat, lng], { icon: makeIcon('+', '#378ADD') }).addTo(gpsMap);
            renderUpdate();
            return;
          }
          if (isClosed) return;
          if (fmt === 'single') { markers.forEach(m => m.remove()); markers = []; points = []; }
          points.push({ lat, lng });
          markers.push(L.marker([lat, lng], { icon: makeIcon(points.length) }).addTo(gpsMap));
          gpsRender();
        });
      }
      gpsMap.invalidateSize();
    }, 80);
  };

  el('gpspicker-back-btn').addEventListener('click', () => {
    el('gpspicker-overlay').classList.add('hidden');
    if (gpsMap) { gpsMap.remove(); gpsMap = null; }
  });

  el('gps-close-btn').addEventListener('click', () => {
    if (points.length < 3 || isClosed) return;
    const f = points[0];
    points.push({ lat: f.lat, lng: f.lng });
    markers.push(L.marker([f.lat, f.lng], { icon: makeIcon(points.length) }).addTo(gpsMap));
    isClosed = true;
    el('gps-close-status').textContent = `Closed — point ${points.length} is an exact copy of point 1`;
    gpsRender();
  });

  el('gps-clear-btn').addEventListener('click', () => {
    markers.forEach(m => m.remove()); markers = []; points = []; isClosed = false;
    el('gps-close-status').textContent = '';
    gpsRender();
  });

  el('gps-update-clear-btn').addEventListener('click', () => {
    if (updateMarker) updateMarker.remove();
    updateMarker = null; updatePoint = null;
    el('gps-update-pk').value = '';
    renderUpdate();
  });

  el('gps-update-table').addEventListener('change', renderUpdate);
  el('gps-update-pk').addEventListener('input', renderUpdate);
  el('gps-pond-name').addEventListener('input', gpsRender);
  el('gps-entity-type').addEventListener('change', loadEntityDropdown);
  el('gps-entity-id').addEventListener('change', onEntitySelect);

  document.querySelectorAll('.gps-mode-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      gpsMode = this.dataset.gpsmode;
      document.querySelectorAll('.gps-mode-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      el('gps-polygon-panel').style.display = gpsMode === 'polygon' ? 'block' : 'none';
      el('gps-update-panel').style.display  = gpsMode === 'update'  ? 'block' : 'none';
      if (gpsMode === 'update') { markers.forEach(m => m.remove()); markers = []; points = []; isClosed = false; el('gps-close-status').textContent = ''; }
      else { if (updateMarker) updateMarker.remove(); updateMarker = null; updatePoint = null; }
      gpsRender();
    });
  });

  document.querySelectorAll('.gps-fmt-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      fmt = this.dataset.gpsfmt;
      document.querySelectorAll('.gps-fmt-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      if (fmt === 'single') { markers.forEach(m => m.remove()); markers = []; points = []; isClosed = false; el('gps-close-status').textContent = ''; }
      gpsRender();
    });
  });

  el('gps-copy-btn').addEventListener('click', () => {
    const txt = gpsMode === 'update' ? buildUpdateSQL() : buildPolygonOutput();
    if (!txt) return;
    const fb = el('gps-copy-feedback');
    function showFeedback() {
      fb.style.opacity = '1';
      setTimeout(() => { fb.style.opacity = '0'; }, 2000);
    }
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showFeedback(); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(showFeedback).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  });
})();

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

  async function exportCSV() {
    if (!exifRows.length) return;
    const cols = exifFields.filter(f => exifActive.has(f));
    const esc  = v => `"${String(v).replace(/"/g, '""')}"`;
    let csv = cols.map(esc).join(',') + '\n';
    for (const row of exifRows) csv += cols.map(f => esc(row[f] || '')).join(',') + '\n';
    await shareFile(new Blob([csv], { type: 'text/csv' }),
      `exif_${new Date().toISOString().slice(0,10)}.csv`, 'EXIF GPS Data');
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
  const _save = beginSave(el('pw-save-btn'));
  try {
    await api('POST', '/api/auth/change-password', { current_password: cur, new_password: nw });
    el('pw-current').value = '';
    el('pw-new').value = '';
    el('pw-confirm').value = '';
    showToast('Password updated', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    _save();
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
  const _save = beginSave(el('kf-widget-save-btn'));
  try {
    await api('PUT', '/api/settings/kf-widget', { start_date, end_date });
    showToast('KF widget updated');
    // Reload dashboard stats on next visit
    loadDashboardStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    _save();
  }
});

// ── Running Wells Settings ────────────────────────────────────────────────────
const CVC_POOLS = ['Pool 1', 'Pool 2', 'Pool 3', 'Pool 4', 'Pool 5', 'Pool 6'];
const KRC_POOL  = 'Kern River Canal';
const POOL_EXTRA_LABELS = {
  'Pool 1': 'KWB & West Kern Pipeline Total',
  'Pool 2': 'KWB & RRB Turn-In Total',
  'Pool 3': 'KWB, RRB Strand Wells, & Central Intake Total',
};

function poolSortKey(pool) {
  const i = CVC_POOLS.indexOf(pool);
  if (i >= 0) return `0_${i}`;
  if (/kern\s*river\s*canal/i.test(pool)) return '1_krc';
  return `2_${pool}`;
}

async function initRunningWellsPanel() {
  const list = el('rw-settings-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const [{ well_ids, pool_extras }, wells] = await Promise.all([
      api('GET', '/api/settings/running-wells'),
      api('GET', '/api/wells/operational'),
    ]);
    const savedSet = new Set(well_ids.map(Number));

    // Group by discharge_pool
    const byPool = {};
    wells.forEach(w => {
      const pool = w.discharge_pool || 'Other';
      if (!byPool[pool]) byPool[pool] = [];
      byPool[pool].push(w);
    });

    // Sort: Pool 1-6, then KRC, then others
    const sortedPools = Object.keys(byPool).sort((a, b) => poolSortKey(a).localeCompare(poolSortKey(b)));

    let html = '';
    sortedPools.forEach(pool => {
      const poolWells = byPool[pool];
      const safePool  = pool.replace(/"/g, '&quot;');
      html += `<div class="rw-area-row">
        <label class="rw-area-label">
          <input type="checkbox" class="rw-area-cb" data-pool="${safePool}">
          <span>${escHtml(pool)}</span>
        </label>
      </div>`;
      poolWells.forEach(w => {
        const checked = savedSet.has(Number(w.well_id)) ? 'checked' : '';
        html += `<div class="rw-well-row">
          <label class="rw-well-label">
            <input type="checkbox" class="rw-well-cb" data-pool="${safePool}" data-id="${w.well_id}" ${checked}>
            <span>${escHtml(w.common_name)}</span>
          </label>
        </div>`;
      });
      if (POOL_EXTRA_LABELS[pool]) {
        const savedVal = pool_extras[pool] != null ? pool_extras[pool] : '';
        html += `<div class="rw-well-extra-row">
          <span class="rw-well-extra-label">${escHtml(POOL_EXTRA_LABELS[pool])}</span>
          <input type="number" class="ctrl-input ctrl-input-sm rw-pool-extra-input"
            data-pool="${safePool}" step="0.01" min="0" placeholder="0.00"
            value="${savedVal}" style="width:80px;text-align:right">
          <span class="rw-well-extra-unit">cfs</span>
        </div>`;
      }
    });

    // Ensure Pool 1/2/3 extra inputs always appear even if no wells in that pool
    Object.entries(POOL_EXTRA_LABELS).forEach(([pool, label]) => {
      if (byPool[pool]) return;
      const safePool = pool.replace(/"/g, '&quot;');
      const savedVal = pool_extras[pool] != null ? pool_extras[pool] : '';
      html += `<div class="rw-area-row"><label class="rw-area-label"><span>${escHtml(pool)}</span></label></div>
        <div class="rw-well-extra-row">
          <span class="rw-well-extra-label">${escHtml(label)}</span>
          <input type="number" class="ctrl-input ctrl-input-sm rw-pool-extra-input"
            data-pool="${safePool}" step="0.01" min="0" placeholder="0.00"
            value="${savedVal}" style="width:80px;text-align:right">
          <span class="rw-well-extra-unit">cfs</span>
        </div>`;
    });

    list.innerHTML = html;

    function syncPoolCheckbox(pool) {
      const wellCbs = list.querySelectorAll(`.rw-well-cb[data-pool="${pool}"]`);
      const poolCb  = list.querySelector(`.rw-area-cb[data-pool="${pool}"]`);
      if (!poolCb) return;
      const total   = wellCbs.length;
      const checked = [...wellCbs].filter(c => c.checked).length;
      poolCb.checked = checked === total;
      poolCb.indeterminate = checked > 0 && checked < total;
    }

    Object.keys(byPool).forEach(syncPoolCheckbox);

    list.querySelectorAll('.rw-area-cb').forEach(poolCb => {
      poolCb.addEventListener('change', () => {
        list.querySelectorAll(`.rw-well-cb[data-pool="${poolCb.dataset.pool}"]`)
          .forEach(cb => { cb.checked = poolCb.checked; });
      });
    });

    list.querySelectorAll('.rw-well-cb').forEach(wellCb => {
      wellCb.addEventListener('change', () => syncPoolCheckbox(wellCb.dataset.pool));
    });
  } catch (err) {
    list.innerHTML = `<div class="placeholder-msg">Failed to load.</div>`;
  }
}

el('rw-settings-save-btn').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.rw-well-cb:checked')].map(cb => Number(cb.dataset.id));
  const pool_extras = {};
  document.querySelectorAll('.rw-pool-extra-input').forEach(inp => {
    const v = parseFloat(inp.value);
    if (!isNaN(v) && v >= 0) pool_extras[inp.dataset.pool] = v;
  });
  const _save = beginSave(el('rw-settings-save-btn'));
  try {
    await api('PUT', '/api/settings/running-wells', { well_ids: checked, pool_extras });
    showToast('Running wells saved');
    loadDashboardStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    _save();
  }
});

async function initGPSSelectorSettingsPanel() {
  try {
    const s = await api('GET', '/api/settings/gps-selector');
    const isPublic = s.public;
    el('gps-sel-toggle-on').classList.toggle('active', isPublic);
    el('gps-sel-toggle-off').classList.toggle('active', !isPublic);
  } catch { /* ignore */ }
}

el('gps-sel-toggle-on').addEventListener('click', () => {
  el('gps-sel-toggle-on').classList.add('active');
  el('gps-sel-toggle-off').classList.remove('active');
});
el('gps-sel-toggle-off').addEventListener('click', () => {
  el('gps-sel-toggle-off').classList.add('active');
  el('gps-sel-toggle-on').classList.remove('active');
});
el('gps-sel-save-btn').addEventListener('click', async () => {
  const isPublic = el('gps-sel-toggle-on').classList.contains('active');
  const _save = beginSave(el('gps-sel-save-btn'));
  try {
    await api('PUT', '/api/settings/gps-selector', { public: isPublic });
    showToast('Setting saved', 'success');
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  } finally {
    _save();
  }
});

/* ── SCADA Access (admin) ─────────────────────────────────────────────────── */
// Roles offered as checkboxes, in display order. Admin is always on + locked.
const SCADA_ROLE_OPTIONS = ['operator', 'systems-operator', 'heavy-equipment-operator',
  'pump-tech', 'elec-tech', 'water-planner', 'supervisor', 'admin'];

async function initScadaRolesPanel() {
  const list = el('scada-roles-list');
  let allowed = ['admin'];
  try {
    const r = await api('GET', '/api/settings/scada-roles');
    if (Array.isArray(r.roles)) allowed = r.roles;
  } catch { /* keep default */ }
  list.innerHTML = SCADA_ROLE_OPTIONS.map(role => {
    const checked = allowed.includes(role) ? 'checked' : '';
    const locked  = role === 'admin' ? 'disabled' : '';
    return `<label class="settings-row">
      <span class="settings-label">${escHtml(formatRole(role))}${role === 'admin' ? ' (always)' : ''}</span>
      <input type="checkbox" class="scada-role-cb" data-role="${role}" ${checked} ${locked}>
    </label>`;
  }).join('');
}

el('scada-roles-save-btn').addEventListener('click', async () => {
  const roles = [...document.querySelectorAll('.scada-role-cb:checked')].map(c => c.dataset.role);
  if (!roles.includes('admin')) roles.push('admin');
  const _save = beginSave(el('scada-roles-save-btn'));
  try {
    const r = await api('PUT', '/api/settings/scada-roles', { roles });
    if (Array.isArray(r.roles)) scadaAllowedRoles = r.roles;
    // Reflect immediately for the current admin
    const ok = isScadaAllowed(currentUser.role);
    el('nav-scada-item').classList.toggle('hidden', !ok);
    el('scada-flow-stat')?.classList.toggle('hidden', !ok);
    showToast('SCADA access updated', 'success');
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  } finally {
    _save();
  }
});

async function openKFSetsModal() {
  const body = el('kf-sets-modal-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  el('kf-sets-modal').classList.remove('hidden');
  try {
    const { sets, kf_start, kf_end } = await api('GET', '/api/dashboard/kf-by-set');
    const fmtDate = str => {
      if (!str) return '';
      const [y, m, d] = str.split('-');
      return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    el('kf-sets-modal-title').textContent =
      `KF Complete — ${fmtDate(kf_start)} – ${fmtDate(kf_end)}`;

    if (!sets.length) {
      body.innerHTML = '<div class="placeholder-msg">No KF sets found.</div>';
      return;
    }

    const totalWells = sets.reduce((s, r) => s + r.total_wells, 0);
    const totalRead  = sets.reduce((s, r) => s + r.wells_read, 0);

    let html = '';
    sets.forEach(r => {
      const pct = r.total_wells > 0 ? Math.round((r.wells_read / r.total_wells) * 100) : 0;
      html += `<div class="kf-set-row">
        <div class="kf-set-name">${r.set_name}</div>
        <div class="kf-set-count">${r.wells_read}<span class="kf-set-total">/${r.total_wells}</span></div>
        <div class="kf-set-bar-wrap">
          <div class="kf-set-bar"><div class="kf-set-bar-fill" style="width:${pct}%"></div></div>
          <span class="kf-set-pct">${pct}%</span>
        </div>
      </div>`;
    });

    const totalPct = totalWells > 0 ? Math.round((totalRead / totalWells) * 100) : 0;
    html += `<div class="kf-set-total-row">
      <div class="kf-set-name">Total</div>
      <div class="kf-set-count">${totalRead}<span class="kf-set-total">/${totalWells}</span></div>
      <div class="kf-set-bar-wrap">
        <div class="kf-set-bar"><div class="kf-set-bar-fill" style="width:${totalPct}%"></div></div>
        <span class="kf-set-pct">${totalPct}%</span>
      </div>
    </div>`;

    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

el('kf-sets-modal-close').addEventListener('click', () => {
  el('kf-sets-modal').classList.add('hidden');
});
el('kf-sets-modal').addEventListener('click', e => {
  if (e.target === el('kf-sets-modal')) el('kf-sets-modal').classList.add('hidden');
});

async function openRunningWellsModal() {
  const body = el('rw-modal-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  el('running-wells-modal').classList.remove('hidden');
  try {
    const { wells, pool_extras } = await api('GET', '/api/dashboard/running-wells');

    // Group configured wells by pool
    const byPool = {};
    wells.forEach(w => {
      const pool = w.discharge_pool || 'Other';
      if (!byPool[pool]) byPool[pool] = [];
      byPool[pool].push(w);
    });

    // Always show Pool 1-6 + KRC; add any other pools from configured wells
    const extraPools = Object.keys(byPool).filter(p =>
      !CVC_POOLS.includes(p) && !(/kern\s*river\s*canal/i.test(p))
    ).sort();
    const allPools = [...CVC_POOLS, KRC_POOL, ...extraPools];

    let cvcTotal = 0;
    let krcTotal = 0;
    let html = '';

    allPools.forEach(pool => {
      const poolWells  = byPool[pool] || [];
      const extraCfs   = parseFloat((pool_extras || {})[pool]) || 0;
      const isKRC      = /kern\s*river\s*canal/i.test(pool);

      html += `<div class="rw-modal-area">${escHtml(pool)}</div>`;

      poolWells.forEach(w => {
        const dot = w.read_today
          ? '<span class="rw-modal-dot rw-dot-read"></span>'
          : '<span class="rw-modal-dot rw-dot-unread"></span>';

        let onOffHtml;
        if (w.on_off === true)        onOffHtml = '<span class="rw-modal-onoff rw-onoff-on">On</span>';
        else if (w.on_off === false)  onOffHtml = '<span class="rw-modal-onoff rw-onoff-off">Off</span>';
        else                          onOffHtml = '<span class="rw-modal-onoff" style="color:var(--text-dim)">—</span>';

        const effectiveFlow = w.flow_cfs ?? (w.on_off ? w.fallback_flow_cfs : null);
        let cfsHtml;
        if (w.on_off && effectiveFlow != null) {
          const isFallback = w.flow_cfs == null && w.fallback_flow_cfs != null;
          cfsHtml = `<span class="rw-modal-cfs${isFallback ? ' rw-cfs-fallback' : ''}">${parseFloat(effectiveFlow).toFixed(2)} cfs</span>`;
        } else if (w.on_off === false) {
          cfsHtml = '<span class="rw-modal-cfs rw-cfs-off">Off</span>';
        } else {
          cfsHtml = '<span class="rw-modal-cfs" style="color:var(--text-dim)">—</span>';
        }

        html += `<div class="rw-modal-row">
          <span class="rw-modal-well-name">${dot}${escHtml(w.common_name)}</span>
          ${onOffHtml}
          ${cfsHtml}
        </div>`;
      });

      const wellPoolCfs = poolWells
        .filter(w => w.on_off)
        .reduce((sum, w) => sum + (parseFloat(w.flow_cfs ?? w.fallback_flow_cfs) || 0), 0);
      const poolTotal = wellPoolCfs + extraCfs;

      if (POOL_EXTRA_LABELS[pool] && extraCfs > 0) {
        html += `<div class="rw-modal-extra-row">
          <span>${escHtml(POOL_EXTRA_LABELS[pool])}</span>
          <span class="rw-modal-cfs">${extraCfs.toFixed(2)} cfs</span>
        </div>`;
      }

      html += `<div class="rw-modal-subtotal">${escHtml(pool)} Total: ${poolTotal.toFixed(2)} cfs</div>`;

      if (isKRC) krcTotal += poolTotal;
      else       cvcTotal += poolTotal;
    });

    html += `<div class="rw-modal-totals-block">
      <div class="rw-modal-total-line">
        <span>Totals: Pools 1–6</span><span>${cvcTotal.toFixed(2)} cfs</span>
      </div>
      <div class="rw-modal-total-line rw-modal-total-krc">
        <span>Kern River Canal</span><span>${krcTotal.toFixed(2)} cfs</span>
      </div>
    </div>`;

    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg">Failed to load.</div>`;
  }
}

el('rw-modal-close').addEventListener('click', () => {
  el('running-wells-modal').classList.add('hidden');
});
el('running-wells-modal').addEventListener('click', e => {
  if (e.target === el('running-wells-modal')) el('running-wells-modal').classList.add('hidden');
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
          <div class="today-reading-name">${escHtml(r.name || '')}</div>
          <div class="today-reading-meta">${r.reading_time ? escHtml(r.reading_time.slice(0,5)) : ''} &bull; ${escHtml(r.summary || '')}</div>
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
let bugPendingPhotos = [];

function renderBugPhotoQueue() {
  const qEl = el('bug-photo-queue');
  if (!bugPendingPhotos.length) { qEl.classList.add('hidden'); qEl.innerHTML = ''; return; }
  qEl.classList.remove('hidden');
  qEl.innerHTML = bugPendingPhotos.map((f, i) =>
    `<div class="maint-aq-item">
      <img src="${URL.createObjectURL(f)}" alt="">
      <button class="maint-aq-remove" data-bug-photo="${i}">&times;</button>
    </div>`
  ).join('');
}

function closeBugModal() {
  el('bug-report-modal').classList.add('hidden');
  bugPendingPhotos = [];
  renderBugPhotoQueue();
}

el('bug-modal-close').addEventListener('click', closeBugModal);
el('bug-modal-cancel').addEventListener('click', closeBugModal);
el('bug-report-modal').addEventListener('click', e => { if (e.target === el('bug-report-modal')) closeBugModal(); });

el('bug-add-photo-btn').addEventListener('click', () => el('bug-photo-input').click());
el('bug-photo-input').addEventListener('change', () => {
  [...el('bug-photo-input').files].forEach(f => bugPendingPhotos.push(f));
  el('bug-photo-input').value = '';
  renderBugPhotoQueue();
});
el('bug-photo-queue').addEventListener('click', e => {
  const btn = e.target.closest('[data-bug-photo]');
  if (!btn) return;
  bugPendingPhotos.splice(parseInt(btn.dataset.bugPhoto), 1);
  renderBugPhotoQueue();
});

el('bug-modal-submit').addEventListener('click', async () => {
  const description = el('bug-description').value.trim();
  const errEl = el('bug-error');
  errEl.classList.add('hidden');
  if (!description) { errEl.textContent = 'Please describe the issue.'; errEl.classList.remove('hidden'); return; }
  const is_repeatable = document.querySelector('#bug-repeatable-seg .seg-btn.active')?.dataset.val === 'true';
  const _save = beginSave(el('bug-modal-submit'));
  try {
    const result = await api('POST', '/api/bug-reports', {
      screen_area: el('bug-screen').value || null,
      severity: el('bug-severity').value,
      is_repeatable,
      description,
      app_version: BUG_VERSION,
    });
    // Upload any pending screenshots
    if (bugPendingPhotos.length && result.report_id) {
      const d = new Date();
      const dateStr = `${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${d.getFullYear()}`;
      let idx = 0;
      for (const photo of bugPendingPhotos) {
        idx++;
        const ext = photo.name.includes('.') ? photo.name.split('.').pop().toLowerCase() : 'jpg';
        const newName = `bug_screenshot_${dateStr}${idx > 1 ? `_${idx}` : ''}.${ext}`;
        const fd = new FormData();
        fd.append('file', new File([photo], newName, { type: photo.type }));
        try {
          await fetch(
            `/api/maintenance/attachment?table_name=bug_reports&record_id=${result.report_id}&file_type=photo&category=general`,
            { method: 'POST', body: fd }
          );
        } catch { /* non-fatal — report is saved, screenshot upload failing is OK */ }
      }
    }
    closeBugModal();
    showToast('Bug report submitted — thank you!', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    _save();
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
            ${r.screen_area ? `<span class="bug-area">${escHtml(r.screen_area)}</span>` : ''}
            ${r.is_repeatable ? '<span class="bug-tag">Repeatable</span>' : ''}
            <span class="bug-meta">${escHtml(r.submitted_by)} &bull; ${new Date(r.submitted_at).toLocaleDateString()}</span>
          </div>
          <div class="bug-description">${escHtml(r.description)}</div>
          ${r.app_version ? `<div class="bug-version">${escHtml(r.app_version)}</div>` : ''}
          <div class="bug-resolve-row">
            <label class="bug-resolve-label">
              <input type="checkbox" class="bug-resolve-check" data-id="${r.report_id}" ${r.resolved ? 'checked' : ''}>
              ${r.resolved ? `Resolved by ${escHtml(r.resolved_by || '')} on ${new Date(r.resolved_at).toLocaleDateString()}` : 'Mark resolved'}
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
  if (!currentUser || !isSupervisorLevel(currentUser.role)) return;
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
        <div class="user-avatar">${escHtml((u.initials || u.username.slice(0,2)).toUpperCase())}</div>
        <div class="user-info">
          <div class="user-name">${escHtml(u.full_name || u.username)}</div>
          <div class="user-sub">@${escHtml(u.username)}${u.is_active ? '' : ' · Inactive'}</div>
        </div>
        <span class="role-badge role-${escHtml(u.role)}">${formatRole(u.role)}</span>
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

  const _save = beginSave(el('user-modal-save'));
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
  } finally {
    _save();
  }
});

/* ── Charge Code Settings (admin/supervisor) ─────────────────────────────── */
let _editChargeCodeId = null, _editSplitId = null;

function ccsSwitchTab(tab) {
  el('ccs-tab-codes').style.display  = tab === 'codes'  ? '' : 'none';
  el('ccs-tab-splits').style.display = tab === 'splits' ? '' : 'none';
  el('ccs-tab-btn-codes').classList.toggle('active',  tab === 'codes');
  el('ccs-tab-btn-splits').classList.toggle('active', tab === 'splits');
}

async function initChargeCodesSettings() {
  ccsSwitchTab('codes');
  el('ccs-tab-btn-codes').onclick  = () => ccsSwitchTab('codes');
  el('ccs-tab-btn-splits').onclick = () => ccsSwitchTab('splits');
  await loadChargeCodeSettings();
}

async function loadChargeCodeSettings() {
  el('ccs-code-list').innerHTML  = '<div class="placeholder-msg">Loading…</div>';
  el('ccs-split-list').innerHTML = '<div class="placeholder-msg">Loading…</div>';
  let codes = [], splits = [];
  try {
    [codes, splits] = await Promise.all([
      api('GET', '/api/charge-codes?include_inactive=true'),
      api('GET', '/api/charge-code-splits?include_inactive=true'),
    ]);
  } catch {
    el('ccs-code-list').innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
    return;
  }
  renderCCSettingsCodes(codes);
  renderCCSettingsSplits(splits);
}

function renderCCSettingsCodes(codes) {
  const list = el('ccs-code-list');
  if (!codes.length) { list.innerHTML = '<div class="placeholder-msg">No charge codes yet.</div>'; return; }
  list.innerHTML = codes.map(c => `
    <div class="cc-item${c.status !== 'active' ? ' cc-item-inactive' : ''}">
      <span class="cc-item-code">${escHtml(c.code)}${c.status !== 'active' ? ' <span class="pest-inactive-badge">Inactive</span>' : ''}</span>
      <span class="cc-item-desc">${escHtml(c.description || '')}</span>
      <button class="btn btn-secondary btn-xs cc-edit-btn" data-id="${c.code_id}">Edit</button>
    </div>`).join('');
  list.querySelectorAll('.cc-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openChargeCodeModal(codes.find(c => c.code_id === parseInt(btn.dataset.id)))));
}

function renderCCSettingsSplits(splits) {
  const list = el('ccs-split-list');
  if (!splits.length) { list.innerHTML = '<div class="placeholder-msg">No split tools yet.</div>'; return; }
  list.innerHTML = splits.map(s => {
    const parts = (s.components || []).map(c => `${escHtml(c.code)} ${c.percent}%`).join(' · ');
    return `<div class="cc-item${s.status !== 'active' ? ' cc-item-inactive' : ''}" style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="cc-item-code">${escHtml(s.name)}${s.status !== 'active' ? ' <span class="pest-inactive-badge">Inactive</span>' : ''}</div>
        <div class="cc-item-desc" style="text-align:left">${parts}</div>
      </div>
      <button class="btn btn-secondary btn-xs cc-split-edit-btn" data-id="${s.split_id}">Edit</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.cc-split-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openSplitModal(splits.find(s => s.split_id === parseInt(btn.dataset.id)))));
}

// ── Charge code add/edit modal ──
el('ccs-add-code-btn').addEventListener('click', () => openChargeCodeModal(null));

function openChargeCodeModal(code) {
  _editChargeCodeId = code ? code.code_id : null;
  el('cc-code-modal-title').textContent = code ? 'Edit Code' : 'Add Code';
  el('ccm-code').value = code?.code || '';
  el('ccm-desc').value = code?.description || '';
  el('cc-code-modal-delete').style.display = code ? '' : 'none';
  clearError('ccm-error');
  el('cc-code-modal').classList.remove('hidden');
}
el('cc-code-modal-close').addEventListener('click',  () => el('cc-code-modal').classList.add('hidden'));
el('cc-code-modal-cancel').addEventListener('click', () => el('cc-code-modal').classList.add('hidden'));

el('cc-code-modal-save').addEventListener('click', async () => {
  clearError('ccm-error');
  const code = el('ccm-code').value.trim();
  const description = el('ccm-desc').value.trim();
  if (!code) return showError('ccm-error', 'Charge code is required');
  const _save = beginSave(el('cc-code-modal-save'));
  try {
    if (_editChargeCodeId) await api('PATCH', `/api/charge-codes/${_editChargeCodeId}`, { code, description });
    else await api('POST', '/api/charge-codes', { code, description });
    el('cc-code-modal').classList.add('hidden');
    showToast('Charge code saved', 'success');
    await loadChargeCodeSettings();
  } catch (err) {
    showError('ccm-error', err.message);
  } finally { _save(); }
});

el('cc-code-modal-delete').addEventListener('click', async () => {
  if (!_editChargeCodeId || !confirm('Delete this charge code?')) return;
  try {
    await api('DELETE', `/api/charge-codes/${_editChargeCodeId}`);
    el('cc-code-modal').classList.add('hidden');
    showToast('Charge code deleted', 'success');
    await loadChargeCodeSettings();
  } catch (err) { showError('ccm-error', err.message); }
});

// ── Split tool add/edit modal (dynamic component rows) ──
el('ccs-add-split-btn').addEventListener('click', () => openSplitModal(null));

function openSplitModal(split) {
  _editSplitId = split ? split.split_id : null;
  el('cc-split-modal-title').textContent = split ? 'Edit Split Tool' : 'Add Split Tool';
  el('csm-name').value = split?.name || '';
  el('csm-components').innerHTML = '';
  const comps = (split?.components && split.components.length) ? split.components : [{ code: '', percent: '' }, { code: '', percent: '' }];
  comps.forEach(c => addSplitComponentRow(c.code, c.percent));
  el('cc-split-modal-delete').style.display = split ? '' : 'none';
  clearError('csm-error');
  updateSplitTotal();
  el('cc-split-modal').classList.remove('hidden');
}

function addSplitComponentRow(code = '', percent = '') {
  const row = document.createElement('div');
  row.className = 'csm-comp-row';
  row.innerHTML = `
    <input type="text" class="ctrl-input csm-comp-code" placeholder="Code" value="${escHtml(String(code))}">
    <input type="number" class="ctrl-input csm-comp-pct" placeholder="%" min="0" step="1" value="${percent === '' ? '' : escHtml(String(percent))}">
    <button type="button" class="btn btn-secondary btn-xs csm-comp-remove">&times;</button>`;
  row.querySelector('.csm-comp-remove').addEventListener('click', () => { row.remove(); updateSplitTotal(); });
  row.querySelector('.csm-comp-pct').addEventListener('input', updateSplitTotal);
  el('csm-components').appendChild(row);
}

function readSplitComponents() {
  return [...el('csm-components').querySelectorAll('.csm-comp-row')].map(r => ({
    code: r.querySelector('.csm-comp-code').value.trim(),
    percent: parseFloat(r.querySelector('.csm-comp-pct').value),
  }));
}

function updateSplitTotal() {
  const sum = readSplitComponents().reduce((a, c) => a + (isNaN(c.percent) ? 0 : c.percent), 0);
  const totalEl = el('csm-total');
  totalEl.textContent = `Total: ${sum}%`;
  totalEl.classList.toggle('csm-total-ok', Math.abs(sum - 100) < 0.01);
}

el('csm-add-comp-btn').addEventListener('click', () => addSplitComponentRow());
el('cc-split-modal-close').addEventListener('click',  () => el('cc-split-modal').classList.add('hidden'));
el('cc-split-modal-cancel').addEventListener('click', () => el('cc-split-modal').classList.add('hidden'));

el('cc-split-modal-save').addEventListener('click', async () => {
  clearError('csm-error');
  const name = el('csm-name').value.trim();
  if (!name) return showError('csm-error', 'Name is required');
  const components = readSplitComponents();
  if (components.some(c => !c.code || isNaN(c.percent) || c.percent <= 0))
    return showError('csm-error', 'Every component needs a code and a positive percent');
  const sum = components.reduce((a, c) => a + c.percent, 0);
  if (Math.abs(sum - 100) > 0.01) return showError('csm-error', `Percentages must total 100% (currently ${sum}%)`);
  const _save = beginSave(el('cc-split-modal-save'));
  try {
    if (_editSplitId) await api('PATCH', `/api/charge-code-splits/${_editSplitId}`, { name, components });
    else await api('POST', '/api/charge-code-splits', { name, components });
    el('cc-split-modal').classList.add('hidden');
    showToast('Split tool saved', 'success');
    await loadChargeCodeSettings();
  } catch (err) {
    showError('csm-error', err.message);
  } finally { _save(); }
});

el('cc-split-modal-delete').addEventListener('click', async () => {
  if (!_editSplitId || !confirm('Delete this split tool?')) return;
  try {
    await api('DELETE', `/api/charge-code-splits/${_editSplitId}`);
    el('cc-split-modal').classList.add('hidden');
    showToast('Split tool deleted', 'success');
    await loadChargeCodeSettings();
  } catch (err) { showError('csm-error', err.message); }
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
        ? `<button class="btn btn-secondary btn-xs maint-hist-attach-btn" data-id="${r.maintenance_id}">${icon('attachments')} ${r.attachment_count} file${r.attachment_count > 1 ? 's' : ''}</button>` : '';
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
              ? `<span class="maint-att-pdf-icon">${icon('invoice', 28)}</span>`
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
              openAttachmentPreview(card.dataset.url, card.dataset.name, card.dataset.pdf === 'true');
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
  setPanelNav(el('screen-maintenance'), closePMType,
    'Maintenance Log - PM Records - ' + (PM_TYPES[pmType]?.title || pmType));
  initPMTypePanel(pmType);
}

function closePMType() {
  document.querySelectorAll('#maint-panel-pms .pm-panel').forEach(p => p.classList.add('hidden'));
  el('pm-main').classList.remove('hidden');
  setPanelNav(el('screen-maintenance'), closeMaintPanel, 'Maintenance Log - PM Records');
}

// .pm-back-btn buttons removed from HTML — navigation handled by setPanelNav()

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
    const _save = beginSave(submitBtn);
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
      _save();
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
      : '<div class="placeholder-msg">No pump positions at this plant.</div>';
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
    const _save = beginSave(submitBtn);
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
      _save();
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
    const _save = beginSave(submitBtn);
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
      _save();
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
    } else if (item.type === 'twc-area') {
      const cb  = checklistEl.querySelector(`input[data-key="${item.key}"][data-type="twc"]`);
      const txt = checklistEl.querySelector(`textarea[data-key="${item.key}"][data-type="twc-val"]`);
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
    if (!rows.length) { histEl.innerHTML = '<div class="placeholder-msg">No PM records yet.</div>'; return; }
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
    histEl.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── PM Record View Modal ──────────────────────────────────────────────────────
el('pm-view-modal-close').addEventListener('click', () => el('pm-view-modal').classList.add('hidden'));
el('pm-view-modal').addEventListener('click', e => {
  if (e.target === el('pm-view-modal')) el('pm-view-modal').classList.add('hidden');
});

function renderSBRecordView(record) {
  const entries = Object.entries(record.checklist);
  if (!entries.length) return '<div class="placeholder-msg">No checklist data.</div>';
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

/* ── Pesticides ──────────────────────────────────────────────────────────── */
let pestUsageLoaded   = false;
let pestLocationLoaded = false;
let pestReportLoaded  = false;
let pestProductsLoaded = false;
let pestReportMonth   = new Date().getMonth() + 1;
let pestReportYear    = new Date().getFullYear();
let pestLocationEditId = null;

const PEST_PANEL_NAMES = {
  usage:    'Usage Log',
  tasks:    'Treatment List',
  location: 'Application Location',
  reports:  'Monthly Report',
  products: 'Products',
};
function openPestPanel(panelId) {
  el('pest-main').classList.add('hidden');
  document.querySelectorAll('.maint-panel[id^="pest-panel-"]').forEach(p => p.classList.add('hidden'));
  el(`pest-panel-${panelId}`).classList.remove('hidden');
  setPanelNav(el('screen-pesticides'), closePestPanel,
    'Pesticides - ' + (PEST_PANEL_NAMES[panelId] || panelId));
  if (panelId === 'usage')    initPestUsagePanel();
  if (panelId === 'tasks')    initPestTasksPanel();
  if (panelId === 'location') initPestLocationPanel();
  if (panelId === 'reports')  initPestReportsPanel();
  if (panelId === 'products') initPestProductsPanel();
}

function closePestPanel() {
  document.querySelectorAll('.maint-panel[id^="pest-panel-"]').forEach(p => p.classList.add('hidden'));
  el('pest-main').classList.remove('hidden');
  setPanelNav(el('screen-pesticides'), () => showScreen('dashboard'), 'Pesticides');
}

function initPesticideScreen() {
  closePestPanel();
}

// Sub-tile click
document.querySelectorAll('[data-pest-panel]').forEach(btn => {
  btn.addEventListener('click', () => openPestPanel(btn.dataset.pestPanel));
});

// .maint-back-btn buttons inside pest panels removed from HTML — navigation handled by setPanelNav()

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
  const _save = beginSave(el('pest-usage-save-btn'));
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
  } finally {
    _save();
  }
});

async function loadPestUsageList() {
  const list = el('pest-usage-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/pesticide-usage');
    if (!rows.length) { list.innerHTML = '<div class="placeholder-msg">No usage entries yet.</div>'; return; }
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
    list.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Treatment List Panel ──────────────────────────────────────────────────────
// A shared spray/bait checklist. Anyone can add a one-line task; checking it off
// hides it from the active list (kept for history). Records who added it and who
// checked it off.
function initPestTasksPanel() {
  // Reset history view each time the panel is opened
  el('pest-task-history').classList.add('hidden');
  el('pest-task-history').innerHTML = '';
  el('pest-task-history-btn').textContent = 'Show completed history';
  loadPestTaskList();
}

async function loadPestTaskList() {
  const list = el('pest-task-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const tasks = await api('GET', '/api/pest-tasks');
    if (!tasks.length) {
      list.innerHTML = '<div class="placeholder-msg">No active tasks. Add one above.</div>';
      return;
    }
    list.innerHTML = tasks.map(t => `
      <div class="pest-task-item" data-id="${t.task_id}">
        <input type="checkbox" class="pest-task-check" title="Mark as done">
        <div class="pest-task-body">
          <div class="pest-task-text">${escHtml(t.description)}</div>
          <div class="pest-task-meta">Added by ${escHtml(t.created_by || 'Unknown')} · ${localDateStr(t.created_at, { month: 'short', day: 'numeric' })}</div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.pest-task-check').forEach(cb => {
      cb.addEventListener('change', async e => {
        const row = e.currentTarget.closest('.pest-task-item');
        const id  = row.dataset.id;
        e.currentTarget.disabled = true;
        try {
          await api('PATCH', `/api/pest-tasks/${id}`, { done: true });
          row.remove();
          if (!list.querySelector('.pest-task-item')) {
            list.innerHTML = '<div class="placeholder-msg">No active tasks. Add one above.</div>';
          }
          // Refresh history if it's currently visible
          if (!el('pest-task-history').classList.contains('hidden')) loadPestTaskHistory();
        } catch (err) {
          e.currentTarget.checked = false;
          e.currentTarget.disabled = false;
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

async function addPestTask() {
  const input = el('pest-task-input');
  const description = input.value.trim();
  if (!description) return;
  const btn = el('pest-task-add-btn');
  btn.disabled = true;
  try {
    await api('POST', '/api/pest-tasks', { description });
    input.value = '';
    await loadPestTaskList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

async function loadPestTaskHistory() {
  const box = el('pest-task-history');
  box.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const tasks = await api('GET', '/api/pest-tasks?history=1');
    if (!tasks.length) {
      box.innerHTML = '<div class="pest-task-history-title">Completed</div><div class="placeholder-msg">Nothing completed yet.</div>';
      return;
    }
    box.innerHTML = '<div class="pest-task-history-title">Completed</div>' + tasks.map(t => `
      <div class="pest-task-item">
        <div class="pest-task-body">
          <div class="pest-task-text">${escHtml(t.description)}</div>
          <div class="pest-task-meta">Done by ${escHtml(t.done_by || 'Unknown')} · ${t.done_at ? localDateStr(t.done_at, { month: 'short', day: 'numeric', year: 'numeric' }) : ''} · added by ${escHtml(t.created_by || 'Unknown')}</div>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

el('pest-task-add-btn').addEventListener('click', addPestTask);
el('pest-task-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addPestTask(); }
});
el('pest-task-history-btn').addEventListener('click', () => {
  const box = el('pest-task-history');
  const showing = !box.classList.contains('hidden');
  if (showing) {
    box.classList.add('hidden');
    el('pest-task-history-btn').textContent = 'Show completed history';
  } else {
    box.classList.remove('hidden');
    el('pest-task-history-btn').textContent = 'Hide completed history';
    loadPestTaskHistory();
  }
});

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
    if (!rows.length) { list.innerHTML = '<div class="placeholder-msg">No usage entries yet.</div>'; return; }
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
    list.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
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
  const _save = beginSave(el('pest-location-save-btn'));
  try {
    await api('PATCH', `/api/pesticide-usage/${pestLocationEditId}`, { location_description, notes });
    el('pest-location-modal').classList.add('hidden');
    pestLocationLoaded = false;
    await loadPestLocationList();
    pestLocationLoaded = true;
    showToast('Location saved');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    _save();
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
      out.innerHTML = '<div class="placeholder-msg">No usage recorded for this month.</div>';
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
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
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
  const _save = beginSave(el('pest-product-save-btn'));
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
  } finally {
    _save();
  }
});

async function loadPestProductList() {
  const list = el('pest-product-list');
  list.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const products = await api('GET', '/api/pesticides');
    if (!products.length) { list.innerHTML = '<div class="placeholder-msg">No products added yet.</div>'; return; }
    const isSupervisor = currentUser && isSupervisorLevel(currentUser.role);
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
    list.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
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
const ALL_REPORT_PANELS = ['vehicles','kf','maintenance','pms','piezometers','canal','ponds','wells'];

function initReportsScreen() {
  el('report-main').classList.remove('hidden');
  ALL_REPORT_PANELS.forEach(c => el(`report-panel-${c}`).classList.add('hidden'));
}

const REPORT_PANEL_NAMES = {
  vehicles:     'Vehicles',
  kf:           'KF Monthly',
  maintenance:  'Maintenance Issues',
  pms:          'PM Records',
  piezometers:  'Piezometers',
  canal:        'Canal Readings',
  ponds:        'Pond Report',
  wells:        'Well Readings',
};
function openReportPanel(cat) {
  el('report-main').classList.add('hidden');
  ALL_REPORT_PANELS.forEach(c => el(`report-panel-${c}`).classList.add('hidden'));
  el(`report-panel-${cat}`).classList.remove('hidden');
  setPanelNav(el('screen-reports'), closeReportPanel,
    'Reports - ' + (REPORT_PANEL_NAMES[cat] || cat));
  if (cat === 'vehicles')    initVehicleReportPanel();
  if (cat === 'kf')          initKFReportPanel();
  if (cat === 'maintenance') initMaintenanceReportPanel();
  if (cat === 'pms')         initPMReportPanel();
  if (cat === 'piezometers') initPiezReportPanel();
  if (cat === 'canal')       initCanalReportPanel();
  if (cat === 'ponds')       initPondsReportPanel();
  if (cat === 'wells')       initWellReportPanel();
}

function closeReportPanel() {
  ALL_REPORT_PANELS.forEach(c => el(`report-panel-${c}`).classList.add('hidden'));
  el('report-main').classList.remove('hidden');
  setPanelNav(el('screen-reports'), () => showScreen('dashboard'), 'Reports');
}

el('screen-reports').addEventListener('click', e => {
  const tile = e.target.closest('[data-report-cat]');
  if (tile) openReportPanel(tile.dataset.reportCat);
});
// report-*-back buttons removed from HTML — navigation handled by setPanelNav()

// ── Vehicles Panel ────────────────────────────────────────────────────────────
function updateReportsMonthLabel() {
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  el('report-month-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function initVehicleReportPanel() {
  updateReportsMonthLabel();
  // Default the Compare pickers to last month → this month (only on first open).
  if (!el('vehicle-cmp-m2').value) {
    const now  = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    el('vehicle-cmp-m1').value = ym(prev);
    el('vehicle-cmp-m2').value = ym(now);
  }
  runVehicleReport();
}

async function runVehicleReport() {
  const isCompare = vehicleReportType === 'compare';
  el('report-export-btn').style.display = vehicleReportType === 'mileage' ? '' : 'none';
  // The single-month nav is used by CVC Mileage / Last Service; Compare uses
  // its own two-month picker.
  document.querySelector('#report-panel-vehicles .report-month-nav:not(#vehicle-compare-nav)')
    .style.display = isCompare ? 'none' : '';
  el('vehicle-compare-nav').style.display = isCompare ? '' : 'none';
  if (vehicleReportType === 'mileage')      await renderMileageReport();
  else if (vehicleReportType === 'service') await renderVehicleServiceReport();
  else                                       await renderVehicleCompareReport();
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

// ── Compare report ──────────────────────────────────────────────────────────
el('vehicle-cmp-m1').addEventListener('change', runVehicleReport);
el('vehicle-cmp-m2').addEventListener('change', runVehicleReport);

// "YYYY-MM" → { year, month } (month 1-12)
function parseYearMonth(v) {
  if (!v) return null;
  const [y, m] = v.split('-').map(Number);
  return { year: y, month: m };
}

function buildCompareHTML(rows1, rows2, ym1, ym2) {
  const label = ym => new Date(ym.year, ym.month - 1, 1)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const m1Label = label(ym1), m2Label = label(ym2);

  // Index second-month readings by vehicle for quick lookup, then merge so the
  // row list always mirrors the (active) vehicle set from the first query.
  const byId2 = {};
  rows2.forEach(r => { byId2[r.vehicle_id] = r; });
  const merged = rows1.map(a => {
    const b = byId2[a.vehicle_id] || {};
    return {
      ...a,
      odo1: a.odometer_miles, odo2: b.odometer_miles,
      hrs1: a.engine_hours,   hrs2: b.engine_hours,
    };
  });

  const trucks = merged.filter(r => !r.reading_type || r.reading_type === 'odometer');
  const heavy  = merged.filter(r => r.reading_type === 'hours' || r.reading_type === 'both');
  const ac = v => (v.assigned_user && v.assigned_user.trim().toLowerCase() !== 'ops & maint') ? v.assigned_user : '';
  const num  = (v, dec = 0) => v != null ? Number(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—';
  const dash = '<span style="color:var(--text-dim)">—</span>';

  // Difference cell: 2nd − 1st. Red when negative.
  const diffCell = (a, b, dec = 0) => {
    if (a == null || b == null) return `<td class="report-num">${dash}</td>`;
    const d = Number(b) - Number(a);
    const color = d < 0 ? 'var(--red-light)' : '';
    const sign = d > 0 ? '+' : '';
    return `<td class="report-num" style="${color ? `color:${color};font-weight:600` : ''}">${sign}${d.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</td>`;
  };

  const truckRows = trucks.map(v => `<tr>
    <td>${v.vehicle_number||''}</td><td>${v.make||''}</td><td>${v.model||''}</td><td>${ac(v)}</td>
    <td class="report-num">${num(v.odo1)}</td>
    <td class="report-num">${num(v.odo2)}</td>
    ${diffCell(v.odo1, v.odo2)}
  </tr>`).join('');

  const heavyRows = heavy.map(v => `<tr>
    <td>${v.vehicle_number||''}</td><td>${v.make||''}</td><td>${v.model||''}</td><td>${ac(v)}</td>
    <td class="report-num">${num(v.odo1)}</td>
    <td class="report-num">${num(v.odo2)}</td>
    <td class="report-num">${num(v.hrs1, 1)}</td>
    <td class="report-num">${num(v.hrs2, 1)}</td>
    ${diffCell(v.hrs1, v.hrs2, 1)}
  </tr>`).join('');

  return `
    <div class="report-title">Compare</div>
    <div class="report-subtitle">${m1Label} → ${m2Label}</div>
    <div class="report-section-title">Trucks</div>
    ${trucks.length ? `<table class="report-table trucks">
      <thead><tr>
        <th>Unit #</th><th>Make</th><th>Model</th><th>Operator</th>
        <th class="report-num">${m1Label} Odo</th><th class="report-num">${m2Label} Odo</th>
        <th class="report-num">Difference</th>
      </tr></thead>
      <tbody>${truckRows}</tbody></table>`
    : '<div class="report-empty">No active trucks.</div>'}
    <div class="report-section-title">Heavy Equipment</div>
    ${heavy.length ? `<table class="report-table heavy">
      <thead><tr>
        <th>Unit #</th><th>Make</th><th>Model</th><th>Operator</th>
        <th class="report-num">${m1Label} Odo</th><th class="report-num">${m2Label} Odo</th>
        <th class="report-num">${m1Label} Hrs</th><th class="report-num">${m2Label} Hrs</th>
        <th class="report-num">Difference</th>
      </tr></thead>
      <tbody>${heavyRows}</tbody></table>`
    : '<div class="report-empty">No active heavy equipment.</div>'}`;
}

async function renderVehicleCompareReport() {
  const out = el('report-output');
  const ym1 = parseYearMonth(el('vehicle-cmp-m1').value);
  const ym2 = parseYearMonth(el('vehicle-cmp-m2').value);
  if (!ym1 || !ym2) {
    out.innerHTML = '<div class="placeholder-msg">Select two months to compare.</div>';
    return;
  }
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const [rows1, rows2] = await Promise.all([
      api('GET', `/api/reports/mileage?year=${ym1.year}&month=${ym1.month}`),
      api('GET', `/api/reports/mileage?year=${ym2.year}&month=${ym2.month}`),
    ]);
    out.innerHTML = `<div class="report-card">${buildCompareHTML(rows1, rows2, ym1, ym2)}</div>`;
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
  // Always land on the Open Issues tab
  maintReportType = 'open';
  document.querySelectorAll('#maint-report-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.val === 'open'));
  el('maint-open-output').style.display   = '';
  el('maint-lookup-output').style.display = 'none';
  renderMaintenanceIssuesReport();
}

// ── Maintenance report tab switching ───────────────────────────────────────
let maintReportType = 'open';
document.querySelectorAll('#maint-report-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#maint-report-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    maintReportType = btn.dataset.val;
    const lookup = maintReportType === 'lookup';
    el('maint-open-output').style.display   = lookup ? 'none' : '';
    el('maint-lookup-output').style.display = lookup ? '' : 'none';
    if (lookup) ensureIssuesLoaded();
  });
});

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

// ── Issue Look-Up ───────────────────────────────────────────────────────────
// Search any well/building/equipment by name and view its full issue history
// (open + resolved). Data is loaded once and searched instantly client-side.
let _issuesAllCache = null;   // raw issue rows from the server
let _issueSubjects  = [];     // de-duplicated subjects [{ key, type, name, category, detail, total, open }]
let _issueSuggestActive = -1; // highlighted suggestion index for keyboard nav

const issueSubjectKey = r => `${r.subject_type}|${r.subject_id}`;

async function ensureIssuesLoaded() {
  if (_issuesAllCache) return;
  const results = el('issue-lookup-results');
  results.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    _issuesAllCache = await api('GET', '/api/reports/issues-all');
    // Build de-duplicated subject list with issue counts
    const map = new Map();
    _issuesAllCache.forEach(r => {
      const key = issueSubjectKey(r);
      let s = map.get(key);
      if (!s) {
        s = { key, type: r.subject_type, name: r.subject_name,
              category: r.category, detail: r.subject_detail, total: 0, open: 0 };
        map.set(key, s);
      }
      s.total++;
      if (r.status === 'open' || r.status === 'in_progress') s.open++;
    });
    _issueSubjects = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    results.innerHTML = '<div class="placeholder-msg">Search for a piece of equipment to see its issue history.</div>';
  } catch (err) {
    _issuesAllCache = null;
    results.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

function renderIssueSuggestions(query) {
  const box = el('issue-lookup-suggest');
  const q = query.trim().toLowerCase();
  _issueSuggestActive = -1;
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  // Match on name; rank exact-prefix matches first, then alphabetical
  const matches = _issueSubjects
    .filter(s => s.name.toLowerCase().includes(q) || (s.detail || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, 12);

  if (!matches.length) {
    box.innerHTML = '<div class="issue-lookup-suggest-empty">No matching equipment with issues.</div>';
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML = matches.map(s => `
    <div class="issue-lookup-suggest-item" data-key="${escHtml(s.key)}">
      <span class="issue-lookup-suggest-name">${escHtml(s.name)}</span>
      <span class="issue-lookup-suggest-cat">${escHtml(s.category)}</span>
      <span class="issue-lookup-suggest-count">${s.total} issue${s.total === 1 ? '' : 's'}</span>
    </div>`).join('');
  box.classList.remove('hidden');
}

function selectIssueSubject(key) {
  const subject = _issueSubjects.find(s => s.key === key);
  if (!subject) return;
  el('issue-lookup-search').value = subject.name;
  el('issue-lookup-suggest').classList.add('hidden');
  renderIssueHistory(subject);
}

function renderIssueHistory(subject) {
  const out = el('issue-lookup-results');
  const issues = _issuesAllCache
    .filter(r => issueSubjectKey(r) === subject.key)
    .sort((a, b) => (b.reported_date || '').localeCompare(a.reported_date || ''));

  const pillCls = st => st === 'in_progress' ? 'in-progress'
    : (st === 'resolved' || st === 'closed') ? 'resolved' : 'open';
  const money = c => (c != null && c !== '') ? `$${Number(c).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  const fmtD = d => d ? localDateStr(d, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  let html = `<div class="report-card">
    <div class="issue-lookup-subject-head">
      <span class="issue-lookup-subject-name">${escHtml(subject.name)}</span>
      <span class="issue-lookup-subject-meta">${escHtml(subject.category)}${subject.detail ? ' · ' + escHtml(subject.detail) : ''}</span>
      <span class="issue-lookup-subject-meta">${subject.total} total · ${subject.open} open</span>
    </div>`;

  issues.forEach(r => {
    const meta = [];
    if (r.assigned_to) meta.push(`Assigned: ${escHtml(r.assigned_to)}`);
    if (r.po_number)   meta.push(`PO: ${escHtml(r.po_number)}`);
    const m = money(r.cost); if (m) meta.push(`Cost: ${m}`);
    if (r.resolved_date) meta.push(`Resolved: ${fmtD(r.resolved_date)}`);
    html += `<div class="maint-issue-report-row">
      <div class="maint-issue-report-header">
        <span class="status-pill ${pillCls(r.status)}">${escHtml((r.status || '').replace('_', ' '))}</span>
        <span class="maint-issue-report-name">${escHtml(r.description ? '' : 'Issue')}</span>
        <span class="maint-issue-report-date">${fmtD(r.reported_date)}</span>
      </div>
      ${r.description     ? `<div class="maint-issue-report-desc">${escHtml(r.description)}</div>` : ''}
      ${r.action_taken    ? `<div class="maint-issue-report-action">Action: ${escHtml(r.action_taken)}</div>` : ''}
      ${r.resolution_notes? `<div class="maint-issue-report-action">Resolution: ${escHtml(r.resolution_notes)}</div>` : ''}
      ${meta.length       ? `<div class="maint-issue-report-meta">${meta.join(' · ')}</div>` : ''}
    </div>`;
  });

  if (!issues.length) html += '<div class="report-empty">No issues found.</div>';
  html += '</div>';
  out.innerHTML = html;
}

// Wire the search input + suggestion dropdown
(function () {
  const input = el('issue-lookup-search');
  const box   = el('issue-lookup-suggest');
  if (!input) return;

  input.addEventListener('input', () => renderIssueSuggestions(input.value));
  input.addEventListener('focus', () => { if (input.value.trim()) renderIssueSuggestions(input.value); });

  input.addEventListener('keydown', e => {
    const items = [...box.querySelectorAll('.issue-lookup-suggest-item')];
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      _issueSuggestActive = Math.min(_issueSuggestActive + 1, items.length - 1);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      _issueSuggestActive = Math.max(_issueSuggestActive - 1, 0);
    } else if (e.key === 'Enter') {
      const pick = items[_issueSuggestActive] || items[0];
      if (pick) { e.preventDefault(); selectIssueSubject(pick.dataset.key); }
      return;
    } else if (e.key === 'Escape') {
      box.classList.add('hidden');
      return;
    } else {
      return;
    }
    items.forEach((it, i) => it.classList.toggle('active', i === _issueSuggestActive));
    if (items[_issueSuggestActive]) items[_issueSuggestActive].scrollIntoView({ block: 'nearest' });
  });

  box.addEventListener('click', e => {
    const item = e.target.closest('.issue-lookup-suggest-item');
    if (item) selectIssueSubject(item.dataset.key);
  });

  // Close the dropdown when clicking outside the search area
  document.addEventListener('click', e => {
    if (!e.target.closest('.issue-lookup-search-wrap')) box.classList.add('hidden');
  });
})();

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
      sbRows += `<td><button class="pmgrid-hist-btn" data-pm-type="siphon_breaker" data-pm-building="${escHtml(plant.name)}" data-pm-label="PP ${escHtml(plant.num)} Siphon Breakers" title="View history">${icon('pm-records')}</button></td></tr>`;
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
      acRows += `<td><button class="pmgrid-hist-btn" data-pm-type="air_compressor" data-pm-building="${escHtml(plant.name)}" data-pm-label="PP ${escHtml(plant.num)} Air Compressors" title="View history">${icon('pm-records')}</button></td>`;
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
      body.innerHTML = '<div class="placeholder-msg">No records for this plant yet.</div>';
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
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Canal Readings Report Panel ────────────────────────────────────────────────
function initCanalReportPanel() {
  if (!el('canal-report-start-date').value) {
    el('canal-report-start-date').value = todayISO();
    el('canal-report-end-date').value   = todayISO();
  }
  renderCanalReport();
}

el('canal-report-start-date').addEventListener('change', renderCanalReport);
el('canal-report-end-date').addEventListener('change',   renderCanalReport);

async function renderCanalReport() {
  const start = el('canal-report-start-date').value;
  const end   = el('canal-report-end-date').value;
  if (!start || !end) return;
  const out = el('report-canal-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', `/api/reports/canal?start_date=${start}&end_date=${end}`);
    if (!rows.length) {
      out.innerHTML = '<div class="placeholder-msg">No canal readings found.</div>';
      return;
    }

    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const fmtNum  = (v, dec = 2) => v != null ? Number(v).toFixed(dec) : '—';

    // Group by date
    const byDate = {};
    rows.forEach(r => {
      const d = r.reading_date?.slice(0, 10) || 'Unknown';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    });

    let html = `<div class="report-card">
      <div class="report-title">Canal Readings</div>
      <div class="report-subtitle">${fmtDate(start)}${start !== end ? ' – ' + fmtDate(end) : ''}</div>`;

    Object.keys(byDate).sort().forEach(date => {
      const readings = byDate[date];
      html += `<div class="report-section-title">${fmtDate(date)}</div>
        <table class="report-table">
          <thead><tr>
            <th>Structure</th>
            <th class="report-num">Flow (cfs)</th>
            <th class="report-num">Totalizer (af)</th>
            <th class="report-num">Gate</th>
            <th class="report-num">Head (ft)</th>
            <th>By</th>
          </tr></thead>
          <tbody>`;
      readings.forEach(r => {
        html += `<tr>
          <td>${escHtml(r.structure_name)}</td>
          <td class="report-num">${fmtNum(r.instantaneous_flow_cfs)}</td>
          <td class="report-num">${fmtNum(r.totalizer_reading_af)}</td>
          <td class="report-num">${fmtNum(r.gate_setting)}</td>
          <td class="report-num">${fmtNum(r.head_reading_ft)}</td>
          <td>${escHtml(r.entered_by || '—')}</td>
        </tr>`;
        if (r.notes) html += `<tr><td colspan="6" style="color:var(--text-dim);font-size:0.82rem;padding:2px 4px 6px">↳ ${escHtml(r.notes)}</td></tr>`;
      });
      html += '</tbody></table>';
    });

    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

// ── Pond Report Panel ─────────────────────────────────────────────────────────
let pondsReportInitialized = false;

function pondsReportActiveTab() {
  return el('ponds-report-seg').querySelector('.seg-btn.active')?.dataset.val || 'gauges';
}

function renderPondsActiveTab() {
  if (pondsReportActiveTab() === 'gauges') renderPondsReport();
  else renderPondGateReport();
}

function initPondsReportPanel() {
  el('ponds-report-date').value = todayISO();

  if (!pondsReportInitialized) {
    pondsReportInitialized = true;

    el('ponds-report-seg').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      el('ponds-report-seg').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPondsActiveTab();
    });

    el('ponds-report-prev').addEventListener('click', () => wellStepDate('ponds-report-date', -1, renderPondsActiveTab));
    el('ponds-report-next').addEventListener('click', () => wellStepDate('ponds-report-date', 1, renderPondsActiveTab));
    el('ponds-report-today').addEventListener('click', () => { el('ponds-report-date').value = todayISO(); renderPondsActiveTab(); });
    el('ponds-report-date').addEventListener('change', renderPondsActiveTab);

    el('ponds-report-print-btn').addEventListener('click', async () => {
      const card = el('report-ponds-output').querySelector('.report-card');
      if (!card) return showToast('No report to export', 'error');
      const btn = el('ponds-report-print-btn');
      btn.disabled = true;
      try {
        const date = el('ponds-report-date').value || todayISO();
        await sharePdfFromHtml(card.outerHTML, REPORT_PDF_CSS, `Ponds_Report_${date}`, 'Ponds Report');
      } catch (err) {
        if (err.name !== 'AbortError') showToast('Export failed: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // Reset to gauges tab on re-open
    el('ponds-report-seg').querySelectorAll('.seg-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  }

  renderPondsReport();
}

async function renderPondsReport() {
  const date = el('ponds-report-date').value;
  if (!date) return;
  const out = el('report-ponds-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const { gauges } = await api('GET', `/api/reports/ponds?date=${date}`);
    const fmtNum  = (v, dec = 2) => v != null ? Number(v).toFixed(dec) : '—';
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const fmtTime = t => t ? t.slice(0, 5) : '—';

    let html = `<div class="report-card">
      <div class="report-title">Pond Report</div>
      <div class="report-subtitle">${fmtDate(date)}</div>
      <div class="report-section-title">Staff Gauges</div>
      <table class="report-table">
        <thead><tr>
          <th>Location</th><th>Pond</th>
          <th class="report-num">Level (ft)</th>
          <th>Time</th><th>By</th>
        </tr></thead><tbody>`;

    let lastLoc = '';
    gauges.forEach(g => {
      const locLabel = g.location_name !== lastLoc ? escHtml(g.location_name) : '';
      lastLoc = g.location_name;
      const level = g.level_ft != null
        ? `<strong>${fmtNum(g.level_ft)}</strong>`
        : `<span style="color:var(--text-dim)">—</span>`;
      html += `<tr>
        <td>${locLabel}</td>
        <td>${escHtml(g.pond_name)}</td>
        <td class="report-num">${level}</td>
        <td>${fmtTime(g.reading_time)}</td>
        <td>${escHtml(g.entered_by || '—')}</td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

async function renderPondGateReport() {
  const date = el('ponds-report-date').value;
  if (!date) return;
  const out = el('report-ponds-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', `/api/reports/ponds/gates?date=${date}`);
    const fmtNum  = (v, dec=2) => v != null ? Number(v).toFixed(dec) : '—';
    const fmtTime = t => t ? String(t).slice(0,5) : '';

    // Build hierarchy: locations → ponds → connections → gates
    const locOrder = [], locMap = {};
    rows.forEach(r => {
      if (!locMap[r.location_id]) {
        locMap[r.location_id] = { name: r.location_name, sort: r.location_sort, ponds: {}, pondOrder: [] };
        locOrder.push(r.location_id);
      }
      const loc = locMap[r.location_id];
      if (r.pond_id && !loc.ponds[r.pond_id]) {
        loc.ponds[r.pond_id] = {
          name: r.pond_name, sort: r.pond_sort,
          gauge_level: r.gauge_level, gauge_time: r.gauge_time,
          connections: {}, connOrder: [],
        };
        loc.pondOrder.push(r.pond_id);
      }
      if (!r.connection_id) return;
      const pond = loc.ponds[r.pond_id];
      if (!pond.connections[r.connection_id]) {
        pond.connections[r.connection_id] = { name: r.connection_name, sort: r.connection_sort, gates: [] };
        pond.connOrder.push(r.connection_id);
      }
      if (!r.gate_id) return;
      pond.connections[r.connection_id].gates.push({
        gate_id: r.gate_id, label: r.gate_label, width_in: r.width_in,
        head_ft: r.head_ft, opening_in: r.opening_in, overpour_in: r.overpour_in,
        flow_cfs: r.flow_cfs, notes: r.gate_notes,
      });
    });

    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    let html = `<div class="report-card">
      <div class="report-title">Pond Gate Readings</div>
      <div class="report-subtitle">${fmtDate(date)}</div>`;

    locOrder.forEach(lid => {
      const loc = locMap[lid];
      html += `<div class="report-section-title" style="margin-top:14px">${escHtml(loc.name)}</div>`;

      loc.pondOrder.forEach(pid => {
        const pond = loc.ponds[pid];
        const gaugeStr = pond.gauge_level != null
          ? `<span style="font-weight:600">${fmtNum(pond.gauge_level)} ft</span>${pond.gauge_time ? ` <span style="color:var(--text-dim);font-size:0.8rem">@ ${fmtTime(pond.gauge_time)}</span>` : ''}`
          : `<span style="color:var(--text-dim)">no gauge reading</span>`;

        html += `<div style="margin:8px 0 2px;font-weight:600;font-size:0.9rem">
          ${escHtml(pond.name)} — Gauge: ${gaugeStr}
        </div>`;

        if (pond.connOrder.length === 0) {
          html += `<div style="color:var(--text-dim);font-size:0.82rem;padding-left:8px;margin-bottom:4px">No connections configured</div>`;
          return;
        }

        pond.connOrder.forEach(cid => {
          const conn = pond.connections[cid];
          html += `<div style="font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-dim);margin:6px 0 2px 8px">${escHtml(conn.name)}</div>`;

          if (conn.gates.length === 0) {
            html += `<div style="color:var(--text-dim);font-size:0.82rem;padding-left:8px;margin-bottom:4px">No gates configured</div>`;
            return;
          }

          html += `<table class="report-table" style="margin-left:8px;margin-bottom:4px">
            <thead><tr>
              <th>Gate</th>
              <th class="report-num">Width (in)</th>
              <th class="report-num">Head (ft)</th>
              <th class="report-num">Opening (in)</th>
              <th class="report-num">Overpour (in)</th>
              <th class="report-num">Flow (cfs)</th>
              <th>Notes</th>
            </tr></thead><tbody>`;

          conn.gates.forEach(g => {
            const hasReading = g.head_ft != null || g.opening_in != null || g.flow_cfs != null;
            const rowStyle = hasReading ? '' : ' style="opacity:0.5"';
            html += `<tr${rowStyle}>
              <td>${escHtml(g.label || '—')}</td>
              <td class="report-num">${g.width_in != null ? g.width_in : '—'}</td>
              <td class="report-num">${fmtNum(g.head_ft)}</td>
              <td class="report-num">${fmtNum(g.opening_in)}</td>
              <td class="report-num">${g.overpour_in != null ? fmtNum(g.overpour_in) : '—'}</td>
              <td class="report-num">${fmtNum(g.flow_cfs)}</td>
              <td>${escHtml(g.notes || '')}</td>
            </tr>`;
          });

          // Connection flow total (sum of gates with readings)
          const totalCfs = conn.gates.reduce((s, g) => s + (g.flow_cfs != null ? Number(g.flow_cfs) : 0), 0);
          const hasAny = conn.gates.some(g => g.flow_cfs != null);
          if (hasAny) {
            html += `<tr style="font-weight:700;border-top:1.5px solid var(--border)">
              <td colspan="5" style="text-align:right;font-size:0.82rem;color:var(--text-dim)">Connection Total:</td>
              <td class="report-num">${totalCfs.toFixed(2)}</td>
              <td></td>
            </tr>`;
          }

          html += '</tbody></table>';
        });
      });
    });

    if (locOrder.length === 0) html += '<div class="placeholder-msg">No pond locations configured.</div>';
    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

/* ── Export Modal ────────────────────────────────────────────────────────── */
let exportContext = 'vehicles'; // 'vehicles' | 'piezometers-status' | 'piezometers-compare' | 'wells-daily'

el('report-export-btn').addEventListener('click', () => {
  if (!lastReportRows.length) return showToast('No report data to export', 'error');
  exportContext = 'vehicles';
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  el('export-modal-subtitle').textContent = `CVC Mileage — ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
  el('export-modal').classList.remove('hidden');
});

el('piez-export-btn').addEventListener('click', () => {
  if (piezRepType === 'status') {
    if (!lastPiezStatusRows.length) return showToast('No report data to export', 'error');
    exportContext = 'piezometers-status';
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    el('export-modal-subtitle').textContent = `Piezometers — ${fmtDate(piezRepStart)} to ${fmtDate(piezRepEnd)}`;
  } else {
    if (!lastPiezCompareRows1.length) return showToast('No report data to export', 'error');
    exportContext = 'piezometers-compare';
    el('export-modal-subtitle').textContent = `Piezometer Comparison`;
  }
  el('export-modal').classList.remove('hidden');
});

el('export-modal-close').addEventListener('click', () => el('export-modal').classList.add('hidden'));
el('export-modal').addEventListener('click', e => {
  if (e.target === el('export-modal')) el('export-modal').classList.add('hidden');
});


el('export-csv-btn').addEventListener('click', async () => {
  el('export-modal').classList.add('hidden');

  if (exportContext === 'piezometers-status') {
    const csvEsc = v => (v == null || v === '') ? '' : /[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
    const lines = [`Piezometer Readings,${piezRepStart} to ${piezRepEnd}`, '', 'Pool,Name,DTW (ft),Method,Operator,Date'];
    lastPiezStatusRows.forEach(p => {
      const method = [p.plopper_sounder, p.wet_dry_moist].filter(Boolean).join(' / ');
      lines.push([p.pool||'', p.piezometer_name, p.dtw_reading??'', method, p.operator||'', p.reading_date?.slice(0,10)||''].map(csvEsc).join(','));
    });
    await shareFile(new Blob([lines.join('\r\n')], { type: 'text/csv' }), `Piezometers_${piezRepStart}_${piezRepEnd}.csv`, 'Piezometer Readings');
    return;
  }

  if (exportContext === 'piezometers-compare') {
    const s1 = el('piez-cmp-start1').value, e1 = el('piez-cmp-end1').value;
    const s2 = el('piez-cmp-start2').value, e2 = el('piez-cmp-end2').value;
    const map2 = new Map(lastPiezCompareRows2.map(r => [r.piezometer_id, r]));
    const lines = [`Piezometer Comparison,${s1}–${e1} vs ${s2}–${e2}`, '', `Pool,Name,DTW 1,DTW 2,Difference`];
    lastPiezCompareRows1.forEach(p => {
      const r2 = map2.get(p.piezometer_id);
      const d1 = p.dtw_reading != null ? Number(p.dtw_reading) : '';
      const d2 = r2?.dtw_reading != null ? Number(r2.dtw_reading) : '';
      const diff = d1 !== '' && d2 !== '' ? (d2 - d1).toFixed(2) : '';
      lines.push([p.pool||'', p.piezometer_name, d1, d2, diff].join(','));
    });
    await shareFile(new Blob([lines.join('\r\n')], { type: 'text/csv' }), `Piezometers_Compare_${s1}_${s2}.csv`, 'Piezometer Comparison');
    return;
  }

  if (exportContext === 'wells-daily') {
    const csvEsc = v => (v == null || v === '') ? '' : /[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
    const date = el('well-report-date').value;
    const lines = [`Well Readings,${date}`, '', 'Area,Well,Time,On/Off,Flow (cfs),Totalizer (AF),Calc. cfs,Dripper Oil (gal),Motor Oil,kWh,Notes'];
    lastWellDailyRows.forEach(r => {
      lines.push([
        r.area||'', r.common_name, r.reading_time ? String(r.reading_time).slice(0,5) : '',
        r.on_off||'', r.flow_cfs??'', r.totalizer??'', r.totalizer_calc??'',
        r.dripper_oil??'', r.motor_oil??'', r.pge_kwh??'', r.notes||'',
      ].map(csvEsc).join(','));
    });
    await shareFile(new Blob([lines.join('\r\n')], { type: 'text/csv' }), `WellReadings_${date}.csv`, 'Well Readings');
    return;
  }

  if (exportContext === 'wells-dripper') {
    const csvEsc = v => (v == null || v === '') ? '' : /[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
    const fillTo = parseInt(el('well-dripper-amount').value) || 12;
    const checkedIds = getCheckedDripperIds();
    const exportRows = checkedIds.size > 0 ? lastWellDripperRows.filter(r => checkedIds.has(String(r.well_id))) : lastWellDripperRows;
    const lines = [`Dripper Oil Levels,Fill target: ${fillTo} gal`, '', 'Area,Well,Dripper Oil (gal),Amt to Full (gal),Last Read'];
    let csvTotal = 0;
    exportRows.forEach(r => {
      const dripper = r.dripper_oil != null ? Number(r.dripper_oil) : null;
      const atf = dripper != null ? Math.max(0, fillTo - dripper) : null;
      if (atf != null) csvTotal += atf;
      lines.push([r.area||'', r.common_name, dripper != null ? dripper.toFixed(2) : '', atf != null ? atf.toFixed(2) : '', r.reading_date ? String(r.reading_date).slice(0,10) : ''].map(csvEsc).join(','));
    });
    lines.push('', `Total oil needed (${exportRows.length} wells),,,${csvTotal.toFixed(2)},`);
    await shareFile(new Blob([lines.join('\r\n')], { type: 'text/csv' }), `DripperOil.csv`, 'Dripper Oil Levels');
    return;
  }

  // vehicles (default)
  const ac = v => (v.assigned_user && v.assigned_user.trim().toLowerCase() !== 'ops & maint') ? v.assigned_user : '';
  const trucks = lastReportRows.filter(r => !r.reading_type || r.reading_type === 'odometer');
  const heavy  = lastReportRows.filter(r => r.reading_type === 'hours' || r.reading_type === 'both');
  const d = new Date(reportsYear, reportsMonth - 1, 1);
  const lines = [`CVC Mileage — ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`, '', 'TRUCKS', 'Unit #,Make,Model,Operator,Odometer'];
  trucks.forEach(v => lines.push([v.vehicle_number, v.make, v.model, ac(v), v.odometer_miles ?? ''].join(',')));
  lines.push('', 'HEAVY EQUIPMENT', 'Unit #,Make,Model,Operator,Odometer,Engine Hours');
  heavy.forEach(v => lines.push([v.vehicle_number, v.make, v.model, ac(v), v.odometer_miles ?? '', v.engine_hours ?? ''].join(',')));
  await shareFile(new Blob([lines.join('\r\n')], { type: 'text/csv' }), `CVC_Mileage_${reportsYear}_${reportsMonth}.csv`, 'CVC Mileage');
});

el('export-xlsx-btn').addEventListener('click', async () => {
  el('export-modal').classList.add('hidden');
  try {
    if (exportContext === 'piezometers-status') {
      const { token } = await api('POST', '/api/reports/download-token', {});
      const url = `/api/reports/piezometers/export?start_date=${piezRepStart}&end_date=${piezRepEnd}&token=${token}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      await shareFile(await res.blob(), `Piezometers_${piezRepStart}_${piezRepEnd}.xlsx`, 'Piezometer Readings');
      return;
    }
    if (exportContext === 'piezometers-compare') {
      const s1 = el('piez-cmp-start1').value, e1 = el('piez-cmp-end1').value;
      const s2 = el('piez-cmp-start2').value, e2 = el('piez-cmp-end2').value;
      const { token } = await api('POST', '/api/reports/download-token', {});
      const url = `/api/reports/piezometers/compare/export?s1=${s1}&e1=${e1}&s2=${s2}&e2=${e2}&token=${token}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      await shareFile(await res.blob(), `Piezometers_Compare_${s1}_${s2}.xlsx`, 'Piezometer Comparison');
      return;
    }
    if (exportContext === 'wells-daily') {
      const date = el('well-report-date').value;
      const { token } = await api('POST', '/api/reports/download-token', {});
      const url = `/api/reports/wells/daily/export?date=${date}&token=${token}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      await shareFile(await res.blob(), `WellReadings_${date}.xlsx`, 'Well Readings');
      return;
    }
    if (exportContext === 'wells-dripper') {
      const fillTo = el('well-dripper-amount').value || 12;
      const checkedIds = [...getCheckedDripperIds()];
      const { token } = await api('POST', '/api/reports/download-token', {});
      const wellsParam = checkedIds.length > 0 ? `&wells=${checkedIds.join(',')}` : '';
      const url = `/api/reports/wells/dripper/export?fill_to=${fillTo}&token=${token}${wellsParam}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      await shareFile(await res.blob(), `DripperOil.xlsx`, 'Dripper Oil Levels');
      return;
    }
    // vehicles
    const { token } = await api('POST', '/api/reports/download-token', { year: reportsYear, month: reportsMonth });
    const url = `/api/reports/mileage/export?format=xlsx&year=${reportsYear}&month=${reportsMonth}&token=${token}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Export failed');
    await shareFile(await res.blob(), `CVC_Mileage_${reportsYear}_${reportsMonth}.xlsx`, 'CVC Mileage');
  } catch (err) {
    if (err.name !== 'AbortError') showToast('Export failed: ' + err.message, 'error');
  }
});

// ── Piezometers Report Panel ───────────────────────────────────────────────────
let piezRepType        = 'status';
let lastPiezStatusRows = [];
let lastPiezCompareRows1 = [];
let lastPiezCompareRows2 = [];
let piezRepYear  = new Date().getFullYear();
let piezRepMonth = new Date().getMonth() + 1;
let piezRepStart = '';
let piezRepEnd   = '';

// Compare ranges default: previous month vs current month
(function () {
  const now   = new Date();
  const cy    = now.getFullYear(), cm = now.getMonth() + 1;
  let   py    = cy, pm = cm - 1;
  if (pm < 1) { pm = 12; py--; }
  const pad   = n => String(n).padStart(2, '0');
  const lastP = new Date(py, pm, 0).getDate();
  const lastC = new Date(cy, cm, 0).getDate();
  el('piez-cmp-start1').value = `${py}-${pad(pm)}-01`;
  el('piez-cmp-end1').value   = `${py}-${pad(pm)}-${pad(lastP)}`;
  el('piez-cmp-start2').value = `${cy}-${pad(cm)}-01`;
  el('piez-cmp-end2').value   = `${cy}-${pad(cm)}-${pad(lastC)}`;
})();

// Numeric pool sort: Pool 1, 2, 3… first; Central Pioneer and other named last
function sortPools(poolKeys) {
  const num = n => { const m = /^Pool\s+(\d+)$/i.exec(n); return m ? parseInt(m[1]) : null; };
  return [...poolKeys].sort((a, b) => {
    const na = num(a), nb = num(b);
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.localeCompare(b);
  });
}

function piezRepMonthBounds() {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(piezRepYear, piezRepMonth, 0).getDate();
  piezRepStart = `${piezRepYear}-${pad(piezRepMonth)}-01`;
  piezRepEnd   = `${piezRepYear}-${pad(piezRepMonth)}-${pad(lastDay)}`;
  el('piez-report-start-date').value = piezRepStart;
  el('piez-report-end-date').value   = piezRepEnd;
}

function updatePiezRepLabel() {
  const d = new Date(piezRepYear, piezRepMonth - 1, 1);
  el('piez-report-month-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function initPiezReportPanel() {
  if (!piezRepStart) piezRepMonthBounds();
  updatePiezRepLabel();
  runPiezReport();
}

function runPiezReport() {
  if (piezRepType === 'status')       renderPiezReport();
  else if (piezRepType === 'compare') renderPiezCompareReport();
}

document.querySelectorAll('#piez-report-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#piez-report-seg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    piezRepType = btn.dataset.val;
    el('piez-status-toolbar').style.display  = piezRepType === 'status'  ? '' : 'none';
    el('piez-compare-toolbar').style.display = piezRepType === 'compare' ? '' : 'none';
    runPiezReport();
  });
});

el('piez-report-prev-month').addEventListener('click', () => {
  piezRepMonth--;
  if (piezRepMonth < 1) { piezRepMonth = 12; piezRepYear--; }
  piezRepMonthBounds();
  updatePiezRepLabel();
  renderPiezReport();
});
el('piez-report-next-month').addEventListener('click', () => {
  piezRepMonth++;
  if (piezRepMonth > 12) { piezRepMonth = 1; piezRepYear++; }
  piezRepMonthBounds();
  updatePiezRepLabel();
  renderPiezReport();
});
el('piez-report-start-date').addEventListener('change', () => { piezRepStart = el('piez-report-start-date').value; renderPiezReport(); });
el('piez-report-end-date').addEventListener('change',   () => { piezRepEnd   = el('piez-report-end-date').value;   renderPiezReport(); });
['piez-cmp-start1','piez-cmp-end1','piez-cmp-start2','piez-cmp-end2'].forEach(id => {
  el(id).addEventListener('change', renderPiezCompareReport);
});

function groupByPool(rows) {
  const pools = {};
  rows.forEach(r => {
    const pool = r.pool || 'No Pool';
    if (!pools[pool]) pools[pool] = [];
    pools[pool].push(r);
  });
  return pools;
}

async function renderPiezReport() {
  const out = el('report-piez-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    lastPiezStatusRows = await api('GET', `/api/reports/piezometers?start_date=${piezRepStart}&end_date=${piezRepEnd}`);
    const rows = lastPiezStatusRows;
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric' }) : '—';
    const pools = groupByPool(rows);

    const totalPiezs = rows.length;
    const readCount  = rows.filter(r => r.reading_date).length;
    const pct = totalPiezs > 0 ? (readCount / totalPiezs * 100).toFixed(0) : 0;

    let html = `<div class="report-card">
      <div class="report-title">Piezometer Readings</div>
      <div class="report-subtitle">${fmtDate(piezRepStart)} – ${fmtDate(piezRepEnd)}</div>
      <div class="kf-complete-banner">
        <span class="kf-complete-fraction">${readCount} / ${totalPiezs}</span>
        <span class="kf-complete-label">piezometers read</span>
        <span class="kf-complete-pct">${pct}%</span>
      </div>`;

    sortPools(Object.keys(pools)).forEach(pool => {
      const piezs = pools[pool];
      html += `<div class="report-section-title">${pool}</div>
        <table class="report-table">
          <thead><tr><th>Name</th><th class="report-num">DTW (ft)</th><th>Method</th><th>Operator</th><th class="report-num">Date</th></tr></thead>
          <tbody>`;
      piezs.forEach(p => {
        const read = !!p.reading_date;
        const dtw  = p.dtw_reading != null ? Number(p.dtw_reading).toFixed(2) : '—';
        const method = [p.plopper_sounder, p.wet_dry_moist].filter(Boolean).join(' / ') || '—';
        const dateCell = read
          ? `<span style="color:var(--green)">${fmtDate(p.reading_date)}</span>`
          : `<span style="color:var(--red-light)">Not read</span>`;
        html += `<tr${read ? '' : ' style="opacity:0.6"'}>
          <td>${escHtml(p.piezometer_name)}</td>
          <td class="report-num">${dtw}</td>
          <td>${method}</td>
          <td>${escHtml(p.operator || '—')}</td>
          <td class="report-num">${dateCell}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    });

    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

async function renderPiezCompareReport() {
  const s1 = el('piez-cmp-start1').value, e1 = el('piez-cmp-end1').value;
  const s2 = el('piez-cmp-start2').value, e2 = el('piez-cmp-end2').value;
  if (!s1 || !e1 || !s2 || !e2) return;

  const out = el('report-piez-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    [lastPiezCompareRows1, lastPiezCompareRows2] = await Promise.all([
      api('GET', `/api/reports/piezometers?start_date=${s1}&end_date=${e1}`),
      api('GET', `/api/reports/piezometers?start_date=${s2}&end_date=${e2}`),
    ]);
    const [rows1, rows2] = [lastPiezCompareRows1, lastPiezCompareRows2];

    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const map2 = new Map(rows2.map(r => [r.piezometer_id, r]));
    const pools = groupByPool(rows1);

    let html = `<div class="report-card">
      <div class="report-title">Piezometer Comparison</div>
      <div class="report-subtitle">${fmtDate(s1)}–${fmtDate(e1)} vs ${fmtDate(s2)}–${fmtDate(e2)}</div>`;

    sortPools(Object.keys(pools)).forEach(pool => {
      const piezs = pools[pool];
      html += `<div class="report-section-title">${pool}</div>
        <table class="report-table">
          <thead><tr><th>Name</th><th class="report-num">DTW 1</th><th class="report-num">DTW 2</th><th class="report-num">Difference</th></tr></thead>
          <tbody>`;
      piezs.forEach(p => {
        const r2   = map2.get(p.piezometer_id);
        const dtw1 = p.dtw_reading    != null ? Number(p.dtw_reading)    : null;
        const dtw2 = r2?.dtw_reading  != null ? Number(r2.dtw_reading)   : null;
        const d1   = dtw1 != null ? dtw1.toFixed(2) : '—';
        const d2   = dtw2 != null ? dtw2.toFixed(2) : '—';
        let diffCell = '—';
        if (dtw1 != null && dtw2 != null) {
          const diff = dtw2 - dtw1;
          const abs  = Math.abs(diff).toFixed(2);
          // DTW is depth-to-water. A larger reading than before = water level
          // dropped → down arrow. A smaller reading = water level rose → up arrow.
          if (Math.abs(diff) < 0.005) {
            diffCell = abs;
          } else if (diff > 0) {
            diffCell = `<span style="color:var(--yellow)">↓ ${abs}</span>`;
          } else {
            diffCell = `<span style="color:var(--green)">↑ ${abs}</span>`;
          }
        }
        html += `<tr>
          <td>${escHtml(p.piezometer_name)}</td>
          <td class="report-num">${d1}</td>
          <td class="report-num">${d2}</td>
          <td class="report-num">${diffCell}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    });

    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

el('export-pdf-btn').addEventListener('click', async () => {
  el('export-modal').classList.add('hidden');
  document.body.style.overflow = '';
  const btn = el('export-pdf-btn');
  btn.disabled = true;
  try {
    if (exportContext === 'wells-dripper') {
      if (!lastWellDripperRows.length) throw new Error('No report data to export');
      const fillTo = parseInt(el('well-dripper-amount').value) || 12;
      const checkedIds = getCheckedDripperIds();
      const exportRows = checkedIds.size > 0 ? lastWellDripperRows.filter(r => checkedIds.has(String(r.well_id))) : lastWellDripperRows;
      await sharePdfFromHtml(buildDripperPdfHtml(exportRows, fillTo), REPORT_PDF_CSS, 'DripperOil', 'Dripper Oil Levels');
    } else if (exportContext === 'wells-daily') {
      const card = el('report-wells-output').querySelector('.report-card');
      if (!card) throw new Error('No report to export');
      const date = el('well-report-date').value;
      await sharePdfFromHtml(card.outerHTML, REPORT_PDF_CSS, `WellReadings_${date}`, 'Well Readings');
    } else if (exportContext === 'piezometers-status') {
      const card = el('report-piez-output').querySelector('.report-card');
      if (!card) throw new Error('No report to export');
      await sharePdfFromHtml(card.outerHTML, REPORT_PDF_CSS, `Piezometers_${piezRepStart}_${piezRepEnd}`, 'Piezometer Readings');
    } else if (exportContext === 'piezometers-compare') {
      const card = el('report-piez-output').querySelector('.report-card');
      if (!card) throw new Error('No report to export');
      const s1 = el('piez-cmp-start1').value, s2 = el('piez-cmp-start2').value;
      await sharePdfFromHtml(card.outerHTML, REPORT_PDF_CSS, `Piezometers_Compare_${s1}_${s2}`, 'Piezometer Comparison');
    } else {
      // vehicles / mileage — compact so the whole fleet fits one portrait page
      const html = buildMileageHTML(lastReportRows, reportsYear, reportsMonth);
      const monthName = new Date(reportsYear, reportsMonth - 1, 1).toLocaleDateString('en-US', { month: 'long' });
      const fname = `${reportsMonth}-${monthName}-${String(reportsYear).slice(2)}-Mileage`;
      await sharePdfFromHtml(html, MILEAGE_PDF_CSS, fname, 'CVC Mileage',
        { orientation: 'portrait', format: 'letter', widthPx: 794, margin: 6 });
    }
  } catch (err) {
    if (err.name !== 'AbortError') showToast('Export failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ── Lock body scroll when any modal is open (prevents background scroll on iOS) ── */
(function () {
  const observer = new MutationObserver(() => {
    const anyOpen = document.querySelector('.modal-overlay:not(.hidden)');
    document.body.style.overflow = anyOpen ? 'hidden' : '';
  });
  document.querySelectorAll('.modal-overlay').forEach(m => {
    observer.observe(m, { attributes: true, attributeFilter: ['class'] });
  });
})();

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
      if (activeScreen._navBackFn) activeScreen._navBackFn();
      else showScreen('dashboard');
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

/* ── GPS Location Selector ───────────────────────────────────────────────── */
function openGPSLocSelector() {
  el('gps-loc-overlay').classList.remove('hidden');
  el('gps-loc-category').value = '';
  el('gps-loc-pool').innerHTML = '<option value="">— Select pool —</option>';
  el('gps-loc-pool-group').style.display = 'none';
  el('gps-loc-well').innerHTML = '<option value="">— Select category first —</option>';
  el('gps-loc-well').disabled = true;
  el('gps-loc-existing').className = 'gps-loc-existing hidden';
  el('gps-loc-existing').textContent = '';
  el('gps-loc-coords').textContent = 'Tap map to place pin';
  el('gps-loc-save').disabled = true;
  el('gps-loc-save').textContent = 'Save Location';
  _gpsLocPin = null;
  _gpsLocSelected = null;
  _gpsLocWellData = [];

  setTimeout(() => {
    if (_gpsLocMap) { _gpsLocMap.remove(); _gpsLocMap = null; }
    _gpsLocPinMarker = null;
    _gpsLocExistingMarker = null;
    _gpsLocUserMarker = null;

    _gpsLocMap = L.map('gps-loc-map', { zoomControl: true, attributionControl: false })
      .setView([35.37, -119.02], 14);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20
    }).addTo(_gpsLocMap);

    _gpsLocMap.on('click', e => {
      const lat = parseFloat(e.latlng.lat.toFixed(7));
      const lng = parseFloat(e.latlng.lng.toFixed(7));
      _gpsLocPin = { lat, lng };
      el('gps-loc-coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      const pinIcon = L.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;border-radius:50%;background:#ef4444;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      if (_gpsLocPinMarker) _gpsLocPinMarker.remove();
      _gpsLocPinMarker = L.marker([lat, lng], { icon: pinIcon }).addTo(_gpsLocMap);
      _gpsLocPinMarker.bindPopup('New location').openPopup();
      updateGPSLocSaveBtn();
    });

    refreshGPSLocPosition();

    _gpsLocMap.invalidateSize();
  }, 50);
}

function refreshGPSLocPosition() {
  if (!navigator.geolocation || !_gpsLocMap) return;
  const btn = el('gps-loc-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  navigator.geolocation.getCurrentPosition(pos => {
    if (!_gpsLocMap) return;
    const { latitude, longitude } = pos.coords;
    const locIcon = L.divIcon({
      className: '',
      html: '<div class="map-my-location"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    if (_gpsLocUserMarker) _gpsLocUserMarker.remove();
    _gpsLocUserMarker = L.marker([latitude, longitude], { icon: locIcon })
      .addTo(_gpsLocMap)
      .bindPopup('<strong>You are here</strong>');
    _gpsLocMap.setView([latitude, longitude], 16);

    // Always update pin to current location (overrides previous auto-fill or manual tap)
    _gpsLocPin = { lat: parseFloat(latitude.toFixed(7)), lng: parseFloat(longitude.toFixed(7)) };
    el('gps-loc-coords').textContent = `${_gpsLocPin.lat.toFixed(6)}, ${_gpsLocPin.lng.toFixed(6)} (your location)`;
    if (_gpsLocPinMarker) { _gpsLocPinMarker.remove(); _gpsLocPinMarker = null; }
    updateGPSLocSaveBtn();
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  }, () => {
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  });
}

function closeGPSLocSelector() {
  el('gps-loc-overlay').classList.add('hidden');
  if (_gpsLocMap) { _gpsLocMap.remove(); _gpsLocMap = null; }
  _gpsLocPinMarker = null;
  _gpsLocExistingMarker = null;
  _gpsLocUserMarker = null;
  _gpsLocPin = null;
  _gpsLocSelected = null;
  _gpsLocWellData = [];
}

async function onGPSLocCategoryChange() {
  const cat = el('gps-loc-category').value;
  _gpsLocSelected = null;
  _gpsLocWellData = [];
  el('gps-loc-well').innerHTML = '<option value="">Loading…</option>';
  el('gps-loc-well').disabled = true;
  el('gps-loc-existing').className = 'gps-loc-existing hidden';
  el('gps-loc-pool-group').style.display = 'none';
  updateGPSLocSaveBtn();

  if (!cat) {
    el('gps-loc-well').innerHTML = '<option value="">— Select category first —</option>';
    return;
  }

  if (cat === 'Piezometers') {
    el('gps-loc-pool-group').style.display = '';
    // Build pool list from piezAllItems if loaded, else fetch
    let piez = piezAllItems;
    if (!piez || !piez.length) {
      try { piez = await api('GET', '/api/piezometers'); } catch { piez = []; }
    }
    _gpsLocWellData = piez;
    const pools = [...new Set(piez.map(p => p.pool).filter(Boolean))].sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, '')) || 0;
      const nb = parseInt(b.replace(/\D/g, '')) || 0;
      return na !== nb ? na - nb : a.localeCompare(b);
    });
    el('gps-loc-pool').innerHTML = '<option value="">— Select pool —</option>' +
      pools.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
    el('gps-loc-well').innerHTML = '<option value="">— Select pool first —</option>';
  } else {
    try {
      const wells = await api('GET', `/api/wells/by-run?run=${encodeURIComponent(cat)}`);
      _gpsLocWellData = wells;
      if (!wells.length) {
        el('gps-loc-well').innerHTML = '<option value="">No wells found</option>';
      } else {
        el('gps-loc-well').innerHTML = '<option value="">— Select well —</option>' +
          wells.map(w => {
            const label = [w.state_well_number, w.common_name].filter(Boolean).join(' — ');
            return `<option value="${w.well_id}" data-lat="${w.gps_latitude ?? ''}" data-lng="${w.gps_longitude ?? ''}">${escHtml(label)}</option>`;
          }).join('');
        el('gps-loc-well').disabled = false;
      }
    } catch {
      el('gps-loc-well').innerHTML = '<option value="">Failed to load</option>';
    }
  }
}

function onGPSLocPoolChange() {
  const pool = el('gps-loc-pool').value;
  _gpsLocSelected = null;
  el('gps-loc-existing').className = 'gps-loc-existing hidden';
  updateGPSLocSaveBtn();

  if (!pool) {
    el('gps-loc-well').innerHTML = '<option value="">— Select pool first —</option>';
    el('gps-loc-well').disabled = true;
    return;
  }
  const filtered = _gpsLocWellData.filter(p => p.pool === pool);
  if (!filtered.length) {
    el('gps-loc-well').innerHTML = '<option value="">No piezometers in this pool</option>';
    el('gps-loc-well').disabled = true;
    return;
  }
  el('gps-loc-well').innerHTML = '<option value="">— Select piezometer —</option>' +
    filtered.map(p => `<option value="${p.piezometer_id}" data-lat="${p.gps_latitude ?? ''}" data-lng="${p.gps_longitude ?? ''}">${escHtml(p.piezometer_name)}</option>`).join('');
  el('gps-loc-well').disabled = false;
}

function onGPSLocWellChange() {
  const opt = el('gps-loc-well').selectedOptions[0];
  if (!opt || !opt.value) {
    _gpsLocSelected = null;
    el('gps-loc-existing').className = 'gps-loc-existing hidden';
    updateGPSLocSaveBtn();
    return;
  }
  const cat = el('gps-loc-category').value;
  const isPiez = cat === 'Piezometers';
  const existingLat = opt.dataset.lat ? parseFloat(opt.dataset.lat) : null;
  const existingLng = opt.dataset.lng ? parseFloat(opt.dataset.lng) : null;

  _gpsLocSelected = {
    type: isPiez ? 'piezometer' : 'well',
    id:   opt.value,
    name: opt.textContent,
    existingLat,
    existingLng,
  };

  const existEl = el('gps-loc-existing');
  if (existingLat && existingLng) {
    existEl.className = 'gps-loc-existing has-coords';
    existEl.textContent = `Existing: ${existingLat.toFixed(6)}, ${existingLng.toFixed(6)}`;

    const greyIcon = L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#9ca3af;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    if (_gpsLocExistingMarker) _gpsLocExistingMarker.remove();
    _gpsLocExistingMarker = L.marker([existingLat, existingLng], { icon: greyIcon })
      .addTo(_gpsLocMap)
      .bindPopup(`Current: ${existingLat.toFixed(6)}, ${existingLng.toFixed(6)}`);
    _gpsLocMap.setView([existingLat, existingLng], 16);
  } else {
    existEl.className = 'gps-loc-existing';
    existEl.textContent = 'No coordinates set';
    if (_gpsLocExistingMarker) { _gpsLocExistingMarker.remove(); _gpsLocExistingMarker = null; }
  }

  // Refresh device location for this well so pin is current
  _gpsLocPin = null;
  if (_gpsLocPinMarker) { _gpsLocPinMarker.remove(); _gpsLocPinMarker = null; }
  refreshGPSLocPosition();
  updateGPSLocSaveBtn();
}

function updateGPSLocSaveBtn() {
  el('gps-loc-save').disabled = !(_gpsLocSelected && _gpsLocPin);
}

async function saveGPSLocation() {
  if (!_gpsLocSelected || !_gpsLocPin) return;
  if (_gpsLocSelected.existingLat && _gpsLocSelected.existingLng) {
    if (!confirm(`"${_gpsLocSelected.name}" already has GPS coordinates.\nOverwrite with the new location?`)) return;
  }
  const endpoint = _gpsLocSelected.type === 'well'
    ? `/api/wells/${_gpsLocSelected.id}/gps`
    : `/api/piezometers/${_gpsLocSelected.id}/gps`;
  const saveBtn = el('gps-loc-save');
  try {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    await api('PATCH', endpoint, { gps_latitude: _gpsLocPin.lat, gps_longitude: _gpsLocPin.lng });
    showToast(`GPS saved for ${_gpsLocSelected.name}`, 'success');

    // Stay on modal — update state to reflect the newly saved coords
    const savedLat = _gpsLocPin.lat;
    const savedLng = _gpsLocPin.lng;
    _gpsLocSelected.existingLat = savedLat;
    _gpsLocSelected.existingLng = savedLng;

    // Update the dropdown option's data attributes so re-selecting shows new coords
    const opt = el('gps-loc-well').selectedOptions[0];
    if (opt) { opt.dataset.lat = savedLat; opt.dataset.lng = savedLng; }

    // Move existing-location marker to saved position (green to indicate saved)
    const savedIcon = L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#4caf50;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>',
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    if (_gpsLocExistingMarker) _gpsLocExistingMarker.remove();
    _gpsLocExistingMarker = L.marker([savedLat, savedLng], { icon: savedIcon })
      .addTo(_gpsLocMap)
      .bindPopup(`Saved: ${savedLat.toFixed(6)}, ${savedLng.toFixed(6)}`);

    // Remove the tap pin and reset pin state
    if (_gpsLocPinMarker) { _gpsLocPinMarker.remove(); _gpsLocPinMarker = null; }
    _gpsLocPin = null;

    // Update footer and existing-coords display
    el('gps-loc-coords').textContent = 'Tap map to place pin';
    const existEl = el('gps-loc-existing');
    existEl.className = 'gps-loc-existing has-coords';
    existEl.textContent = `Saved: ${savedLat.toFixed(6)}, ${savedLng.toFixed(6)}`;

    saveBtn.textContent = 'Save Location';
    updateGPSLocSaveBtn();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Location';
  }
}

el('gps-loc-close').addEventListener('click', closeGPSLocSelector);
el('gps-loc-overlay').addEventListener('click', e => { if (e.target === el('gps-loc-overlay')) closeGPSLocSelector(); });
el('gps-loc-category').addEventListener('change', onGPSLocCategoryChange);
el('gps-loc-pool').addEventListener('change', onGPSLocPoolChange);
el('gps-loc-well').addEventListener('change', onGPSLocWellChange);
el('gps-loc-refresh-btn').addEventListener('click', refreshGPSLocPosition);
el('gps-loc-save').addEventListener('click', saveGPSLocation);

const WR_PANEL_NAMES = { dwr: 'DWR', kcwa: 'KCWA Piezometers' };
let wellRunsInited = false;
async function initWellRunsScreen() {
  if (wellRunsInited) return;
  wellRunsInited = true;

  const role = currentUser?.role;
  let showToAll = false;
  try {
    const s = await api('GET', '/api/settings/gps-selector');
    showToAll = s.public;
  } catch { /* ignore */ }

  if (isSupervisorLevel(role) || showToAll) {
    el('gps-loc-btn-wrap').classList.remove('hidden');
    el('gps-loc-open-btn').addEventListener('click', openGPSLocSelector);
  }

  document.querySelectorAll('[data-wr-panel]').forEach(tile => {
    tile.addEventListener('click', () => {
      const panel = tile.dataset.wrPanel;
      el('well-runs-main').classList.add('hidden');
      const closeWrPanel = () => {
        document.querySelectorAll('#screen-well-runs .maint-panel').forEach(p => p.classList.add('hidden'));
        el('well-runs-main').classList.remove('hidden');
        setPanelNav(el('screen-well-runs'), () => showScreen('dashboard'), 'Well Runs');
      };
      if (panel === 'dwr') {
        el('wr-panel-dwr').classList.remove('hidden');
        initDWRScreen();
      } else if (panel === 'kcwa') {
        el('wr-panel-kcwa').classList.remove('hidden');
        initPiezScreen();
      } else {
        el('wr-panel-soon').classList.remove('hidden');
      }
      setPanelNav(el('screen-well-runs'), closeWrPanel,
        'Well Runs - ' + (WR_PANEL_NAMES[panel] || 'Coming Soon'));
    });
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
      <div class="form-group toggle-row">
        <label>Access</label>
        <div class="toggle-group">
          <button class="toggle-btn dwr-access-tube${w.access === 'Tube' ? ' active' : ''}">Tube</button>
          <button class="toggle-btn dwr-access-plug${w.access === 'Plug' ? ' active' : ''}">Plug</button>
        </div>
      </div>
      <div class="form-group">
        <label>Operator</label>
        <input type="text" class="ctrl-input dwr-op" placeholder="Initials" readonly>
      </div>
      <div class="form-group">
        <label>Notes</label>
        ${w.last_notes ? `<div class="prev-note-hint">${escHtml(w.last_notes)}</div>` : ''}
        <textarea class="ctrl-textarea dwr-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="lif-error error-msg hidden"></div>
      <div class="lif-footer">
        ${hasGPS ? `<button class="btn btn-secondary btn-sm dwr-map-item-btn">${icon('map-pin')} Map</button>` : ''}
        <button class="btn btn-secondary btn-sm dwr-hist-btn">${icon('history')} History</button>
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

  let dwrAccess = w.access || null;
  div.querySelector('.dwr-access-tube').addEventListener('click', e => {
    if (dwrAccess === 'Tube') { dwrAccess = null; e.currentTarget.classList.remove('active'); return; }
    dwrAccess = 'Tube';
    e.currentTarget.classList.add('active');
    div.querySelector('.dwr-access-plug').classList.remove('active');
  });
  div.querySelector('.dwr-access-plug').addEventListener('click', e => {
    if (dwrAccess === 'Plug') { dwrAccess = null; e.currentTarget.classList.remove('active'); return; }
    dwrAccess = 'Plug';
    e.currentTarget.classList.add('active');
    div.querySelector('.dwr-access-tube').classList.remove('active');
  });

  // Map button (individual well)
  div.querySelector('.dwr-map-item-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openLocationModal(w.gps_latitude, w.gps_longitude, wellLabel);
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
      const sb = div.querySelector('.dwr-save-btn');
      sb.disabled = false; sb.textContent = 'Save Reading';
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

    const saveBtn = e.currentTarget;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
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
      access:                   dwrAccess,
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
      div.querySelector('.dwr-method').value = '';
      div.querySelector('.dwr-notes').value = '';

      updateDWRCounter();
      showToast(`${w.common_name} saved`, 'success');
    } catch (err) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Reading';
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
        ? `<span class="uptool-qi-pdf">${icon('invoice', 28)}</span>`
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
        ? `<div class="uptool-fc-thumb"><span class="uptool-pdf-icon">${icon('invoice', 28)}</span></div>`
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
        <p>${icon('invoice', 32)} ${escapeHtml(name)}</p>
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

/* ── HR ──────────────────────────────────────────────────────────────────── */
let torRanges = [];   // [{ start, end, hours }]

// "Wednesday, June 3rd"
function torFmtDate(d) {
  const dt = new Date(d + 'T00:00:00');
  const day = dt.getDate();
  const ord = (day % 10 === 1 && day !== 11) ? 'st'
            : (day % 10 === 2 && day !== 12) ? 'nd'
            : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long' });
  const month   = dt.toLocaleDateString('en-US', { month: 'long' });
  return `${weekday}, ${month} ${day}${ord}`;
}

// "Wednesday, June 3rd" or "Wednesday, June 3rd – Friday, June 5th"
function torFmtRange(start, end) {
  return start === end ? torFmtDate(start) : `${torFmtDate(start)} – ${torFmtDate(end)}`;
}

function openHRPanel(panelId) {
  el('hr-main').classList.add('hidden');
  document.querySelectorAll('#screen-hr .maint-panel').forEach(p => p.classList.add('hidden'));
  el(`hr-panel-${panelId}`).classList.remove('hidden');
  const panelTitles = {
    'time-off':     'Time Off Request',
    'charge-codes': 'Charge Codes',
  };
  setPanelNav(el('screen-hr'), closeHRPanel, 'HR – ' + (panelTitles[panelId] || panelId));
  if (panelId === 'time-off') initTimeOffPanel();
  if (panelId === 'charge-codes') initChargeCodesPanel();
}

function closeHRPanel() {
  document.querySelectorAll('#screen-hr .maint-panel').forEach(p => p.classList.add('hidden'));
  el('hr-main').classList.remove('hidden');
  setPanelNav(el('screen-hr'), () => showScreen('dashboard'), 'HR');
}

function initHRScreen() {
  closeHRPanel();
}

// ── Charge Codes (HR reference list + breakdown calculator) ─────────────────
let _ccCodes = [], _ccSplits = [];

async function initChargeCodesPanel() {
  ccSwitchTab('list');
  el('cc-tab-btn-list').onclick = () => ccSwitchTab('list');
  el('cc-tab-btn-calc').onclick = () => ccSwitchTab('calc');
  el('cc-search').oninput = renderCCList;
  el('cc-split-select').onchange = renderCCSplitResult;
  el('cc-split-hours').oninput = renderCCSplitResult;
  el('cc-list').innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    [_ccCodes, _ccSplits] = await Promise.all([
      api('GET', '/api/charge-codes'),
      api('GET', '/api/charge-code-splits'),
    ]);
  } catch {
    el('cc-list').innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
    return;
  }
  renderCCList();
  renderCCSplitOptions();
}

function ccSwitchTab(tab) {
  el('cc-tab-list').style.display = tab === 'list' ? '' : 'none';
  el('cc-tab-calc').style.display = tab === 'calc' ? '' : 'none';
  el('cc-tab-btn-list').classList.toggle('active', tab === 'list');
  el('cc-tab-btn-calc').classList.toggle('active', tab === 'calc');
}

function renderCCList() {
  const q = (el('cc-search').value || '').trim().toLowerCase();
  const rows = _ccCodes.filter(c =>
    !q || c.code.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
  if (!rows.length) {
    el('cc-list').innerHTML = `<div class="placeholder-msg">${_ccCodes.length ? 'No matches.' : 'No charge codes found.'}</div>`;
    return;
  }
  el('cc-list').innerHTML = rows.map(c => `
    <div class="cc-item">
      <span class="cc-item-code">${escHtml(c.code)}</span>
      <span class="cc-item-desc">${escHtml(c.description || '')}</span>
    </div>`).join('');
}

function renderCCSplitOptions() {
  const sel = el('cc-split-select');
  if (!_ccSplits.length) {
    sel.innerHTML = '<option value="">No breakdowns defined</option>';
  } else {
    sel.innerHTML = _ccSplits.map(s => `<option value="${s.split_id}">${escHtml(s.name)}</option>`).join('');
  }
  renderCCSplitResult();
}

// Split hours to the nearest quarter hour, giving any remainder to the
// largest-percentage code so the parts always sum exactly to the total.
function computeChargeSplit(total, components) {
  const parts = components.map(c => ({
    code: c.code,
    percent: Number(c.percent),
    hrs: Math.round((total * Number(c.percent) / 100) / 0.25) * 0.25,
  }));
  const sum = parts.reduce((a, p) => a + p.hrs, 0);
  const diff = Math.round((total - sum) * 100) / 100;
  if (diff !== 0 && parts.length) {
    let mi = 0;
    parts.forEach((p, i) => { if (p.percent > parts[mi].percent) mi = i; });
    parts[mi].hrs = Math.round((parts[mi].hrs + diff) * 100) / 100;
  }
  return parts;
}

function renderCCSplitResult() {
  const out = el('cc-split-result');
  const split = _ccSplits.find(s => String(s.split_id) === el('cc-split-select').value);
  const total = parseFloat(el('cc-split-hours').value);
  if (!split || !Array.isArray(split.components) || !split.components.length) { out.innerHTML = ''; return; }
  if (isNaN(total) || total < 0) {
    out.innerHTML = '<div class="placeholder-msg">Enter total hours above.</div>';
    return;
  }
  const parts = computeChargeSplit(total, split.components);
  out.innerHTML = parts.map(p => `
    <div class="cc-split-row">
      <span><strong class="cc-item-code">${escHtml(p.code)}</strong> <span style="color:var(--text-dim)">(${p.percent}%)</span></span>
      <strong>${p.hrs.toFixed(2)} h</strong>
    </div>`).join('') + `
    <div class="cc-split-total"><span>Total</span><span>${parts.reduce((a, p) => a + p.hrs, 0).toFixed(2)} h</span></div>`;
}

function initTimeOffPanel() {
  const today = new Date().toLocaleDateString('en-CA');
  torRanges = [];
  el('tor-start').value  = today;
  el('tor-end').value    = today;
  el('tor-hours').value  = '';
  el('tor-notes').value  = '';
  el('tor-range-error').classList.add('hidden');
  el('tor-error').classList.add('hidden');
  renderTorRanges();
}

function addTorRange() {
  const start  = el('tor-start').value;
  const end    = el('tor-end').value;
  const hours  = el('tor-hours').value;
  const errEl  = el('tor-range-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!start || !end) {
    errEl.textContent = 'Please select both a start and end date.';
    errEl.classList.remove('hidden');
    return;
  }
  if (end < start) {
    errEl.textContent = 'End date must be on or after start date.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!hours || parseFloat(hours) <= 0) {
    errEl.textContent = 'Please enter hours requested.';
    errEl.classList.remove('hidden');
    return;
  }

  torRanges.push({ start, end, hours: parseFloat(hours) });

  // Reset inputs for next range
  const today = new Date().toLocaleDateString('en-CA');
  el('tor-start').value = today;
  el('tor-end').value   = today;
  el('tor-hours').value = '';
  renderTorRanges();
}

function renderTorRanges() {
  const listEl = el('tor-ranges-list');
  if (torRanges.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    el('tor-submit-btn').disabled = true;
    return;
  }
  listEl.classList.remove('hidden');
  listEl.innerHTML = torRanges.map((r, i) => {
    const dateLabel = torFmtRange(r.start, r.end);
    return `<div class="tor-range-item">
      <div class="tor-range-text">
        <div class="tor-range-dates">${dateLabel}</div>
        <div class="tor-range-hours">${r.hours} hr${r.hours !== 1 ? 's' : ''}</div>
      </div>
      <button class="tor-range-remove" data-idx="${i}" title="Remove">×</button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.tor-range-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      torRanges.splice(parseInt(btn.dataset.idx), 1);
      renderTorRanges();
    });
  });
  el('tor-submit-btn').disabled = false;
}

document.querySelectorAll('[data-hr-panel]').forEach(btn => {
  btn.addEventListener('click', () => openHRPanel(btn.dataset.hrPanel));
});

// When start date changes, keep end date in sync (ranges are usually short,
// so the end date is most likely on/near the start). Only auto-advance if the
// current end is before the new start.
el('tor-start').addEventListener('change', () => {
  const start = el('tor-start').value;
  const end   = el('tor-end').value;
  if (start && (!end || end < start)) el('tor-end').value = start;
});

el('tor-add-range-btn').addEventListener('click', addTorRange);

el('tor-submit-btn').addEventListener('click', () => {
  const notes    = el('tor-notes').value.trim();
  const errEl    = el('tor-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (torRanges.length === 0) {
    errEl.textContent = 'Add at least one date range before sending.';
    errEl.classList.remove('hidden');
    return;
  }

  const fullName = currentUser?.full_name || currentUser?.username || '';
  const subject  = `Time Off Request – ${fullName}`;

  let body = `Time Off Request\nSubmitted by: ${fullName}\n`;
  const totalHours = torRanges.reduce((s, r) => s + r.hours, 0);
  body += `Total Hours Requested: ${totalHours}\n\n`;

  torRanges.forEach(r => {
    body += `${torFmtRange(r.start, r.end)}  (${r.hours} hr${r.hours !== 1 ? 's' : ''})\n`;
  });
  body += '\n';

  if (notes) body += `Notes:\n${notes}\n`;

  const to = 'syoder@kcwa.com,mansolabehere@kcwa.com';
  window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

/* ── Safety ──────────────────────────────────────────────────────────────── */
let _safetyInited = false;
let _safetySigninMeetingId = null;

const SAFETY_PANEL_NAMES = { meetings: 'Safety Meetings' };

function initSafetyScreen() {
  if (_safetyInited) return;
  _safetyInited = true;
  document.querySelectorAll('[data-safety-panel]').forEach(tile => {
    tile.addEventListener('click', () => openSafetyPanel(tile.dataset.safetyPanel));
  });
}

function openSafetyPanel(id) {
  el('safety-main').classList.add('hidden');
  document.querySelectorAll('#screen-safety .maint-panel').forEach(p => p.classList.add('hidden'));
  el(`safety-panel-${id}`).classList.remove('hidden');
  setPanelNav(el('screen-safety'), closeSafetyPanel, 'Safety – ' + (SAFETY_PANEL_NAMES[id] || id));
  if (id === 'meetings') buildSafetyMeetingsPanel(el('safety-panel-meetings'));
}

function closeSafetyPanel() {
  document.querySelectorAll('#screen-safety .maint-panel').forEach(p => p.classList.add('hidden'));
  el('safety-main').classList.remove('hidden');
  setPanelNav(el('screen-safety'), () => showScreen('dashboard'), 'Safety');
}

// ── Safety Meetings Panel ─────────────────────────────────────────────────────
function buildSafetyMeetingsPanel(contentEl) {
  if (contentEl.firstElementChild) { loadSafetyMeetings(); return; }

  contentEl.innerHTML = `
    <div class="issue-toolbar" style="gap:8px">
      <button class="btn btn-primary btn-sm" id="safety-new-btn">+ New Meeting</button>
      <input type="search" id="safety-topic-search" class="ctrl-input" placeholder="Search by topic…" style="flex:1;min-width:0">
    </div>
    <div id="safety-meeting-form" class="settings-card hidden" style="margin:0 0 14px">
      <div class="settings-pad">
        <div class="two-col">
          <div class="form-group">
            <label>Date</label>
            <input type="date" id="sm-date" class="ctrl-input ctrl-input-sm">
          </div>
          <div class="form-group">
            <label>Time</label>
            <input type="time" id="sm-time" class="ctrl-input ctrl-input-sm">
          </div>
        </div>
        <div class="form-group">
          <label>Presented By</label>
          <select id="sm-presenter" class="ctrl-select"></select>
        </div>
        <div class="form-group">
          <label>Topic</label>
          <input type="text" id="sm-topic" class="ctrl-input" placeholder="Meeting topic or title">
        </div>
        <div class="form-group">
          <label>Link <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>
          <input type="url" id="sm-link" class="ctrl-input" placeholder="https://…">
        </div>
        <div class="form-group">
          <label>Notes <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>
          <textarea id="sm-notes" class="ctrl-input" rows="3" placeholder="Additional details…"></textarea>
        </div>
        <div id="sm-error" class="error-msg hidden"></div>
        <div class="form-row">
          <button class="btn btn-save" id="sm-submit">Create Meeting</button>
          <button class="btn btn-secondary" id="sm-cancel">Cancel</button>
        </div>
      </div>
    </div>
    <div id="safety-meetings-list"><div class="placeholder-msg">Loading…</div></div>`;

  el('safety-new-btn').addEventListener('click', openNewSafetyMeetingForm);
  el('sm-cancel').addEventListener('click', () => {
    el('safety-meeting-form').classList.add('hidden');
    el('safety-new-btn').style.display = '';
  });
  el('sm-submit').addEventListener('click', submitSafetyMeeting);

  let _smSearchTimer;
  el('safety-topic-search').addEventListener('input', () => {
    clearTimeout(_smSearchTimer);
    _smSearchTimer = setTimeout(() => loadSafetyMeetings(el('safety-topic-search').value.trim()), 300);
  });

  loadSafetyMeetings();
}

async function openNewSafetyMeetingForm() {
  el('safety-new-btn').style.display = 'none';
  el('safety-meeting-form').classList.remove('hidden');
  el('sm-date').value = new Date().toLocaleDateString('en-CA');
  el('sm-time').value = nowHHMM();
  el('sm-topic').value = '';
  el('sm-link').value  = '';
  el('sm-notes').value = '';
  el('sm-error').classList.add('hidden');

  // Populate presenter dropdown
  const sel = el('sm-presenter');
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const users = await api('GET', '/api/users/list');
    const fullNames = users.map(u => u.full_name || u.username).filter(Boolean);
    const current = currentUser?.full_name || '';
    sel.innerHTML = fullNames.map(n =>
      `<option value="${escHtml(n)}" ${n === current ? 'selected' : ''}>${escHtml(n)}</option>`
    ).join('');
    if (!sel.value && current) {
      const opt = document.createElement('option');
      opt.value = current; opt.textContent = current; opt.selected = true;
      sel.prepend(opt);
    }
  } catch {
    sel.innerHTML = `<option value="${escHtml(currentUser?.full_name || '')}">${escHtml(currentUser?.full_name || 'Unknown')}</option>`;
  }
}

async function submitSafetyMeeting() {
  const topic = el('sm-topic').value.trim();
  const errEl = el('sm-error');
  errEl.classList.add('hidden');
  if (!topic) {
    errEl.textContent = 'Topic is required.';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = el('sm-submit');
  const _save = beginSave(btn);
  try {
    await api('POST', '/api/safety-meetings', {
      meeting_date: el('sm-date').value,
      meeting_time: el('sm-time').value,
      presented_by: el('sm-presenter').value,
      topic,
      link:  el('sm-link').value.trim(),
      notes: el('sm-notes').value.trim(),
    });
    el('safety-meeting-form').classList.add('hidden');
    el('safety-new-btn').style.display = '';
    showToast('Meeting created');
    loadSafetyMeetings(el('safety-topic-search').value.trim());
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    _save();
  }
}

async function loadSafetyMeetings(q = '') {
  const listEl = el('safety-meetings-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const meetings = await api('GET', `/api/safety-meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!meetings.length) {
      listEl.innerHTML = '<div class="placeholder-msg">No meetings found.</div>';
      return;
    }
    listEl.innerHTML = meetings.map(m => {
      const dateStr = localDateStr(m.meeting_date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const time = m.meeting_time ? ' · ' + m.meeting_time.slice(0,5) : '';
      return `<div class="safety-meeting-item" data-mid="${m.meeting_id}">
        <div class="safety-meeting-header">
          <div class="safety-meeting-info">
            <div class="safety-meeting-topic">${escHtml(m.topic)}</div>
            <div class="safety-meeting-date">${dateStr}${time} · ${escHtml(m.presented_by || '')}
              <span class="safety-attend-count">${m.attendee_count} attendee${m.attendee_count !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <span class="safety-meeting-chevron">›</span>
        </div>
        <div class="safety-meeting-body hidden"></div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.safety-meeting-item').forEach(item => {
      item.querySelector('.safety-meeting-header').addEventListener('click', () => {
        toggleSafetyMeeting(item);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="placeholder-msg">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

async function toggleSafetyMeeting(item) {
  const body = item.querySelector('.safety-meeting-body');
  const chevron = item.querySelector('.safety-meeting-chevron');
  const isOpen = !body.classList.contains('hidden');
  if (isOpen) {
    body.classList.add('hidden');
    chevron.style.transform = '';
    return;
  }
  body.classList.remove('hidden');
  chevron.style.transform = 'rotate(90deg)';
  if (body.dataset.loaded) return;
  body.dataset.loaded = '1';
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';

  const mid = item.dataset.mid;
  try {
    const data = await api('GET', `/api/safety-meetings/${mid}`);
    renderSafetyMeetingBody(body, data);
  } catch {
    body.innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

function renderSafetyMeetingBody(body, data) {
  const linkHtml = data.link
    ? `<div class="form-group"><label>Link</label><a href="${escHtml(/^https?:\/\//i.test(data.link) ? data.link : 'https://' + data.link)}" target="_blank" rel="noopener" class="safety-meeting-link">${escHtml(data.link)}</a></div>`
    : '';
  const notesHtml = data.notes
    ? `<div class="form-group"><label>Notes</label><div class="safety-meeting-notes">${escHtml(data.notes)}</div></div>`
    : '';

  body.innerHTML = `
    ${linkHtml}
    ${notesHtml}
    <div class="safety-attend-section">
      <div class="safety-attend-header">
        <span class="report-section-title" style="margin:0">Attendance</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm safety-signin-btn">Sign In</button>
          <button class="btn btn-secondary btn-sm safety-export-btn">${icon('print',14)} Export PDF</button>
        </div>
      </div>
      <div class="safety-attend-list"></div>
    </div>`;

  renderSafetyAttendees(body.querySelector('.safety-attend-list'), data.attendees || [], data.meeting_id, body);

  body.querySelector('.safety-signin-btn').addEventListener('click', () => {
    openSafetySigninModal(data.meeting_id, body);
  });
  body.querySelector('.safety-export-btn').addEventListener('click', () => {
    exportSafetyMeetingPDF(data, data.attendees || []);
  });
}

function renderSafetyAttendees(listEl, attendees, meetingId, bodyEl) {
  const canDel = meetingId && bodyEl && isSupervisorLevel(currentUser?.role);
  if (!attendees.length) {
    listEl.innerHTML = '<div class="placeholder-msg" style="padding:12px 0">No attendees yet.</div>';
    return;
  }
  listEl.innerHTML = `<table class="safety-attend-table">
    <thead><tr><th>#</th><th>Print Name</th><th>Signature</th><th>Date</th>${canDel ? '<th></th>' : ''}</tr></thead>
    <tbody>${attendees.map((a, i) => `<tr>
      <td style="color:var(--text-dim);font-size:0.82rem">${i + 1}</td>
      <td>${escHtml(a.full_name)}</td>
      <td>${a.signature_data ? `<img src="${escHtml(a.signature_data)}" alt="signature">` : '<span style="color:var(--text-dim)">—</span>'}</td>
      <td style="white-space:nowrap">${a.signed_date ? localDateStr(a.signed_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
      ${canDel ? `<td><button class="safety-attend-del" data-aid="${a.attendee_id}" title="Delete">✕</button></td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;

  if (canDel) {
    listEl.querySelectorAll('.safety-attend-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this attendance record?')) return;
        try {
          await api('DELETE', `/api/safety-meetings/${meetingId}/attendees/${btn.dataset.aid}`);
          const data = await api('GET', `/api/safety-meetings/${meetingId}`);
          renderSafetyAttendees(listEl, data.attendees || [], meetingId, bodyEl);
          const item = bodyEl.closest('.safety-meeting-item');
          if (item) {
            const countEl = item.querySelector('.safety-attend-count');
            if (countEl) countEl.textContent = `${data.attendees.length} attendee${data.attendees.length !== 1 ? 's' : ''}`;
          }
        } catch (err) {
          showToast('Failed to delete: ' + (err.message || 'Unknown error'));
        }
      });
    });
  }
}

// ── Sign-in Modal ─────────────────────────────────────────────────────────────
let _sigCanvas = null;
let _sigCtx    = null;
let _sigDrawing = false;
let _sigInited  = false;

function openSafetySigninModal(meetingId, bodyEl) {
  _safetySigninMeetingId = meetingId;
  el('safety-signin-modal').classList.remove('hidden');
  el('safety-signin-date').value = new Date().toLocaleDateString('en-CA');
  el('safety-signin-error').classList.add('hidden');

  // Init canvas once
  if (!_sigInited) {
    _sigInited = true;
    _sigCanvas = el('safety-sig-canvas');
    _sigCtx = _sigCanvas.getContext('2d');
    initSigCanvas(_sigCanvas, _sigCtx);
    el('safety-sig-clear').addEventListener('click', () => {
      _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
    });
    el('safety-signin-close').addEventListener('click', closeSafetySigninModal);
    el('safety-signin-modal').addEventListener('click', e => {
      if (e.target === el('safety-signin-modal')) closeSafetySigninModal();
    });
    el('safety-signin-name-sel').addEventListener('change', () => {
      const isOther = el('safety-signin-name-sel').value === '__other__';
      el('safety-signin-name-other').style.display = isOther ? '' : 'none';
    });
    el('safety-signin-save').onclick = () => saveSignIn(bodyEl);
  } else {
    // Clear canvas on re-open
    _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
    el('safety-signin-save').onclick = () => saveSignIn(bodyEl);
  }

  // Populate name dropdown
  api('GET', '/api/users/list').then(users => {
    const sel = el('safety-signin-name-sel');
    const current = currentUser?.full_name || '';
    sel.innerHTML = users.map(u => {
      const n = u.full_name || u.username;
      return `<option value="${escHtml(n)}" ${n === current ? 'selected' : ''}>${escHtml(n)}</option>`;
    }).join('') + '<option value="__other__">Other (type below)…</option>';
    el('safety-signin-name-other').style.display = 'none';
  }).catch(() => {});
}

function closeSafetySigninModal() {
  el('safety-signin-modal').classList.add('hidden');
  _safetySigninMeetingId = null;
}

function initSigCanvas(canvas, ctx) {
  // Always draw black ink on a transparent canvas (the element has a white CSS
  // background so strokes are visible while signing in either theme). Stored
  // PNG is black-on-transparent: in-app dark mode inverts it to white, light
  // mode shows it black, and the PDF export forces black via brightness(0).
  ctx.strokeStyle = '#000';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  const pt = e => {
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - r.left) * (canvas.width  / r.width),
      y: (src.clientY - r.top)  * (canvas.height / r.height),
    };
  };
  const start = e => { _sigDrawing = true; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const draw  = e => { if (!_sigDrawing) return; const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const stop  = ()  => { _sigDrawing = false; };

  canvas.addEventListener('pointerdown',  start);
  canvas.addEventListener('pointermove',  draw);
  canvas.addEventListener('pointerup',    stop);
  canvas.addEventListener('pointerleave', stop);
  canvas.addEventListener('touchstart',   start, { passive: false });
  canvas.addEventListener('touchmove',    draw,  { passive: false });
  canvas.addEventListener('touchend',     stop);
}

async function saveSignIn(bodyEl) {
  const sel    = el('safety-signin-name-sel');
  const isOther = sel.value === '__other__';
  const name   = isOther ? el('safety-signin-name-other').value.trim() : sel.value;
  const errEl  = el('safety-signin-error');
  errEl.classList.add('hidden');

  if (!name) {
    errEl.textContent = 'Please enter your name.';
    errEl.classList.remove('hidden');
    return;
  }

  // Check if canvas has any drawn content
  const blank = !_sigCanvas.toDataURL().includes('data:image/png;base64,iVBOR');
  const sigData = blank ? '' : _sigCanvas.toDataURL('image/png');

  const btn = el('safety-signin-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const meetingId = _safetySigninMeetingId;
    await api('POST', `/api/safety-meetings/${meetingId}/attend`, {
      full_name:      name,
      signature_data: sigData || null,
      signed_date:    el('safety-signin-date').value,
    });
    closeSafetySigninModal();
    showToast('Signed in successfully');
    // Reload attendees in the expanded body
    const data = await api('GET', `/api/safety-meetings/${meetingId}`);
    renderSafetyAttendees(bodyEl.querySelector('.safety-attend-list'), data.attendees || [], meetingId, bodyEl);
    // Update the attendee count badge in the header
    const item = bodyEl.closest('.safety-meeting-item');
    if (item) {
      const countEl = item.querySelector('.safety-attend-count');
      if (countEl) countEl.textContent = `${data.attendees.length} attendee${data.attendees.length !== 1 ? 's' : ''}`;
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save';
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// ── PDF Export ────────────────────────────────────────────────────────────────
function buildSafetySheetHtml(meeting, attendees) {
  const fmtDate  = d => d ? localDateStr(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '—';
  const fmtShort = d => d ? localDateStr(d, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const esc = escHtml;

  // Only render rows for the actual attendees (no blank padding)
  const rows = attendees.length
    ? attendees.map((a, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(a.full_name)}</td>
        <td class="sig">${a.signature_data ? `<img src="${esc(a.signature_data)}" alt="">` : ''}</td>
        <td class="dt">${fmtShort(a.signed_date)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="text-align:center;color:#999;padding:14px">No attendees recorded</td></tr>`;

  return `
    <div class="sf-report-header">
      <img class="sf-logo" src="/icons/kcwa-seal-192.png" alt="KCWA">
      <div class="sf-titles">
        <div class="sf-title">Safety Sign In</div>
        <div class="sf-sub">Kern County Water Agency</div>
      </div>
    </div>
    <table class="sf-meta-table">
      <tr><th>Date</th><td>${fmtDate(meeting.meeting_date)}</td><th>Time</th><td>${meeting.meeting_time ? meeting.meeting_time.slice(0,5) : '—'}</td></tr>
      <tr><th>Topic</th><td>${esc(meeting.topic)}</td><th>Presented By</th><td>${esc(meeting.presented_by || '—')}</td></tr>
      ${meeting.link  ? `<tr><th>Reference</th><td colspan="3">${esc(meeting.link)}</td></tr>` : ''}
      ${meeting.notes ? `<tr><th>Notes</th><td colspan="3">${esc(meeting.notes)}</td></tr>` : ''}
    </table>
    <table class="sf-attend-table">
      <thead><tr><th>#</th><th>Print Name</th><th>Signature</th><th>Date</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sf-footer">Total Attendees: ${attendees.length} &nbsp;|&nbsp; Generated: ${new Date().toLocaleDateString()}</div>`;
}

function exportSafetyMeetingPDF(meeting, attendees) {
  document.getElementById('safety-report-modal')?.remove();

  // Filename: MM-DD-YYYY-Safety-Meeting
  const raw = meeting.meeting_date ? String(meeting.meeting_date).slice(0, 10) : '';
  const [yr, mo, dy] = raw ? raw.split('-') : ['', '', ''];
  const filename = raw ? `${mo}-${dy}-${yr}-Safety-Meeting` : 'Safety-Meeting';

  const contentHtml = buildSafetySheetHtml(meeting, attendees);

  const modal = document.createElement('div');
  modal.id = 'safety-report-modal';
  modal.className = 'report-preview-overlay';
  modal.innerHTML = `
    <div class="report-preview-bar">
      <button class="btn btn-secondary btn-sm" id="sf-rp-close">&times; Close</button>
      <span class="report-preview-bar-title">Safety Sign In</span>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-save btn-sm" id="sf-rp-share">&#8679; Share / Export</button>
      </div>
    </div>
    <div class="report-preview-scroll">
      <div class="ir-content sf-content" id="sf-rp-body">${contentHtml}</div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#sf-rp-close').addEventListener('click', () => modal.remove());

  // Share: render to a real PDF blob and hand off to the OS share sheet
  modal.querySelector('#sf-rp-share').addEventListener('click', async () => {
    const b = modal.querySelector('#sf-rp-share');
    b.disabled = true; b.textContent = 'Generating…';
    try {
      await sharePdfFromElement(modal.querySelector('#sf-rp-body'), filename, 'Safety Sign In');
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Share failed: ' + err.message, 'error');
    } finally {
      b.disabled = false; b.innerHTML = '&#8679; Share / Export';
    }
  });
}

/* ── Global Search ───────────────────────────────────────────────────────── */
const SEARCH_TYPE_ICON = {
  well: 'wells', vehicle: 'vehicles', piezometer: 'piezometers',
  canal: 'canal', building: 'buildings', site: 'location',
  motor: 'equipment', pond: 'gauge',
};
const SEARCH_TYPE_LABEL = {
  well: 'Wells', vehicle: 'Vehicles', piezometer: 'Piezometers',
  canal: 'Canal Structures', building: 'Buildings', site: 'Sites',
  motor: 'Motors', pond: 'Ponds',
};

// Returns all navigation destinations for a result row.
// Each dest: { label, action }
function searchNavTargets(r) {
  const [wellRun, kfFlag] = (r.meta || '').split('|');
  switch (r.type) {
    case 'well': {
      const targets = [{ label: 'Well Readings', action: 'wells' }];
      if (kfFlag === 'kf')
        targets.push({ label: 'KF Monthly', action: 'kf-monthly' });
      if (wellRun === 'DWR')
        targets.push({ label: 'Well Runs – DWR', action: 'wr-dwr' });
      if (wellRun === 'Shallow')
        targets.push({ label: 'Well Runs – Shallow', action: 'wr-shallow' });
      if (wellRun === 'IWV')
        targets.push({ label: 'Well Runs – IWV', action: 'wr-iwv' });
      targets.push({ label: 'Well Issues', action: 'maint-wells' });
      return targets;
    }
    case 'vehicle':
      return [
        { label: 'Vehicle Monthly', action: 'vehicles' },
        { label: 'Maintenance',     action: 'maint-vehicles' },
      ];
    case 'piezometer':
      return [{ label: 'Well Runs – Piezometers', action: 'wr-kcwa' }];
    case 'canal':
      return [{ label: 'Canal Readings', action: 'canal' }];
    case 'building':
      return [{ label: 'Maintenance – Buildings', action: 'maint-buildings' }];
    case 'motor':
      return [{ label: 'Maintenance – Equipment', action: 'maint-equipment' }];
    case 'pond':
      return [{ label: 'Ponds', action: 'ponds' }];
    default:
      return [];
  }
}

let _searchDebounce = null;

function openSearchModal() {
  el('search-modal').classList.remove('hidden');
  el('search-input').value = '';
  el('search-results').innerHTML = '<div class="search-placeholder">Type to search wells, vehicles, buildings, and more…</div>';
  setTimeout(() => el('search-input').focus(), 60);
}

function closeSearchModal() {
  el('search-modal').classList.add('hidden');
}

el('header-search-btn').addEventListener('click', openSearchModal);
el('search-modal-close').addEventListener('click', closeSearchModal);
el('search-modal').addEventListener('click', e => {
  if (e.target === el('search-modal')) closeSearchModal();
});

el('search-input').addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  const q = el('search-input').value.trim();
  if (q.length < 2) {
    el('search-results').innerHTML = '<div class="search-placeholder">Type at least 2 characters…</div>';
    return;
  }
  el('search-results').innerHTML = '<div class="search-placeholder">Searching…</div>';
  _searchDebounce = setTimeout(() => runSearch(q), 280);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !el('search-modal').classList.contains('hidden')) closeSearchModal();
});

async function runSearch(q) {
  try {
    const rows = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(rows);
  } catch (err) {
    el('search-results').innerHTML = `<div class="search-placeholder" style="color:var(--red-light)">Search failed.</div>`;
  }
}

function renderSearchResults(rows) {
  const out = el('search-results');
  if (!rows.length) {
    out.innerHTML = '<div class="search-placeholder">No results found.</div>';
    return;
  }

  // Group by type preserving ORDER BY type,name from server
  const groups = {};
  rows.forEach(r => { (groups[r.type] = groups[r.type] || []).push(r); });

  let html = '';
  for (const [type, items] of Object.entries(groups)) {
    html += `<div class="search-type-header">${SEARCH_TYPE_LABEL[type] || type}</div>`;
    html += items.map(r => {
      const detail  = [r.detail, r.context].filter(Boolean).join(' · ');
      const targets = searchNavTargets(r);
      const chips   = targets.map(t =>
        `<button class="search-nav-chip" data-action="${t.action}">${t.label}</button>`
      ).join('');
      return `<div class="search-result-item">
        <div class="search-result-icon">${icon(SEARCH_TYPE_ICON[type] || 'dashboard', 16)}</div>
        <div class="search-result-body">
          <div class="search-result-name">${r.name}</div>
          ${detail ? `<div class="search-result-detail">${detail}</div>` : ''}
          ${chips ? `<div class="search-nav-chips">${chips}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  out.innerHTML = html;

  out.querySelectorAll('.search-nav-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      navigateToSearchResult(chip.dataset.action);
    });
  });
}

function navigateToSearchResult(action) {
  closeSearchModal();
  const wrPanel = action.startsWith('wr-') ? action.slice(3) : null;
  const maintPanel = action.startsWith('maint-') ? action.slice(6) : null;
  if (wrPanel) {
    showScreen('well-runs');
    setTimeout(() => {
      const btn = document.querySelector(`[data-wr-panel="${wrPanel}"]`);
      if (btn) btn.click();
    }, 80);
  } else if (maintPanel) {
    showScreen('maintenance');
    setTimeout(() => {
      const btn = document.querySelector(`[data-maint-panel="${maintPanel}"]`);
      if (btn) btn.click();
    }, 80);
  } else if (action === 'kf-monthly') {
    showScreen('kf-monthly');
  } else {
    showScreen(action);
  }
}

/* ── Charts ───────────────────────────────────────────────────────────────── */
const CHART_PANEL_TITLES = {
  overpour: 'Overpour', pressure: 'Pressure', 'open-air': 'Open Air', p11: 'P-11',
  gate: 'Gate Discharge', rrb: 'RRB T.O. 1 & 2', pioneer: 'Pioneer Inlet',
};

function openChartsPanel(panelId) {
  el('charts-main').classList.add('hidden');
  document.querySelectorAll('#screen-charts .maint-panel').forEach(p => p.classList.add('hidden'));
  el(`charts-panel-${panelId}`).classList.remove('hidden');
  setPanelNav(el('screen-charts'), closeChartsPanel, 'Charts – ' + (CHART_PANEL_TITLES[panelId] || panelId));
  if (panelId === 'overpour')       initOverpourPanel();
  else if (panelId === 'pressure')  initGatePanel('pressure');
  else if (panelId === 'open-air')  initGatePanel('open-air');
  else if (panelId === 'p11')       initP11Panel();
  else if (panelId === 'gate')      initGateDischargePanel();
  else if (panelId === 'rrb')       initRRBPanel();
  else if (panelId === 'pioneer')   initPioneerPanel();
}

function closeChartsPanel() {
  document.querySelectorAll('#screen-charts .maint-panel').forEach(p => p.classList.add('hidden'));
  el('charts-main').classList.remove('hidden');
  setPanelNav(el('screen-charts'), () => showScreen('dashboard'), 'Charts');
}

function initChartsScreen() {
  closeChartsPanel();
}

// Overpour weir: Q = 3.996 × (W/12) × (H/12)^1.5
function calcOverpour(w, h) {
  return 3.996 * (w / 12) * Math.pow(h / 12, 1.5);
}

function initOverpourPanel() {
  const container = el('overpour-table-container');
  if (!container.dataset.built) {
    const widths = [];
    for (let w = 24; w <= 66; w += 2) widths.push(w);
    const heads = [];
    for (let h = 0.5; h <= 40; h += 0.5) heads.push(+h.toFixed(1));
    let html = '<table class="charts-table"><thead><tr><th>Head (in)</th>';
    widths.forEach(w => { html += `<th>${w}"</th>`; });
    html += '</tr></thead><tbody>';
    heads.forEach(h => {
      html += `<tr><td>${h}</td>`;
      widths.forEach(w => { html += `<td>${calcOverpour(w, h).toFixed(2)}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    container.dataset.built = '1';
  }
  el('overpour-tab-btn-table').onclick = () => switchOverpourTab('table');
  el('overpour-tab-btn-calc').onclick  = () => switchOverpourTab('calc');
  el('overpour-width').oninput = updateOverpourCalc;
  el('overpour-head').oninput  = updateOverpourCalc;
}

function switchOverpourTab(tab) {
  el('overpour-tab-table').style.display = tab === 'table' ? '' : 'none';
  el('overpour-tab-calc').style.display  = tab === 'calc'  ? '' : 'none';
  el('overpour-tab-btn-table').classList.toggle('active', tab === 'table');
  el('overpour-tab-btn-calc').classList.toggle('active',  tab === 'calc');
}

function updateOverpourCalc() {
  const w = parseFloat(el('overpour-width').value);
  const h = parseFloat(el('overpour-head').value);
  el('overpour-result').textContent = (w > 0 && h > 0) ? calcOverpour(w, h).toFixed(2) : '—';
}

// Gate formula: Cd × (W/12) × (O/12) × √(64.4 × H/12)
// Pressure / P-11: Cd = 0.74682 — Open Air free-discharge: Cd = 0.66950
function calcGate(w, o, h, cd = 0.74682) {
  if (!(w > 0 && o > 0 && h > 0)) return null;
  return cd * (w / 12) * (o / 12) * Math.sqrt(64.4 * (h / 12));
}

function initGatePanel(panelId) {
  const pfx = panelId === 'pressure' ? 'pres' : 'oa';
  const cd  = panelId === 'open-air' ? 0.66950 : 0.74682;
  const fixedWidths = [54, 55, 56];
  function update() {
    const h  = parseFloat(el(`${pfx}-head`).value);
    const o  = parseFloat(el(`${pfx}-opening`).value);
    const cw = parseFloat(el(`${pfx}-custom-width`).value);
    fixedWidths.forEach((w, i) => {
      const q = calcGate(w, o, h, cd);
      el(`${pfx}-q${i}`).textContent = q !== null ? q.toFixed(2) : '—';
    });
    const qc = calcGate(cw, o, h, cd);
    el(`${pfx}-qc`).textContent = qc !== null ? qc.toFixed(2) : '—';
  }
  el(`${pfx}-head`).oninput         = update;
  el(`${pfx}-opening`).oninput      = update;
  el(`${pfx}-custom-width`).oninput = update;
}

// P-11: 72" fixed width, head (in) + % open → derives opening inches
function initP11Panel() {
  function update() {
    const h   = parseFloat(el('p11-head').value);
    const pct = parseFloat(el('p11-pct').value);
    const o   = 72 * (pct / 100);
    el('p11-opening-display').textContent = (pct > 0) ? `Opening: ${o.toFixed(1)} in` : '';
    const q = calcGate(72, o, h);
    el('p11-result').textContent = q !== null ? q.toFixed(2) : '—';
  }
  el('p11-head').oninput = update;
  el('p11-pct').oninput  = update;
}

document.querySelectorAll('[data-charts-panel]').forEach(btn => {
  btn.addEventListener('click', () => openChartsPanel(btn.dataset.chartsPanel));
});

// ── Gate Discharge & RRB table data ─────────────────────────────────────
// Keys h=heads(in), o=openings(in), q=flow table(cfs)
const GATE_DATA={"30":{"h":[1,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,4.25,4.5,4.75,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"o":[2,2.5,3,3.5,4,4.5,5,5.5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"q":[[0.84,1.05,1.25,1.43,1.59,1.78,1.93,2.1,2.27,2.6,2.93,3.25,3.55,3.86,4.14,4.43,4.69,4.96,5.23,5.49,5.74,5.98,6.21,6.42,6.62,6.8,6.98,7.14,7.29,7.44,7.58,7.66,7.73],[0.93,1.17,1.39,1.59,1.77,1.99,2.16,2.35,2.54,2.91,3.28,3.64,3.97,4.31,4.63,4.95,5.25,5.55,5.85,6.14,6.42,6.68,6.94,7.17,7.4,7.6,7.8,7.98,8.15,8.31,8.47,8.56,8.64],[1.01,1.27,1.51,1.74,1.94,2.18,2.36,2.57,2.78,3.19,3.59,3.99,4.34,4.72,5.07,5.42,5.75,6.08,6.41,6.72,7.03,7.32,7.61,7.86,8.11,8.33,8.55,8.74,8.93,9.11,9.28,9.37,9.46],[1.09,1.37,1.63,1.87,2.09,2.35,2.55,2.78,3,3.45,3.88,4.3,4.69,5.1,5.48,5.86,6.21,6.57,6.92,7.26,7.59,7.91,8.22,8.49,8.76,9,9.23,9.44,9.64,9.84,10.03,10.13,10.22],[1.16,1.46,1.74,2,2.24,2.51,2.73,2.97,3.21,3.68,4.14,4.6,5.02,5.45,5.86,6.26,6.64,7.02,7.4,7.76,8.12,8.45,8.78,9.07,9.36,9.62,9.87,10.09,10.31,10.52,10.72,10.82,10.92],[1.23,1.54,1.84,2.12,2.37,2.66,2.89,3.15,3.41,3.91,4.4,4.88,5.32,5.78,6.21,6.64,7.04,7.45,7.85,8.23,8.61,8.97,9.32,9.63,9.93,10.2,10.47,10.7,10.93,11.15,11.37,11.48,11.58],[1.29,1.62,1.93,2.23,2.5,2.8,3.05,3.32,3.59,4.12,4.63,5.15,5.61,6.1,6.55,7,7.42,7.85,8.28,8.68,9.07,9.45,9.82,10.15,10.47,10.76,11.04,11.28,11.52,11.76,11.99,12.1,12.21],[1.35,1.7,2.02,2.33,2.62,2.93,3.19,3.48,3.76,4.32,4.86,5.4,5.89,6.39,6.87,7.34,7.78,8.23,8.68,9.1,9.52,9.91,10.3,10.64,10.98,11.28,11.58,11.83,12.08,12.33,12.57,12.69,12.8],[1.4,1.77,2.1,2.43,2.73,3.06,3.34,3.64,3.93,4.51,5.08,5.64,6.15,6.68,7.17,7.67,8.13,8.6,9.07,9.51,9.94,10.35,10.76,11.12,11.47,11.78,12.09,12.36,12.62,12.88,13.13,13.25,13.37],[1.46,1.83,2.19,2.53,2.84,3.18,3.47,3.79,4.09,4.7,5.28,5.87,6.4,6.95,7.47,7.98,8.46,8.95,9.44,9.9,10.35,10.78,11.2,11.57,11.93,12.26,12.58,12.86,13.14,13.41,13.67,13.8,13.92],[1.51,1.9,2.26,2.62,2.95,3.3,3.6,3.93,4.25,4.88,5.48,6.09,6.64,7.21,7.75,8.28,8.78,9.28,9.8,10.27,10.74,11.18,11.62,12,12.38,12.72,13.06,13.35,13.63,13.91,14.18,14.31,14.44],[1.56,1.96,2.34,2.71,3.05,3.41,3.73,4.07,4.4,5.05,5.68,6.3,6.87,7.47,8.02,8.57,9.09,9.61,10.15,10.63,11.11,11.57,12.03,12.43,12.82,13.17,13.52,13.82,14.11,14.4,14.68,14.81,14.94],[1.61,2.02,2.41,2.79,3.15,3.52,3.85,4.2,4.54,5.21,5.86,6.51,7.1,7.71,8.28,8.85,9.39,9.93,10.48,10.98,11.48,11.95,12.42,12.83,13.24,13.6,13.96,14.27,14.57,14.87,15.16,15.3,15.43],[1.66,2.08,2.48,2.88,3.24,3.63,3.97,4.33,4.68,5.37,6.04,6.71,7.32,7.95,8.54,9.13,9.68,10.23,10.8,11.32,11.83,12.32,12.8,13.23,13.65,14.02,14.39,14.71,15.02,15.33,15.63,15.77,15.91],[1.7,2.14,2.55,2.96,3.34,3.73,4.08,4.45,4.82,5.53,6.22,6.91,7.53,8.18,8.79,9.39,9.96,10.53,11.12,11.65,12.17,12.67,13.17,13.61,14.04,14.43,14.81,15.14,15.46,15.77,16.08,16.23,16.37],[1.75,2.19,2.62,3.04,3.43,3.83,4.19,4.58,4.95,5.68,6.39,7.09,7.74,8.4,9.03,9.65,10.23,10.82,11.42,11.97,12.51,13.02,13.53,13.98,14.43,14.82,15.21,15.55,15.88,16.2,16.52,16.67,16.82],[1.79,2.25,2.68,3.11,3.51,3.93,4.3,4.69,5.08,5.83,6.56,7.28,7.94,8.62,9.26,9.9,10.5,11.1,11.72,12.28,12.83,13.36,13.89,14.35,14.8,15.21,15.61,15.95,16.29,16.62,16.95,17.1,17.25],[1.87,2.35,2.81,3.26,3.68,4.12,4.51,4.92,5.32,6.11,6.88,7.63,8.33,9.04,9.71,10.38,11.01,11.64,12.29,12.88,13.46,14.01,14.56,15.04,15.52,15.95,16.37,16.73,17.09,17.44,17.78,17.94,18.09],[1.95,2.45,2.92,3.4,3.84,4.3,4.71,5.14,5.56,6.39,7.18,7.97,8.7,9.45,10.15,10.84,11.5,12.15,12.84,13.45,14.06,14.64,15.21,15.71,16.21,16.66,17.1,17.48,17.85,18.21,18.57,18.73,18.89],[2.03,2.54,3.04,3.53,4,4.47,4.9,5.35,5.79,6.65,7.47,8.3,9.05,9.83,10.56,11.29,11.97,12.65,13.36,14,14.63,15.23,15.83,16.36,16.88,17.34,17.79,18.19,18.58,18.95,19.32,19.49,19.66],[2.1,2.63,3.15,3.66,4.15,4.64,5.08,5.55,6.01,6.9,7.76,8.61,9.4,10.2,10.96,11.71,12.42,13.13,13.87,14.53,15.18,15.81,16.43,16.97,17.51,17.99,18.47,18.88,19.28,19.67,20.05,20.23,20.41],[2.17,2.72,3.25,3.78,4.29,4.8,5.26,5.75,6.22,7.14,8.03,8.92,9.73,10.56,11.34,12.13,12.86,13.59,14.36,15.04,15.71,16.36,17,17.57,18.13,18.62,19.11,19.53,19.95,20.36,20.76,20.94,21.12],[2.23,2.8,3.35,3.9,4.43,4.95,5.43,5.94,6.42,7.37,8.29,9.21,10.05,10.91,11.72,12.52,13.28,14.03,14.83,15.53,16.23,16.9,17.56,18.14,18.72,19.23,19.74,20.18,20.61,21.03,21.44,21.63,21.81],[2.3,2.88,3.45,4.02,4.56,5.1,5.6,6.12,6.62,7.6,8.55,9.49,10.36,11.24,12.08,12.97,13.69,14.47,15.29,16.01,16.73,17.42,18.1,18.7,19.3,19.83,20.35,20.8,21.24,21.67,22.1,22.29,22.48],[2.36,2.96,3.55,4.13,4.69,5.25,5.76,6.3,6.81,7.82,8.8,9.77,10.66,11.57,12.43,13.28,14.08,14.88,15.73,16.47,17.21,17.92,18.63,19.25,19.86,20.4,20.94,21.4,21.86,22.3,22.74,22.94,23.13],[2.42,3.04,3.64,4.24,4.82,5.39,5.91,6.47,7,8.04,9.04,10.03,10.95,11.89,12.77,13.65,14.47,15.29,16.16,16.92,17.68,18.41,19.14,19.77,20.4,20.96,21.51,21.98,22.45,22.91,23.36,23.56,23.76],[2.48,3.11,3.73,4.35,4.94,5.52,6.07,6.64,7.18,8.25,9.27,10.3,11.23,12.2,13.1,14,14.85,15.69,16.58,17.36,18.14,18.89,19.63,20.28,20.93,21.5,22.07,22.56,23.04,23.51,23.97,24.18,24.38],[2.6,3.25,3.9,4.55,5.18,5.79,6.36,6.96,7.53,8.65,9.73,10.8,11.78,12.79,13.74,14.69,15.57,16.46,17.4,18.22,19.03,19.81,20.59,21.27,21.95,22.55,23.15,23.66,24.16,24.65,25.14,25.36,25.57],[2.71,3.39,4.07,4.75,5.41,6.04,6.64,7.27,7.86,9.03,10.16,11.28,12.31,13.36,14.35,15.34,16.26,17.19,18.17,19.02,19.87,20.69,21.51,22.22,22.93,23.56,24.18,24.71,25.24,25.75,26.26,26.48,26.7],[2.81,3.52,4.22,4.93,5.63,6.28,6.91,7.57,8.18,9.4,10.57,11.74,12.81,13.91,14.94,15.97,16.93,17.89,18.91,19.8,20.69,21.54,22.39,23.13,23.86,24.51,25.16,25.72,26.27,26.8,27.33,27.56,27.79],[2.91,3.64,4.37,5.11,5.83,6.52,7.17,7.86,8.49,9.76,10.97,12.18,13.3,14.43,15.5,16.57,17.57,18.56,19.63,20.55,21.47,22.35,23.23,24,24.76,25.44,26.11,26.69,27.26,27.81,28.36,28.6,28.84],[3.01,3.77,4.52,5.29,6.04,6.74,7.42,8.13,8.79,10.1,11.36,12.61,13.76,14.94,16.04,17.15,18.19,19.21,20.32,21.27,22.22,23.14,24.05,24.84,25.63,26.33,27.03,27.62,28.21,28.79,29.36,29.61,29.85],[3.1,3.88,4.66,5.45,6.23,6.96,7.66,8.4,9.08,10.43,11.73,13.03,14.21,15.43,16.57,17.71,18.78,19.84,20.99,21.97,22.95,23.89,24.83,25.65,26.47,27.19,27.91,28.53,29.14,29.73,30.32,30.57,30.82],[3.19,3.99,4.8,5.62,6.42,7.17,7.9,8.66,9.36,10.75,12.09,13.43,14.65,15.9,17.08,18.26,19.36,20.45,21.64,22.65,23.65,24.63,25.6,26.45,27.29,28.03,28.77,29.41,30.04,30.65,31.25,31.51,31.77],[3.28,4.1,4.93,5.77,6.6,7.37,8.12,8.91,9.63,11.07,12.45,13.82,15.08,16.36,17.58,18.79,19.92,21.05,22.26,23.3,24.34,25.34,26.34,27.21,28.08,28.85,29.61,30.26,30.91,31.54,32.16,32.43,32.69],[3.36,4.21,5.06,5.93,6.78,7.57,8.35,9.15,9.89,11.37,12.79,14.19,15.49,16.81,18.06,19.3,20.47,21.62,22.88,23.94,25,26.03,27.06,27.96,28.85,29.64,30.42,31.09,31.75,32.4,33.04,33.31,33.58],[3.45,4.31,5.18,6.07,6.96,7.76,8.56,9.39,10.15,11.67,13.12,14.56,15.89,17.25,18.53,19.8,21,22.18,23.47,24.56,25.65,26.71,27.77,28.69,29.6,30.41,31.21,31.9,32.58,33.24,33.9,34.18,34.45],[3.53,4.41,5.3,6.22,7.12,7.95,8.77,9.62,10.4,11.95,13.44,14.92,16.29,17.67,18.99,20.29,21.52,22.73,24.05,25.17,26.29,27.37,28.45,29.39,30.33,31.16,31.98,32.68,33.38,34.06,34.73,35.02,35.3],[3.61,4.51,5.42,6.36,7.29,8.13,8.98,9.85,10.65,12.24,13.76,15.27,16.67,18.09,19.43,20.77,22.03,23.27,24.62,25.8,26.97,28.05,29.12,30.08,31.04,31.89,32.73,33.45,34.17,34.86,35.55,35.84,36.13],[3.68,4.6,5.54,6.5,7.45,8.31,9.18,10.07,10.89,12.51,14.07,15.62,17.05,18.5,19.87,21.24,22.52,23.79,25.17,26.34,27.51,28.64,29.77,30.76,31.74,32.61,33.47,34.2,34.93,35.64,36.35,36.65,36.94],[3.76,4.7,5.65,6.63,7.61,8.49,9.37,10.28,11.12,12.78,14.37,15.95,17.41,18.9,20.3,21.7,23.01,24.3,25.72,26.91,28.1,29.26,30.41,31.42,32.42,33.31,34.19,34.94,35.68,36.41,37.13,37.43,37.73],[3.83,4.79,5.76,6.76,7.76,8.66,9.56,10.5,11.35,13.04,14.67,16.28,17.77,19.28,20.72,22.14,23.48,24.8,26.25,27.47,28.68,29.86,31.04,32.07,33.09,33.99,34.89,35.66,36.42,37.16,37.9,38.21,38.51],[3.9,4.88,5.87,6.89,7.92,8.83,9.75,10.7,11.57,13.3,14.96,16.61,18.13,19.67,21.13,22.58,23.95,25.29,26.77,28.01,29.25,30.46,31.66,32.71,33.75,34.67,35.58,36.36,37.14,37.9,38.65,38.96,39.27],[3.97,4.96,5.97,7.02,8.06,8.99,9.94,10.91,11.79,13.56,15.25,16.92,18.47,20.04,21.53,23.01,24.4,25.77,27.28,28.55,29.81,31.04,32.26,33.33,34.39,35.33,36.26,37.06,37.86,38.62,39.38,39.7,40.02],[4.04,5.05,6.08,7.14,8.21,9.15,10.12,11.11,12.01,13.81,15.53,17.23,18.81,20.41,21.92,23.43,24.85,26.25,27.78,29.07,30.35,31.6,32.85,33.94,35.02,35.97,36.92,37.73,38.54,39.33,40.11,40.43,40.75],[4.11,5.13,6.18,7.27,8.35,9.31,10.3,11.3,12.22,14.05,15.8,17.54,19.15,20.77,22.31,23.85,25.29,26.71,28.27,29.58,30.89,32.16,33.43,34.54,35.64,36.61,37.58,38.4,39.22,40.02,40.82,41.15,41.47],[4.18,5.22,6.28,7.39,8.49,9.47,10.47,11.5,12.43,14.29,16.07,17.84,19.47,21.13,22.69,24.26,25.72,27.17,28.76,30.09,31.42,32.71,34,35.13,36.25,37.24,38.22,39.06,39.9,40.71,41.52,41.85,42.18]]},"36":{"h":[1,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,4.25,4.5,4.75,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"o":[2,2.5,3,3.5,4,4.5,5,5.5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36],"q":[[0.96,1.21,1.46,1.69,1.91,2.11,2.35,2.55,2.75,3.17,3.57,3.97,4.33,4.69,5.06,5.42,5.74,6.07,6.43,6.74,7.04,7.36,7.67,7.97,8.27,8.53,8.78,8.99,9.2,9.41,9.61,9.77,9.93,10.06,10.19,10.32,10.44,10.53,10.61],[1.07,1.35,1.63,1.88,2.13,2.36,2.63,2.86,3.07,3.57,3.99,4.44,4.84,5.24,5.66,6.06,6.42,6.79,7.19,7.53,7.87,8.22,8.57,8.91,9.24,9.53,9.82,10.06,10.29,10.52,10.75,10.93,11.1,11.25,11.4,11.54,11.67,11.77,11.86],[1.17,1.47,1.77,2.05,2.33,2.58,2.88,3.13,3.36,3.88,4.37,4.87,5.3,5.74,6.2,6.63,7.03,7.43,7.87,8.25,8.62,9.01,9.39,9.76,10.13,10.45,10.76,11.02,11.27,11.52,11.77,11.97,12.16,12.32,12.48,12.64,12.79,12.9,13],[1.25,1.58,1.91,2.21,2.51,2.79,3.11,3.38,3.63,4.19,4.72,5.26,5.73,6.2,6.7,7.16,7.59,8.03,8.51,8.91,9.31,9.73,10.15,10.55,10.94,11.28,11.62,11.9,12.18,12.45,12.72,12.93,13.14,13.31,13.48,13.65,13.81,13.93,14.04],[1.34,1.69,2.04,2.36,2.68,2.98,3.32,3.61,3.88,4.48,5.04,5.62,6.12,6.63,7.16,7.66,8.12,8.58,9.09,9.52,9.95,10.4,10.85,11.27,11.69,12.06,12.43,12.73,13.02,13.31,13.6,13.83,14.05,14.23,14.41,14.59,14.77,14.89,15.01],[1.41,1.79,2.16,2.5,2.84,3.16,3.52,3.83,4.12,4.75,5.35,5.96,6.49,7.03,7.6,8.12,8.61,9.11,9.65,10.11,10.56,11.04,11.51,11.96,12.4,12.79,13.18,13.5,13.81,14.12,14.42,14.66,14.9,15.1,15.29,15.48,15.66,15.79,15.92],[1.49,1.88,2.27,2.63,2.99,3.33,3.71,4.04,4.34,5.01,5.64,6.29,6.85,7.41,8.01,8.56,9.08,9.6,10.17,10.65,11.13,11.63,12.13,12.61,13.08,13.49,13.89,14.23,14.56,14.88,15.2,15.46,15.71,15.91,16.11,16.31,16.51,16.61,16.7],[1.56,1.97,2.37,2.75,3.13,3.49,3.88,4.24,4.55,5.26,5.91,6.59,7.18,7.77,8.4,8.98,9.52,10.07,10.66,11.17,11.67,12.2,12.73,13.23,13.72,14.15,14.57,14.92,15.27,15.61,15.95,16.22,16.48,16.69,16.9,17.11,17.32,17.46,17.6],[1.62,2.05,2.47,2.87,3.26,3.64,4.06,4.42,4.75,5.49,6.18,6.89,7.5,8.12,8.77,9.38,9.94,10.51,11.14,11.67,12.19,12.74,13.29,13.81,14.33,14.78,15.22,15.59,15.95,16.31,16.66,16.94,17.21,17.43,17.65,17.87,18.09,18.24,18.38],[1.69,2.13,2.57,2.98,3.39,3.79,4.22,4.61,4.95,5.71,6.43,7.17,7.81,8.45,9.13,9.76,10.35,10.94,11.59,12.14,12.69,13.27,13.84,14.38,14.91,15.38,15.84,16.23,16.61,16.98,17.34,17.63,17.91,18.14,18.37,18.6,18.83,18.98,19.13],[1.75,2.21,2.66,3.09,3.52,3.93,4.38,4.78,5.14,5.93,6.67,7.44,8.1,8.77,9.48,10.13,10.74,11.36,12.03,12.6,13.17,13.77,14.36,14.92,15.47,15.96,16.44,16.84,17.23,17.61,17.99,18.29,18.59,18.83,19.06,19.3,19.54,19.7,19.85],[1.81,2.28,2.75,3.2,3.64,4.07,4.53,4.95,5.32,6.14,6.9,7.7,8.39,9.08,9.81,10.48,11.12,11.76,12.46,13.05,13.63,14.25,14.86,15.44,16.02,16.52,17.02,17.43,17.84,18.24,18.63,18.94,19.24,19.49,19.73,19.98,20.23,20.39,20.55],[1.86,2.35,2.84,3.3,3.75,4.2,4.68,5.11,5.49,6.34,7.13,7.95,8.66,9.38,10.13,10.83,11.48,12.14,12.86,13.47,14.08,14.72,15.35,15.95,16.54,17.06,17.58,18.01,18.43,18.84,19.24,19.56,19.87,20.13,20.38,20.64,20.89,21.06,21.23],[1.92,2.42,2.92,3.4,3.87,4.33,4.82,5.27,5.66,6.54,7.35,8.2,8.93,9.67,10.44,11.16,11.84,12.52,13.26,13.89,14.51,15.17,15.82,16.44,17.05,17.59,18.12,18.56,18.99,19.41,19.83,20.16,20.49,20.75,21.01,21.27,21.53,21.71,21.88],[1.97,2.49,3.01,3.49,3.98,4.45,4.96,5.42,5.82,6.73,7.56,8.44,9.19,9.95,10.75,11.48,12.18,12.88,13.65,14.29,14.93,15.61,16.28,16.92,17.55,18.1,18.64,19.09,19.54,19.98,20.41,20.75,21.08,21.35,21.61,21.89,22.16,22.34,22.51],[2.02,2.55,3.08,3.59,4.08,4.57,5.09,5.57,5.98,6.91,7.77,8.67,9.44,10.22,11.04,11.8,12.51,13.23,14.02,14.68,15.34,16.04,16.73,17.38,18.03,18.59,19.15,19.62,20.08,20.53,20.97,21.32,21.66,21.94,22.21,22.49,22.76,22.95,23.13],[2.07,2.52,3.16,3.68,4.19,4.69,5.22,5.71,6.14,7.09,7.97,8.89,9.68,10.48,11.33,12.11,12.84,13.58,14.38,15.06,15.74,16.46,17.17,17.84,18.5,19.08,19.65,20.13,20.6,21.06,21.51,21.87,22.22,22.5,22.78,23.07,23.36,23.55,23.73],[2.17,2.74,3.31,3.85,4.39,4.92,5.48,5.99,6.44,7.44,8.36,9.33,10.16,11,11.88,12.7,13.47,14.24,15.09,15.8,16.51,17.26,18,18.7,19.4,20.01,20.61,21.11,21.61,22.09,22.56,22.94,23.31,23.6,23.89,24.2,24.5,24.7,24.89],[2.26,2.85,3.45,4.02,4.58,5.13,5.72,6.26,6.72,7.77,8.73,9.74,10.61,11.48,12.41,13.26,14.07,14.87,15.76,16.5,17.24,18.03,18.81,19.54,20.27,20.9,21.53,22.05,22.57,23.07,23.57,23.96,24.35,24.66,24.96,25.28,25.59,25.8,26],[2.35,2.97,3.58,4.18,4.76,5.34,5.95,6.51,7,8.08,9.09,10.14,11.04,11.95,12.92,13.8,14.64,15.48,16.4,17.18,17.95,18.77,19.58,20.34,21.1,21.76,22.41,22.96,23.5,24.02,24.53,24.94,25.34,25.66,25.97,26.3,26.63,26.85,27.06],[2.43,3.07,3.71,4.33,4.93,5.54,6.17,6.76,7.26,8.39,9.43,10.52,11.46,12.41,13.41,14.32,15.19,16.06,17.02,17.83,18.63,19.47,20.31,21.1,21.89,22.58,23.26,23.83,24.39,24.93,25.46,25.88,26.3,26.63,26.95,27.3,27.64,27.86,28.08],[2.52,3.18,3.84,4.48,5.1,5.73,6.39,7,7.51,8.69,9.76,10.89,11.86,12.84,13.88,14.82,15.73,16.63,17.62,18.45,19.28,20.16,21.03,21.85,22.66,23.37,24.07,24.66,25.24,25.8,26.36,26.79,27.22,27.56,27.9,28.26,28.61,28.84,29.07],[2.6,3.28,3.96,4.62,5.26,5.92,6.59,7.22,7.76,8.97,10.08,11.25,12.25,13.26,14.34,15.31,16.24,17.17,18.2,19.06,19.91,20.82,21.72,22.57,23.41,24.14,24.86,25.47,26.07,26.65,27.22,27.67,28.12,28.47,28.81,29.18,29.55,29.79,30.02],[2.67,3.37,4.08,4.76,5.42,6.1,6.79,7.45,8,9.25,10.39,11.6,12.63,13.67,14.78,15.78,16.74,17.7,18.76,19.65,20.53,21.46,22.39,23.26,24.13,24.88,25.63,26.26,26.88,27.47,28.06,28.52,28.98,29.34,29.7,30.08,30.46,30.71,30.95],[2.75,3.41,4.19,4.89,5.58,6.28,6.99,7.66,8.23,9.52,10.69,11.93,13,14.07,15.21,16.24,17.23,18.22,19.3,20.21,21.12,22.08,23.04,23.94,24.83,25.6,26.37,27.02,27.66,28.27,28.88,29.36,29.83,30.2,30.56,30.95,31.34,31.59,31.84],[2.82,3.56,4.3,5.02,5.72,6.45,7.18,7.87,8.46,9.78,10.99,12.26,13.35,14.45,15.62,16.68,17.7,18.72,19.83,20.77,21.7,22.69,23.67,24.59,25.51,26.31,27.1,27.76,28.42,29.05,29.67,30.16,30.64,31.02,31.4,31.8,32.2,32.46,32.72],[2.89,3.65,4.41,5.15,5.87,6.61,7.36,8.08,8.68,10.03,11.27,12.58,13.7,14.83,16.03,17.12,18.16,19.2,20.35,21.31,22.26,23.28,24.29,25.23,26.17,26.99,27.8,28.48,29.16,29.8,30.44,30.94,31.44,31.83,32.21,32.63,33.04,33.31,33.57],[3.02,3.82,4.61,5.39,6.15,6.93,7.72,8.47,9.1,10.52,11.82,13.19,14.37,15.55,16.81,17.95,19.05,20.14,21.34,22.35,23.35,24.41,25.47,26.46,27.45,28.31,29.16,29.87,30.58,31.26,31.93,32.46,32.98,33.38,33.78,34.22,34.65,34.93,35.21],[3.15,3.98,4.81,5.62,6.42,7.24,8.06,8.85,9.5,10.99,12.35,13.78,15.01,16.24,17.56,18.75,19.89,21.04,22.29,23.34,24.39,25.5,26.61,27.61,28.61,29.53,30.45,31.2,31.94,32.65,33.35,33.9,34.45,34.87,35.29,35.74,36.19,36.48,36.77],[3.21,4.13,5,5.85,6.67,7.53,8.38,9.21,9.89,11.44,12.85,14.34,15.63,16.91,18.28,19.51,20.71,21.9,23.21,24.3,25.38,26.54,27.7,28.77,29.84,30.77,31.7,32.48,33.25,33.98,34.71,35.28,35.85,36.29,36.73,37.2,37.67,37.97,38.27],[3.39,4.28,5.18,6.06,6.92,7.81,8.7,9.56,10.26,11.87,13.33,14.89,16.22,17.55,18.97,20.25,21.49,22.72,24.08,25.21,26.34,27.54,28.74,29.86,30.97,31.94,32.9,33.71,34.51,35.27,36.03,36.62,37.21,37.66,38.11,38.61,39.1,39.41,39.72],[3.51,4.43,5.35,6.27,7.15,8.08,9,9.89,10.62,12.29,13.8,15.41,16.79,18.16,19.64,20.96,22.24,23.52,24.93,26.1,27.27,28.51,29.75,30.91,32.06,33.06,34.05,34.89,35.72,36.51,37.29,37.91,38.52,38.99,39.45,39.93,40.41,40.76,41.11],[3.62,4.56,5.52,6.41,7.38,8.34,9.29,10.22,10.97,12.69,14.25,15.92,17.34,18.76,20.28,21.65,22.97,24.29,25.75,26.96,28.16,29.45,30.73,31.92,33.11,34.14,35.17,36.03,36.89,37.71,38.52,39.15,39.78,40.26,40.74,41.27,41.8,42.13,42.46],[3.72,4.7,5.68,6.66,7.6,8.6,9.58,10.53,11.31,13.08,14.69,16.41,17.87,19.34,20.91,22.31,23.68,25.04,26.54,27.79,29.03,30.36,31.68,32.91,34.13,35.19,36.25,37.14,38.03,38.87,39.7,40.36,41.01,41.5,41.99,42.54,43.08,43.43,43.77],[3.83,4.83,5.84,6.85,7.82,8.85,9.85,10.84,11.64,13.46,15.12,16.88,18.39,19.9,21.51,22.96,24.37,25.77,27.31,28.59,29.87,31.24,32.6,33.86,35.12,36.21,37.3,38.22,39.14,40,40.86,41.53,42.2,42.71,43.21,43.77,44.33,44.69,45.04],[3.93,4.96,5.99,7.03,8.03,9.09,10.12,11.13,11.95,13.83,15.53,17.34,18.89,20.44,22.1,23.59,25.04,26.47,28.06,29.38,30.69,32.09,33.49,34.79,36.09,37.21,38.33,39.27,40.21,41.1,41.98,42.67,43.36,43.88,44.4,44.98,45.55,45.92,46.28],[4.02,5.08,6.14,7.2,8.23,9.32,10.38,11.42,12.26,14.19,15.94,17.8,19.39,20.97,22.68,24.2,25.69,27.16,28.79,30.14,31.49,32.93,34.36,35.7,37.03,38.18,39.32,40.29,41.26,42.17,43.07,43.78,44.48,45.02,45.55,46.14,46.73,47.11,47.48],[4.12,5.2,6.29,7.38,8.43,9.55,10.63,11.7,12.57,14.54,16.33,18.24,19.86,21.49,23.24,24.8,26.32,27.83,29.5,30.89,32.27,33.74,35.21,36.58,37.94,39.12,40.3,41.29,42.28,43.21,44.13,44.86,45.58,46.13,46.67,47.28,47.89,48.27,48.65],[4.21,5.32,6.43,7.54,8.62,9.77,10.88,11.98,12.86,14.88,16.71,18.61,20.33,22,23.79,25.38,26.94,28.49,30.2,31.61,33.02,34.53,36.04,37.44,38.83,40.04,41.24,42.26,43.27,44.19,45.11,45.89,46.66,47.22,47.77,48.4,49.02,49.41,49.8],[4.3,5.43,6.57,7.71,8.81,9.99,11.12,12.25,13.15,15.22,17.09,19.09,20.79,22.49,24.32,25.95,27.55,29.13,30.88,32.33,33.77,35.31,36.85,38.28,39.71,40.94,42.17,43.21,44.25,45.22,46.19,46.95,47.71,48.28,48.84,49.48,50.12,50.52,50.92],[4.39,5.54,6.71,7.87,9,10.2,11.36,12.51,13.43,15.55,17.46,19.5,21.24,22.98,24.85,26.51,28.14,29.75,31.54,33.02,34.49,36.07,37.65,39.11,40.56,41.82,43.08,44.14,45.2,46.2,47.19,47.96,48.73,49.31,49.89,50.55,51.2,51.61,52.01],[4.48,5.65,6.84,8.03,9.18,10.41,11.59,12.77,13.71,15.87,17.81,19.9,21.68,23.45,25.36,27.05,28.72,30.37,32.19,33.7,35.2,36.81,38.42,39.91,41.4,42.69,43.97,45.05,46.13,47.15,48.16,48.95,49.74,50.33,50.92,51.59,52.25,52.67,53.08],[4.56,5.76,6.97,8.18,9.36,10.61,11.82,13.02,13.98,16.18,18.17,20.29,22.11,23.92,25.86,27.59,29.29,30.97,32.83,34.37,35.9,37.55,39.19,40.71,42.22,43.53,44.84,45.95,47.05,48.09,49.12,49.93,50.73,51.33,51.93,52.61,53.29,53.72,54.14],[4.64,5.86,7.09,8.33,9.53,10.81,12.04,13.27,14.25,16.49,18.51,20.68,22.53,24.37,26.36,28.11,29.85,31.56,33.46,35.03,36.59,38.26,39.93,41.48,43.03,44.37,45.7,46.83,47.95,49,50.05,50.87,51.69,52.31,52.92,53.61,54.3,54.74,55.17],[4.73,5.96,7.22,8.48,9.7,11.01,12.26,13.51,14.51,16.79,18.85,21.06,22.94,24.82,26.84,28.63,30.4,32.14,34.07,35.67,37.26,38.97,40.67,42.25,43.82,45.18,46.53,47.68,48.83,49.87,50.91,51.78,52.64,53.27,53.89,54.6,55.3,55.74,56.18],[4.81,6.01,7.34,8.63,9.87,11.2,12.41,13.75,14.77,17.09,19.19,21.43,23.35,25.26,27.32,29.14,30.93,32.71,34.67,36.3,37.92,39.66,41.39,42.99,44.59,45.98,47.36,48.53,49.69,50.79,51.88,52.73,53.58,54.21,54.84,55.56,56.28,56.73,57.18],[4.88,6.11,7.46,8.77,10.03,11.39,12.69,13.99,15.02,17.38,19.51,21.8,23.75,25.69,27.78,29.63,31.46,33.27,35.27,36.92,38.57,40.34,42.1,43.73,45.36,46.77,48.17,49.36,50.55,51.66,52.76,53.63,54.49,55.14,55.78,56.51,57.24,57.7,58.15]]},"42":{"h":[1,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,4.25,4.5,4.75,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"o":[2,2.5,3,3.5,4,4.5,5,5.5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42],"q":[[1.07,1.38,1.72,1.95,2.25,2.54,2.71,2.96,3.23,3.73,4.24,4.68,5.15,5.59,6.01,6.43,6.84,7.25,7.65,8.04,8.42,8.8,9.18,9.55,9.92,10.27,10.62,10.9,11.18,11.46,11.74,11.97,12.2,12.42,12.65,12.81,12.97,13.12,13.28,13.41,13.53,13.66,13.78,13.84,13.89],[1.19,1.54,1.91,2.18,2.5,2.83,3.03,3.31,3.61,4.17,4.74,5.23,5.76,6.25,6.72,7.18,7.64,8.1,8.56,8.99,9.41,9.84,10.26,10.68,11.09,11.48,11.87,12.19,12.5,12.82,13.13,13.38,13.64,13.89,14.14,14.32,14.5,14.67,14.85,14.99,15.13,15.27,15.41,15.48,15.54],[1.31,1.68,2.08,2.38,2.73,3.09,3.32,3.62,3.95,4.56,5.19,5.73,6.31,6.84,7.36,7.87,8.37,8.87,9.37,9.84,10.31,10.78,11.24,11.7,12.15,12.58,13,13.35,13.7,14.04,14.39,14.67,14.94,15.22,15.49,15.69,15.88,16.08,16.27,16.43,16.58,16.74,16.89,16.96,17.02],[1.41,1.81,2.24,2.56,2.94,3.33,3.58,3.91,4.27,4.93,5.61,6.19,6.81,7.39,7.95,8.5,9.04,9.58,10.12,10.63,11.14,11.64,12.14,12.63,13.12,13.58,14.04,14.42,14.79,15.17,15.54,15.84,16.14,16.43,16.73,16.94,17.15,17.36,17.57,17.74,17.91,18.07,18.24,18.32,18.39],[1.5,1.92,2.38,2.73,3.14,3.55,3.83,4.18,4.56,5.27,5.99,6.62,7.29,7.9,8.5,9.09,9.67,10.25,10.82,11.37,11.91,12.44,12.97,13.5,14.03,14.52,15.01,15.41,15.82,16.22,16.62,16.94,17.25,17.57,17.88,18.11,18.33,18.56,18.78,18.96,19.14,19.32,19.5,19.58,19.66],[1.59,2.04,2.52,2.89,3.32,3.76,4.06,4.43,4.84,5.59,6.36,7.02,7.73,8.38,9.02,9.64,10.25,10.87,11.48,12.06,12.63,13.2,13.76,14.32,14.88,15.4,15.92,16.35,16.77,17.2,17.62,17.96,18.29,18.63,18.96,19.2,19.44,19.68,19.92,20.11,20.31,20.5,20.69,20.77,20.85],[1.67,2.14,2.65,3.04,3.5,3.95,4.28,4.67,5.1,5.89,6.7,7.4,8.14,8.84,9.51,10.16,10.81,11.46,12.1,12.71,13.32,13.91,14.5,15.09,15.68,16.23,16.78,17.23,17.68,18.13,18.58,18.93,19.29,19.64,19.99,20.24,20.5,20.75,21,21.2,21.41,21.61,21.81,21.9,21.98],[1.75,2.24,2.77,3.19,3.66,4.14,4.49,4.9,5.35,6.18,7.03,7.76,8.54,9.27,9.97,10.65,11.33,12.01,12.69,13.33,13.97,14.59,15.21,15.83,16.45,17.03,17.6,18.07,18.55,19.02,19.49,19.86,20.23,20.59,20.96,21.23,21.5,21.76,22.03,22.24,22.46,22.67,22.88,22.97,23.05],[1.83,2.34,2.88,3.32,3.82,4.32,4.69,5.12,5.59,6.45,7.34,8.11,8.92,9.68,10.41,11.13,11.84,12.55,13.26,13.93,14.59,15.24,15.88,16.53,17.18,17.78,18.38,18.87,19.37,19.86,20.35,20.74,21.12,21.51,21.89,22.17,22.45,22.73,23.01,23.23,23.45,23.67,23.89,23.99,24.08],[1.9,2.43,2.99,3.45,3.97,4.49,4.88,5.33,5.82,6.72,7.64,8.44,9.29,10.07,10.84,11.58,12.32,13.06,13.8,14.5,15.19,15.86,16.53,17.21,17.88,18.51,19.13,19.65,20.16,20.68,21.19,21.59,21.99,22.38,22.78,23.07,23.37,23.66,23.95,24.18,24.41,24.64,24.87,24.97,25.06],[1.97,2.52,3.1,3.58,4.11,4.65,5.06,5.53,6.04,6.97,7.93,8.76,9.64,10.45,11.25,12.02,12.78,13.55,14.32,15.04,15.76,16.46,17.15,17.86,18.56,19.21,19.85,20.39,20.92,21.46,21.99,22.4,22.82,23.23,23.64,23.95,24.25,24.56,24.86,25.1,25.34,25.57,25.81,25.91,26.01],[2.04,2.6,3.2,3.7,4.25,4.81,5.24,5.72,6.25,7.21,8.2,9.06,9.98,10.82,11.65,12.44,13.23,14.03,14.82,15.57,16.32,17.04,17.76,18.49,19.21,19.88,20.55,21.1,21.66,22.21,22.76,23.19,23.62,24.04,24.47,24.79,25.1,25.42,25.73,25.98,26.23,26.47,26.72,26.82,26.92],[2.1,2.68,3.3,3.82,4.39,4.96,5.41,5.91,6.46,7.45,8.47,9.36,10.3,11.18,12.03,12.85,13.67,14.49,15.31,16.08,16.85,17.6,18.34,19.09,19.84,20.53,21.22,21.79,22.37,22.94,23.51,23.95,24.39,24.83,25.27,25.6,25.92,26.25,26.57,26.83,27.09,27.34,27.6,27.7,27.8],[2.16,2.76,3.4,3.93,4.52,5.1,5.58,6.09,6.66,7.68,8.73,9.65,10.62,11.52,12.4,13.25,14.09,14.94,15.78,16.58,17.37,18.14,18.9,19.68,20.45,21.16,21.87,22.46,23.05,23.64,24.23,24.69,25.14,25.6,26.05,26.39,26.72,27.06,27.39,27.66,27.92,28.19,28.45,28.56,28.66],[2.23,2.84,3.49,4.04,4.65,5.25,5.74,6.27,6.85,7.9,8.99,9.93,10.93,11.85,12.76,13.63,14.49,15.37,16.24,17.06,17.88,18.67,19.45,20.25,21.05,21.78,22.5,23.11,23.72,24.33,24.94,25.41,25.87,26.34,26.8,27.15,27.5,27.84,28.19,28.46,28.73,29,29.27,29.38,29.49],[2.29,2.91,3.58,4.15,4.77,5.38,5.89,6.44,7.04,8.12,9.23,10.2,11.23,12.18,13.11,14,14.89,15.79,16.68,17.53,18.37,19.18,19.98,20.8,21.62,22.37,23.12,23.75,24.37,25,25.62,26.1,26.58,27.06,27.54,27.9,28.25,28.61,28.96,29.24,29.52,29.79,30.07,30.19,30.3],[2.34,2.98,3.67,4.26,4.89,5.52,6.05,6.61,7.22,8.33,9.47,10.47,11.52,12.5,13.45,14.37,15.28,16.2,17.11,17.98,18.84,19.67,20.5,21.35,22.19,22.96,23.72,24.36,25.01,25.65,26.29,26.78,27.27,27.76,28.25,28.62,28.98,29.35,29.71,30,30.29,30.57,30.86,30.98,31.09],[2.45,3.12,3.83,4.46,5.12,5.78,6.34,6.93,7.58,8.74,9.94,10.98,12.08,13.11,14.11,15.07,16.02,16.99,17.95,18.86,19.77,20.64,21.5,22.39,23.27,24.08,24.88,25.55,26.23,26.9,27.57,28.09,28.6,29.12,29.63,30.01,30.4,30.78,31.16,31.46,31.77,32.07,32.37,32.49,32.61],[2.56,3.26,3.99,4.65,5.34,6.03,6.62,7.24,7.91,9.12,10.38,11.47,12.62,13.69,14.73,15.73,16.73,17.74,18.75,19.7,20.65,21.55,22.45,23.38,24.3,25.14,25.98,26.69,27.39,28.1,28.8,29.34,29.87,30.41,30.94,31.34,31.75,32.15,32.55,32.87,33.18,33.5,33.81,33.94,34.06],[2.66,3.38,4.15,4.83,5.55,6.26,6.89,7.53,8.24,9.5,10.8,11.93,13.13,14.25,15.34,16.38,17.42,18.47,19.51,20.5,21.49,22.43,23.37,24.34,25.3,26.17,27.04,27.78,28.51,29.25,29.98,30.54,31.1,31.65,32.21,32.63,33.05,33.46,33.88,34.21,34.54,34.86,35.19,35.32,35.45],[2.76,3.51,4.3,5.01,5.75,6.49,7.15,7.82,8.55,9.86,11.21,12.38,13.63,14.78,15.92,17,18.07,19.16,20.25,21.28,22.3,23.28,24.25,25.25,26.25,27.16,28.06,28.82,29.59,30.35,31.11,31.69,32.27,32.84,33.42,33.86,34.29,34.73,35.16,35.5,35.84,36.18,36.52,36.66,36.79],[2.85,3.62,4.44,5.18,5.95,6.71,7.4,8.09,8.85,10.2,11.6,12.82,14.11,15.3,16.48,17.6,18.71,19.84,20.96,22.03,23.09,24.1,25.1,26.14,27.17,28.11,29.04,29.83,30.62,31.41,32.2,32.8,33.4,33.99,34.59,35.04,35.5,35.95,36.4,36.75,37.1,37.45,37.8,37.94,38.08],[2.94,3.74,4.57,5.34,6.13,6.92,7.64,8.36,9.14,10.54,11.98,13.24,14.57,15.8,17.02,18.17,19.32,20.49,21.65,22.75,23.85,24.89,25.92,27,28.07,29.03,29.99,30.81,31.63,32.44,33.26,33.88,34.49,35.11,35.72,36.19,36.66,37.12,37.59,37.95,38.32,38.68,39.04,39.19,39.33],[3.03,3.85,4.71,5.5,6.32,7.12,7.88,8.61,9.42,10.86,12.35,13.65,15.02,16.29,17.54,18.73,19.91,21.12,22.32,23.45,24.58,25.65,26.72,27.83,28.93,29.92,30.91,31.76,32.6,33.45,34.29,34.92,35.56,36.19,36.82,37.3,37.79,38.27,38.75,39.13,39.5,39.88,40.25,40.4,40.54],[3.12,3.95,4.83,5.65,6.49,7.32,8.1,8.86,9.69,11.17,12.71,14.04,15.46,16.76,18.05,19.27,20.49,21.73,22.96,24.13,25.29,26.39,27.49,28.63,29.77,30.79,31.81,32.68,33.55,34.41,35.28,35.93,36.59,37.24,37.89,38.39,38.89,39.38,39.88,40.27,40.65,41.04,41.42,41.57,41.72],[3.2,4.06,4.96,5.8,6.66,7.52,8.33,9.11,9.96,11.48,13.06,14.43,15.88,17.22,18.55,19.8,21.05,22.32,23.59,24.79,25.99,27.12,28.24,29.42,30.59,31.64,32.68,33.57,34.47,35.36,36.25,36.92,37.59,38.25,38.92,39.43,39.95,40.46,40.97,41.37,41.76,42.16,42.55,42.71,42.86],[3.28,4.16,5.08,5.95,6.83,7.7,8.54,9.34,10.22,11.78,13.4,14.8,16.29,17.67,19.03,20.32,21.6,22.91,24.21,25.44,26.66,27.82,28.97,30.18,31.38,32.46,33.53,34.45,35.36,36.28,37.19,37.88,38.56,39.25,39.93,40.46,40.98,41.51,42.03,42.44,42.85,43.25,43.66,43.82,43.98],[3.44,4.35,5.31,6.23,7.15,8.07,8.96,9.8,10.72,12.35,14.05,15.53,17.09,18.53,19.96,21.31,22.65,24.02,25.39,26.68,27.97,29.18,30.39,31.65,32.91,34.04,35.16,36.12,37.09,38.05,39.01,39.73,40.45,41.16,41.88,42.43,42.99,43.54,44.09,44.52,44.94,45.37,45.79,45.96,46.13],[3.58,4.54,5.54,6.5,7.46,8.41,9.35,10.23,11.2,12.9,14.67,16.22,17.85,19.36,20.85,22.26,23.66,25.09,26.52,27.87,29.21,30.48,31.74,33.06,34.38,35.55,36.72,37.73,38.74,39.74,40.75,41.5,42.25,42.99,43.74,44.32,44.9,45.47,46.05,46.5,46.94,47.39,47.83,48.01,48.18],[3.73,4.72,5.75,6.76,7.75,8.74,9.73,10.65,11.65,13.43,15.27,16.88,18.57,20.15,21.7,23.16,24.62,26.11,27.6,29.01,30.41,31.72,33.03,34.41,35.78,37,38.22,39.27,40.32,41.36,42.41,43.19,43.97,44.74,45.52,46.12,46.73,47.33,47.93,48.4,48.86,49.33,49.79,49.97,50.15],[3.86,4.89,5.95,7,8.04,9.06,10.1,11.05,12.09,13.94,15.85,17.52,19.28,20.91,22.52,24.04,25.55,27.1,28.64,30.1,31.56,32.92,34.27,35.71,37.14,38.4,39.66,40.75,41.84,42.93,44.02,44.83,45.63,46.44,47.24,47.87,48.49,49.12,49.74,50.22,50.71,51.19,51.67,51.86,52.04],[3.99,5.05,6.15,7.24,8.31,9.37,10.45,11.44,12.52,14.42,16.4,18.13,19.95,21.64,23.31,24.88,26.45,28.05,29.65,31.16,32.67,34.08,35.48,36.96,38.44,39.75,41.05,42.18,43.31,44.43,45.56,46.39,47.23,48.06,48.89,49.54,50.19,50.84,51.49,51.99,52.49,52.99,53.49,53.68,53.87],[4.12,5.21,6.34,7.47,8.57,9.66,10.8,11.82,12.93,14.9,16.94,18.73,20.61,22.35,24.07,25.69,27.31,28.97,30.62,32.18,33.74,35.19,36.64,38.17,39.7,41.05,42.39,43.56,44.73,45.89,47.06,47.92,48.78,49.63,50.49,51.16,51.84,52.51,53.18,53.7,54.21,54.73,55.24,55.44,55.64],[4.24,5.36,6.52,7.69,8.83,9.95,11.13,12.18,13.33,15.36,17.46,19.31,21.24,23.04,24.82,26.49,28.15,29.86,31.56,33.17,34.78,36.27,37.76,39.34,40.92,42.31,43.7,44.9,46.11,47.31,48.51,49.39,50.28,51.16,52.04,52.74,53.43,54.13,54.82,55.35,55.89,56.42,56.95,57.15,57.35],[4.36,5.51,6.7,7.91,9.07,10.22,11.45,12.53,13.72,15.8,17.97,19.87,21.86,23.71,25.54,27.26,28.97,30.73,32.48,34.14,35.79,37.33,38.86,40.49,42.11,43.54,44.96,46.2,47.44,48.68,49.92,50.83,51.74,52.64,53.55,54.27,54.98,55.7,56.41,56.96,57.51,58.05,58.6,58.81,59.02],[4.48,5.65,6.87,8.12,9.31,10.49,11.76,12.88,14.09,16.23,18.46,20.41,22.46,24.36,26.24,28,29.76,31.57,33.37,35.07,36.77,38.35,39.92,41.6,43.27,44.73,46.19,47.47,48.74,50.02,51.29,52.22,53.16,54.09,55.02,55.76,56.49,57.23,57.96,58.52,59.09,59.65,60.21,60.42,60.63],[4.59,5.79,7.04,8.32,9.55,10.76,12.07,13.21,14.46,16.65,18.94,20.94,23.04,24.99,26.92,28.73,30.53,32.39,34.24,35.99,37.73,39.35,40.96,42.68,44.39,45.89,47.39,48.7,50.01,51.31,52.62,53.58,54.53,55.49,56.44,57.2,57.96,58.71,59.47,60.05,60.62,61.2,61.77,61.99,62.21],[4.7,5.93,7.2,8.52,9.78,11.01,12.36,13.54,14.82,17.07,19.41,21.46,23.61,25.6,27.58,29.44,31.29,33.19,35.08,36.87,38.66,40.32,41.97,43.73,45.49,47.03,48.56,49.9,51.24,52.58,53.92,54.9,55.88,56.85,57.83,58.61,59.39,60.16,60.94,61.53,62.12,62.71,63.3,63.53,63.75],[4.81,6.07,7.36,8.71,10,11.26,12.65,13.85,15.17,17.47,19.87,21.96,24.16,26.21,28.23,30.13,32.02,33.97,35.91,37.74,39.57,41.26,42.95,44.76,46.56,48.13,49.7,51.08,52.45,53.83,55.2,56.2,57.2,58.19,59.19,59.99,60.78,61.58,62.37,62.98,63.58,64.19,64.79,65.02,65.25],[4.92,6.2,7.52,8.9,10.21,11.5,12.94,14.17,15.51,17.86,20.31,22.46,24.71,26.8,28.87,30.81,32.74,34.73,36.71,38.59,40.46,42.19,43.92,45.77,47.61,49.21,50.81,52.22,53.63,55.03,56.44,57.46,58.48,59.5,60.52,61.33,62.15,62.96,63.77,64.39,65.01,65.63,66.25,66.49,66.72],[5.02,6.32,7.67,9.09,10.43,11.74,13.21,14.47,15.84,18.24,20.75,22.94,25.24,27.37,29.49,31.47,33.44,35.47,37.5,39.42,41.33,43.1,44.86,46.75,48.63,50.27,51.9,53.34,54.78,56.21,57.65,58.69,59.74,60.78,61.82,62.65,63.49,64.32,65.15,65.78,66.42,67.05,67.68,67.92,68.15],[5.12,6.45,7.82,9.27,10.63,11.98,13.49,14.77,16.17,18.62,21.18,23.42,25.76,27.94,30.1,32.12,34.13,36.21,38.28,40.24,42.19,43.99,45.78,47.71,49.63,51.3,52.97,54.44,55.91,57.37,58.84,59.9,60.97,62.03,63.09,63.94,64.79,65.64,66.49,67.14,67.78,68.43,69.07,69.32,69.56],[5.22,6.57,7.96,9.45,10.84,12.2,13.75,15.06,16.49,18.99,21.59,23.88,26.27,28.49,30.7,32.76,34.81,36.93,39.04,41.03,43.02,44.86,46.69,48.66,50.62,52.32,54.02,55.52,57.02,58.51,60.01,61.09,62.18,63.26,64.34,65.21,66.08,66.94,67.81,68.47,69.13,69.78,70.44,70.69,70.94],[5.31,6.69,8.11,9.62,11.04,12.43,14.01,15.35,16.8,19.35,22.01,24.33,26.77,29.03,31.28,33.38,35.47,37.63,39.78,41.81,43.84,45.71,47.58,49.58,51.58,53.32,55.05,56.58,58.11,59.63,61.16,62.26,63.36,64.46,65.56,66.45,67.33,68.22,69.1,69.77,70.45,71.12,71.79,72.04,72.29],[5.41,6.81,8.25,9.79,11.23,12.65,14.27,15.63,17.11,19.7,22.41,24.78,27.26,29.57,31.86,33.99,36.12,38.32,40.51,42.58,44.65,46.55,48.45,50.49,52.53,54.3,56.06,57.62,59.17,60.73,62.28,63.4,64.53,65.65,66.77,67.67,68.57,69.47,70.37,71.06,71.74,72.43,73.11,73.37,73.62],[5.5,6.92,8.38,9.96,11.43,12.86,14.52,15.9,17.42,20.05,22.81,25.22,27.74,30.09,32.42,34.59,36.76,39,41.23,43.34,45.44,47.37,49.3,51.38,53.46,55.26,57.05,58.63,60.22,61.8,63.38,64.52,65.67,66.81,67.95,68.87,69.79,70.7,71.62,72.32,73.01,73.71,74.4,74.66,74.92],[5.59,7.04,8.52,10.13,11.61,13.07,14.77,16.18,17.71,20.4,23.2,25.65,28.22,30.6,32.98,35.19,37.39,39.66,41.93,44.08,46.22,48.19,50.15,52.26,54.37,56.2,58.02,59.63,61.25,62.86,64.47,65.63,66.79,67.95,69.11,70.04,70.98,71.91,72.84,73.55,74.26,74.97,75.68,75.94,76.2],[5.68,7.16,8.66,10.3,11.79,13.28,15.02,16.46,18,20.75,23.59,26.08,28.7,31.11,33.54,35.78,38.02,40.33,42.63,44.82,47,49,51,53.14,55.28,57.14,58.99,60.63,62.28,63.92,65.56,66.74,67.92,69.09,70.27,71.22,72.17,73.11,74.06,74.79,75.51,76.24,76.96,77.22,77.48]]},"48":{"h":[1,1.25,1.5,1.75,2,2.25,2.5,2.75,3,3.25,3.5,3.75,4,4.25,4.5,4.75,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"o":[2,2.5,3,3.5,4,4.5,5,5.5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48],"q":[[1.19,1.51,1.85,2.21,2.49,2.81,3.13,3.41,3.67,4.28,4.87,5.42,5.96,6.4,6.99,7.48,7.97,8.44,8.9,9.35,9.8,10.27,10.73,11.15,11.57,11.99,12.41,12.8,13.19,13.53,13.87,14.23,14.59,14.85,15.11,15.36,15.62,15.83,16.03,16.24,16.44,16.61,16.79,16.96,17.13,17.24,17.36,17.47,17.58,17.54,17.5],[1.32,1.69,2.07,2.47,2.78,3.13,3.49,3.81,4.1,4.78,5.44,6.06,6.67,7.16,7.81,8.36,8.91,9.44,9.96,10.46,10.96,11.48,12,12.47,12.93,13.4,13.87,14.31,14.75,15.13,15.51,15.91,16.31,16.6,16.89,17.17,17.46,17.69,17.92,18.15,18.38,18.57,18.77,18.96,19.15,19.28,19.4,19.53,19.65,19.61,19.57],[1.44,1.84,2.26,2.7,3.04,3.43,3.82,4.17,4.5,5.24,5.96,6.64,7.31,7.84,8.56,9.16,9.76,10.34,10.91,11.46,12,12.58,13.15,13.66,14.17,14.69,15.2,15.68,16.15,16.57,16.99,17.43,17.87,18.19,18.5,18.82,19.13,19.38,19.63,19.88,20.13,20.34,20.56,20.77,20.98,21.12,21.25,21.39,21.52,21.48,21.44],[1.55,1.99,2.43,2.91,3.28,3.7,4.13,4.5,4.86,5.66,6.44,7.17,7.89,8.47,9.24,9.89,10.54,11.16,11.78,12.38,12.97,13.59,14.2,14.75,15.3,15.86,16.42,16.93,17.44,17.9,18.35,18.83,19.3,19.64,19.98,20.32,20.66,20.93,21.21,21.48,21.75,21.98,22.21,22.43,22.66,22.81,22.96,23.1,23.25,23.21,23.17],[1.66,2.12,2.59,3.1,3.5,3.95,4.41,4.81,5.19,6.05,6.88,7.66,8.44,9.05,9.88,10.58,11.27,11.93,12.59,13.23,13.86,14.52,15.18,15.77,16.36,16.96,17.55,18.1,18.65,19.13,19.61,20.12,20.63,21,21.36,21.73,22.09,22.38,22.67,22.96,23.25,23.5,23.74,23.99,24.23,24.39,24.54,24.7,24.85,24.81,24.77],[1.75,2.24,2.75,3.29,3.71,4.18,4.67,5.1,5.51,6.42,7.3,8.13,8.95,9.6,10.48,11.22,11.96,12.66,13.36,14.03,14.7,15.4,16.1,16.73,17.35,17.99,18.62,19.2,19.78,20.29,20.8,21.35,21.89,22.28,22.66,23.05,23.43,23.74,24.05,24.35,24.66,24.92,25.18,25.44,25.7,25.86,26.03,26.19,26.35,26.31,26.27],[1.84,2.36,2.89,3.46,3.9,4.41,4.92,5.38,5.81,6.76,7.7,8.57,9.43,10.12,11.05,11.83,12.61,13.35,14.08,14.79,15.5,16.24,16.97,17.63,18.29,18.96,19.62,20.23,20.84,21.39,21.93,22.5,23.07,23.48,23.89,24.29,24.7,25.02,25.35,25.67,25.99,26.27,26.54,26.82,27.09,27.26,27.43,27.6,27.77,27.74,27.7],[1.93,2.47,3.03,3.63,4.09,4.62,5.16,5.64,6.09,7.09,8.07,8.98,9.89,10.62,11.59,12.41,13.22,14,14.77,15.51,16.25,17.03,17.8,18.5,19.19,19.89,20.58,21.22,21.86,22.43,23,23.6,24.2,24.63,25.05,25.48,25.9,26.24,26.58,26.92,27.26,27.55,27.84,28.12,28.41,28.59,28.77,28.95,29.13,29.09,29.05],[2.01,2.58,3.16,3.78,4.27,4.82,5.39,5.88,6.37,7.41,8.43,9.38,10.33,11.09,12.1,12.96,13.81,14.62,15.42,16.2,16.97,17.78,18.59,19.32,20.04,20.77,21.5,22.17,22.83,23.43,24.02,24.65,25.27,25.72,26.16,26.61,27.05,27.41,27.76,28.12,28.47,28.77,29.07,29.37,29.67,29.86,30.05,30.23,30.42,30.39,30.35],[2.09,2.68,3.28,3.93,4.44,5.01,5.61,6.12,6.63,7.71,8.77,9.77,10.75,11.54,12.6,13.49,14.38,15.22,16.05,16.86,17.67,18.51,19.35,20.11,20.86,21.62,22.37,23.07,23.76,24.38,25,25.65,26.3,26.77,27.23,27.7,28.16,28.53,28.9,29.27,29.64,29.95,30.26,30.57,30.88,31.08,31.27,31.47,31.66,31.63,31.59],[2.17,2.78,3.4,4.08,4.6,5.2,5.82,6.35,6.88,8,9.11,10.14,11.16,11.98,13.07,14,14.92,15.79,16.66,17.5,18.33,19.21,20.08,20.87,21.65,22.44,23.22,23.94,24.66,25.31,25.95,26.63,27.3,27.78,28.26,28.74,29.22,29.61,29.99,30.38,30.76,31.08,31.41,31.73,32.05,32.25,32.45,32.65,32.85,32.82,32.78],[2.24,2.88,3.52,4.22,4.76,5.38,6.02,6.57,7.12,8.28,9.43,10.49,11.55,12.4,13.53,14.49,15.45,16.35,17.24,18.11,18.98,19.89,20.79,21.6,22.41,23.22,24.03,24.78,25.52,26.19,26.86,27.56,28.26,28.76,29.26,29.75,30.25,30.65,31.05,31.44,31.84,32.17,32.51,32.84,33.17,33.38,33.59,33.79,34,33.97,33.94],[2.31,2.97,3.63,4.35,4.92,5.55,6.21,6.79,7.35,8.56,9.73,10.83,11.93,12.81,13.98,14.97,15.96,16.89,17.81,18.71,19.6,20.54,21.47,22.31,23.14,23.98,24.82,25.59,26.36,27.05,27.74,28.46,29.18,29.7,30.21,30.73,31.24,31.65,32.06,32.47,32.88,33.23,33.57,33.92,34.26,34.48,34.69,34.91,35.12,35.09,35.05],[2.38,3.06,3.74,4.48,5.06,5.72,6.4,7,7.58,8.82,10.03,11.17,12.3,13.2,14.41,15.43,16.45,17.41,18.36,19.28,20.2,21.17,22.13,22.99,23.85,24.72,25.59,26.38,27.17,27.88,28.59,29.34,30.08,30.61,31.14,31.67,32.2,32.62,33.05,33.47,33.89,34.25,34.6,34.96,35.31,35.53,35.76,35.98,36.2,36.17,36.13],[2.44,3.14,3.85,4.61,5.21,5.89,6.59,7.2,7.8,9.07,10.33,11.49,12.65,13.58,14.83,15.88,16.93,17.91,18.89,19.84,20.79,21.78,22.77,23.66,24.55,25.44,26.33,27.14,27.95,28.69,29.42,30.19,30.95,31.5,32.05,32.59,33.14,33.57,34.01,34.44,34.87,35.24,35.6,35.97,36.33,36.56,36.79,37.01,37.24,37.21,37.18],[2.51,3.23,3.95,4.73,5.35,6.05,6.77,7.39,8.01,9.32,10.61,11.81,13,13.95,15.23,16.31,17.39,18.4,19.4,20.38,21.36,22.38,23.4,24.31,25.22,26.14,27.05,27.89,28.72,29.48,30.23,31.02,31.8,32.36,32.92,33.48,34.04,34.49,34.94,35.38,35.83,36.21,36.58,36.96,37.33,37.56,37.8,38.03,38.26,38.23,38.2],[2.57,3.31,4.05,4.85,5.48,6.2,6.94,7.58,8.22,9.57,10.88,12.11,13.34,14.32,15.63,16.74,17.84,18.88,19.91,20.91,21.91,22.96,24.01,24.94,25.87,26.81,27.75,28.61,29.46,30.24,31.01,31.82,32.63,33.21,33.78,34.36,34.93,35.39,35.85,36.3,36.76,37.15,37.53,37.92,38.3,38.54,38.78,39.01,39.25,39.23,39.2],[2.69,3.47,4.24,5.08,5.75,6.5,7.27,7.95,8.62,10.03,11.41,12.7,13.99,15.02,16.39,17.56,18.72,19.8,20.88,21.93,22.98,24.08,25.18,26.16,27.14,28.13,29.11,30.01,30.9,31.72,32.53,33.38,34.22,34.82,35.43,36.03,36.63,37.11,37.59,38.07,38.55,38.96,39.36,39.77,40.17,40.42,40.67,40.92,41.17,41.14,41.11],[2.8,3.62,4.42,5.3,6,6.78,7.59,8.3,9.01,10.48,11.92,13.27,14.61,15.68,17.12,18.34,19.55,20.68,21.81,22.91,24,25.15,26.3,27.33,28.35,29.38,30.4,31.34,32.27,33.12,33.97,34.86,35.74,36.37,37,37.63,38.26,38.76,39.27,39.77,40.27,40.69,41.11,41.53,41.95,42.21,42.47,42.73,42.99,42.97,42.95],[2.91,3.76,4.6,5.51,6.24,7.06,7.9,8.64,9.38,10.91,12.41,13.81,15.21,16.32,17.82,19.09,20.35,21.53,22.7,23.84,24.98,26.18,27.37,28.44,29.5,30.57,31.64,32.62,33.59,34.48,35.36,36.28,37.2,37.86,38.51,39.17,39.82,40.34,40.87,41.39,41.91,42.35,42.79,43.23,43.67,43.94,44.21,44.48,44.75,44.73,44.7],[3.02,3.9,4.76,5.72,6.47,7.32,8.2,8.97,9.73,11.32,12.88,14.33,15.78,16.94,18.49,19.81,21.12,22.34,23.56,24.75,25.93,27.17,28.41,29.52,30.62,31.73,32.84,33.85,34.85,35.78,36.7,37.66,38.61,39.29,39.97,40.65,41.33,41.87,42.42,42.96,43.5,43.95,44.41,44.86,45.31,45.59,45.87,46.15,46.43,46.41,46.39],[3.12,4.03,4.93,5.91,6.69,7.57,8.48,9.28,10.07,11.72,13.33,14.83,16.33,17.53,19.14,20.5,21.86,23.12,24.38,25.61,26.84,28.13,29.41,30.55,31.69,32.84,33.99,35.03,36.07,37.03,37.98,38.97,39.96,40.67,41.37,42.08,42.78,43.34,43.9,44.46,45.02,45.49,45.96,46.43,46.9,47.19,47.48,47.77,48.06,48.05,48.03],[3.22,4.16,5.08,6.1,6.91,7.82,8.76,9.58,10.4,12.1,13.77,15.32,16.87,18.11,19.77,21.18,22.58,23.88,25.18,26.45,27.72,29.05,30.37,31.55,32.73,33.92,35.11,36.18,37.25,38.24,39.23,40.25,41.27,42,42.73,43.45,44.18,44.76,45.34,45.92,46.5,46.99,47.47,47.96,48.44,48.74,49.04,49.33,49.63,49.62,49.6],[3.32,4.28,5.23,6.28,7.12,8.05,9.02,9.87,10.73,12.47,14.19,15.79,17.39,18.67,20.38,21.83,23.28,24.62,25.96,27.27,28.57,29.94,31.31,32.53,33.74,34.97,36.19,37.3,38.4,39.42,40.44,41.49,42.54,43.29,44.04,44.79,45.54,46.14,46.74,47.33,47.93,48.43,48.93,49.43,49.93,50.24,50.54,50.85,51.15,51.14,51.13],[3.41,4.4,5.38,6.46,7.32,8.28,9.28,10.16,11.04,12.84,14.6,16.25,17.89,19.21,20.97,22.46,23.95,25.33,26.71,28.06,29.4,30.81,32.21,33.47,34.72,35.98,37.24,38.38,39.51,40.56,41.61,42.7,43.78,44.55,45.32,46.09,46.86,47.48,48.09,48.71,49.32,49.84,50.35,50.87,51.38,51.7,52.01,52.33,52.64,52.63,52.62],[3.5,4.52,5.53,6.63,7.51,8.51,9.53,10.43,11.34,13.19,15,16.69,18.38,19.73,21.54,23.08,24.61,26.03,27.44,28.82,30.2,31.65,33.1,34.39,35.67,36.97,38.26,39.43,40.59,41.67,42.75,43.87,44.98,45.77,46.57,47.36,48.15,48.78,49.41,50.04,50.67,51.2,51.73,52.26,52.79,53.11,53.43,53.75,54.07,54.07,54.06],[3.58,4.64,5.66,6.8,7.71,8.72,9.78,10.7,11.63,13.53,15.39,17.13,18.86,20.25,22.1,23.68,25.25,26.7,28.15,29.57,30.99,32.48,33.96,35.28,36.6,37.93,39.25,40.45,41.64,42.75,43.86,45,46.14,46.96,47.77,48.59,49.4,50.05,50.7,51.34,51.99,52.53,53.08,53.62,54.16,54.49,54.82,55.15,55.48,55.48,55.47],[3.75,4.86,5.93,7.12,8.08,9.14,10.25,11.22,12.2,14.19,16.14,17.96,19.78,21.24,23.18,24.84,26.49,28.01,29.53,31.02,32.5,34.06,35.62,37.01,38.39,39.78,41.17,42.42,43.67,44.84,46,47.2,48.4,49.25,50.11,50.96,51.81,52.49,53.17,53.84,54.52,55.09,55.66,56.23,56.8,57.15,57.49,57.84,58.18,58.18,58.18],[3.91,5.07,6.19,7.43,8.43,9.54,10.7,11.72,12.75,14.82,16.86,18.76,20.66,22.18,24.21,25.94,27.67,29.26,30.84,32.39,33.94,35.57,37.2,38.65,40.1,41.55,43,44.31,45.61,46.83,48.05,49.3,50.55,51.44,52.33,53.22,54.11,54.82,55.53,56.24,56.95,57.54,58.14,58.73,59.32,59.68,60.04,60.4,60.76,60.77,60.77],[4.07,5.27,6.43,7.73,8.77,9.93,11.13,12.19,13.27,15.43,17.55,19.53,21.51,23.09,25.2,27,28.8,30.45,32.1,33.72,35.33,37.03,38.72,40.23,41.73,43.25,44.76,46.12,47.47,48.74,50.01,51.31,52.61,53.54,54.47,55.39,56.32,57.06,57.8,58.53,59.27,59.89,60.51,61.13,61.75,62.12,62.5,62.87,63.24,63.25,63.26],[4.21,5.46,6.67,8.01,9.09,10.3,11.55,12.65,13.77,16.01,18.21,20.26,22.32,23.96,26.15,28.02,29.89,31.6,33.31,34.99,36.66,38.42,40.18,41.75,43.31,44.88,46.45,47.86,49.26,50.58,51.9,53.25,54.6,55.56,56.53,57.49,58.45,59.22,59.98,60.75,61.51,62.15,62.8,63.44,64.08,64.47,64.85,65.24,65.62,65.64,65.65],[4.35,5.65,6.9,8.29,9.4,10.65,11.95,13.09,14.26,16.57,18.85,20.98,23.1,24.8,27.07,29.01,30.94,32.71,34.48,36.22,37.95,39.77,41.59,43.21,44.83,46.46,48.08,49.54,50.99,52.36,53.72,55.12,56.52,57.52,58.51,59.51,60.5,61.29,62.09,62.88,63.67,64.33,65,65.66,66.32,66.72,67.12,67.52,67.92,67.94,67.96],[4.49,5.83,7.11,8.55,9.71,11,12.34,13.52,14.72,17.12,19.47,21.66,23.86,25.61,27.96,29.96,31.96,33.79,35.61,37.4,39.19,41.08,42.96,44.63,46.3,47.98,49.65,51.16,52.66,54.07,55.48,56.93,58.37,59.4,60.43,61.45,62.48,63.3,64.12,64.94,65.76,66.45,67.13,67.82,68.5,68.91,69.32,69.73,70.14,70.17,70.2],[4.62,6,7.33,8.81,10,11.33,12.71,13.93,15.18,17.65,20.07,22.33,24.59,26.4,28.82,30.88,32.94,34.83,36.71,38.56,40.4,42.34,44.28,46.01,47.73,49.46,51.18,52.73,54.27,55.73,57.19,58.68,60.17,61.23,62.29,63.35,64.41,65.25,66.1,66.94,67.78,68.49,69.2,69.9,70.61,71.03,71.46,71.88,72.3,72.33,72.36],[4.75,6.17,7.53,9.06,10.28,11.65,13.08,14.33,15.62,18.16,20.65,22.98,25.31,27.17,29.66,31.78,33.9,35.84,37.77,39.67,41.57,43.57,45.56,47.34,49.11,50.89,52.67,54.26,55.85,57.35,58.85,60.38,61.91,63,64.09,65.18,66.27,67.14,68.01,68.88,69.75,70.48,71.2,71.93,72.65,73.09,73.52,73.96,74.39,74.43,74.46],[4.88,6.33,7.73,9.3,10.56,11.97,13.43,14.72,16.05,18.66,21.22,23.61,26,27.91,30.47,32.65,34.83,36.82,38.8,40.76,42.71,44.76,46.81,48.64,50.46,52.29,54.11,55.74,57.37,58.92,60.46,62.04,63.61,64.73,65.85,66.97,68.09,68.98,69.88,70.77,71.66,72.41,73.15,73.9,74.64,75.09,75.53,75.98,76.42,76.47,76.51],[5,6.49,7.93,9.53,10.83,12.27,13.78,15.1,16.47,19.14,21.77,24.22,26.67,28.63,31.26,33.5,35.74,37.78,39.81,41.82,43.82,45.93,48.03,49.9,51.77,53.64,55.51,57.19,58.86,60.45,62.03,63.65,65.26,66.41,67.56,68.71,69.86,70.78,71.69,72.61,73.52,74.29,75.05,75.82,76.58,77.04,77.49,77.95,78.4,78.45,78.5],[5.12,6.65,8.12,9.76,11.09,12.57,14.12,15.47,16.87,19.61,22.3,24.82,27.33,29.34,32.03,34.33,36.62,38.71,40.79,42.85,44.9,47.06,49.22,51.14,53.05,54.97,56.89,58.6,60.31,61.94,63.56,65.22,66.87,68.05,69.23,70.4,71.58,72.52,73.46,74.4,75.34,76.12,76.91,77.69,78.47,78.94,79.41,79.87,80.34,80.39,80.44],[5.23,6.8,8.3,9.99,11.35,12.86,14.44,15.84,17.27,20.08,22.83,25.4,27.98,30.03,32.79,35.14,37.49,39.62,41.75,43.86,45.96,48.17,50.38,52.34,54.3,56.26,58.22,59.98,61.73,63.4,65.06,66.76,68.45,69.66,70.86,72.07,73.27,74.23,75.19,76.15,77.11,77.91,78.72,79.52,80.32,80.8,81.27,81.75,82.22,82.28,82.34],[5.35,6.95,8.48,10.21,11.6,13.15,14.77,16.19,17.66,20.53,23.34,25.97,28.6,30.71,33.52,35.93,38.33,40.51,42.69,44.84,46.99,49.25,51.51,53.52,55.52,57.53,59.53,61.33,63.12,64.82,66.52,68.25,69.98,71.21,72.45,73.68,74.91,75.89,76.88,77.86,78.84,79.66,80.48,81.3,82.12,82.61,83.1,83.58,84.07,84.13,84.19],[5.46,7.1,8.66,10.42,11.84,13.43,15.08,16.54,18.04,20.97,23.84,26.53,29.22,31.37,34.25,36.71,39.16,41.39,43.61,45.81,48,50.31,52.62,54.67,56.72,58.77,60.81,62.64,64.47,66.21,67.95,69.72,71.49,72.75,74.01,75.27,76.53,77.53,78.54,79.54,80.54,81.38,82.22,83.05,83.89,84.39,84.88,85.38,85.87,85.94,86.01],[5.56,7.24,8.83,10.63,12.08,13.7,15.39,16.87,18.41,21.4,24.34,27.08,29.82,32.01,34.95,37.46,39.97,42.24,44.51,46.75,48.99,51.35,53.7,55.8,57.89,59.98,62.07,63.94,65.8,67.58,69.35,71.16,72.96,74.25,75.53,76.82,78.1,79.13,80.15,81.18,82.2,83.06,83.91,84.77,85.62,86.13,86.63,87.14,87.64,87.71,87.78],[5.67,7.38,9,10.83,12.32,13.97,15.69,17.21,18.78,21.83,24.82,27.61,30.41,32.65,35.64,38.2,40.76,43.08,45.39,47.68,49.96,52.37,54.77,56.9,59.03,61.17,63.3,65.2,67.1,68.92,70.73,72.57,74.41,75.72,77.03,78.34,79.65,80.7,81.74,82.79,83.83,84.7,85.57,86.44,87.31,87.83,88.34,88.86,89.37,89.45,89.52],[5.77,7.51,9.17,11.04,12.55,14.23,15.98,17.53,19.14,22.24,25.29,28.14,30.99,33.27,36.32,38.93,41.54,43.9,46.26,48.59,50.91,53.36,55.81,57.99,60.16,62.33,64.5,66.44,68.38,70.23,72.07,73.95,75.83,77.17,78.5,79.84,81.17,82.23,83.3,84.36,85.42,86.31,87.2,88.08,88.97,89.5,90.02,90.55,91.07,91.15,91.23],[5.88,7.65,9.33,11.23,12.77,14.49,16.27,17.85,19.49,22.65,25.75,28.65,31.56,33.88,36.99,39.65,42.3,44.7,47.1,49.48,51.85,54.34,56.83,59.05,61.26,63.48,65.69,67.66,69.63,71.52,73.4,75.31,77.22,78.58,79.94,81.3,82.66,83.74,84.83,85.91,86.99,87.9,88.8,89.71,90.61,91.14,91.68,92.21,92.74,92.83,92.91],[5.98,7.78,9.49,11.43,13,14.74,16.56,18.17,19.83,23.05,26.21,29.16,32.12,34.48,37.65,40.35,43.05,45.5,47.94,50.35,52.76,55.3,57.84,60.1,62.35,64.6,66.85,68.86,70.86,72.78,74.69,76.64,78.58,79.97,81.35,82.74,84.12,85.22,86.33,87.43,88.53,89.45,90.37,91.29,92.21,92.75,93.3,93.84,94.38,94.47,94.56],[6.07,7.91,9.65,11.62,13.21,14.99,16.84,18.47,20.17,23.45,26.66,29.66,32.67,35.07,38.29,41.04,43.79,46.28,48.76,51.22,53.67,56.25,58.83,61.13,63.42,65.71,67.99,70.03,72.07,74.02,75.97,77.95,79.93,81.34,82.75,84.15,85.56,86.68,87.81,88.93,90.05,90.98,91.92,92.85,93.78,94.33,94.89,95.44,95.99,96.09,96.18],[6.29,8.04,9.81,11.82,13.43,15.24,17.13,18.78,20.51,23.85,27.12,30.17,33.23,35.67,38.94,41.74,44.54,47.07,49.59,52.09,54.58,57.21,59.83,62.17,64.5,66.82,69.14,71.22,73.29,75.28,77.26,79.27,81.29,82.72,84.15,85.58,87.01,88.16,89.3,90.44,91.58,92.53,93.48,94.42,95.37,95.93,96.49,97.06,97.62,97.71,97.8]]}};

// RRB_Q[row][col]: row=tenths of head(ft) 0.0–3.3, col=hundredths 0–9
const RRB_Q=[[0,0,0,0,0,1,1,1,1,1],[2,2,2,2,3,3,3,4,4,4],[4,5,5,6,6,6,7,7,7,8],[8,9,9,9,10,10,11,11,12,12],[13,13,14,14,15,15,16,16,17,17],[18,18,19,19,20,20,21,21,22,23],[23,24,24,25,26,26,27,27,28,29],[29,30,31,31,32,32,33,34,34,35],[36,36,37,38,38,39,40,41,41,42],[43,43,44,45,46,46,47,48,48,49],[50,51,51,52,53,54,55,55,56,57],[58,58,59,60,61,62,62,63,64,65],[66,66,67,68,69,70,71,71,72,73],[74,75,76,77,77,78,79,80,81,82],[83,84,85,85,86,87,88,89,90,91],[92,93,94,95,95,96,97,98,99,100],[101,102,103,104,105,106,107,108,109,110],[111,112,113,114,115,116,117,118,119,120],[121,122,123,124,125,126,127,128,129,130],[131,132,133,134,135,136,137,138,139,140],[141,142,143,144,146,147,148,149,150,151],[152,153,154,155,156,157,159,160,161,162],[163,164,165,166,167,169,170,171,172,173],[174,175,177,178,179,180,181,182,183,185],[186,187,188,189,190,192,193,194,195,196],[197,199,200,201,202,203,205,206,207,208],[209,211,212,213,214,215,217,218,219,220],[222,223,224,225,227,228,229,230,232,233],[234,235,237,238,239,240,242,243,244,245],[247,248,249,251,252,253,254,256,257,258],[260,261,262,263,265,266,267,269,270,271],[273,274,275,277,278,279,281,282,283,285],[286,287,289,290,291,293,294,295,297,298],[299,301,302,304,305,306,308,309,310,312]];


// ── Gate Discharge panel ─────────────────────────────────────────────────
let gateDischargeSize = 30;
const gateTableCache = {};

function initGateDischargePanel() {
  const sel = el('gate-size-select');
  sel.value = String(gateDischargeSize);
  sel.onchange = () => {
    gateDischargeSize = parseInt(sel.value);
    buildGateDischargeTable();
    updateGateDischargeCalc();
  };
  el('gate-tab-btn-table').onclick = () => switchGateDischargeTab('table');
  el('gate-tab-btn-calc').onclick  = () => switchGateDischargeTab('calc');
  el('gate-head').oninput    = updateGateDischargeCalc;
  el('gate-opening').oninput = updateGateDischargeCalc;
  buildGateDischargeTable();
}

function switchGateDischargeTab(tab) {
  el('gate-tab-table').style.display = tab === 'table' ? '' : 'none';
  el('gate-tab-calc').style.display  = tab === 'calc'  ? '' : 'none';
  el('gate-tab-btn-table').classList.toggle('active', tab === 'table');
  el('gate-tab-btn-calc').classList.toggle('active',  tab === 'calc');
}

function buildGateDischargeTable() {
  const container = el('gate-table-container');
  if (gateTableCache[gateDischargeSize]) {
    container.innerHTML = gateTableCache[gateDischargeSize];
    return;
  }
  const data = GATE_DATA[gateDischargeSize];
  let html = '<table class="charts-table"><thead><tr><th>Head (in)</th>';
  data.o.forEach(o => { html += `<th>${o}"</th>`; });
  html += '</tr></thead><tbody>';
  data.h.forEach((h, i) => {
    html += `<tr><td>${h}</td>`;
    data.q[i].forEach(q => { html += `<td>${q.toFixed(2)}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  gateTableCache[gateDischargeSize] = html;
  container.innerHTML = html;
}

function interpGateDischarge(h, o) {
  const data = GATE_DATA[gateDischargeSize];
  const heads = data.h; const openings = data.o; const q = data.q;
  if (h < heads[0] || h > heads[heads.length-1]) return null;
  if (o < openings[0] || o > openings[openings.length-1]) return null;
  let hi = 0;
  for (let i = 0; i < heads.length - 1; i++) { if (heads[i] <= h && h <= heads[i+1]) { hi = i; break; } }
  let oi = 0;
  for (let i = 0; i < openings.length - 1; i++) { if (openings[i] <= o && o <= openings[i+1]) { oi = i; break; } }
  const t = heads[hi+1] === heads[hi] ? 0 : (h - heads[hi]) / (heads[hi+1] - heads[hi]);
  const u = openings[oi+1] === openings[oi] ? 0 : (o - openings[oi]) / (openings[oi+1] - openings[oi]);
  return (1-t)*(1-u)*q[hi][oi] + (1-t)*u*q[hi][oi+1] + t*(1-u)*q[hi+1][oi] + t*u*q[hi+1][oi+1];
}

function updateGateDischargeCalc() {
  const h = parseFloat(el('gate-head').value);
  const o = parseFloat(el('gate-opening').value);
  if (isNaN(h) || isNaN(o)) { el('gate-result').textContent = '—'; return; }
  const q = interpGateDischarge(h, o);
  el('gate-result').textContent = q !== null ? q.toFixed(2) : 'Out of range';
}

// ── RRB T.O. 1 & 2 panel ────────────────────────────────────────────────
function initRRBPanel() {
  const container = el('rrb-table-container');
  if (!container.dataset.built) {
    const cols = [0,0.01,0.02,0.03,0.04,0.05,0.06,0.07,0.08,0.09];
    let html = '<table class="charts-table"><thead><tr><th>Head (ft)</th>';
    cols.forEach(c => { html += `<th>+${c.toFixed(2)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let ri = 0; ri < RRB_Q.length; ri++) {
      const rowLabel = (ri * 0.1).toFixed(1);
      html += `<tr><td>${rowLabel}</td>`;
      RRB_Q[ri].forEach(q => { html += `<td>${q}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.dataset.built = '1';
  }
  el('rrb-tab-btn-table').onclick = () => switchRRBTab('table');
  el('rrb-tab-btn-calc').onclick  = () => switchRRBTab('calc');
  el('rrb-head').oninput = updateRRBCalc;
}

function switchRRBTab(tab) {
  el('rrb-tab-table').style.display = tab === 'table' ? '' : 'none';
  el('rrb-tab-calc').style.display  = tab === 'calc'  ? '' : 'none';
  el('rrb-tab-btn-table').classList.toggle('active', tab === 'table');
  el('rrb-tab-btn-calc').classList.toggle('active',  tab === 'calc');
}

function updateRRBCalc() {
  const h = parseFloat(el('rrb-head').value);
  if (isNaN(h) || h < 0 || h > 3.39) { el('rrb-result').textContent = '—'; return; }
  const h100 = Math.round(h * 100);
  const ri = Math.floor(h100 / 10);
  const ci = h100 % 10;
  if (ri >= RRB_Q.length || ci >= 10) { el('rrb-result').textContent = '—'; return; }
  el('rrb-result').textContent = RRB_Q[ri][ci];
}

// ── Pioneer Inlet panel (sharp crested weir) ────────────────────────────
// Lookup chart from gauge height (GH, ft) to flow (cfs). Rows start at GH 0.30
// and run to 2.70; columns are hundredths +0.00…+0.09. Values are kept as
// strings to preserve the published precision and the ^ / U markers exactly.
const PIONEER_FIRST_GH = 0.30;
const PIONEER_Q = [
  ['0.0','0.400','0.800','1.20','1.60','2.00','2.40','2.80','3.20','3.60'],  // 0.30
  ['4.00','4.60','5.20','5.80','6.40','7.00','7.60','8.20','8.80','9.40'],   // 0.40
  ['10.0','10.7','11.4','12.1','12.8','13.5','14.2','14.9','15.6','16.3'],   // 0.50
  ['17.0','18.0','19.0','20.0','21.0','22.0','23.0','24.0','25.0','26.0'],   // 0.60
  ['27.0','28.2','29.4','30.6','31.8','33.0','34.2','35.4','36.6','37.8'],   // 0.70
  ['39.0','40.2','41.4','42.6','43.8','45.0','46.2','47.4','48.6','49.8'],   // 0.80
  ['51.0','52.4','53.8','55.2','56.6','58.0','59.4','60.8','62.2','63.6'],   // 0.90
  ['65.0','66.3','67.6','68.9','70.2','71.5','72.8','74.1','75.4','76.7'],   // 1.00
  ['78.0','79.5','81.0','82.5','84.0','85.5','87.0','88.5','90.0','91.5'],   // 1.10
  ['93.0','94.7','96.4','98.1','99.8','102','103','105','107','108'],        // 1.20
  ['110','112','114','116','118','120','121','123','125','127'],             // 1.30
  ['129','131','133','135','137','139','141','143','145','147'],             // 1.40
  ['149','151','153','155','157','159','161','163','165','167'],             // 1.50
  ['169','171','173','175','177','180','182','184','186','188'],             // 1.60
  ['190','192','194','196','198','201','203','205','207','209'],             // 1.70
  ['211','213','215','218','220','222','224','226','229','231'],             // 1.80
  ['233','235','237','240','242','244','246','248','251','253'],             // 1.90
  ['255','257','260','262','264','267','269','271','273','276'],             // 2.00
  ['278','280','283','285','287','289','292','294','296','299'],             // 2.10
  ['301','303','306','308','311','313','315','318','320','323'],             // 2.20
  ['325','327','330','332','335','337','340','342','345','347'],             // 2.30
  ['350','353^','355^','358^','360^','363^','366^','368^','371^','373^'],    // 2.40
  ['376^','379^','381^','384^','387^','389^','392^','395^','398^','400^'],   // 2.50
  ['403U','406U','409U','411U','414U','417U','420U','423U','425U','428U'],   // 2.60
  ['431U'],                                                                  // 2.70
];

function initPioneerPanel() {
  const container = el('pioneer-table-container');
  if (!container.dataset.built) {
    const cols = [0,0.01,0.02,0.03,0.04,0.05,0.06,0.07,0.08,0.09];
    let html = '<table class="charts-table"><thead><tr><th>GH (ft)</th>';
    cols.forEach(c => { html += `<th>+${c.toFixed(2)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let ri = 0; ri < PIONEER_Q.length; ri++) {
      const rowLabel = (PIONEER_FIRST_GH + ri * 0.1).toFixed(2);
      html += `<tr><td>${rowLabel}</td>`;
      for (let ci = 0; ci < cols.length; ci++) {
        html += `<td>${PIONEER_Q[ri][ci] ?? ''}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.dataset.built = '1';
  }
  el('pioneer-tab-btn-table').onclick = () => switchPioneerTab('table');
  el('pioneer-tab-btn-calc').onclick  = () => switchPioneerTab('calc');
  el('pioneer-head').oninput = updatePioneerCalc;
}

function switchPioneerTab(tab) {
  el('pioneer-tab-table').style.display = tab === 'table' ? '' : 'none';
  el('pioneer-tab-calc').style.display  = tab === 'calc'  ? '' : 'none';
  el('pioneer-tab-btn-table').classList.toggle('active', tab === 'table');
  el('pioneer-tab-btn-calc').classList.toggle('active',  tab === 'calc');
}

function updatePioneerCalc() {
  const h = parseFloat(el('pioneer-head').value);
  if (isNaN(h) || h < PIONEER_FIRST_GH || h > 2.70) { el('pioneer-result').textContent = '—'; return; }
  const h100 = Math.round(h * 100);
  const ri = Math.floor(h100 / 10) - Math.round(PIONEER_FIRST_GH * 10);
  const ci = h100 % 10;
  const val = PIONEER_Q[ri] && PIONEER_Q[ri][ci];
  el('pioneer-result').textContent = (val == null) ? '—' : val;
}

/* ── Ponds ───────────────────────────────────────────────────────────────── */
let pondsLoaded = false;

async function initPondsScreen() {
  if (pondsLoaded) return;
  pondsLoaded = true;

  const dateInput = el('ponds-date');
  const timeInput = el('ponds-time');
  dateInput.value = todayISO();
  timeInput.value = nowHHMM();

  const body = el('ponds-list-body');
  body.innerHTML = '<div class="placeholder-msg">Loading…</div>';

  try {
    const rows = await api('GET', '/api/ponds');
    if (!rows.length) {
      body.innerHTML = '<div class="placeholder-msg">No ponds found.</div>';
      return;
    }

    // Group flat rows → locations → (ponds + outlets) → connections → gates
    const locMap = new Map();
    function addGate(connMap, connId, row) {
      if (!connMap.has(connId)) {
        connMap.set(connId, {
          id: row.connection_id, name: row.connection_name, sort: row.connection_sort,
          source_type: row.source_type, source_canal_id: row.source_canal_id,
          canal_structure_name: row.canal_structure_name,
          last_canal_flow: row.last_canal_flow, last_canal_totalizer: row.last_canal_totalizer,
          last_canal_date: row.last_canal_date, last_canal_reading_id: row.last_canal_reading_id,
          last_canal_notes: row.last_canal_notes,
          gates: [],
        });
      }
      if (row.gate_id) {
        connMap.get(connId).gates.push({
          gate_id: row.gate_id, label: row.gate_label, gate_type: row.gate_type,
          width_in: row.width_in, gate_notes: row.gate_notes, sort: row.gate_sort,
          last_head: row.last_head, last_opening: row.last_opening,
          last_overpour: row.last_overpour, last_flow: row.last_flow, last_date: row.last_gate_date,
          last_notes: row.last_gate_notes,
        });
      }
    }

    for (const row of rows) {
      if (!row.location_id) continue; // outlets without location assigned yet
      if (!locMap.has(row.location_id)) {
        locMap.set(row.location_id, {
          id: row.location_id, name: row.location_name,
          sort: row.location_sort, ponds: new Map(), outlets: new Map(),
        });
      }
      const loc = locMap.get(row.location_id);

      if (row.row_type === 'outlet') {
        if (!loc.outlets.has(row.outlet_id)) {
          loc.outlets.set(row.outlet_id, {
            outlet_id: row.outlet_id, name: row.pond_name, sort: row.pond_sort,
            isOutlet: true,
            last_gauge_level: row.last_gauge_level,
            last_gauge_date:  row.last_gauge_date,
            last_gauge_notes: row.last_gauge_notes,
            connections: new Map(),
          });
        }
        if (row.connection_id) {
          addGate(loc.outlets.get(row.outlet_id).connections, row.connection_id, row);
        }
      } else {
        if (!loc.ponds.has(row.pond_id)) {
          loc.ponds.set(row.pond_id, {
            pond_id: row.pond_id, name: row.pond_name, sort: row.pond_sort,
            last_gauge_level: row.last_gauge_level,
            last_gauge_date:  row.last_gauge_date,
            last_gauge_notes: row.last_gauge_notes,
            connections: new Map(),
          });
        }
        if (row.connection_id) {
          addGate(loc.ponds.get(row.pond_id).connections, row.connection_id, row);
        }
      }
    }

    body.innerHTML = '';
    const sortedLocs = [...locMap.values()].sort((a, b) => a.sort - b.sort);
    for (const loc of sortedLocs) {
      const allEntities = [
        ...[...loc.ponds.values()].map(p => ({ ...p, _fn: createPondCard })),
        ...[...loc.outlets.values()].map(o => ({ ...o, _fn: createOutletCard })),
      ].sort((a, b) => a.sort - b.sort);
      const cards = allEntities.map(e => e._fn(e, dateInput, timeInput));
      body.appendChild(makeCollapsibleSection(loc.name, cards));
    }
  } catch (err) {
    body.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
    showToast('Failed to load ponds: ' + err.message, 'error');
  }
}

function pondDelta(cur, prev, dec = 2) {
  if (cur == null || prev == null) return '';
  const d = Number(cur) - Number(prev);
  if (Math.abs(d) < 0.005) return '';
  const up = d > 0;
  return ` <span class="pond-delta ${up ? 'delta-up' : 'delta-dn'}">${up ? '▲' : '▼'}${Math.abs(d).toFixed(dec)}</span>`;
}

function createPondCard(pond, dateInput, timeInput) {
  const today = todayISO();
  const allGates = [...pond.connections.values()].flatMap(c => c.gates);
  const hasGates = allGates.length > 0;

  // Gate-specific status (badge reflects gate readings; gauge is shown inline)
  const lastGateDate = allGates.reduce((best, g) => {
    const d = g.last_date ? String(g.last_date).slice(0, 10) : null;
    return (!best || (d && d > best)) ? d : best;
  }, null);
  // For gauge-only ponds, fall back to gauge date
  const statusDate  = hasGates ? lastGateDate
    : (pond.last_gauge_date ? String(pond.last_gauge_date).slice(0, 10) : null);
  const badgeClass  = !statusDate ? 'default' : (statusDate === today ? 'ok' : 'due');
  const badgeText   = !statusDate ? 'Not read' : (statusDate === today ? 'Today' : fmtDate(statusDate));

  // Gauge hint — always shown; falls back to dash when no reading yet
  const gaugeLevel = pond.last_gauge_level;
  const gaugeDate  = pond.last_gauge_date ? String(pond.last_gauge_date).slice(0, 10) : null;
  const gaugeHint  = gaugeLevel != null
    ? `Staff: ${Number(gaugeLevel).toFixed(2)} ft · ${gaugeDate ? fmtDate(gaugeDate) : 'Today'}`
    : 'Staff: —';

  const div = document.createElement('div');
  div.className = 'list-item';
  div.dataset.curGaugeLevel = pond.last_gauge_level ?? '';
  const mapPinSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="list-item-name">${pond.name}</span>
      <span class="pond-gauge-hint">${gaugeHint}</span>
      <button class="pond-map-btn btn btn-secondary btn-sm" title="View map" style="padding:2px 7px;flex-shrink:0">${mapPinSvg}</button>
      <span class="status-badge ${badgeClass}">${badgeText}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-form"></div>`;

  div.querySelector('.pond-map-btn').addEventListener('click', e => {
    e.stopPropagation();
    openPondMap('pond', pond.pond_id, pond.name);
  });

  const form = div.querySelector('.list-item-form');
  form.style.display = 'none';

  // Staff gauge section
  form.appendChild(buildGaugeForm(pond, dateInput, timeInput, div));

  // Connection rows — canal gets a special inflow row; river/pond use gate rows
  const sortedConns = [...pond.connections.values()].sort((a, b) => a.sort - b.sort);
  for (const conn of sortedConns) {
    if (conn.source_type === 'canal' && conn.source_canal_id) {
      form.appendChild(buildCanalRow(conn, dateInput, timeInput, div));
    } else {
      const sortedGates = [...conn.gates].sort((a, b) => a.sort - b.sort);
      for (const gate of sortedGates) {
        form.appendChild(buildGateRow(gate, dateInput, timeInput, div));
      }
    }
  }

  // Total row (only when multiple gates)
  if (allGates.length > 1) {
    const totalRow = document.createElement('div');
    totalRow.className = 'pond-total-row';
    totalRow.innerHTML = `<span>Total</span><span class="pond-total-cfs">—</span>`;
    form.appendChild(totalRow);
  }

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = !div.classList.contains('expanded');
    div.classList.toggle('expanded', open);
    form.style.display = open ? '' : 'none';
    if (open) timeInput.value = nowHHMM();
  });

  return div;
}

function createOutletCard(outlet, dateInput, timeInput) {
  const today    = todayISO();
  const allGates = [...outlet.connections.values()].flatMap(c => c.gates);

  const lastGateDate = allGates.reduce((best, g) => {
    const d = g.last_date ? String(g.last_date).slice(0, 10) : null;
    return (!best || (d && d > best)) ? d : best;
  }, null);
  const statusDate = lastGateDate || (outlet.last_gauge_date ? String(outlet.last_gauge_date).slice(0, 10) : null);
  const badgeClass = !statusDate ? 'default' : (statusDate === today ? 'ok' : 'due');
  const badgeText  = !statusDate ? 'Not read' : (statusDate === today ? 'Today' : fmtDate(statusDate));

  const gaugeLevel = outlet.last_gauge_level;
  const gaugeDate  = outlet.last_gauge_date ? String(outlet.last_gauge_date).slice(0, 10) : null;
  const gaugeHint  = gaugeLevel != null
    ? `Staff: ${Number(gaugeLevel).toFixed(2)} ft · ${gaugeDate ? fmtDate(gaugeDate) : 'Today'}`
    : 'Staff: —';

  const div = document.createElement('div');
  div.className = 'list-item';
  div.dataset.curGaugeLevel = outlet.last_gauge_level ?? '';
  const mapPinSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;

  div.innerHTML = `
    <div class="list-item-header">
      <span class="list-item-name">${outlet.name}</span>
      <span class="pond-gauge-hint">${gaugeHint}</span>
      <button class="pond-map-btn btn btn-secondary btn-sm" title="View map" style="padding:2px 7px;flex-shrink:0">${mapPinSvg}</button>
      <span class="status-badge ${badgeClass}">${badgeText}</span>
      <span class="expand-chevron">&#9660;</span>
    </div>
    <div class="list-item-form"></div>`;

  div.querySelector('.pond-map-btn').addEventListener('click', e => {
    e.stopPropagation();
    openPondMap('outlet', outlet.outlet_id, outlet.name);
  });

  const form = div.querySelector('.list-item-form');
  form.style.display = 'none';

  form.appendChild(buildGaugeForm(outlet, dateInput, timeInput, div));

  const sortedConns = [...outlet.connections.values()].sort((a, b) => a.sort - b.sort);
  for (const conn of sortedConns) {
    const sortedGates = [...conn.gates].sort((a, b) => a.sort - b.sort);
    for (const gate of sortedGates) {
      form.appendChild(buildGateRow(gate, dateInput, timeInput, div));
    }
  }

  if (allGates.length > 1) {
    const totalRow = document.createElement('div');
    totalRow.className = 'pond-total-row';
    totalRow.innerHTML = `<span>Total</span><span class="pond-total-cfs">—</span>`;
    form.appendChild(totalRow);
  }

  div.querySelector('.list-item-header').addEventListener('click', () => {
    const open = !div.classList.contains('expanded');
    div.classList.toggle('expanded', open);
    form.style.display = open ? '' : 'none';
    if (open) timeInput.value = nowHHMM();
  });

  return div;
}

function buildCanalRow(conn, dateInput, timeInput, cardEl) {
  const today    = todayISO();
  const prevDate = conn.last_canal_date ? String(conn.last_canal_date).slice(0, 10) : null;
  const lastFlow = conn.last_canal_flow != null ? Number(conn.last_canal_flow) : null;
  const prevHint = lastFlow != null
    ? `${lastFlow.toFixed(2)} cfs · ${prevDate === today ? 'Today' : (prevDate ? fmtDate(prevDate) : '')}`
    : null;

  const wrap = document.createElement('div');
  const row  = document.createElement('div');
  row.className  = 'reading-row';
  row.style.flexWrap = 'wrap';

  const labelSub = [
    conn.canal_structure_name ? `<div class="prev-date" style="font-style:italic">${conn.canal_structure_name}</div>` : '',
    prevHint ? `<div class="prev-date">${prevHint}</div>` : '',
  ].join('');

  row.innerHTML = `
    <div class="rr-label">${conn.name}${labelSub}</div>
    <div class="rr-field-group" style="width:84px">
      <span class="rr-col-hd">Flow (cfs)</span>
      <input type="number" class="rr-input pg-canal-flow" step="0.01" placeholder="—" inputmode="decimal">
      <span class="pg-canal-flow-delta live-delta"></span>
    </div>
    <div class="rr-field-group" style="width:92px">
      <span class="rr-col-hd">Totalizer (af)</span>
      <input type="number" class="rr-input pg-canal-totalizer" step="0.01" placeholder="—" inputmode="decimal">
      <span class="live-delta" style="visibility:hidden;pointer-events:none">x</span>
    </div>
    <div style="flex:1;min-width:50px;display:flex;flex-direction:column">
      <span class="rr-col-hd" style="visibility:hidden;pointer-events:none">x</span>
      ${conn.last_canal_notes ? `<div class="prev-note-hint">${escHtml(conn.last_canal_notes)}</div>` : ''}
      <div style="display:flex;gap:4px;align-items:stretch">
        <textarea class="rr-notes-input pg-canal-notes" rows="1" placeholder="Notes…"></textarea>
        <button class="btn btn-secondary btn-sm" title="History" style="flex-shrink:0">${icon('history')}</button>
        <button class="btn btn-save btn-sm pg-canal-save" style="flex-shrink:0">Save</button>
      </div>
      <span class="live-delta" style="visibility:hidden;pointer-events:none">x</span>
    </div>`;

  const errDiv = document.createElement('div');
  errDiv.className = 'error-msg hidden';
  errDiv.style.cssText = 'font-size:0.78rem;padding:2px 10px 4px';
  wrap.appendChild(row);
  wrap.appendChild(errDiv);

  const flowInput      = row.querySelector('.pg-canal-flow');
  const totalizerInput = row.querySelector('.pg-canal-totalizer');
  const notesInput     = row.querySelector('.pg-canal-notes');
  const saveBtn        = row.querySelector('.pg-canal-save');
  const flowDeltaEl    = row.querySelector('.pg-canal-flow-delta');

  flowInput.dataset.savedFlow = conn.last_canal_flow ?? '';

  flowInput.addEventListener('input', () => {
    const v = parseFloat(flowInput.value), ref = parseFloat(flowInput.dataset.savedFlow ?? '');
    flowDeltaEl.innerHTML = (!isNaN(v) && !isNaN(ref)) ? pondDelta(v, ref).trim() : '';
  });

  row.querySelector('.btn-secondary').addEventListener('click', () =>
    openHistoryModal('canal', conn.source_canal_id,
      `${conn.name}${conn.canal_structure_name ? ' — ' + conn.canal_structure_name : ''}`));

  saveBtn.addEventListener('click', async () => {
    const flow      = parseFloat(flowInput.value);
    const totalizer = parseFloat(totalizerInput.value);
    if (isNaN(flow) && isNaN(totalizer)) {
      errDiv.textContent = 'Enter flow or totalizer.';
      errDiv.classList.remove('hidden');
      return;
    }
    errDiv.classList.add('hidden');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api('POST', '/api/readings/canal', {
        structure_id:           conn.source_canal_id,
        reading_date:           dateInput.value,
        reading_time:           timeInput.value,
        instantaneous_flow_cfs: isNaN(flow)      ? null : flow,
        totalizer_reading_af:   isNaN(totalizer) ? null : totalizer,
        notes:                  notesInput.value || null,
      });
      saveBtn.textContent = 'Saved ✓';
      saveBtn.disabled = false;
      flowInput.dataset.savedFlow = isNaN(flow) ? '' : String(flow);
      flowDeltaEl.innerHTML = '';
      showToast(`${conn.name} saved`, 'success');
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  return wrap;
}

function buildGaugeForm(pond, dateInput, timeInput, cardEl) {
  const wrap = document.createElement('div');

  const row = document.createElement('div');
  row.className = 'reading-row';
  row.style.flexWrap = 'wrap';

  const prevDate = pond.last_gauge_date ? String(pond.last_gauge_date).slice(0, 10) : null;
  const prevHint = pond.last_gauge_level != null && prevDate
    ? `${Number(pond.last_gauge_level).toFixed(2)} ft · ${fmtDate(prevDate)}` : null;

  row.innerHTML = `
    <div class="rr-label">Staff Gauge${prevHint ? `<div class="prev-date">${prevHint}</div>` : ''}</div>
    <div class="rr-field-group" style="width:72px">
      <span class="rr-col-hd">Level (ft)</span>
      <input type="number" class="rr-input pg-gauge-level" step="0.01" placeholder="—" inputmode="decimal">
      <span class="pg-gauge-delta live-delta"></span>
    </div>
    <div style="flex:1;min-width:50px;display:flex;flex-direction:column">
      <span class="rr-col-hd" style="visibility:hidden;pointer-events:none">x</span>
      ${pond.last_gauge_notes ? `<div class="prev-note-hint">${escHtml(pond.last_gauge_notes)}</div>` : ''}
      <div style="display:flex;gap:4px;align-items:stretch">
        <textarea class="rr-notes-input pg-gauge-notes" rows="1" placeholder="Notes…"></textarea>
        <button class="btn btn-secondary btn-sm" title="History" style="flex-shrink:0">${icon('history')}</button>
        <button class="btn btn-save btn-sm pg-gauge-save" style="flex-shrink:0">Save</button>
      </div>
      <span class="live-delta" style="visibility:hidden;pointer-events:none">x</span>
    </div>`;

  const errDiv = document.createElement('div');
  errDiv.className = 'error-msg hidden';
  errDiv.style.cssText = 'font-size:0.78rem;padding:2px 10px 4px';

  wrap.appendChild(row);
  wrap.appendChild(errDiv);

  const levelInput  = row.querySelector('.pg-gauge-level');
  const gaugeDeltaEl = row.querySelector('.pg-gauge-delta');
  const notesInput  = row.querySelector('.pg-gauge-notes');

  levelInput.addEventListener('input', () => {
    const v   = parseFloat(levelInput.value);
    const ref = parseFloat(cardEl.dataset.curGaugeLevel);
    gaugeDeltaEl.innerHTML = (!isNaN(v) && !isNaN(ref)) ? pondDelta(v, ref).trim() : '';
  });
  const saveBtn    = row.querySelector('.pg-gauge-save');

  const historyId = pond.outlet_id ? `outlet-${pond.outlet_id}` : pond.pond_id;
  row.querySelector('.btn-secondary').addEventListener('click', () =>
    openHistoryModal('staff-gauge', historyId, pond.name + ' — Staff Gauge'));

  saveBtn.addEventListener('click', async () => {
    const level = parseFloat(levelInput.value);
    if (isNaN(level)) {
      errDiv.textContent = 'Enter a level reading.';
      errDiv.classList.remove('hidden');
      return;
    }
    errDiv.classList.add('hidden');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const gaugeBody = pond.outlet_id
      ? { outlet_id: pond.outlet_id, reading_date: dateInput.value, reading_time: timeInput.value, level_ft: level, notes: notesInput.value || null }
      : { pond_id:   pond.pond_id,   reading_date: dateInput.value, reading_time: timeInput.value, level_ft: level, notes: notesInput.value || null };
    try {
      await api('POST', '/api/readings/staff-gauge', gaugeBody);
      saveBtn.textContent = 'Saved ✓';
      saveBtn.disabled = false;
      // Update reference level for future live-delta comparisons
      cardEl.dataset.curGaugeLevel = level;
      gaugeDeltaEl.innerHTML = ''; // delta is 0 after save
      // Update the gauge hint on the card header
      const hint = cardEl.querySelector('.pond-gauge-hint');
      const hintText = `Staff: ${level.toFixed(2)} ft · Today`;
      if (hint) hint.textContent = hintText;
      else {
        const s = document.createElement('span');
        s.className = 'pond-gauge-hint';
        s.textContent = hintText;
        cardEl.querySelector('.list-item-name').after(s);
      }
      updatePondBadge(cardEl, 'Today');
      showToast(`${pond.name} gauge saved`, 'success');
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Gauge';
    }
  });

  return wrap;
}

function buildGateRow(gate, dateInput, timeInput, cardEl) {
  const today    = todayISO();
  const prevDate = gate.last_date ? String(gate.last_date).slice(0, 10) : null;
  const lastFlow = gate.last_flow != null ? Number(gate.last_flow) : null;
  const isToday  = prevDate === today;
  const prevHint = lastFlow != null
    ? `${lastFlow.toFixed(2)} cfs · ${isToday ? 'Today' : (prevDate ? fmtDate(prevDate) : '')}`
    : (prevDate ? fmtDate(prevDate) : null);

  const wrap = document.createElement('div');
  const isWeir = gate.gate_type === 'weir';

  const row = document.createElement('div');
  row.className = 'reading-row';
  row.style.flexWrap = 'wrap';

  const labelSub = [
    prevHint ? `<div class="prev-date">${prevHint}</div>` : '',
    gate.gate_notes ? `<div class="prev-date" style="font-style:italic">${gate.gate_notes}</div>` : '',
  ].join('');

  row.innerHTML = `
    <div class="rr-label">${gate.label}${labelSub}</div>
    ${!isWeir ? `
    <div class="rr-field-group" style="width:62px">
      <span class="rr-col-hd">Head (ft)</span>
      <input type="number" class="rr-input pg-head" step="0.01" placeholder="—" inputmode="decimal">
      <span class="pg-head-delta live-delta"></span>
    </div>
    <div class="rr-field-group" style="width:72px">
      <span class="rr-col-hd">Opening (in)</span>
      <input type="number" class="rr-input pg-opening" step="0.1" placeholder="—" inputmode="decimal">
      <span class="pg-opening-delta live-delta"></span>
    </div>` : `
    <div class="rr-field-group" style="width:82px">
      <span class="rr-col-hd">Overpour (in)</span>
      <input type="number" class="rr-input pg-overpour" step="0.01" placeholder="—" inputmode="decimal">
      <span class="pg-overpour-delta live-delta"></span>
    </div>`}
    <div class="rr-field-group" style="width:84px">
      <span class="rr-col-hd">Flow (cfs)</span>
      <input type="number" class="rr-input pg-flow" step="0.01" placeholder="—" inputmode="decimal">
      <span class="pg-flow-delta live-delta"></span>
    </div>
    <div style="flex:1;min-width:50px;display:flex;flex-direction:column">
      <span class="rr-col-hd" style="visibility:hidden;pointer-events:none">x</span>
      ${gate.last_notes ? `<div class="prev-note-hint">${escHtml(gate.last_notes)}</div>` : ''}
      <div style="display:flex;gap:4px;align-items:stretch">
        <textarea class="rr-notes-input pg-gate-notes" rows="1" placeholder="Notes…"></textarea>
        <button class="btn btn-secondary btn-sm" title="History" style="flex-shrink:0">${icon('history')}</button>
        <button class="btn btn-save btn-sm pg-gate-save" style="flex-shrink:0">Save</button>
      </div>
      <span class="live-delta" style="visibility:hidden;pointer-events:none">x</span>
    </div>`;

  const errDiv = document.createElement('div');
  errDiv.className = 'error-msg hidden';
  errDiv.style.cssText = 'font-size:0.78rem;padding:2px 10px 4px';

  wrap.appendChild(row);
  wrap.appendChild(errDiv);

  const headInput     = row.querySelector('.pg-head');
  const openingInput  = row.querySelector('.pg-opening');
  const overpourInput = row.querySelector('.pg-overpour');
  const flowInput     = row.querySelector('.pg-flow');
  const notesInput    = row.querySelector('.pg-gate-notes');
  const saveBtn       = row.querySelector('.pg-gate-save');

  // Dataset refs for live delta comparisons
  if (headInput)     headInput.dataset.savedHead         = gate.last_head     ?? '';
  if (openingInput)  openingInput.dataset.savedOpening   = gate.last_opening  ?? '';
  if (overpourInput) overpourInput.dataset.savedOverpour = gate.last_overpour ?? '';
  flowInput.dataset.savedFlow = gate.last_flow ?? '';

  const headDeltaEl     = row.querySelector('.pg-head-delta');
  const openingDeltaEl  = row.querySelector('.pg-opening-delta');
  const overpourDeltaEl = row.querySelector('.pg-overpour-delta');
  const flowDeltaEl     = row.querySelector('.pg-flow-delta');

  function liveDelta(el, val, savedKey, inp) {
    if (!el || !inp) return;
    const v = parseFloat(val), ref = parseFloat(inp.dataset[savedKey] ?? '');
    el.innerHTML = (!isNaN(v) && !isNaN(ref)) ? pondDelta(v, ref).trim() : '';
  }

  function updateFlowDelta() {
    liveDelta(flowDeltaEl, flowInput.value, 'savedFlow', flowInput);
  }

  function calcFlow() {
    let q = null;
    if (isWeir) {
      const ov = parseFloat(overpourInput?.value);
      if (!isNaN(ov) && ov > 0 && gate.width_in > 0)
        q = 3.996 * (gate.width_in / 12) * Math.pow(ov / 12, 1.5);
    } else {
      const h = parseFloat(headInput?.value);
      const o = parseFloat(openingInput?.value);
      if (!isNaN(h) && h > 0 && !isNaN(o) && o > 0 && gate.width_in > 0)
        q = 0.748 * (gate.width_in / 12) * (o / 12) * Math.sqrt(64.4 * h);
    }
    if (q !== null && flowInput) flowInput.value = q.toFixed(2);
    updatePondTotal(cardEl);
    updateFlowDelta();
  }

  headInput?.addEventListener('input', () => {
    calcFlow();
    liveDelta(headDeltaEl, headInput.value, 'savedHead', headInput);
  });
  openingInput?.addEventListener('input', () => {
    calcFlow();
    liveDelta(openingDeltaEl, openingInput.value, 'savedOpening', openingInput);
  });
  overpourInput?.addEventListener('input', () => {
    calcFlow();
    liveDelta(overpourDeltaEl, overpourInput.value, 'savedOverpour', overpourInput);
  });
  flowInput?.addEventListener('input', () => { updatePondTotal(cardEl); updateFlowDelta(); });

  row.querySelector('.btn-secondary').addEventListener('click', () =>
    openHistoryModal('pond-gate', gate.gate_id, gate.label));

  saveBtn.addEventListener('click', async () => {
    errDiv.classList.add('hidden');

    if (lastFlow != null && flowInput && flowInput.value.trim() === '') {
      const _ra = await showReadingAlert('Incomplete Reading',
        `<p><strong>Flow (cfs)</strong> was recorded last time (<strong>${lastFlow.toFixed(2)} cfs</strong>) but is now blank.</p>`,
        [{ key: 'cancel', label: 'Cancel',             cls: 'btn-secondary' },
         { key: 'fill',   label: 'Fill with Previous', cls: 'btn-primary'   },
         { key: 'save',   label: 'Save Anyway',        cls: 'btn-save'      }]);
      if (_ra === 'cancel') return;
      if (_ra === 'fill') { flowInput.value = lastFlow.toFixed(2); return; }
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const h  = parseFloat(headInput?.value);
    const o  = parseFloat(openingInput?.value);
    const ov = parseFloat(overpourInput?.value);
    const fl = parseFloat(flowInput?.value);
    try {
      await api('POST', '/api/readings/pond-gate', {
        gate_id:      gate.gate_id,
        reading_date: dateInput.value,
        reading_time: timeInput.value,
        head_ft:      isNaN(h)  ? null : h,
        opening_in:   isNaN(o)  ? null : o,
        overpour_in:  isNaN(ov) ? null : ov,
        flow_cfs:     isNaN(fl) ? null : fl,
        notes:        notesInput.value || null,
      });
      saveBtn.textContent = 'Saved ✓';
      saveBtn.disabled = false;
      // Update all saved refs and clear delta spans
      if (headInput)     headInput.dataset.savedHead         = isNaN(h)  ? '' : h;
      if (openingInput)  openingInput.dataset.savedOpening   = isNaN(o)  ? '' : o;
      if (overpourInput) overpourInput.dataset.savedOverpour = isNaN(ov) ? '' : ov;
      flowInput.dataset.savedFlow = isNaN(fl) ? '' : fl;
      if (headDeltaEl)     headDeltaEl.innerHTML     = '';
      if (openingDeltaEl)  openingDeltaEl.innerHTML  = '';
      if (overpourDeltaEl) overpourDeltaEl.innerHTML = '';
      flowDeltaEl.innerHTML = '';
      updatePondTotal(cardEl);
      // Update prev hint in label
      const label = row.querySelector('.rr-label');
      const existingDate = label.querySelector('.prev-date:not([style*="italic"])') || label.querySelector('.prev-date');
      const flowText = fl != null ? `${fl.toFixed(2)} cfs · Today` : 'Today';
      if (existingDate) existingDate.textContent = flowText;
      else label.insertAdjacentHTML('beforeend', `<div class="prev-date">${flowText}</div>`);
      updatePondBadge(cardEl, 'Today');
      showToast(`${gate.label} saved`, 'success');
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Gate';
    }
  });

  return wrap;
}

function updatePondTotal(cardEl) {
  const totalEl = cardEl.querySelector('.pond-total-cfs');
  if (!totalEl) return;
  let liveTotal = 0, savedForTyped = 0, hasAny = false, hasSaved = false;
  cardEl.querySelectorAll('.pg-flow').forEach(inp => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) {
      liveTotal += v;
      hasAny = true;
      const s = parseFloat(inp.dataset.savedFlow ?? '');
      if (!isNaN(s)) { savedForTyped += s; hasSaved = true; }
    }
  });
  const deltaHtml = (hasAny && hasSaved) ? pondDelta(liveTotal, savedForTyped).trim() : '';
  totalEl.innerHTML = hasAny ? `${liveTotal.toFixed(2)} cfs ${deltaHtml}` : '—';
}

function updatePondBadge(cardEl, text) {
  const badge = cardEl.querySelector('.list-item-header .status-badge');
  if (badge) { badge.textContent = text; badge.className = 'status-badge ok'; }
}

/* ── Pond Map ────────────────────────────────────────────────────────────── */
let _pondMap = null;

async function openPondMap(entityType, entityId, entityName) {
  el('pond-map-title').textContent = entityName;
  el('pond-map-modal').classList.remove('hidden');

  const container = el('pond-map-container');
  container.innerHTML = '<div class="placeholder-msg" style="padding:20px">Loading…</div>';

  // Destroy previous Leaflet instance before re-using the container
  if (_pondMap) { _pondMap.remove(); _pondMap = null; }

  try {
    const url = entityType === 'outlet'
      ? `/api/outlets/${entityId}/polygon`
      : `/api/ponds/${entityId}/polygon`;
    const data = await api('GET', url);
    container.innerHTML = '';

    if (!data.has_polygon) {
      container.innerHTML = '<div class="placeholder-msg" style="padding:20px">No map data for this pond yet.</div>';
      return;
    }

    const map = L.map(container, { zoomControl: true });
    _pondMap = map;

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, USGS, USDA',
      maxZoom: 19,
    }).addTo(map);

    const poly = L.geoJSON(data.polygon, {
      style: { color: '#2196f3', weight: 2.5, fillColor: '#2196f3', fillOpacity: 0.15 },
    }).addTo(map);

    map.fitBounds(poly.getBounds(), { padding: [24, 24] });

    // Label at centroid
    const [lon, lat] = data.centroid.coordinates;
    L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:rgba(0,0,0,0.62);color:#fff;padding:3px 10px;border-radius:4px;font-size:0.78rem;white-space:nowrap;font-family:sans-serif">${entityName}</div>`,
        iconAnchor: [-4, 10],
      }),
      interactive: false,
    }).addTo(map);

    // Staff gauge marker
    if (data.gauge_marker) {
      L.marker([data.gauge_marker.lat, data.gauge_marker.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:#1976d2;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.72rem;white-space:nowrap;font-family:sans-serif">Staff Gauge</div>`,
          iconAnchor: [-4, 10],
        }),
        interactive: false,
      }).addTo(map);
    }

    // Gate markers
    for (const gm of (data.gate_markers || [])) {
      L.marker([gm.lat, gm.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:#e65100;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.72rem;white-space:nowrap;font-family:sans-serif">${gm.label}</div>`,
          iconAnchor: [-4, 10],
        }),
        interactive: false,
      }).addTo(map);
    }

    // Operator location dot (HTTPS / secure context only)
    if (window.isSecureContext && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude, longitude } = pos.coords;
        L.marker([latitude, longitude], {
          icon: L.divIcon({
            className: '',
            html: '<div class="map-my-location"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          zIndexOffset: 1000,
        }).bindPopup('<strong>You are here</strong>').addTo(map);
      }, () => { /* permission denied or unavailable — silent */ });
    }

    // Leaflet needs a tick after the container is visible to measure size
    setTimeout(() => map.invalidateSize(), 50);
  } catch (err) {
    container.innerHTML = `<div class="placeholder-msg" style="padding:20px">Failed to load map: ${err.message}</div>`;
  }
}

el('pond-map-close').addEventListener('click', () => {
  el('pond-map-modal').classList.add('hidden');
});
el('pond-map-modal').addEventListener('click', e => {
  if (e.target === el('pond-map-modal')) el('pond-map-modal').classList.add('hidden');
});

async function openAllPondsMap() {
  el('pond-map-title').textContent = 'Pond Maps';
  el('pond-map-modal').classList.remove('hidden');

  const container = el('pond-map-container');
  container.innerHTML = '<div class="placeholder-msg" style="padding:20px">Loading…</div>';

  if (_pondMap) { _pondMap.remove(); _pondMap = null; }

  // One color per location so ponds cluster visually by area
  const LOC_COLORS = { 1: '#2196f3', 2: '#4caf50', 3: '#ff9800', 4: '#9c27b0' };

  try {
    const ponds = await api('GET', '/api/ponds/polygons');
    if (!ponds.length) {
      container.innerHTML = '<div class="placeholder-msg" style="padding:20px">No pond maps have been entered yet.</div>';
      return;
    }

    container.innerHTML = '';
    const map = L.map(container, { zoomControl: true });
    _pondMap = map;

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, USGS, USDA',
      maxZoom: 19,
    }).addTo(map);

    const allLayers = [];

    for (const pond of ponds) {
      const color = LOC_COLORS[pond.location_id] || '#2196f3';

      const poly = L.geoJSON(pond.polygon, {
        style: { color, weight: 2, fillColor: color, fillOpacity: 0.2 },
      }).addTo(map);
      allLayers.push(poly);

      const [lon, lat] = pond.centroid.coordinates;
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:rgba(0,0,0,0.62);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.72rem;white-space:nowrap;font-family:sans-serif">${pond.pond_name}</div>`,
          iconAnchor: [-4, 10],
        }),
        interactive: false,
      }).addTo(map);
    }

    // Fit to combined bounds of all polygons
    const group = L.featureGroup(allLayers);
    map.fitBounds(group.getBounds(), { padding: [24, 24] });

    setTimeout(() => map.invalidateSize(), 50);
  } catch (err) {
    container.innerHTML = `<div class="placeholder-msg" style="padding:20px">Failed to load maps: ${err.message}</div>`;
  }
}

el('pond-maps-btn').addEventListener('click', openAllPondsMap);

// ── Well Readings Report Panel ─────────────────────────────────────────────────

let lastWellDailyRows = [];

function makeSvgSparkline(values, { width=160, height=40, inverted=false, color='#4caf50' } = {}) {
  const valid = values.map((v,i) => ({v: Number(v), i})).filter(x => !isNaN(x.v) && x.v != null);
  if (valid.length < 2) return '<span style="color:var(--text-dim);font-size:11px">—</span>';
  const min = Math.min(...valid.map(x=>x.v));
  const max = Math.max(...valid.map(x=>x.v));
  const range = max - min || 1;
  const pad = 4;
  const pts = valid.map(({v,i}) => {
    const x = pad + (i / (values.length - 1)) * (width - pad*2);
    const norm = (v - min) / range;
    const y = inverted ? pad + norm*(height-pad*2) : pad + (1-norm)*(height-pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const dotPts = valid.map(({v,i}) => {
    const x = pad + (i / (values.length - 1)) * (width - pad*2);
    const norm = (v - min) / range;
    const y = inverted ? pad + norm*(height-pad*2) : pad + (1-norm)*(height-pad*2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}"/>`;
  }).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${dotPts}
  </svg>`;
}

function wellStepDate(inputId, days, callback) {
  const inp = el(inputId);
  if (!inp.value) return;
  const d = new Date(inp.value + 'T00:00:00');
  d.setDate(d.getDate() + days);
  inp.value = d.toISOString().slice(0,10);
  callback();
}

let wellReportInitialized = false;

function initWellReportPanel() {
  const today = todayISO();
  el('well-report-date').value = today;
  el('well-detail-date').value = today;

  if (!wellReportInitialized) {
    wellReportInitialized = true;

    // Seg group tabs
    el('well-report-seg').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      el('well-report-seg').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.val;
      el('well-daily-toolbar').style.display   = tab === 'daily'   ? '' : 'none';
      el('well-detail-toolbar').style.display  = tab === 'detail'  ? '' : 'none';
      el('well-dripper-toolbar').style.display = tab === 'dripper' ? '' : 'none';
      el('well-monthly-toolbar').style.display = tab === 'monthly' ? '' : 'none';
      el('report-wells-output').innerHTML = '';
      if (tab === 'daily')   renderWellDailyReport();
      else if (tab === 'detail')  renderWellDetailReport();
      else if (tab === 'dripper') renderWellDripperReport();
      else if (tab === 'monthly') renderWellMonthlyReport();
    });

    // Monthly grid nav
    el('well-monthly-month').addEventListener('change', renderWellMonthlyReport);
    el('well-monthly-pool').addEventListener('change', renderWellMonthlyReport);

    el('well-dripper-amount').addEventListener('change', recalcDripper);

    // Daily date nav
    el('well-report-prev').addEventListener('click', () => wellStepDate('well-report-date', -1, renderWellDailyReport));
    el('well-report-next').addEventListener('click', () => wellStepDate('well-report-date', 1, renderWellDailyReport));
    el('well-report-today').addEventListener('click', () => { el('well-report-date').value = todayISO(); renderWellDailyReport(); });
    el('well-report-date').addEventListener('change', renderWellDailyReport);

    // Detail date nav
    el('well-detail-prev').addEventListener('click', () => wellStepDate('well-detail-date', -1, renderWellDetailReport));
    el('well-detail-next').addEventListener('click', () => wellStepDate('well-detail-date', 1, renderWellDetailReport));
    el('well-detail-today').addEventListener('click', () => { el('well-detail-date').value = todayISO(); renderWellDetailReport(); });
    el('well-detail-date').addEventListener('change', renderWellDetailReport);

    el('well-report-select').addEventListener('change', renderWellDetailReport);

    // Export button — routes to the active tab's export
    el('well-export-btn').addEventListener('click', () => {
      const activeTab = el('well-report-seg').querySelector('.seg-btn.active')?.dataset.val || 'daily';
      if (activeTab === 'daily') {
        if (!lastWellDailyRows.length) return showToast('No report data to export', 'error');
        exportContext = 'wells-daily';
        el('export-modal-subtitle').textContent = `Well Readings — ${el('well-report-date').value}`;
      } else if (activeTab === 'dripper') {
        if (!lastWellDripperRows.length) return showToast('No report data to export', 'error');
        exportContext = 'wells-dripper';
        el('export-modal-subtitle').textContent = `Dripper Oil Levels (fill target: ${el('well-dripper-amount').value} gal)`;
      } else {
        return showToast('Export available on Daily Overview and Dripper Oil tabs', 'info');
      }
      el('export-modal').classList.remove('hidden');
    });

    // Reset active tab to daily when re-entering
    el('well-report-seg').querySelectorAll('.seg-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    el('well-daily-toolbar').style.display   = '';
    el('well-detail-toolbar').style.display  = 'none';
    el('well-dripper-toolbar').style.display = 'none';
    el('well-monthly-toolbar').style.display = 'none';
  }

  // Default the month picker to the current month
  if (!el('well-monthly-month').value) el('well-monthly-month').value = todayISO().slice(0, 7);

  // Load pool options every open (may have changed)
  api('GET', '/api/reports/wells/pools').then(pools => {
    const sel = el('well-monthly-pool');
    const prev = sel.value;
    sel.innerHTML = pools.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
    if (prev && pools.includes(prev)) sel.value = prev;
  }).catch(() => {});

  // Load well dropdown every open (may have changed)
  api('GET', '/api/reports/wells/list').then(wells => {
    const sel = el('well-report-select');
    const prevVal = sel.value;
    sel.innerHTML = '';
    const groups = {};
    wells.forEach(w => {
      const area = w.area || 'Other';
      if (!groups[area]) groups[area] = [];
      groups[area].push(w);
    });
    Object.keys(groups).sort().forEach(area => {
      const og = document.createElement('optgroup');
      og.label = area;
      groups[area].forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.well_id;
        opt.textContent = w.common_name;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    if (prevVal) sel.value = prevVal;
  }).catch(() => {});

  renderWellDailyReport();
}

// Monthly grid: days of the month down the left, every well discharging in the
// selected pool across the top (grouped by area). Cell = last flow_cfs that day.
async function renderWellMonthlyReport() {
  const month = el('well-monthly-month').value;
  const poolName = el('well-monthly-pool').value;
  const out = el('report-wells-output');
  if (!month || !poolName) { out.innerHTML = '<div class="placeholder-msg">Select a month and pool.</div>'; return; }
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const { wells, data, daysInMonth } = await api('GET',
      `/api/reports/wells/monthly?month=${encodeURIComponent(month)}&pool=${encodeURIComponent(poolName)}`);
    if (!wells.length) { out.innerHTML = '<div class="placeholder-msg">No wells discharging in this pool.</div>'; return; }

    // Group wells by area (server already ordered by area, common_name)
    const areas = [], areaMap = {};
    wells.forEach(w => {
      const a = w.area || 'Other';
      if (!areaMap[a]) { areaMap[a] = []; areas.push(a); }
      areaMap[a].push(w);
    });
    const ordered = areas.flatMap(a => areaMap[a]);

    let areaRow = '<tr><th class="wm-day-col" rowspan="2">Day</th>';
    areas.forEach(a => { areaRow += `<th colspan="${areaMap[a].length}" class="wm-area-hdr">${escHtml(a)}</th>`; });
    areaRow += '</tr>';

    let wellRow = '<tr>';
    ordered.forEach(w => { wellRow += `<th class="report-num wm-well-hdr">${escHtml(w.common_name)}</th>`; });
    wellRow += '</tr>';

    let body = '';
    for (let d = 1; d <= daysInMonth; d++) {
      body += `<tr><td class="wm-day-col">${d}</td>`;
      ordered.forEach(w => {
        const v = data[w.well_id]?.[d];
        body += `<td class="report-num">${v != null ? Number(v).toFixed(2) : ''}</td>`;
      });
      body += '</tr>';
    }

    const monthLabel = new Date(month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    out.innerHTML = `<div class="report-card">
      <div class="report-title">Monthly Well Report — ${escHtml(poolName)}</div>
      <div class="report-subtitle">${monthLabel} · flow (cfs)</div>
      <table class="report-table wm-table">
        <thead>${areaRow}${wellRow}</thead>
        <tbody>${body}</tbody>
      </table></div>`;
  } catch (err) {
    out.innerHTML = '<div class="placeholder-msg">Failed to load.</div>';
  }
}

async function renderWellDailyReport() {
  const date = el('well-report-date').value;
  if (!date) return;
  const out = el('report-wells-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', `/api/reports/wells/daily?date=${date}`);
    lastWellDailyRows = rows;

    const readCount = rows.filter(r => r.reading_time != null).length;
    const fmtNum = (v, dec=2) => v != null ? Number(v).toFixed(dec) : '—';
    const fmtTime = t => t ? String(t).slice(0,5) : '—';

    // Group by area
    const areas = [];
    const areaMap = {};
    rows.forEach(r => {
      const area = r.area || 'Other';
      if (!areaMap[area]) { areaMap[area] = []; areas.push(area); }
      areaMap[area].push(r);
    });

    let html = `<div class="report-card">
      <div class="report-title">Well Readings</div>
      <div class="report-subtitle">${localDateStr(date)}</div>
      <div class="report-subtitle" style="font-size:0.85rem;color:var(--text-dim)">${readCount} / ${rows.length} wells read</div>`;

    areas.forEach(area => {
      html += `<div class="report-section-title">${escHtml(area)}</div>
        <table class="report-table">
          <thead><tr>
            <th>Well</th><th>Time</th><th>On/Off</th>
            <th class="report-num">Flow<br>(cfs)</th>
            <th class="report-num">Tot.<br>(AF)</th>
            <th class="report-num" title="Calculated from AF delta">Calc.<br>cfs</th>
            <th class="report-num">Drip<br>Oil</th>
            <th class="report-num">Mtr<br>Oil</th>
            <th class="report-num">kWh</th>
            <th>Notes</th>
          </tr></thead><tbody>`;

      areaMap[area].forEach(r => {
        if (r.reading_time == null) {
          html += `<tr style="opacity:0.45">
            <td>${escHtml(r.common_name)}</td>
            <td colspan="9" style="color:var(--text-dim);font-style:italic">Not read</td>
          </tr>`;
        } else {
          const _oo = r.on_off != null ? String(r.on_off).toLowerCase() : null;
          const _onLabel = (_oo === 'on' || _oo === 'true') ? 'On' : 'Off';
          const onOff = r.on_off != null
            ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${_onLabel==='On'?'var(--green)':'var(--text-dim)'};margin-right:4px"></span>${_onLabel}`
            : '—';
          const calcCell = r.totalizer_calc != null
            ? `<span style="font-style:italic;color:var(--text-dim)" title="Calculated from AF delta">${fmtNum(r.totalizer_calc)}</span>`
            : '<span style="color:var(--text-dim)">—</span>';
          const notesTrunc = r.notes
            ? `<span title="${escHtml(r.notes)}">${escHtml(r.notes.length > 40 ? r.notes.slice(0,40)+'…' : r.notes)}</span>`
            : '—';
          html += `<tr>
            <td>${escHtml(r.common_name)}</td>
            <td>${fmtTime(r.reading_time)}</td>
            <td>${onOff}</td>
            <td class="report-num">${fmtNum(r.flow_cfs)}</td>
            <td class="report-num">${fmtNum(r.totalizer)}</td>
            <td class="report-num">${calcCell}</td>
            <td class="report-num">${fmtNum(r.dripper_oil,1)}</td>
            <td class="report-num">${fmtNum(r.motor_oil,1)}</td>
            <td class="report-num">${r.pge_kwh != null ? Number(r.pge_kwh).toLocaleString() : '—'}</td>
            <td>${notesTrunc}</td>
          </tr>`;
        }
      });

      html += '</tbody></table>';
    });

    if (!rows.length) {
      html += '<div class="placeholder-msg">No operational wells found.</div>';
    }

    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

async function renderWellDetailReport() {
  const wellId = el('well-report-select').value;
  const endDate = el('well-detail-date').value;
  if (!wellId) return;
  const out = el('report-wells-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const { well, flow_readings, dtw_readings } = await api('GET', `/api/reports/wells/history?well_id=${wellId}&end_date=${endDate}`);
    const fmtNum = (v, dec=2) => v != null ? Number(v).toFixed(dec) : '—';
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const fmtTime = t => t ? String(t).slice(0,5) : '—';

    let html = '<div class="report-card">';

    // Well info header
    if (well) {
      html += `<div class="report-title">${escHtml(well.common_name)}</div>
        <div class="report-subtitle" style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.85rem;color:var(--text-dim)">
          ${well.area ? `<span>Area: ${escHtml(well.area)}</span>` : ''}
          ${well.state_well_number ? `<span>State #: ${escHtml(well.state_well_number)}</span>` : ''}
          ${well.pump_hp != null ? `<span>Pump HP: ${well.pump_hp}</span>` : ''}
          ${well.total_depth_ft != null ? `<span>Total Depth: ${well.total_depth_ft} ft</span>` : ''}
        </div>`;
    }

    // Flow readings
    html += `<div class="report-section-title">Flow Readings (last 5 as of ${endDate})</div>`;
    if (flow_readings.length) {
      const chronoFlow = [...flow_readings].reverse();
      html += makeSvgSparkline(chronoFlow.map(r => r.flow_cfs != null ? Number(r.flow_cfs) : null), { width: 200, height: 44, color: 'var(--green)' });
      html += `<table class="report-table" style="margin-top:8px">
        <thead><tr>
          <th>Date</th><th>Time</th><th>On/Off</th>
          <th class="report-num">Flow (cfs)</th>
          <th class="report-num">Totalizer (AF)</th>
          <th class="report-num">Hours</th>
          <th class="report-num">Drip Oil</th>
          <th class="report-num">Mtr Oil</th>
        </tr></thead><tbody>`;
      flow_readings.forEach(r => {
        const _oo2 = r.on_off != null ? String(r.on_off).toLowerCase() : null;
        const _onLabel2 = (_oo2 === 'on' || _oo2 === 'true') ? 'On' : 'Off';
        const onOff = r.on_off != null
          ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${_onLabel2==='On'?'var(--green)':'var(--text-dim)'};margin-right:4px"></span>${_onLabel2}`
          : '—';
        html += `<tr>
          <td>${fmtDate(r.reading_date)}</td>
          <td>${fmtTime(r.reading_time)}</td>
          <td>${onOff}</td>
          <td class="report-num">${fmtNum(r.flow_cfs)}</td>
          <td class="report-num">${fmtNum(r.totalizer)}</td>
          <td class="report-num">${r.hour_reading != null ? r.hour_reading : '—'}</td>
          <td class="report-num">${fmtNum(r.dripper_oil,1)}</td>
          <td class="report-num">${fmtNum(r.motor_oil,1)}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="placeholder-msg">No flow readings found.</div>';
    }

    // Depth-to-water readings (KF Monthly)
    html += `<div class="report-section-title" style="margin-top:16px">Depth to Water — KF Monthly (last 5 as of ${endDate})</div>`;
    if (dtw_readings.length) {
      const chronoDtw = [...dtw_readings].reverse();
      html += makeSvgSparkline(chronoDtw.map(r => r.dtw_reading != null ? Number(r.dtw_reading) : null), { width: 200, height: 44, inverted: true, color: '#2196f3' });
      html += `<table class="report-table" style="margin-top:8px">
        <thead><tr>
          <th>Date</th><th>Time</th>
          <th class="report-num">DTW (ft)</th>
          <th>Plopper/Sounder</th><th>Operator</th><th>Notes</th>
        </tr></thead><tbody>`;
      dtw_readings.forEach(r => {
        html += `<tr>
          <td>${fmtDate(r.reading_date)}</td>
          <td>${fmtTime(r.reading_time)}</td>
          <td class="report-num">${fmtNum(r.dtw_reading)}</td>
          <td>${escHtml(r.plopper_sounder || '—')}</td>
          <td>${escHtml(r.operator || '—')}</td>
          <td>${escHtml(r.notes || '—')}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="placeholder-msg">No KF monthly readings on record.</div>';
    }

    html += '</div>';
    out.innerHTML = html;
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

let lastWellDripperRows = [];

function getCheckedDripperIds() {
  return new Set([...document.querySelectorAll('.dripper-check:checked')]
    .map(cb => cb.closest('.dripper-row').dataset.wellId));
}

// Build clean (no CSS vars, no checkboxes) HTML for the dripper PDF export.
function buildDripperPdfHtml(rows, fillTo) {
  const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const areas = [...new Set(rows.map(r => r.area || 'Other'))];
  let total = 0;
  let html = `<div class="report-card">
    <div class="report-title">Dripper Oil Levels</div>
    <div class="report-subtitle">Fill target: ${fillTo} gal — ${rows.length} well${rows.length !== 1 ? 's' : ''}</div>`;
  areas.forEach(area => {
    const aRows = rows.filter(r => (r.area || 'Other') === area);
    html += `<div class="report-section-title">${escHtml(area)}</div>
      <table class="report-table"><thead><tr>
        <th>Well</th>
        <th class="report-num">Dripper Oil (gal)</th>
        <th class="report-num">Amt to Full (gal)</th>
        <th>Last Read</th>
      </tr></thead><tbody>`;
    aRows.forEach(r => {
      const dripper = r.dripper_oil != null ? Number(r.dripper_oil) : null;
      const atf = dripper != null ? Math.max(0, fillTo - dripper) : null;
      if (atf != null) total += atf;
      html += `<tr>
        <td>${escHtml(r.common_name)}</td>
        <td class="report-num">${dripper != null ? dripper.toFixed(2) + ' gal' : '<span style="color:#6b7280">No reading</span>'}</td>
        <td class="report-num">${atf != null ? atf.toFixed(2) + ' gal' : '—'}</td>
        <td>${fmtDate(r.reading_date)}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  });
  html += `<div style="padding:14px 4px 4px;display:flex;align-items:center;gap:10px;border-top:2px solid #000;margin-top:12px">
    <span style="font-weight:600">Total oil needed:</span>
    <span style="font-size:1.15rem;font-weight:700;color:#16a34a">${total.toFixed(2)}</span>
    <span style="color:#6b7280;font-size:0.85rem">gal</span>
  </div></div>`;
  return html;
}

async function renderWellDripperReport() {
  const out = el('report-wells-output');
  out.innerHTML = '<div class="placeholder-msg">Loading…</div>';
  try {
    const rows = await api('GET', '/api/reports/wells/dripper');
    lastWellDripperRows = rows;
    const fillTo = parseInt(el('well-dripper-amount').value) || 12;
    const fmtDate = s => s ? localDateStr(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    const areas = [];
    const areaMap = {};
    rows.forEach(r => {
      const area = r.area || 'Other';
      if (!areaMap[area]) { areaMap[area] = []; areas.push(area); }
      areaMap[area].push(r);
    });

    let html = `<div class="report-card">
      <div class="report-title">Dripper Oil Levels</div>
      <div class="report-subtitle" style="font-size:0.85rem;color:var(--text-dim)">Most recent reading per well · Check wells to include in total</div>`;

    areas.forEach((area, areaIdx) => {
      html += `<div class="report-section-title">${escHtml(area)}</div>
        <table class="report-table" data-area-idx="${areaIdx}">
          <thead><tr>
            <th style="width:28px"><input type="checkbox" class="dripper-area-all" data-area-idx="${areaIdx}" title="Select wells under 5 gal in this area" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green)"></th>
            <th>Well</th>
            <th class="report-num">Dripper Oil (gal)</th>
            <th class="report-num">Amt to Full (gal)</th>
            <th>Last Read</th>
          </tr></thead><tbody>`;

      areaMap[area].forEach(r => {
        const dripper = r.dripper_oil != null ? Number(r.dripper_oil) : null;
        const atf = dripper != null ? Math.max(0, fillTo - dripper).toFixed(2) : '—';
        const dripCell = dripper != null
          ? dripper.toFixed(2) + ' gal'
          : `<span style="color:var(--text-dim)">No reading</span>`;
        html += `<tr class="dripper-row" data-well-id="${r.well_id}" data-dripper-oil="${dripper != null ? dripper : ''}">
          <td><input type="checkbox" class="dripper-check" style="width:18px;height:18px;cursor:pointer;accent-color:var(--green)" ${dripper == null ? 'disabled' : ''}></td>
          <td>${escHtml(r.common_name)}</td>
          <td class="report-num">${dripCell}</td>
          <td class="report-num dripper-atf">${atf !== '—' ? atf + ' gal' : '—'}</td>
          <td>${fmtDate(r.reading_date)}</td>
        </tr>`;
      });

      html += '</tbody></table>';
    });

    if (!rows.length) html += '<div class="placeholder-msg">No operational wells found.</div>';

    html += `<div style="padding:14px 4px 4px;display:flex;align-items:center;gap:10px;border-top:2px solid var(--border);margin-top:12px">
      <span style="font-weight:600">Total oil needed (checked wells):</span>
      <span id="dripper-total" style="font-size:1.15rem;font-weight:700;color:var(--green)">0.00</span>
      <span style="color:var(--text-dim);font-size:0.85rem">gal</span>
    </div></div>`;

    out.innerHTML = html;

    out.addEventListener('change', e => {
      if (e.target.classList.contains('dripper-area-all')) {
        const table = e.target.closest('table');
        // Select only wells with dripper oil < 5 gal (toggle: all-under-5 checked → uncheck all)
        const under5 = [...table.querySelectorAll('.dripper-row')].filter(row => {
          const v = parseFloat(row.dataset.dripperOil);
          return !isNaN(v) && v < 5;
        });
        const allUnder5Checked = under5.length > 0 && under5.every(r => r.querySelector('.dripper-check').checked);
        under5.forEach(r => { r.querySelector('.dripper-check').checked = !allUnder5Checked; });
        e.target.checked = !allUnder5Checked && under5.length > 0;
        e.target.indeterminate = false;
        recalcDripper();
      } else if (e.target.classList.contains('dripper-check')) {
        const table = e.target.closest('table');
        const under5 = [...table.querySelectorAll('.dripper-row')].filter(row => {
          const v = parseFloat(row.dataset.dripperOil);
          return !isNaN(v) && v < 5;
        });
        const checkedUnder5 = under5.filter(r => r.querySelector('.dripper-check').checked).length;
        const areaAll = table.querySelector('.dripper-area-all');
        if (areaAll) {
          areaAll.indeterminate = checkedUnder5 > 0 && checkedUnder5 < under5.length;
          areaAll.checked = under5.length > 0 && checkedUnder5 === under5.length;
        }
        recalcDripper();
      }
    });
  } catch (err) {
    out.innerHTML = `<div class="placeholder-msg" style="color:var(--red-light)">${err.message}</div>`;
  }
}

function recalcDripper() {
  const fillTo = parseInt(el('well-dripper-amount').value) || 12;
  let total = 0;
  document.querySelectorAll('.dripper-row').forEach(row => {
    const raw = row.dataset.dripperOil;
    const dripper = raw !== '' ? parseFloat(raw) : null;
    const atf = dripper != null ? Math.max(0, fillTo - dripper) : null;
    row.querySelector('.dripper-atf').textContent = atf != null ? atf.toFixed(2) + ' gal' : '—';
    if (row.querySelector('.dripper-check').checked && atf != null) total += atf;
  });
  const totalEl = document.getElementById('dripper-total');
  if (totalEl) totalEl.textContent = total.toFixed(2);
}


/* ── Init ────────────────────────────────────────────────────────────────── */
checkDBStatus();
loadLoginUserList();
checkAuth();

// Show any Microsoft login error passed back via ?ms_error= query param
(function checkMsError() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('ms_error');
  if (!err) return;
  const msgs = {
    no_account:  'No WaterMark account is linked to that Microsoft identity. Contact your administrator.',
    no_email:    'Could not retrieve your email from Microsoft. Contact your administrator.',
    auth_failed: 'Microsoft sign-in failed. Please try again.',
  };
  history.replaceState({}, '', window.location.pathname);
  const errEl = el('ms-login-error');
  if (errEl) { errEl.textContent = msgs[err] || 'Sign-in error.'; errEl.classList.remove('hidden'); }
})();

// Hide MS login button if Entra ID is not configured on the server
fetch('/auth/microsoft/status')
  .then(r => r.json())
  .then(({ enabled }) => {
    if (enabled) return;
    const btn = el('ms-login-btn');
    if (!btn) return;
    const divider = btn.previousElementSibling;
    if (divider && divider.classList.contains('login-divider')) divider.remove();
    btn.remove();
  })
  .catch(() => {});
