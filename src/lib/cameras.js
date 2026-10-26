// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Fixed speed cameras (AES, AWAS) along a route, from OpenStreetMap. The list is built ahead of time by
// scripts/build-cameras.mjs into public/cameras.json and read here through the Worker's static assets.
//
// A camera counts when it sits on the route's own carriageway (the other half of a divided road is often only
// 20 to 30 m away). One a little further off still counts when its name says it's for the way the route goes
// there ("Northbound"). A warning too many is better than a missed one, so the name never rules one out.

import { cumulative, bearing, angleDiff } from '../../public/geo.js';
import { pointAlong } from '../../public/nav.js';

const ON_ROAD_M = 18; // on this carriageway, not the other
const NEAR_M = 30; // beside the road, for one whose name says it's for this way
const SAME_WAY_DEG = 75; // names only say north, south, east or west

export async function loadCameras(assets) {
  if (!assets) return [];
  const res = await assets.fetch(new Request('https://assets.local/cameras.json'));
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return []; // not built: no cameras
  return (await res.json()).cameras ?? [];
}

// The cameras on a route, in order: { at: index into its coords, name, limit }.
export function camerasAlong(coords, cameras) {
  if (!cameras.length || coords.length < 2) return [];
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  const pad = 0.0005;
  const cum = cumulative(coords);
  const out = [];
  for (const [lng, lat, name, dir, limit] of cameras) {
    if (lng < box[0] - pad || lng > box[2] + pad || lat < box[1] - pad || lat > box[3] + pad) continue;
    const hit = pointAlong(coords, cum, [lng, lat]);
    const sameWay = dir != null && Math.abs(angleDiff(dir, bearing(coords[hit.seg - 1], coords[hit.seg]))) <= SAME_WAY_DEG;
    if (hit.dist > (sameWay ? NEAR_M : ON_ROAD_M)) continue;
    out.push({ at: hit.seg, along: hit.along, name: name || null, limit: limit || null });
  }
  out.sort((a, b) => a.along - b.along);
  // One warning for a camera mapped twice (or a pair on one gantry).
  return out.filter((c, i) => i === 0 || c.along - out[i - 1].along > 100).map(({ at, name, limit }) => ({ at, name, limit }));
}
