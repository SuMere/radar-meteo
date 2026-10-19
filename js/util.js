// Utility condivise: fetch sicuro con allowlist, tempo, storage protetto.

export const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

// Unici host con cui l'app può comunicare via fetch (deve coincidere con la CSP).
export const ALLOWED_HOSTS = new Set([
  'api.rainviewer.com',
  'tilecache.rainviewer.com',
  'maps.dwd.de',
  'mesonet.agron.iastate.edu',
  'view.eumetsat.int',
  'gibs.earthdata.nasa.gov',
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
]);

const MAX_BYTES = 8 * 1024 * 1024;

export async function safeFetch(url, { as = 'json', timeout = 15000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error('Host non consentito: ' + u.hostname);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(u.href, {
      signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      cache: 'no-store', mode: 'cors', redirect: 'follow',
    });
    const final = new URL(r.url || u.href);
    if (final.protocol !== 'https:' || !ALLOWED_HOSTS.has(final.hostname)) {
      throw new Error('Redirect verso host non consentito');
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const len = Number(r.headers.get('content-length'));
    if (len > MAX_BYTES) throw new Error('Risposta troppo grande');
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('Risposta troppo grande');
    const body = as === 'json' ? JSON.parse(text) : text;
    return { body, ms: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML non valido');
  return doc;
}

export function parseTime(s) {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error('Data non valida: ' + s);
  return t;
}

// Intervallo ISO "start/end/PERIOD" (eventualmente lista separata da virgole) → {start, end}
export function parseIsoInterval(text) {
  const parts = text.trim().split(',').map(p => p.trim()).filter(Boolean);
  const first = parts[0].split('/'), last = parts[parts.length - 1].split('/');
  return { start: parseTime(first[0]), end: parseTime(last.length > 1 ? last[1] : last[0]) };
}

export const snap = (t, stepMin) => Math.round(t / (stepMin * MIN)) * stepMin * MIN;
export const floorTo = (t, stepMin) => Math.floor(t / (stepMin * MIN)) * stepMin * MIN;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const pad = n => String(n).padStart(2, '0');
export function isoZ(t, ms = false) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${ms ? '.000' : ''}Z`;
}
export function compactUTC(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export function fmtAge(ms) {
  ms = Math.abs(ms);
  const m = Math.round(ms / MIN);
  let s;
  if (m < 60) s = `${m} min`;
  else if (m < 48 * 60) s = `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
  else s = `${Math.round(m / 1440 * 10) / 10} g`;
  return s;
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage non disponibile */ }
  },
};

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
