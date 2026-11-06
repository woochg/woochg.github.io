/* ArmBioZ service worker v0.1.5 — offline app shell.
 * Strategy: NETWORK-FIRST for the app's own files, cache as offline fallback.
 * A new GitHub Pages deploy is picked up on the next page load without
 * clearing browser data (v0.1.1 used cache-first, which kept old builds).
 * Still bump CACHE on release so stale offline copies are dropped. */
const CACHE = 'armbioz-v0.1.5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
               'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })            // revalidate with the server
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
