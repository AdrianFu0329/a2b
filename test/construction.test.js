import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twinStretches, parseOverpass } from '../src/lib/construction.js';

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

test('only roads being built for cars count', () => {
  const geometry = [{ lat: 3.22, lon: 101.48 }, { lat: 3.221, lon: 101.481 }];
  const roads = parseOverpass({
    elements: [
      { type: 'way', tags: { highway: 'construction', construction: 'footway' }, geometry },
      { type: 'way', tags: { highway: 'construction', construction: 'secondary' }, geometry },
      { type: 'way', tags: { highway: 'construction' }, geometry },
    ],
  });
  assert.equal(roads.length, 2);
  assert.deepEqual(roads[0], [[101.48, 3.22], [101.481, 3.221]]);
});
