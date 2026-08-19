/**
 * AI4Food service worker.
 *
 * It does one job: keep the app openable when the network is not there. The
 * app already has a demo mode for exactly that case, so a cached shell lands
 * somewhere sensible rather than on a browser error page.
 *
 * What it must never do is serve stale truth. Stock, orders, payment state and
 * pickup codes are the product; a cached one is a lie with a timestamp. So
 * anything under /api/ is passed straight through and never stored, and even
 * the shell is fetched from the network first — the cache is a fallback, not a
 * source.
 */
const VERSION = 'ai4food-v1';
const SHELL = ['./ai4food-app.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      // A shell that will not cache is not a reason to refuse to install.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The API is live data by definition. Not cached, not read from cache, not
  // touched — a stale order is worse than no order.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/ready') return;

  // Someone else's origin is their business.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./ai4food-app.html'))),
  );
});

// The page asks for the new version when it is ready to take it.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
