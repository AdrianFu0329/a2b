// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Builds public/cameras.json: Malaysia's fixed speed cameras (AES, AWAS) as mapped in OpenStreetMap
// (highway=speed_camera), so routes can warn about them. Photon, the search service, is asked for the cameras
// within a few hundred km of a handful of points covering the country; an answer that comes back full is asked
// again as four smaller areas. That's a few requests a month. One OpenStreetMap API call per 200 cameras then
// adds their tags: their names and speed limits.
//
//   node scripts/build-cameras.mjs            (or: npm run cameras)

import { writeFileSync } from 'node:fs';

const PHOTON = process.env.GEOCODER_URL || 'https://photon.komoot.io';
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const AREAS = [
  [102.1, 4.0, 450], // Peninsular Malaysia: lng, lat, radius in km
  [112.5, 2.5, 450], // Sarawak
  [116.8, 5.3, 300], // Sabah
];
const LIMIT = 50;
const PAUSE_MS = 400; // between requests, to be kind to a free service

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }).catch((e) => e);
    if (res.ok) return res.json();
    if (attempt === 4) throw new Error(`${url}: ${res.status ?? res.message}`);
    await sleep(2000 * 2 ** attempt);
  }
}

// The cameras within `radius` km of a point; a full page means there may be more, so look closer.
async function around(lng, lat, radius, found) {
  const u = new URL('/reverse', PHOTON);
  Object.entries({ lat, lon: lng, radius, limit: LIMIT, osm_tag: 'highway:speed_camera' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const { features = [] } = await json(u);
  await sleep(PAUSE_MS);
  for (const f of features) {
    if (f.properties.osm_type !== 'N' || f.properties.countrycode !== 'MY') continue;
    found.set(f.properties.osm_id, { id: f.properties.osm_id, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: f.properties.name ?? null });
  }
  if (features.length >= LIMIT && radius > 3) {
    const d = radius / 111 / 2;
    for (const [dx, dy] of [[-d, -d], [d, -d], [-d, d], [d, d]]) await around(lng + dx, lat + dy, radius / 2, found);
  }
}

// Which way the camera checks traffic, as a compass bearing, from its name ("AES GCE - Southbound",
// "KM 214.4 Lebuhraya PLUS, Alor Gajah (NB)", "Arah Utara"); null when it doesn't say. The direction tag isn't
// used: mappers use it both for the way traffic goes and for the way the camera faces, which is the opposite.
const BOUND = { north: 0, n: 0, utara: 0, east: 90, e: 90, timur: 90, south: 180, s: 180, selatan: 180, west: 270, w: 270, barat: 270 };
export function cameraBearing(name = '') {
  const m = /\b(north|south|east|west)[\s-]*bound\b|\b([nsew])b\b|\barah\s+(utara|selatan|timur|barat)\b/i.exec(name ?? '');
  return m ? BOUND[(m[1] ?? m[2] ?? m[3]).toLowerCase()] : null;
}

async function main() {
  const found = new Map();
  for (const [lng, lat, radius] of AREAS) {
    await around(lng, lat, radius, found);
    console.log(`…${found.size} cameras so far`);
  }
  const list = [...found.values()];
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    const { elements = [] } = await json(`${OSM_API}/nodes.json?nodes=${batch.map((c) => c.id).join(',')}`);
    for (const el of elements) Object.assign(found.get(el.id) ?? {}, { tags: el.tags ?? {} });
    await sleep(PAUSE_MS);
  }
  const cameras = list
    .map((c) => {
      const limit = Number.parseInt(c.tags?.maxspeed, 10);
      return [Math.round(c.lng * 1e6) / 1e6, Math.round(c.lat * 1e6) / 1e6, c.tags?.name ?? c.name, cameraBearing(c.tags?.name ?? c.name), Number.isFinite(limit) ? limit : null];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = { built: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap contributors (ODbL), via Photon', count: cameras.length, fields: ['lng', 'lat', 'name', 'bearing', 'limit'], cameras };
  writeFileSync(new URL('../public/cameras.json', import.meta.url), `${JSON.stringify(out)}\n`);
  console.log(`Wrote ${cameras.length} cameras to public/cameras.json (${cameras.filter((c) => c[3] != null).length} saying which way, ${cameras.filter((c) => c[4]).length} with a limit).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
