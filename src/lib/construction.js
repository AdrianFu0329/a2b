// Roads that OpenStreetMap still shows as open right beside a road marked under construction. A new dual
// carriageway is mapped as two one-way halves; mappers sometimes mark one half "under construction" and leave
// the other as an ordinary road, so the router happily drives down it. A route that runs alongside a
// construction road, close and parallel, for a good stretch is most likely on that forgotten half.
//
// Construction roads come from Overpass, a tile at a time, and are kept in D1 for a week, so most routes
// never wait on it. A slow or failing lookup just means no check for that tile.

import { cumulative, atDistance, distance, bearing } from '../../public/geo.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const TILE = 0.05; // degrees, about 5.5 km
const KEEP_MS = 7 * 86400_000;
const LOOKUP_MS = 6000;
const MAX_TILES = 24; // a long trip: check the first stretch, where it matters soonest
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/;

export const NEAR_M = 25; // the two halves of a divided road sit this close or closer
const PARALLEL_DEG = 20;
export const MIN_RUN_M = 100; // a shorter brush past one (a junction, a bend) doesn't count
const STEP_M = 10;

const tileKey = ([lng, lat]) => `${Math.floor(lng / TILE)}_${Math.floor(lat / TILE)}`;

// The tiles a set of routes passes through, nearest the start first.
export function tilesAlong(routes) {
  const keys = new Set();
  for (const r of routes) {
    const cum = cumulative(r.coords);
    for (let d = 0; d <= cum.at(-1); d += 1000) keys.add(tileKey(atDistance(r.coords, cum, d)));
    keys.add(tileKey(r.coords.at(-1)));
  }
  return [...keys].slice(0, MAX_TILES);
}

// Construction roads in one tile, from D1 or Overpass: [[lng, lat], ...] lines.
async function tileRoads(db, key, now) {
  const hit = await db.prepare('SELECT roads, fetched_at FROM construction_tiles WHERE tile = ?').bind(key).first();
  if (hit && now - hit.fetched_at < KEEP_MS) return JSON.parse(hit.roads);
  const [x, y] = key.split('_').map(Number);
  const box = [y * TILE, x * TILE, (y + 1) * TILE, (x + 1) * TILE].map((v) => v.toFixed(4)).join(',');
  const query = `[out:json][timeout:15];way["highway"="construction"](${box});out tags geom;`;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(LOOKUP_MS),
      });
      if (!res.ok) continue;
      const roads = parseOverpass(await res.json());
      await db
        .prepare('INSERT INTO construction_tiles (tile, roads, fetched_at) VALUES (?, ?, ?) ON CONFLICT(tile) DO UPDATE SET roads = excluded.roads, fetched_at = excluded.fetched_at')
        .bind(key, JSON.stringify(roads), now)
        .run();
      return roads;
    } catch {
      // try the next server
    }
  }
  return hit ? JSON.parse(hit.roads) : [];
}

// Only roads being built for cars count (not footpaths or cycle tracks under construction).
export function parseOverpass(data) {
  return (data?.elements ?? [])
    .filter((e) => e.type === 'way' && e.geometry?.length > 1 && (!e.tags?.construction || ROAD.test(e.tags.construction)))
    .map((e) => e.geometry.map((g) => [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]));
}

// Where a route runs alongside a construction road: the middle of each such stretch, on the route.
export function twinStretches(coords, roads) {
  const segs = [];
  const box = boundsOf(coords, 0.0005);
  for (const line of roads) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      if (Math.max(a[0], b[0]) < box[0] || Math.min(a[0], b[0]) > box[2] || Math.max(a[1], b[1]) < box[1] || Math.min(a[1], b[1]) > box[3]) continue;
      segs.push({ a, b, bearing: bearing(a, b), box: boundsOf([a, b], 0.0003) });
    }
  }
  if (!segs.length) return [];
  const out = [];
  let run = [];
  const close = () => {
    if (run.length * STEP_M >= MIN_RUN_M) out.push(run[Math.floor(run.length / 2)]);
    run = [];
  };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const len = distance(a, b);
    const heading = bearing(a, b);
    for (let d = 0; d < len; d += STEP_M) {
      const t = d / len;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const alongside = segs.some((s) => p[0] >= s.box[0] && p[0] <= s.box[2] && p[1] >= s.box[1] && p[1] <= s.box[3]
        && parallel(heading, s.bearing) && distToSegment(p, s.a, s.b) <= NEAR_M);
      if (alongside) run.push(p);
      else close();
    }
  }
  close();
  return out;
}

// For each route, the stretches it shares with a construction road (see twinStretches).
export async function constructionTwins(db, routes, now = Date.now()) {
  const tiles = tilesAlong(routes);
  const roads = (await Promise.all(tiles.map((k) => tileRoads(db, k, now).catch(() => [])))).flat();
  return routes.map((r) => twinStretches(r.coords, roads));
}

function parallel(a, b) {
  const d = Math.abs((((a - b) % 180) + 180) % 180);
  return Math.min(d, 180 - d) <= PARALLEL_DEG;
}

function distToSegment(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = a[0] * k, ay = a[1], dx = b[0] * k - ax, dy = b[1] - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] * k - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
  return distance(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}

function boundsOf(coords, pad) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}
