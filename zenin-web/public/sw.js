// Service worker: keeps the app shell available offline. It never caches /api (loan data must always be live) or pages
// that show account state. Bump VERSION to refresh the cache.
const VERSION = 'zenin-v1';
const SHELL = ['/app', '/css/site.css', '/js/app.js', '/js/i18n.js', '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (!SHELL.includes(url.pathname) && !url.pathname.startsWith('/app')) return;
  // network first, so a deploy shows up immediately; the cache is only the offline fallback
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match('/app'))));
});
