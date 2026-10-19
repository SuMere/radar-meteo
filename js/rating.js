// Sistema di rating delle fonti.
// Il punteggio (0-100) combina caratteristiche statiche (tipo di dato, risoluzione
// spaziale e temporale) con misure dinamiche raccolte periodicamente:
// affidabilità (successo delle sonde, media mobile esponenziale persistente),
// freschezza dell'ultimo dato rispetto alla latenza attesa, tempo di risposta e
// completezza della serie. Le misure vengono salvate nel browser e aggiornate
// ogni RATE_INTERVAL.

import { store, clamp, MIN } from './util.js';

export const RATE_INTERVAL = 5 * MIN;
const KEY = 'radar-meteo.ratings.v1';
const TYPE_Q = { radar: 1.0, satellite: 0.55, model: 0.45 };
const W = { type: 0.35, res: 0.12, step: 0.08, reliab: 0.25, fresh: 0.12, speed: 0.05, complete: 0.03 };

function load() {
  const raw = store.get(KEY, {});
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [id, s] of Object.entries(raw)) {
      if (s && Number.isFinite(s.reliab)) {
        out[id] = {
          reliab: clamp(s.reliab, 0, 1),
          history: Array.isArray(s.history) ? s.history.filter(h => h && Number.isFinite(h.at)).slice(-50) : [],
        };
      }
    }
  }
  return out;
}

export class Rating {
  constructor(sources) {
    this.sources = sources;
    this.state = load();
    for (const s of sources) {
      this.state[s.id] ||= { reliab: 0.8, history: [] };
      Object.assign(this.state[s.id], { ok: null, ms: null, latest: null, error: null, checkedAt: null, completeness: 1 });
      this.state[s.id].score = this.compute(s);
    }
    this.listeners = new Set();
    this.running = null;
  }

  onChange(fn) { this.listeners.add(fn); }

  staticParts(src) {
    return {
      type: TYPE_Q[src.kind] ?? 0.3,
      res: clamp(1 - Math.log(src.resKm) / Math.log(50), 0, 1),
      step: clamp(1 - Math.log(src.stepMin / 5) / Math.log(24), 0, 1),
    };
  }

  compute(src) {
    const st = this.state[src.id];
    const p = this.staticParts(src);
    let fresh = 0.7, speed = 0.7;
    if (st.ok === false) { fresh = 0; speed = 0; }
    else if (st.ok) {
      if (src.kind === 'model') fresh = 1;
      else {
        const ageMin = (Date.now() - st.latest) / MIN;
        const exp = Math.max(10, src.latencyMin);
        fresh = clamp(1 - Math.max(0, ageMin - exp) / (4 * exp), 0, 1);
      }
      speed = clamp(1 - (st.ms - 400) / 6000, 0.2, 1);
    }
    const score = W.type * p.type + W.res * p.res + W.step * p.step + W.reliab * st.reliab +
      W.fresh * fresh + W.speed * speed + W.complete * (st.completeness ?? 1);
    st.parts = { ...p, fresh, speed, reliab: st.reliab };
    return Math.round(score * 1000) / 10;
  }

  async probeOne(src) {
    const st = this.state[src.id];
    try {
      const r = await src.probe();
      Object.assign(st, { ok: true, ms: r.ms, latest: r.latest, completeness: r.completeness ?? 1, error: null });
      st.reliab = 0.75 * st.reliab + 0.25;
    } catch (e) {
      Object.assign(st, { ok: false, error: String(e.message || e) });
      st.reliab = 0.75 * st.reliab;
    }
    st.checkedAt = Date.now();
    st.score = this.compute(src);
    st.history.push({ at: st.checkedAt, ok: st.ok, ms: st.ms != null ? Math.round(st.ms) : null, score: st.score });
    st.history = st.history.slice(-50);
  }

  async rateAll() {
    if (this.running) return this.running;
    this.running = (async () => {
      await Promise.all(this.sources.map(s => this.probeOne(s)));
      this.lastRun = Date.now();
      const persist = {};
      for (const [id, s] of Object.entries(this.state)) persist[id] = { reliab: s.reliab, history: s.history };
      store.set(KEY, persist);
      this.listeners.forEach(fn => fn());
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    this.rateAll();
    this.timer = setInterval(() => this.rateAll(), RATE_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - (this.lastRun || 0) > RATE_INTERVAL) this.rateAll();
    });
  }

  score(id) { return this.state[id]?.score ?? 0; }
}
