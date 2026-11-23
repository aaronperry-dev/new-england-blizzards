/* New England Blizzard Atlas - static front end (no build step). */
(() => {
'use strict';

/* ================================================================== helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const MPH_PER_KT = 1.15078;
const NY = 'America/New_York';
const localFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: 'short', day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'numeric' });
const toDate = (iso) => new Date(iso.length === 16 ? iso + ':00Z' : iso);
const local = (iso) => (iso ? localFmt.format(toDate(iso)) : '–');
const localDate = (iso) => (iso ? dateFmt.format(toDate(iso)) : '–');
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const hoverCapable = matchMedia('(hover: hover)').matches;
const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

async function getJSON(name) {
  const r = await fetch(`data/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

/* ================================================================== winter colour ramps (light -> dark, monotonic lightness) */
const RAMPS = {
  ice:    ['#dcecfb', '#b4d6f6', '#86b8f0', '#5a95e8', '#3b6fd6', '#3a48bd', '#2a2b8c'],     // pale ice blue -> indigo
  orchid: ['#fde7f3', '#f9c6e0', '#f19ccb', '#e070b3', '#c24697', '#8f2a84', '#561761'],     // blush pink -> plum
  aurora: ['#e6f1ff', '#b9d5f7', '#99b5f1', '#a38fe6', '#d46fc4', '#a33c9c', '#5e1f73'],     // blue -> violet -> pink -> purple
};
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const LUT = {};
for (const [name, stops] of Object.entries(RAMPS)) {
  const rgb = stops.map(hex2rgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (rgb.length - 1), k = Math.min(rgb.length - 2, Math.floor(p)), f = p - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
  }
  LUT[name] = lut;
}
const rampGradient = (name) => `linear-gradient(90deg, ${RAMPS[name].join(',')})`;
const rampAt = (name, t) => { const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3; const l = LUT[name]; return `rgb(${l[i]},${l[i + 1]},${l[i + 2]})`; };
const niceCeil = (v) => { if (!(v > 0)) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e; };

/* ================================================================== state */
const S = { meta: null, stations: [], stById: {}, events: [], warnings: [], zones: null, grids: null, seasons: [], from: 0, to: 0, db: null, dbPromise: null, grid: 'obs_events' };
let map = null;

const seasonIdx = (label) => S.seasons.indexOf(label);
const inRange = (label) => { const i = seasonIdx(label); return i >= S.from && i <= S.to; };
const rangeLabel = () => (S.from === S.to ? S.seasons[S.from] : `${S.seasons[S.from]} – ${S.seasons[S.to]}`);

/* ================================================================== boot */
async function boot() {
  try {
    const [meta, stations, events, warnings, zones, grids] = await Promise.all(
      ['meta.json', 'stations.json', 'events.json', 'warnings.json', 'warning_zones.geojson', 'grids.json'].map(getJSON));
    Object.assign(S, { meta, stations, events, warnings, zones, grids });
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div class="page"><div class="card"><h3>Data not found</h3><p>${esc(e.message)}. Run <code>python -m pipeline.build</code> (or the “Build data” GitHub Action) to generate <code>site/data/</code>.</p></div></div>`);
    return;
  }
  S.stations.forEach((s) => (S.stById[s.id] = s));
  const first = +S.meta.window.first_season.slice(0, 4), last = +S.meta.window.last_season.slice(0, 4);
  for (let y = first; y <= last; y++) S.seasons.push(`${y}-${String(y + 1).slice(-2)}`);
  S.to = S.seasons.length - 1;
  initHeader();
  initTabs();
  initMap();
  initDashboard();
  initExplorer();
  initAbout();
  applyHash();
  window.__atlas = { S, get map() { return map; } };
}

/* ================================================================== header / tabs */
function initHeader() {
  const inProg = S.meta.window.in_progress_season;
  const opts = S.seasons.map((s, i) => `<option value="${i}">${s}${s === inProg ? ' (in progress)' : ''}</option>`).join('');
  $('#seasonFrom').innerHTML = opts; $('#seasonTo').innerHTML = opts;
  $('#seasonFrom').value = S.from; $('#seasonTo').value = S.to;
  const onChange = () => {
    let a = +$('#seasonFrom').value, b = +$('#seasonTo').value;
    if (a > b) { if (document.activeElement.id === 'seasonFrom') b = a; else a = b; }
    S.from = a; S.to = b; $('#seasonFrom').value = a; $('#seasonTo').value = b;
    refreshMapLayers(); renderDashboard();
  };
  $('#seasonFrom').onchange = onChange; $('#seasonTo').onchange = onChange;
}

function showView(v) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === `view-${v}`));
  $('#globalRange').style.visibility = v === 'map' || v === 'dash' ? 'visible' : 'hidden';
  if (v === 'map' && map) setTimeout(() => map.resize(), 0);
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
}
function initTabs() { $$('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view))); }
function applyHash() { const v = location.hash.slice(1); if (['map', 'dash', 'explore', 'about'].includes(v)) showView(v); else showView('map'); }

/* ================================================================== MAP */
const BASES = {
  light: { tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`), attr: '© OpenStreetMap contributors © CARTO', dark: false },
  dark: { tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`), attr: '© OpenStreetMap contributors © CARTO', dark: true },
  osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attr: '© OpenStreetMap contributors', dark: false },
};
const THEME = {
  light: { bg: '#cfdcec', land: '#f4f6fa', line: '#8d9ab5', county: '#b3bdd1' },
  dark: { bg: '#0b1120', land: '#18203a', line: '#56648a', county: '#2c3659' },
};

function stationsGeoJSON() {
  const cnt = {};
  for (const e of S.events) if (inRange(e.season)) cnt[e.station] = (cnt[e.station] || 0) + 1;
  return { type: 'FeatureCollection', features: S.stations.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, n: cnt[s.id] || 0, usable: s.valid_seasons > 0 ? 1 : 0 } })) };
}
function zoneCounts() {
  const c = {};
  for (const w of S.warnings) if (inRange(w.season)) for (const u of w.ugcs) c[u] = (c[u] || 0) + 1;
  return c;
}
function zonesGeoJSON() {
  const c = zoneCounts();
  return { type: 'FeatureCollection', features: S.zones.features.map((f) => ({ ...f, properties: { ...f.properties, n: c[f.properties.ugc] || 0 } })) };
}

function initMap() {
  const th = prefersDark() ? THEME.dark : THEME.light;
  map = new maplibregl.Map({
    container: 'map', hash: false, attributionControl: { compact: true },
    bounds: [[-73.9, 40.9], [-66.6, 47.6]], fitBoundsOptions: { padding: matchMedia('(max-width: 760px)').matches ? 16 : { top: 24, bottom: 24, right: 24, left: 340 } }, maxZoom: 11, minZoom: 3.2,
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': th.bg } }] },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
  map.dragRotate.disable(); map.touchZoomRotate.disableRotation();

  map.on('load', async () => {
    const [states, counties] = await Promise.all([getJSON('basemap_states.geojson'), getJSON('basemap_counties.geojson')]);
    map.addSource('states', { type: 'geojson', data: states });
    map.addSource('counties', { type: 'geojson', data: counties });
    map.addSource('base', { type: 'raster', tiles: BASES.light.tiles, tileSize: 256, attribution: BASES.light.attr, maxzoom: 18 });
    map.addSource('grid', { type: 'image', url: gridImageUrl(S.grid) || blankPng(), coordinates: gridCoords() });
    map.addSource('zones', { type: 'geojson', data: zonesGeoJSON() });
    map.addSource('stations', { type: 'geojson', data: stationsGeoJSON() });

    map.addLayer({ id: 'states-fill', type: 'fill', source: 'states', paint: { 'fill-color': th.land } });
    map.addLayer({ id: 'base', type: 'raster', source: 'base', layout: { visibility: 'visible' }, paint: { 'raster-opacity': 1 } });
    map.addLayer({ id: 'grid', type: 'raster', source: 'grid', paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', layout: { visibility: 'none' }, paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'n'], 0, 'rgba(255,255,255,0)', 1, '#f9c6e0', 2, '#f19ccb', 3, '#e070b3', 5, '#c24697', 8, '#8f2a84', 12, '#561761'], 'fill-opacity': 0.72 } });
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', layout: { visibility: 'none' }, paint: { 'line-color': '#8f2a84', 'line-width': 0.6, 'line-opacity': 0.7 } });
    map.addLayer({ id: 'counties-line', type: 'line', source: 'counties', layout: { visibility: 'none' }, paint: { 'line-color': th.county, 'line-width': 0.6 } });
    map.addLayer({ id: 'states-line', type: 'line', source: 'states', paint: { 'line-color': th.line, 'line-width': 1 } });
    map.addLayer({ id: 'stations-none', type: 'circle', source: 'stations', filter: ['all', ['==', ['get', 'n'], 0], ['==', ['get', 'usable'], 1]], layout: { visibility: 'none' },
      paint: { 'circle-radius': 3, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#6b7694', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'stations-ev', type: 'circle', source: 'stations', filter: ['>', ['get', 'n'], 0], paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'n'], 1, 5, 5, 8, 20, 12, 60, 18, 150, 24],
      'circle-color': ['interpolate', ['linear'], ['get', 'n'], 1, '#9db7f1', 4, '#a38fe6', 12, '#d46fc4', 30, '#a33c9c', 80, '#5e1f73'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': 0.92 } });

    initPanel();
    renderGridLayer(true);
    map.on('mousemove', onMove); map.on('click', onClick);
    map.on('mouseleave', () => (hoverCapable ? hideTip() : null));
    for (const l of ['stations-ev', 'stations-none', 'zones-fill']) {
      map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
    }
  });
}

const blankPng = () => 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const gridCoords = () => { const [w, s, e, n] = S.grids.bounds; return [[w, n], [e, n], [e, s], [w, s]]; };

function initPanel() {
  const P = S.grids.products;
  const groups = { observed: [], warned: [] };
  Object.entries(P).forEach(([k, p]) => groups[p.kind].push(`<option value="${k}">${esc(p.label)}</option>`));
  $('#gridSel').innerHTML = `<option value="">None</option><optgroup label="Observed (stations → grid)">${groups.observed.join('')}</optgroup><optgroup label="NWS Blizzard Warnings (zones → grid)">${groups.warned.join('')}</optgroup>`;
  $('#gridSel').value = S.grid;
  $('#gridSel').onchange = () => { S.grid = $('#gridSel').value; renderGridLayer(); };
  $('#gridOpacity').oninput = () => map.setPaintProperty('grid', 'raster-opacity', $('#gridOpacity').value / 100);
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  $('#lyStations').onchange = (e) => vis('stations-ev', e.target.checked);
  $('#lyAllStations').onchange = (e) => vis('stations-none', e.target.checked);
  $('#lyZones').onchange = (e) => { vis('zones-fill', e.target.checked); vis('zones-line', e.target.checked); };
  $('#lyCounties').onchange = (e) => vis('counties-line', e.target.checked);
  $('#baseSel').onchange = (e) => setBase(e.target.value);
  const tgl = $('#panelToggle');
  tgl.onclick = () => { const h = $('#panel').classList.toggle('hidden'); tgl.setAttribute('aria-expanded', String(!h)); };
  if (matchMedia('(max-width: 760px)').matches) { $('#panel').classList.add('hidden'); tgl.setAttribute('aria-expanded', 'false'); }
  if (prefersDark()) { $('#baseSel').value = 'dark'; setBase('dark'); }
}

function setBase(name) {
  const th = name === 'dark' || (name === 'none' && prefersDark()) ? THEME.dark : THEME.light;
  map.setPaintProperty('bg', 'background-color', th.bg);
  map.setPaintProperty('states-fill', 'fill-color', th.land);
  map.setPaintProperty('states-line', 'line-color', th.line);
  map.setPaintProperty('counties-line', 'line-color', th.county);
  if (name === 'none') { map.setLayoutProperty('base', 'visibility', 'none'); return; }
  const b = BASES[name];
  if (map.getSource('base').tiles !== b.tiles) map.getSource('base').setTiles(b.tiles);
  map.setLayoutProperty('base', 'visibility', 'visible');
}

function refreshMapLayers() {
  if (!map || !map.getSource('stations')) return;
  map.getSource('stations').setData(stationsGeoJSON());
  map.getSource('zones').setData(zonesGeoJSON());
}

/* ---------- gridded product raster ---------- */
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);
const domainCache = {};
function domainOf(key) {
  if (domainCache[key]) return domainCache[key];
  const d = S.grids.products[key].data; let mx = 0;
  for (const v of d) if (v != null && v > mx) mx = v;
  return (domainCache[key] = niceCeil(mx * 1.0001));
}

function gridImageUrl(key) {
  if (!key) return null;
  const G = S.grids, P = G.products[key], { nx, ny } = G, [, s, , n] = G.bounds;
  const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(nx, ny);
  const dom = domainOf(key), lut = LUT[P.ramp];
  const y0 = mercY(n), y1 = mercY(s);
  for (let r = 0; r < ny; r++) {
    const lat = invMercY(y0 + ((r + 0.5) / ny) * (y1 - y0));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((n - lat) / G.step)));
    for (let i = 0; i < nx; i++) {
      const v = P.data[j * nx + i], o = (r * nx + i) * 4;
      if (v == null) { img.data[o + 3] = 0; continue; }
      const t = Math.max(0, Math.min(1, v / dom)), li = Math.round(t * 255) * 3;
      img.data[o] = lut[li]; img.data[o + 1] = lut[li + 1]; img.data[o + 2] = lut[li + 2];
      img.data[o + 3] = v === 0 ? 70 : 255;   // zero = faint, so "no events" still reads as covered
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

function renderGridLayer(initial = false) {
  const key = S.grid, G = S.grids, P = key && G.products[key];
  if (!key) { map.setLayoutProperty('grid', 'visibility', 'none'); $('#legend').innerHTML = ''; $('#gridNote').textContent = ''; return; }
  map.setLayoutProperty('grid', 'visibility', 'visible');
  const dom = domainOf(key);
  map.setPaintProperty('grid', 'raster-resampling', P.kind === 'warned' ? 'nearest' : 'linear');
  if (!initial) {
    try { Promise.resolve(map.getSource('grid').updateImage({ url: gridImageUrl(key), coordinates: gridCoords() })).catch(() => {}); } catch (_) { /* superseded load */ }
  }
  const unit = P.unit, ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => fmt(f * dom, dom < 2 ? 2 : dom < 10 ? 1 : 0));
  $('#legend').innerHTML = `<div class="ttl">${esc(P.label)} <span class="muted">(${esc(unit)})</span></div><div class="bar" style="background:${rampGradient(P.ramp)}"></div><div class="ticks">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>`;
  const climo = G.climo_seasons;
  $('#gridNote').textContent = (P.kind === 'observed'
    ? `Smoothed from station records (Gaussian, σ ${G.kernel.sigma_km} km); blank where no usable station lies within ~45 km. `
    : 'Direct count of NWS Blizzard Warning zones covering each 5 km cell. ')
    + `Grids always summarize the ${climo.length} completed winters ${climo[0]} – ${climo[climo.length - 1]}.`;
}

/* ---------- cursor tooltip ---------- */
const tip = () => $('#gridTip');
function hideTip() { tip().hidden = true; }
function cellAt(lngLat) {
  const G = S.grids, [w, , , n] = G.bounds;
  const i = Math.floor((lngLat.lng - w) / G.step), j = Math.floor((n - lngLat.lat) / G.step);
  if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return null;
  return { i, j, idx: j * G.nx + i };
}
function showTip(point, lngLat) {
  const c = cellAt(lngLat);
  if (!c) return hideTip();
  const G = S.grids, P = G.products, nearIdx = G.nearest.idx[c.idx];
  if (nearIdx < 0 && P.obs_events.data[c.idx] == null && P.warn_events.data[c.idx] == null) return hideTip();
  const SHORT = { obs_events: 'Blizzard events', obs_prob: 'Chance of ≥1 blizzard', obs_hours: 'Blizzard hours', warn_events: 'Blizzard Warnings', warn_prob: 'Chance of ≥1 warning' };
  const UNIT = { 'events / winter': 'per winter', 'hours / winter': 'h per winter', 'warnings / winter': 'per winter', '% of winters': 'of winters' };
  let last = '';
  const rows = Object.entries(P).map(([k, p]) => {
    const v = p.data[c.idx];
    const num = v == null ? '<span class="muted">no data</span>' : `${fmt(v, p.unit.startsWith('%') ? 0 : p.unit.startsWith('hours') ? 1 : 2)}${p.unit.startsWith('%') ? '%' : ''} <span class="muted u">${esc(UNIT[p.unit] || p.unit)}</span>`;
    const sw = v == null ? 'transparent' : rampAt(p.ramp, Math.min(1, v / domainOf(k)));
    const head = p.kind !== last ? `<tr class="grp"><td colspan="2">${p.kind === 'observed' ? 'Observed at stations (10 winters)' : 'NWS Blizzard Warnings (10 winters)'}</td></tr>` : '';
    last = p.kind;
    return `${head}<tr class="${k === S.grid ? 'sel' : ''}"><td><span class="sw" style="background:${sw}"></span>${esc(SHORT[k] || p.label)}</td><td>${num}</td></tr>`;
  }).join('');
  const st = nearIdx >= 0 ? S.stById[G.station_ids[nearIdx]] : null;
  const km = G.nearest.km[c.idx];
  const conf = G.conf[c.idx];
  const support = conf == null ? '' : conf >= 1.5 ? 'strong' : conf >= 0.6 ? 'moderate' : conf >= G.kernel.min_conf ? 'weak' : 'none';
  tip().innerHTML = `<h4>${lngLat.lat.toFixed(2)}°N, ${Math.abs(lngLat.lng).toFixed(2)}°W</h4><table>${rows}</table>`
    + `<div class="foot">${st ? `Nearest station: <b>${esc(st.id)}</b> ${esc(st.name)}, ${esc(st.state)} · ${fmt(km)} km` : ''}${support ? `<br>Station support for observed fields: ${support}` : ''}</div>`;
  tip().hidden = false;
  const box = $('#view-map').getBoundingClientRect(), tw = tip().offsetWidth, th = tip().offsetHeight;
  let x = point.x + 16, y = point.y + 16;
  if (x + tw > box.width - 8) x = point.x - tw - 16;
  if (y + th > box.height - 8) y = point.y - th - 16;
  tip().style.left = `${Math.max(8, x)}px`; tip().style.top = `${Math.max(8, y)}px`;
}
function onMove(e) {
  if (!hoverCapable) return;
  const hit = map.queryRenderedFeatures(e.point, { layers: ['stations-ev', 'stations-none'] });
  if (hit.length) return hideTip();
  showTip(e.point, e.lngLat);
}
let popup = null;
function onClick(e) {
  const feats = map.queryRenderedFeatures(e.point, { layers: ['stations-ev', 'stations-none'] });
  if (feats.length) { hideTip(); return stationPopup(feats[0].properties.id, e.lngLat); }
  if (map.getLayoutProperty('zones-fill', 'visibility') === 'visible') {
    const z = map.queryRenderedFeatures(e.point, { layers: ['zones-fill'] });
    if (z.length) { hideTip(); return zonePopup(z.map((f) => f.properties.ugc), e.lngLat); }
  }
  if (!hoverCapable) showTip(e.point, e.lngLat);
}
function openPopup(lngLat, html) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '330px', offset: 10 }).setLngLat(lngLat).setHTML(html).addTo(map);
}
function stationPopup(id, lngLat) {
  const s = S.stById[id], evs = S.events.filter((e) => e.station === id && inRange(e.season));
  const li = evs.slice().sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 25).map((e) =>
    `<li><a data-ev="${e.id}">${esc(localDate(e.start))}</a> · ${e.hours} h · gust/wind ${fmt(e.peak_wind_mph)} mph · min vis ${e.min_vis_mi} mi ${e.warned ? '<span class="badge warn">warned</span>' : ''}${e.confirmed ? '' : ' <span class="badge" title="No present-weather sensor; snow inferred from temperature">inferred</span>'}</li>`).join('');
  openPopup(lngLat, `<div class="pop"><h3>${esc(s.id)} · ${esc(s.name)}</h3><div class="sub">${esc(s.state)} · ${esc(s.county || '')} · ${s.type} · ${s.valid_seasons} usable winters${s.vis_capable ? '' : ' · no visibility sensor'}</div>
    <b>${evs.length}</b> verified event${evs.length === 1 ? '' : 's'} in ${esc(rangeLabel())}${s.events_per_season != null ? ` <span class="muted">(${fmt(s.events_per_season, 2)} / winter, ${fmt(s.season_prob * 100)}% of winters)</span>` : ''}
    <ul>${li || '<li class="muted">No verified blizzard conditions in this range.</li>'}</ul></div>`);
}
function zonePopup(ugcs, lngLat) {
  const set = new Set(ugcs), ws = S.warnings.filter((w) => inRange(w.season) && w.ugcs.some((u) => set.has(u))).sort((a, b) => (a.start < b.start ? 1 : -1));
  const li = ws.map((w) => `<li>${esc(localDate(w.start))} → ${esc(localDate(w.end))} · NWS ${esc(w.wfo)} · ${w.stations_verified}/${w.stations_in_area} stations verified · <a href="${esc(w.iem_url)}" target="_blank" rel="noopener">IEM</a></li>`).join('');
  openPopup(lngLat, `<div class="pop"><h3>${esc([...set].join(', '))}</h3><div class="sub">Zone${set.size > 1 ? 's' : ''} · Blizzard Warnings in ${esc(rangeLabel())}: <b>${ws.length}</b></div><ul>${li || '<li class="muted">None in this range.</li>'}</ul></div>`);
}
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-ev]');
  if (a) { ev.preventDefault(); openEvent(+a.dataset.ev); }
});

/* ================================================================== DASHBOARD */
function initDashboard() {
  const states = [...new Set(S.stations.map((s) => s.state))].sort();
  $('#dState').insertAdjacentHTML('beforeend', states.map((s) => `<option>${s}</option>`).join(''));
  $('#evState').insertAdjacentHTML('beforeend', states.map((s) => `<option>${s}</option>`).join(''));
  $('#dState').onchange = renderDashboard; $('#dType').onchange = renderDashboard;
  renderDashboard();
}

const chartTip = (() => {
  let d = null;
  return {
    show(html, ev) { if (!d) { d = document.createElement('div'); d.className = 'ctip'; document.body.appendChild(d); } d.innerHTML = html; d.style.display = 'block'; this.move(ev); },
    move(ev) { if (d) { d.style.left = `${Math.min(innerWidth - d.offsetWidth - 8, ev.clientX + 12)}px`; d.style.top = `${ev.clientY + 14}px`; } },
    hide() { if (d) d.style.display = 'none'; },
  };
})();

/** Vertical bar chart. items: [{label, value, tip}] ; one series, one colour. */
function barChart(host, items, { color, yTitle = '', height = 230 }) {
  const W = 560, H = height, m = { l: 36, r: 8, t: 10, b: 30 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const raw = Math.max(1, ...items.map((i) => i.value));
  const step = raw <= 5 ? 1 : niceCeil(raw / 4), max = Math.ceil(raw / step) * step;
  const bw = iw / items.length, bar = Math.min(34, bw * 0.62);
  const ticks = []; for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  let g = ticks.map((t) => { const y = m.t + ih - (t / max) * ih; return `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/><text x="${m.l - 6}" y="${y + 3.5}" text-anchor="end">${fmt(t)}</text>`; }).join('');
  const skip = Math.ceil(items.length / 11);
  items.forEach((it, i) => {
    const x = m.l + i * bw + (bw - bar) / 2, h = (it.value / max) * ih, y = m.t + ih - h;
    const bottom = m.t + ih, r = Math.min(4, h / 2);
    g += `<g class="b" data-i="${i}"><rect class="hit" x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ih}"/>${it.value > 0 ? `<path class="bar" d="M${x},${bottom} V${y + r} a${r},${r} 0 0 1 ${r},-${r} h${bar - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${bottom} Z" fill="${color}"/>` : ''}</g>`;
    if (i % skip === 0) g += `<text x="${m.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  host.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yTitle)} bar chart">${g}</svg></div>
    <details><summary class="muted">View as table</summary><div class="tablewrap"><table><tbody>${items.map((i) => `<tr><td>${esc(i.label)}</td><td class="num">${fmt(i.value)}</td></tr>`).join('')}</tbody></table></div></details>`;
  $$('g.b', host).forEach((n) => {
    const it = items[+n.dataset.i];
    n.onmousemove = (e) => chartTip.show(it.tip || `${esc(it.label)}: <b>${fmt(it.value)}</b>`, e);
    n.onmouseleave = () => chartTip.hide();
  });
}

/** Horizontal bar chart for rankings. */
function hbarChart(host, items, { color }) {
  const W = 560, rowH = 24, m = { l: 150, r: 40, t: 4, b: 4 }, H = m.t + m.b + rowH * items.length, iw = W - m.l - m.r;
  const max = Math.max(1, ...items.map((i) => i.value));
  const g = items.map((it, i) => {
    const y = m.t + i * rowH, w = (it.value / max) * iw;
    return `<g class="b" data-i="${i}"><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/><text x="${m.l - 8}" y="${y + 16}" text-anchor="end">${esc(it.label)}</text><path class="bar" d="M${m.l},${y + 4} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${rowH - 16} a4,4 0 0 1 -4,4 h-${Math.max(0, w - 4)} Z" fill="${color}"/><text x="${m.l + w + 6}" y="${y + 16}">${fmt(it.value)}</text></g>`;
  }).join('');
  host.innerHTML = items.length ? `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ranking of stations by verified blizzard events">${g}</svg></div>` : '<div class="muted">No verified events for this selection.</div>';
  $$('g.b', host).forEach((n) => {
    const it = items[+n.dataset.i];
    n.onmousemove = (e) => chartTip.show(it.tip, e); n.onmouseleave = () => chartTip.hide();
  });
}

function dashFilters() {
  const st = $('#dState').value, ty = $('#dType').value;
  const okStation = (id) => { const s = S.stById[id]; return s && (!st || s.state === st) && (!ty || s.type === ty); };
  return { st, ty, okStation };
}

function renderDashboard() {
  if (!S.seasons.length) return;
  const { st, okStation } = dashFilters();
  $('#dScope').textContent = `Winters ${rangeLabel()}`;
  const evs = S.events.filter((e) => inRange(e.season) && okStation(e.station));
  const wars = S.warnings.filter((w) => inRange(w.season) && (!st || w.ugcs.some((u) => u.startsWith(st))));
  const storms = new Set(evs.map((e) => e.storm)).size;
  const hours = evs.reduce((a, e) => a + e.hours, 0);
  const warned = evs.filter((e) => e.warned).length;
  const top = evs.slice().sort((a, b) => b.peak_wind_mph - a.peak_wind_mph)[0];
  const verifiedW = wars.filter((w) => w.stations_verified > 0).length;
  $('#kpis').innerHTML = [
    [fmt(evs.length), 'verified station-events'], [fmt(storms), 'regional blizzard storms'], [fmt(hours), 'station-hours of blizzard conditions'],
    [fmt(wars.length), 'Blizzard Warnings issued'],
    [evs.length ? `${fmt((warned / evs.length) * 100)}%` : '–', 'of station-events were under a warning'],
    [wars.length ? `${fmt((verifiedW / wars.length) * 100)}%` : '–', 'of warnings verified at ≥1 station'],
    [top ? `${fmt(top.peak_wind_mph)} mph` : '–', top ? `peak wind: ${top.station}, ${localDate(top.start)}` : 'peak wind'],
  ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${esc(s)}</span></div>`).join('');

  const seasons = S.seasons.slice(S.from, S.to + 1);
  barChart($('#chSeason'), seasons.map((s) => { const v = evs.filter((e) => e.season === s).length, sm = new Set(evs.filter((e) => e.season === s).map((e) => e.storm)).size; return { label: s.slice(2), value: v, tip: `<b>${s}</b><br>${v} station-events · ${sm} storms` }; }), { color: '#3b6fd6', yTitle: 'Station-events per winter' });
  barChart($('#chWarn'), seasons.map((s) => { const v = wars.filter((w) => w.season === s).length; return { label: s.slice(2), value: v, tip: `<b>${s}</b><br>${v} Blizzard Warning${v === 1 ? '' : 's'}` }; }), { color: '#c24697', yTitle: 'Blizzard Warnings per winter' });
  const months = [[10, 'Oct'], [11, 'Nov'], [12, 'Dec'], [1, 'Jan'], [2, 'Feb'], [3, 'Mar'], [4, 'Apr'], [5, 'May']];
  barChart($('#chMonth'), months.map(([m, name]) => { const v = evs.filter((e) => +monthFmt.format(toDate(e.start)) === m).length; return { label: name, value: v, tip: `<b>${name}</b><br>${v} station-events` }; }), { color: '#a38fe6', yTitle: 'Station-events by month' });
  const cnt = {};
  evs.forEach((e) => (cnt[e.station] = (cnt[e.station] || 0) + 1));
  const rank = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, v]) => { const s = S.stById[id]; return { label: `${id} ${s.name}`.slice(0, 24), value: v, tip: `<b>${esc(s.name)}, ${esc(s.state)}</b> (${id})<br>${v} events · ${fmt(evs.filter((e) => e.station === id).reduce((a, e) => a + e.hours, 0))} h` }; });
  hbarChart($('#chStation'), rank, { color: '#a33c9c' });

  const rows = wars.slice().sort((a, b) => (a.start < b.start ? 1 : -1));
  $('#warnTable').innerHTML = `<thead><tr><th>Warning start (local)</th><th>Ends</th><th>NWS office</th><th>Ended by</th><th>Zones</th><th>Stations in area</th><th>Verified</th><th></th></tr></thead><tbody>${rows.map((w) =>
    `<tr><td>${esc(local(w.start))}</td><td>${esc(local(w.end))}</td><td>${esc(w.wfo)}</td><td>${esc(w.ended_by)}</td><td class="num">${w.ugcs.length}</td><td class="num">${w.stations_in_area}</td><td class="num">${w.stations_in_area ? `${w.stations_verified} ${w.stations_verified ? '<span class="badge ok">✓</span>' : '<span class="badge">none</span>'}` : '–'}</td><td><a href="${esc(w.iem_url)}" target="_blank" rel="noopener">IEM ↗</a></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No warnings in this selection.</td></tr>'}</tbody>`;
}

/* ================================================================== EXPLORER */
const EV = { sort: 'start', dir: -1, page: 0, per: 25, rows: [] };
const evCols = [
  ['start', 'Start (local)', (e) => esc(local(e.start))], ['station', 'Station', (e) => `<b>${esc(e.station)}</b> ${esc(S.stById[e.station]?.name || '')}`],
  ['state', 'St', (e) => esc(S.stById[e.station]?.state || '')], ['type', 'Type', (e) => esc(S.stById[e.station]?.type || '')],
  ['hours', 'Hours', (e) => e.hours, 'num'], ['peak_wind_mph', 'Peak wind (mph)', (e) => fmt(e.peak_wind_mph), 'num'],
  ['min_vis_mi', 'Min vis (mi)', (e) => e.min_vis_mi, 'num'], ['min_tmpf', 'Min temp (°F)', (e) => fmt(e.min_tmpf), 'num'],
  ['confirmed', 'Snow', (e) => (e.confirmed ? '<span class="badge ok">reported</span>' : '<span class="badge" title="No present-weather sensor: inferred from temperature">inferred</span>')],
  ['warned', 'Warning', (e) => (e.warned ? '<span class="badge warn">warned</span>' : '<span class="badge">none</span>')],
];
const evVal = (e, k) => (k === 'state' ? S.stById[e.station]?.state : k === 'type' ? S.stById[e.station]?.type : e[k]);

function initExplorer() {
  $$('.subtabs button').forEach((b) => (b.onclick = () => {
    $$('.subtabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('.sub').forEach((s) => s.classList.toggle('active', s.id === `sub-${b.dataset.sub}`));
    if (b.dataset.sub === 'sql') initSql();
  }));
  const rerun = () => { EV.page = 0; renderEvents(); };
  ['evSearch'].forEach((id) => ($('#' + id).oninput = debounce(rerun, 150)));
  ['evState', 'evType', 'evHours', 'evWind', 'evWarned'].forEach((id) => ($('#' + id).onchange = rerun));
  $('#evPrev').onclick = () => { EV.page--; renderEvents(); }; $('#evNext').onclick = () => { EV.page++; renderEvents(); };
  $('#evCsv').onclick = () => downloadCSV('blizzard_events.csv', ['id', 'station', 'name', 'state', 'start_utc', 'end_utc', 'hours', 'peak_wind_mph', 'min_vis_mi', 'min_tmpf', 'snow_reported', 'warned', 'storm'], EV.rows.map((e) => [e.id, e.station, S.stById[e.station]?.name, S.stById[e.station]?.state, e.start, e.end, e.hours, e.peak_wind_mph, e.min_vis_mi, e.min_tmpf, e.confirmed ? 1 : 0, e.warned, e.storm]));
  renderEvents();
  initArchive();
}

function renderEvents() {
  const q = $('#evSearch').value.trim().toLowerCase(), st = $('#evState').value, ty = $('#evType').value, hrs = +$('#evHours').value || 0, wnd = +$('#evWind').value || 0, wd = $('#evWarned').value;
  EV.rows = S.events.filter((e) => {
    const s = S.stById[e.station]; if (!s) return false;
    if (st && s.state !== st) return false; if (ty && s.type !== ty) return false;
    if (e.hours < hrs || e.peak_wind_mph < wnd) return false;
    if (wd !== '' && String(e.warned) !== wd) return false;
    if (!q) return true;
    const hay = `${e.station} ${s.name} ${s.county || ''} ${s.state} ${e.start} ${e.storm} ${localDate(e.start)}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
  const k = EV.sort, d = EV.dir;
  EV.rows.sort((a, b) => { const x = evVal(a, k), y = evVal(b, k); return (x > y ? 1 : x < y ? -1 : 0) * d; });
  const pages = Math.max(1, Math.ceil(EV.rows.length / EV.per)); EV.page = Math.max(0, Math.min(pages - 1, EV.page));
  const slice = EV.rows.slice(EV.page * EV.per, (EV.page + 1) * EV.per);
  $('#evCount').textContent = `${fmt(EV.rows.length)} of ${fmt(S.events.length)} verified station-events`;
  $('#evTable').innerHTML = `<thead><tr>${evCols.map(([k2, h]) => `<th data-k="${k2}" ${EV.sort === k2 ? `data-dir="${EV.dir > 0 ? '▲' : '▼'}"` : ''}>${h}</th>`).join('')}</tr></thead><tbody>${slice.map((e) => `<tr class="click" data-id="${e.id}">${evCols.map(([, , f, cls]) => `<td class="${cls || ''}">${f(e)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${evCols.length}" class="muted">No events match.</td></tr>`}</tbody>`;
  $$('#evTable th').forEach((th) => (th.onclick = () => { const k2 = th.dataset.k; EV.dir = EV.sort === k2 ? -EV.dir : -1; EV.sort = k2; renderEvents(); }));
  $$('#evTable tbody tr[data-id]').forEach((tr) => (tr.onclick = () => showEventDetail(+tr.dataset.id)));
  $('#evPage').textContent = `Page ${EV.page + 1} of ${pages}`;
  $('#evPrev').disabled = EV.page === 0; $('#evNext').disabled = EV.page >= pages - 1;
}

function openEvent(id) {
  showView('explore');
  $$('.subtabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.sub === 'events')));
  $$('.sub').forEach((s) => s.classList.toggle('active', s.id === 'sub-events'));
  const e = S.events.find((x) => x.id === id);
  if (e) { $('#evSearch').value = `${e.station} ${e.start.slice(0, 10)}`; EV.page = 0; renderEvents(); }
  showEventDetail(id);
}

async function showEventDetail(id) {
  const e = S.events.find((x) => x.id === id), s = S.stById[e.station], box = $('#evDetail');
  box.hidden = false;
  box.innerHTML = `<h3>${esc(s.id)} · ${esc(s.name)}, ${esc(s.state)} <span class="badge">${s.type}</span></h3>
    <div class="muted">${esc(local(e.start))} → ${esc(local(e.end))} · ${e.hours} consecutive hours · storm ${esc(e.storm)} · peak wind ${fmt(e.peak_wind_mph)} mph · min visibility ${e.min_vis_mi} mi ${e.warned ? `· <span class="badge warn">under Blizzard Warning ${esc(e.warning_id || '')}</span>` : ''}</div>
    <p class="muted">Loading reports…</p>`;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const db = await getDb();
    const res = db.exec('SELECT valid,tmpf,vsby,sknt,gust,wxcodes,metar,qualifies FROM event_obs WHERE event_id=? ORDER BY valid', [id]);
    const rows = res[0]?.values || [];
    box.querySelector('p').outerHTML = `<div class="tablewrap"><table><thead><tr><th>Time (local)</th><th>Temp °F</th><th>Vis mi</th><th>Wind mph</th><th>Wx</th><th>METAR</th></tr></thead><tbody>${rows.map(([v, t, vis, sk, g, wx, m, q]) =>
      `<tr class="${q ? 'q' : ''}"><td>${esc(local(v))}</td><td class="num">${fmt(t)}</td><td class="num">${vis ?? '–'}</td><td class="num">${sk == null ? '–' : fmt(sk * MPH_PER_KT)}${g ? ` G${fmt(g * MPH_PER_KT)}` : ''}</td><td>${esc(wx || '')}</td><td class="metar">${esc(m || '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="hint">Highlighted rows meet the blizzard thresholds (wind ≥ 35 mph, visibility ≤ ¼ mi, snow). Times shown in New England local time.</div>`;
  } catch (err) { box.querySelector('p').textContent = `Could not load reports: ${err.message}`; }
}

/* ---------- SQL (sql.js) ---------- */
function getDb() {
  if (S.dbPromise) return S.dbPromise;
  S.dbPromise = (async () => {
    const SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
    const buf = await (await fetch('data/blizzard.sqlite')).arrayBuffer();
    S.db = new SQL.Database(new Uint8Array(buf));
    return S.db;
  })();
  return S.dbPromise;
}
const SQL_EXAMPLES = {
  'Stations ranked by verified events': `SELECT s.id, s.name, s.state, s.type, COUNT(*) AS events, SUM(e.hours) AS hours, MAX(e.peak_wind_mph) AS peak_mph
FROM events e JOIN stations s ON s.id = e.station
GROUP BY s.id ORDER BY events DESC LIMIT 25;`,
  'Strongest winds during blizzard conditions': `SELECT station, station_name, state, start, hours, peak_wind_mph, min_vis_mi
FROM v_events ORDER BY peak_wind_mph DESC LIMIT 25;`,
  'Events by winter, warned vs not': `SELECT season, SUM(warned) AS under_warning, SUM(1-warned) AS no_warning, COUNT(*) AS total
FROM events GROUP BY season ORDER BY season;`,
  'Raw METARs that met blizzard thresholds (one storm)': `SELECT e.station, o.valid, o.metar
FROM event_obs o JOIN events e ON e.id = o.event_id
WHERE o.qualifies = 1 AND e.storm = (SELECT storm FROM events ORDER BY peak_wind_mph DESC LIMIT 1)
ORDER BY o.valid, e.station;`,
  'Search raw METAR text (blowing snow)': `SELECT e.station, o.valid, o.vsby, o.sknt, o.gust, o.metar
FROM event_obs o JOIN events e ON e.id = o.event_id
WHERE o.metar LIKE '%BLSN%' ORDER BY o.valid DESC LIMIT 100;`,
  'Blizzard Warnings and verification': `SELECT id, start, "end", area_km2, stations_in_area, stations_verified
FROM warnings ORDER BY start DESC;`,
  'Station data coverage by winter': `SELECT station, season, coverage, vis_reported, wx_capable, valid
FROM station_seasons WHERE valid = 0 ORDER BY station, season;`,
};
let sqlInit = false, sqlLast = null;
function initSql() {
  if (sqlInit) return; sqlInit = true;
  $('#sqlExamples').innerHTML = Object.keys(SQL_EXAMPLES).map((k) => `<option>${esc(k)}</option>`).join('');
  $('#sqlText').value = SQL_EXAMPLES[Object.keys(SQL_EXAMPLES)[0]];
  $('#sqlExamples').onchange = () => { $('#sqlText').value = SQL_EXAMPLES[$('#sqlExamples').value]; runSql(); };
  $('#sqlRun').onclick = runSql;
  $('#sqlText').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });
  $('#sqlCsv').onclick = () => sqlLast && downloadCSV('query.csv', sqlLast.columns, sqlLast.values);
  runSql();
}
async function runSql() {
  const st = $('#sqlStatus'); st.textContent = 'Running…';
  try {
    const db = await getDb(), t0 = performance.now(), res = db.exec($('#sqlText').value);
    const r = res[res.length - 1]; sqlLast = r || null;
    if (!r) { $('#sqlTable').innerHTML = ''; st.textContent = 'OK (no rows returned)'; return; }
    const shown = r.values.slice(0, 1000);
    $('#sqlTable').innerHTML = `<thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${shown.map((row) => `<tr>${row.map((v) => `<td class="${typeof v === 'number' ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    st.textContent = `${fmt(r.values.length)} row${r.values.length === 1 ? '' : 's'}${r.values.length > 1000 ? ' (first 1,000 shown)' : ''} · ${fmt(performance.now() - t0)} ms`;
  } catch (e) { st.textContent = `Error: ${e.message}`; }
}

/* ---------- live archive search (IEM, from the browser) ---------- */
const AR = { rows: [], page: 0, per: 50 };
function initArchive() {
  const sorted = S.stations.slice().sort((a, b) => a.state.localeCompare(b.state) || a.id.localeCompare(b.id));
  $('#arStation').innerHTML = sorted.map((s) => `<option value="${s.id}">${s.state} · ${s.id} · ${esc(s.name)} (${s.type})</option>`).join('');
  const ev = S.events.slice().sort((a, b) => b.peak_wind_mph - a.peak_wind_mph)[0];
  if (ev) {
    $('#arStation').value = ev.station;
    const d = new Date(toDate(ev.start)); const a = new Date(d - 864e5), b = new Date(+d + 2 * 864e5);
    $('#arFrom').value = a.toISOString().slice(0, 10); $('#arTo').value = b.toISOString().slice(0, 10);
  }
  $('#arForm').onsubmit = (e) => { e.preventDefault(); runArchive(); };
  $('#arPrev').onclick = () => { AR.page--; renderArchive(); }; $('#arNext').onclick = () => { AR.page++; renderArchive(); };
  $('#arCsv').onclick = () => downloadCSV('archive_search.csv', ['station', 'valid_utc', 'tmpf', 'vsby', 'wind_mph', 'gust_mph', 'wxcodes', 'metar'], AR.rows.map((r) => [r.station, r.valid, r.tmpf, r.vsby, r.wind, r.gust, r.wx, r.metar]));
}
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function runArchive() {
  const st = $('#arStatus'), from = $('#arFrom').value, to = $('#arTo').value, id = $('#arStation').value;
  const days = (new Date(to) - new Date(from)) / 864e5;
  if (!(days >= 0)) { st.textContent = 'Choose a valid date range.'; return; }
  if (days > 400) { st.textContent = 'Please search at most ~13 months at a time.'; return; }
  st.textContent = 'Querying the IEM archive…';
  const end = new Date(+new Date(to) + 864e5).toISOString().slice(0, 10);
  const p = new URLSearchParams([['station', id], ['sts', `${from}T00:00Z`], ['ets', `${end}T00:00Z`], ['tz', 'UTC'], ['format', 'onlycomma'], ['missing', 'empty'], ['trace', 'T'], ['report_type', '3'], ['report_type', '4'], ...['tmpf', 'vsby', 'sknt', 'gust', 'wxcodes', 'metar'].map((d) => ['data', d])]);
  try {
    const r = await fetch(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${p}`);
    if (!r.ok) throw new Error(`IEM returned HTTP ${r.status}`);
    const rows = parseCSV(await r.text()); const head = rows.shift() || [];
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    const num = (v) => (v === '' || v == null ? null : Number(v));
    let all = rows.filter((x) => x.length > 3).map((x) => ({ station: x[ix.station], valid: x[ix.valid], tmpf: num(x[ix.tmpf]), vsby: num(x[ix.vsby]), wind: num(x[ix.sknt]) == null ? null : Math.round(num(x[ix.sknt]) * MPH_PER_KT), gust: num(x[ix.gust]) == null ? null : Math.round(num(x[ix.gust]) * MPH_PER_KT), wx: x[ix.wxcodes] || '', metar: x[ix.metar] || '' }));
    const total = all.length;
    const w = num($('#arWind').value), v = num($('#arVis').value), wx = $('#arWx').value.trim().toUpperCase(), tx = $('#arText').value.trim();
    let re = null;
    if (tx) { const m = tx.match(/^\/(.+)\/([a-z]*)$/i); try { re = m ? new RegExp(m[1], m[2] || 'i') : null; } catch (_) { re = null; } }
    all = all.filter((r2) => (w == null || Math.max(r2.wind ?? 0, r2.gust ?? 0) >= w) && (v == null || (r2.vsby != null && r2.vsby <= v)) && (!wx || r2.wx.toUpperCase().includes(wx)) && (!tx || (re ? re.test(r2.metar) : r2.metar.toLowerCase().includes(tx.toLowerCase()))));
    AR.rows = all; AR.page = 0; renderArchive();
    st.textContent = `${fmt(all.length)} of ${fmt(total)} reports match · ${id} ${from} → ${to} (UTC)`;
  } catch (e) { st.textContent = `Search failed: ${e.message}`; }
}
function renderArchive() {
  const pages = Math.max(1, Math.ceil(AR.rows.length / AR.per)); AR.page = Math.max(0, Math.min(pages - 1, AR.page));
  const sl = AR.rows.slice(AR.page * AR.per, (AR.page + 1) * AR.per);
  $('#arTable').innerHTML = `<thead><tr><th>Time (local)</th><th>Temp °F</th><th>Vis mi</th><th>Wind mph</th><th>Wx</th><th>METAR</th></tr></thead><tbody>${sl.map((r) => `<tr><td>${esc(local(r.valid.replace(' ', 'T') + 'Z'))}</td><td class="num">${fmt(r.tmpf)}</td><td class="num">${r.vsby ?? '–'}</td><td class="num">${r.wind ?? '–'}${r.gust ? ` G${r.gust}` : ''}</td><td>${esc(r.wx)}</td><td class="metar">${esc(r.metar)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No matching reports.</td></tr>'}</tbody>`;
  $('#arPage').textContent = `Page ${AR.page + 1} of ${pages}`; $('#arPrev').disabled = AR.page === 0; $('#arNext').disabled = AR.page >= pages - 1;
}

function downloadCSV(name, cols, rows) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[cols, ...rows].map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ================================================================== ABOUT */
function initAbout() {
  const m = S.meta, t = m.thresholds, c = m.counts, w = m.window;
  $('#aboutBody').innerHTML = `
  <h1>About this atlas</h1>
  <p>Ten winters of verified blizzard conditions from ASOS/AWOS/METAR stations, side by side with every NWS Blizzard Warning, for Connecticut, Rhode Island, Massachusetts, New Hampshire, Vermont and Maine.</p>
  <table><tbody>
    <tr><td>Winters covered</td><td>${esc(w.first_season)} – ${esc(w.last_season)}${w.in_progress_season ? ` (${esc(w.in_progress_season)} in progress)` : ''}</td></tr>
    <tr><td>Stations</td><td>${c.stations} (${c.stations_usable} with a usable visibility record)</td></tr>
    <tr><td>Verified station-events</td><td>${c.events} in ${c.storms} regional storms</td></tr>
    <tr><td>Blizzard Warnings</td><td>${c.warnings}</td></tr>
    <tr><td>Raw reports stored</td><td>${fmt(c.event_obs)} METAR/SPECI around verified events</td></tr>
    <tr><td>Last updated</td><td>${esc(m.generated)} UTC</td></tr>
  </tbody></table>
  <h2>How “verified blizzard conditions” are defined</h2>
  <p>Following the NWS definition, a station has a <b>verified blizzard event</b> when, in each of at least <b>${t.min_hours} consecutive clock hours</b>, at least one report has sustained wind or gust ≥ <b>${t.wind_mph} mph</b> (${t.wind_kt} kt), visibility ≤ <b>${t.vis_mi} mile</b>, and the present-weather group shows snow or blowing snow (SN, BLSN, SG, including intensity and shower variants; drifting snow is excluded).</p>
  <p>Many AWOS units have no present-weather sensor. For station-winters that never reported a weather code, the snow test is replaced by <b>temperature ≤ ${t.inferred_tmpf_max}°F</b> and the event is labelled <i>inferred</i>. Stations without a visibility sensor cannot verify blizzards and are excluded. A station-winter must have usable visibility and wind in at least ${Math.round(t.min_coverage * 100)}% of its hours to count toward frequencies.</p>
  <p><b>Quality control.</b> Winds above 90 kt and gusts more than 45 kt above the sustained wind are ignored (a lone 102 kt gust in an ordinary snow report is a sensor artifact, not a storm).${(m.excluded_stations || []).length ? ` <b>Excluded:</b> ${m.excluded_stations.map((x) => `${esc(x.id)} ${esc(x.name)}, ${esc(x.state)} — ${esc(x.reason)}`).join('; ')}.` : ''}</p>
  <h2>Gridded products</h2>
  <p><b>Observed</b> grids are Gaussian-weighted (σ ${S.grids.kernel.sigma_km} km) averages of each station’s own rates over completed winters, left blank where no station with a usable record lies within roughly 45 km. They are smoothed station statistics, not a physical analysis: terrain, coastlines and lake/ocean effects between stations are not resolved. <b>Warned</b> grids count how many Blizzard Warnings covered each 5 km cell, from NWS forecast-zone polygons. The grids use only completed winters (${esc(S.grids.climo_seasons[0])} – ${esc(S.grids.climo_seasons.at(-1))}) so a partial season never biases a rate; the season selector only affects station dots, warning-zone counts and the dashboard.</p>
  <p>With ten winters, probabilities move in steps of 10% at a station and small differences between neighbouring locations are not significant.</p>
  <h2>Data sources</h2>
  <p>Observations (ASOS/AWOS METAR and SPECI) and NWS VTEC warnings come from the <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">Iowa Environmental Mesonet</a> archive. Basemap: © OpenStreetMap contributors, © CARTO; state and county outlines from US Atlas (Census). Map rendering by MapLibre GL JS; in-browser SQL by sql.js. Data refreshes via GitHub Actions.</p>`;
}

boot();
})();
