/* ── SCADA Dashboard ─────────────────────────────────────────────────────────
 * Live view of CVC pumping-plant PLC data. Reads from /api/scada/* (InfluxDB on
 * the server). Admin-gated. Two views: Overview (one card per plant) and Site
 * Detail (sensor tiles + pump cards + a trend chart). Live values pushed over SSE.
 *
 * Depends on app.js globals: el(), api(), showToast(), setPanelNav(), escHtml(),
 * showScreen().
 * ──────────────────────────────────────────────────────────────────────────── */

let _scadaConfig  = null;   // { sites, sensorMeta, defaultSensors, pollMs }
let _scadaCurrent = {};     // { tagPath: { v, t } }
let _scadaView    = 'overview';   // 'overview' | 'trends' | siteId
let _scadaES      = null;   // EventSource
let _scadaChart   = null;   // Chart.js instance
let _scadaChartKey = null;  // identifies the series currently charted (race guard)
let _scadaChartRange = '1h';
let _scadaLastUpdate = 0;   // epoch ms of last good data
let _scadaStatusTimer = null;

// Trends view: persisted multi-select of tag paths (can span sites, like the
// standalone dashboard), the site whose chips are shown, and the range.
let _scadaTrendTags  = new Set(JSON.parse(localStorage.getItem('scadaTrendTags') || '[]'));
let _scadaTrendSite  = localStorage.getItem('scadaTrendSite') || '';
let _scadaTrendRange = localStorage.getItem('scadaTrendRange') || '24h';

// Chart.js + the date-fns time adapter are bundled locally (under /vendor) so the
// trend charts work offline as part of the PWA shell — no CDN dependency.
const SCADA_VENDOR = [
  '/vendor/chart.umd.js',
  '/vendor/chartjs-adapter-date-fns.bundle.min.js',
];
// Line colors, matching the standalone dashboard palette (first = primary blue).
const SCADA_SERIES_COLORS = ['#38b6ff', '#2ecc71', '#f1c40f', '#e67e22', '#9b59b6', '#e74c3c', '#1abc9c', '#fd79a8'];

/* ── Entry point (called by showScreen) ──────────────────────────────────── */
async function initScadaScreen() {
  _scadaView = 'overview';
  setPanelNav(el('screen-scada'), () => showScreen('dashboard'), 'SCADA Dashboard');
  if (!_scadaConfig) {
    el('scada-body').innerHTML = '<div class="placeholder-msg">Loading…</div>';
    try {
      _scadaConfig = await api('GET', '/api/scada/config');
    } catch (err) {
      el('scada-body').innerHTML =
        `<div class="placeholder-msg">SCADA source unavailable.<br><span style="font-size:.85rem">${escHtml(err.message || '')}</span></div>`;
      return;
    }
  }
  showScadaTab('overview');
  startScadaStream();
}

/* ── Top-level tabs: Overview | Trends ─────────────────────────────────────── */
function scadaTabsHtml(active) {
  return `<div class="scada-tabs">
    <button class="scada-tab ${active === 'overview' ? 'active' : ''}" data-scada-tab="overview">Overview</button>
    <button class="scada-tab ${active === 'trends' ? 'active' : ''}" data-scada-tab="trends">Trends</button>
  </div>`;
}

function wireScadaTabs() {
  el('scada-body').querySelectorAll('[data-scada-tab]').forEach(b =>
    b.addEventListener('click', () => showScadaTab(b.dataset.scadaTab)));
}

function showScadaTab(tab) {
  setPanelNav(el('screen-scada'), () => showScreen('dashboard'), 'SCADA Dashboard');
  if (tab === 'trends') renderScadaTrends();
  else renderScadaOverview();
}

/* ── Live stream (SSE) ────────────────────────────────────────────────────── */
function startScadaStream() {
  stopScadaStream();
  try {
    _scadaES = new EventSource('/api/scada/stream');
  } catch { return; }
  _scadaES.addEventListener('current', e => {
    try { applyScadaCurrent(JSON.parse(e.data)); } catch { /* ignore parse */ }
  });
  _scadaES.addEventListener('sourceError', () => setScadaStatus(false));
  _scadaES.onerror = () => setScadaStatus(false);

  // Tick the "last update" label every second while connected
  clearInterval(_scadaStatusTimer);
  _scadaStatusTimer = setInterval(refreshScadaStatusLabel, 1000);
}

function stopScadaStream() {
  if (_scadaES) { _scadaES.close(); _scadaES = null; }
  clearInterval(_scadaStatusTimer);
  _scadaStatusTimer = null;
  if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; _scadaChartKey = null; }
}

function applyScadaCurrent(data) {
  // Merge so a partial poll never blanks out tags it didn't return this tick
  Object.assign(_scadaCurrent, data);
  _scadaLastUpdate = Date.now();
  setScadaStatus(true);
  if (_scadaView === 'overview') renderScadaOverview();
  else if (_scadaView === 'trends') { /* historical chart — leave it alone */ }
  else patchScadaDetail();
}

function setScadaStatus(online) {
  const bar = el('scada-status-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', online);
  if (!online) refreshScadaStatusLabel();
}

function refreshScadaStatusLabel() {
  const bar = el('scada-status-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  const ago = _scadaLastUpdate ? Math.round((Date.now() - _scadaLastUpdate) / 1000) : null;
  bar.textContent = ago == null
    ? 'Offline — no data received yet'
    : `Offline — last update ${ago}s ago`;
}

/* ── Tag-path + value helpers ─────────────────────────────────────────────── */
function scadaSensorPath(site, sensor) { return `${site.influxSite}.${sensor}.SCL.PV`; }
function scadaPumpPath(site, letter, suffix) { return `${site.influxSite}.${letter}.${suffix}`; }
function scadaVal(path) { const o = _scadaCurrent[path]; return o ? o.v : null; }
function pumpLabel(site, letter) { return (site.pumpLabels && site.pumpLabels[letter]) || letter; }
function isOn(v) { return v != null && v >= 0.5; }

function fmtSensor(sensor, v) {
  if (v == null) return '—';
  const kind = _scadaConfig.sensorMeta?.[sensor]?.kind;
  if (kind === 'temp') return Math.round(v).toString();
  return Number(v).toFixed(2);
}

function scadaSiteByInflux(influx) { return _scadaConfig.sites.find(s => s.influxSite === influx); }

// Human label for a tag path, e.g. "CVC PP 4B · Forebay Level" or "CVC PP 1A · Pump C RPM".
function scadaTagLabel(path, withSite = true) {
  const parts = path.split('.');
  const site = scadaSiteByInflux(parts[0]);
  const siteName = site ? site.name : parts[0];
  let label = path;
  if (parts.length === 4 && parts[2] === 'SCL' && parts[3] === 'PV') {
    label = _scadaConfig.sensorMeta?.[parts[1]]?.label || parts[1];
  } else if (parts[2] === 'MTR' && parts[3] === 'Spd') {
    label = `Pump ${site ? pumpLabel(site, parts[1]) : parts[1]} RPM`;
  }
  return withSite ? `${siteName} · ${label}` : label;
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
function renderScadaOverview() {
  _scadaView = 'overview';
  const body = el('scada-body');
  const cards = _scadaConfig.sites.map(site => {
    const total = site.pumps.length;
    let running = 0, faulted = 0;
    site.pumps.forEach(p => {
      if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Run')))) running++;
      if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Fail')))) faulted++;
    });
    const dot = faulted ? 'alarm' : (running ? 'ok' : 'idle');
    const fb = fmtSensor('FBLvl', scadaVal(scadaSensorPath(site, 'FBLvl')));
    const ab = fmtSensor('ABLvl', scadaVal(scadaSensorPath(site, 'ABLvl')));
    return `
      <button class="scada-site-card" data-scada-site="${site.id}">
        <div class="scada-site-row">
          <span class="scada-dot scada-dot-${dot}"></span>
          <span class="scada-site-name">${escHtml(site.name)}</span>
          <span class="scada-pump-count">${running}/${total} running${faulted ? ` · ${faulted} fault` : ''}</span>
        </div>
        <div class="scada-site-sensors">
          <span>Forebay <strong>${fb}</strong> ft</span>
          <span>Afterbay <strong>${ab}</strong> ft</span>
        </div>
      </button>`;
  }).join('');
  body.innerHTML = scadaTabsHtml('overview') + `<div class="scada-overview-grid">${cards}</div>`;
  wireScadaTabs();
  body.querySelectorAll('[data-scada-site]').forEach(c =>
    c.addEventListener('click', () => openScadaSite(c.dataset.scadaSite)));
}

/* ── Site detail ──────────────────────────────────────────────────────────── */
function openScadaSite(siteId) {
  const site = _scadaConfig.sites.find(s => s.id === siteId);
  if (!site) return;
  _scadaView = siteId;
  setPanelNav(el('screen-scada'), () => showScadaTab('overview'), 'SCADA – ' + site.name);
  renderScadaDetail(site);
}

function renderScadaDetail(site) {
  const sensors = site.sensors || _scadaConfig.defaultSensors || [];
  const sensorTiles = sensors.map(s => {
    const meta = _scadaConfig.sensorMeta?.[s] || { label: s, unit: '' };
    const path = scadaSensorPath(site, s);
    return `
      <div class="scada-sensor-tile">
        <div class="scada-sensor-label">${escHtml(meta.label)}</div>
        <div class="scada-sensor-value" data-scada-sensor="${s}" data-scada-tag="${path}">
          ${fmtSensor(s, scadaVal(path))}</div>
        <div class="scada-sensor-unit">${escHtml(meta.unit || '')}</div>
      </div>`;
  }).join('');

  const pumpCards = site.pumps.map(p => {
    const runPath = scadaPumpPath(site, p, 'MTR.Cntrl.Run');
    const failPath = scadaPumpPath(site, p, 'MTR.Cntrl.Fail');
    const spdPath = scadaPumpPath(site, p, 'MTR.Spd.SCL.PV');
    const hpPath  = scadaPumpPath(site, p, 'HP');
    const sbPath  = scadaPumpPath(site, p, 'SBVlv.Cntrl.Enable');
    const run = isOn(scadaVal(runPath)), fail = isOn(scadaVal(failPath));
    const spd = scadaVal(spdPath), hp = scadaVal(hpPath), sb = scadaVal(sbPath);
    return `
      <div class="scada-pump-card" data-scada-pump="${p}">
        <div class="scada-pump-head">
          <span class="scada-pump-label">Pump ${escHtml(pumpLabel(site, p))}</span>
          <span class="scada-fault-badge ${fail ? '' : 'hidden'}" data-scada-fail="${failPath}">FAULT</span>
        </div>
        <span class="scada-run-pill ${run ? 'running' : 'stopped'}" data-scada-run="${runPath}">
          ${run ? 'RUNNING' : 'STOPPED'}</span>
        <div class="scada-pump-meta">
          <span>RPM <strong data-scada-tag="${spdPath}" data-scada-int="1">${spd == null ? '—' : Math.round(spd)}</strong></span>
          <span>HP <strong>${hp == null ? '—' : Math.round(hp)}</strong></span>
          <span>SB Valve <strong data-scada-sb="${sbPath}">${sb == null ? '—' : (isOn(sb) ? 'ON' : 'OFF')}</strong></span>
        </div>
      </div>`;
  }).join('');

  // Trend selector: every sensor + every pump speed
  const trendOpts = [
    ...sensors.map(s => `<option value="${scadaSensorPath(site, s)}">${escHtml(_scadaConfig.sensorMeta?.[s]?.label || s)}</option>`),
    ...site.pumps.map(p => `<option value="${scadaPumpPath(site, p, 'MTR.Spd.SCL.PV')}">Pump ${escHtml(pumpLabel(site, p))} RPM</option>`),
  ].join('');

  el('scada-body').innerHTML = `
    <div class="scada-detail">
      <div class="scada-section-hdr">Sensors</div>
      <div class="scada-sensor-grid">${sensorTiles}</div>
      <div class="scada-section-hdr">Pumps</div>
      <div class="scada-pump-grid">${pumpCards}</div>
      <div class="scada-section-hdr">Trend</div>
      <div class="scada-chart-controls">
        <select id="scada-trend-sel" class="ctrl-select ctrl-input-sm">${trendOpts}</select>
        <div class="seg-group" id="scada-range-seg">
          <button class="seg-btn active" data-range="1h">1h</button>
          <button class="seg-btn" data-range="6h">6h</button>
          <button class="seg-btn" data-range="24h">24h</button>
          <button class="seg-btn" data-range="7d">7d</button>
        </div>
      </div>
      <div class="scada-chart-wrap"><canvas id="scada-chart-canvas" class="scada-chart-canvas"></canvas></div>
    </div>`;

  // Wire trend controls
  _scadaChartRange = '1h';
  const sel = el('scada-trend-sel');
  sel.addEventListener('change', () => renderScadaChart(sel.value, _scadaChartRange));
  el('scada-range-seg').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-range-seg').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaChartRange = b.dataset.range;
      renderScadaChart(sel.value, _scadaChartRange);
    }));
  renderScadaChart(sel.value, _scadaChartRange);
}

// Patch live values into the already-rendered detail view (chart untouched)
function patchScadaDetail() {
  const body = el('scada-body');
  body.querySelectorAll('[data-scada-sensor]').forEach(elm => {
    elm.textContent = fmtSensor(elm.dataset.scadaSensor, scadaVal(elm.dataset.scadaTag));
  });
  body.querySelectorAll('[data-scada-int]').forEach(elm => {
    const v = scadaVal(elm.dataset.scadaTag);
    elm.textContent = v == null ? '—' : Math.round(v);
  });
  body.querySelectorAll('[data-scada-run]').forEach(elm => {
    const run = isOn(scadaVal(elm.dataset.scadaRun));
    elm.classList.toggle('running', run);
    elm.classList.toggle('stopped', !run);
    elm.textContent = run ? 'RUNNING' : 'STOPPED';
  });
  body.querySelectorAll('[data-scada-fail]').forEach(elm => {
    elm.classList.toggle('hidden', !isOn(scadaVal(elm.dataset.scadaFail)));
  });
  body.querySelectorAll('[data-scada-sb]').forEach(elm => {
    const v = scadaVal(elm.dataset.scadaSb);
    elm.textContent = v == null ? '—' : (isOn(v) ? 'ON' : 'OFF');
  });
}

/* ── Trend chart (Chart.js, lazy-loaded from /vendor) ──────────────────────── */
// Load the bundled scripts once, in order (adapter depends on Chart being global).
let _scadaVendorLoaded = null;
function loadScadaVendor() {
  if (window.Chart) return Promise.resolve();
  if (_scadaVendorLoaded) return _scadaVendorLoaded;
  const loadOne = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load chart library'));
    document.head.appendChild(s);
  });
  _scadaVendorLoaded = SCADA_VENDOR.reduce(
    (chain, src) => chain.then(() => loadOne(src)), Promise.resolve());
  return _scadaVendorLoaded;
}

// Pull theme colors from CSS vars so the chart matches WaterMark's light/dark mode
// while keeping the clean, thin-line styling of the standalone dashboard.
function scadaThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  return {
    text: v('--text', '#dce8f2'),
    dim:  v('--text-dim', '#7d96aa'),
    grid: v('--border', '#1f3447'),
    surface: v('--surface', '#18293a'),
  };
}

const SCADA_STATUS_RE = /\.(Run|Fail|Enable)$/;

// Scriptable gradient fill for single-series charts (built from the real chart
// area once Chart.js has laid it out, so it's correct before first paint).
function scadaFill(color) {
  return (context) => {
    const { ctx, chartArea } = context.chart;
    if (!chartArea) return color + '20';
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, color + '40');
    g.addColorStop(1, color + '00');
    return g;
  };
}

// Draw a line chart of one or more tag paths into `canvas`. Multiple paths are
// overlaid for comparison (each its own color + legend entry).
async function drawScadaChart(canvas, tagPaths, range) {
  if (!canvas) return;
  if (!tagPaths.length) { if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; } return; }
  const key = tagPaths.join('|') + '@' + range;
  _scadaChartKey = key;
  try {
    await loadScadaVendor();
    let series;
    if (tagPaths.length === 1) {
      const arr = await api('GET', `/api/scada/history?tag=${encodeURIComponent(tagPaths[0])}&range=${encodeURIComponent(range)}`);
      series = { [tagPaths[0]]: arr };
    } else {
      const resp = await api('GET', `/api/scada/history?tags=${encodeURIComponent(tagPaths.join(','))}&range=${encodeURIComponent(range)}`);
      series = resp.series || {};
    }
    if (_scadaChartKey !== key) return; // selection changed while loading

    const c = scadaThemeColors();
    const single = tagPaths.length === 1;
    const datasets = tagPaths.map((p, i) => {
      const color = SCADA_SERIES_COLORS[i % SCADA_SERIES_COLORS.length];
      const stepped = SCADA_STATUS_RE.test(p);
      return {
        label: scadaTagLabel(p),
        data: (series[p] || []).map(([t, v]) => ({ x: t, y: v })),
        borderColor: color,
        backgroundColor: single ? scadaFill(color) : color + '22',
        borderWidth: 1.8,
        pointRadius: 0,
        tension: stepped ? 0 : 0.25,
        stepped,
        fill: single,
      };
    });

    if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
    _scadaChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: !single, labels: { color: c.text, boxWidth: 14, usePointStyle: true } },
          tooltip: {
            backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text,
            borderColor: c.grid, borderWidth: 1,
          },
        },
        scales: {
          x: {
            type: 'time',
            time: { tooltipFormat: 'MMM d, h:mm a' },
            ticks: { color: c.dim, maxTicksLimit: 8, autoSkip: true },
            grid: { color: c.grid },
          },
          y: {
            ticks: { color: c.dim },
            grid: { color: c.grid },
          },
        },
      },
    });
  } catch (err) {
    showToast(err.message || 'Chart failed to load', 'error');
  }
}

// Site-detail convenience wrapper — single tag into the detail canvas.
function renderScadaChart(tagPath, range) {
  return drawScadaChart(el('scada-chart-canvas'), [tagPath], range);
}

/* ── Trends view (multi-select chips, stack readings across sites) ─────────── */
function renderScadaTrends() {
  _scadaView = 'trends';
  const sites = _scadaConfig.sites;
  if (!_scadaTrendSite || !sites.some(s => s.id === _scadaTrendSite)) {
    _scadaTrendSite = sites[0]?.id || '';
  }
  const siteOpts = sites.map(s =>
    `<option value="${s.id}" ${s.id === _scadaTrendSite ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('');

  el('scada-body').innerHTML = scadaTabsHtml('trends') + `
    <div class="scada-trend-controls">
      <select id="scada-trend-site" class="ctrl-select ctrl-input-sm">${siteOpts}</select>
      <div class="seg-group" id="scada-trend-range">
        <button class="seg-btn" data-range="1h">1h</button>
        <button class="seg-btn" data-range="6h">6h</button>
        <button class="seg-btn" data-range="24h">24h</button>
        <button class="seg-btn" data-range="7d">7d</button>
      </div>
    </div>
    <div class="scada-trend-chips" id="scada-trend-chips"></div>
    <div class="scada-chart-wrap"><canvas id="scada-trend-canvas" class="scada-chart-canvas"></canvas></div>
    <p class="placeholder-msg" id="scada-trend-empty">Pick one or more readings above to plot. Selections from other sites stay on the chart for comparison.</p>`;

  wireScadaTabs();

  // Mark the active range button
  el('scada-trend-range').querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === _scadaTrendRange);
    b.addEventListener('click', () => {
      el('scada-trend-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaTrendRange = b.dataset.range;
      localStorage.setItem('scadaTrendRange', _scadaTrendRange);
      refreshScadaTrendChart();
    });
  });

  el('scada-trend-site').addEventListener('change', e => {
    _scadaTrendSite = e.target.value;
    localStorage.setItem('scadaTrendSite', _scadaTrendSite);
    buildScadaTrendChips();
  });

  buildScadaTrendChips();
  refreshScadaTrendChart();
}

// Chips for the currently selected site (sensors + each pump's RPM). Selecting a
// chip toggles its tag in the persisted set; chips from other sites stay selected.
function buildScadaTrendChips() {
  const wrap = el('scada-trend-chips');
  if (!wrap) return;
  const site = _scadaConfig.sites.find(s => s.id === _scadaTrendSite);
  if (!site) { wrap.innerHTML = ''; return; }
  const sensors = site.sensors || _scadaConfig.defaultSensors || [];
  const tags = [
    ...sensors.map(s => scadaSensorPath(site, s)),
    ...site.pumps.map(p => scadaPumpPath(site, p, 'MTR.Spd.SCL.PV')),
  ];
  wrap.innerHTML = tags.map(path =>
    `<button class="scada-trend-chip ${_scadaTrendTags.has(path) ? 'selected' : ''}" data-trend-tag="${path}">
       ${escHtml(scadaTagLabel(path, false))}
     </button>`).join('');
  wrap.querySelectorAll('[data-trend-tag]').forEach(chip =>
    chip.addEventListener('click', () => {
      const path = chip.dataset.trendTag;
      if (_scadaTrendTags.has(path)) _scadaTrendTags.delete(path);
      else if (_scadaTrendTags.size < 8) _scadaTrendTags.add(path);
      else { showToast('Up to 8 readings at once', 'error'); return; }
      localStorage.setItem('scadaTrendTags', JSON.stringify([..._scadaTrendTags]));
      chip.classList.toggle('selected', _scadaTrendTags.has(path));
      refreshScadaTrendChart();
    }));
}

function refreshScadaTrendChart() {
  const tags = [..._scadaTrendTags];
  const empty = el('scada-trend-empty');
  const wrap = el('scada-trend-canvas')?.closest('.scada-chart-wrap');
  if (empty) empty.classList.toggle('hidden', tags.length > 0);
  if (wrap) wrap.classList.toggle('hidden', tags.length === 0);
  if (tags.length) drawScadaChart(el('scada-trend-canvas'), tags, _scadaTrendRange);
  else if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
}
