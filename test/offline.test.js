// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lngLatToTile, tileUrl, tilesForCoords } from '../public/offline.js';

test('lngLatToTile centres the world at low zoom', () => {
  assert.deepEqual(lngLatToTile(0, 0, 0), { z: 0, x: 0, y: 0 });
  assert.deepEqual(lngLatToTile(101.7, 3.15, 14), { z: 14, x: 12820, y: 8048 });
});

test('lngLatToTile clamps poles and antimeridian', () => {
  const t = lngLatToTile(0, 90, 4);
  assert.equal(t.y, 0);
  assert.ok(lngLatToTile(200, 0, 4).x <= 15);
  assert.ok(lngLatToTile(-200, 0, 4).x >= 0);
});

test('tileUrl fills the template', () => {
  assert.equal(
    tileUrl('https://tiles.example.org/planet/20261025_pt/{z}/{x}/{y}.pbf', { z: 14, x: 12820, y: 8048 }),
    'https://tiles.example.org/planet/20261025_pt/14/12820/8048.pbf',
  );
});

test('tilesForCoords dedupes overlapping points and orders low zoom first', () => {
  const tiles = tilesForCoords([[101.7, 3.15], [101.7001, 3.1501]], [14, 12], 0);
  const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
  assert.equal(keys.length, new Set(keys).size); // no duplicates
  assert.ok(tiles[0].z === 12 && tiles.at(-1).z === 14); // context before detail
});

test('tilesForCoords buffer adds neighbours but stays in range', () => {
  const tiles = tilesForCoords([[179.9, 0]], [2], 1);
  const n = 4;
  assert.ok(tiles.length > 0 && tiles.length <= 9);
  for (const t of tiles) assert.ok(t.x >= 0 && t.y >= 0 && t.x < n && t.y < n);
});

test('a short drive stays within prefetch budget', () => {
  // ~15 km of points every ~100 m, like a route from KL to Putrajaya sampled coarsely.
  const coords = [];
  for (let i = 0; i <= 150; i++) coords.push([101.7 + i * 0.0009, 3.15 - i * 0.0004]);
  const tiles = tilesForCoords(coords, [12, 13, 14, 15, 16]);
  assert.ok(tiles.length < 6000, `got ${tiles.length} tiles`);
});
