/* Hexsphere service worker: precache everything, serve from cache, and refresh
 * the whole app as one unit. The game has no network features at all, so once
 * installed it works permanently offline — including on a phone in aeroplane
 * mode.
 *
 * The background refresh is what makes a deploy reachable. Serving a cache hit
 * and stopping there means a fix pushed to the site never arrives at a browser
 * that already has the file, because this worker's own bytes did not change so
 * no new worker installs. Bumping VERSION by hand fixes that too, right up to
 * the one deploy where it is forgotten. So the refresh stays.
 *
 * What it must not do is refresh one file at a time. The game is eight scripts
 * that call into each other, so the unit that has to stay consistent is the
 * whole app. A launch closed part-way through a per-file refresh left the cache
 * holding some files from the new deploy and some from the old, and the next
 * launch served that mixture: new main.js called solver.levelFor, which the old
 * solver.js does not export, nothing caught it, and the board never drew. A
 * blank screen, with a warm cache and a healthy network.
 *
 * So a refresh is all-or-nothing. Every asset is fetched before any of it is
 * written, and one unreachable file means the deploy is not committed at all:
 * the last version that ran as a set stays, and the update lands on a later
 * launch instead. That is also what keeps offline play working — with no
 * network the fetch simply fails and the cache is left exactly as it was.
 *
 * The refresh runs once per launch, on the navigation, rather than once per
 * request. That is the same number of fetches a launch already made, and the
 * navigation is the only moment the whole set can be replaced without a page
 * reading across the change. */
const VERSION = 'hexsphere-v2';
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

/* Fetch the entire app, then write it. Promise.all rejects on the first
 * failure, which is the behaviour this depends on: nothing reaches the cache
 * unless everything arrived.
 *
 * Each body is read as soon as its headers land, rather than held until the
 * last asset arrives. A response whose body is never read keeps its connection
 * open and a browser allows only a handful per host, so holding all seventeen
 * deadlocked the install outright: the worker sat in "installing" for ever and
 * never threw. Reading frees the connection at once and still lets the whole
 * set be written together. */
function refreshAll() {
  return Promise.all(ASSETS.map(function (url) {
    /* cache: 'reload' so a stale HTTP cache cannot seed the precache. */
    const request = new Request(url, { cache: 'reload' });
    return fetch(request).then(function (response) {
      if (!response || response.status !== 200 || response.type !== 'basic') {
        throw new Error('refusing a partial refresh: ' + url);
      }
      return response.blob().then(function (body) {
        return {
          request: request,
          response: new Response(body, { status: 200, headers: response.headers })
        };
      });
    });
  })).then(function (fetched) {
    return caches.open(VERSION).then(function (cache) {
      return Promise.all(fetched.map(function (pair) {
        return cache.put(pair.request, pair.response);
      }));
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(refreshAll().then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  /* One refresh per launch, covering everything. A refresh that fails leaves
   * the cache untouched, so there is never a partial state to recover from. */
  if (request.mode === 'navigate') {
    event.waitUntil(refreshAll().catch(function () { /* try again next launch */ }));
  }

  /* The home-screen shortcuts carry a query string, which is part of the cache
   * key, so they miss and fall through to the network and then to the cached
   * document. They are deliberately never cached under their own key: that
   * would put a second copy of index.html outside the set refreshAll replaces,
   * and a stale copy outside that set is the whole bug above. */
  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).catch(function () { return undefined; })
        .then(function (response) { return response || caches.match('./index.html'); });
    })
  );
});
