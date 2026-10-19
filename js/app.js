// Radar Meteo – applicazione principale.
import { SOURCES, KIND_LABEL } from './sources.js';
import { Rating, RATE_INTERVAL } from './rating.js';
import { safeFetch, store, el, clamp, floorTo, fmtAge, isoZ, MIN, HOUR, DAY } from './util.js';

const RANGE_MIN = 15 * 1440;         // ±15 giorni, in minuti
const SLIDER_STEP = 5;               // minuti
const PREFS_KEY = 'radar-meteo.prefs.v1';
const $ = id => document.getElementById(id);
const byId = Object.fromEntries(SOURCES.map(s => [s.id, s]));

// ------------------------------------------------------------------ preferenze
const prefs = (() => {
  const p = store.get(PREFS_KEY, {});
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    lat: clamp(num(p.lat, 45.0705), -85, 85),
    lon: clamp(num(p.lon, 7.6868), -180, 180),
    zoom: clamp(num(p.zoom, 8), 2, 14),
    place: typeof p.place === 'string' ? p.place.slice(0, 120) : 'Torino, Piemonte, Italia',
    opacity: clamp(num(p.opacity, 0.8), 0.1, 1),
    basemap: ['dark', 'osm'].includes(p.basemap) ? p.basemap : 'light',
    mode: typeof p.mode === 'string' && (p.mode === 'auto' || byId[p.mode]) ? p.mode : 'auto',
    disabled: Array.isArray(p.disabled) ? p.disabled.filter(id => byId[id]) : [],
  };
})();
const savePrefs = () => store.set(PREFS_KEY, prefs);

// ------------------------------------------------------------------ mappa
const map = L.map('map', { zoomControl: true, worldCopyJump: true, minZoom: 2 })
  .setView([prefs.lat, prefs.lon], prefs.zoom);
map.createPane('radar').style.zIndex = 350;
map.createPane('labels').style.zIndex = 450;
map.getPane('labels').style.pointerEvents = 'none';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
const esriAttr = 'Mappa © <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap';
const osmAttr = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
let baseLayer, labelLayer;
function setBasemap(kind) {
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  labelLayer = null;
  if (kind === 'osm') {
    baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }).addTo(map);
  } else {
    const name = kind === 'dark' ? 'World_Dark_Gray' : 'World_Light_Gray';
    baseLayer = L.tileLayer(`${ESRI}${name}_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, attribution: esriAttr }).addTo(map);
    labelLayer = L.tileLayer(`${ESRI}${name}_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, pane: 'labels' }).addTo(map);
  }
  document.body.classList.toggle('dark', kind === 'dark');
}
setBasemap(prefs.basemap);

const placeMarker = L.circleMarker([prefs.lat, prefs.lon], {
  radius: 6, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1, pane: 'labels',
}).addTo(map);

// ------------------------------------------------------------------ gestione frame
// Mantiene alcuni layer pre-caricati (opacità 0) per animazioni fluide e
// mostra il nuovo frame solo quando le tile sono pronte, evitando sfarfallii.
class FrameManager {
  constructor(max = 8) { this.cache = new Map(); this.current = null; this.max = max; this.opacity = prefs.opacity; }
  _get(key, factory) {
    let e = this.cache.get(key);
    if (e) { this.cache.delete(key); this.cache.set(key, e); return e; }
    const layer = factory();
    if (!layer) return null;
    e = { key, layer, loaded: false, attrShown: true };
    layer.on('load', () => { e.loaded = true; });
    layer.setOpacity(0);
    layer.addTo(map);
    this._visible(e, false);
    this.cache.set(key, e);
    this._evict();
    return e;
  }
  _evict() {
    for (const [k, e] of this.cache) {
      if (this.cache.size <= this.max) break;
      if (e === this.current) continue;
      this._visible(e, true);
      map.removeLayer(e.layer);
      this.cache.delete(k);
    }
  }
  show(key, factory) {
    if (this.current?.key === key) return;
    const e = this._get(key, factory);
    if (!e) return this.hide();
    const hadVisible = this.current && this.cache.has(this.current.key);
    this.current = e;
    const reveal = () => {
      if (this.current !== e) return;
      for (const o of this.cache.values()) this._visible(o, o === e);
    };
    if (e.loaded || !hadVisible) reveal();
    else { e.layer.once('load', reveal); setTimeout(reveal, 2500); }
  }
  // I layer pre-caricati restano sulla mappa invisibili: l'attribuzione segue la visibilità.
  _visible(o, on) {
    o.layer.setOpacity(on ? this.opacity : 0);
    const attr = o.layer.getAttribution?.();
    if (!attr || o.attrShown === on) return;
    if (on) map.attributionControl.addAttribution(attr); else map.attributionControl.removeAttribution(attr);
    o.attrShown = on;
  }
  preload(key, factory) { if (!this.cache.has(key)) this._get(key, factory); }
  hide() { this.current = null; for (const o of this.cache.values()) this._visible(o, false); }
  setOpacity(o) { this.opacity = o; if (this.current) this.current.layer.setOpacity(o); }
  dropPrefix(prefix) {
    for (const [k, e] of [...this.cache]) {
      if (k.startsWith(prefix) && e !== this.current) { this._visible(e, true); map.removeLayer(e.layer); this.cache.delete(k); }
    }
  }
}
const frames = new FrameManager();

// ------------------------------------------------------------------ griglia modello (Open-Meteo)
const PRECIP_STOPS = [
  [0.1, [155, 225, 255, 120]], [0.5, [67, 176, 255, 170]], [1, [26, 115, 232, 200]],
  [2, [34, 197, 94, 210]], [5, [250, 204, 21, 220]], [10, [249, 115, 22, 230]],
  [20, [239, 68, 68, 235]], [50, [162, 28, 175, 240]],
];
function precipColor(mm) {
  if (!(mm >= PRECIP_STOPS[0][0])) return [0, 0, 0, 0];
  for (let i = PRECIP_STOPS.length - 1; i >= 0; i--) if (mm >= PRECIP_STOPS[i][0]) return PRECIP_STOPS[i][1];
  return PRECIP_STOPS[0][1];
}

class ModelGrid {
  constructor() { this.data = null; this.pending = null; this.renders = new Map(); this.seq = 0; }
  _fits(b, z, t) {
    const d = this.data;
    return d && d.bounds.contains(b) && Math.abs(d.zoom - z) < 1.5 && t >= d.t0 && t + HOUR <= d.t0 + (d.len - 1) * HOUR;
  }
  async ensure(t) {
    const b = map.getBounds(), z = map.getZoom();
    if (this._fits(b, z, t)) return this.data;
    if (this.pending) {
      await this.pending.catch(() => {});
      if (this._fits(b, z, t)) return this.data;
    }
    this.pending = this._fetch(b.pad(0.3), z, t);
    try { return await this.pending; } finally { this.pending = null; }
  }
  async _fetch(pb, z, t) {
    const s = Math.max(-84, pb.getSouth()), n = Math.min(84, pb.getNorth());
    let w = pb.getWest(), e = pb.getEast();
    if (e - w > 360) { w = -180; e = 180; }
    const size = map.getSize(), aspect = clamp(size.x / Math.max(1, size.y), 0.4, 3);
    const ny = clamp(Math.round(Math.sqrt(120 / aspect)), 4, 15), nx = clamp(Math.floor(120 / ny), 4, 20);
    const lats = [], lons = [];
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      lats.push((n - (r + 0.5) * (n - s) / ny).toFixed(3));
      let lon = w + (c + 0.5) * (e - w) / nx;
      lon = ((lon + 540) % 360) - 180;
      lons.push(lon.toFixed(3));
    }
    const h0 = floorTo(t, 60) - DAY, h1 = floorTo(t, 60) + 2 * DAY;
    const hh = x => isoZ(x).slice(0, 16);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
      `&hourly=precipitation&timezone=GMT&models=best_match&start_hour=${hh(h0)}&end_hour=${hh(h1)}`;
    const { body } = await safeFetch(url, { timeout: 25000 });
    const arr = Array.isArray(body) ? body : [body];
    if (arr.length !== nx * ny) throw new Error('Griglia incompleta');
    const times = arr[0]?.hourly?.time;
    if (!Array.isArray(times) || !times.length) throw new Error('Griglia senza dati');
    const t0 = Date.parse(times[0] + 'Z');
    const values = arr.map(p => (p.hourly?.precipitation || []).map(v => (Number.isFinite(v) ? v : NaN)));
    this.data = { id: ++this.seq, bounds: L.latLngBounds([s, w], [n, e]), zoom: z, nx, ny, t0, len: times.length, values };
    this.renders.clear();
    frames.dropPrefix('om:');
    return this.data;
  }
  // Precipitazione nell'ora [ft, ft+1h] (Open-Meteo: valore a T = somma dell'ora precedente).
  render(ft) {
    const d = this.data;
    const idx = Math.round((ft - d.t0) / HOUR) + 1;
    if (idx < 0 || idx >= d.len) return null;
    const key = `om:${d.id}:${idx}`;
    if (this.renders.has(key)) return this.renders.get(key);
    const small = document.createElement('canvas');
    small.width = d.nx; small.height = d.ny;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(d.nx, d.ny);
    for (let i = 0; i < d.nx * d.ny; i++) img.data.set(precipColor(d.values[i][idx]), i * 4);
    sctx.putImageData(img, 0, 0);
    const big = document.createElement('canvas');
    big.width = d.nx * 24; big.height = d.ny * 24;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, big.width, big.height);
    const out = { key, url: big.toDataURL('image/png'), bounds: d.bounds };
    this.renders.set(key, out);
    return out;
  }
  valueAt(lat, lon, ft) {
    const d = this.data;
    if (!d || !d.bounds.contains([lat, lon])) return null;
    const r = Math.floor((d.bounds.getNorth() - lat) / (d.bounds.getNorth() - d.bounds.getSouth()) * d.ny);
    const c = Math.floor((lon - d.bounds.getWest()) / (d.bounds.getEast() - d.bounds.getWest()) * d.nx);
    const idx = Math.round((ft - d.t0) / HOUR) + 1;
    return d.values[clamp(r, 0, d.ny - 1) * d.nx + clamp(c, 0, d.nx - 1)]?.[idx] ?? null;
  }
}
const modelGrid = new ModelGrid();

const modelLegend = L.control({ position: 'bottomleft' });
modelLegend.onAdd = () => {
  const box = el('div', { class: 'legend' }, el('div', { class: 'muted small', text: 'Modello · mm/h' }));
  for (const [mm, c] of PRECIP_STOPS) {
    const sw = el('i');
    sw.style.background = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
    box.append(el('span', {}, sw, String(mm)));
  }
  return box;
};
let legendShown = false;
function showModelLegend(on) {
  if (on === legendShown) return;
  legendShown = on;
  if (on) modelLegend.addTo(map); else modelLegend.remove();
}

// ------------------------------------------------------------------ stato
const rating = new Rating(SOURCES);
const disabled = new Set(prefs.disabled);
const state = {
  anchor: floorTo(Date.now(), SLIDER_STEP),
  t: Date.now(),
  live: true,
  playing: false,
  loop: null,
  pick: null,
  cands: [],
};
const coverage = new Map(); // "id|lat|lon" → true/false/null

function coverageOf(src, lat, lon) {
  if (!src.covers(lat, lon)) return false;
  if (!src.coverage) return true;
  const key = `${src.id}|${Math.round(lat * 2) / 2}|${Math.round(lon * 2) / 2}`;
  if (coverage.has(key)) return coverage.get(key);
  coverage.set(key, null);
  src.coverage(lat, lon).then(v => { coverage.set(key, v); scheduleUpdate(); });
  return null;
}

function candidatesAt(t, lat, lon) {
  const out = [];
  for (const s of SOURCES) {
    if (disabled.has(s.id)) continue;
    const cov = coverageOf(s, lat, lon);
    if (cov === false) continue;
    const f = s.frameAt(t);
    if (!f) continue;
    const eff = rating.score(s.id) * s.qualityAt(t, f) * (cov === null ? 0.9 : 1);
    out.push({ s, f, eff });
  }
  return out.sort((a, b) => b.eff - a.eff);
}

function frameKindLabel(src, f) {
  if (src.kind === 'model') return f.time + HOUR <= Date.now() ? 'analisi del modello' : 'previsione del modello';
  if (f.nowcast) return 'nowcast (estrapolazione radar)';
  return 'osservato';
}

// ------------------------------------------------------------------ aggiornamento vista
let updateToken = 0;
let updateQueued = false;
function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => { updateQueued = false; update(); });
}

async function update() {
  const token = ++updateToken;
  const c = map.getCenter();
  const cands = candidatesAt(state.t, c.lat, c.lng);
  state.cands = cands;
  let pick = null;
  if (prefs.mode === 'auto') pick = cands[0] || null;
  else {
    const s = byId[prefs.mode];
    const f = s.frameAt(state.t);
    pick = f ? { s, f, eff: rating.score(s.id) * s.qualityAt(state.t, f) } : null;
  }
  state.pick = pick;
  showModelLegend(pick?.s.id === 'openmeteo');
  renderTimeLabel();
  renderSourceInfo();
  drawTimeline();

  if (!pick) { frames.hide(); setMapNote('Nessuna fonte con dati per questo istante e luogo.'); return; }
  if (pick.s.id === 'openmeteo') {
    setMapNote('Carico la griglia del modello…');
    try {
      await modelGrid.ensure(pick.f.time);
    } catch (e) {
      if (token === updateToken) { frames.hide(); setMapNote('Errore modello: ' + e.message); }
      return;
    }
    if (token !== updateToken) return;
    const r = modelGrid.render(pick.f.time);
    if (!r) { frames.hide(); setMapNote('Ora fuori dalla griglia del modello.'); return; }
    frames.show(r.key, () => L.imageOverlay(r.url, r.bounds, {
      pane: 'radar', interactive: false, attribution: pick.s.attribution, className: 'model-overlay',
    }));
    setMapNote(null);
    renderSourceInfo();
  } else {
    frames.show(pick.f.key, () => pick.s.layer(pick.f));
    setMapNote(pick.s.coverage && coverage.get(`${pick.s.id}|${Math.round(c.lat * 2) / 2}|${Math.round(c.lng * 2) / 2}`) === null
      ? 'Verifica copertura radar in corso…' : null);
    if (state.playing) preloadNext(pick);
  }
}

function preloadNext(pick) {
  const next = pick.s.frameAt(state.t + pick.s.stepMin * MIN);
  if (next && next.key !== pick.f.key && pick.s.layer) frames.preload(next.key, () => pick.s.layer(next));
}

function setMapNote(text) {
  const n = $('map-note');
  n.textContent = text || '';
  n.hidden = !text;
}

const fmtFull = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtHM = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric' });

function renderTimeLabel() {
  const d = state.t - Date.now();
  $('time-main').textContent = fmtFull.format(state.t);
  $('time-rel').textContent = Math.abs(d) < 3 * MIN ? 'adesso' : d < 0 ? `${fmtAge(-d)} fa` : `tra ${fmtAge(d)}`;
  $('time-main').title = 'UTC: ' + isoZ(state.t);
  $('slider').value = String(Math.round((state.t - state.anchor) / MIN / SLIDER_STEP) * SLIDER_STEP);
  $('btn-live').classList.toggle('active', state.live);
}

function renderSourceInfo() {
  const box = $('source-info');
  box.replaceChildren();
  const p = state.pick;
  if (!p) {
    box.append(el('span', { class: 'muted', text: prefs.mode === 'auto' ? 'Nessun dato disponibile' : `${byId[prefs.mode].short}: nessun dato in questo istante` }));
    return;
  }
  const kindTxt = frameKindLabel(p.s, p.f);
  box.append(
    el('span', { class: 'dot' }),
    el('strong', { text: p.s.short }),
    el('span', { class: 'badge ' + p.s.kind, text: KIND_LABEL[p.s.kind] }),
    el('span', { class: 'muted', text: ` ${kindTxt} · frame ${fmtHM.format(p.f.time)} · rating ${rating.score(p.s.id).toFixed(0)}` }),
  );
  box.firstChild.style.background = p.s.color;
  const alts = state.cands.filter(c => c.s !== p.s).slice(0, 3).map(c => `${c.s.short} (${c.eff.toFixed(0)})`);
  if (alts.length) box.append(el('span', { class: 'muted alt', text: ' · alternative: ' + alts.join(', ') }));
  const c = map.getCenter();
  const v = p.s.id === 'openmeteo' ? modelGrid.valueAt(c.lat, c.lng, p.f.time) : pointValueAt(state.t);
  if (v != null && Number.isFinite(v)) box.append(el('span', { class: 'muted', text: ` · al centro (modello): ${v.toFixed(1)} mm/h` }));
}

// ------------------------------------------------------------------ serie puntuale + timeline
let point = null; // { lat, lon, t0, values }
let pointTimer = null;
function schedulePointFetch() {
  clearTimeout(pointTimer);
  pointTimer = setTimeout(fetchPoint, 700);
}
async function fetchPoint() {
  const c = map.getCenter();
  if (point && map.distance([point.lat, point.lon], c) < 5000) return;
  const lat = c.lat.toFixed(3), lon = (((c.lng + 540) % 360) - 180).toFixed(3);
  try {
    const { body } = await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&hourly=precipitation&past_days=15&forecast_days=16&timezone=GMT&models=best_match');
    const times = body?.hourly?.time, vals = body?.hourly?.precipitation;
    if (!Array.isArray(times) || !Array.isArray(vals)) throw new Error('dati mancanti');
    point = { lat: c.lat, lon: c.lng, t0: Date.parse(times[0] + 'Z'), values: vals.map(v => (Number.isFinite(v) ? v : 0)) };
  } catch { point = null; }
  drawTimeline();
  renderSourceInfo();
}
function pointValueAt(t) {
  if (!point) return null;
  const i = Math.round((floorTo(t, 60) - point.t0) / HOUR) + 1;
  return point.values[i] ?? null;
}

const tlCanvas = $('timeline');
function tRange() { return [state.anchor - RANGE_MIN * MIN, state.anchor + RANGE_MIN * MIN]; }
const THUMB = 8; // metà larghezza del cursore dello slider: allinea canvas e slider
function xOf(t, w) { const [a, b] = tRange(); return THUMB + (t - a) / (b - a) * (w - 2 * THUMB); }
function tOf(x, w) { const [a, b] = tRange(); return a + clamp((x - THUMB) / (w - 2 * THUMB), 0, 1) * (b - a); }

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const w = tlCanvas.clientWidth, h = tlCanvas.clientHeight;
  if (!w || !h) return;
  if (tlCanvas.width !== Math.round(w * dpr)) { tlCanvas.width = Math.round(w * dpr); tlCanvas.height = Math.round(h * dpr); }
  const ctx = tlCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue('--fg-muted').trim() || '#888';
  const [a, b] = tRange();

  // Giorni
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.globalAlpha = 0.35;
  const dayStep = w < 600 ? 3 : w < 1000 ? 2 : 1;
  const firstDay = new Date(a); firstDay.setHours(0, 0, 0, 0);
  for (let k = 0, day = firstDay; day.getTime() <= b; day.setDate(day.getDate() + 1)) {
    const d = day.getTime();
    if (d < a) continue;
    k++;
    const x = xOf(d, w);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    if (k % dayStep === 0) { ctx.globalAlpha = 0.8; ctx.fillText(fmtDay.format(d), x + 2, h - 2); ctx.globalAlpha = 0.35; }
  }
  ctx.globalAlpha = 1;

  // Precipitazione puntuale (modello) – barre orarie
  const barBase = h - 13, barMax = barBase - 26;
  if (point) {
    ctx.fillStyle = '#3b82f6';
    for (let i = 1; i < point.values.length; i++) {
      const v = point.values[i];
      if (!(v > 0.05)) continue;
      const t1 = point.t0 + (i - 1) * HOUR;
      const x = xOf(t1, w), x2 = xOf(t1 + HOUR, w);
      const hh = Math.min(1, Math.sqrt(v / 10)) * barMax;
      const c = precipColor(Math.max(v, 0.1));
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.9)`;
      ctx.fillRect(x, barBase - hh, Math.max(1, x2 - x), hh);
    }
  }

  // Disponibilità delle fonti al centro mappa (una riga per fonte)
  const c = map.getCenter();
  let row = 0;
  for (const s of SOURCES) {
    if (disabled.has(s.id) || coverageOf(s, c.lat, c.lng) === false) continue;
    const win = s.window();
    if (!win) continue;
    const y = 2 + row * 4;
    const x0 = xOf(Math.max(a, win.start), w), x1 = xOf(Math.min(b, win.obsEnd ?? win.end), w), x2 = xOf(Math.min(b, win.end), w);
    ctx.fillStyle = s.color;
    if (x1 > x0) ctx.fillRect(x0, y, Math.max(2, x1 - x0), 3);
    if (x2 > x1) { ctx.globalAlpha = 0.4; ctx.fillRect(x1, y, x2 - x1, 3); ctx.globalAlpha = 1; }
    row++;
  }

  // Adesso e cursore
  const xn = xOf(Date.now(), w);
  ctx.fillStyle = '#ef4444'; ctx.fillRect(xn - 0.5, 0, 1.5, h);
  const xc = xOf(state.t, w);
  ctx.fillStyle = css.getPropertyValue('--fg').trim() || '#000';
  ctx.fillRect(xc - 1, 0, 2, h);
}

function timelineLegend() {
  const box = $('tl-legend');
  box.replaceChildren();
  const c = map.getCenter();
  for (const s of SOURCES) {
    if (disabled.has(s.id) || coverageOf(s, c.lat, c.lng) === false || !s.window()) continue;
    const sw = el('i'); sw.style.background = s.color;
    box.append(el('span', {}, sw, s.short));
  }
  const bar = el('i', { class: 'bars' });
  box.append(el('span', {}, bar, 'pioggia al centro (modello)'));
}

// ------------------------------------------------------------------ pannello rating
function renderRatings() {
  const body = $('ratings-body');
  body.replaceChildren();
  const c = map.getCenter();
  const sorted = [...SOURCES].sort((x, y) => rating.score(y.id) - rating.score(x.id));
  for (const s of sorted) {
    const st = rating.state[s.id];
    const cov = coverageOf(s, c.lat, c.lng);
    const chk = el('input', { type: 'checkbox', title: 'Usa questa fonte in modalità automatica' });
    chk.checked = !disabled.has(s.id);
    chk.addEventListener('change', () => {
      if (chk.checked) disabled.delete(s.id); else disabled.add(s.id);
      prefs.disabled = [...disabled]; savePrefs(); scheduleUpdate(); timelineLegend();
    });
    const bar = el('div', { class: 'score-bar' }, el('div'));
    bar.firstChild.style.width = clamp(st.score, 0, 100) + '%';
    bar.firstChild.style.background = s.color;
    const hist = el('div', { class: 'hist', title: 'Ultime sonde (verde = ok, rosso = errore)' });
    for (const h of st.history.slice(-16)) hist.append(el('i', { class: h.ok ? 'ok' : 'ko' }));
    const link = el('a', { href: s.homepage, target: '_blank', rel: 'noopener noreferrer', text: s.name });
    const stato = st.ok == null ? 'in verifica…' : st.ok ? 'ok' : 'errore: ' + st.error;
    body.append(el('tr', { class: cov === false ? 'nocov' : '' },
      el('td', {}, chk),
      el('td', {}, link, el('div', { class: 'muted small', text: `${KIND_LABEL[s.kind]} · ${s.resKm} km · ogni ${s.stepMin} min · ${stato}` })),
      el('td', { class: 'center', text: cov === true ? '✔' : cov === false ? '✖' : '?' }),
      el('td', {}, el('div', { class: 'score' }, el('b', { text: st.score.toFixed(0) }), bar)),
      el('td', { class: 'num', text: Math.round(st.reliab * 100) + '%' }),
      el('td', { class: 'num', text: st.ms != null && st.ok ? Math.round(st.ms) + ' ms' : '—' }),
      el('td', { class: 'num', text: st.latest && st.ok ? (s.kind === 'model' ? '—' : fmtAge(Date.now() - st.latest)) : '—' }),
      el('td', {}, hist),
    ));
  }
  const last = rating.lastRun;
  $('ratings-when').textContent = last
    ? `Ultima valutazione: ${fmtHM.format(last)} · prossima alle ${fmtHM.format(last + RATE_INTERVAL)}`
    : 'Valutazione in corso…';
}

// ------------------------------------------------------------------ controlli tempo
function setTime(t, { live = false } = {}) {
  const [a, b] = tRange();
  state.t = clamp(t, a, b);
  state.live = live;
  scheduleUpdate();
}

function latestObservation() {
  const c = map.getCenter();
  let best = null;
  for (const s of SOURCES) {
    if (s.kind === 'model' || disabled.has(s.id) || coverageOf(s, c.lat, c.lng) === false) continue;
    const w = s.window();
    if (!w) continue;
    const t = Math.min(w.obsEnd ?? w.end, Date.now());
    const eff = rating.score(s.id);
    if (!best || eff > best.eff) best = { t, eff };
  }
  return best ? best.t : Date.now();
}
const goLive = () => setTime(latestObservation(), { live: true });

function step(dir) {
  const st = state.pick ? state.pick.s.stepMin : SLIDER_STEP;
  const base = state.pick ? state.pick.f.time : state.t;
  stopLoop();
  setTime(base + dir * st * MIN);
}

let playTimer = null;
function play(on) {
  state.playing = on;
  $('btn-play').textContent = on ? '❚❚' : '▶';
  $('btn-play').title = on ? 'Pausa (spazio)' : 'Riproduci (spazio)';
  clearInterval(playTimer);
  if (!on) return;
  const tick = () => {
    const st = state.pick ? state.pick.s.stepMin : 10;
    let t = (state.pick ? state.pick.f.time : state.t) + st * MIN;
    if (state.loop && t > state.loop.end) t = state.loop.start;
    if (t > tRange()[1]) return play(false);
    state.t = t; state.live = false;
    scheduleUpdate();
  };
  playTimer = setInterval(tick, Number($('speed').value));
}
function stopLoop() { state.loop = null; $('btn-loop').classList.remove('active'); }

// ------------------------------------------------------------------ ricerca luoghi
async function search(q) {
  const list = $('search-results');
  list.replaceChildren();
  q = q.trim().slice(0, 100);
  if (q.length < 2) { list.hidden = true; return; }
  list.hidden = false;
  list.append(el('li', { class: 'muted', text: 'Ricerca…' }));
  try {
    const { body } = await safeFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=it&format=json`);
    list.replaceChildren();
    const res = Array.isArray(body?.results) ? body.results : [];
    if (!res.length) list.append(el('li', { class: 'muted', text: 'Nessun risultato' }));
    for (const r of res) {
      if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
      const label = [r.name, r.admin1, r.country].filter(x => typeof x === 'string' && x).join(', ');
      const li = el('li', { tabindex: '0', text: label });
      const choose = () => { goTo(r.latitude, r.longitude, label, 9); list.hidden = true; $('search').value = label; };
      li.addEventListener('click', choose);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') choose(); });
      list.append(li);
    }
  } catch (e) {
    list.replaceChildren(el('li', { class: 'muted', text: 'Errore di ricerca: ' + e.message }));
  }
}

function goTo(lat, lon, label, zoom) {
  map.setView([lat, lon], zoom ?? Math.max(map.getZoom(), 8));
  placeMarker.setLatLng([lat, lon]);
  prefs.place = label;
  $('place').textContent = label;
  savePrefs();
}

// ------------------------------------------------------------------ eventi UI
function bindUI() {
  const slider = $('slider');
  slider.min = String(-RANGE_MIN); slider.max = String(RANGE_MIN); slider.step = String(SLIDER_STEP);
  slider.addEventListener('input', () => { stopLoop(); setTime(state.anchor + Number(slider.value) * MIN); });

  let dragging = false;
  const fromPointer = e => {
    const r = tlCanvas.getBoundingClientRect();
    stopLoop(); setTime(tOf(e.clientX - r.left, r.width));
  };
  tlCanvas.addEventListener('pointerdown', e => { dragging = true; tlCanvas.setPointerCapture(e.pointerId); fromPointer(e); });
  tlCanvas.addEventListener('pointermove', e => { if (dragging) fromPointer(e); });
  tlCanvas.addEventListener('pointerup', () => { dragging = false; });

  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-next').addEventListener('click', () => step(1));
  $('btn-play').addEventListener('click', () => play(!state.playing));
  $('btn-live').addEventListener('click', () => { stopLoop(); goLive(); });
  $('btn-loop').addEventListener('click', () => {
    if (state.loop) { stopLoop(); play(false); return; }
    const end = latestObservation();
    state.loop = { start: end - 2 * HOUR, end };
    $('btn-loop').classList.add('active');
    setTime(state.loop.start);
    play(true);
  });
  $('btn-day-back').addEventListener('click', () => { stopLoop(); setTime(state.t - DAY); });
  $('btn-day-fwd').addEventListener('click', () => { stopLoop(); setTime(state.t + DAY); });
  $('speed').addEventListener('change', () => { if (state.playing) play(true); });

  const opacity = $('opacity');
  opacity.value = String(prefs.opacity);
  opacity.addEventListener('input', () => { prefs.opacity = Number(opacity.value); frames.setOpacity(prefs.opacity); savePrefs(); });

  const mode = $('mode');
  mode.append(el('option', { value: 'auto', text: 'Automatica (fonte migliore)' }));
  for (const s of SOURCES) mode.append(el('option', { value: s.id, text: s.short }));
  mode.value = prefs.mode;
  mode.addEventListener('change', () => { prefs.mode = mode.value; savePrefs(); scheduleUpdate(); });

  const base = $('basemap');
  base.value = prefs.basemap;
  base.addEventListener('change', () => { prefs.basemap = base.value; savePrefs(); setBasemap(base.value); drawTimeline(); });

  const input = $('search');
  let st;
  input.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => search(input.value), 400); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(st); search(input.value); }
    if (e.key === 'Escape') $('search-results').hidden = true;
    if (e.key === 'ArrowDown') $('search-results').querySelector('li[tabindex]')?.focus();
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) $('search-results').hidden = true; });

  $('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return setMapNote('Geolocalizzazione non disponibile');
    navigator.geolocation.getCurrentPosition(
      p => goTo(p.coords.latitude, p.coords.longitude, 'La mia posizione', 9),
      e => setMapNote('Posizione non disponibile: ' + e.message),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  $('btn-ratings').addEventListener('click', () => {
    const p = $('ratings');
    p.hidden = !p.hidden;
    if (!p.hidden) renderRatings();
  });
  $('btn-ratings-close').addEventListener('click', () => { $('ratings').hidden = true; });
  $('btn-rerate').addEventListener('click', async () => {
    $('btn-rerate').disabled = true;
    await rating.rateAll();
    $('btn-rerate').disabled = false;
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches('input[type=search], input[type=text], select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? setTime(state.t - HOUR) : step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? setTime(state.t + HOUR) : step(1); }
    else if (e.key === ' ' && !e.target.matches('button')) { e.preventDefault(); play(!state.playing); }
  });

  map.on('moveend', () => {
    const c = map.getCenter();
    prefs.lat = c.lat; prefs.lon = ((c.lng + 540) % 360) - 180; prefs.zoom = map.getZoom(); savePrefs();
    schedulePointFetch();
    timelineLegend();
    if (!$('ratings').hidden) renderRatings();
    scheduleUpdate();
  });
  window.addEventListener('resize', drawTimeline);
}

// ------------------------------------------------------------------ avvio
window.addEventListener('error', e => setMapNote('Errore: ' + e.message));
window.addEventListener('unhandledrejection', e => setMapNote('Errore: ' + (e.reason?.message || e.reason)));
function reanchor() {
  state.anchor = floorTo(Date.now(), SLIDER_STEP);
  if (state.live) state.t = latestObservation();
  scheduleUpdate();
}

bindUI();
$('place').textContent = prefs.place;
rating.onChange(() => {
  if (state.live) state.t = latestObservation();
  scheduleUpdate();
  timelineLegend();
  if (!$('ratings').hidden) renderRatings();
});
rating.start();
setInterval(reanchor, MIN);
schedulePointFetch();
timelineLegend();
drawTimeline();
setMapNote('Valutazione delle fonti in corso…');
