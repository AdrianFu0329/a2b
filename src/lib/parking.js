// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Car parks near a destination, for "Parking" in the trip menu. Photon finds the OpenStreetMap car parks
// around the point (nearest first); one OpenStreetMap API call then fetches their tags, for whether they
// charge, what kind they are and how many spaces they have. Private car parks are left out. A failing
// details lookup still returns the car parks, just without the extras.

import { distance } from '../../public/geo.js';

const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const RADIUS_KM = 1;
const LIMIT = 12;
const KINDS = { 'multi-storey': 'Multi-storey', underground: 'Underground', surface: 'Open air', street_side: 'Street', lane: 'Street', rooftop: 'Rooftop' };

export async function parkingNear(env, [lng, lat]) {
  const u = new URL('/reverse', env.GEOCODER_URL || 'https://photon.komoot.io');
  Object.entries({ lat, lon: lng, radius: RADIUS_KM, limit: 25, osm_tag: 'amenity:parking' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw Object.assign(new Error(`Couldn't look up parking (${res.status}).`), { status: 502 });
  const found = ((await res.json()).features ?? []).map((f) => ({
    type: f.properties.osm_type,
    id: f.properties.osm_id,
    name: f.properties.name ?? null,
    street: f.properties.street ?? null,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
  const tags = await osmTags(found).catch(() => new Map());
  return found
    .map((p) => describe(p, tags.get(`${p.type}${p.id}`), [lng, lat]))
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, LIMIT);
}

// Tags for the found ways and nodes, keyed like "W123". Two requests at most, whatever the count.
async function osmTags(found) {
  const out = new Map();
  const groups = [['W', 'ways'], ['N', 'nodes']];
  await Promise.all(groups.map(async ([t, plural]) => {
    const ids = found.filter((p) => p.type === t).map((p) => p.id);
    if (!ids.length) return;
    const res = await fetch(`${OSM_API}/${plural}.json?${plural}=${ids.join(',')}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return;
    for (const e of (await res.json()).elements ?? []) out.set(`${t}${e.id}`, e.tags ?? {});
  }));
  return out;
}

export function describe(p, tags = {}, dest) {
  if (['private', 'no', 'permit'].includes(tags.access)) return null;
  const name = tags.name || p.name;
  const capacity = Number.parseInt(tags.capacity, 10);
  return {
    name: name || (p.street ? `Car park on ${p.street}` : 'Car park'),
    lat: p.lat,
    lng: p.lng,
    distance: Math.round(distance(dest, [p.lng, p.lat])),
    kind: KINDS[tags.parking] ?? null,
    fee: tags.fee === 'yes' ? true : tags.fee === 'no' ? false : null,
    charge: tags.charge ?? null,
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
    customers: tags.access === 'customers',
  };
}
