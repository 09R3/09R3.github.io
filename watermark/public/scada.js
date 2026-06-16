/* ── SCADA Dashboard ─────────────────────────────────────────────────────────
 * Depends on app.js globals: el(), api(), showToast(), setPanelNav(), escHtml(),
 * showScreen()
 * ──────────────────────────────────────────────────────────────────────────── */

// ── Module state ─────────────────────────────────────────────────────────────
let _scadaConfig     = null;
let _scadaCurrent    = {};
let _scadaView       = 'overview'; // 'overview' | 'trends' | 'runtime' | 'plant:pp1'
let _scadaES         = null;
let _scadaChart      = null;
let _scadaChartKey   = null;
let _scadaDetailTag  = null;   // selected tag in plant detail view
let _scadaDetailRange = '24h';
let _scadaLastUpdate = 0;
let _scadaStatusTimer = null;

// Trends — multi-select tags, plant selection, range — all persisted
let _scadaTrendTags         = new Set(JSON.parse(localStorage.getItem('scadaTrendTags') || '[]'));
let _scadaTrendPlant        = localStorage.getItem('scadaTrendPlant') || '';
let _scadaTrendRange        = localStorage.getItem('scadaTrendRange') || '24h';
let _scadaTrendCustomStart  = localStorage.getItem('scadaTrendCustomStart') || '';
let _scadaTrendCustomEnd    = localStorage.getItem('scadaTrendCustomEnd') || '';

// Runtime — plant + range persisted
let _scadaRuntimePlant       = localStorage.getItem('scadaRuntimePlant') || '';
let _scadaRuntimeRange       = localStorage.getItem('scadaRuntimeRange') || '24h';
let _scadaRuntimeCustomStart = localStorage.getItem('scadaRuntimeCustomStart') || '';
let _scadaRuntimeCustomEnd   = localStorage.getItem('scadaRuntimeCustomEnd') || '';

// ── Chart vendor (loaded once from /vendor, works offline) ───────────────────
const SCADA_VENDOR = [
  '/vendor/chart.umd.js',
  '/vendor/chartjs-adapter-date-fns.bundle.min.js',
];
const SCADA_COLORS = ['#38b6ff','#2ecc71','#f1c40f','#e67e22','#9b59b6','#e74c3c','#1abc9c','#fd79a8'];
const SCADA_STATUS_RE = /\.(Run|Fail|Enable)$/;

let _scadaVendorLoaded = null;
function loadScadaVendor() {
  if (window.Chart) return Promise.resolve();
  if (_scadaVendorLoaded) return _scadaVendorLoaded;
  const one = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load chart library'));
    document.head.appendChild(s);
  });
  _scadaVendorLoaded = SCADA_VENDOR.reduce((chain, src) => chain.then(() => one(src)), Promise.resolve());
  return _scadaVendorLoaded;
}

function scadaThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => cs.getPropertyValue(n).trim() || fb;
  return {
    text:    v('--text',     '#dce8f2'),
    dim:     v('--text-dim', '#7d96aa'),
    grid:    v('--border',   '#1f3447'),
    surface: v('--surface',  '#18293a'),
  };
}

function scadaGradientFill(color) {
  return ctx => {
    const { ctx: cx, chartArea } = ctx.chart;
    if (!chartArea) return color + '20';
    const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
    return g;
  };
}

// Converts a datetime-local string (local time) to a UTC ISO string for the API.
function localDtToISO(dt) { return dt ? new Date(dt).toISOString() : ''; }

// Build the range query string — preset ('1h'…'30d') or custom { start, end }.
function scadaRangeQS(range) {
  if (typeof range === 'object')
    return `start=${encodeURIComponent(localDtToISO(range.start))}&end=${encodeURIComponent(localDtToISO(range.end))}`;
  return `range=${encodeURIComponent(range)}`;
}

// Draw one or more tags on canvas. Single-series gets gradient fill; multi gets legend.
// range: preset string OR { start, end } (datetime-local strings) for custom.
async function drawScadaChart(canvas, tagPaths, range) {
  if (!canvas || !tagPaths.length) {
    if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
    return;
  }
  const isCustom = typeof range === 'object';
  if (isCustom && (!range.start || !range.end)) return; // incomplete custom range
  const key = tagPaths.join('|') + '@' + (isCustom ? `${range.start}~${range.end}` : range);
  _scadaChartKey = key;
  try {
    await loadScadaVendor();
    const qs = scadaRangeQS(range);
    let series;
    if (tagPaths.length === 1) {
      const arr = await api('GET', `/api/scada/history?tag=${encodeURIComponent(tagPaths[0])}&${qs}`);
      series = { [tagPaths[0]]: arr };
    } else {
      const r = await api('GET', `/api/scada/history?tags=${encodeURIComponent(tagPaths.join(','))}&${qs}`);
      series = r.series || {};
    }
    if (_scadaChartKey !== key) return; // selection changed while fetching

    const c = scadaThemeColors();
    const single = tagPaths.length === 1;
    const datasets = tagPaths.map((p, i) => {
      const color = SCADA_COLORS[i % SCADA_COLORS.length];
      const stepped = SCADA_STATUS_RE.test(p);
      return {
        label: scadaTagLabel(p),
        data: (series[p] || []).map(([t, v]) => ({ x: t, y: v })),
        borderColor: color,
        backgroundColor: single ? scadaGradientFill(color) : color + '22',
        borderWidth: 1.8, pointRadius: 0,
        tension: stepped ? 0 : 0.25, stepped,
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
          tooltip: { backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1 },
        },
        scales: {
          x: { type: 'time', time: { tooltipFormat: 'MMM d, h:mm a' },
               ticks: { color: c.dim, maxTicksLimit: 8, autoSkip: true }, grid: { color: c.grid } },
          y: { ticks: { color: c.dim }, grid: { color: c.grid } },
        },
      },
    });
  } catch (err) {
    showToast(err.message || 'Chart failed to load', 'error');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
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

// ── SSE stream ────────────────────────────────────────────────────────────────
function startScadaStream() {
  stopScadaStream();
  try { _scadaES = new EventSource('/api/scada/stream'); } catch { return; }
  _scadaES.addEventListener('current', e => {
    try { applyScadaCurrent(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  _scadaES.addEventListener('sourceError', () => setScadaStatus(false));
  _scadaES.onerror = () => setScadaStatus(false);
  clearInterval(_scadaStatusTimer);
  _scadaStatusTimer = setInterval(refreshScadaStatusLabel, 1000);
}

function stopScadaStream() {
  if (_scadaES) { _scadaES.close(); _scadaES = null; }
  clearInterval(_scadaStatusTimer); _scadaStatusTimer = null;
  if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; _scadaChartKey = null; }
  _scadaDetailTag = null;
}

function applyScadaCurrent(data) {
  Object.assign(_scadaCurrent, data);
  _scadaLastUpdate = Date.now();
  setScadaStatus(true);
  if (_scadaView === 'overview') renderScadaOverview();
  else if (_scadaView.startsWith('plant:')) patchScadaPlantDetail();
  // trends / runtime: historical data — leave charts alone
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
  bar.textContent = ago == null ? 'Offline — no data received yet' : `Offline — last update ${ago}s ago`;
}

// ── Tag / value helpers ───────────────────────────────────────────────────────
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

// "CVC PP 1A" → "PP 1A"
function shortSiteName(site) { return site.name.replace('CVC ', ''); }

function scadaSiteByInflux(influx) { return _scadaConfig.sites.find(s => s.influxSite === influx); }

// Human-readable label for any tag path.
function scadaTagLabel(path) {
  const parts = path.split('.');
  const site = scadaSiteByInflux(parts[0]);
  const sn = site ? shortSiteName(site) : parts[0];
  if (parts.length === 4 && parts[2] === 'SCL' && parts[3] === 'PV') {
    return `${sn} · ${_scadaConfig.sensorMeta?.[parts[1]]?.label || parts[1]}`;
  }
  if (parts[2] === 'MTR' && parts[3] === 'Spd') {
    return `${sn} · Pump ${site ? pumpLabel(site, parts[1]) : parts[1]} RPM`;
  }
  return path;
}

// ── Plant groups (pair A + B plants) ─────────────────────────────────────────
function scadaPlantGroups() {
  const sites = _scadaConfig.sites;
  const groups = [], seen = new Set();
  for (const site of sites) {
    if (seen.has(site.id)) continue;
    const ma = site.id.match(/^(pp(\d+))a$/);
    if (ma) {
      const bSite = sites.find(s => s.id === ma[1] + 'b');
      groups.push({ key: ma[1], num: ma[2], name: `Pumping Plant ${ma[2]}`, a: site, b: bSite || null });
      seen.add(site.id);
      if (bSite) seen.add(bSite.id);
    } else if (!seen.has(site.id)) {
      groups.push({ key: site.id, num: site.id, name: site.name, a: site, b: null });
      seen.add(site.id);
    }
  }
  return groups;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function scadaTabsHtml(active) {
  const tabs = [['overview','Overview'],['trends','Trends'],['runtime','Runtime']];
  return `<div class="scada-tabs">${tabs.map(([k,l]) =>
    `<button class="scada-tab${active===k?' active':''}" data-scada-tab="${k}">${l}</button>`
  ).join('')}</div>`;
}

function wireScadaTabs() {
  el('scada-body').querySelectorAll('[data-scada-tab]').forEach(b =>
    b.addEventListener('click', () => showScadaTab(b.dataset.scadaTab)));
}

function showScadaTab(tab) {
  setPanelNav(el('screen-scada'), () => showScreen('dashboard'), 'SCADA Dashboard');
  if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; _scadaChartKey = null; }
  _scadaDetailTag = null;
  if (tab === 'trends') renderScadaTrends();
  else if (tab === 'runtime') renderScadaRuntime();
  else renderScadaOverview();
}

// ── Overview (paired plant cards) ─────────────────────────────────────────────
function renderScadaOverview() {
  _scadaView = 'overview';
  const groups = scadaPlantGroups();
  const cards = groups.map(g => {
    const solo = !g.b;
    const inner = solo
      ? plantSideHtml(g.a)
      : `${plantSideHtml(g.a)}<div class="scada-plant-divider"></div>${plantSideHtml(g.b)}`;
    return `<div class="scada-plant-card${solo ? ' scada-plant-solo' : ''}" data-plant="${g.key}">
      <div class="scada-plant-title">${escHtml(g.name)}</div>
      <div class="scada-plant-sides">${inner}</div>
    </div>`;
  }).join('');

  el('scada-body').innerHTML = scadaTabsHtml('overview') + `<div class="scada-overview-grid">${cards}</div>`;
  wireScadaTabs();
  el('scada-body').querySelectorAll('[data-plant]').forEach(c =>
    c.addEventListener('click', () => openScadaPlant(c.dataset.plant)));
}

function plantSideHtml(site) {
  const total = site.pumps.length;
  let running = 0, faulted = 0;
  site.pumps.forEach(p => {
    if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Run')))) running++;
    if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Fail')))) faulted++;
  });
  const dot = faulted ? 'alarm' : (running ? 'ok' : 'idle');
  const fb = fmtSensor('FBLvl', scadaVal(scadaSensorPath(site, 'FBLvl')));
  const tr = fmtSensor('TRLvl', scadaVal(scadaSensorPath(site, 'TRLvl')));
  const ab = fmtSensor('ABLvl', scadaVal(scadaSensorPath(site, 'ABLvl')));
  return `<div class="scada-plant-side">
    <div class="scada-side-head">
      <span class="scada-side-label">${escHtml(shortSiteName(site))}</span>
      <span class="scada-dot scada-dot-${dot}"></span>
      <span class="scada-pump-count">${running}/${total}</span>
    </div>
    <div class="scada-side-readings">
      <div class="scada-mini-row"><span>Forebay</span><strong>${fb}</strong> ft</div>
      <div class="scada-mini-row"><span>Trash Rack</span><strong>${tr}</strong> ft</div>
      <div class="scada-mini-row"><span>Afterbay</span><strong>${ab}</strong> ft</div>
    </div>
  </div>`;
}

// ── Plant detail (A+B combined view) ─────────────────────────────────────────
function openScadaPlant(groupKey) {
  const g = scadaPlantGroups().find(x => x.key === groupKey);
  if (!g) return;
  _scadaView = 'plant:' + groupKey;
  _scadaDetailTag = null;
  if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
  setPanelNav(el('screen-scada'), () => showScadaTab('overview'), 'SCADA – ' + g.name);
  renderScadaPlantDetail(g);
}

function sensorColHtml(site) {
  const sensors = site.sensors || _scadaConfig.defaultSensors || [];
  const tiles = sensors.map(s => {
    const meta = _scadaConfig.sensorMeta?.[s] || { label: s, unit: '' };
    const path = scadaSensorPath(site, s);
    return `<div class="scada-sensor-tile" data-scada-tag="${path}" data-selectable>
      <div class="scada-sensor-label">${escHtml(meta.label)}</div>
      <div class="scada-sensor-value" data-scada-sensor="${s}" data-scada-tag="${path}">${fmtSensor(s, scadaVal(path))}</div>
      <div class="scada-sensor-unit">${escHtml(meta.unit || '')}</div>
    </div>`;
  }).join('');
  return `<div class="scada-detail-col">
    <div class="scada-col-hdr">${escHtml(shortSiteName(site))}</div>
    <div class="scada-sensor-grid">${tiles}</div>
  </div>`;
}

function pumpCardHtml(site, p) {
  const runPath  = scadaPumpPath(site, p, 'MTR.Cntrl.Run');
  const failPath = scadaPumpPath(site, p, 'MTR.Cntrl.Fail');
  const spdPath  = scadaPumpPath(site, p, 'MTR.Spd.SCL.PV');
  const hpPath   = scadaPumpPath(site, p, 'HP');
  const run = isOn(scadaVal(runPath)), fail = isOn(scadaVal(failPath));
  const spd = scadaVal(spdPath), hp = scadaVal(hpPath);
  return `<div class="scada-pump-card${run?' run':' stop'}" data-scada-tag="${spdPath}" data-run-path="${runPath}" data-selectable>
    <div class="scada-pump-head">
      <span class="scada-pump-label">Pump ${escHtml(pumpLabel(site, p))}</span>
      <span class="scada-fault-badge${fail?'':' hidden'}" data-scada-fail="${failPath}">FAULT</span>
    </div>
    <span class="scada-run-pill ${run?'running':'stopped'}" data-scada-run="${runPath}">${run?'RUNNING':'STOPPED'}</span>
    <div class="scada-pump-meta">
      <span>RPM <strong data-scada-tag="${spdPath}" data-scada-int="1">${spd==null?'—':Math.round(spd)}</strong></span>
      ${hp!=null?`<span>HP <strong>${Math.round(hp)}</strong></span>`:''}
    </div>
  </div>`;
}

function renderScadaPlantDetail(g) {
  const sites = g.b ? [g.a, g.b] : [g.a];

  const sensorSection = `<div class="scada-detail-split">
    ${sites.map(sensorColHtml).join('')}
  </div>`;

  const pumpCards = sites.flatMap(s => s.pumps.map(p => pumpCardHtml(s, p))).join('');

  el('scada-body').innerHTML = `<div class="scada-detail">
    <div class="scada-section-hdr">Sensors</div>
    ${sensorSection}
    <div class="scada-section-hdr">Pumps</div>
    <div class="scada-pump-grid">${pumpCards}</div>
    <div class="scada-section-hdr" id="scada-chart-hdr">Tap a tile or pump to view its trend</div>
    <div class="scada-chart-range hidden" id="scada-detail-range">
      <div class="seg-group">
        ${['1h','6h','24h','7d'].map(r =>
          `<button class="seg-btn${_scadaDetailRange===r?' active':''}" data-range="${r}">${r}</button>`
        ).join('')}
      </div>
    </div>
    <div class="scada-chart-wrap hidden" id="scada-detail-chart-wrap">
      <canvas id="scada-chart-canvas" class="scada-chart-canvas"></canvas>
    </div>
  </div>`;

  el('scada-detail-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-detail-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaDetailRange = b.dataset.range;
      if (_scadaDetailTag) drawScadaChart(el('scada-chart-canvas'), [_scadaDetailTag], _scadaDetailRange);
    }));

  el('scada-body').querySelectorAll('[data-selectable]').forEach(tile =>
    tile.addEventListener('click', () => selectScadaDetailTag(tile)));
}

function selectScadaDetailTag(tile) {
  const path = tile.dataset.scadaTag;
  if (!path) return;
  _scadaDetailTag = path;

  el('scada-body').querySelectorAll('[data-selectable]').forEach(t => t.classList.remove('selected'));
  tile.classList.add('selected');

  // Update section header to show what's charted
  const isSensor = tile.classList.contains('scada-sensor-tile');
  const label = isSensor
    ? (tile.querySelector('.scada-sensor-label')?.textContent || 'Sensor')
    : ('Pump ' + (tile.querySelector('.scada-pump-label')?.textContent?.replace('Pump ', '') || '?') + ' RPM');
  const hdr = el('scada-chart-hdr');
  if (hdr) hdr.textContent = label;

  el('scada-detail-range').classList.remove('hidden');
  el('scada-detail-chart-wrap').classList.remove('hidden');
  drawScadaChart(el('scada-chart-canvas'), [path], _scadaDetailRange);
}

// In-place live-value patch for plant detail (chart untouched).
function patchScadaPlantDetail() {
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
  body.querySelectorAll('[data-scada-fail]').forEach(elm =>
    elm.classList.toggle('hidden', !isOn(scadaVal(elm.dataset.scadaFail))));
  body.querySelectorAll('[data-run-path]').forEach(card => {
    const run = isOn(scadaVal(card.dataset.runPath));
    card.classList.toggle('run', run);
    card.classList.toggle('stop', !run);
  });
}

// ── Trends (plant pills + multi-select chips) ─────────────────────────────────
const SCADA_PRESET_RANGES = ['1h','6h','24h','7d','30d'];

function scadaRangeBtnsHtml(currentRange, idPrefix) {
  return [...SCADA_PRESET_RANGES, 'custom'].map(r =>
    `<button class="seg-btn${currentRange===r?' active':''}" data-range="${r}">${r === 'custom' ? 'Custom' : r}</button>`
  ).join('');
}

function scadaCustomRangeHtml(startVal, endVal, idPrefix, hidden) {
  return `<div class="scada-custom-range${hidden?' hidden':''}" id="${idPrefix}-custom">
    <label class="scada-custom-label">From</label>
    <input type="datetime-local" class="ctrl-input ctrl-input-sm" id="${idPrefix}-from" value="${startVal}">
    <label class="scada-custom-label">To</label>
    <input type="datetime-local" class="ctrl-input ctrl-input-sm" id="${idPrefix}-to" value="${endVal}">
    <button class="btn btn-secondary btn-sm" id="${idPrefix}-apply">Apply</button>
  </div>`;
}

function renderScadaTrends() {
  _scadaView = 'trends';
  const groups = scadaPlantGroups();
  if (!_scadaTrendPlant || !groups.some(g => g.key === _scadaTrendPlant))
    _scadaTrendPlant = groups[0]?.key || '';

  el('scada-body').innerHTML = scadaTabsHtml('trends') + `
    <div class="scada-plant-pills" id="scada-trend-pills">
      ${groups.map(g => `<button class="scada-plant-pill${g.key===_scadaTrendPlant?' active':''}" data-plant="${g.key}">PP ${g.num}</button>`).join('')}
    </div>
    <div class="scada-trend-chips" id="scada-trend-chips"></div>
    <div class="scada-chart-controls">
      <div class="seg-group" id="scada-trend-range">${scadaRangeBtnsHtml(_scadaTrendRange, 'scada-trend')}</div>
    </div>
    ${scadaCustomRangeHtml(_scadaTrendCustomStart, _scadaTrendCustomEnd, 'scada-trend', _scadaTrendRange !== 'custom')}
    <div class="scada-chart-wrap"><canvas id="scada-trend-canvas" class="scada-chart-canvas"></canvas></div>
    <p class="placeholder-msg" id="scada-trend-empty">Pick readings above to overlay on the chart.</p>
    <button class="btn btn-secondary" id="scada-trend-clear" style="margin-top:10px;width:100%">Clear All Selections</button>`;

  wireScadaTabs();

  el('scada-trend-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-trend-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaTrendRange = b.dataset.range;
      localStorage.setItem('scadaTrendRange', _scadaTrendRange);
      el('scada-trend-custom').classList.toggle('hidden', _scadaTrendRange !== 'custom');
      if (_scadaTrendRange !== 'custom') refreshScadaTrendChart();
    }));

  el('scada-trend-apply').addEventListener('click', () => {
    _scadaTrendCustomStart = el('scada-trend-from').value;
    _scadaTrendCustomEnd   = el('scada-trend-to').value;
    localStorage.setItem('scadaTrendCustomStart', _scadaTrendCustomStart);
    localStorage.setItem('scadaTrendCustomEnd',   _scadaTrendCustomEnd);
    refreshScadaTrendChart();
  });

  el('scada-trend-clear').addEventListener('click', () => {
    _scadaTrendTags.clear();
    localStorage.setItem('scadaTrendTags', '[]');
    el('scada-trend-chips').querySelectorAll('.scada-trend-chip').forEach(c => c.classList.remove('selected'));
    if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
    const empty = el('scada-trend-empty');
    if (empty) empty.classList.remove('hidden');
    const wrap = el('scada-trend-canvas')?.closest('.scada-chart-wrap');
    if (wrap) wrap.classList.add('hidden');
  });

  el('scada-trend-pills').querySelectorAll('[data-plant]').forEach(pill =>
    pill.addEventListener('click', () => {
      el('scada-trend-pills').querySelectorAll('.scada-plant-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _scadaTrendPlant = pill.dataset.plant;
      localStorage.setItem('scadaTrendPlant', _scadaTrendPlant);
      buildScadaTrendChips();
    }));

  buildScadaTrendChips();
  refreshScadaTrendChart();
}

// Chips for all tags (sensors + pump RPM) in the selected plant (A + B).
function buildScadaTrendChips() {
  const wrap = el('scada-trend-chips');
  if (!wrap) return;
  const g = scadaPlantGroups().find(x => x.key === _scadaTrendPlant);
  if (!g) { wrap.innerHTML = ''; return; }

  const sites = g.b ? [g.a, g.b] : [g.a];
  const paths = sites.flatMap(site => {
    const sensors = site.sensors || _scadaConfig.defaultSensors || [];
    return [
      ...sensors.map(s => scadaSensorPath(site, s)),
      ...site.pumps.map(p => scadaPumpPath(site, p, 'MTR.Spd.SCL.PV')),
    ];
  });

  wrap.innerHTML = paths.map(path =>
    `<button class="scada-trend-chip${_scadaTrendTags.has(path)?' selected':''}" data-trend-tag="${path}">
      ${escHtml(scadaTagLabel(path))}</button>`).join('');

  wrap.querySelectorAll('[data-trend-tag]').forEach(chip =>
    chip.addEventListener('click', () => {
      const path = chip.dataset.trendTag;
      if (_scadaTrendTags.has(path)) {
        _scadaTrendTags.delete(path);
      } else if (_scadaTrendTags.size < 8) {
        _scadaTrendTags.add(path);
      } else {
        showToast('Up to 8 readings at once', 'error'); return;
      }
      localStorage.setItem('scadaTrendTags', JSON.stringify([..._scadaTrendTags]));
      chip.classList.toggle('selected', _scadaTrendTags.has(path));
      refreshScadaTrendChart();
    }));
}

function refreshScadaTrendChart() {
  const tags = [..._scadaTrendTags];
  const empty  = el('scada-trend-empty');
  const canvas = el('scada-trend-canvas');
  const wrap   = canvas?.closest('.scada-chart-wrap');
  if (empty) empty.classList.toggle('hidden', tags.length > 0);
  if (wrap)  wrap.classList.toggle('hidden', tags.length === 0);
  if (tags.length) {
    const range = _scadaTrendRange === 'custom'
      ? { start: _scadaTrendCustomStart, end: _scadaTrendCustomEnd }
      : _scadaTrendRange;
    drawScadaChart(canvas, tags, range);
  } else if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
}

// ── Runtime (pump run-hours from InfluxDB integral) ───────────────────────────
function renderScadaRuntime() {
  _scadaView = 'runtime';
  const groups = scadaPlantGroups();
  if (!_scadaRuntimePlant || !groups.some(g => g.key === _scadaRuntimePlant))
    _scadaRuntimePlant = groups[0]?.key || '';

  el('scada-body').innerHTML = scadaTabsHtml('runtime') + `
    <div class="scada-plant-pills" id="scada-runtime-pills">
      ${groups.map(g => `<button class="scada-plant-pill${g.key===_scadaRuntimePlant?' active':''}" data-plant="${g.key}">PP ${g.num}</button>`).join('')}
    </div>
    <div class="seg-group" id="scada-runtime-range" style="margin-bottom:8px">
      ${scadaRangeBtnsHtml(_scadaRuntimeRange, 'scada-runtime')}
    </div>
    ${scadaCustomRangeHtml(_scadaRuntimeCustomStart, _scadaRuntimeCustomEnd, 'scada-runtime', _scadaRuntimeRange !== 'custom')}
    <div id="scada-runtime-body"><div class="placeholder-msg">Loading…</div></div>`;

  wireScadaTabs();

  el('scada-runtime-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-runtime-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaRuntimeRange = b.dataset.range;
      localStorage.setItem('scadaRuntimeRange', _scadaRuntimeRange);
      el('scada-runtime-custom').classList.toggle('hidden', _scadaRuntimeRange !== 'custom');
      if (_scadaRuntimeRange !== 'custom') loadScadaRuntime();
    }));

  el('scada-runtime-apply').addEventListener('click', () => {
    _scadaRuntimeCustomStart = el('scada-runtime-from').value;
    _scadaRuntimeCustomEnd   = el('scada-runtime-to').value;
    localStorage.setItem('scadaRuntimeCustomStart', _scadaRuntimeCustomStart);
    localStorage.setItem('scadaRuntimeCustomEnd',   _scadaRuntimeCustomEnd);
    loadScadaRuntime();
  });

  el('scada-runtime-pills').querySelectorAll('[data-plant]').forEach(pill =>
    pill.addEventListener('click', () => {
      el('scada-runtime-pills').querySelectorAll('.scada-plant-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _scadaRuntimePlant = pill.dataset.plant;
      localStorage.setItem('scadaRuntimePlant', _scadaRuntimePlant);
      loadScadaRuntime();
    }));

  loadScadaRuntime();
}

async function loadScadaRuntime() {
  const rBody = el('scada-runtime-body');
  if (!rBody) return;
  rBody.innerHTML = '<div class="placeholder-msg">Loading…</div>';

  const g = scadaPlantGroups().find(x => x.key === _scadaRuntimePlant);
  if (!g) { rBody.innerHTML = '<div class="placeholder-msg">No data.</div>'; return; }

  const sites = g.b ? [g.a, g.b] : [g.a];
  const runtimeRangeObj = _scadaRuntimeRange === 'custom'
    ? { start: _scadaRuntimeCustomStart, end: _scadaRuntimeCustomEnd }
    : null;
  const maxHrs = runtimeRangeObj ? rangeHours(runtimeRangeObj) : rangeHours(_scadaRuntimeRange);

  if (runtimeRangeObj && (!runtimeRangeObj.start || !runtimeRangeObj.end)) {
    rBody.innerHTML = '<div class="placeholder-msg">Set start and end dates above, then tap Apply.</div>';
    return;
  }

  try {
    const qs = runtimeRangeObj
      ? `start=${encodeURIComponent(localDtToISO(runtimeRangeObj.start))}&end=${encodeURIComponent(localDtToISO(runtimeRangeObj.end))}`
      : `range=${encodeURIComponent(_scadaRuntimeRange)}`;
    const results = await Promise.all(
      sites.map(s => api('GET', `/api/scada/runtime?site=${encodeURIComponent(s.influxSite)}&${qs}`))
    );

    const cards = sites.flatMap((site, si) =>
      site.pumps.map(p => {
        const hrs = results[si][p] ?? 0;
        const pct = Math.min(100, (hrs / maxHrs) * 100).toFixed(1);
        const label = pumpLabel(site, p);
        return `<div class="scada-runtime-card">
          <div class="scada-runtime-head">
            <span class="scada-pump-label">Pump ${escHtml(label)}</span>
            <span class="scada-runtime-hrs">${hrs.toFixed(1)} h</span>
          </div>
          <div class="scada-runtime-bar-track"><div class="scada-runtime-bar" style="width:${pct}%"></div></div>
        </div>`;
      })
    ).join('');

    rBody.innerHTML = `<div class="scada-runtime-grid">${cards}</div>`;
  } catch (err) {
    rBody.innerHTML = `<div class="placeholder-msg">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

function rangeHours(range) {
  if (typeof range === 'object' && range.start && range.end)
    return Math.max(1, (new Date(range.end) - new Date(range.start)) / 3600000);
  return { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[range] || 24;
}
