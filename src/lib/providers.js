// Place search (Photon) and driving routes (Valhalla), normalised into the shapes the app uses.
// Both default to free public servers; point GEOCODER_URL / ROUTING_URL at your own to scale up.

import { decodePolyline, cumulative } from '../../public/geo.js';
import { pointAlong } from '../../public/nav.js';

const UA = 'a2b-navigation/0.1 (+https://github.com/thaqif0709/a2b)';

export function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// ---------- Search ----------

export async function searchPlaces(env, { q, lat, lng, lang = 'en' }) {
  const base = env.GEOCODER_URL || 'https://photon.komoot.io';
  const u = new URL('/api/', base);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '10');
  if (['en', 'de', 'fr'].includes(lang)) u.searchParams.set('lang', lang);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    u.searchParams.set('lat', lat);
    u.searchParams.set('lon', lng);
  }
  const data = await getJson(u);
  return dedupe((data.features ?? []).map(photonToPlace));
}

export async function reverseGeocode(env, { lat, lng }) {
  const base = env.GEOCODER_URL || 'https://photon.komoot.io';
  const u = new URL('/reverse', base);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lng);
  u.searchParams.set('limit', '1');
  const data = await getJson(u);
  const f = data.features?.[0];
  return f ? photonToPlace(f) : { name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, address: '', lat, lng, category: 'pin' };
}

export function photonToPlace(f) {
  const p = f.properties ?? {};
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street || p.city || p.county || p.state || p.country || 'Dropped pin';
  const parts = [p.name && street && street !== p.name ? street : null, p.district || p.locality, p.city, p.state, p.country]
    .filter(Boolean)
    .filter((x, i, a) => x !== name && a.indexOf(x) === i);
  return { name, address: parts.join(', '), lat, lng, category: p.osm_value || p.type || 'place' };
}

function dedupe(places) {
  const seen = new Set();
  return places.filter((p) => {
    const k = `${p.name}|${p.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Routing ----------

// Valhalla maneuver type numbers -> the turn arrow the app draws.
const MANEUVER = {
  0: 'straight', 1: 'depart', 2: 'depart', 3: 'depart', 4: 'arrive', 5: 'arrive_right', 6: 'arrive_left', 7: 'straight', 8: 'straight',
  9: 'slight_right', 10: 'right', 11: 'sharp_right', 12: 'uturn_right', 13: 'uturn_left', 14: 'sharp_left', 15: 'left', 16: 'slight_left',
  17: 'straight', 18: 'slight_right', 19: 'slight_left', 20: 'slight_right', 21: 'slight_left', 22: 'straight', 23: 'slight_right',
  24: 'slight_left', 25: 'merge', 26: 'roundabout', 27: 'roundabout_exit', 28: 'ferry', 29: 'ferry', 37: 'merge_right', 38: 'merge_left',
};

export function buildRouteRequest({ from, to, avoid = {}, units = 'metric', lang = 'en-US', heading, exclude = [] }) {
  const start = { lat: from[1], lon: from[0] };
  if (Number.isFinite(heading)) {
    start.heading = Math.round(heading);
    start.heading_tolerance = 60;
  }
  return {
    locations: [start, { lat: to[1], lon: to[0] }],
    costing: 'auto',
    costing_options: {
      auto: {
        use_tolls: avoid.tolls ? 0 : 0.5,
        use_highways: avoid.highways ? 0 : 1,
        use_ferry: avoid.ferries ? 0 : 0.5,
      },
    },
    exclude_locations: exclude.slice(0, 40).map(([lng, lat]) => ({ lat, lon: lng })),
    alternates: 2,
    units: units === 'imperial' ? 'miles' : 'kilometers',
    language: lang,
    directions_options: { units: units === 'imperial' ? 'miles' : 'kilometers', language: lang },
  };
}

export async function fetchRoutes(env, opts) {
  const body = buildRouteRequest(opts);
  const res = await fetch(env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Valhalla 442/171 etc: no route. Retrying without closures may still help the driver.
    if (body.exclude_locations.length && opts.exclude?.length) return fetchRoutes(env, { ...opts, exclude: [] });
    throw httpError(data.error || 'No route found between these places.', res.status === 400 ? 404 : 502);
  }
  return [data.trip, ...(data.alternates ?? []).map((a) => a.trip)].filter(Boolean).map((t) => normalizeTrip(t, opts.units));
}

export function normalizeTrip(trip, units = 'metric') {
  const leg = trip.legs[0];
  const coords = decodePolyline(leg.shape, 6);
  const unit = units === 'imperial' ? 1609.344 : 1000;
  const steps = leg.maneuvers.map((m) => ({
    type: MANEUVER[m.type] ?? 'straight',
    instruction: m.instruction,
    alert: m.verbal_transition_alert_instruction || m.verbal_succinct_transition_instruction || m.instruction,
    pre: m.verbal_pre_transition_instruction || m.instruction,
    post: m.verbal_post_transition_instruction || null,
    street: (m.street_names ?? m.begin_street_names ?? [])[0] || '',
    exit: m.roundabout_exit_count ?? null,
    begin: m.begin_shape_index,
    end: m.end_shape_index,
    length: m.length * unit,
    time: m.time,
  }));
  return {
    coords,
    distance: trip.summary.length * unit,
    duration: trip.summary.time,
    toll: Boolean(trip.summary.has_toll),
    highway: Boolean(trip.summary.has_highway),
    ferry: Boolean(trip.summary.has_ferry),
    via: viaName(steps),
    steps,
  };
}

// "via Main St": the street the route spends the longest on.
function viaName(steps) {
  const by = new Map();
  for (const s of steps) if (s.street) by.set(s.street, (by.get(s.street) ?? 0) + s.length);
  let best = '', len = 0;
  for (const [k, v] of by) if (v > len) [best, len] = [k, v];
  return best;
}

// Extra minutes a community traffic report adds when it sits on the route.
const JAM_DELAY = { moderate: 90, heavy: 240, standstill: 480 };

// Marks which live reports lie on each route and adds reported jams to the ETA.
export function annotateWithReports(routes, reports) {
  for (const r of routes) {
    const cum = cumulative(r.coords);
    const box = bbox(r.coords, 0.0005);
    const hits = [];
    for (const rep of reports) {
      if (rep.lng < box[0] || rep.lat < box[1] || rep.lng > box[2] || rep.lat > box[3]) continue;
      const best = pointAlong(r.coords, cum, [rep.lng, rep.lat]);
      if (best.dist <= 40) hits.push({ id: rep.id, type: rep.type, subtype: rep.subtype, at: Math.round(best.along) });
    }
    hits.sort((a, b) => a.at - b.at);
    r.reports = hits;
    r.delay = hits.filter((h) => h.type === 'traffic').reduce((s, h) => s + (JAM_DELAY[h.subtype] ?? 120), 0);
    r.duration += r.delay;
  }
  return routes;
}

export function bbox(coords, pad = 0) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw httpError(`Search service error (${res.status}).`, 502);
  return res.json();
}
