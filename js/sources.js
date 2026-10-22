// Definizione delle fonti di dati di precipitazione.
// Ogni fonte espone: copertura geografica, finestra temporale disponibile,
// selezione del frame più vicino, creazione del layer e una "sonda" usata dal rating.

import { safeFetch, parseXml, parseIsoInterval, parseTime, snap, floorTo, isoZ, compactUTC, MIN, HOUR, DAY } from './util.js';

const inBox = (b, lat, lon) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

// Distanza angolare dal punto sub-satellitare (satelliti geostazionari).
function geoVisible(lat, lon, subLon, maxDeg) {
  const r = Math.PI / 180;
  const c = Math.cos(lat * r) * Math.cos((lon - subLon) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r <= maxDeg;
}

function wmsLayer(url, layerName, t, attribution) {
  return L.tileLayer.wms(url, {
    layers: layerName, styles: '', format: 'image/png', transparent: true,
    version: '1.3.0', time: isoZ(t, true), maxZoom: 19, attribution,
    pane: 'radar', updateWhenZooming: false, keepBuffer: 1,
  });
}

// Legge la dimensione "time" (e opzionale REFERENCE_TIME) da un GetCapabilities WMS.
function wmsTimeInfo(xmlText) {
  const doc = parseXml(xmlText);
  const out = {};
  for (const d of doc.getElementsByTagName('Dimension')) {
    const name = (d.getAttribute('name') || '').toLowerCase();
    if (name === 'time') Object.assign(out, parseIsoInterval(d.textContent));
    if (name === 'reference_time') {
      const def = d.getAttribute('default');
      if (def) out.reference = parseTime(def);
    }
  }
  const bb = doc.getElementsByTagName('EX_GeographicBoundingBox')[0];
  if (bb) {
    const g = tag => Number(bb.getElementsByTagName(tag)[0]?.textContent);
    const box = { w: g('westBoundLongitude'), e: g('eastBoundLongitude'), s: g('southBoundLatitude'), n: g('northBoundLatitude') };
    if (Object.values(box).every(Number.isFinite)) out.bbox = box;
  }
  if (!Number.isFinite(out.end)) throw new Error('Dimensione temporale assente');
  return out;
}

// ---------------------------------------------------------------- RainViewer
const RV_PATH = /^\/v2\/radar\/[A-Za-z0-9_-]{4,64}$/;
const rainviewer = {
  id: 'rainviewer', name: 'RainViewer – mosaico radar mondiale', short: 'RainViewer',
  kind: 'radar', color: '#38bdf8', resKm: 1.5, stepMin: 10, latencyMin: 15,
  homepage: 'https://www.rainviewer.com/',
  attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
  meta: { frames: [] },
  covers: () => true, // verificato puntualmente con la mappa di copertura
  async probe() {
    const { body, ms } = await safeFetch('https://api.rainviewer.com/public/weather-maps.json');
    if (body.host !== 'https://tilecache.rainviewer.com') throw new Error('Host tile inatteso');
    const frames = (body.radar?.past || [])
      .filter(f => Number.isFinite(f.time) && RV_PATH.test(f.path))
      .map(f => ({ t: f.time * 1000, path: f.path }))
      .sort((a, b) => a.t - b.t);
    if (!frames.length) throw new Error('Nessun frame');
    this.meta = { frames };
    return { ms, latest: frames[frames.length - 1].t, completeness: Math.min(1, frames.length / 13) };
  },
  window() {
    const f = this.meta.frames;
    return f.length ? { start: f[0].t, end: f[f.length - 1].t, obsEnd: f[f.length - 1].t } : null;
  },
  frameAt(t) {
    let best = null;
    for (const f of this.meta.frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
    if (!best || Math.abs(best.t - t) > 5 * MIN) return null;
    return { key: 'rv:' + best.path, time: best.t, path: best.path };
  },
  qualityAt: () => 1,
  layer(frame) {
    return L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      maxNativeZoom: 7, maxZoom: 19, attribution: this.attribution, pane: 'radar', updateWhenZooming: false, keepBuffer: 1,
    });
  },
  // La mappa di copertura RainViewer: pixel opaco = zona NON coperta dai radar.
  _cov: new Map(),
  coverage(lat, lon) {
    const key = `${Math.round(lat * 2) / 2},${Math.round(lon * 2) / 2}`;
    if (this._cov.has(key)) return this._cov.get(key);
    const p = new Promise(resolve => {
      const z = 6, n = 2 ** z;
      const x = (lon + 180) / 360 * n;
      const latR = lat * Math.PI / 180;
      const y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const a = ctx.getImageData(Math.floor((x % 1) * 256), Math.floor((y % 1) * 256), 1, 1).data[3];
          resolve(a < 128);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = `https://tilecache.rainviewer.com/v2/coverage/0/256/${z}/${Math.floor(x)}/${Math.floor(y)}/0/0_0.png`;
    });
    this._cov.set(key, p);
    return p;
  },
};

// ---------------------------------------------------------------- DWD (RADOLAN)
const DWD_WMS = 'https://maps.dwd.de/geoserver/dwd/wms';
const dwd = {
  id: 'dwd', name: 'DWD – composito radar Germania/Europa centrale (RADOLAN, con nowcast 2 h)', short: 'DWD radar',
  kind: 'radar', color: '#f59e0b', resKm: 1, stepMin: 5, latencyMin: 10,
  homepage: 'https://www.dwd.de/',
  attribution: 'Radar © <a href="https://www.dwd.de/">Deutscher Wetterdienst</a>',
  meta: { bbox: { w: 1.46, e: 18.73, s: 45.68, n: 56.22 } },
  covers(lat, lon) { return inBox(this.meta.bbox, lat, lon); },
  async probe() {
    const { body, ms } = await safeFetch('https://maps.dwd.de/geoserver/dwd/Niederschlagsradar/ows?service=WMS&request=GetCapabilities&version=1.3.0', { as: 'text' });
    const info = wmsTimeInfo(body);
    this.meta = { ...this.meta, ...info, bbox: info.bbox || this.meta.bbox };
    const obsEnd = info.reference || Math.min(info.end, Date.now());
    return { ms, latest: obsEnd };
  },
  window() {
    const m = this.meta;
    return m.end ? { start: m.start, end: m.end, obsEnd: m.reference || m.end } : null;
  },
  frameAt(t) {
    const m = this.meta;
    if (!m.end) return null;
    const ft = snap(t, 5);
    if (ft < m.start || ft > m.end) return null;
    return { key: 'dwd:' + ft, time: ft, nowcast: m.reference ? ft > m.reference : false };
  },
  qualityAt(t, frame) {
    if (!frame?.nowcast) return 1;
    const leadH = (frame.time - this.meta.reference) / HOUR;
    return Math.max(0.55, 0.85 - 0.15 * leadH); // nowcast: affidabilità decrescente
  },
  layer(frame) { return wmsLayer(DWD_WMS, 'dwd:Niederschlagsradar', frame.time, this.attribution); },
};

// ---------------------------------------------------------------- NOAA NEXRAD via IEM
// Archivio IEM: composito N0R (8 bit, 1995–2010), poi N0Q (più risoluzione in dBZ).
const NEXRAD_START = Date.UTC(1995, 0, 1), N0Q_START = Date.UTC(2010, 10, 14);
const nexrad = {
  id: 'nexrad', name: 'NOAA NEXRAD – composito radar USA (Iowa Environmental Mesonet)', short: 'NEXRAD USA',
  kind: 'radar', color: '#a78bfa', resKm: 1, stepMin: 5, latencyMin: 10,
  homepage: 'https://mesonet.agron.iastate.edu/',
  attribution: 'Radar NEXRAD © NOAA, tiles <a href="https://mesonet.agron.iastate.edu/">IEM</a>',
  meta: {},
  covers: (lat, lon) => inBox({ w: -127, e: -65, s: 23, n: 51 }, lat, lon),
  async probe() {
    const { body, ms } = await safeFetch('https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json');
    const latest = parseTime(body?.meta?.valid);
    this.meta = { start: NEXRAD_START, end: latest };
    return { ms, latest };
  },
  window() { return this.meta.end ? { start: this.meta.start, end: this.meta.end, obsEnd: this.meta.end } : null; },
  frameAt(t) {
    if (!this.meta.end) return null;
    const ft = snap(t, 5);
    if (ft < this.meta.start || ft > this.meta.end) return null;
    return { key: 'nx:' + ft, time: ft };
  },
  qualityAt: () => 1,
  layer(frame) {
    return L.tileLayer(`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-${frame.time < N0Q_START ? 'N0R' : 'N0Q'}-${compactUTC(frame.time)}/{z}/{x}/{y}.png`, {
      maxNativeZoom: 12, maxZoom: 19, attribution: this.attribution, pane: 'radar', updateWhenZooming: false, keepBuffer: 1,
    });
  },
};

// ---------------------------------------------------------------- EUMETSAT H SAF (satellite)
function eumetsat(id, layerName, subLon, label, short) {
  return {
    id, name: label, short,
    kind: 'satellite', color: id === 'hsaf_msg' ? '#34d399' : '#2dd4bf', resKm: 4, stepMin: 15, latencyMin: 90,
    homepage: 'https://view.eumetsat.int/',
    attribution: 'Precipitazioni H SAF © <a href="https://www.eumetsat.int/">EUMETSAT</a>',
    meta: {},
    covers: (lat, lon) => geoVisible(lat, lon, subLon, 65),
    async probe() {
      const [ws, ly] = layerName.split(':');
      const { body, ms } = await safeFetch(`https://view.eumetsat.int/geoserver/${ws}/${ly}/ows?service=WMS&request=GetCapabilities&version=1.3.0`, { as: 'text' });
      const info = wmsTimeInfo(body);
      this.meta = info;
      return { ms, latest: info.end };
    },
    window() { return this.meta.end ? { start: this.meta.start, end: this.meta.end, obsEnd: this.meta.end } : null; },
    frameAt(t) {
      if (!this.meta.end) return null;
      const ft = snap(t, 15);
      if (ft < this.meta.start || ft > this.meta.end) return null;
      return { key: id + ':' + ft, time: ft };
    },
    qualityAt: () => 1,
    layer(frame) { return wmsLayer('https://view.eumetsat.int/geoserver/wms', layerName, frame.time, this.attribution); },
  };
}

// ---------------------------------------------------------------- NASA IMERG (satellite)
const IMERG = 'IMERG_Precipitation_Rate_30min';
const IMERG_START = Date.UTC(1998, 0, 1); // inizio della serie IMERG V07 su GIBS
const imerg = {
  id: 'imerg', name: 'NASA GPM IMERG – precipitazione da satellite (globale, 30 min)', short: 'NASA IMERG',
  kind: 'satellite', color: '#f472b6', resKm: 10, stepMin: 30, latencyMin: 360,
  homepage: 'https://gpm.nasa.gov/data/imerg',
  attribution: 'IMERG © <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
  meta: {},
  covers: lat => Math.abs(lat) <= 60,
  async probe() {
    const day = d => isoZ(d).slice(0, 10);
    const now = Date.now();
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/${IMERG}/default/GoogleMapsCompatible_Level6/all/${day(now - 2 * DAY)}--${day(now + DAY)}.xml`;
    const { body, ms } = await safeFetch(url, { as: 'text' });
    const doc = parseXml(body);
    const dom = doc.getElementsByTagName('Domain')[0];
    if (!dom) throw new Error('Dominio temporale assente');
    const { end } = parseIsoInterval(dom.textContent);
    this.meta = { start: IMERG_START, end };
    return { ms, latest: end };
  },
  window() { return this.meta.end ? { start: this.meta.start, end: this.meta.end, obsEnd: this.meta.end } : null; },
  frameAt(t) {
    if (!this.meta.end) return null;
    const ft = floorTo(t, 30);
    if (ft < this.meta.start || ft > this.meta.end) return null;
    return { key: 'imerg:' + ft, time: ft };
  },
  qualityAt: () => 1,
  layer(frame) {
    return L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${IMERG}/default/${isoZ(frame.time)}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, {
      maxNativeZoom: 6, maxZoom: 19, attribution: this.attribution, pane: 'radar', updateWhenZooming: false, keepBuffer: 1,
    });
  },
};

// ---------------------------------------------------------------- Open-Meteo (modelli)
// Unica fonte che copre il futuro: griglia di punti dal modello migliore per la zona
// ("best_match": ICON-D2, AROME, HRRR, ... a seconda del luogo), fino a +16 giorni.
// Per il passato si usano tre archivi, in ordine di dettaglio:
//   forecast            ultimi ~3 mesi (stessi modelli della previsione)
//   historical-forecast dal 23/03/2021 (archivio delle corse dei modelli, con indice UV)
//   archive (ERA5)      dal 1940 (rianalisi ~25 km, senza indice UV)
export const OM_START = Date.UTC(1940, 0, 1);
export const OM_HIST_START = Date.UTC(2021, 2, 23);
const OM_FORECAST_PAST_DAYS = 90; // l'API forecast accetta ~92 giorni nel passato

// Fine della previsione: oggi (UTC) + 16 giorni.
export const omEnd = (now = Date.now()) => floorTo(now, 1440) + 16 * DAY - HOUR;

// Archivio Open-Meteo da usare per un intervallo che inizia a h0.
export function omEndpoint(h0, now = Date.now()) {
  if (h0 >= floorTo(now, 1440) - OM_FORECAST_PAST_DAYS * DAY) return { kind: 'forecast', url: 'https://api.open-meteo.com/v1/forecast', models: true };
  if (h0 >= OM_HIST_START) return { kind: 'historical', url: 'https://historical-forecast-api.open-meteo.com/v1/forecast', models: true };
  return { kind: 'era5', url: 'https://archive-api.open-meteo.com/v1/archive', models: false };
}
const openmeteo = {
  id: 'openmeteo', name: 'Open-Meteo – modelli numerici (best match) e rianalisi ERA5, dal 1940 a +16 g', short: 'Modello Open-Meteo',
  kind: 'model', color: '#94a3b8', resKm: 11, stepMin: 60, latencyMin: 0,
  homepage: 'https://open-meteo.com/',
  attribution: 'Modelli © <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0)',
  meta: {},
  covers: () => true,
  async probe() {
    const { body, ms } = await safeFetch('https://api.open-meteo.com/v1/forecast?latitude=45.07&longitude=7.69&hourly=precipitation&forecast_days=1');
    if (!Array.isArray(body?.hourly?.precipitation)) throw new Error('Risposta inattesa');
    return { ms, latest: Date.now() };
  },
  window() {
    const now = Date.now();
    return { start: OM_START, end: omEnd(now), obsEnd: now };
  },
  frameAt(t) {
    const w = this.window();
    const ft = floorTo(t, 60);
    if (ft < w.start || ft > w.end) return null;
    return { key: 'om:' + ft, time: ft, model: true };
  },
  qualityAt(t) {
    const leadD = (t - Date.now()) / DAY;
    if (leadD <= 0) return t < OM_HIST_START ? 0.8 : 0.9;
    return Math.max(0.3, 1 - leadD / 15 * 0.7);
  },
  layer: null, // gestito da ModelGrid in app.js
};

export const SOURCES = [dwd, nexrad, rainviewer, eumetsat('hsaf_msg', 'msg_fes:h60b', 0,
  'EUMETSAT H SAF H60B – precipitazione da satellite Meteosat (Europa/Africa)', 'H SAF Meteosat'),
  eumetsat('hsaf_iodc', 'msg_iodc:h63', 45.5,
  'EUMETSAT H SAF H63 – precipitazione da satellite Meteosat IODC (Asia/Oceano Indiano)', 'H SAF IODC'),
  imerg, openmeteo];

export const KIND_LABEL = { radar: 'Radar a terra', satellite: 'Satellite', model: 'Modello' };
