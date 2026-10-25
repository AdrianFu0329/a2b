// Place search on the phone, from Overture Maps data built by scripts/build-places.py into /places/.
// Shops and restaurants that OpenStreetMap lacks (e.g. many in Malaysia) are found here. Only the files
// for the query's words, in the person's area and the areas around it, are downloaded, and the browser
// keeps them for next time. With no /places/ data deployed, this quietly finds nothing.

import { distance } from './geo.js';
import { words, matchesWordStarts } from './text.js';

const BASE = '/places';
const MAX_RESULTS = 8;
const RADIUS_KM = 60; // beyond this a place isn't "nearby" (the other search covers the rest)
const MAX_FILES_PER_WORD = 8;

const cache = new Map(); // url -> Promise<json|null>
function getJson(url, init) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, init).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(url);
}

let indexPromise = null;
function loadIndex() {
  // The index names the data release, which versions every other file, so always check it is current.
  indexPromise ??= getJson(`${BASE}/index.json`, { cache: 'no-cache' }).then((idx) => (idx ? { ...idx, areaSet: new Set(idx.areas) } : null));
  return indexPromise;
}

const asciiAlnum = /^[a-z0-9]+$/;

// The files that can hold places with a name word starting with `word`: the longest prefix that has its
// own file, or, for a word shorter than the split, its file and the longer ones under it.
export function filesForWord(word, files) {
  if (!asciiAlnum.test(word[0])) return '_' in files ? ['_'] : [];
  for (let n = Math.min(3, word.length); n >= 1; n--) {
    const p = word.slice(0, n);
    if (!asciiAlnum.test(p) || !(p in files)) continue;
    if (n < word.length || n === 3) return [p];
    return [p, ...Object.keys(files).filter((k) => k.length > p.length && k.startsWith(p))].slice(0, MAX_FILES_PER_WORD);
  }
  return [];
}

// Areas of `size` degrees: the one containing `near` and the eight around it.
function areasAround([lng, lat], size, known) {
  const row = Math.floor(lat / size), col = Math.floor(lng / size);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) out.push(`${row + dr}_${col + dc}`);
  return out.filter((a) => known.has(a));
}

export async function searchNearby(q, near) {
  const qWords = words(q).filter((w) => w.length >= 2 || /\d/.test(w));
  if (!qWords.length || !near) return [];
  const idx = await loadIndex();
  if (!idx) return [];
  const v = encodeURIComponent(idx.release ?? '');
  const areas = areasAround(near, idx.area, idx.areaSet);
  const lists = await Promise.all(areas.map((a) => getJson(`${BASE}/${a}/files.json?v=${v}`)));

  const urls = new Set();
  areas.forEach((area, i) => {
    const files = lists[i];
    if (!files) return;
    for (const w of qWords) for (const p of filesForWord(w, files)) urls.add(`${BASE}/${area}/${p}.json?v=${v}`);
  });
  const shards = await Promise.all([...urls].map((u) => getJson(u)));

  const seen = new Set();
  const found = [];
  for (const shard of shards) {
    for (const [name, lng, lat, address, category] of shard?.p ?? []) {
      const key = `${name}|${lng}|${lat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matchesWordStarts(`${name} ${address}`, q)) continue;
      const km = distance(near, [lng, lat]) / 1000;
      if (km > RADIUS_KM) continue;
      found.push({ name, address, lat, lng, category: category || 'place', km, inName: matchesWordStarts(name, q), source: 'overture' });
    }
  }
  // Places matching on their name alone first, then nearest.
  found.sort((a, b) => b.inName - a.inName || a.km - b.km);
  return found.slice(0, MAX_RESULTS);
}

// Puts nearby Overture places together with the other search's results, dropping duplicates (same name
// within 150 m), then orders them: best text match first, nearest first within that.
//   1. the name starts with the query's first word, and the rest of the query is in the name or address
//      ("nandos eco grandeur" -> Nando's, Ruang Niaga Eco Grandeur)
//   2. all of the query is somewhere in the name or address
//   3. the rest (e.g. the Eco Grandeur suburb itself)
export function mergeResults(server, local, q, near) {
  const dup = (a, b) => words(a.name).join(' ') === words(b.name).join(' ') && distance([a.lng, a.lat], [b.lng, b.lat]) < 150;
  const all = [...server, ...local.filter((l) => !server.some((s) => dup(s, l)))];
  const first = words(q)[0] ?? '';
  const tier = (p) => {
    const full = matchesWordStarts(`${p.name} ${p.address ?? ''}`, q);
    if (full && matchesWordStarts(p.name, first)) return 0;
    return full ? 1 : 2;
  };
  const km = (p) => (near ? distance(near, [p.lng, p.lat]) / 1000 : 0);
  return all
    .map((p) => ({ p, t: tier(p), d: km(p) }))
    .sort((a, b) => a.t - b.t || a.d - b.d)
    .map(({ p }) => p)
    .slice(0, 12);
}

export const attribution = 'Places: Overture Maps Foundation';
