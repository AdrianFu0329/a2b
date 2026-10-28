// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Car park entrances at a destination. A route to a mall (Pavilion, Mid Valley, Sunway Pyramid) otherwise ends at
// the middle of the building, often on a road on the wrong side of it. OpenStreetMap maps the entrances
// (amenity=parking_entrance), so the drive can end at one: the one quickest to get to from where you are, counting
// the walk from it to the place. Overpass finds them; one Valhalla matrix request times the drive to each. Any
// failure just means no entrance, and the route goes to the place as before.

import { distance } from '../../public/geo.js';

const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
export const RADIUS_M = 350;
const CANDIDATES = 5; // timed per route request, the nearest to the place
const CACHE_MS = 86400_000;
const CACHE_MAX = 500;
const WALK_MPS = 1.25;
const WALK_DETOUR = 1.3;
const CLOSED = new Set(['private', 'no', 'permit', 'delivery', 'staff', 'employees']);

const cache = new Map(); // "lat,lng" to ~100 m -> { at, list }

// The public car park entrances within RADIUS_M of `to` ([lng, lat]), nearest first: { name, lat, lng, m }.
export async function entrancesNear(env, [lng, lat], { now = Date.now() } = {}) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return withDistance(hit.list, [lng, lat]);
  const q = `[out:json][timeout:15];node(around:${RADIUS_M},${lat},${lng})[amenity=parking_entrance];out body;`;
  const res = await fetch(env.OVERPASS_URL || OVERPASS, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: q }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Overpass: ${res.status}`);
  const list = entranceRows((await res.json()).elements ?? []);
  cache.delete(key);
  cache.set(key, { at: now, list });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return withDistance(list, [lng, lat]);
}

export function forgetEntrances() {
  cache.clear();
}

// Overpass nodes -> entrances drivers may use. Customer-only ones stay: that's a mall's own car park.
export function entranceRows(elements) {
  return elements
    .filter((e) => e.lat != null && e.lon != null)
    .filter((e) => !CLOSED.has(e.tags?.access) && e.tags?.motorcar !== 'no' && e.tags?.motor_vehicle !== 'no')
    .map((e) => {
      const t = e.tags ?? {};
      const name = t['name:en'] || t.name || (t.ref ? `Entrance ${t.ref}` : '');
      return { name, lat: e.lat, lng: e.lon };
    });
}

const withDistance = (list, to) => list.map((e) => ({ ...e, m: Math.round(distance(to, [e.lng, e.lat])) })).sort((a, b) => a.m - b.m);

// The entrance to drive to from `from`: the least drive time (one sources_to_targets request) plus the walk on to
// the place. If the router can't say, the one nearest the place. Null when there are none.
export async function pickEntrance(env, from, list) {
  const cands = list.slice(0, CANDIDATES);
  if (!cands.length) return null;
  const walk = (e) => (e.m * WALK_DETOUR) / WALK_MPS;
  const times = await driveTimes(env, from, cands).catch(() => null);
  if (!times) return cands[0];
  let best = null, bestCost = Infinity;
  cands.forEach((e, i) => {
    if (times[i] == null) return;
    const cost = times[i] + walk(e);
    if (cost < bestCost) [best, bestCost] = [e, cost];
  });
  return best ?? cands[0];
}

async function driveTimes(env, [lng, lat], targets) {
  const base = env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route';
  const res = await fetch(base.replace(/\/route$/, '/sources_to_targets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ sources: [{ lat, lon: lng }], targets: targets.map((e) => ({ lat: e.lat, lon: e.lng })), costing: 'auto' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const row = (await res.json()).sources_to_targets?.[0];
  if (!Array.isArray(row)) return null;
  const out = targets.map(() => null);
  for (const c of row) if (c && Number.isInteger(c.to_index) && typeof c.time === 'number') out[c.to_index] = c.time;
  return out.some((t) => t != null) ? out : null;
}

// The road the route reaches the entrance on: the street of the last step that names one.
export function arrivalStreet(route) {
  for (let i = (route?.steps?.length ?? 0) - 1; i >= 0; i--) if (route.steps[i].street) return route.steps[i].street;
  return '';
}
