// Roads that OpenStreetMap still shows as open right beside a road marked under construction. A new dual
// carriageway is mapped as two one-way halves; mappers sometimes mark one half "under construction" and leave
// the other as an ordinary road, so the router happily drives down it. A route that runs alongside a
// construction road, close and parallel, for a good stretch is most likely on that forgotten half.
//
// The construction roads are built ahead of time from Overture Maps (OpenStreetMap's roads) by
// scripts/build-construction.py into public/construction/, one small file per tile, and read here through
// the Worker's static assets, so checking a route costs no outside request.

import { cumulative, atDistance, distance, bearing } from '../../public/geo.js';

const TILE = 0.05; // degrees, about 5.5 km; must match the build script
const MAX_TILES = 40; // a very long trip: check the first stretch, where it matters soonest

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
    for (const p of r.coords) keys.add(tileKey(p));
    for (let d = 0; d <= cum.at(-1); d += 1000) keys.add(tileKey(atDistance(r.coords, cum, d))); // long straight stretches
  }
  return [...keys].slice(0, MAX_TILES);
}

async function asset(assets, path) {
  const res = await assets.fetch(new Request(`https://assets.local/construction/${path}`));
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null; // missing files fall back to the app page
  return res.json();
}

// Construction roads near the given routes: [[lng, lat], ...] lines.
export async function roadsNear(assets, routes) {
  if (!assets) return [];
  const have = new Set((await asset(assets, 'index.json'))?.tiles ?? []); // the tiles that have any
  const tiles = tilesAlong(routes).filter((k) => have.has(k));
  return (await Promise.all(tiles.map((k) => asset(assets, `${k}.json`).catch(() => null)))).flatMap((t) => t ?? []);
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
export async function constructionTwins(assets, routes) {
  const roads = await roadsNear(assets, routes);
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
