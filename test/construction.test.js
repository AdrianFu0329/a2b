// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twinStretches } from '../src/lib/construction.js';

const road = Array.from({ length: 11 }, (_, i) => [101.48 + 0.0009 * i, 3.22]); // ~1 km heading east
const shift = (line, dLng, dLat) => line.map(([x, y]) => [x + dLng, y + dLat]);

test('a route running right beside a road under construction is found', () => {
  const hits = twinStretches(road, [shift(road, 0, 0.00012)]); // ~13 m north, the other half of a divided road
  assert.equal(hits.length, 1);
  const [lng, lat] = hits[0];
  assert.ok(Math.abs(lat - 3.22) < 1e-9 && lng > 101.483 && lng < 101.486, 'the middle of the stretch, on the route');
  // The opposite direction of travel is still alongside.
  assert.equal(twinStretches([...road].reverse(), [shift(road, 0, 0.00012)]).length, 1);
});

test('nearby roads that are not its twin are left alone', () => {
  assert.equal(twinStretches(road, [shift(road, 0, 0.0006)]).length, 0, '~66 m away: a separate road');
  assert.equal(twinStretches(road, [[[101.4845, 3.215], [101.4845, 3.225]]]).length, 0, 'crossing it');
  assert.equal(twinStretches(road, [[[101.48, 3.22012], [101.4805, 3.22012]]]).length, 0, 'only ~55 m alongside');
  assert.deepEqual(twinStretches(road, []), []);
});
