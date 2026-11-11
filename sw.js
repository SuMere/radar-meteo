// Service worker: rende l'app installabile e apribile anche offline.
// Sicurezza: gestisce solo i file dell'app (stessa origine, elenco fisso); le richieste ai servizi
// meteo non passano mai di qui e non vengono salvate. Prima la rete, poi la cache: gli aggiornamenti
// (anche quelli di sicurezza) arrivano subito ai telefoni su cui l'app è installata.
const CACHE = 'radar-meteo-v1';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/sources.js', 'js/rating.js', 'js/util.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png', 'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const SHELL = new Set(FILES.map(f => new URL(f, self.registration.scope).href));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  const key = u.origin + u.pathname; // senza query: il link condivisibile è nell'hash, che non arriva qui
  if (req.method !== 'GET' || u.origin !== self.location.origin || !SHELL.has(key)) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(r => r || Response.error())));
});
// Clic su una notifica di pioggia: riporta in primo piano l'app (solo pagine di questa origine).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    const win = list.find(c => new URL(c.url).origin === self.location.origin);
    return win ? win.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
