// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Trips by train around the Klang Valley: walk to a station, ride the LRT, MRT, Monorail, BRT or KTM Komuter
// (changing where lines meet), and walk on to the destination. The timetables are Malaysia's official GTFS feeds
// (scripts/build-transit.py -> transit-data.json). Prasarana's lines only say how often trains run, so a wait is
// counted as half the time between trains; KTM Komuter has real departure times. The network is small (under 300
// stations), so a plain Dijkstra over stations, by time, finds the trips. Walks here are straight-line estimates;
// the Worker swaps in real walking routes for the trips it returns.

import DATA from './transit-data.json' with { type: 'json' };
import { distance, decodePolyline } from '../../public/geo.js';

const WALK_MPS = 1.25; // ~4.5 km/h
const DETOUR = 1.3; // streets aren't straight lines
const ACCESS_M = 1500; // furthest walk to or from a station, as the crow flies
const ACCESS_STOPS = 6; // nearest stations tried at each end
const TRANSFER_M = 400; // stations this close are one interchange (Masjid Jamek, KL Sentral)
const TRANSFER_EXTRA_S = 60; // stairs, gates
const CHANGE_PENALTY_S = 240; // a change of train is worse than its minutes alone
const MAX_OPTIONS = 3;
const NIGHT_WAIT_S = 45 * 60; // waiting longer than this for a train means they've stopped for the night
const QUICK_WALK_S = 30 * 60; // only suggest walking instead when it's a short walk
const MYT = 8 * 3600_000;
const DAY = 86400;

export const walkSeconds = (m) => Math.round((m * DETOUR) / WALK_MPS);

// ---------- The network, read once ----------
const stops = DATA.stops.map(([name, lat, lng, code], i) => ({ i, name, lat, lng, code, at: [lng, lat], visits: [] }));
const patterns = DATA.patterns.map((p, k) => ({ ...p, k }));
for (const p of patterns) p.stops.forEach((s, pos) => stops[s].visits.push([p.k, pos]));
const nearby = stops.map((a) =>
  stops
    .filter((b) => b !== a && distance(a.at, b.at) <= TRANSFER_M)
    .map((b) => ({ to: b.i, secs: walkSeconds(distance(a.at, b.at)) + TRANSFER_EXTRA_S })),
);
const shapes = new Map();
const shapeOf = (id) => {
  if (!id || !DATA.shapes[id]) return null;
  if (!shapes.has(id)) shapes.set(id, decodePolyline(DATA.shapes[id], 5));
  return shapes.get(id);
};

// ---------- When trains run ----------
// The service day for a moment: its date (YYYYMMDD), weekday (Monday 0) and seconds since midnight, Malaysia time.
export function serviceDay(at) {
  const d = new Date(at + MYT);
  return { date: d.toISOString().slice(0, 10).replace(/-/g, ''), dow: (d.getUTCDay() + 6) % 7, secs: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
}

export function runs(serviceId, { date, dow }) {
  const s = DATA.services[serviceId];
  if (!s) return false;
  if (s.remove.includes(date)) return false;
  if (s.add.includes(date)) return true;
  return date >= s.start && date <= s.end && s.days[dow] === 1;
}

// Boarding pattern p at its stop `pos`, at `t` seconds into the service day: when the train leaves (for lines that
// only give a frequency, the expected wait of half a headway) and when it reaches each later stop. Null when no
// more trains run today.
export function board(p, pos, t) {
  if (p.freq) {
    const offset = p.offsets[pos];
    const start = t - offset; // the train must have left its first stop by then
    for (const [from, to, headway] of p.freq) {
      if (start >= to) continue;
      const dep = start < from ? from + offset : t + headway / 2;
      return { dep, headway, arrive: (j) => dep + p.offsets[j] - offset };
    }
    return null;
  }
  const trip = p.trips.find((d) => d[pos] >= t);
  return trip ? { dep: trip[pos], headway: null, arrive: (j) => trip[j] } : null;
}

// ---------- Planning ----------
function access(point) {
  return stops
    .map((s) => ({ s: s.i, m: distance(point, s.at) }))
    .filter((x) => x.m <= ACCESS_M)
    .sort((a, b) => a.m - b.m)
    .slice(0, ACCESS_STOPS);
}

// The fastest trip from `from` to `to` ([lng, lat]) leaving at `t` (seconds into `day`), not using `forbidden` lines.
function search(from, to, t0, day, forbidden) {
  const starts = access(from);
  const ends = new Map(access(to).map((x) => [x.s, x.m]));
  if (!starts.length || !ends.size) return null;
  const live = patterns.filter((p) => !forbidden.has(p.line) && runs(p.service, day));
  const liveSet = new Set(live.map((p) => p.k));

  const label = new Array(stops.length).fill(null); // { t, cost, rides, line, prev }
  const done = new Array(stops.length).fill(false);
  const relax = (s, l) => {
    if (!label[s] || l.cost < label[s].cost) label[s] = l;
  };
  for (const { s, m } of starts) relax(s, { t: t0 + walkSeconds(m), cost: walkSeconds(m), rides: 0, line: null, prev: { kind: 'walk', from: null, m } });

  for (;;) {
    let s = -1;
    for (let i = 0; i < stops.length; i++) if (!done[i] && label[i] && (s < 0 || label[i].cost < label[s].cost)) s = i;
    if (s < 0) break;
    done[s] = true;
    const here = label[s];
    // Walk across to another line's platform, but never two walks in a row.
    if (here.prev.kind === 'ride') {
      for (const n of nearby[s]) relax(n.to, { t: here.t + n.secs, cost: here.cost + n.secs, rides: here.rides, line: here.line, prev: { kind: 'walk', from: s, m: distance(stops[s].at, stops[n.to].at) } });
    }
    for (const [k, pos] of stops[s].visits) {
      const p = patterns[k];
      if (!liveSet.has(k) || p.line === here.line) continue; // no getting off and back on the same line
      const b = board(p, pos, here.t);
      if (!b) continue;
      const penalty = here.rides ? CHANGE_PENALTY_S : 0;
      for (let j = pos + 1; j < p.stops.length; j++) {
        const arrive = b.arrive(j);
        if (arrive >= DAY + 3 * 3600) break;
        relax(p.stops[j], { t: arrive, cost: here.cost + (arrive - here.t) + penalty, rides: here.rides + 1, line: p.line, prev: { kind: 'ride', from: s, k, i: pos, j, dep: b.dep, headway: b.headway, wait: b.dep - here.t } });
      }
    }
  }

  let best = null;
  for (const [s, m] of ends) {
    const l = label[s];
    if (!l || !l.rides) continue;
    const total = l.cost + walkSeconds(m);
    if (!best || total < best.cost) best = { s, m, cost: total, t: l.t + walkSeconds(m) };
  }
  if (!best) return null;

  // Back from the last station to the first, then forwards as legs.
  const steps = [];
  for (let s = best.s; s != null; ) {
    const l = label[s];
    steps.unshift({ s, ...l.prev, t: l.t });
    s = l.prev.from;
  }
  return { steps, end: best, t0 };
}

function stationOf(i) {
  const s = stops[i];
  return { name: s.name, code: s.code, lat: s.lat, lng: s.lng };
}

// The line drawn for a ride from stop index i to j of a pattern: along its track where the feed has one.
function rideLine(p, i, j) {
  const pts = p.stops.slice(i, j + 1).map((s) => stops[s].at);
  const track = shapeOf(p.shape);
  if (!track) return pts;
  const near = (pt, from) => {
    let best = from;
    for (let k = from; k < track.length; k++) if (distance(track[k], pt) < distance(track[best], pt)) best = k;
    return best;
  };
  const a = near(pts[0], 0);
  const b = near(pts.at(-1), a);
  return b > a ? [pts[0], ...track.slice(a, b + 1), pts.at(-1)] : pts;
}

function toTrip(found, from, to, dayStart) {
  const ms = (t) => dayStart + t * 1000;
  const legs = [];
  let t = found.t0;
  let place = { name: 'Start', lat: from[1], lng: from[0] };
  for (const st of found.steps) {
    if (st.kind === 'walk') {
      const dest = stationOf(st.s);
      legs.push({ mode: 'walk', from: place, to: dest, distance: Math.round(st.m * DETOUR), duration: st.t - t, coords: [[place.lng, place.lat], [dest.lng, dest.lat]] });
    } else {
      const p = patterns[st.k];
      const line = DATA.lines[p.line];
      legs.push({
        mode: 'train',
        line: { id: p.line, short: line.short, name: line.name, color: line.color, text: line.text, kind: line.kind },
        towards: p.headsign,
        from: stationOf(p.stops[st.i]),
        to: stationOf(p.stops[st.j]),
        stops: st.j - st.i,
        wait: Math.round(st.wait),
        every: st.headway ? Math.round(st.headway / 60) : null,
        depart: ms(st.dep),
        arrive: ms(st.t),
        duration: st.t - st.dep,
        coords: rideLine(p, st.i, st.j),
      });
    }
    t = st.t;
    place = stationOf(st.s);
  }
  const end = found.end;
  legs.push({ mode: 'walk', from: place, to: { name: 'Destination', lat: to[1], lng: to[0] }, distance: Math.round(end.m * DETOUR), duration: walkSeconds(end.m), coords: [[place.lng, place.lat], to] });
  return summarise(legs, ms(found.t0));
}

export function summarise(legs, depart) {
  const duration = legs.reduce((a, l) => a + l.duration + (l.wait ?? 0), 0);
  return {
    depart,
    arrive: depart + duration * 1000,
    duration,
    walk: legs.filter((l) => l.mode === 'walk').reduce((a, l) => a + l.distance, 0),
    changes: Math.max(0, legs.filter((l) => l.mode === 'train').length - 1),
    legs,
  };
}

// Up to three trips by train from `from` to `to` ([lng, lat]) leaving at `at` (ms): the fastest, then the fastest
// without each of its lines in turn, when they aren't much slower. Also says when walking is simply quicker.
export function planTransit(from, to, at = Date.now()) {
  const day = serviceDay(at);
  const dayStart = at - day.secs * 1000;
  const walkAll = walkSeconds(distance(from, to));
  const note = (msg) => ({ trips: [], walk: walkAll, note: msg });
  if (!access(from).length) return note('No train station within walking distance of the start.');
  if (!access(to).length) return note('No train station within walking distance of the destination.');

  const first = search(from, to, day.secs, day, new Set());
  if (!first) return note('No trains can get you there at this time.');
  const trips = [toTrip(first, from, to, dayStart)];
  const seen = new Set([lineKey(trips[0])]);
  for (const line of trips[0].legs.filter((l) => l.mode === 'train').map((l) => l.line.id)) {
    const alt = search(from, to, day.secs, day, new Set([line]));
    if (!alt) continue;
    const trip = toTrip(alt, from, to, dayStart);
    if (seen.has(lineKey(trip)) || trip.duration > trips[0].duration * 1.4 + 600) continue;
    seen.add(lineKey(trip));
    trips.push(trip);
  }
  trips.sort((a, b) => a.arrive - b.arrive);
  // Late at night the first trip waits for the morning's first train: say so rather than offer a long wait.
  const firstTrain = trips[0].legs.find((l) => l.mode === 'train');
  if (firstTrain.wait > NIGHT_WAIT_S) return { trips: trips.slice(0, MAX_OPTIONS), walk: walkAll, night: true, note: 'Trains have stopped for the night.', firstTrain: firstTrain.depart };
  const quickerOnFoot = walkAll <= Math.min(trips[0].duration, QUICK_WALK_S);
  return { trips: trips.slice(0, MAX_OPTIONS), walk: walkAll, note: quickerOnFoot ? 'Walking there is about as quick.' : null };
}

const lineKey = (trip) => trip.legs.filter((l) => l.mode === 'train').map((l) => `${l.line.id}:${l.from.code}:${l.to.code}`).join('>');

export const feeds = DATA.feeds;

// ---------- Real walks ----------
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const MAX_WALKS = 8; // walking routes asked of the router per request, at most

// Swaps the straight-line walks of these trips for walking routes from the router (Valhalla's pedestrian costing):
// the path to draw, its length and time. A walk the router can't find keeps its estimate. Trip totals follow.
export async function withRealWalks(env, plan) {
  const walks = new Map();
  const key = (l) => [l.from.lng, l.from.lat, l.to.lng, l.to.lat].map((v) => v.toFixed(5)).join(',');
  for (const trip of plan.trips) for (const l of trip.legs) if (l.mode === 'walk' && l.distance > 30 && walks.size < MAX_WALKS) walks.set(key(l), null);
  await Promise.all([...walks.keys()].map(async (k) => walks.set(k, await walkRoute(env, k.split(',').map(Number)).catch(() => null))));
  for (const trip of plan.trips) {
    let shift = 0; // a longer walk than estimated makes everything after it later
    for (const l of trip.legs) {
      const w = l.mode === 'walk' && walks.get(key(l));
      if (w) {
        shift += w.duration - l.duration;
        Object.assign(l, w);
      } else if (l.mode === 'train' && shift) {
        l.depart += shift * 1000;
        l.arrive += shift * 1000;
      }
    }
    Object.assign(trip, summarise(trip.legs, trip.depart));
  }
  plan.trips.sort((a, b) => a.arrive - b.arrive); // the real walks can change which arrives first
  return plan;
}

async function walkRoute(env, [lng1, lat1, lng2, lat2]) {
  const res = await fetch(env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ locations: [{ lat: lat1, lon: lng1 }, { lat: lat2, lon: lng2 }], costing: 'pedestrian', directions_type: 'none', units: 'kilometers' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const trip = (await res.json()).trip;
  const leg = trip?.legs?.[0];
  if (!leg) return null;
  return { coords: decodePolyline(leg.shape, 6), distance: Math.round(trip.summary.length * 1000), duration: Math.round(trip.summary.time) };
}
