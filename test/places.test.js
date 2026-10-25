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
