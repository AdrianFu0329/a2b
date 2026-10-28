// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entranceRows, entrancesNear, pickEntrance, arrivalStreet, forgetEntrances } from '../src/lib/entrances.js';

const MID_VALLEY = [101.677, 3.118];
// As Overpass returns them (trimmed from the live data around Mid Valley).
const NODES = [
  { type: 'node', id: 1, lat: 3.1172, lon: 101.6762, tags: { amenity: 'parking_entrance', name: 'Mid Valley Car Park Zone C', ref: 'C', fee: 'yes' } },
  { type: 'node', id: 2, lat: 3.1191, lon: 101.6781, tags: { amenity: 'parking_entrance', ref: 'A' } },
  { type: 'node', id: 3, lat: 3.1183, lon: 101.6775, tags: { amenity: 'parking_entrance', access: 'private' } },
  { type: 'node', id: 4, lat: 3.1179, lon: 101.6772, tags: { amenity: 'parking_entrance', access: 'customers' } },
  { type: 'node', id: 5, lat: 3.1185, lon: 101.6760, tags: { amenity: 'parking_entrance', motorcar: 'no', name: 'Motorcycles' } },
];

function fakeServers({ overpass = NODES, overpassDown = false, matrix = 'ok' } = {}) {
  const calls = { overpass: 0, matrix: 0, bodies: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://overpass-api.de/')) {
      calls.overpass++;
      assert.match(new URLSearchParams(String(init.body)).get('data'), /around:350,3\.118,101\.677\)\[amenity=parking_entrance\]/);
      return overpassDown ? new Response('busy', { status: 429 }) : Response.json({ elements: overpass });
    }
    if (u.endsWith('/sources_to_targets')) {
      calls.matrix++;
      const body = JSON.parse(init.body);
      calls.bodies.push(body);
      if (matrix === 'down') return new Response('', { status: 500 });
      // From the south: Zone C (the southern one) is 3 minutes away, the rest 9.
      return Response.json({ sources_to_targets: [body.targets.map((t, i) => ({ to_index: i, time: t.lat < 3.1175 ? 180 : 540, distance: 1 }))] });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

test('entrances drivers may use: private and motorcycle-only ones left out, customers kept, named by ref', () => {
  assert.deepEqual(entranceRows(NODES).map((r) => r.name), ['Mid Valley Car Park Zone C', 'Entrance A', '']);
});

test('the quickest entrance to reach from where you are, counting the walk to the place', async () => {
  forgetEntrances();
  const calls = fakeServers();
  const list = await entrancesNear({}, MID_VALLEY);
  assert.deepEqual(list.map((e) => e.name), ['', 'Mid Valley Car Park Zone C', 'Entrance A'], 'nearest the place first');
  const best = await pickEntrance({ ROUTING_URL: 'https://routing.test/route' }, [101.67, 3.08], list);
  assert.equal(best.name, 'Mid Valley Car Park Zone C');
  assert.equal(calls.matrix, 1);
  assert.equal(calls.bodies[0].costing, 'auto');
  assert.deepEqual(calls.bodies[0].sources, [{ lat: 3.08, lon: 101.67 }]);
});

test('the router down: the entrance nearest the place', async () => {
  forgetEntrances();
  fakeServers({ matrix: 'down' });
  const list = await entrancesNear({}, MID_VALLEY);
  assert.equal(await pickEntrance({ ROUTING_URL: 'https://routing.test/route' }, [101.67, 3.08], list), list[0]);
  assert.equal(await pickEntrance({}, [101.67, 3.08], []), null, 'none there');
});

test('entrances are kept for a day per spot (~100 m); a failed lookup isn’t kept', async () => {
  forgetEntrances();
  fakeServers({ overpassDown: true });
  await assert.rejects(entrancesNear({}, MID_VALLEY, { now: 0 }));
  const calls = fakeServers();
  await entrancesNear({}, MID_VALLEY, { now: 1000 });
  await entrancesNear({}, [101.6772, 3.1181], { now: 3600_000 });
  assert.equal(calls.overpass, 1, 'asked again after the failure, then kept');
  await entrancesNear({}, MID_VALLEY, { now: 1000 + 86400_000 });
  assert.equal(calls.overpass, 2, 'a day later, asked again');
});

test('the street the route reaches the entrance on', () => {
  assert.equal(arrivalStreet({ steps: [{ street: 'Jalan Bukit Bintang' }, { street: 'Jalan Raja Chulan' }, { type: 'arrive', street: '' }] }), 'Jalan Raja Chulan');
  assert.equal(arrivalStreet({ steps: [] }), '');
});
