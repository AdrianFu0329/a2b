// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Saving the map along a drive, so tunnels and dead spots don't leave a blank map. The service worker
// (sw.js) keeps every map tile it fetches; this module decides *which* tiles to fetch ahead of time:
// the corridor around the active route, prefetched when a drive starts while still online.

export const TILE_CACHE = 'a2b-tiles-v1'; // keep in step with public/sw.js
const MAX_CACHED_TILES = 6000; // past this, the oldest prefetches are dropped to bound phone storage
const PREFETCH_ZOOMS = [12, 13, 14, 15, 16]; // street detail without the label-only zooms above
const FETCH_AT_ONCE = 6;

// ---------- Pure tile maths (unit-tested in test/offline.test.js) ----------

const clampLat = (lat) => Math.max(-85.0511, Math.min(85.0511, lat));

export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((clampLat(lat) * Math.PI) / 180) + 1 / Math.cos((clampLat(lat) * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function tileUrl(template, { z, x, y }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// Every tile the route touches at the given zooms, plus a one-tile margin so the map around the
// road is there too. Low zooms first, so a cap keeps context over detail.
export function tilesForCoords(coords, zooms = PREFETCH_ZOOMS, buffer = 1) {
  const seen = new Set();
  const out = [];
  for (const z of [...zooms].sort((a, b) => a - b)) {
    const n = 2 ** z;
    for (const [lng, lat] of coords) {
      const { x, y } = lngLatToTile(lng, lat, z);
      for (let dx = -buffer; dx <= buffer; dx++) {
        for (let dy = -buffer; dy <= buffer; dy++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          const key = `${z}/${tx}/${ty}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ z, x: tx, y: ty });
        }
      }
    }
  }
  return out;
}

// ---------- Cache bookkeeping ----------

export async function tileCount() {
  try {
    return (await (await caches.open(TILE_CACHE)).keys()).length;
  } catch {
    return 0;
  }
}

export async function clearOfflineTiles() {
  try {
    await caches.delete(TILE_CACHE);
  } catch {}
}

export async function originUsage() {
  try {
    return (await navigator.storage?.estimate()) ?? null;
  } catch {
    return null;
  }
}

// ---------- Prefetch ----------

// Tile URL templates for the map's vector sources, resolved through their TileJSON so a new tile
// release (OpenFreeMap versions the tile path) is picked up without a code change. Raster sources
// (hillshading) are decorative and world-covering at low zoom, so they are left out.
export async function tileTemplates(style) {
  const urls = [...new Set(Object.values(style?.sources ?? {}).filter((s) => s.type === 'vector' && s.url).map((s) => s.url))];
  const templates = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      for (const t of (await res.json()).tiles ?? []) templates.push(t);
    } catch {}
  }));
  return templates;
}

// Fetch the route corridor into the tile cache. Already-cached tiles are served from cache by the
// worker, so re-driving a familiar road costs almost nothing. Never throws: prefetch is best-effort.
export async function prefetchRouteTiles(coords, getStyle, { zooms = PREFETCH_ZOOMS, maxTiles = MAX_CACHED_TILES, onProgress } = {}) {
  try {
    if (!coords?.length || typeof caches === 'undefined') return { fetched: 0, total: 0 };
    const templates = await tileTemplates(getStyle());
    if (!templates.length) return { fetched: 0, total: 0 };
    const tiles = tilesForCoords(coords, zooms).slice(0, maxTiles);
    let fetched = 0;
    const queue = [...tiles];
    await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, queue.length) }, async () => {
      while (queue.length) {
        const t = queue.shift();
        for (const template of templates) {
          try {
            const res = await fetch(tileUrl(template, t));
            if (res.ok) fetched++;
          } catch {} // went offline mid-prefetch: the tiles so far still count
        }
        onProgress?.(fetched, tiles.length);
      }
    }));
    await trimTileCache();
    return { fetched, total: tiles.length };
  } catch {
    return { fetched: 0, total: 0 };
  }
}

// The Cache API lists keys in insertion order, so trimming from the front drops the oldest drives.
async function trimTileCache() {
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length > MAX_CACHED_TILES) await Promise.all(keys.slice(0, keys.length - MAX_CACHED_TILES).map((k) => cache.delete(k)));
  } catch {}
}
