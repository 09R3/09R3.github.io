/* ── SCADA Dashboard ─────────────────────────────────────────────────────────
 * Depends on app.js globals: el(), api(), showToast(), setPanelNav(), escHtml(),
 * showScreen()
 * ──────────────────────────────────────────────────────────────────────────── */

// ── Module state ─────────────────────────────────────────────────────────────
let _scadaConfig     = null;
let _scadaCurrent    = {};
let _scadaView       = 'overview'; // 'overview' | 'trends' | 'runtime' | 'plant:pp1'
let _scadaES         = null;
let _scadaChart        = null;
let _scadaChartKey     = null;
let _scadaRuntimeChart = null;
let _scadaDetailTag  = null;   // selected tag in plant detail view
let _scadaDetailRange = '24h';
let _scadaDetailCustomStart = localStorage.getItem('scadaDetailCustomStart') || '';
let _scadaDetailCustomEnd   = localStorage.getItem('scadaDetailCustomEnd') || '';
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
let _scadaRuntimeSubTab      = localStorage.getItem('scadaRuntimeSubTab') || 'runtime';

// Overview charts — mini FBLvl trend per plant card
let _overviewRange       = localStorage.getItem('scadaOverviewRange') || '24h';
let _overviewCustomStart = localStorage.getItem('scadaOverviewCustomStart') || '';
let _overviewCustomEnd   = localStorage.getItem('scadaOverviewCustomEnd') || '';
let _overviewCharts  = new Map();   // groupKey → Chart instance
let _overviewLoadGen = 0;           // cancel stale loads on range change

function destroyOverviewCharts() {
  _overviewCharts.forEach(c => { try { c.destroy(); } catch { /* */ } });
  _overviewCharts.clear();
}

// ── Chart vendor (loaded once from /vendor, works offline) ───────────────────
const SCADA_VENDOR = [
  '/vendor/chart.umd.js',
  '/vendor/chartjs-adapter-date-fns.bundle.min.js',
];
const SCADA_COLORS = ['#38b6ff','#2ecc71','#f1c40f','#e67e22','#9b59b6','#e74c3c','#1abc9c','#fd79a8'];
const SCADA_STATUS_RE = /\.(Run|Fail|Enable)$/;

// Pump flow capacity in CFS, keyed by influxSite then pump letter.
const PUMP_CFS_TABLE = {
  'CVC_PP1A': {A:31,  B:70,  C:180, D:180, E:180, F:180, G:70,  H:31},
  'CVC_PP2A': {A:31,  B:70,  C:180, D:180, E:180, F:180, G:70,  H:31},
  'CVC_PP3A': {A:31,  B:70,  C:180, D:180, E:180, F:70,  G:31,  H:70,  J:31},
  'CVC_PP4A': {A:31,  B:70,  C:180, D:180, E:180, F:70,  G:31,  H:70,  J:31},
  'CVC_PP5A': {A:31,  B:70,  C:180, D:180, E:180, F:70,  G:31,  H:70,  J:31},
  'CVC_PP6A': {A:31,  B:70,  C:180, D:180, E:180, F:70,  G:70,  H:31},
  'CVC_PP7A': {A:31,  B:70,  C:70,  D:70,  E:70,  F:31},
  'CVC_PP1B': {A:200, B:200, C:200},
  'CVC_PP2B': {A:200, B:200, C:200},
  'CVC_PP3B': {A:200, B:200, C:200},
  'CVC_PP4B': {A:200, B:200, C:200},
  'CVC_PP5B': {A:200, B:200, C:200},
  'CVC_PP6B': {A:45,  B:200, C:200, D:90},
};

// Reverse-flow CFS per pump (A plants only) — used when a plant runs in reverse
// mode and a pump's siphon breaker is closed. Keyed by influxSite then letter.
const REVERSE_CFS_TABLE = {
  'CVC_PP1A': {A:25, B:56, C:140, D:140, E:140, F:140, G:55, H:25},
  'CVC_PP2A': {A:25, B:56, C:140, D:140, E:140, F:140, G:55, H:25},
  'CVC_PP3A': {A:25, B:56, C:140, D:140, E:140, F:55,  G:25, H:55, J:25},
  'CVC_PP4A': {A:25, B:56, C:140, D:140, E:140, F:55,  G:25, H:55, J:25},
  'CVC_PP5A': {A:25, B:56, C:140, D:140, E:140, F:55,  G:25, H:55, J:25},
  'CVC_PP6A': {A:25, B:56, C:140, D:140, E:140, F:55,  G:25},
  'CVC_PP7A': {A:25, B:56, C:56,  D:56,  E:56,  F:25},
};

// Pump motor HP per pump, keyed by influxSite then pump letter. This is a static
// label only (no calculations depend on it), hard-coded from the published chart.
// B-plant pumps use their actual letters (A/B/C/D); they display as K/L/M/N.
const PUMP_HP_TABLE = {
  'CVC_PP1A': {A:100, B:250, C:565, D:565, E:565, F:565, G:250, H:100},
  'CVC_PP2A': {A:100, B:250, C:565, D:565, E:565, F:565, G:250, H:100},
  'CVC_PP3A': {A:100, B:250, C:565, D:565, E:565, F:250, G:100, H:250, J:100},
  'CVC_PP4A': {A:100, B:250, C:565, D:565, E:565, F:250, G:100, H:250, J:100},
  'CVC_PP5A': {A:100, B:250, C:565, D:565, E:565, F:250, G:100, H:250, J:100},
  'CVC_PP6A': {A:100, B:250, C:565, D:565, E:565, F:250, G:250, H:100},
  'CVC_PP7A': {A:100, B:250, C:250, D:250, E:250, F:100},
  'CVC_PP1B': {A:800, B:800, C:800},
  'CVC_PP2B': {A:700, B:700, C:700},
  'CVC_PP3B': {A:700, B:700, C:700},
  'CVC_PP4B': {A:700, B:700, C:700},
  'CVC_PP5B': {A:700, B:700, C:700},
  'CVC_PP6B': {A:250, B:700, C:700, D:400},
};

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

    // Separate regular tag paths from synthetic computed-sum tags
    const regPaths = tagPaths.filter(p => !p.startsWith('~sum~'));
    const sumTags  = tagPaths.filter(p =>  p.startsWith('~sum~'));

    let series = {};
    if (regPaths.length === 1) {
      const arr = await api('GET', `/api/scada/history?tag=${encodeURIComponent(regPaths[0])}&${qs}`);
      series[regPaths[0]] = arr;
    } else if (regPaths.length > 1) {
      const r = await api('GET', `/api/scada/history?tags=${encodeURIComponent(regPaths.join(','))}&${qs}`);
      series = r.series || {};
    }

    // Fetch constituent paths for each sum tag and merge by timestamp
    for (const sumTag of sumTags) {
      const parsed = parseSumTag(sumTag);
      if (!parsed || !parsed.paths.length) continue;
      const r = await api('GET', `/api/scada/history?tags=${encodeURIComponent(parsed.paths.join(','))}&${qs}`);
      const s = r.series || {};
      const pts = new Map();
      parsed.paths.forEach(p => { (s[p] || []).forEach(([t, v]) => pts.set(t, (pts.get(t) || 0) + v)); });
      series[sumTag] = [...pts.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    }

    if (_scadaChartKey !== key) return; // selection changed while fetching

    const c = scadaThemeColors();
    const single = tagPaths.length === 1;
    const anyStatus = tagPaths.some(p => SCADA_STATUS_RE.test(p));
    const datasets = tagPaths.map((p, i) => {
      const color = SCADA_COLORS[i % SCADA_COLORS.length];
      const status = SCADA_STATUS_RE.test(p);
      if (status) {
        // On/off state: filled stepped band on a hidden 0–1 axis so it reads as a
        // solid bar while running (empty when off) and never distorts the level scale.
        return {
          label: scadaTagLabel(p),
          data: (series[p] || []).map(([t, v]) => ({ x: t, y: v >= 0.5 ? 1 : 0 })),
          yAxisID: 'yStatus',
          borderColor: color,
          backgroundColor: color + '33',
          borderWidth: 1, pointRadius: 0,
          stepped: true, fill: 'origin',
        };
      }
      return {
        label: scadaTagLabel(p),
        data: (series[p] || []).map(([t, v]) => ({ x: t, y: v })),
        borderColor: color,
        backgroundColor: single ? scadaGradientFill(color) : color + '22',
        borderWidth: 1.8, pointRadius: 0,
        tension: 0.25,
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
          ...(anyStatus ? { yStatus: { display: false, min: 0, max: 1, position: 'right' } } : {}),
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
  stopScadaPower();
}

function applyScadaCurrent(data) {
  Object.assign(_scadaCurrent, data);
  _scadaLastUpdate = Date.now();
  setScadaStatus(true);
  if (_scadaView === 'overview') patchScadaOverview();
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

// Returns inline color style when a temperature reading is critically high.
function tempColorStyle(sensor, v) {
  return sensor === 'InTmp' && v != null && v > 85 ? '#ef4444' : '';
}

// Decodes a synthetic computed-sum tag: '~sum~Label~unit~path1,path2,...'
function parseSumTag(tag) {
  if (!tag.startsWith('~sum~')) return null;
  const parts = tag.slice(5).split('~'); // ['Label', 'unit', 'path1,path2']
  return { label: parts[0], unit: parts[1] || '', paths: (parts[2] || '').split(',').filter(Boolean) };
}

// Skid-level status helpers (A plants expose these tags).
function siteReverseMode(site) { return isOn(scadaVal(`${site.influxSite}.Skid.FRmode`)); }
function siteOverridesDisabled(site) { return isOn(scadaVal(`${site.influxSite}.Skid.DSDis`)); }
// Siphon breaker O_Cmd: true = closed.
function siphonClosed(site, p) { return isOn(scadaVal(scadaPumpPath(site, p, 'SBVlv.Cntrl.O_Cmd'))); }

// Plant-group flow total (used for the live overview flow line). In reverse mode
// (FRmode true) a plant's flow is the reverse-chart CFS of every pump whose siphon
// breaker is closed, shown NEGATIVE since water moves the opposite direction;
// otherwise it's the forward CFS of every running pump.
function plantGroupFlow(g) {
  const sites = g.b ? [g.a, g.b] : [g.a];
  let total = 0;
  sites.forEach(site => {
    if (siteReverseMode(site)) {
      const rev = REVERSE_CFS_TABLE[site.influxSite] || {};
      site.pumps.forEach(p => { if (siphonClosed(site, p)) total -= rev[p] || 0; });
    } else {
      const cfs = PUMP_CFS_TABLE[site.influxSite] || {};
      site.pumps.forEach(p => {
        if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Run')))) total += cfs[p] || 0;
      });
    }
  });
  return total;
}

// "CVC PP 1A" → "PP 1A"
function shortSiteName(site) { return site.name.replace('CVC ', ''); }

function scadaSiteByInflux(influx) { return _scadaConfig.sites.find(s => s.influxSite === influx); }

// Human-readable label for any tag path (including synthetic ~sum~ tags).
function scadaTagLabel(path) {
  if (path.startsWith('~sum~')) {
    const parsed = parseSumTag(path);
    if (!parsed) return path;
    const firstSite = parsed.paths[0] ? scadaSiteByInflux(parsed.paths[0].split('.')[0]) : null;
    const sn = firstSite ? shortSiteName(firstSite) : '';
    return sn ? `${sn} · ${parsed.label}` : parsed.label;
  }
  const parts = path.split('.');
  const site = scadaSiteByInflux(parts[0]);
  const sn = site ? shortSiteName(site) : parts[0];
  if (parts.length === 4 && parts[2] === 'SCL' && parts[3] === 'PV') {
    return `${sn} · ${_scadaConfig.sensorMeta?.[parts[1]]?.label || parts[1]}`;
  }
  if (parts[2] === 'MTR' && parts[3] === 'Spd') {
    return `${sn} · Pump ${site ? pumpLabel(site, parts[1]) : parts[1]} RPM`;
  }
  if (parts[2] === 'MTR' && parts[3] === 'Cntrl' && parts[4] === 'Run') {
    return `${sn} · Pump ${site ? pumpLabel(site, parts[1]) : parts[1]} Run`;
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
  if (_scadaConfig?.power) tabs.push(['power','Power']);
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
  destroyOverviewCharts();
  stopScadaPower(); // tear down power timer + charts when leaving Power tab
  if (tab === 'trends') renderScadaTrends();
  else if (tab === 'runtime') renderScadaRuntime();
  else if (tab === 'power') renderScadaPower();
  else renderScadaOverview();
}

// ── Overview (paired plant cards) ─────────────────────────────────────────────
function renderScadaOverview() {
  _scadaView = 'overview';
  destroyOverviewCharts();
  const groups = scadaPlantGroups();
  const cards = groups.map(g => {
    const sides = g.b
      ? `${compactSideHtml(g.a)}<div style="width:1px;background:var(--border);margin:0 4px;flex-shrink:0"></div>${compactSideHtml(g.b)}`
      : compactSideHtml(g.a);
    const flowTotal = plantGroupFlow(g);
    const revMode = siteReverseMode(g.a);
    return `<div class="scada-plant-card" style="display:flex;align-items:stretch;padding:0;overflow:hidden" data-plant="${g.key}">
      <div style="flex:1;min-width:0;padding:8px 10px">
        <div class="scada-plant-title" style="margin-bottom:4px">${escHtml(g.name)}${dwrTitleHtml(g)}</div>
        <div data-ov-revmode="${escHtml(g.a.influxSite)}" style="font-size:0.72rem;font-weight:700;color:#ef4444;margin-bottom:3px${revMode ? '' : ';display:none'}">(Reverse Mode)</div>
        <div style="display:flex;gap:0;align-items:flex-start">${sides}${bldgTempColHtml(g)}</div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:3px" data-ov-flow="${escHtml(g.key)}">Flow&nbsp;=&nbsp;<strong>${flowTotal} cfs</strong></div>
      </div>
      <div style="flex:0 0 38%;border-left:1px solid var(--border);position:relative;min-height:88px">
        <canvas data-ov-plant="${g.key}" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
      </div>
    </div>`;
  }).join('');

  el('scada-body').innerHTML = scadaTabsHtml('overview') + `
    <div class="seg-group" id="scada-ov-range" style="margin-bottom:8px">${scadaRangeBtnsHtml(_overviewRange)}</div>
    ${scadaCustomRangeHtml(_overviewCustomStart, _overviewCustomEnd, 'scada-ov', _overviewRange !== 'custom')}
    <div class="scada-overview-grid">${cards}</div>`;

  wireScadaTabs();

  el('scada-ov-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-ov-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _overviewRange = b.dataset.range;
      localStorage.setItem('scadaOverviewRange', _overviewRange);
      el('scada-ov-custom').classList.toggle('hidden', _overviewRange !== 'custom');
      if (_overviewRange !== 'custom') loadOverviewCharts();
    }));

  el('scada-ov-apply').addEventListener('click', () => {
    _overviewCustomStart = el('scada-ov-from').value;
    _overviewCustomEnd   = el('scada-ov-to').value;
    localStorage.setItem('scadaOverviewCustomStart', _overviewCustomStart);
    localStorage.setItem('scadaOverviewCustomEnd',   _overviewCustomEnd);
    loadOverviewCharts();
  });

  el('scada-body').querySelectorAll('[data-plant]').forEach(c =>
    c.addEventListener('click', () => openScadaPlant(c.dataset.plant)));

  loadOverviewCharts();
}

// Title suffix showing live DWR total flow, for plants that define a computed flow sum.
function dwrTitleHtml(g) {
  const sites = g.b ? [g.a, g.b] : [g.a];
  const site = sites.find(s => (s.computedSensors || []).some(c => c.kind === 'flow' || /flow|dwr/i.test(c.label)));
  if (!site) return '';
  const comp  = site.computedSensors.find(c => c.kind === 'flow' || /flow|dwr/i.test(c.label));
  const paths = comp.sum.map(s => scadaSensorPath(site, s));
  const vals  = paths.map(scadaVal);
  const total = vals.every(v => v != null) ? vals.reduce((a, b) => a + b, 0) : null;
  return ` <span style="font-weight:500;font-size:0.8rem;color:var(--accent)"
    data-ov-dwr="${escHtml(paths.join(','))}" data-ov-dwr-unit="${escHtml(comp.unit || '')}">— DWR ${total == null ? '—' : total.toFixed(1)} ${escHtml(comp.unit || '')}</span>`;
}

// Building-temp column (right side of the readings block) — one row per site in the group.
function bldgTempColHtml(g) {
  const sites = g.b ? [g.a, g.b] : [g.a];
  const rows = sites.map(s => {
    const path  = scadaSensorPath(s, 'InTmp');
    const tag   = shortSiteName(s).replace('PP ', '');
    const v     = scadaVal(path);
    const color = tempColorStyle('InTmp', v);
    const style = color ? ` style="color:${color}"` : '';
    return `<div>${escHtml(tag)}&nbsp;<strong data-scada-sensor="InTmp" data-scada-tag="${path}"${style}>${fmtSensor('InTmp', v)}</strong>°</div>`;
  }).join('');
  const dsDis = siteOverridesDisabled(g.a);
  return `<div style="flex:0 0 auto;padding-left:10px;font-size:0.73rem;line-height:1.55;color:var(--text-dim)">
    <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:.04em;opacity:.8">Bldg °F</div>
    ${rows}
    <div data-ov-dsdis="${escHtml(g.a.influxSite)}" style="font-size:0.66rem;font-weight:700;color:#ef4444;margin-top:2px${dsDis ? '' : ';display:none'}">Overrides Disabled</div>
  </div>`;
}

function compactSideHtml(site) {
  const total = site.pumps.length;
  let running = 0, faulted = 0;
  site.pumps.forEach(p => {
    if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Run')))) running++;
    if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Fail')))) faulted++;
  });
  const dot = faulted ? 'alarm' : (running ? 'ok' : 'idle');
  const fbPath = scadaSensorPath(site, 'FBLvl');
  const trPath = scadaSensorPath(site, 'TRLvl');
  const abPath = scadaSensorPath(site, 'ABLvl');
  return `<div style="flex:1;min-width:0" data-ov-site="${escHtml(site.influxSite)}">
    <div style="display:flex;align-items:center;gap:3px;margin-bottom:3px">
      <span class="scada-dot scada-dot-${dot}"></span>
      <span style="font-size:0.78rem;font-weight:700;white-space:nowrap">${escHtml(shortSiteName(site))}</span>
      <span class="scada-pump-count" style="font-size:0.7rem;color:var(--text-dim)">${running}/${total}</span>
    </div>
    <div style="font-size:0.73rem;line-height:1.55;color:var(--text-dim)">
      <div>FB&nbsp;<strong data-scada-sensor="FBLvl" data-scada-tag="${fbPath}">${fmtSensor('FBLvl', scadaVal(fbPath))}</strong></div>
      <div>TR&nbsp;<strong data-scada-sensor="TRLvl" data-scada-tag="${trPath}">${fmtSensor('TRLvl', scadaVal(trPath))}</strong></div>
      <div>AB&nbsp;<strong data-scada-sensor="ABLvl" data-scada-tag="${abPath}">${fmtSensor('ABLvl', scadaVal(abPath))}</strong></div>
    </div>
  </div>`;
}

function patchScadaOverview() {
  const body = el('scada-body');
  body.querySelectorAll('[data-scada-sensor]').forEach(elm => {
    const sensor = elm.dataset.scadaSensor;
    const v = scadaVal(elm.dataset.scadaTag);
    elm.textContent = fmtSensor(sensor, v);
    const color = tempColorStyle(sensor, v);
    elm.style.color = color || '';
  });
  body.querySelectorAll('[data-ov-site]').forEach(div => {
    const site = _scadaConfig?.sites.find(s => s.influxSite === div.dataset.ovSite);
    if (!site) return;
    let running = 0, faulted = 0;
    site.pumps.forEach(p => {
      if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Run')))) running++;
      if (isOn(scadaVal(scadaPumpPath(site, p, 'MTR.Cntrl.Fail')))) faulted++;
    });
    const dot = faulted ? 'alarm' : (running ? 'ok' : 'idle');
    const dotEl = div.querySelector('.scada-dot');
    const cntEl = div.querySelector('.scada-pump-count');
    if (dotEl) dotEl.className = `scada-dot scada-dot-${dot}`;
    if (cntEl) cntEl.textContent = `${running}/${site.pumps.length}`;
  });
  body.querySelectorAll('[data-ov-dwr]').forEach(elm => {
    const vals = elm.dataset.ovDwr.split(',').map(p => scadaVal(p));
    const total = vals.every(v => v != null) ? vals.reduce((a, b) => a + b, 0) : null;
    elm.textContent = `— DWR ${total == null ? '—' : total.toFixed(1)} ${elm.dataset.ovDwrUnit || ''}`;
  });
  body.querySelectorAll('[data-ov-flow]').forEach(elm => {
    const g = scadaPlantGroups().find(x => x.key === elm.dataset.ovFlow);
    if (!g) return;
    const total = plantGroupFlow(g);
    const strong = elm.querySelector('strong');
    if (strong) strong.textContent = `${total} cfs`;
  });
  body.querySelectorAll('[data-ov-revmode]').forEach(elm => {
    const site = _scadaConfig?.sites.find(s => s.influxSite === elm.dataset.ovRevmode);
    elm.style.display = site && siteReverseMode(site) ? '' : 'none';
  });
  body.querySelectorAll('[data-ov-dsdis]').forEach(elm => {
    const site = _scadaConfig?.sites.find(s => s.influxSite === elm.dataset.ovDsdis);
    elm.style.display = site && siteOverridesDisabled(site) ? '' : 'none';
  });
}

async function loadOverviewCharts() {
  const gen = ++_overviewLoadGen;
  try { await loadScadaVendor(); } catch { return; }
  if (gen !== _overviewLoadGen) return;

  const groups = scadaPlantGroups();
  const custom = _overviewRange === 'custom';
  if (custom && (!_overviewCustomStart || !_overviewCustomEnd)) return; // wait for Apply
  const qs = custom
    ? `start=${encodeURIComponent(localDtToISO(_overviewCustomStart))}&end=${encodeURIComponent(localDtToISO(_overviewCustomEnd))}`
    : `range=${encodeURIComponent(_overviewRange)}`;

  await Promise.all(groups.map(async g => {
    const canvas = el('scada-body').querySelector(`[data-ov-plant="${g.key}"]`);
    if (!canvas) return;
    if (_overviewCharts.has(g.key)) { _overviewCharts.get(g.key).destroy(); _overviewCharts.delete(g.key); }

    // Chart shows only the A-side Forebay and Trash Rack levels for at-a-glance view.
    const siteA = g.a;
    try {
      const [fbData, trData] = await Promise.all([
        api('GET', `/api/scada/history?tag=${encodeURIComponent(scadaSensorPath(siteA, 'FBLvl'))}&${qs}`),
        api('GET', `/api/scada/history?tag=${encodeURIComponent(scadaSensorPath(siteA, 'TRLvl'))}&${qs}`),
      ]);
      if (gen !== _overviewLoadGen || !canvas.isConnected) return;

      const tc = scadaThemeColors();
      const datasets = [
        {
          label: 'FB',
          data: fbData.map(([t, v]) => ({ x: t, y: v })),
          borderColor: SCADA_COLORS[0],
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
        },
        {
          label: 'TR',
          data: trData.map(([t, v]) => ({ x: t, y: v })),
          borderColor: SCADA_COLORS[2],
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
        },
      ];

      const chart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          events: [],
          plugins: {
            legend: {
              display: true,
              labels: { color: tc.dim, boxWidth: 10, font: { size: 9 }, padding: 4 },
            },
          },
          scales: {
            x: {
              type: 'time',
              ticks: { color: tc.dim, maxTicksLimit: 3, font: { size: 9 } },
              grid: { color: tc.grid },
            },
            y: {
              ticks: { color: tc.dim, maxTicksLimit: 3, font: { size: 9 } },
              grid: { color: tc.grid },
            },
          },
        },
      });
      _overviewCharts.set(g.key, chart);
    } catch { /* skip — no data or offline */ }
  }));
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
  destroyOverviewCharts();
  if (_scadaChart) { _scadaChart.destroy(); _scadaChart = null; }
  setPanelNav(el('screen-scada'), () => showScadaTab('overview'), 'SCADA – ' + g.name);
  renderScadaPlantDetail(g);
}

function sensorColHtml(site) {
  const sensors = site.sensors || _scadaConfig.defaultSensors || [];
  const tiles = sensors.map(s => {
    const meta  = _scadaConfig.sensorMeta?.[s] || { label: s, unit: '' };
    const path  = scadaSensorPath(site, s);
    const v     = scadaVal(path);
    const color = tempColorStyle(s, v);
    const style = color ? ` style="color:${color}"` : '';
    return `<div class="scada-sensor-tile" data-scada-tag="${path}" data-selectable>
      <div class="scada-sensor-label">${escHtml(meta.label)}</div>
      <div class="scada-sensor-value" data-scada-sensor="${s}" data-scada-tag="${path}"${style}>${fmtSensor(s, v)}</div>
      <div class="scada-sensor-unit">${escHtml(meta.unit || '')}</div>
    </div>`;
  }).join('');

  const computed = (site.computedSensors || []).map(c => {
    const paths = c.sum.map(s => scadaSensorPath(site, s));
    const vals  = paths.map(p => scadaVal(p));
    const total = vals.every(v => v != null) ? vals.reduce((a, b) => a + b, 0) : null;
    const key   = paths.join(',');
    return `<div class="scada-sensor-tile scada-sensor-computed">
      <div class="scada-sensor-label">${escHtml(c.label)}</div>
      <div class="scada-sensor-value" data-scada-computed="${escHtml(key)}">${total == null ? '—' : total.toFixed(2)}</div>
      <div class="scada-sensor-unit">${escHtml(c.unit || '')}</div>
    </div>`;
  }).join('');

  return `<div class="scada-detail-col">
    <div class="scada-col-hdr">${escHtml(shortSiteName(site))}</div>
    <div class="scada-sensor-grid">${tiles}${computed}</div>
  </div>`;
}

function pumpCardHtml(site, p) {
  const runPath  = scadaPumpPath(site, p, 'MTR.Cntrl.Run');
  const failPath = scadaPumpPath(site, p, 'MTR.Cntrl.Fail');
  const spdPath  = scadaPumpPath(site, p, 'MTR.Spd.SCL.PV');
  const sbPath   = scadaPumpPath(site, p, 'SBVlv.Cntrl.O_Cmd');
  const run = isOn(scadaVal(runPath)), fail = isOn(scadaVal(failPath));
  const spd = scadaVal(spdPath);
  const hp  = (PUMP_HP_TABLE[site.influxSite] || {})[p]; // static label, from chart
  const sbClosed = siphonClosed(site, p);
  return `<div class="scada-pump-card${run?' run':' stop'}" data-scada-tag="${spdPath}" data-run-path="${runPath}" data-selectable>
    <div class="scada-pump-head">
      <span class="scada-pump-label">Pump ${escHtml(pumpLabel(site, p))}</span>
      <span class="scada-fault-badge${fail?'':' hidden'}" data-scada-fail="${failPath}">FAULT</span>
    </div>
    <span class="scada-run-pill ${run?'running':'stopped'}" data-scada-run="${runPath}">${run?'RUNNING':'STOPPED'}</span>
    <div class="scada-pump-meta">
      <span>RPM <strong data-scada-tag="${spdPath}" data-scada-int="1">${spd==null?'—':Math.round(spd)}</strong></span>
      ${hp!=null?`<span>HP <strong>${hp}</strong></span>`:''}
    </div>
    <div class="scada-pump-siphon" data-scada-siphon="${sbPath}">Siphon <strong>${sbClosed ? 'Closed' : 'Open'}</strong></div>
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
      <div class="seg-group">${scadaRangeBtnsHtml(_scadaDetailRange)}</div>
      ${scadaCustomRangeHtml(_scadaDetailCustomStart, _scadaDetailCustomEnd, 'scada-detail', _scadaDetailRange !== 'custom')}
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
      el('scada-detail-custom').classList.toggle('hidden', _scadaDetailRange !== 'custom');
      if (_scadaDetailRange !== 'custom' && _scadaDetailTag)
        drawScadaChart(el('scada-chart-canvas'), [_scadaDetailTag], detailRangeArg());
    }));

  el('scada-detail-apply').addEventListener('click', () => {
    _scadaDetailCustomStart = el('scada-detail-from').value;
    _scadaDetailCustomEnd   = el('scada-detail-to').value;
    localStorage.setItem('scadaDetailCustomStart', _scadaDetailCustomStart);
    localStorage.setItem('scadaDetailCustomEnd',   _scadaDetailCustomEnd);
    if (_scadaDetailTag) drawScadaChart(el('scada-chart-canvas'), [_scadaDetailTag], detailRangeArg());
  });

  el('scada-body').querySelectorAll('[data-selectable]').forEach(tile =>
    tile.addEventListener('click', () => selectScadaDetailTag(tile)));
}

function detailRangeArg() {
  return _scadaDetailRange === 'custom'
    ? { start: _scadaDetailCustomStart, end: _scadaDetailCustomEnd }
    : _scadaDetailRange;
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
  drawScadaChart(el('scada-chart-canvas'), [path], detailRangeArg());
}

// In-place live-value patch for plant detail (chart untouched).
function patchScadaPlantDetail() {
  const body = el('scada-body');
  body.querySelectorAll('[data-scada-sensor]').forEach(elm => {
    const sensor = elm.dataset.scadaSensor;
    const v = scadaVal(elm.dataset.scadaTag);
    elm.textContent = fmtSensor(sensor, v);
    const color = tempColorStyle(sensor, v);
    elm.style.color = color || '';
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
  body.querySelectorAll('[data-scada-computed]').forEach(elm => {
    const vals = elm.dataset.scadaComputed.split(',').map(p => scadaVal(p));
    elm.textContent = vals.every(v => v != null) ? vals.reduce((a, b) => a + b, 0).toFixed(2) : '—';
  });
  body.querySelectorAll('[data-run-path]').forEach(card => {
    const run = isOn(scadaVal(card.dataset.runPath));
    card.classList.toggle('run', run);
    card.classList.toggle('stop', !run);
  });
  body.querySelectorAll('[data-scada-siphon]').forEach(elm => {
    const closed = isOn(scadaVal(elm.dataset.scadaSiphon));
    const strong = elm.querySelector('strong');
    if (strong) strong.textContent = closed ? 'Closed' : 'Open';
  });
}

// ── Trends (plant pills + multi-select chips) ─────────────────────────────────
const SCADA_PRESET_RANGES = ['1h','8h','12h','24h','7d','30d'];
const SCADA_POWER_RANGES  = ['15m','1h','6h','24h','7d'];

function scadaRangeBtnsHtml(currentRange, presets = SCADA_PRESET_RANGES) {
  return [...presets, 'custom'].map(r =>
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

  // Trends now charts pump on/off state, not RPM — migrate any saved RPM selections.
  if ([..._scadaTrendTags].some(t => t.endsWith('.MTR.Spd.SCL.PV'))) {
    _scadaTrendTags = new Set([..._scadaTrendTags].map(t => t.replace(/\.MTR\.Spd\.SCL\.PV$/, '.MTR.Cntrl.Run')));
    localStorage.setItem('scadaTrendTags', JSON.stringify([..._scadaTrendTags]));
  }

  el('scada-body').innerHTML = scadaTabsHtml('trends') + `
    <div class="scada-plant-pills" id="scada-trend-pills">
      ${groups.map(g => `<button class="scada-plant-pill${g.key===_scadaTrendPlant?' active':''}" data-plant="${g.key}">PP ${g.num}</button>`).join('')}
    </div>
    <div class="scada-trend-chips" id="scada-trend-chips"></div>
    <div class="scada-chart-controls">
      <div class="seg-group" id="scada-trend-range">${scadaRangeBtnsHtml(_scadaTrendRange)}</div>
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

// Chips for all tags (sensors + pump run + computed sums) in the selected plant (A + B).
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
      ...site.pumps.map(p => scadaPumpPath(site, p, 'MTR.Cntrl.Run')),
    ];
  });

  // Add synthetic computed-sum chips (e.g. DWR Total)
  const computedTags = sites.flatMap(site =>
    (site.computedSensors || []).map(c => {
      const cpaths = c.sum.map(s => scadaSensorPath(site, s));
      return `~sum~${c.label}~${c.unit||''}~${cpaths.join(',')}`;
    })
  );

  const allTags = [...paths, ...computedTags];
  wrap.innerHTML = allTags.map(tag =>
    `<button class="scada-trend-chip${_scadaTrendTags.has(tag)?' selected':''}" data-trend-tag="${escHtml(tag)}">
      ${escHtml(scadaTagLabel(tag))}</button>`).join('');

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
      ${scadaRangeBtnsHtml(_scadaRuntimeRange)}
    </div>
    ${scadaCustomRangeHtml(_scadaRuntimeCustomStart, _scadaRuntimeCustomEnd, 'scada-runtime', _scadaRuntimeRange !== 'custom')}
    <div class="seg-group" id="scada-runtime-subtab" style="margin-bottom:8px">
      <button class="seg-btn${_scadaRuntimeSubTab==='runtime'?' active':''}" data-subtab="runtime">Pump Runtime</button>
      <button class="seg-btn${_scadaRuntimeSubTab==='reverse'?' active':''}" data-subtab="reverse">Reverse Flow</button>
    </div>
    <div id="scada-runtime-body"><div class="placeholder-msg">Loading…</div></div>`;

  wireScadaTabs();

  el('scada-runtime-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-runtime-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaRuntimeRange = b.dataset.range;
      localStorage.setItem('scadaRuntimeRange', _scadaRuntimeRange);
      el('scada-runtime-custom').classList.toggle('hidden', _scadaRuntimeRange !== 'custom');
      if (_scadaRuntimeRange !== 'custom') (_scadaRuntimeSubTab === 'reverse' ? loadScadaReverseFlow : loadScadaRuntime)();
    }));

  el('scada-runtime-apply').addEventListener('click', () => {
    _scadaRuntimeCustomStart = el('scada-runtime-from').value;
    _scadaRuntimeCustomEnd   = el('scada-runtime-to').value;
    localStorage.setItem('scadaRuntimeCustomStart', _scadaRuntimeCustomStart);
    localStorage.setItem('scadaRuntimeCustomEnd',   _scadaRuntimeCustomEnd);
    (_scadaRuntimeSubTab === 'reverse' ? loadScadaReverseFlow : loadScadaRuntime)();
  });

  el('scada-runtime-pills').querySelectorAll('[data-plant]').forEach(pill =>
    pill.addEventListener('click', () => {
      el('scada-runtime-pills').querySelectorAll('.scada-plant-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _scadaRuntimePlant = pill.dataset.plant;
      localStorage.setItem('scadaRuntimePlant', _scadaRuntimePlant);
      (_scadaRuntimeSubTab === 'reverse' ? loadScadaReverseFlow : loadScadaRuntime)();
    }));

  el('scada-runtime-subtab').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-runtime-subtab').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaRuntimeSubTab = b.dataset.subtab;
      localStorage.setItem('scadaRuntimeSubTab', _scadaRuntimeSubTab);
      (_scadaRuntimeSubTab === 'reverse' ? loadScadaReverseFlow : loadScadaRuntime)();
    }));

  (_scadaRuntimeSubTab === 'reverse' ? loadScadaReverseFlow : loadScadaRuntime)();
}

async function loadScadaRuntime() {
  const rBody = el('scada-runtime-body');
  if (!rBody) return;
  if (_scadaRuntimeChart) { _scadaRuntimeChart.destroy(); _scadaRuntimeChart = null; }
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

    const allPumps = sites.flatMap((site, si) =>
      site.pumps.map(p => ({ label: pumpLabel(site, p), hrs: results[si][p] ?? 0 }))
    );
    const cards = allPumps.map(({ label, hrs }) => {
      const pct = Math.min(100, (hrs / maxHrs) * 100).toFixed(1);
      return `<div class="scada-runtime-card">
          <div class="scada-runtime-head">
            <span class="scada-pump-label">Pump ${escHtml(label)}</span>
            <span class="scada-runtime-hrs">${hrs.toFixed(1)} h</span>
          </div>
          <div class="scada-runtime-bar-track"><div class="scada-runtime-bar" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');

    rBody.innerHTML = `<div class="scada-runtime-grid">${cards}</div>
      <div style="height:160px;margin-top:12px;position:relative"><canvas id="scada-runtime-chart"></canvas></div>`;
    drawRuntimeBarChart(document.getElementById('scada-runtime-chart'), allPumps, '#22c55e').catch(() => {});
  } catch (err) {
    rBody.innerHTML = `<div class="placeholder-msg">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

async function loadScadaReverseFlow() {
  const rBody = el('scada-runtime-body');
  if (!rBody) return;
  if (_scadaRuntimeChart) { _scadaRuntimeChart.destroy(); _scadaRuntimeChart = null; }
  rBody.innerHTML = '<div class="placeholder-msg">Loading…</div>';

  const g = scadaPlantGroups().find(x => x.key === _scadaRuntimePlant);
  if (!g) { rBody.innerHTML = '<div class="placeholder-msg">No data.</div>'; return; }

  // Reverse flow is an A-plant concept only — B plants never run in reverse.
  const sites = [g.a];
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
      sites.map(s => api('GET', `/api/scada/runtime-reverse?site=${encodeURIComponent(s.influxSite)}&${qs}`))
    );

    const allPumps = sites.flatMap((site, si) =>
      site.pumps.map(p => ({ label: pumpLabel(site, p), hrs: results[si][p] ?? 0 }))
    );
    const cards = allPumps.map(({ label, hrs }) => {
      const pct = Math.min(100, (hrs / maxHrs) * 100).toFixed(1);
      return `<div class="scada-runtime-card">
          <div class="scada-runtime-head">
            <span class="scada-pump-label">Pump ${escHtml(label)}</span>
            <span class="scada-runtime-hrs">${hrs.toFixed(1)} h</span>
          </div>
          <div class="scada-runtime-bar-track"><div class="scada-runtime-bar reverse" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');

    rBody.innerHTML = `<div class="scada-runtime-grid">${cards}</div>
      <div style="height:160px;margin-top:12px;position:relative"><canvas id="scada-runtime-chart"></canvas></div>`;
    drawRuntimeBarChart(document.getElementById('scada-runtime-chart'), allPumps, '#b45309').catch(() => {});
  } catch (err) {
    rBody.innerHTML = `<div class="placeholder-msg">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

function rangeHours(range) {
  if (typeof range === 'object' && range.start && range.end)
    return Math.max(1, (new Date(range.end) - new Date(range.start)) / 3600000);
  return { '1h': 1, '8h': 8, '12h': 12, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[range] || 24;
}

async function drawRuntimeBarChart(canvas, allPumps, barColor) {
  await loadScadaVendor();
  const c = scadaThemeColors();
  _scadaRuntimeChart = new window.Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: allPumps.map(x => x.label),
      datasets: [{
        data: allPumps.map(x => x.hrs),
        backgroundColor: barColor + '99',
        borderColor: barColor,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y.toFixed(1)} h` } },
      },
      scales: {
        x: { ticks: { color: c.dim, font: { size: 11 } }, grid: { color: c.grid } },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Hours', color: c.dim, font: { size: 11 } },
          ticks: { color: c.dim, font: { size: 11 } },
          grid: { color: c.grid },
        },
      },
    },
  });
}

/* ── Power monitoring tab ─────────────────────────────────────────────────────
 * Reads the `power_meters` bucket via /api/scada/power/*. One pill per metered
 * plant plus an "All Sites" comparison view. Live current values refresh every
 * 60s; charts redraw on each refresh. All field names / thresholds come from
 * _scadaConfig.power so the meter schema can change without touching this file.
 * ──────────────────────────────────────────────────────────────────────────── */
let _scadaPowerSite        = localStorage.getItem('scadaPowerSite') || 'all';
let _scadaPowerRange       = localStorage.getItem('scadaPowerRange') || '24h';
let _scadaPowerCustomStart = localStorage.getItem('scadaPowerCustomStart') || '';
let _scadaPowerCustomEnd   = localStorage.getItem('scadaPowerCustomEnd') || '';
let _scadaPowerCurrent     = {};       // { meterId: { field: { v, t } } }
let _scadaPowerCharts      = [];       // active Chart.js instances on this tab
let _scadaPowerTimer       = null;
const POWER_REFRESH_MS = 60000;

function stopScadaPower() {
  clearInterval(_scadaPowerTimer); _scadaPowerTimer = null;
  destroyPowerCharts();
}
function destroyPowerCharts() {
  _scadaPowerCharts.forEach(c => { try { c.destroy(); } catch { /* */ } });
  _scadaPowerCharts = [];
}

function powerCfg()       { return _scadaConfig.power; }
function powerSites()     { return powerCfg().sites || []; }
function powerThresholds(){ return powerCfg().thresholds || {}; }
function powerFieldMeta(f){ return powerCfg().fieldMeta?.[f] || { label: f, unit: '' }; }

// Latest value / freshest timestamp for a meter's field.
function pv(meterId, field) { const o = _scadaPowerCurrent[meterId]?.[field]; return o ? o.v : null; }
function powerAgeSec(meterId) {
  const m = _scadaPowerCurrent[meterId];
  if (!m) return null;
  let max = null;
  for (const k in m) if (m[k].t && (max == null || m[k].t > max)) max = m[k].t;
  return max == null ? null : Math.max(0, Math.round((Date.now() - max) / 1000));
}
function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 90) return sec + 's';
  if (sec < 5400) return Math.round(sec / 60) + 'm';
  return Math.round(sec / 3600) + 'h';
}
function fmtNum(v, dp = 1) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(dp); }

// (max-min)/|avg| as a percentage; null if fewer than two readings.
function imbalancePct(vals) {
  const xs = vals.filter(v => v != null && !isNaN(v));
  if (xs.length < 2) return null;
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!avg) return null;
  return (Math.max(...xs) - Math.min(...xs)) / Math.abs(avg) * 100;
}

// Worst-case status + human-readable issue list for one meter.
// Levels: 'na' (no data) < 'ok' < 'warn' < 'alarm'.
function evalPowerSite(meterId) {
  const th = powerThresholds(), f = k => pv(meterId, k);
  const age = powerAgeSec(meterId);
  if (age == null) return { level: 'na', issues: ['No data'], age: null };

  let level = 'ok';
  const order = { na: 0, ok: 1, warn: 2, alarm: 3 };
  const bump = l => { if (order[l] > order[level]) level = l; };
  const issues = [];

  if (age > (th.staleAlarmSec ?? 300))      { bump('alarm'); issues.push('Stale ' + fmtAge(age)); }
  else if (age > (th.staleWarnSec ?? 120))  { bump('warn');  issues.push('Stale ' + fmtAge(age)); }

  const pf = f('pf');
  if (pf != null && pf < (th.pfMin ?? 0.85)) { bump('warn'); issues.push('PF ' + pf.toFixed(2)); }

  const fr = f('freq_hz');
  if (fr != null && (fr < (th.freqMin ?? 59.95) || fr > (th.freqMax ?? 60.05))) {
    bump('alarm'); issues.push(fr.toFixed(2) + ' Hz');
  }

  // Use averages for voltage deviation — per-phase L-N can vary significantly
  // on medium-voltage systems and would produce false alarms if checked raw.
  const dev = th.voltageDeviationPct ?? 5;
  const nomLN = powerCfg().nominalVoltageLN, nomLL = powerCfg().nominalVoltageLL;
  const vnavg = f('vnavg_v'), viavg = f('viavg_v');
  if (nomLN && vnavg != null && Math.abs(vnavg - nomLN) / nomLN * 100 > dev)
    { bump('alarm'); issues.push('Avg L-N ' + vnavg.toFixed(0) + 'V'); }
  if (nomLL && viavg != null && Math.abs(viavg - nomLL) / nomLL * 100 > dev)
    { bump('alarm'); issues.push('Avg L-L ' + viavg.toFixed(0) + 'V'); }

  const vimb = imbalancePct([f('v1'), f('v2'), f('v3')]);
  if (vimb != null && vimb > (th.voltageImbalancePct ?? 2)) { bump('warn'); issues.push('V imbal ' + vimb.toFixed(1) + '%'); }
  const iimb = imbalancePct([f('i1'), f('i2'), f('i3')]);
  if (iimb != null && iimb > (th.currentImbalancePct ?? 10)) { bump('warn'); issues.push('I imbal ' + iimb.toFixed(1) + '%'); }

  for (const ph of ['p1','p2','p3']) {
    const v = f(ph);
    if (v != null && v < 0) { bump('alarm'); issues.push(ph.toUpperCase() + ' backfeed'); }
  }
  return { level, issues, age, vimb, iimb };
}

const POWER_LEVEL_DOT = { ok: 'scada-dot-ok', warn: 'scada-dot-idle', alarm: 'scada-dot-alarm', na: 'scada-dot-na' };

// ── Shell ──────────────────────────────────────────────────────────────────
function renderScadaPower() {
  _scadaView = 'power';
  destroyPowerCharts();
  const sites = powerSites();
  if (_scadaPowerSite !== 'all' && !sites.some(s => s.id === _scadaPowerSite)) _scadaPowerSite = 'all';

  const pills = `<button class="scada-plant-pill${_scadaPowerSite==='all'?' active':''}" data-power-site="all">All Sites</button>` +
    sites.map(s => `<button class="scada-plant-pill${s.id===_scadaPowerSite?' active':''}" data-power-site="${s.id}">${escHtml(s.name)}</button>`).join('');

  el('scada-body').innerHTML = scadaTabsHtml('power') + `
    <div class="scada-plant-pills" id="scada-power-pills">${pills}</div>
    <div class="seg-group" id="scada-power-range" style="margin-bottom:8px">
      ${scadaRangeBtnsHtml(_scadaPowerRange, SCADA_POWER_RANGES)}
    </div>
    ${scadaCustomRangeHtml(_scadaPowerCustomStart, _scadaPowerCustomEnd, 'scada-power', _scadaPowerRange !== 'custom')}
    <div id="scada-power-body"><div class="placeholder-msg">Loading…</div></div>`;

  wireScadaTabs();

  el('scada-power-pills').querySelectorAll('[data-power-site]').forEach(pill =>
    pill.addEventListener('click', () => {
      el('scada-power-pills').querySelectorAll('.scada-plant-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      _scadaPowerSite = pill.dataset.powerSite;
      localStorage.setItem('scadaPowerSite', _scadaPowerSite);
      loadScadaPower();
    }));

  el('scada-power-range').querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      el('scada-power-range').querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _scadaPowerRange = b.dataset.range;
      localStorage.setItem('scadaPowerRange', _scadaPowerRange);
      el('scada-power-custom').classList.toggle('hidden', _scadaPowerRange !== 'custom');
      if (_scadaPowerRange !== 'custom') loadScadaPower();
    }));

  el('scada-power-apply').addEventListener('click', () => {
    _scadaPowerCustomStart = el('scada-power-from').value;
    _scadaPowerCustomEnd   = el('scada-power-to').value;
    localStorage.setItem('scadaPowerCustomStart', _scadaPowerCustomStart);
    localStorage.setItem('scadaPowerCustomEnd',   _scadaPowerCustomEnd);
    loadScadaPower();
  });

  loadScadaPower();
  clearInterval(_scadaPowerTimer);
  _scadaPowerTimer = setInterval(loadScadaPower, POWER_REFRESH_MS);
}

// Resolve the active range to either a preset string or { start, end }, or null
// if a custom range is selected but not yet fully filled in.
function powerActiveRange() {
  if (_scadaPowerRange !== 'custom') return _scadaPowerRange;
  if (!_scadaPowerCustomStart || !_scadaPowerCustomEnd) return null;
  return { start: _scadaPowerCustomStart, end: _scadaPowerCustomEnd };
}

async function loadScadaPower() {
  if (_scadaView !== 'power') return;
  const body = el('scada-power-body');
  if (!body) return;
  try {
    _scadaPowerCurrent = await api('GET', '/api/scada/power/current');
  } catch (err) {
    destroyPowerCharts();
    body.innerHTML = `<div class="placeholder-msg">Power source unavailable.<br>
      <span style="font-size:.85rem">${escHtml(err.message || '')}</span></div>`;
    return;
  }
  if (_scadaView !== 'power') return;
  if (_scadaPowerSite === 'all') renderPowerAll();
  else renderPowerSite(powerSites().find(s => s.id === _scadaPowerSite));
}

// ── All Sites: comparison + per-site status ──────────────────────────────────
function renderPowerAll() {
  destroyPowerCharts();
  const sites = powerSites();
  const evals = sites.map(s => ({ site: s, ev: evalPowerSite(s.meterId) }));
  const worst = evals.reduce((acc, e) => {
    const order = { na: 0, ok: 1, warn: 2, alarm: 3 };
    return order[e.ev.level] > order[acc] ? e.ev.level : acc;
  }, 'ok');

  const grid = evals.map(({ site, ev }) => {
    const kw = pv(site.meterId, powerGroup('active')?.total || 'Psum_kW');
    const badges = ev.issues.slice(0, 3).map(i => `<span class="power-badge">${escHtml(i)}</span>`).join('');
    return `<button class="power-site-card power-lvl-${ev.level}" data-power-site="${site.id}">
      <div class="power-site-top">
        <span class="scada-dot ${POWER_LEVEL_DOT[ev.level]}"></span>
        <span class="power-site-name">${escHtml(site.name)}</span>
        <span class="power-site-kw">${fmtNum(kw, 0)}<small> kW</small></span>
      </div>
      <div class="power-site-badges">${badges || '<span class="power-badge ok">Normal</span>'}</div>
    </button>`;
  }).join('');

  el('scada-power-body').innerHTML = `
    ${powerSystemBanner(worst, evals.filter(e => e.ev.level === 'alarm' || e.ev.level === 'warn').length)}
    <div class="scada-section-hdr">Total Active Power by Site (kW)</div>
    <div class="scada-chart-wrap"><canvas id="power-compare-canvas" class="scada-chart-canvas"></canvas></div>
    <div class="scada-section-hdr">Site Status</div>
    <div class="power-site-grid">${grid}</div>`;

  el('scada-power-body').querySelectorAll('[data-power-site]').forEach(c =>
    c.addEventListener('click', () => {
      _scadaPowerSite = c.dataset.powerSite;
      localStorage.setItem('scadaPowerSite', _scadaPowerSite);
      renderScadaPower();
    }));

  drawPowerCompareChart();
}

function powerSystemBanner(level, count) {
  const label = level === 'alarm' ? 'ALARM' : level === 'warn' ? 'WARNING' : level === 'na' ? 'NO DATA' : 'ALL NORMAL';
  const sub = level === 'ok' ? 'No active alerts' :
    level === 'na' ? 'Awaiting meter data' : `${count} site${count === 1 ? '' : 's'} need attention`;
  return `<div class="power-banner power-lvl-${level}">
    <span class="scada-dot ${POWER_LEVEL_DOT[level]}"></span>
    <span class="power-banner-label">${label}</span>
    <span class="power-banner-sub">${escHtml(sub)}</span>
  </div>`;
}

async function drawPowerCompareChart() {
  const canvas = el('power-compare-canvas');
  if (!canvas) return;
  await loadScadaVendor();
  if (!el('power-compare-canvas')) return;
  const sites = powerSites();
  const totalField = powerGroup('active')?.total || 'psum_kw';
  const c = scadaThemeColors();
  const data = sites.map(s => pv(s.meterId, totalField) ?? 0);
  const colors = sites.map(s => evalPowerSite(s.meterId).level === 'alarm' ? '#e53935'
    : evalPowerSite(s.meterId).level === 'warn' ? '#d9a300' : SCADA_COLORS[0]);
  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: sites.map(s => s.name), datasets: [{ label: 'kW', data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
        tooltip: { backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1 } },
      scales: { x: { ticks: { color: c.dim }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: c.dim }, grid: { color: c.grid } } },
    },
  });
  _scadaPowerCharts.push(chart);
}

// ── Single site: diagnostics + stats + charts ────────────────────────────────
function powerGroup(key) { return (powerCfg().groups || []).find(g => g.key === key); }

async function renderPowerSite(site) {
  destroyPowerCharts();
  if (!site) { el('scada-power-body').innerHTML = '<div class="placeholder-msg">No data.</div>'; return; }
  const m = site.meterId;
  const ev = evalPowerSite(m);

  // Diagnostic cards
  const th = powerThresholds();
  const pf = pv(m, 'pf'), fr = pv(m, 'freq_hz');
  const vOut = ev.issues.some(i => /^Avg L/.test(i));
  const neg  = ['p1','p2','p3'].some(k => { const v = pv(m, k); return v != null && v < 0; });
  const diag = [
    powerDiagCard('Phase V Imbalance', ev.vimb == null ? '—' : ev.vimb.toFixed(1) + '%',
      ev.vimb != null && ev.vimb > (th.voltageImbalancePct ?? 2) ? 'warn' : 'ok'),
    powerDiagCard('Current Imbalance', ev.iimb == null ? '—' : ev.iimb.toFixed(1) + '%',
      ev.iimb != null && ev.iimb > (th.currentImbalancePct ?? 10) ? 'warn' : 'ok'),
    powerDiagCard('Power Factor', pf == null ? '—' : pf.toFixed(2),
      pf != null && pf < (th.pfMin ?? 0.85) ? 'warn' : 'ok'),
    powerDiagCard('Frequency', fr == null ? '—' : fr.toFixed(2) + ' Hz',
      fr != null && (fr < (th.freqMin ?? 59.95) || fr > (th.freqMax ?? 60.05)) ? 'alarm' : 'ok'),
    powerDiagCard('Voltage Range', vOut ? 'Out' : 'OK', vOut ? 'alarm' : 'ok'),
    powerDiagCard('Power Flow', neg ? 'Backfeed' : 'Forward', neg ? 'alarm' : 'ok'),
    powerDiagCard('Data', fmtAge(ev.age), ev.level === 'na' ? 'na'
      : ev.age > (th.staleAlarmSec ?? 300) ? 'alarm' : ev.age > (th.staleWarnSec ?? 120) ? 'warn' : 'ok'),
  ].join('');

  // Key stat tiles
  const stats = [
    powerStatTile('Total Active', fmtNum(pv(m, 'psum_kw'), 0), 'kW'),
    powerStatTile('Total Reactive', fmtNum(pv(m, 'qsum_kvar'), 0), 'kVAR'),
    powerStatTile('Total Apparent', fmtNum(pv(m, 'ssum_kva'), 0), 'kVA'),
    powerStatTile('Import Energy', fmtNum(pv(m, 'ep_imp_kwh'), 0), 'kWh', 'power-energy-delta'),
  ].join('');

  const lineGroups = (powerCfg().groups || []).filter(g => g.chart !== 'bar');
  const barGroups  = (powerCfg().groups || []).filter(g => g.chart === 'bar');
  const chartCards = [...lineGroups, ...barGroups].map(g =>
    `<div class="scada-section-hdr">${escHtml(g.label)}${g.unit ? ` (${escHtml(g.unit)})` : ''}</div>
     <div class="scada-chart-wrap"><canvas id="power-chart-${g.key}" class="scada-chart-canvas"></canvas></div>`
  ).join('');

  el('scada-power-body').innerHTML = `
    <div class="power-site-head">
      <span class="scada-dot ${POWER_LEVEL_DOT[ev.level]}"></span>
      <span class="power-site-headname">${escHtml(site.name)}</span>
      <span class="power-updated">Updated ${fmtAge(ev.age)} ago</span>
    </div>
    <div class="power-diag-grid">${diag}</div>
    <div class="scada-section-hdr">Live Readings</div>
    <div class="power-stat-grid">${stats}</div>
    ${chartCards}`;

  const range = powerActiveRange();
  if (range == null) {
    [...lineGroups, ...barGroups].forEach(g => {
      const cv = el('power-chart-' + g.key);
      if (cv) cv.closest('.scada-chart-wrap').innerHTML = '<div class="placeholder-msg">Set a custom range above, then tap Apply.</div>';
    });
    return;
  }
  lineGroups.forEach(g => drawPowerLineChart(el('power-chart-' + g.key), g, m, range));
  barGroups.forEach(g => drawPowerBarChart(el('power-chart-' + g.key), g, m));
  loadPowerEnergyDelta(m, range);
}

function powerDiagCard(label, value, level) {
  return `<div class="power-diag-card power-lvl-${level}">
    <div class="power-diag-label">${escHtml(label)}</div>
    <div class="power-diag-value">${escHtml(value)}</div>
  </div>`;
}
function powerStatTile(label, value, unit, id) {
  return `<div class="scada-sensor-tile">
    <div class="scada-sensor-label">${escHtml(label)}</div>
    <div class="scada-sensor-value"${id ? ` id="${id}"` : ''}>${escHtml(value)}</div>
    <div class="scada-sensor-unit">${escHtml(unit)}</div>
  </div>`;
}

// Import-energy delta over the selected range (last − first sample of EP_IMP_kWh).
async function loadPowerEnergyDelta(meterId, range) {
  try {
    const qs = scadaRangeQS(range);
    const r = await api('GET', `/api/scada/power/history?meter=${encodeURIComponent(meterId)}&fields=ep_imp_kwh&${qs}`);
    const pts = r.series?.EP_IMP_kWh || [];
    const elx = el('power-energy-delta');
    if (!elx || pts.length < 2) return;
    const delta = pts[pts.length - 1][1] - pts[0][1];
    elx.insertAdjacentHTML('afterend',
      `<div class="power-energy-sub">+${fmtNum(delta, 0)} kWh this range</div>`);
  } catch { /* non-critical */ }
}

async function drawPowerLineChart(canvas, group, meterId, range) {
  if (!canvas) return;
  try {
    await loadScadaVendor();
    if (!canvas.isConnected) return;
    const qs = scadaRangeQS(range);
    const r = await api('GET',
      `/api/scada/power/history?meter=${encodeURIComponent(meterId)}&fields=${encodeURIComponent(group.members.join(','))}&${qs}`);
    if (!canvas.isConnected) return;
    const series = r.series || {};
    const c = scadaThemeColors();
    const single = group.members.length === 1;
    const datasets = group.members.map((f, i) => {
      const color = SCADA_COLORS[i % SCADA_COLORS.length];
      const isTotal = f === group.total;
      return {
        label: powerFieldMeta(f).label,
        data: (series[f] || []).map(([t, v]) => ({ x: t, y: v })),
        borderColor: color,
        backgroundColor: single ? scadaGradientFill(color) : color + '22',
        borderWidth: isTotal ? 2.4 : 1.6, pointRadius: 0, tension: 0.25, fill: single,
      };
    });
    const yScale = { ticks: { color: c.dim }, grid: { color: c.grid } };
    if (group.yMin != null) yScale.min = group.yMin;
    if (group.yMax != null) yScale.max = group.yMax;
    const chart = new window.Chart(canvas.getContext('2d'), {
      type: 'line', data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: !single, labels: { color: c.text, boxWidth: 12, usePointStyle: true } },
          tooltip: { backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1 },
        },
        scales: {
          x: { type: 'time', time: { tooltipFormat: 'MMM d, h:mm a' },
               ticks: { color: c.dim, maxTicksLimit: 7, autoSkip: true }, grid: { color: c.grid } },
          y: yScale,
        },
      },
    });
    _scadaPowerCharts.push(chart);
  } catch (err) {
    if (canvas.isConnected) canvas.closest('.scada-chart-wrap').innerHTML =
      `<div class="placeholder-msg">Failed to load.</div>`;
  }
}

// Demand is shown as a snapshot bar chart of current register values.
async function drawPowerBarChart(canvas, group, meterId) {
  if (!canvas) return;
  await loadScadaVendor();
  if (!canvas.isConnected) return;
  const c = scadaThemeColors();
  const labels = group.members.map(f => powerFieldMeta(f).label || f);
  const data = group.members.map(f => pv(meterId, f) ?? 0);
  const colors = group.members.map((_, i) => SCADA_COLORS[i % SCADA_COLORS.length]);
  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
        tooltip: { backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1,
          callbacks: { label: ctx => `${ctx.parsed.y} ${powerFieldMeta(group.members[ctx.dataIndex]).unit || ''}` } } },
      scales: { x: { ticks: { color: c.dim }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: c.dim }, grid: { color: c.grid } } },
    },
  });
  _scadaPowerCharts.push(chart);
}
