// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrainGuide, trackOf, snap, pointAt, stationAlongs, alongAtTime, timeAtAlong, nextStop, shouldAlert, alighted, boarded, markerFor, DWELL_S,
} from '../public/train-guide.js';
import { planTransit, feeds } from '../src/lib/transit.js';

// A straight line north along 101.7°E: four stations 1 km apart, 2 minutes between each.
const lat = (m) => 3 + m / 111_195; // metres north, as geo.js measures them
const COORDS = [[101.7, lat(0)], [101.7, lat(1000)], [101.7, lat(2000)], [101.7, lat(3000)]];
const STATIONS = [['A', lat(0), 101.7, 0], ['B', lat(1000), 101.7, 120], ['C', lat(2000), 101.7, 240], ['D', lat(3000), 101.7, 360]];
const T0 = Date.parse('2026-11-04T09:00:00+08:00');
const ride = (o = {}) => ({
  mode: 'train', line: { id: 'x:KJ', short: 'KJ', name: 'Kelana Jaya Line', color: '#e0115f', text: '#fff' }, towards: 'Gombak',
  from: { name: 'A', lat: lat(0), lng: 101.7 }, to: { name: 'D', lat: lat(3000), lng: 101.7 }, stops: 3, wait: 120,
  depart: T0 + 300_000, arrive: T0 + 660_000, duration: 360, coords: COORDS, stations: STATIONS, ...o,
});
const walk = (from, to, m) => ({ mode: 'walk', from, to, distance: m, duration: m / 1.25, coords: [[from.lng, from.lat], [to.lng, to.lat]] });
const fix = (m, o = {}) => ({ lngLat: [101.7, lat(m)], speed: 15, accuracy: 10, ...o });

test('along the track: snapping, points and the stations', () => {
  const track = trackOf(COORDS);
  const s = snap(track, [101.7005, lat(1500)]);
  assert.ok(Math.abs(s.along - 1500) < 3 && s.off > 50 && s.off < 60, JSON.stringify(s));
  assert.ok(Math.abs(pointAt(track, 2500).pos[1] - lat(2500)) < 1e-6);
  assert.ok(Math.abs(pointAt(track, 2500).heading) < 1, 'heading north');
  assert.deepEqual(stationAlongs(track, STATIONS).map((x) => Math.round(x / 10) * 10), [0, 1000, 2000, 3000]);
});

test('time and place on a ride, from the timetable, standing at each station', () => {
  const times = [0, 120, 240, 360], alongs = [0, 1000, 2000, 3000];
  assert.equal(alongAtTime(times, alongs, 60), 500);
  assert.equal(alongAtTime(times, alongs, 120 + DWELL_S / 2), 1000, 'standing at B');
  assert.ok(alongAtTime(times, alongs, 200) > 1000 && alongAtTime(times, alongs, 200) < 2000);
  assert.equal(alongAtTime(times, alongs, 999), 3000);
  for (const t of [30, 160, 300]) assert.ok(Math.abs(timeAtAlong(times, alongs, alongAtTime(times, alongs, t)) - t) < 1e-6, `${t}`);
  assert.equal(nextStop(alongs, 0), 1);
  assert.equal(nextStop(alongs, 1100), 2);
});

test('when to say "get off at the next stop", and when you have', () => {
  const g = { times: [0, 120, 240, 360], alongs: [0, 1000, 2000, 3000] };
  assert.ok(!shouldAlert({ ...g, along: 1900, sinceBoard: 200 }));
  assert.ok(shouldAlert({ ...g, along: 2100, sinceBoard: 200 }), 'left the stop before yours');
  assert.ok(shouldAlert({ ...g, along: 1500, sinceBoard: 275 }), 'or 90 s to go, by the clock');
  assert.ok(!alighted({ ...g, along: 2900, sinceBoard: 360 }));
  assert.ok(alighted({ ...g, along: 2970, sinceBoard: 300 }));
  assert.ok(alighted({ ...g, along: 2500, sinceBoard: 360 + DWELL_S }), 'underground: by the clock');
});

test('boarding: moving fast along the line, or the train time passes at the station', () => {
  assert.ok(boarded({ speed: 12, off: 20, now: 0, departAt: 1e9, atStation: false }));
  assert.ok(!boarded({ speed: 12, off: 300, now: 0, departAt: 1e9, atStation: false }), 'a car beside it is not the train');
  assert.ok(!boarded({ speed: 1.2, off: 5, now: 0, departAt: 1e9, atStation: true }), 'walking on the platform');
  assert.ok(boarded({ speed: null, off: Infinity, now: 100_000, departAt: 60_000, atStation: true }));
});

test('a whole trip: walk, ride, the alert once, a change, the walk at the end', () => {
  const start = { name: 'Start', lat: lat(-300), lng: 101.7 };
  const second = ride({
    line: { id: 'x:SP', short: 'SP', name: 'Sri Petaling Line', color: '#7f2b0a', text: '#fff' }, towards: 'Putra Heights',
    from: { name: 'D', lat: lat(3000), lng: 101.7 }, to: { name: 'F', lat: lat(5000), lng: 101.7 },
    depart: T0 + 900_000, coords: [[101.7, lat(3000)], [101.7, lat(5000)]], stations: [['D', lat(3000), 101.7, 0], ['E', lat(4000), 101.7, 120], ['F', lat(5000), 101.7, 240]],
  });
  const end = { name: 'Destination', lat: lat(5200), lng: 101.7 };
  const trip = { legs: [walk(start, ride().from, 300), ride(), second, walk(second.to, end, 200)] };
  const g = new TrainGuide(trip, { now: T0 });
  const said = [];
  const step = (o) => {
    const r = g.update(o);
    said.push(...r.events.map((e) => e.type));
    return r.view;
  };

  assert.equal(step({ now: T0, fix: fix(-300, { speed: 1.3 }) }).kind, 'walk');
  assert.ok(step({ now: T0 + 60_000, fix: fix(-150, { speed: 1.3 }) }).left > 100);
  assert.equal(step({ now: T0 + 200_000, fix: fix(-20, { speed: 1 }) }).kind, 'wait', 'at the station');
  assert.equal(step({ now: T0 + 290_000, fix: fix(0, { speed: 0.5 }) }).kind, 'wait');
  let v = step({ now: T0 + 340_000, fix: fix(300, { speed: 14 }) });
  assert.equal(v.kind, 'ride');
  assert.deepEqual([v.next, v.stopsToGo], ['B', 3]);
  // Underground: no GPS at all. The estimate carries on from the timetable.
  v = step({ now: T0 + 400_000, fix: null });
  assert.ok(v.estimating, 'estimating');
  assert.equal(v.next, 'B');
  v = step({ now: T0 + 560_000, fix: null });
  assert.equal(v.next, 'D');
  assert.ok(!v.alerted, 'standing at C, not yet');
  v = step({ now: T0 + 580_000, fix: null }); // 90 s before D
  assert.ok(v.alerted && said.filter((x) => x === 'alert').length === 1, 'said once');
  step({ now: T0 + 590_000, fix: null });
  assert.equal(said.filter((x) => x === 'alert').length, 1);
  // GPS back at D: off, and change.
  step({ now: T0 + 640_000, fix: fix(2990, { speed: 0 }) });
  assert.ok(said.includes('change'), said.join());
  assert.equal(g.leg.line.short, 'SP');
  v = step({ now: T0 + 960_000, fix: fix(3400, { speed: 15 }) });
  assert.equal(v.kind, 'ride');
  step({ now: T0 + 1_100_000, fix: fix(4995, { speed: 0 }) });
  assert.ok(said.includes('alight'), said.join());
  step({ now: T0 + 1_200_000, fix: fix(5180, { speed: 1 }) });
  assert.ok(g.done && said.at(-1) === 'arrived', said.join());
});

test('GPS that comes back puts the estimate right', () => {
  const g = new TrainGuide({ legs: [ride(), walk(ride().to, { name: 'Destination', lat: lat(3100), lng: 101.7 }, 100)] }, { now: T0 });
  g.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) });
  g.update({ now: T0 + 330_000, fix: null });
  const v = g.update({ now: T0 + 340_000, fix: fix(1600) }).view; // further on than the timetable says
  assert.ok(!v.estimating);
  assert.equal(v.next, 'C');
  const later = g.update({ now: T0 + 345_000, fix: null }).view;
  assert.ok(later.pos[1] >= lat(1590), 'carries on from there, not back to the timetable');
});

test('which marker shows where you are', () => {
  assert.equal(markerFor({ mode: 'ride', legMode: 'train', vehicle: 'car' }), 'train');
  assert.equal(markerFor({ mode: 'ride', legMode: 'walk', vehicle: 'car' }), 'chevron', 'on foot: which way you face');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: 'car' }), 'car');
  assert.equal(markerFor({ mode: 'browse', legMode: null, vehicle: 'chevron' }), 'chevron');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: undefined }), 'chevron', 'the chevron by default, as on main');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: 'something old' }), 'chevron');
});

test('train legs from the planner carry their stations with times', () => {
  const until = Object.values(feeds).map((f) => f.until).sort()[0];
  const at = Date.parse(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}T09:00:00+08:00`) - 8 * 86400_000;
  const plan = planTransit([101.6865, 3.134], [101.7116, 3.1579], at);
  const leg = plan.trips[0].legs.find((l) => l.mode === 'train');
  assert.equal(leg.stations.length, leg.stops + 1);
  assert.deepEqual([leg.stations[0][0], leg.stations.at(-1)[0]], [leg.from.name, leg.to.name]);
  assert.equal(leg.stations[0][3], 0);
  assert.ok(leg.stations.every((s, i) => !i || s[3] > leg.stations[i - 1][3]), 'times go up');
  assert.ok(Math.abs(leg.stations.at(-1)[3] - leg.duration) <= 1, 'the last is the ride');
});
