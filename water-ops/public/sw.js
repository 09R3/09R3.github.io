const CACHE_NAME = 'waterops-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/config.js',
  '/db.js',
  '/sync.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET requests
  if (e.request.method !== 'GET') return;

  // Skip cross-origin (e.g. Tailwind CDN) — let browser handle it
  if (url.origin !== self.location.origin) return;

  // API calls: network-only, no caching
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', offline: true }),
          { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // App shell: network-first, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('/index.html')))
  );
});
