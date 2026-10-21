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
    layer: ['wind', 'uv'].includes(p.layer) ? p.layer : 'precip',
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
}
const frames = new FrameManager();

// ------------------------------------------------------------------ griglia modello (Open-Meteo)
const PRECIP_STOPS = [
  [0.1, [155, 225, 255, 120]], [0.5, [67, 176, 255, 170]], [1, [26, 115, 232, 200]],
  [2, [34, 197, 94, 210]], [5, [250, 204, 21, 220]], [10, [249, 115, 22, 230]],
  [20, [239, 68, 68, 235]], [50, [162, 28, 175, 240]],
];
// Vento in km/h (rampa continua), indice UV con la scala colori OMS.
const WIND_STOPS = [
  [0, [98, 113, 183, 150]], [10, [57, 154, 192, 160]], [20, [77, 186, 129, 170]], [30, [180, 200, 70, 175]],
  [40, [235, 180, 60, 185]], [55, [225, 110, 60, 195]], [70, [200, 60, 90, 205]], [90, [150, 50, 160, 215]],
];
const UV_STOPS = [
  [0.5, [41, 149, 0, 150]], [3, [247, 228, 0, 180]], [6, [248, 89, 0, 200]], [8, [216, 0, 29, 215]], [11, [107, 73, 200, 225]],
];
const stepColor = stops => v => {
  if (!(v >= stops[0][0])) return [0, 0, 0, 0];
  for (let i = stops.length - 1; i >= 0; i--) if (v >= stops[i][0]) return stops[i][1];
  return stops[0][1];
};
const precipColor = stepColor(PRECIP_STOPS);
// Interpolazione lineare tra i colori delle soglie.
const rampColor = stops => v => {
  if (!Number.isFinite(v)) return [0, 0, 0, 0];
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (v - a) / (b - a);
      return ca.map((x, k) => Math.round(x + (cb[k] - x) * f));
    }
  }
  return stops[stops.length - 1][1];
};

// Variabili del modello visualizzabili. offset: indice orario del valore riferito a [ft, ft+1h]
// (precipitazione Open-Meteo a T = somma dell'ora precedente; vento e UV sono istantanei).
const VARS = {
  precip: { params: ['precipitation'], offset: 1, stops: PRECIP_STOPS, color: precipColor, min: 0.05,
    bar: v => Math.min(1, Math.sqrt(v / 10)), legend: 'Modello · pioggia mm/h', barLabel: 'pioggia al centro (modello)' },
  wind: { params: ['wind_speed_10m', 'wind_direction_10m'], offset: 0, stops: WIND_STOPS, color: rampColor(WIND_STOPS), min: 0,
    bar: v => Math.min(1, Math.sqrt(v / 60)), legend: 'Modello · vento a 10 m, km/h', barLabel: 'vento al centro (modello)' },
  uv: { params: ['uv_index'], offset: 0, stops: UV_STOPS, color: stepColor(UV_STOPS), min: 0.05,
    bar: v => Math.min(1, v / 11), legend: 'Modello · indice UV', barLabel: 'indice UV al centro (modello)' },
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const compass = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function uvCategory(v) {
  if (v < 3) return { label: 'basso', advice: 'Nessuna protezione necessaria.' };
  if (v < 6) return { label: 'moderato', advice: 'Protezione consigliata: crema solare, cappello e occhiali; ombra nelle ore centrali.' };
  if (v < 8) return { label: 'alto', advice: 'Protezione necessaria: crema SPF 30+, cappello, occhiali; riduci l\'esposizione tra le 11 e le 16.' };
  if (v < 11) return { label: 'molto alto', advice: 'Protezione indispensabile: evita il sole nelle ore centrali, crema SPF 50+.' };
  return { label: 'estremo', advice: 'Evita l\'esposizione: la pelle non protetta si scotta in pochi minuti.' };
}

// Frecce del vento (direzione verso cui soffia) al centro di ogni cella della griglia.
function drawWindArrows(ctx, d, idx, cell) {
  const sp = d.values.wind_speed_10m, dir = d.values.wind_direction_10m;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let r = 0; r < d.ny; r++) for (let c = 0; c < d.nx; c++) {
    const i = r * d.nx + c, s = sp[i][idx], a = dir[i][idx];
    if (!Number.isFinite(s) || !Number.isFinite(a) || s < 1) continue;
    const b = (a + 180) * Math.PI / 180, dx = Math.sin(b), dy = -Math.cos(b);
    const k = cell / 24, len = (4 + Math.min(1, s / 60) * 6) * k, cx = (c + 0.5) * cell, cy = (r + 0.5) * cell;
    const hx = cx + dx * len, hy = cy + dy * len;
    const path = new Path2D();
    path.moveTo(cx - dx * len, cy - dy * len); path.lineTo(hx, hy);
    for (const rot of [0.5, -0.5]) {
      const bx = -dx * Math.cos(rot) + dy * Math.sin(rot), by = -dx * Math.sin(rot) - dy * Math.cos(rot);
      path.moveTo(hx, hy); path.lineTo(hx + bx * 4 * k, hy + by * 4 * k);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3 * k; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(15,23,42,0.9)'; ctx.lineWidth = 1.4 * k; ctx.stroke(path);
  }
}

// Open-Meteo conta ogni punto della griglia come una chiamata (limite gratuito: 600/min,
// 5000/ora, 10000/giorno). Per restare nei limiti: una sola richiesta con tutte le
// variabili, area e intervallo ampi, cache delle ultime griglie e pausa dopo un 429.
const GRID_POINTS = 96;
const GRID_PARAMS = [...new Set(Object.values(VARS).flatMap(v => v.params))];
const omLimit = {
  until: 0, backoff: 60e3,
  check() {
    const wait = this.until - Date.now();
    if (wait <= 0) return;
    const e = new Error(`Troppe richieste a Open-Meteo: nuovo tentativo tra ${Math.ceil(wait / 1000)} s`);
    e.rateLimited = true;
    throw e;
  },
  hit() {
    if (this.until > Date.now()) return; // già in pausa (altra richiesta concorrente)
    this.until = Date.now() + this.backoff;
    setTimeout(() => { scheduleUpdate(); schedulePointFetch(); }, this.backoff + 500);
    this.backoff = Math.min(this.backoff * 2, 10 * MIN);
  },
  ok() { this.backoff = 60e3; },
};
async function omFetch(url, opts) {
  omLimit.check();
  try {
    const res = await safeFetch(url, opts);
    omLimit.ok();
    return res;
  } catch (e) {
    if (e.status === 429) { omLimit.hit(); omLimit.check(); }
    throw e;
  }
}

class ModelGrid {
  constructor() { this.data = null; this.cache = []; this.pending = null; this.renders = new Map(); this.seq = 0; }
  // Una griglia va bene se copre la vista, l'ora richiesta e non è troppo grossolana per lo zoom.
  _fits(d, b, z, t) {
    return d && d.bounds.contains(b) && z - d.zoom <= 2 && t >= d.t0 && t + HOUR <= d.t0 + (d.len - 1) * HOUR;
  }
  _find(b, z, t) {
    const d = this.cache.find(g => this._fits(g, b, z, t));
    if (d) this.data = d;
    return d;
  }
  async ensure(t, stale = () => false) {
    const b = map.getBounds(), z = map.getZoom();
    if (this._find(b, z, t)) return this.data;
    while (this.pending) {
      await this.pending.catch(() => {});
      if (this._find(b, z, t)) return this.data;
    }
    if (stale()) throw new Error('superato'); // la vista è già cambiata: non sprecare una richiesta
    this.pending = this._fetch(b.pad(0.5), z, t);
    try { return await this.pending; } finally { this.pending = null; }
  }
  async _fetch(pb, z, t) {
    const s = Math.max(-84, pb.getSouth()), n = Math.min(84, pb.getNorth());
    let w = pb.getWest(), e = pb.getEast();
    if (e - w > 360) { w = -180; e = 180; }
    const size = map.getSize(), aspect = clamp(size.x / Math.max(1, size.y), 0.4, 3);
    const ny = clamp(Math.round(Math.sqrt(GRID_POINTS / aspect)), 4, 14), nx = clamp(Math.floor(GRID_POINTS / ny), 4, 18);
    const lats = [], lons = [];
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      lats.push((n - (r + 0.5) * (n - s) / ny).toFixed(3));
      let lon = w + (c + 0.5) * (e - w) / nx;
      lon = ((lon + 540) % 360) - 180;
      lons.push(lon.toFixed(3));
    }
    const h0 = floorTo(t, 60) - 2 * DAY, h1 = floorTo(t, 60) + 4 * DAY; // < 2 settimane: 1 chiamata per punto
    const hh = x => isoZ(x).slice(0, 16);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
      `&hourly=${GRID_PARAMS.join(',')}&timezone=GMT&models=best_match&start_hour=${hh(h0)}&end_hour=${hh(h1)}`;
    const { body } = await omFetch(url, { timeout: 25000 });
    const arr = Array.isArray(body) ? body : [body];
    if (arr.length !== nx * ny) throw new Error('Griglia incompleta');
    const times = arr[0]?.hourly?.time;
    if (!Array.isArray(times) || !times.length) throw new Error('Griglia senza dati');
    const t0 = Date.parse(times[0] + 'Z');
    const values = {};
    for (const p of GRID_PARAMS) values[p] = arr.map(pt => (pt.hourly?.[p] || []).map(x => (Number.isFinite(x) ? x : NaN)));
    this.data = { id: ++this.seq, bounds: L.latLngBounds([s, w], [n, e]), zoom: z, nx, ny, t0, len: times.length, values };
    this.cache = [this.data, ...this.cache].slice(0, 4);
    if (this.renders.size > 150) this.renders.clear();
    return this.data;
  }
  // Valore della variabile corrente per l'ora [ft, ft+1h].
  render(ft) {
    const d = this.data, v = prefs.layer, cfg = VARS[v];
    const idx = Math.round((ft - d.t0) / HOUR) + cfg.offset;
    if (idx < 0 || idx >= d.len) return null;
    const key = `om:${d.id}:${v}:${idx}`;
    if (this.renders.has(key)) return this.renders.get(key);
    const main = d.values[cfg.params[0]];
    const small = document.createElement('canvas');
    small.width = d.nx; small.height = d.ny;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(d.nx, d.ny);
    for (let i = 0; i < d.nx * d.ny; i++) img.data.set(cfg.color(main[i][idx]), i * 4);
    sctx.putImageData(img, 0, 0);
    const arrows = v === 'wind' && !fieldAnim.enabled; // frecce statiche solo con "riduci movimento"
    const cell = arrows ? 64 : 24; // più risoluzione per frecce nitide
    const big = document.createElement('canvas');
    big.width = d.nx * cell; big.height = d.ny * cell;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, big.width, big.height);
    if (arrows) drawWindArrows(bctx, d, idx, cell);
    const out = { key, idx, url: big.toDataURL('image/png'), bounds: d.bounds };
    this.renders.set(key, out);
    return out;
  }
  valueAt(lat, lon, ft) {
    const d = this.data;
    if (!d || !d.bounds.contains([lat, lon])) return null;
    const cfg = VARS[prefs.layer];
    const r = Math.floor((d.bounds.getNorth() - lat) / (d.bounds.getNorth() - d.bounds.getSouth()) * d.ny);
    const c = Math.floor((lon - d.bounds.getWest()) / (d.bounds.getEast() - d.bounds.getWest()) * d.nx);
    const idx = Math.round((ft - d.t0) / HOUR) + cfg.offset;
    return d.values[cfg.params[0]][clamp(r, 0, d.ny - 1) * d.nx + clamp(c, 0, d.nx - 1)]?.[idx] ?? null;
  }
}
const modelGrid = new ModelGrid();

// ------------------------------------------------------------------ vento e UV animati
// Vento: particelle trasportate dal campo del modello, con scie che sfumano.
// UV: bagliori che compaiono, salgono piano e svaniscono; densità e dimensione
// crescono con l'indice UV (nessuno di notte).
// Il campo (vento: u, v in km/h; UV: indice) è interpolato bilinearmente dalla griglia
// su una maglia di pixel dello schermo, ricostruita a ogni spostamento o cambio d'ora.
const FIELD_STEP = 8;    // px tra i nodi della maglia
// Velocità visiva (px per frame a 60 Hz) non lineare: anche il vento debole scorre
// in modo percepibile (5 km/h ≈ 35 px/s, 20 km/h ≈ 85 px/s, 100 km/h ≈ 220 px/s).
const windPx = kmh => 0.22 * Math.pow(kmh, 0.62);
const ANIMATED = new Set(['wind', 'uv']);
function glowSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,245,1)');
  grad.addColorStop(0.25, 'rgba(255,240,180,0.7)');
  grad.addColorStop(1, 'rgba(255,220,120,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  return c;
}
class FieldAnimation {
  constructor() {
    this.canvas = el('canvas', { class: 'field-canvas', 'aria-hidden': 'true' });
    this.canvas.hidden = true;
    map.getContainer().append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.src = null; this.field = null; this.particles = []; this.raf = 0; this.moving = false;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.buckets = [[], [], [], []];
    this.sprite = glowSprite();
    map.on('movestart zoomstart', () => { this.moving = true; this._pause(); });
    map.on('moveend', () => { this.moving = false; this._rebuild(); });
    map.on('resize', () => this._rebuild());
  }
  get enabled() { return !this.reduced.matches; }
  setOpacity(o) { this.canvas.style.opacity = String(0.4 + 0.6 * o); }
  setSource(d, idx, mode) {
    if (!this.enabled) return this.stop();
    if (this.src?.d === d && this.src.idx === idx && this.src.mode === mode) return;
    const n = d.nx * d.ny, u = new Float32Array(n), v = new Float32Array(n);
    if (mode === 'wind') {
      // u, v per cella: componenti verso cui soffia (x = est, y = sud sullo schermo).
      const sp = d.values.wind_speed_10m, dir = d.values.wind_direction_10m;
      for (let i = 0; i < n; i++) {
        const s = sp[i][idx], a = dir[i][idx];
        if (!Number.isFinite(s) || !Number.isFinite(a)) { u[i] = v[i] = NaN; continue; }
        const b = (a + 180) * Math.PI / 180;
        u[i] = s * Math.sin(b); v[i] = -s * Math.cos(b);
      }
    } else {
      const uv = d.values.uv_index;
      for (let i = 0; i < n; i++) u[i] = Number.isFinite(uv[i][idx]) ? uv[i][idx] : NaN;
    }
    if (this.src && this.src.mode !== mode) this._pause();
    this.src = { d, idx, mode, u, v };
    this._rebuild();
  }
  stop() {
    if (!this.src) return;
    this.src = null; this.field = null;
    this._pause();
  }
  _pause() {
    cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.hidden = true;
    this.particles = [];
  }
  // Campo della griglia (bilineare tra i centri delle celle) in un punto geografico.
  _sample(lat, lon) {
    const { d, u, v } = this.src, b = d.bounds;
    const fr = (b.getNorth() - lat) / (b.getNorth() - b.getSouth()) * d.ny - 0.5;
    const fc = (lon - b.getWest()) / (b.getEast() - b.getWest()) * d.nx - 0.5;
    if (fr < -0.5 || fr > d.ny - 0.5 || fc < -0.5 || fc > d.nx - 0.5) return null;
    const r = clamp(fr, 0, d.ny - 1), c = clamp(fc, 0, d.nx - 1);
    const r0 = Math.floor(r), c0 = Math.floor(c), r1 = Math.min(r0 + 1, d.ny - 1), c1 = Math.min(c0 + 1, d.nx - 1);
    const fy = r - r0, fx = c - c0;
    const i00 = r0 * d.nx + c0, i01 = r0 * d.nx + c1, i10 = r1 * d.nx + c0, i11 = r1 * d.nx + c1;
    const mix = a => (a[i00] * (1 - fx) + a[i01] * fx) * (1 - fy) + (a[i10] * (1 - fx) + a[i11] * fx) * fy;
    const uu = mix(u), vv = mix(v);
    return Number.isFinite(uu) && Number.isFinite(vv) ? [uu, vv] : null;
  }
  _rebuild() {
    if (!this.src || this.moving) return;
    const size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!size.x || !size.y) return;
    this.w = size.x; this.h = size.y; this.dpr = dpr;
    const cw = Math.round(size.x * dpr), ch = Math.round(size.y * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const cols = Math.ceil(size.x / FIELD_STEP) + 1, rows = Math.ceil(size.y / FIELD_STEP) + 1;
    const fu = new Float32Array(cols * rows), fv = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const ll = map.containerPointToLatLng([x * FIELD_STEP, y * FIELD_STEP]);
      const s = this._sample(ll.lat, ll.lng), i = y * cols + x;
      fu[i] = s ? s[0] : NaN; fv[i] = s ? s[1] : NaN;
    }
    this.field = { cols, rows, fu, fv };
    const uv = this.src.mode === 'uv';
    const target = Math.round(clamp(size.x * size.y / (uv ? 900 : 450), uv ? 120 : 200, uv ? 1500 : 3500));
    if (this.particles.length > target) this.particles.length = target;
    while (this.particles.length < target) this.particles.push(this._spawn({}, true));
    this.canvas.hidden = false;
    if (!this.raf) this.raf = requestAnimationFrame(this._tick);
  }
  _spawn(p, initial = false) {
    p.x = Math.random() * this.w; p.y = Math.random() * this.h;
    if (this.src?.mode === 'uv') {
      // Accettazione proporzionale all'indice UV: più bagliori dove il sole è più forte.
      for (let k = 0; k < 4; k++) {
        const f = this.field && this._at(p.x, p.y);
        if (f && f[0] >= 0.5 && Math.random() * 9 < f[0]) break;
        p.x = Math.random() * this.w; p.y = Math.random() * this.h;
      }
      p.max = 70 + Math.random() * 90; p.ph = Math.random() * 100;
    } else p.max = 90 + Math.random() * 110;
    p.age = initial ? Math.random() * p.max : 0;
    return p;
  }
  _at(x, y) {
    const f = this.field, gx = x / FIELD_STEP, gy = y / FIELD_STEP;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    if (x0 < 0 || y0 < 0 || x0 >= f.cols - 1 || y0 >= f.rows - 1) return null;
    const fx = gx - x0, fy = gy - y0, i = y0 * f.cols + x0;
    const mix = a => (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + f.cols] * (1 - fx) + a[i + f.cols + 1] * fx) * fy;
    const u = mix(f.fu), v = mix(f.fv);
    return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null;
  }
  _tick = () => {
    this.raf = requestAnimationFrame(this._tick);
    if (!this.field) return;
    // Passo normalizzato a 60 Hz: stessa velocità su schermi a frequenza diversa.
    const now = performance.now(), dt = this.last ? clamp((now - this.last) / (1000 / 60), 0.25, 3) : 1;
    this.last = now;
    const ctx = this.ctx, { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.src.mode === 'uv') return this._tickUV(ctx, w, h, dt);
    // Sfuma le scie esistenti mantenendo la trasparenza del canvas.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${Math.pow(0.955, dt)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const B = this.buckets;
    for (const b of B) b.length = 0;
    for (const p of this.particles) {
      const vel = (p.age += dt) < p.max ? this._at(p.x, p.y) : null;
      if (!vel) { this._spawn(p); continue; }
      const s = Math.hypot(vel[0], vel[1]), k = s > 0 ? windPx(s) / s * dt : 0;
      const nx = p.x + vel[0] * k, ny = p.y + vel[1] * k;
      B[s < 10 ? 0 : s < 25 ? 1 : s < 45 ? 2 : 3].push(p.x, p.y, nx, ny);
      p.x = nx; p.y = ny;
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.5;
    const alpha = [0.45, 0.65, 0.85, 1];
    for (let k = 0; k < B.length; k++) {
      const seg = B[k];
      if (!seg.length) continue;
      ctx.strokeStyle = `rgba(255,255,255,${alpha[k]})`;
      ctx.beginPath();
      for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); }
      ctx.stroke();
    }
  };
  _tickUV(ctx, w, h, dt) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const f = (p.age += dt) < p.max ? this._at(p.x, p.y) : null;
      if (!f || f[0] < 0.5) { this._spawn(p); continue; }
      const uv = f[0];
      p.y -= 0.12 * dt; p.x += Math.sin((p.age + p.ph) / 25) * 0.12 * dt;
      const a = Math.sin(Math.PI * p.age / p.max) * Math.min(1, 0.3 + uv / 10);
      const r = 3 + Math.min(1, uv / 11) * 5;
      ctx.globalAlpha = a * 0.85;
      ctx.drawImage(this.sprite, p.x - r, p.y - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
const fieldAnim = new FieldAnimation();
fieldAnim.setOpacity(prefs.opacity);

const modelLegend = L.control({ position: 'bottomleft' });
let legendVar = null;
modelLegend.onAdd = () => {
  const cfg = VARS[legendVar];
  const box = el('div', { class: 'legend' }, el('div', { class: 'muted small', text: cfg.legend }));
  for (const [v, c] of cfg.stops) {
    const sw = el('i');
    sw.style.background = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
    box.append(el('span', {}, sw, String(v)));
  }
  return box;
};
// Su schermi piccoli la legenda va in alto a destra, lontano dall'attribuzione.
const compactMQ = window.matchMedia('(max-width: 700px), (max-height: 500px)');
const legendPos = () => (compactMQ.matches ? 'topright' : 'bottomleft');
compactMQ.addEventListener('change', () => modelLegend.setPosition(legendPos()));
function showModelLegend(on) {
  const v = on ? prefs.layer : null;
  if (v === legendVar) return;
  modelLegend.setPosition(legendPos());
  if (legendVar) modelLegend.remove();
  legendVar = v;
  if (v) modelLegend.addTo(map);
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
  if (!ANIMATED.has(prefs.layer)) fieldAnim.stop();
  const c = map.getCenter();
  // Vento e UV esistono solo come dato di modello.
  const cands = prefs.layer === 'precip' ? candidatesAt(state.t, c.lat, c.lng) : [];
  state.cands = cands;
  let pick = null;
  if (prefs.layer !== 'precip') {
    const s = byId.openmeteo, f = s.frameAt(state.t);
    pick = f ? { s, f, eff: rating.score(s.id) * s.qualityAt(state.t, f) } : null;
  } else if (prefs.mode === 'auto') pick = cands[0] || null;
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

  if (!pick) { frames.hide(); fieldAnim.stop(); setMapNote('Nessuna fonte con dati per questo istante e luogo.'); return; }
  if (pick.s.id === 'openmeteo') {
    setMapNote('Carico la griglia del modello…');
    try {
      await modelGrid.ensure(pick.f.time, () => token !== updateToken);
    } catch (e) {
      if (token === updateToken) { frames.hide(); fieldAnim.stop(); setMapNote(e.rateLimited ? e.message : 'Errore modello: ' + e.message); }
      return;
    }
    if (token !== updateToken) return;
    const r = modelGrid.render(pick.f.time);
    if (!r) { frames.hide(); fieldAnim.stop(); setMapNote('Ora fuori dalla griglia del modello.'); return; }
    frames.show(r.key, () => L.imageOverlay(r.url, r.bounds, {
      pane: 'radar', interactive: false, attribution: pick.s.attribution, className: 'model-overlay',
    }));
    if (ANIMATED.has(prefs.layer)) fieldAnim.setSource(modelGrid.data, r.idx, prefs.layer);
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
  const gi = $('goto-time');
  if (document.activeElement !== gi) gi.value = toLocalInput(state.t);
}

const pad2 = n => String(n).padStart(2, '0');
function toLocalInput(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function updateGotoRange() {
  const [a, b] = tRange(), gi = $('goto-time');
  gi.min = toLocalInput(a); gi.max = toLocalInput(b);
}
function gotoInputTime() {
  const gi = $('goto-time');
  const t = new Date(gi.value).getTime(); // "AAAA-MM-GGTHH:MM" senza fuso = ora locale
  if (!gi.value || !Number.isFinite(t) || !gi.checkValidity()) { gi.reportValidity(); return; }
  stopLoop(); play(false);
  setTime(t);
  gi.blur();
}

function renderSourceInfo() {
  const box = $('source-info');
  box.replaceChildren();
  const p = state.pick;
  if (!p) {
    box.append(el('span', { class: 'muted', text: prefs.mode === 'auto' || prefs.layer !== 'precip' ? 'Nessun dato disponibile' : `${byId[prefs.mode].short}: nessun dato in questo istante` }));
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
  renderConditions(box, p);
}

// Pioggia, vento e indice UV al centro della mappa (serie puntuale del modello).
function renderConditions(box, p) {
  const c = map.getCenter();
  const parts = [];
  const rain = p.s.id === 'openmeteo' && prefs.layer === 'precip' ? modelGrid.valueAt(c.lat, c.lng, p.f.time) : pointValueAt(state.t, 'precipitation');
  if (rain != null && Number.isFinite(rain)) parts.push(`pioggia ${rain.toFixed(1)} mm/h`);
  const ws = pointValueAt(state.t, 'wind_speed_10m'), wd = pointValueAt(state.t, 'wind_direction_10m');
  const wg = pointValueAt(state.t, 'wind_gusts_10m');
  if (ws != null) parts.push(`vento ${Math.round(ws)} km/h${wd != null ? ' da ' + compass(wd) : ''}${wg != null ? `, raffiche ${Math.round(wg)}` : ''}`);
  const cond = el('span', { class: 'cond' });
  box.append(cond);
  if (parts.length) cond.append(el('span', { class: 'muted', text: ' · al centro (modello): ' + parts.join(' · ') }));
  const uv = pointValueAt(state.t, 'uv_index');
  if (uv == null) return;
  const cat = uvCategory(uv), max = uvDayMax(state.t);
  const maxTxt = max ? ` · max del giorno ${Math.round(max.v)} (${uvCategory(max.v).label}) alle ${fmtHM.format(max.t)}` : '';
  const badge = el('span', { class: 'badge uv', text: `UV ${Math.round(uv)} ${cat.label}`, title: cat.advice + (max && max.v >= 3 ? ` Picco del giorno: ${uvCategory(max.v).advice}` : '') });
  const col = UV_STOPS.findLast(st => Math.max(uv, 0.5) >= st[0])[1];
  badge.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
  badge.style.color = uv >= 8 || uv < 3 ? '#fff' : '#111';
  cond.append(badge, el('span', { class: 'muted', text: maxTxt }));
}

function uvDayMax(t) {
  const ser = point?.series.uv_index;
  if (!ser) return null;
  const d0 = new Date(t); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  let best = null;
  for (let i = 0; i < ser.length; i++) {
    const ti = point.t0 + i * HOUR;
    if (ti >= d0.getTime() && ti < d1.getTime() && Number.isFinite(ser[i]) && (!best || ser[i] > best.v)) best = { v: ser[i], t: ti };
  }
  return best;
}

// ------------------------------------------------------------------ serie puntuale + timeline
const POINT_PARAMS = ['precipitation', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'uv_index'];
let point = null; // { lat, lon, t0, series: { param: valori orari } }
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
    const { body } = await omFetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=${POINT_PARAMS.join(',')}&past_days=15&forecast_days=16&timezone=GMT&models=best_match`);
    const times = body?.hourly?.time;
    if (!Array.isArray(times) || !Array.isArray(body.hourly.precipitation)) throw new Error('dati mancanti');
    const series = {};
    for (const p of POINT_PARAMS) {
      const vals = Array.isArray(body.hourly[p]) ? body.hourly[p] : [];
      series[p] = vals.map(v => (Number.isFinite(v) ? v : NaN));
    }
    point = { lat: c.lat, lon: c.lng, t0: Date.parse(times[0] + 'Z'), series };
  } catch (e) {
    if (!e.rateLimited) point = null; // con il limite raggiunto si tiene l'ultima serie: si riprova dopo la pausa
  }
  drawTimeline();
  renderSourceInfo();
}
// Precipitazione: somma dell'ora successiva a t; le altre variabili: valore istantaneo all'ora di t.
function pointValueAt(t, param) {
  if (!point) return null;
  const i = Math.round((floorTo(t, 60) - point.t0) / HOUR) + (param === 'precipitation' ? 1 : 0);
  const v = point.series[param]?.[i];
  return Number.isFinite(v) ? v : null;
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

  // Variabile corrente al centro (modello) – barre orarie
  const barBase = h - 13, barMax = barBase - Math.min(26, h * 0.4);
  const cfg = VARS[prefs.layer], ser = point?.series[cfg.params[0]];
  if (ser) {
    for (let i = cfg.offset; i < ser.length; i++) {
      const v = ser[i];
      if (!(v > cfg.min)) continue;
      const t1 = point.t0 + (i - cfg.offset) * HOUR;
      const x = xOf(t1, w), x2 = xOf(t1 + HOUR, w);
      const hh = Math.max(1, cfg.bar(v) * barMax);
      const c = cfg.color(Math.max(v, cfg.stops[0][0]));
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.9)`;
      ctx.fillRect(x, barBase - hh, Math.max(1, x2 - x), hh);
    }
  }

  // Disponibilità delle fonti al centro mappa (una riga per fonte)
  const c = map.getCenter();
  let row = 0;
  for (const s of SOURCES) {
    if (disabled.has(s.id) || coverageOf(s, c.lat, c.lng) === false) continue;
    if (prefs.layer !== 'precip' && s.kind !== 'model') continue;
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
    if (prefs.layer !== 'precip' && s.kind !== 'model') continue;
    const sw = el('i'); sw.style.background = s.color;
    box.append(el('span', {}, sw, s.short));
  }
  const cfg = VARS[prefs.layer];
  const bar = el('i', { class: 'bars' });
  bar.style.background = `linear-gradient(${cfg.stops.map(st => `rgb(${st[1].slice(0, 3)})`).reverse().join(', ')})`;
  box.append(el('span', {}, bar, cfg.barLabel));
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
  if (prefs.layer !== 'precip') return Date.now();
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
  updateGotoRange();
  $('btn-goto').addEventListener('click', gotoInputTime);
  $('goto-time').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); gotoInputTime(); }
    if (e.key === 'Escape') { e.target.blur(); renderTimeLabel(); }
  });

  const opacity = $('opacity');
  opacity.value = String(prefs.opacity);
  opacity.addEventListener('input', () => { prefs.opacity = Number(opacity.value); frames.setOpacity(prefs.opacity); fieldAnim.setOpacity(prefs.opacity); savePrefs(); });

  const mode = $('mode');
  mode.append(el('option', { value: 'auto', text: 'Automatica (fonte migliore)' }));
  for (const s of SOURCES) mode.append(el('option', { value: s.id, text: s.short }));
  mode.value = prefs.mode;
  mode.addEventListener('change', () => { prefs.mode = mode.value; savePrefs(); scheduleUpdate(); });

  const layer = $('layer');
  layer.value = prefs.layer;
  mode.disabled = prefs.layer !== 'precip';
  layer.addEventListener('change', () => {
    prefs.layer = layer.value; savePrefs();
    mode.disabled = prefs.layer !== 'precip';
    if (state.live) state.t = latestObservation();
    timelineLegend(); drawTimeline(); scheduleUpdate();
  });

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

  // Menu impostazioni (solo layout mobile; su desktop i controlli sono sempre visibili).
  const menu = $('btn-menu'), settings = $('settings');
  const setMenu = open => { settings.classList.toggle('open', open); menu.setAttribute('aria-expanded', String(open)); menu.classList.toggle('active', open); };
  menu.addEventListener('click', e => { e.stopPropagation(); setMenu(!settings.classList.contains('open')); });
  document.addEventListener('click', e => { if (!e.target.closest('#settings, #btn-menu')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
  $('btn-ratings').addEventListener('click', () => setMenu(false));

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
    if (e.target.matches('input[type=search], input[type=text], input[type=datetime-local], select')) return;
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
  // Su mobile l'altezza della mappa cambia con le righe della barra inferiore e con le barre del browser.
  new ResizeObserver(() => { map.invalidateSize({ pan: false }); drawTimeline(); }).observe($('map'));
}

// ------------------------------------------------------------------ avvio
window.addEventListener('error', e => setMapNote('Errore: ' + e.message));
window.addEventListener('unhandledrejection', e => setMapNote('Errore: ' + (e.reason?.message || e.reason)));
function reanchor() {
  state.anchor = floorTo(Date.now(), SLIDER_STEP);
  updateGotoRange();
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
