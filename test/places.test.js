// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesForWord, searchNearby, mergeResults } from '../public/places.js';
import { matchesWordStarts, normalizeText } from '../public/text.js';

const ECO = [101.468, 3.224]; // Eco Grandeur, Puncak Alam

// A tiny fake /places/ tree: one area (0.5° grid, row 6, col 202) with an "nan" file and an "st" file.
const FILES = {
  '/places/index.json': { release: 'test', area: 0.5, areas: ['6_202'] },
  '/places/6_202/files.json?v=test': { n: 1, nan: 2, st: 1, _: 1 },
  '/places/6_202/nan.json?v=test': { p: [["Nando's", 101.45526, 3.2271, 'Lot 30, Ruang Niaga Eco Grandeur, Puncak Alam', 'restaurant'], ["Nando's", 101.518, 3.071, 'Aneka Walk, Shah Alam', 'restaurant']] },
  '/places/6_202/st.json?v=test': { p: [['Starbucks', 101.45806, 3.22737, 'Jalan Keramat', 'coffee_shop']] },
  '/places/6_202/n.json?v=test': { p: [] },
};
globalThis.fetch = async (url, init) => {
  // Like browsers, refuse a second argument that isn't an options object.
  if (init !== undefined && (typeof init !== 'object' || init === null)) throw new TypeError('fetch init must be an object');
  const body = FILES[url];
  return { ok: Boolean(body), json: async () => body };
};

test('text matching ignores case, accents and apostrophes', () => {
  assert.equal(normalizeText("Nando's  Café!"), 'nandos cafe');
  assert.ok(matchesWordStarts("Nando's Lot 30, Ruang Niaga Eco Grandeur", 'nando eco grand'));
  assert.ok(!matchesWordStarts("Nando's Shah Alam", 'nandos eco'));
});

test('a word picks the most specific file there is', () => {
  const files = { n: 1, na: 1, nan: 1, nas: 1, s: 1, st: 1, _: 1 };
  assert.deepEqual(filesForWord('nandos', files), ['nan']);
  assert.deepEqual(filesForWord('nasi', files), ['nas']);
  assert.deepEqual(filesForWord('na', files), ['na', 'nan', 'nas'], 'a short word also needs the files under it');
  assert.deepEqual(filesForWord('starbucks', files), ['st']);
  assert.deepEqual(filesForWord('shell', files), ['s']);
  assert.deepEqual(filesForWord('麦当劳', files), ['_']);
  assert.deepEqual(filesForWord('xyz', files), []);
});

test('finds the Nando\'s in Eco Grandeur, nearest first', async () => {
  const both = await searchNearby('nandos', ECO);
  assert.deepEqual(both.map((p) => p.address.split(',')[0]), ['Lot 30', 'Aneka Walk']);
  assert.ok(both[0].km < 2 && both[1].km > 15);
  const exact = await searchNearby('nandos eco grandeur', ECO);
  assert.equal(exact.length, 1, 'the area words must match too');
  assert.equal(exact[0].source, 'overture');
  assert.deepEqual(await searchNearby('starbucks', ECO).then((r) => r.map((p) => p.name)), ['Starbucks']);
  assert.deepEqual(await searchNearby('nandos', [-0.12, 51.5]), [], 'nothing deployed for London');
});

test('merging: best match first, then nearest, without duplicates', () => {
  const server = [
    { name: 'Eco Grandeur', address: 'Selangor', lat: 3.224, lng: 101.468 },
    { name: "Nando's", address: 'Aneka Walk, Shah Alam', lat: 3.071, lng: 101.518 },
  ];
  const local = [
    { name: "Nando's", address: 'Lot 30, Ruang Niaga Eco Grandeur', lat: 3.2271, lng: 101.45526 },
    { name: 'Nandos', address: 'Aneka Walk', lat: 3.07101, lng: 101.51801 }, // same place the server already has
  ];
  const byLat = (r) => r.map((p) => p.lat);
  assert.deepEqual(byLat(mergeResults(server, local, 'nandos eco grandeur', ECO)), [3.2271, 3.224, 3.071]);
  assert.deepEqual(byLat(mergeResults(server, local, 'nandos', ECO)), [3.2271, 3.071, 3.224], 'nearest Nando\'s first');
  const near = [{ name: 'Starbucks', address: 'Eco Grandeur', lat: 3.2274, lng: 101.458 }];
  const far = [{ name: 'Starbucks', address: 'Rawang', lat: 3.29, lng: 101.53 }];
  assert.equal(mergeResults(near, far, 'starbucks', ECO)[0].address, 'Eco Grandeur', 'a closer server result stays above');
});

test('a landmark comes first, and copies of it pinned far away are dropped', () => {
  const sentral = [101.6869, 3.139];
  const server = [{ name: 'Petronas Towers', address: 'Kuala Lumpur', lat: 3.158, lng: 101.7112, category: 'attraction', landmark: 'place' }];
  const local = [
    { name: 'PETRONAS Cari Gali Sdn Bhd, XTG PETRONAS Twin Towers', address: 'Level 16, Tower 2 KLCC', lat: 3.1395, lng: 101.687 }, // 4 km off, near the driver
    { name: 'Petronas Twin Towers Gift Shop', address: 'Suria KLCC', lat: 3.1581, lng: 101.7113 },
  ];
  const r = mergeResults(server, local, 'petronas twin towers', sentral);
  assert.deepEqual(r.map((p) => p.name), ['Petronas Towers', 'Petronas Twin Towers Gift Shop']);
  // A landmark the query doesn't start with stays where the text match puts it.
  const klcc = [{ name: 'Suria KLCC', address: 'Kuala Lumpur', lat: 3.158, lng: 101.712, landmark: 'place' }];
  const nandos = [{ name: "Nando's", address: 'Suria KLCC', lat: 3.1582, lng: 101.7121 }];
  assert.equal(mergeResults(klcc, nandos, 'nandos klcc', sentral)[0].name, "Nando's");
});

test('a sight beats a town of the same name, and a town beats a station', () => {
  const server = [
    { name: 'Batu Caves', address: '', lat: 3.2378, lng: 101.6812, landmark: 'station' },
    { name: 'Batu Caves', address: 'Gombak', lat: 3.2369, lng: 101.6833, landmark: 'area' },
    { name: 'Batu Caves temple', address: '', lat: 3.2376, lng: 101.6832, landmark: 'place' },
  ];
  const local = [{ name: 'Temple Hindu Batu Caves', address: 'Kuala Lumpur', lat: 3.149, lng: 101.69 }]; // pinned 10 km away
  const r = mergeResults(server, local, 'batu caves', [101.6869, 3.139]);
  assert.equal(r[0].landmark, 'place');
  assert.ok(!r.some((p) => p.name === 'Temple Hindu Batu Caves'));
});

test('places named after a landmark but pinned far from it are dropped ("klcc")', () => {
  const user = [101.6869, 3.139]; // ~3.5 km from KLCC
  const server = [
    { name: 'KLCC Park', address: 'Kampung Cendana', lat: 3.1553, lng: 101.7139, landmark: 'place' },
    { name: 'LRT - KLCC', address: 'Kuala Lumpur', lat: 3.1589, lng: 101.7135, landmark: 'station' },
  ];
  const local = [
    { name: 'Twin Tower , KLCC', address: 'Kuala Lumpur', lat: 3.1415, lng: 101.6887 }, // 350 m from the driver
    { name: 'Suria KLCC Malaysia', address: 'Suria KLCC', lat: 3.1462, lng: 101.6911 },
    { name: "Nando's", address: 'Suria KLCC', lat: 3.1582, lng: 101.7121 }, // really there: kept
  ];
  const names = mergeResults(server, local, 'klcc', user).map((p) => p.name);
  assert.equal(names[0], 'KLCC Park');
  assert.ok(!names.includes('Twin Tower , KLCC') && !names.includes('Suria KLCC Malaysia'));
  assert.ok(mergeResults(server, local, 'nandos klcc', user).some((p) => p.name === "Nando's"));
});
