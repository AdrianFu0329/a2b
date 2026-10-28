// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransit, withRealWalks, serviceDay, runs, board, feeds } from '../src/lib/transit.js';

const KL_SENTRAL = [101.6865, 3.134];
const KLCC = [101.7116, 3.1579];
const AMPANG = [101.7601, 3.1503];
const KAJANG = [101.7906, 2.9831];
const MID_VALLEY = [101.677, 3.118];
const PUNCAK_ALAM = [101.468, 3.224];
const USJ = [101.5851, 3.0567];
const PAVILION = [101.7136, 3.149];

// A Wednesday morning a week before the rail timetable runs out, so the tests keep working after a rebuild.
const until = feeds.prasarana.until;
const end = Date.parse(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}T09:00:00+08:00`) - 7 * 86400_000;
const WEDNESDAY_9AM = end - ((new Date(end + 8 * 3600_000).getUTCDay() + 7 - 3) % 7) * 86400_000;
const ONE_AM = WEDNESDAY_9AM + 16 * 3600_000; // Thursday 1am

const trains = (trip) => trip.legs.filter((l) => l.mode === 'train');

test('the service day is in Malaysia time', () => {
  const d = serviceDay(Date.parse('2026-10-28T23:30:00Z')); // Thursday 7:30am in KL
  assert.deepEqual(d, { date: '20261029', dow: 3, secs: 7.5 * 3600 });
  assert.ok(runs('prasarana:MonFri', serviceDay(WEDNESDAY_9AM)));
  assert.ok(!runs('prasarana:Sun', serviceDay(WEDNESDAY_9AM)));
});

test('boarding: half a headway on lines that only give a frequency, the next train on timetabled ones', () => {
  const freq = { freq: [[6 * 3600, 9 * 3600, 240], [9 * 3600, 23 * 3600, 600]], offsets: [0, 120, 300] };
  const b = board(freq, 1, 8 * 3600);
  assert.equal(b.dep, 8 * 3600 + 120);
  assert.equal(b.arrive(2), 8 * 3600 + 120 + 180);
  assert.equal(board(freq, 0, 5 * 3600).dep, 6 * 3600, 'before the first train: the first train');
  assert.equal(board(freq, 0, 23.5 * 3600), null, 'after the last');
  const timed = { trips: [[3600, 3900, 4200], [7200, 7500, 7800]] };
  assert.deepEqual([board(timed, 1, 4000).dep, board(timed, 1, 4000).arrive(2)], [7500, 7800]);
  assert.equal(board(timed, 0, 8000), null);
});

test('KL Sentral to KLCC: the Kelana Jaya Line, no changes', () => {
  const plan = planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM);
  const [best] = plan.trips;
  assert.ok(best, plan.note);
  assert.deepEqual(trains(best).map((l) => [l.line.name, l.from.name, l.to.name]), [['Kelana Jaya Line', 'KL Sentral', 'KLCC']]);
  assert.ok(best.duration > 10 * 60 && best.duration < 40 * 60, `${best.duration}s`);
  assert.equal(best.legs[0].mode, 'walk');
  assert.equal(best.legs.at(-1).mode, 'walk');
  assert.ok(trains(best)[0].every >= 2 && trains(best)[0].every <= 10, 'how often trains run');
  assert.ok(trains(best)[0].coords.length > 5, 'drawn along the track');
  assert.equal(best.arrive - best.depart, best.duration * 1000);
});

test('changes lines where they meet, and offers different ways', () => {
  const best = planTransit(KAJANG, MID_VALLEY, WEDNESDAY_9AM).trips[0];
  assert.ok(best.changes >= 1);
  assert.equal(trains(best)[0].line.kind, 'MRT', 'the Kajang Line first');
  // USJ to Pavilion: the Kelana Jaya Line, then either the MRT or the Monorail.
  const plan = planTransit(USJ, PAVILION, WEDNESDAY_9AM);
  assert.ok(plan.trips.length >= 2, 'alternatives');
  const keys = plan.trips.map((t) => trains(t).map((l) => l.line.id).join('>'));
  assert.equal(new Set(keys).size, keys.length, 'no two the same');
  assert.ok(plan.trips.every((t, i) => !i || t.arrive >= plan.trips[i - 1].arrive), 'soonest arrival first');
  assert.ok(planTransit(AMPANG, KLCC, WEDNESDAY_9AM).trips[0].changes >= 1, 'Ampang Line to the Kelana Jaya Line');
});

test('says when there are no trains: too far from a station, or late at night', () => {
  assert.match(planTransit(PUNCAK_ALAM, KLCC, WEDNESDAY_9AM).note, /no train station within walking distance of the start/i);
  assert.match(planTransit(KLCC, PUNCAK_ALAM, WEDNESDAY_9AM).note, /of the destination/i);
  const night = planTransit(KL_SENTRAL, KLCC, ONE_AM);
  assert.ok(night.night);
  assert.match(night.note, /stopped for the night/);
  assert.ok(night.firstTrain > ONE_AM + 4 * 3600_000, 'the first train is in the morning');
  assert.match(planTransit(KLCC, [101.7136, 3.149], WEDNESDAY_9AM).note ?? '', /walking/i, 'Pavilion is a short walk');
});

test('walks become real walking routes, and the trip times follow', async () => {
  const plan = planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM);
  const before = plan.trips[0].duration;
  const firstWalk = plan.trips[0].legs[0];
  const asked = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    // Every walk comes back 2 minutes longer than estimated, along a three-point path.
    const [a, b] = body.locations;
    const est = plan.trips.flatMap((t) => t.legs).find((l) => l.mode === 'walk' && Math.abs(l.from.lat - a.lat) < 1e-5 && Math.abs(l.to.lng - b.lon) < 1e-5);
    return Response.json({ trip: { summary: { length: 0.4, time: est.duration + 120 }, legs: [{ shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] } });
  };
  try {
    await withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, plan);
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(asked.every((b) => b.costing === 'pedestrian'));
  assert.equal(firstWalk.distance, 400);
  assert.equal(firstWalk.coords.length, 3);
  const walks = plan.trips[0].legs.filter((l) => l.mode === 'walk' && l.coords.length === 3).length;
  assert.equal(plan.trips[0].duration, before + walks * 120);
  assert.equal(trains(plan.trips[0])[0].depart - plan.trips[0].depart, (firstWalk.duration + trains(plan.trips[0])[0].wait) * 1000, 'the train is caught after the longer walk');
});
