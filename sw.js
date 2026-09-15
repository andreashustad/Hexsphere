/* Hexsphere service worker: precache everything, serve from cache, refresh in
 * the background. The game has no network features at all, so once installed
 * it works permanently offline — including on a phone in aeroplane mode.
 *
 * The background refresh is what makes a deploy reachable. Serving a cache hit
 * and stopping there means a fix pushed to the site never arrives at a browser
 * that already has the file, because this worker's own bytes did not change so
 * no new worker installs. Bumping VERSION by hand fixes that too, right up to
 * the one deploy where it is forgotten. */
const VERSION = 'hexsphere-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/util.js',
  './js/geometry.js',
  './js/solver.js',
  './js/game.js',
  './js/renderer.js',
  './js/input.js',
  './js/storage.js',
  './js/main.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      /* cache: 'reload' so a stale HTTP cache cannot seed the precache. */
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  /* Ask the network every time, but never wait for it when we already hold a
   * copy. A failed refresh resolves to undefined rather than rejecting, so
   * being offline leaves the cached copy untouched. */
  const refresh = fetch(event.request).then((response) => {
    if (response && response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      return caches.open(VERSION)
        .then((cache) => cache.put(event.request, copy))
        .then(() => response);
    }
    return response;
  }).catch(() => undefined);

  /* waitUntil has to be called while the event is still being dispatched, so
   * it goes here rather than inside the cache lookup below. */
  event.waitUntil(refresh);

  event.respondWith(
    caches.match(event.request)
      .then((hit) => hit || refresh.then((response) => response || caches.match('./index.html')))
  );
});
