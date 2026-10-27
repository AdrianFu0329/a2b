// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Keeps the app shell available offline and fast to open, and keeps map tiles around: every tile,
// font and sprite the map loads is cached, and drives prefetch their corridor (see offline.js), so
// tunnels and dead spots show map instead of blank background. API calls always go to the network.
const CACHE = 'a2b-v33';
const TILES = 'a2b-tiles-v1'; // kept across activates; cleared from Settings › Offline maps
const SHELL = ['/', '/styles.css', '/app.js', '/core.js', '/panels.js', '/nav.js', '/motion.js', '/voice.js', '/vehicle3d.js', '/geo.js', '/icons.js', '/report-types.js', '/map-themes.js', '/places.js', '/text.js', '/sheet-drag.js', '/follow.js', '/presence.js', '/welcome.js', '/update.js', '/offline.js', '/icon.svg', '/manifest.webmanifest'];
const MAPLIBRE = ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    // The map library loads from a CDN: cache it best-effort, but never fail the install over it.
    const tiles = await caches.open(TILES);
    await Promise.all(MAPLIBRE.map((u) => fetch(u).then((res) => res.ok ? tiles.put(u, res) : null).catch(() => null)));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Tiles, fonts and sprites are versioned by their URLs, so cache-first is safe: a new tile release
// is new URLs, and the app shell stays network-first so deploys show up straight away.
function isMapAsset(url) {
  return url.host === 'tiles.openfreemap.org' || (url.host === 'unpkg.com' && url.pathname.startsWith('/maplibre-gl@'));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isMapAsset(url)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Place data is versioned and kept by the browser's own cache; keeping it here too would only grow.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/places/') || url.pathname === '/version.json') return;
  // Network first so new deploys show up straight away; the cache is the fallback when offline.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
