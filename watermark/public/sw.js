const CACHE = 'watermark-v2.88';
const SHELL = ['/', '/app.js', '/scada.js', '/style.css', '/manifest.json',
  '/vendor/chart.umd.js', '/vendor/chartjs-adapter-date-fns.bundle.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// Purge cached API data (user lists, readings, reports) on logout or when the
// app detects an expired session — keeps shared-device data from lingering (S-5).
// The app shell stays cached so offline launch still works.
self.addEventListener('message', e => {
  if (e.data?.type === 'clear-api-cache') {
    e.waitUntil(
      caches.open(CACHE).then(c =>
        c.keys().then(reqs => Promise.all(
          reqs.filter(r => new URL(r.url).pathname.startsWith('/api/'))
              .map(r => c.delete(r))
        ))
      )
    );
  }
});

self.addEventListener('fetch', e => {
  const { pathname } = new URL(e.request.url);

  // SCADA live stream (SSE) — never cache an open-ended stream; pass straight through
  if (pathname === '/api/scada/stream') return;

  // App shell — cache first
  if (SHELL.includes(pathname) || pathname === '/') {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
    return;
  }

  // API GETs — network first, fall back to cache so screens load offline
  if (pathname.startsWith('/api/') && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          caches.open(CACHE).then(c => c.put(e.request, r.clone()));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else (POSTs, auth) — network only, handled by app.js queue
});
