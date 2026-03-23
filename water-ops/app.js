import { queueReading, cacheAssets, getCachedAssets, cacheLastReadings, getCachedLastReadings, prependToCache, getPendingCount, clearAllPending, exportPendingAsCSV } from './db.js';
import { submitReading, startAutoSync, setSyncStatusCallback, syncNow } from './sync.js';
import { api, getBaseUrl, setBaseUrl, clearBaseUrl } from './config.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  user: null,
  screen: 'login',
  readingType: null,
  assetStep: 0,          // for multi-step asset selection
  wellsReadToday: new Set(),     // well_ids saved during this session (daily readings)
  kfWellsReadRecent: new Set(),  // well_ids read in last 30 days (KF readings)
  selectedSite: null,
  selectedBuilding: null,
  selectedAsset: null,   // the final selected asset object
  lastReadings: [],
  assets: {},
  wellSearch: '',
  dailySiteId: null,     // last-used site for daily screen
  dailyReadings: null,   // { pumpHours, compHours, pge, powerMonitors }
};

// ─── Formula Engine ───────────────────────────────────────────────────────────
const FORMULAS = {
  pge: (cur, prev) => {
    if (!prev) return null;
    const diff = parseFloat(cur.kwh_reading) - parseFloat(prev.kwh_reading);
    return { label: 'kWh Used', value: diff.toFixed(1), unit: 'kWh', warn: diff < 0 };
  },
  'power-monitor': (cur, prev) => {
    if (!prev) return null;
    const diff = parseFloat(cur.kwh_reading) - parseFloat(prev.kwh_reading);
    return { label: 'kWh Used', value: diff.toFixed(1), unit: 'kWh', warn: diff < 0 };
  },
  'pump-hours': (cur, prev) => {
    if (!prev) return null;
    const diff = parseFloat(cur.hour_reading) - parseFloat(prev.hour_reading);
    const days = daysBetween(prev.reading_date, cur.reading_date);
    const perDay = days > 0 ? ` (${(diff / days).toFixed(1)} hrs/day)` : '';
    return { label: 'Run Hours', value: diff.toFixed(2), unit: `hrs${perDay}`, warn: diff < 0 };
  },
  'compressor-hours': (cur, prev) => {
    if (!prev) return null;
    const diff = parseFloat(cur.hour_reading) - parseFloat(prev.hour_reading);
    return { label: 'Run Hours', value: diff.toFixed(2), unit: 'hrs', warn: diff < 0 };
  },
  'well-static': (cur, prev) => {
    if (!prev) return null;
    const diff = parseFloat(cur.dtw_reading) - parseFloat(prev.dtw_reading);
    const dir = diff > 0 ? '▲ deeper' : diff < 0 ? '▼ shallower' : 'no change';
    return { label: 'Change in Depth', value: Math.abs(diff).toFixed(2), unit: `ft (${dir})`, warn: false };
  },
  'well-operational': (cur, prev) => {
    if (!prev) return null;
    const afDiff = parseFloat(cur.totalizer_reading_af) - parseFloat(prev.totalizer_reading_af);
    const hrDiff = parseFloat(cur.hour_reading) - parseFloat(prev.hour_reading);
    // 1 AF = 12.1 CFS-hours → avg CFS = afDiff / hrDiff * 12.1
    const avgCfs = hrDiff > 0 ? (afDiff / hrDiff * 12.1).toFixed(2) : null;
    const extra = avgCfs ? ` | avg ${avgCfs} CFS` : '';
    return { label: 'AF Used', value: afDiff.toFixed(3), unit: `AF${extra}`, warn: afDiff < 0 };
  },
  canal: (cur, prev) => {
    if (!prev || !cur.totalizer_reading_af || !prev.totalizer_reading_af) return null;
    const diff = parseFloat(cur.totalizer_reading_af) - parseFloat(prev.totalizer_reading_af);
    return { label: 'AF Since Last', value: diff.toFixed(3), unit: 'AF', warn: diff < 0 };
  },
  pond: (cur, prev) => {
    if (!prev || cur.flow_in_cfs === undefined) return null;
    const net = (parseFloat(cur.flow_in_cfs) || 0) - (parseFloat(cur.flow_out_cfs) || 0);
    return { label: 'Net Flow', value: net.toFixed(2), unit: net >= 0 ? 'CFS in' : 'CFS out', warn: false };
  },
  vehicle: (cur, prev) => {
    if (!prev) return null;
    if (cur.odometer_miles && prev.odometer_miles) {
      const diff = parseFloat(cur.odometer_miles) - parseFloat(prev.odometer_miles);
      return { label: 'Miles Driven', value: Math.round(diff), unit: 'mi', warn: diff < 0 };
    }
    if (cur.engine_hours && prev.engine_hours) {
      const diff = parseFloat(cur.engine_hours) - parseFloat(prev.engine_hours);
      return { label: 'Hours Used', value: diff.toFixed(1), unit: 'hrs', warn: diff < 0 };
    }
    return null;
  },
};

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 0;
  const a = new Date(dateA), b = new Date(dateB);
  return Math.abs((b - a) / 86400000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Reading type metadata ────────────────────────────────────────────────────
const READING_TYPES = {
  'pump-hours':       { label: 'Pump Hours',        icon: '⏱️', group: 'Pumping Plants' },
  pge:                { label: 'PGE Meter',          icon: '⚡', group: 'Pumping Plants' },
  'power-monitor':    { label: 'Power Monitor',      icon: '📊', group: 'Pumping Plants' },
  'compressor-hours': { label: 'Compressor Hours',   icon: '🔧', group: 'Pumping Plants' },
  'well-operational': { label: 'Well Daily Readings', icon: '💧', group: 'Wells' },
  'well-static':      { label: 'KF Readings',         icon: '📏', group: 'Wells' },
  canal:              { label: 'Canal Reading',       icon: '🌊', group: 'Canal & Ponds' },
  pond:               { label: 'Pond Reading',        icon: '🏞️', group: 'Canal & Ponds' },
  vehicle:            { label: 'Vehicle Reading',     icon: '🚛', group: 'Vehicles' },
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const screen = $(name);
  if (screen) { screen.classList.remove('hidden'); window.scrollTo(0, 0); }
  state.screen = name;
}

function setStatus(msg, type = 'info') {
  const bar = $('sync-bar');
  if (!bar) return;
  const colors = { info: 'bg-blue-600', success: 'bg-green-600', warning: 'bg-amber-500', error: 'bg-red-600' };
  bar.className = `fixed top-0 left-0 right-0 z-50 text-white text-sm py-1 flex items-center justify-between px-2 gap-2 transition-colors ${colors[type] || colors.info}`;
  const msgEl = $('sync-bar-msg');
  if (msgEl) msgEl.textContent = msg;
  $('pending-badge') && updatePendingBadge();
  updateSyncActions();
}

async function updatePendingBadge() {
  const count = await getPendingCount();
  const badge = $('pending-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function updateSyncActions() {
  const count = await getPendingCount();
  const actions = $('sync-actions');
  if (actions) {
    if (count > 0) actions.classList.remove('hidden');
    else actions.classList.add('hidden');
  }
}

// ── Cancel sync (clear queue) ─────────────────────────────────────────────────
$('cancel-sync-btn') && $('cancel-sync-btn').addEventListener('click', async () => {
  const count = await getPendingCount();
  if (count === 0) return;
  if (!confirm(`Clear all ${count} queued reading(s)? This cannot be undone.\n\nTip: Export CSV first to keep a backup.`)) return;
  await clearAllPending();
  updatePendingBadge();
  updateSyncActions();
  setStatus('Queue cleared', 'info');
});

// ── Export pending readings as CSV ────────────────────────────────────────────
$('export-csv-btn') && $('export-csv-btn').addEventListener('click', async () => {
  const csv = await exportPendingAsCSV();
  if (!csv) { alert('No pending readings to export.'); return; }
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `waterops-pending-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Asset loading ─────────────────────────────────────────────────────────────
async function loadAssets() {
  // Try cache first for instant display
  const cached = await getCachedAssets();
  if (cached) {
    state.assets = cached;
    renderMenu();
  }

  // Then refresh from server
  try {
    const resp = await fetch(api('/api/assets/all'));
    if (resp.ok) {
      const data = await resp.json();
      state.assets = data;
      await cacheAssets(data);
      renderMenu();
    }
  } catch (e) {
    if (!cached) setStatus('Offline — using cached assets', 'warning');
  }
}

// ─── Login screen ─────────────────────────────────────────────────────────────
async function initLogin() {
  try {
    const resp = await fetch(api('/api/users'));
    const users = resp.ok ? await resp.json() : (state.assets.users || []);
    const sel = $('user-select');
    sel.innerHTML = '<option value="">— Select your name —</option>' +
      users.map(u => `<option value="${u.username}">${u.full_name}</option>`).join('');
  } catch (e) {
    const cached = state.assets.users || [];
    const sel = $('user-select');
    sel.innerHTML = '<option value="">— Select your name —</option>' +
      cached.map(u => `<option value="${u.username}">${u.full_name}</option>`).join('');
  }
}

$('login-btn') && $('login-btn').addEventListener('click', () => {
  const sel = $('user-select');
  if (!sel.value) { alert('Please select your name first.'); return; }
  state.user = sel.value;
  loadAssets().then(() => showScreen('screen-menu'));
  showScreen('screen-menu');
});

// ─── Menu screen ──────────────────────────────────────────────────────────────
// Pumping plant reading types replaced in menu by the single Daily screen
const DAILY_TYPES = new Set(['pump-hours', 'pge', 'power-monitor', 'compressor-hours']);

function renderMenu() {
  const container = $('menu-cards');
  if (!container) return;
  container.innerHTML = '';

  // ── Pumping Plants → single Daily card ───────────────────────────────────
  const ppSection = el('div', 'mb-4');
  ppSection.appendChild(el('h2', 'text-xs font-bold uppercase text-sky-300 tracking-widest mb-2 px-1', 'Pumping Plants'));
  const dailyCard = el('button',
    'flex items-center gap-4 bg-sky-900 hover:bg-sky-700 active:bg-sky-600 text-white rounded-xl p-4 w-full touch-manipulation',
    `<span class="text-4xl">📋</span>
     <div class="text-left">
       <div class="text-base font-bold leading-snug">Daily Pumping Plant Readings</div>
       <div class="text-xs text-sky-400 mt-0.5">Pump hours · PG&amp;E · Compressors — all sites, one form</div>
     </div>`
  );
  dailyCard.addEventListener('click', () => openDailyScreen());
  ppSection.appendChild(dailyCard);
  container.appendChild(ppSection);

  // ── All other reading groups (wells, canal, ponds, vehicles) ─────────────
  const groups = {};
  for (const [type, meta] of Object.entries(READING_TYPES)) {
    if (DAILY_TYPES.has(type)) continue;
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ type, ...meta });
  }
  for (const [group, items] of Object.entries(groups)) {
    const section = el('div', 'mb-4');
    section.appendChild(el('h2', 'text-xs font-bold uppercase text-sky-300 tracking-widest mb-2 px-1', group));
    const grid = el('div', 'grid grid-cols-2 gap-3');
    for (const item of items) {
      const card = el('button',
        'flex flex-col items-center justify-center bg-sky-900 hover:bg-sky-700 active:bg-sky-600 text-white rounded-xl p-4 gap-2 w-full touch-manipulation',
        `<span class="text-3xl">${item.icon}</span><span class="text-sm font-semibold text-center leading-tight">${item.label}</span>`
      );
      card.addEventListener('click', () => startReadingFlow(item.type));
      grid.appendChild(card);
    }
    section.appendChild(grid);
    container.appendChild(section);
  }

  $('menu-user') && ($('menu-user').textContent = state.user);
  updatePendingBadge();
}

$('menu-sync-btn') && $('menu-sync-btn').addEventListener('click', async () => {
  setStatus('Syncing…', 'info');
  const result = await syncNow();
  updatePendingBadge();
});

// ─── Asset selection flow ─────────────────────────────────────────────────────
function startReadingFlow(type) {
  state.readingType = type;
  state.selectedSite = null;
  state.selectedBuilding = null;
  state.selectedAsset = null;
  state.assetStep = 0;

  const selectors = {
    'pump-hours':       showSiteSelector,
    pge:                showSiteSelector,
    'power-monitor':    showSiteSelector,
    'compressor-hours': showSiteSelector,
    'well-operational': showWellSelector,
    'well-static':      showKFSetSelector,
    canal:              showCanalSelector,
    pond:               showPondSelector,
    vehicle:            showVehicleSelector,
  };
  (selectors[type] || showSiteSelector)();
}

// Site → Building → Asset
function showSiteSelector() {
  const container = $('asset-content');
  const meta = READING_TYPES[state.readingType];
  $('asset-title').textContent = `${meta.label} — Select Site`;
  container.innerHTML = '';

  const sites = (state.assets.sites || []).filter(s => state.readingType !== 'pump-hours' || s.site_type === 'pumping_plant');

  for (const site of sites) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-4 text-left flex items-center gap-3 touch-manipulation mb-2',
      `<span class="text-2xl font-bold text-sky-300">${site.site_id}</span><span class="font-semibold">${site.site_name}</span>`
    );
    btn.addEventListener('click', () => {
      state.selectedSite = site;
      showBuildingSelector();
    });
    container.appendChild(btn);
  }
  showScreen('screen-asset');
}

function showBuildingSelector() {
  const container = $('asset-content');
  const meta = READING_TYPES[state.readingType];
  $('asset-title').textContent = `${meta.label} — ${state.selectedSite.site_name}`;
  container.innerHTML = '';

  const buildings = (state.assets.buildings || []).filter(b => b.site_id === state.selectedSite.site_id);

  for (const bldg of buildings) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-4 text-left flex items-center gap-3 touch-manipulation mb-2',
      `<span class="text-2xl font-bold text-sky-300">Building ${bldg.building_letter}</span>`
    );
    btn.addEventListener('click', () => {
      state.selectedBuilding = bldg;
      showAssetForBuilding();
    });
    container.appendChild(btn);
  }
}

function showAssetForBuilding() {
  const type = state.readingType;
  if (type === 'pump-hours') return showPumpPositionSelector();
  if (type === 'pge') return selectMeterForBuilding('pgeMeters', 'pge_meter_id', 'PGE Meter', 'meter_number');
  if (type === 'power-monitor') return selectMeterForBuilding('powerMonitors', 'monitor_id', 'Power Monitor', 'monitor_number');
  if (type === 'compressor-hours') return selectMeterForBuilding('compressors', 'compressor_id', 'Compressor', 'serial_number');
}

function selectMeterForBuilding(assetKey, idField, label, displayField) {
  const items = (state.assets[assetKey] || []).filter(m => m.building_id === state.selectedBuilding.building_id);

  if (items.length === 1) {
    // Only one — auto-select
    state.selectedAsset = items[0];
    state.selectedAsset._assetId = items[0][idField];
    loadFormForAsset();
    return;
  }

  const container = $('asset-content');
  $('asset-title').textContent = `Select ${label}`;
  container.innerHTML = '';

  for (const item of items) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-4 text-left touch-manipulation mb-2',
      `<div class="font-semibold">${item[displayField] || label}</div>`
    );
    btn.addEventListener('click', () => {
      state.selectedAsset = item;
      state.selectedAsset._assetId = item[idField];
      loadFormForAsset();
    });
    container.appendChild(btn);
  }
}

function showPumpPositionSelector() {
  const container = $('asset-content');
  $('asset-title').textContent = `Pump Positions — ${state.selectedSite.site_name} Bldg ${state.selectedBuilding.building_letter}`;
  container.innerHTML = '';

  const positions = (state.assets.pumpPositions || []).filter(
    p => p.building_id === state.selectedBuilding.building_id
  );

  const grid = el('div', 'grid grid-cols-3 gap-3');
  for (const pos of positions) {
    const btn = el('button',
      'bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-4 flex flex-col items-center gap-1 touch-manipulation',
      `<span class="text-2xl font-bold">${pos.position_id}</span><span class="text-xs text-sky-300">${pos.rated_hp} HP</span>`
    );
    btn.addEventListener('click', () => {
      state.selectedAsset = pos;
      state.selectedAsset._assetId = pos.position_id;
      loadFormForAsset();
    });
    grid.appendChild(btn);
  }
  container.appendChild(grid);
}

function showWellSelector() {
  // Step 1: show area picker
  showWellAreaSelector();
}

function showWellAreaSelector() {
  const meta = READING_TYPES[state.readingType];
  $('asset-title').textContent = `${meta.label} — Select Area`;
  const container = $('asset-content');
  container.innerHTML = '';

  const wells = state.assets.wells || [];
  if (wells.length === 0) {
    container.innerHTML = '<p class="text-sky-400 text-center py-8">No wells found.<br>Check that wells are entered in the database.</p>';
    showScreen('screen-asset');
    return;
  }

  // Group by area, null → 'Other'
  const areaMap = new Map();
  for (const w of wells) {
    const area = w.area || 'Other';
    if (!areaMap.has(area)) areaMap.set(area, []);
    areaMap.get(area).push(w);
  }

  // Sort areas: named ones alphabetically, Other last
  const areas = [...areaMap.keys()].sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  const listEl = el('div', 'space-y-3');
  for (const area of areas) {
    const areaWells = areaMap.get(area);
    const readCount = areaWells.filter(w => state.wellsReadToday.has(w.well_id)).length;
    const allRead = readCount === areaWells.length;
    const btn = el('button',
      `w-full rounded-xl p-4 text-left touch-manipulation transition-colors ${allRead ? 'bg-green-800 hover:bg-green-700' : 'bg-sky-800 hover:bg-sky-700'}`,
      `<div class="flex items-center justify-between">
         <span class="font-bold text-lg">${area}</span>
         <span class="text-sm ${allRead ? 'text-green-300' : 'text-sky-400'}">${readCount}/${areaWells.length} read ${allRead ? '✓' : ''}</span>
       </div>
       <div class="text-xs text-sky-400 mt-0.5">${areaWells.map(w => w.common_name || w.well_id).join(', ')}</div>`
    );
    btn.addEventListener('click', () => showWellListForArea(area, areaWells));
    listEl.appendChild(btn);
  }
  container.appendChild(listEl);
  showScreen('screen-asset');
}

function showWellListForArea(area, areaWells) {
  const meta = READING_TYPES[state.readingType];
  $('asset-title').textContent = `${area}`;
  const container = $('asset-content');
  container.innerHTML = '';

  // Back to areas button
  const backBtn = el('button',
    'mb-4 bg-sky-800 hover:bg-sky-700 text-sky-300 text-sm font-semibold rounded-xl px-4 py-2 touch-manipulation',
    '← Back to Areas'
  );
  backBtn.addEventListener('click', showWellAreaSelector);
  container.appendChild(backBtn);

  const listEl = el('div', 'space-y-2');

  function renderList() {
    listEl.innerHTML = '';
    for (const well of areaWells) {
      const done = state.wellsReadToday.has(well.well_id);
      const btn = el('button',
        `w-full rounded-xl p-3 text-left touch-manipulation transition-colors ${done ? 'bg-green-800 hover:bg-green-700 border border-green-600' : 'bg-sky-800 hover:bg-sky-600'}`,
        `<div class="flex items-center justify-between">
           <div>
             <span class="font-bold">${well.common_name || well.well_id}</span>
             ${well.state_well_number ? `<span class="text-xs text-sky-400 ml-2">${well.state_well_number}</span>` : ''}
           </div>
           ${done ? '<span class="text-green-300 text-xl">✓</span>' : ''}
         </div>
         ${well.agency ? `<div class="text-xs text-sky-400 mt-0.5">${well.agency}${well.participant ? ' · ' + well.participant : ''}</div>` : ''}`
      );
      btn.addEventListener('click', () => {
        state.selectedAsset = well;
        state.selectedAsset._assetId = well.well_id;
        state._wellAreaReturn = () => showWellListForArea(area, areaWells);
        loadFormForAsset();
      });
      listEl.appendChild(btn);
    }
  }

  renderList();
  container.appendChild(listEl);
}

// ─── KF Readings — set/well selection ─────────────────────────────────────────

async function showKFSetSelector() {
  $('asset-title').textContent = 'KF Readings — Select Set';
  const container = $('asset-content');
  container.innerHTML = '<p class="text-sky-400 text-center py-8">Loading…</p>';
  showScreen('screen-asset');

  // Fetch wells read in the last 30 days
  try {
    const resp = await fetch(api('/api/kf-wells/recent'));
    if (resp.ok) state.kfWellsReadRecent = new Set(await resp.json());
  } catch (e) { /* offline — use existing set */ }

  container.innerHTML = '';

  const kfWells = state.assets.kfWells || [];
  if (kfWells.length === 0) {
    container.innerHTML = '<p class="text-sky-400 text-center py-8">No KF wells found.<br>Check that wells have a KF set assigned.</p>';
    return;
  }

  // Group by kf_set_id
  const setMap = new Map();
  for (const w of kfWells) {
    const sid = w.kf_set_id;
    if (!setMap.has(sid)) setMap.set(sid, []);
    setMap.get(sid).push(w);
  }

  // Sort: numeric sets first (1–6), then P, then H
  const sortKey = id => {
    const n = parseInt(id);
    if (!isNaN(n)) return n;
    const s = String(id).toUpperCase();
    if (s === 'P') return 97;
    if (s === 'H') return 98;
    return 99;
  };
  const sets = [...setMap.keys()].sort((a, b) => sortKey(a) - sortKey(b));

  const listEl = el('div', 'space-y-3');
  for (const setId of sets) {
    const setWells = setMap.get(setId);
    const setName = setWells[0].set_name || `Set ${setId}`;
    const readCount = setWells.filter(w => state.kfWellsReadRecent.has(w.well_id)).length;
    const allRead = readCount === setWells.length;
    const preview = setWells.map(w => w.common_name || w.well_id).slice(0, 4).join(', ') + (setWells.length > 4 ? '…' : '');
    const btn = el('button',
      `w-full rounded-xl p-4 text-left touch-manipulation transition-colors ${allRead ? 'bg-green-800 hover:bg-green-700' : 'bg-sky-800 hover:bg-sky-700'}`,
      `<div class="flex items-center justify-between">
         <span class="font-bold text-lg">${setName}</span>
         <span class="text-sm ${allRead ? 'text-green-300' : 'text-sky-400'}">${readCount}/${setWells.length} read ${allRead ? '✓' : ''}</span>
       </div>
       <div class="text-xs text-sky-400 mt-0.5">${preview}</div>`
    );
    btn.addEventListener('click', () => showKFWellListForSet(setId, setWells, setName));
    listEl.appendChild(btn);
  }
  container.appendChild(listEl);
}

function showKFWellListForSet(setId, setWells, setName) {
  $('asset-title').textContent = setName || `Set ${setId}`;
  const container = $('asset-content');
  container.innerHTML = '';

  const backBtn = el('button',
    'mb-4 bg-sky-800 hover:bg-sky-700 text-sky-300 text-sm font-semibold rounded-xl px-4 py-2 touch-manipulation',
    '← Back to Sets'
  );
  backBtn.addEventListener('click', showKFSetSelector);
  container.appendChild(backBtn);

  const listEl = el('div', 'space-y-2');

  function renderList() {
    listEl.innerHTML = '';
    for (const well of setWells) {
      const done = state.kfWellsReadRecent.has(well.well_id);
      const btn = el('button',
        `w-full rounded-xl p-3 text-left touch-manipulation transition-colors ${done ? 'bg-green-800 hover:bg-green-700 border border-green-600' : 'bg-sky-800 hover:bg-sky-600'}`,
        `<div class="flex items-center justify-between">
           <div>
             <span class="font-bold">${well.common_name || well.well_id}</span>
             ${well.state_well_number ? `<span class="text-xs text-sky-400 ml-2">${well.state_well_number}</span>` : ''}
           </div>
           ${done ? '<span class="text-green-300 text-xl">✓</span>' : ''}
         </div>
         ${well.agency ? `<div class="text-xs text-sky-400 mt-0.5">${well.agency}</div>` : ''}`
      );
      btn.addEventListener('click', () => {
        state.selectedAsset = well;
        state.selectedAsset._assetId = well.well_id;
        state._kfSetReturn = () => showKFWellListForSet(setId, setWells, setName);
        loadFormForAsset();
      });
      listEl.appendChild(btn);
    }
  }

  renderList();
  container.appendChild(listEl);
}

function showCanalSelector() {
  $('asset-title').textContent = 'Canal Reading — Select Structure';
  const container = $('asset-content');
  container.innerHTML = '';

  for (const s of (state.assets.canals || [])) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-3 text-left touch-manipulation mb-2',
      `<div class="font-bold">${s.structure_name}</div>
       <div class="text-xs text-sky-300">${s.structure_type.replace('_', ' ')} · flow: ${s.flow_direction}</div>`
    );
    btn.addEventListener('click', () => {
      state.selectedAsset = s;
      state.selectedAsset._assetId = s.structure_id;
      loadFormForAsset();
    });
    container.appendChild(btn);
  }
  showScreen('screen-asset');
}

function showPondSelector() {
  $('asset-title').textContent = 'Pond Reading — Select Pond';
  const container = $('asset-content');
  container.innerHTML = '';

  for (const p of (state.assets.ponds || [])) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-3 text-left touch-manipulation mb-2',
      `<div class="font-bold">${p.pond_name}</div>`
    );
    btn.addEventListener('click', () => {
      state.selectedAsset = p;
      state.selectedAsset._assetId = p.pond_id;
      loadFormForAsset();
    });
    container.appendChild(btn);
  }
  showScreen('screen-asset');
}

function showVehicleSelector() {
  $('asset-title').textContent = 'Vehicle Reading — Select Vehicle';
  const container = $('asset-content');
  container.innerHTML = '';

  for (const v of (state.assets.vehicles || [])) {
    const btn = el('button',
      'w-full bg-sky-800 hover:bg-sky-600 text-white rounded-xl p-3 text-left touch-manipulation mb-2',
      `<div class="font-bold">#${v.vehicle_number} — ${v.year} ${v.make} ${v.model}</div>
       <div class="text-xs text-sky-300">${v.fuel_type} · reads: ${v.reading_type}</div>`
    );
    btn.addEventListener('click', () => {
      state.selectedAsset = v;
      state.selectedAsset._assetId = v.vehicle_id;
      loadFormForAsset();
    });
    container.appendChild(btn);
  }
  showScreen('screen-asset');
}

// ─── Form rendering ───────────────────────────────────────────────────────────
async function loadFormForAsset() {
  const type = state.readingType;
  const asset = state.selectedAsset;
  const assetId = asset._assetId;

  // Load last 5 readings
  let readings = [];
  try {
    const resp = await fetch(api(`/api/readings/${type}/${encodeURIComponent(assetId)}/last5`));
    if (resp.ok) {
      readings = await resp.json();
      await cacheLastReadings(type, assetId, readings);
    }
  } catch (e) {
    readings = await getCachedLastReadings(type, assetId);
  }
  state.lastReadings = readings;

  renderForm();
  showScreen('screen-form');
}

function assetLabel() {
  const asset = state.selectedAsset;
  const type = state.readingType;
  if (type === 'pump-hours') return `Position ${asset.position_id} — ${asset.site_name} Bldg ${asset.building_letter}`;
  if (type === 'pge') return `PGE Meter ${asset.meter_number} — ${asset.site_name} Bldg ${asset.building_letter}`;
  if (type === 'power-monitor') return `Monitor ${asset.monitor_number} — ${asset.site_name} Bldg ${asset.building_letter}`;
  if (type === 'compressor-hours') return `Compressor ${asset.serial_number || asset.compressor_id} — ${asset.site_name} Bldg ${asset.building_letter}`;
  if (type === 'well-operational' || type === 'well-static') return `Well ${asset.well_id}${asset.common_name && asset.common_name !== asset.well_id ? ` (${asset.common_name})` : ''}`;
  if (type === 'canal') return `${asset.structure_name} (${asset.structure_type.replace('_', ' ')})`;
  if (type === 'pond') return asset.pond_name;
  if (type === 'vehicle') return `#${asset.vehicle_number} — ${asset.year} ${asset.make} ${asset.model}`;
  return JSON.stringify(asset);
}

function prevReading() {
  return state.lastReadings.length > 0 ? state.lastReadings[0] : null;
}

function renderForm() {
  const type = state.readingType;
  const meta = READING_TYPES[type];
  const prev = prevReading();

  $('form-title').textContent = meta.label;
  $('form-asset-label').textContent = assetLabel();

  // Previous reading summary
  const prevEl = $('form-prev-reading');
  prevEl.innerHTML = '';
  if (prev) {
    prevEl.innerHTML = `
      <div class="bg-sky-950 border border-sky-700 rounded-xl p-3 mb-4">
        <div class="text-xs font-bold text-sky-400 uppercase tracking-wide mb-1">Previous Reading</div>
        ${prevReadingSummary(type, prev)}
      </div>`;
  }

  // Render the type-specific inputs
  const inputsEl = $('form-inputs');
  inputsEl.innerHTML = formInputsHTML(type);

  // Formula display (updates on input)
  const calcEl = $('form-calc');
  calcEl.innerHTML = '';

  // Last 5 history table
  renderHistory();

  // Wire up live formula computation
  inputsEl.querySelectorAll('input, select, textarea').forEach(inp => {
    inp.addEventListener('input', () => updateFormula());
  });

  // Pre-fill date and time
  const dateInp = inputsEl.querySelector('[name="reading_date"]');
  if (dateInp && !dateInp.value) dateInp.value = today();
  const timeInp = inputsEl.querySelector('[name="reading_time"]');
  if (timeInp && !timeInp.value) timeInp.value = new Date().toTimeString().slice(0, 5);
}

function prevReadingSummary(type, prev) {
  const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  switch (type) {
    case 'pge':
    case 'power-monitor':
      return `<div class="text-white font-bold text-xl">${prev.kwh_reading.toLocaleString()} kWh</div><div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)}</div>`;
    case 'pump-hours':
    case 'compressor-hours':
      return `<div class="text-white font-bold text-xl">${parseFloat(prev.hour_reading).toFixed(2)} hrs</div><div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)}</div>`;
    case 'well-static':
      return `<div class="text-white font-bold text-xl">${parseFloat(prev.dtw_reading ?? 0).toFixed(2)} ft depth</div><div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)} · ${prev.well_on_off ? 'Well ON' : 'Well OFF'} · ${prev.operator || ''}</div>`;
    case 'well-operational':
      return `<div class="text-white font-bold text-xl">${parseFloat(prev.totalizer_reading_af).toFixed(3)} AF | ${parseFloat(prev.hour_reading).toFixed(2)} hrs</div>
              <div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)} · ${prev.instantaneous_flow_cfs} CFS · Oil: ${prev.oil_level}</div>`;
    case 'canal':
      return `<div class="text-white font-bold text-xl">${prev.totalizer_reading_af ? parseFloat(prev.totalizer_reading_af).toFixed(3) + ' AF' : 'N/A'} ${prev.instantaneous_flow_cfs ? '· ' + prev.instantaneous_flow_cfs + ' CFS' : ''}</div><div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)}</div>`;
    case 'pond':
      return `<div class="text-white font-bold text-xl">In: ${prev.flow_in_cfs ?? '—'} CFS | Out: ${prev.flow_out_cfs ?? '—'} CFS</div>
              <div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)} · Gauge: ${prev.staff_gauge_ft ?? '—'} ft</div>`;
    case 'vehicle':
      const parts = [];
      if (prev.odometer_miles) parts.push(`${parseInt(prev.odometer_miles).toLocaleString()} mi`);
      if (prev.engine_hours) parts.push(`${parseFloat(prev.engine_hours).toFixed(1)} hrs`);
      return `<div class="text-white font-bold text-xl">${parts.join(' | ')}</div><div class="text-sky-400 text-sm">${fmtDate(prev.reading_date)}</div>`;
    default: return JSON.stringify(prev);
  }
}

function formInputsHTML(type) {
  const label = (txt, name, required = false) =>
    `<label class="block text-sky-300 text-sm font-semibold mb-1" for="${name}">${txt}${required ? ' <span class="text-red-400">*</span>' : ''}</label>`;
  const numInput = (name, placeholder, required = true, step = 'any') =>
    `<input type="number" id="${name}" name="${name}" step="${step}" placeholder="${placeholder}"
      class="w-full bg-sky-950 border border-sky-600 text-white text-2xl rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-sky-400 placeholder-sky-700" ${required ? 'required' : ''}>`;
  const textInput = (name, placeholder, required = false) =>
    `<input type="text" id="${name}" name="${name}" placeholder="${placeholder}"
      class="w-full bg-sky-950 border border-sky-600 text-white rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-sky-400 placeholder-sky-700" ${required ? 'required' : ''}>`;
  const dateInput = (name) =>
    `<input type="date" id="${name}" name="${name}" class="w-full bg-sky-950 border border-sky-600 text-white text-xl rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-sky-400" required>`;
  const selectInput = (name, options, required = true) =>
    `<select id="${name}" name="${name}" class="w-full bg-sky-950 border border-sky-600 text-white text-xl rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-sky-400" ${required ? 'required' : ''}>
      <option value="">— Select —</option>${options.map(o => `<option value="${o.v}">${o.l}</option>`).join('')}
    </select>`;
  const notesInput = () =>
    `<label class="block text-sky-300 text-sm font-semibold mb-1" for="notes">Notes</label>
     <textarea id="notes" name="notes" rows="2" placeholder="Anomalies or observations…"
       class="w-full bg-sky-950 border border-sky-600 text-white rounded-xl px-4 py-2 mb-4 focus:outline-none focus:border-sky-400 placeholder-sky-700 resize-none"></textarea>`;

  const dateRow = `${label('Reading Date', 'reading_date', true)}${dateInput('reading_date')}
    ${label('Reading Time', 'reading_time', true)}<input type="time" id="reading_time" name="reading_time" class="w-full bg-sky-950 border border-sky-600 text-white text-xl rounded-xl px-4 py-3 mb-4 focus:outline-none focus:border-sky-400">`;

  switch (type) {
    case 'pge':
    case 'power-monitor':
      return `${dateRow}${label('kWh Reading', 'kwh_reading', true)}${numInput('kwh_reading', '0.0')}${notesInput()}`;

    case 'pump-hours':
    case 'compressor-hours':
      return `${dateRow}${label('Hour Meter Reading', 'hour_reading', true)}${numInput('hour_reading', '0.00', true, '0.01')}${notesInput()}`;

    case 'well-static': {
      return `${dateRow}
        ${label('Well Status', 'well_on_off', true)}
        ${selectInput('well_on_off', [{ v: 'false', l: 'Off (static level)' }, { v: 'true', l: 'On (pumping — not true static)' }])}
        ${label('Depth to Water (ft)', 'dtw_reading', true)}${numInput('dtw_reading', '0.00', true, '0.01')}
        ${label('Measurement Device', 'plopper_sounder', false)}
        ${selectInput('plopper_sounder', [{ v: 'Plopper', l: 'Plopper' }, { v: 'Sounder', l: 'Sounder' }, { v: 'Other', l: 'Other' }], false)}
        <p class="text-sky-400 text-sm mb-4">Operator: <span class="text-white font-semibold">${state.user}</span></p>
        ${notesInput()}`;
    }

    case 'well-operational': {
      return `${dateRow}
        ${label('Pump Status', 'on_off', true)}
        ${selectInput('on_off', [{ v: 'true', l: 'On (Running)' }, { v: 'false', l: 'Off' }])}
        ${label('Hour Meter Reading', 'hour_reading', false)}${numInput('hour_reading', '0.00', false, '0.01')}
        ${label('Instantaneous Flow (CFS)', 'instantaneous_flow_cfs', false)}${numInput('instantaneous_flow_cfs', '0.00', false, '0.001')}
        ${label('Totalizer Reading (AF)', 'totalizer_reading_af', false)}${numInput('totalizer_reading_af', '0.000', false, '0.001')}
        ${label('Motor Oil', 'motor_oil', true)}
        ${selectInput('motor_oil', [{ v: 'true', l: 'Full' }, { v: 'false', l: 'Low / Needs Oil' }])}
        ${label('Dripper Oil Level (gal)', 'dripper_oil', false)}${numInput('dripper_oil', 'optional', false, '0.1')}
        ${label('PG&E kWh', 'pge_kwh', false)}${numInput('pge_kwh', '0.0', false, '0.1')}
        ${notesInput()}`;
    }

    case 'canal': {
      const isMetered = state.selectedAsset.has_flow_meter;
      if (isMetered) {
        return `${dateRow}
          ${label('Reading Time', 'reading_time', false)}<input type="time" id="reading_time" name="reading_time" class="w-full bg-sky-950 border border-sky-600 text-white text-xl rounded-xl px-4 py-3 mb-4">
          ${label('Instantaneous Flow (CFS)', 'instantaneous_flow_cfs', true)}${numInput('instantaneous_flow_cfs', '0.00', true, '0.001')}
          ${label('Totalizer Reading (AF)', 'totalizer_reading_af', true)}${numInput('totalizer_reading_af', '0.000', true, '0.001')}
          ${label('Gate Setting', 'gate_setting', false)}${textInput('gate_setting', 'e.g. 3.5 turns')}
          ${notesInput()}`;
      } else {
        return `${dateRow}
          ${label('Reading Time', 'reading_time', false)}<input type="time" id="reading_time" name="reading_time" class="w-full bg-sky-950 border border-sky-600 text-white text-xl rounded-xl px-4 py-3 mb-4">
          ${label('Gate Setting', 'gate_setting', false)}${textInput('gate_setting', 'e.g. open 2ft')}
          ${label('Head Reading (ft)', 'head_reading_ft', true)}${numInput('head_reading_ft', '0.00', true, '0.001')}
          ${label('Derived Flow (CFS) — from chart/formula', 'derived_flow_cfs', true)}${numInput('derived_flow_cfs', '0.00', true, '0.001')}
          ${notesInput()}`;
      }
    }

    case 'pond':
      return `${dateRow}
        ${label('Staff Gauge (ft)', 'staff_gauge_ft', false)}${numInput('staff_gauge_ft', '0.00', false, '0.01')}
        ${label('Flow In (CFS)', 'flow_in_cfs', false)}${numInput('flow_in_cfs', '0.00', false, '0.001')}
        ${label('Flow Out (CFS)', 'flow_out_cfs', false)}${numInput('flow_out_cfs', '0.00', false, '0.001')}
        ${notesInput()}`;

    case 'vehicle': {
      const v = state.selectedAsset;
      const showOdo = v.reading_type === 'odometer' || v.reading_type === 'both';
      const showHrs = v.reading_type === 'hours' || v.reading_type === 'both';
      return `${dateRow}
        ${showOdo ? `${label('Odometer (miles)', 'odometer_miles', true)}${numInput('odometer_miles', '0', true, '1')}` : ''}
        ${showHrs ? `${label('Engine Hours', 'engine_hours', true)}${numInput('engine_hours', '0.0', true, '0.1')}` : ''}
        ${notesInput()}`;
    }

    default: return '<p class="text-red-400">Unknown form type</p>';
  }
}

function getFormData() {
  const inputs = $('form-inputs').querySelectorAll('input, select, textarea');
  const data = { entered_by: state.user };
  inputs.forEach(inp => { if (inp.name) data[inp.name] = inp.value || null; });
  // KF readings: operator auto-filled from logged-in user
  if (state.readingType === 'well-static') data.operator = state.user;
  // Add asset ID field
  const type = state.readingType;
  const asset = state.selectedAsset;
  const idMap = {
    pge: ['pge_meter_id', 'pge_meter_id'],
    'power-monitor': ['monitor_id', 'monitor_id'],
    'pump-hours': ['position_id', 'position_id'],
    'compressor-hours': ['compressor_id', 'compressor_id'],
    'well-static': ['well_id', 'well_id'],
    'well-operational': ['well_id', 'well_id'],
    canal: ['structure_id', 'structure_id'],
    pond: ['pond_id', 'pond_id'],
    vehicle: ['vehicle_id', 'vehicle_id'],
  };
  const [field, prop] = idMap[type] || [];
  if (field) data[field] = asset[prop] || asset._assetId;
  return data;
}

function updateFormula() {
  const type = state.readingType;
  const calcFn = FORMULAS[type];
  if (!calcFn) return;
  const data = getFormData();
  const prev = prevReading();
  const result = calcFn(data, prev);
  const calcEl = $('form-calc');

  if (!result) { calcEl.innerHTML = ''; return; }

  const color = result.warn ? 'border-amber-500 bg-amber-950' : 'border-green-500 bg-green-950';
  const icon = result.warn ? '⚠️' : '✅';
  calcEl.innerHTML = `
    <div class="border ${color} rounded-xl p-3 mb-4 flex items-center gap-3">
      <span class="text-2xl">${icon}</span>
      <div>
        <div class="text-xs text-sky-400 font-bold uppercase tracking-wide">${result.label}</div>
        <div class="text-white font-bold text-2xl">${result.value} <span class="text-base font-normal text-sky-300">${result.unit}</span></div>
      </div>
    </div>`;
}

function renderHistory() {
  const readings = state.lastReadings;
  const histEl = $('form-history');
  if (!histEl) return;

  if (readings.length === 0) {
    histEl.innerHTML = '<p class="text-sky-600 text-sm text-center py-2">No previous readings</p>';
    return;
  }

  const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const type = state.readingType;

  const headers = {
    pge: ['Date', 'kWh', 'Usage'],
    'power-monitor': ['Date', 'kWh', 'Usage'],
    'pump-hours': ['Date', 'Hours', 'Run Hrs'],
    'compressor-hours': ['Date', 'Hours', 'Run Hrs'],
    'well-static': ['Date', 'Depth (ft)', 'Status'],
    'well-operational': ['Date', 'AF Total', 'Flow CFS'],
    canal: ['Date', 'AF Total', 'CFS'],
    pond: ['Date', 'In CFS', 'Out CFS'],
    vehicle: ['Date', 'Odo/Hrs', 'Δ'],
  };

  const rowFn = {
    pge: (r, p) => [fmtDate(r.reading_date), parseFloat(r.kwh_reading).toLocaleString(), p ? (r.kwh_reading - p.kwh_reading).toFixed(1) : '—'],
    'power-monitor': (r, p) => [fmtDate(r.reading_date), parseFloat(r.kwh_reading).toLocaleString(), p ? (r.kwh_reading - p.kwh_reading).toFixed(1) : '—'],
    'pump-hours': (r, p) => [fmtDate(r.reading_date), parseFloat(r.hour_reading).toFixed(2), p ? (r.hour_reading - p.hour_reading).toFixed(2) : '—'],
    'compressor-hours': (r, p) => [fmtDate(r.reading_date), parseFloat(r.hour_reading).toFixed(2), p ? (r.hour_reading - p.hour_reading).toFixed(2) : '—'],
    'well-static': (r) => [fmtDate(r.reading_date), parseFloat(r.dtw_reading ?? 0).toFixed(2), r.well_on_off ? 'ON' : 'OFF'],
    'well-operational': (r) => [fmtDate(r.reading_date), parseFloat(r.totalizer_reading_af).toFixed(3), r.instantaneous_flow_cfs],
    canal: (r) => [fmtDate(r.reading_date), r.totalizer_reading_af != null ? parseFloat(r.totalizer_reading_af).toFixed(3) : '—', r.instantaneous_flow_cfs ?? r.derived_flow_cfs ?? '—'],
    pond: (r) => [fmtDate(r.reading_date), r.flow_in_cfs ?? '—', r.flow_out_cfs ?? '—'],
    vehicle: (r, p) => {
      const cur = r.odometer_miles || r.engine_hours;
      const prev = p ? (p.odometer_miles || p.engine_hours) : null;
      return [fmtDate(r.reading_date), cur ? parseFloat(cur).toLocaleString() : '—', prev && cur ? (cur - prev).toFixed(1) : '—'];
    },
  };

  const hdrs = headers[type] || ['Date', 'Value', 'Δ'];
  const fn = rowFn[type] || (() => ['', '', '']);

  let html = `<div class="mt-4">
    <div class="text-xs font-bold text-sky-400 uppercase tracking-wide mb-2">Last ${readings.length} Readings</div>
    <table class="w-full text-sm">
      <thead><tr class="text-sky-400 border-b border-sky-800">
        ${hdrs.map(h => `<th class="text-left pb-1 font-semibold">${h}</th>`).join('')}
      </tr></thead>
      <tbody>`;

  for (let i = 0; i < readings.length; i++) {
    const row = fn(readings[i], readings[i + 1]);
    html += `<tr class="border-b border-sky-900 ${i === 0 ? 'text-white' : 'text-sky-400'}">
      ${row.map(c => `<td class="py-1.5 pr-2">${c}</td>`).join('')}
    </tr>`;
  }

  html += '</tbody></table></div>';
  histEl.innerHTML = html;
}

// ─── Form submission ───────────────────────────────────────────────────────────
$('form-submit-btn') && $('form-submit-btn').addEventListener('click', async () => {
  const type = state.readingType;
  const data = getFormData();

  // Basic validation
  if (!data.reading_date) { alert('Please enter a reading date.'); return; }

  const btn = $('form-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const result = await submitReading(type, data, queueReading);

  // Prepend to local cache for immediate feedback
  await prependToCache(type, state.selectedAsset._assetId, { ...data, reading_date: data.reading_date });

  // Mark well as read so checkmarks show on the list
  if (type === 'well-operational' && state.selectedAsset?.well_id) {
    state.wellsReadToday.add(state.selectedAsset.well_id);
  }
  if (type === 'well-static' && state.selectedAsset?.well_id) {
    state.kfWellsReadRecent.add(state.selectedAsset.well_id);
  }

  btn.disabled = false;
  btn.textContent = 'Save Reading';

  showConfirm(data, result.queued);
  updatePendingBadge();
});

// ─── Confirmation screen ───────────────────────────────────────────────────────
function showConfirm(data, queued) {
  const type = state.readingType;
  const meta = READING_TYPES[type];

  $('confirm-icon').textContent = meta.icon;
  $('confirm-title').textContent = queued ? 'Saved Locally' : 'Saved!';
  $('confirm-subtitle').textContent = queued
    ? 'Reading queued — will sync when back on network'
    : 'Reading saved to database';
  $('confirm-asset').textContent = assetLabel();
  $('confirm-status').className = queued
    ? 'text-sm text-amber-400 font-semibold'
    : 'text-sm text-green-400 font-semibold';
  $('confirm-status').textContent = queued ? '⏳ Pending sync' : '✅ Synced';

  showScreen('screen-confirm');
}

$('confirm-another-btn') && $('confirm-another-btn').addEventListener('click', () => {
  if (state.readingType === 'well-operational' && state._wellAreaReturn) {
    showScreen('screen-asset');
    state._wellAreaReturn();
  } else if (state.readingType === 'well-static' && state._kfSetReturn) {
    showScreen('screen-asset');
    state._kfSetReturn();
  } else {
    startReadingFlow(state.readingType);
  }
});

$('confirm-menu-btn') && $('confirm-menu-btn').addEventListener('click', () => {
  showScreen('screen-menu');
});

$('confirm-same-btn') && $('confirm-same-btn').addEventListener('click', async () => {
  // Re-enter same asset — reload last readings and show form again
  await loadFormForAsset();
});

// ─── Back buttons ─────────────────────────────────────────────────────────────
$('asset-back-btn') && $('asset-back-btn').addEventListener('click', () => showScreen('screen-menu'));
$('form-back-btn') && $('form-back-btn').addEventListener('click', () => showScreen('screen-asset'));

// ─── Daily Pumping Plant screen ───────────────────────────────────────────────

let noteTarget = null; // reference to the notes <input> whose popup is open

$('daily-menu-btn')     && $('daily-menu-btn').addEventListener('click', () => showScreen('screen-menu'));
$('notes-popup-cancel') && $('notes-popup-cancel').addEventListener('click', closeNotesPopup);
$('notes-popup-ok')     && $('notes-popup-ok').addEventListener('click', () => {
  if (noteTarget) noteTarget.value = $('notes-popup-input').value;
  closeNotesPopup();
});

function openNotesPopup(inputEl, label) {
  noteTarget = inputEl;
  $('notes-popup-label').textContent = label;
  $('notes-popup-input').value = inputEl.value;
  $('notes-popup').classList.remove('hidden');
  setTimeout(() => $('notes-popup-input').focus(), 80);
}

function closeNotesPopup() {
  $('notes-popup').classList.add('hidden');
  noteTarget = null;
}

function openDailyScreen() {
  // Populate site dropdown with pumping plant sites only
  const sites = (state.assets.sites || []).filter(s => s.site_type === 'pumping_plant');
  const sel = $('daily-site-select');
  sel.innerHTML = sites.map(s =>
    `<option value="${s.site_id}">${s.site_id} — ${s.site_name}</option>`
  ).join('');

  // Default to last-used or first site
  if (!state.dailySiteId && sites.length > 0) state.dailySiteId = sites[0].site_id;
  if (state.dailySiteId) sel.value = String(state.dailySiteId);

  // Auto-fill today's date and current time
  const now = new Date();
  $('daily-date').value = now.toISOString().slice(0, 10);
  $('daily-time').value = now.toTimeString().slice(0, 5);

  showScreen('screen-daily');
  loadDailyReadings(parseInt(sel.value));
}

$('daily-site-select') && $('daily-site-select').addEventListener('change', e => {
  state.dailySiteId = parseInt(e.target.value);
  loadDailyReadings(state.dailySiteId);
});

async function loadDailyReadings(siteId) {
  $('daily-content').innerHTML = '<p class="text-sky-500 text-center py-8">Loading…</p>';
  let data = { pumpHours: {}, compHours: {}, pge: {}, powerMonitors: {} };
  try {
    const resp = await fetch(api(`/api/readings/daily/${siteId}`));
    if (resp.ok) data = await resp.json();
  } catch { /* offline — show empty Previous values */ }
  state.dailyReadings = data;
  renderDailyContent(siteId);
}

function renderDailyContent(siteId) {
  const container = $('daily-content');
  container.innerHTML = '';

  const buildings = (state.assets.buildings || [])
    .filter(b => b.site_id === siteId)
    .sort((a, b) => a.building_letter.localeCompare(b.building_letter));

  if (buildings.length === 0) {
    container.innerHTML = '<p class="text-sky-400 text-center py-8">No buildings found for this site.</p>';
    return;
  }
  for (const bldg of buildings) container.appendChild(renderDailyBuilding(bldg));
}

function renderDailyBuilding(bldg) {
  const { building_id, building_letter } = bldg;
  const data = state.dailyReadings || {};

  const pumps       = (state.assets.pumpPositions || [])
    .filter(p => p.building_id === building_id)
    .sort((a, b) => (a.pump_letter || '').localeCompare(b.pump_letter || ''));
  const compressors = (state.assets.compressors   || []).filter(c => c.building_id === building_id);
  const pgeMeters   = (state.assets.pgeMeters     || []).filter(m => m.building_id === building_id);
  const powerMons   = (state.assets.powerMonitors || []).filter(m => m.building_id === building_id);

  const section = document.createElement('div');
  section.className = 'bg-sky-900 rounded-2xl mb-5 overflow-hidden';
  section.dataset.buildingId = building_id;

  // ── Section header + Save button ─────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = 'flex items-center justify-between px-4 py-3 bg-sky-800 rounded-t-2xl';
  hdr.innerHTML = `
    <h2 class="text-white text-xl font-bold">${building_letter} Plant</h2>
    <button class="save-bldg-btn bg-red-500 hover:bg-red-400 active:bg-red-600 text-white font-bold px-5 py-2 rounded-xl text-base touch-manipulation transition-colors">
      Save
    </button>`;
  section.appendChild(hdr);

  // ── Column header row ─────────────────────────────────────────────────────
  const colHdr = document.createElement('div');
  colHdr.className = 'daily-row-grid px-3 pt-2 pb-1 border-b border-sky-700';
  colHdr.innerHTML = `
    <span></span>
    <span class="text-sky-400 text-xs font-bold uppercase tracking-wide">Current</span>
    <span class="text-sky-400 text-xs font-bold uppercase tracking-wide">Difference</span>
    <span class="text-sky-400 text-xs font-bold uppercase tracking-wide">Previous</span>
    <span class="text-sky-400 text-xs font-bold uppercase tracking-wide">Notes</span>
    <span></span>`;
  section.appendChild(colHdr);

  // ── Reading rows ──────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'px-3 py-2';

  for (const pump of pumps) {
    body.appendChild(buildDailyRow({
      type: 'pump-hours', idField: 'position_id', id: pump.position_id,
      label: `${pump.pump_letter || pump.position_id} Pump Hours`,
      valueField: 'hour_reading', unit: 'hrs',
      prev: (data.pumpHours || {})[pump.position_id],
    }));
  }
  for (let i = 0; i < compressors.length; i++) {
    const comp = compressors[i];
    body.appendChild(buildDailyRow({
      type: 'compressor-hours', idField: 'compressor_id', id: comp.compressor_id,
      label: compressors.length > 1 ? `Compressor ${comp.serial_number || i + 1} Hours` : 'Air Compressor Hours',
      valueField: 'hour_reading', unit: 'hrs',
      prev: (data.compHours || {})[comp.compressor_id],
    }));
  }
  for (let i = 0; i < pgeMeters.length; i++) {
    const meter = pgeMeters[i];
    body.appendChild(buildDailyRow({
      type: 'pge', idField: 'pge_meter_id', id: meter.pge_meter_id,
      label: pgeMeters.length > 1 ? `PG&E kWh (${meter.meter_number})` : 'PG&E kWh',
      valueField: 'kwh_reading', unit: 'kWh',
      prev: (data.pge || {})[meter.pge_meter_id],
    }));
  }
  for (let i = 0; i < powerMons.length; i++) {
    const mon = powerMons[i];
    body.appendChild(buildDailyRow({
      type: 'power-monitor', idField: 'monitor_id', id: mon.monitor_id,
      label: powerMons.length > 1 ? `Power Monitor kWh (${mon.monitor_number})` : 'Power Monitor kWh',
      valueField: 'kwh_reading', unit: 'kWh',
      prev: (data.powerMonitors || {})[mon.monitor_id],
    }));
  }

  section.appendChild(body);

  // ── Wire Save button ──────────────────────────────────────────────────────
  hdr.querySelector('.save-bldg-btn').addEventListener('click', function () {
    saveDailyBuilding(section, this);
  });

  return section;
}

function buildDailyRow({ type, idField, id, label, valueField, unit, prev }) {
  const row = document.createElement('div');
  row.className = 'daily-row-grid items-center py-2 border-b border-sky-800 last:border-b-0';
  row.dataset.type      = type;
  row.dataset.id        = String(id);
  row.dataset.idField   = idField;
  row.dataset.valueField = valueField;

  const prevNum  = (prev != null && prev[valueField] != null) ? parseFloat(prev[valueField]) : null;
  const prevDisp = (prevNum !== null && !isNaN(prevNum))
    ? prevNum.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const prevNote = (prev && prev.notes) ? prev.notes.replace(/"/g, '&quot;') : '';

  row.innerHTML = `
    <span class="text-white text-sm font-semibold leading-snug pr-1">${label}</span>
    <input type="number" step="any" placeholder="—"
      class="current-val bg-sky-950 border border-sky-600 text-white rounded-lg px-2 py-2 text-sm w-full focus:outline-none focus:border-sky-400 placeholder-sky-700">
    <div class="flex items-baseline gap-1 min-w-0">
      <span class="diff-val text-sm font-bold text-sky-500">—</span>
    </div>
    <div class="flex items-baseline gap-1 min-w-0">
      <span class="text-sm font-semibold text-sky-300">${prevDisp}</span>
      ${prevNum !== null ? `<span class="text-xs text-sky-600">${unit}</span>` : ''}
    </div>
    <input type="text" placeholder="—" value="${prevNote}"
      class="notes-val bg-sky-950 border border-sky-700 text-white rounded-lg px-2 py-2 text-xs w-full focus:outline-none focus:border-sky-400 placeholder-sky-700">
    <button class="add-note-btn bg-sky-700 hover:bg-sky-600 active:bg-sky-500 text-white font-bold rounded-full w-8 h-8 flex items-center justify-center text-xl leading-none touch-manipulation flex-shrink-0" title="Edit note">+</button>`;

  // Live difference calculation
  const currentInput = row.querySelector('.current-val');
  const diffSpan     = row.querySelector('.diff-val');
  currentInput.addEventListener('input', () => {
    const cur = parseFloat(currentInput.value);
    if (!isNaN(cur) && prevNum !== null) {
      const diff = cur - prevNum;
      diffSpan.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      diffSpan.className   = `diff-val text-sm font-bold ${diff < 0 ? 'text-amber-400' : 'text-green-400'}`;
    } else {
      diffSpan.textContent = '—';
      diffSpan.className   = 'diff-val text-sm font-bold text-sky-500';
    }
  });

  // Notes popup button
  const notesInput = row.querySelector('.notes-val');
  row.querySelector('.add-note-btn').addEventListener('click', () => openNotesPopup(notesInput, label));

  return row;
}

async function saveDailyBuilding(sectionEl, saveBtn) {
  const date = $('daily-date').value;
  if (!date) { alert('Please select a date first.'); return; }

  // Collect rows that have a Current value
  const toSave = [];
  for (const row of sectionEl.querySelectorAll('.daily-row-grid[data-type]')) {
    const currentInput = row.querySelector('.current-val');
    if (!currentInput || currentInput.value.trim() === '') continue;
    toSave.push({
      type:       row.dataset.type,
      idField:    row.dataset.idField,
      id:         row.dataset.id,
      valueField: row.dataset.valueField,
      value:      parseFloat(currentInput.value),
      notes:      row.querySelector('.notes-val')?.value || null,
      inputEl:    currentInput,
    });
  }
  if (toSave.length === 0) return;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  for (const item of toSave) {
    const data = {
      [item.idField]:    item.id,
      [item.valueField]: item.value,
      reading_date:      date,
      reading_time:      $('daily-time').value || null,
      entered_by:        state.user,
      notes:             item.notes || null,
    };
    const result = await submitReading(item.type, data, queueReading);
    // Visual feedback: green = saved to server, amber = queued offline
    item.inputEl.classList.remove('border-sky-600');
    item.inputEl.classList.add(result.queued ? 'border-amber-500' : 'border-green-500');
  }

  updatePendingBadge();
  saveBtn.disabled = false;
  saveBtn.textContent = '✅ Saved';
  saveBtn.classList.replace('bg-red-500', 'bg-green-600');
  saveBtn.classList.replace('hover:bg-red-400', 'hover:bg-green-500');
  saveBtn.classList.replace('active:bg-red-600', 'active:bg-green-700');

  setTimeout(() => {
    saveBtn.textContent = 'Save';
    saveBtn.classList.replace('bg-green-600', 'bg-red-500');
    saveBtn.classList.replace('hover:bg-green-500', 'hover:bg-red-400');
    saveBtn.classList.replace('active:bg-green-700', 'active:bg-red-600');
  }, 3000);
}

// ─── Settings screen ──────────────────────────────────────────────────────────

$('settings-btn') && $('settings-btn').addEventListener('click', openSettings);
$('settings-back-btn') && $('settings-back-btn').addEventListener('click', () => showScreen('screen-login'));

async function openSettings() {
  // Pre-fill server URL
  const urlInput = $('settings-server-url');
  urlInput.value = getBaseUrl();
  $('settings-url-status').textContent = '';

  // Fetch current DB settings from server (non-sensitive fields only)
  try {
    const resp = await fetch(api('/api/settings'));
    if (resp.ok) {
      const s = await resp.json();
      $('settings-db-host').value     = s.db_host || '';
      $('settings-db-port').value     = s.db_port || '';
      $('settings-db-name').value     = s.db_name || '';
      $('settings-db-user').value     = s.db_user || '';
      $('settings-db-password').value = '';          // never pre-fill password
      $('settings-db-password').placeholder = s.has_password ? '••••••••  (unchanged)' : 'Enter password';
    }
  } catch {
    // Server unreachable — leave fields blank, user can still change server URL
    $('settings-db-status').textContent = 'Could not reach server for DB settings';
    $('settings-db-status').className = 'text-red-400 text-sm mt-1';
  }

  showScreen('screen-settings');
}

// Test server URL connection
$('settings-test-url-btn') && $('settings-test-url-btn').addEventListener('click', async () => {
  const url = $('settings-server-url').value.trim().replace(/\/$/, '');
  const statusEl = $('settings-url-status');
  statusEl.textContent = 'Testing…';
  statusEl.className = 'text-sky-400 text-sm mt-1';
  try {
    const t0 = Date.now();
    const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const ms = Date.now() - t0;
    if (resp.ok) {
      statusEl.textContent = `✅ Connected (${ms}ms)`;
      statusEl.className = 'text-green-400 text-sm mt-1';
    } else {
      statusEl.textContent = `⚠️ Server responded with ${resp.status}`;
      statusEl.className = 'text-amber-400 text-sm mt-1';
    }
  } catch (e) {
    statusEl.textContent = `❌ Cannot reach server: ${e.message}`;
    statusEl.className = 'text-red-400 text-sm mt-1';
  }
});

// Auto-detect button — reset to current page origin
$('settings-autodetect-btn') && $('settings-autodetect-btn').addEventListener('click', () => {
  $('settings-server-url').value = window.location.origin;
  $('settings-url-status').textContent = '';
});

// Save all settings
$('settings-save-btn') && $('settings-save-btn').addEventListener('click', async () => {
  const btn = $('settings-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  // 1 — Save server URL to localStorage
  const newUrl = $('settings-server-url').value.trim().replace(/\/$/, '');
  if (newUrl) setBaseUrl(newUrl); else clearBaseUrl();

  // 2 — Send DB settings to server
  const dbPayload = {
    db_host:     $('settings-db-host').value.trim(),
    db_port:     $('settings-db-port').value.trim(),
    db_name:     $('settings-db-name').value.trim(),
    db_user:     $('settings-db-user').value.trim(),
    db_password: $('settings-db-password').value, // only sent if non-empty
  };
  // Strip empty password so server doesn't overwrite with blank
  if (!dbPayload.db_password) delete dbPayload.db_password;

  const dbStatusEl = $('settings-db-status');
  try {
    const resp = await fetch(api('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dbPayload),
    });
    const result = await resp.json();
    if (result.ok) {
      dbStatusEl.textContent = '✅ Database settings saved';
      dbStatusEl.className = 'text-green-400 text-sm mt-1';
    } else {
      dbStatusEl.textContent = `⚠️ ${result.error}`;
      dbStatusEl.className = 'text-amber-400 text-sm mt-1';
    }
  } catch (e) {
    dbStatusEl.textContent = `❌ Could not save DB settings: ${e.message}`;
    dbStatusEl.className = 'text-red-400 text-sm mt-1';
  }

  btn.disabled = false;
  btn.textContent = 'Save Settings';

  // Reload the user list with the new server URL
  setTimeout(() => {
    showScreen('screen-login');
    initLogin();
    setStatus('Settings saved — reconnecting…', 'info');
  }, 800);
});

// ─── Boot ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW reg failed:', e));
}

setSyncStatusCallback(setStatus);
startAutoSync();
initLogin();

// Show initial status
(async () => {
  const count = await getPendingCount();
  if (count > 0) setStatus(`${count} reading(s) pending sync`, 'warning');
  else if (navigator.onLine) setStatus('Connected', 'success');
  else setStatus('Offline', 'warning');
})();
