// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Schools along a route, for the school zone warning at school times (public/school-zones.js). The list is built
// ahead of time by scripts/build-schools.mjs into public/schools.json and read here through the Worker's static
// assets, once per Worker instance.

import { cumulative } from '../../public/geo.js';
import { pointAlong } from '../../public/nav.js';

const NEAR_M = 150; // a school this close to the road: its gate is probably on it
const PAD_DEG = 0.002;
const CELL_DEG = 0.05; // ~5 km cells, so a route only looks at the schools near it

let loaded = null; // Promise of { rows, grid }, kept once it has schools

export async function loadSchools(assets) {
  if (!assets) return { rows: [], grid: new Map() };
  if (loaded) return loaded;
  const p = (async () => {
    const res = await assets.fetch(new Request('https://assets.local/schools.json'));
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return { rows: [], grid: new Map() }; // not built
    const rows = (await res.json()).schools ?? [];
    const grid = new Map();
    for (const r of rows) {
      const k = `${Math.floor(r[0] / CELL_DEG)}:${Math.floor(r[1] / CELL_DEG)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(r);
    }
    return { rows, grid };
  })();
  loaded = p;
  const got = await p.catch(() => null);
  if (!got?.rows.length) loaded = null; // nothing yet: look again next time
  return got ?? { rows: [], grid: new Map() };
}

// The schools beside a route, in order: { at: index into its coords, name }.
export function schoolsAlong(coords, { grid }) {
  if (!grid?.size || coords.length < 2) return [];
  const cells = new Set();
  for (const [x, y] of coords) {
    for (const dx of [-PAD_DEG, PAD_DEG]) for (const dy of [-PAD_DEG, PAD_DEG]) cells.add(`${Math.floor((x + dx) / CELL_DEG)}:${Math.floor((y + dy) / CELL_DEG)}`);
  }
  const cum = cumulative(coords);
  const out = [];
  for (const k of cells) {
    for (const [lng, lat, name] of grid.get(k) ?? []) {
      const hit = pointAlong(coords, cum, [lng, lat]);
      if (hit.dist > NEAR_M) continue;
      out.push({ at: hit.seg, along: hit.along, name: name || null });
    }
  }
  out.sort((a, b) => a.along - b.along);
  // Schools side by side (a primary and a secondary sharing a road) are one zone.
  return out.filter((s, i) => i === 0 || s.along - out[i - 1].along > 150).map(({ at, name }) => ({ at, name }));
}
