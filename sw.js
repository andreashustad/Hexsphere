/* Hexsphere service worker: precache everything, then serve from cache.
 * The game has no network features at all, so once installed it works
 * permanently offline — including on a phone in aeroplane mode. */
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
      .then((cache) => cache.addAll(ASSETS))
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
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((response) => {
        /* Keep the cache warm for anything fetched later (e.g. a new icon). */
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
