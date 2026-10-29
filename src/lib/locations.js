// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A2B's own place search: shops, landmarks, streets and addresses loaded from Overture Maps and OpenStreetMap
// (scripts/build-locations.py), searched with SQLite full-text search in D1, so finding a place needs no outside
// service. Rows marked removed are left out.

import { distance } from '../../public/geo.js';

// Around the person, nearest first: ~5 km, then ~50 km, then everywhere. Matches that score alike (every "KFC")
// would otherwise fill the candidates with any 120 of a chain's branches, not the nearest.
const AROUND_DEG = [0.05, 0.45];
const CANDIDATES = 120; // text matches to rank by distance
const AROUND_CELLS = 1; // cells (0.1°, ~11 km) each way around the person, for searches of only common words
export const KINDS = ['place', 'landmark', 'street', 'address'];
// Landmarks people head for, as scripts/build-locations.py VENUES.
const VENUES = new Set([
  'shopping_center', 'shopping_mall', 'mall', 'train_station', 'metro_station', 'rail_station', 'station', 'airport', 'aerodrome',
  'terminal', 'ferry_terminal', 'bus_station', 'hospital', 'university', 'college_university', 'stadium', 'museum', 'zoo',
  'theme_park', 'convention_center', 'tourist_attraction', 'attraction',
]);

// Words in a huge share of names and addresses (each in over 15,000 of them; "jalan" is in 330,000) and words shorter
// than 3 letters: matching them in the full-text index means scoring that many rows, up to ~0.5 s of the database's
// single thread and as many rows read. They narrow the matches of the other words instead; a search of nothing else
// looks around the person. From the October 2026 data; rebuild the list with the counts scripts/build-locations.py prints.
export const COMMON = new Set([
  'jalan', 'jln', 'lorong', 'lrg', 'persiaran', 'taman', 'tmn', 'kampung', 'kg', 'bandar', 'pusat', 'kota', 'bukit',
  'sungai', 'sg', 'batu', 'baru', 'jaya', 'alam', 'indah', 'perdana', 'sri', 'seri', 'kuala', 'lumpur', 'petaling', 'shah',
  'johor', 'bahru', 'ipoh', 'klang', 'kinabalu', 'kuching', 'miri', 'malaysia', 'lot', 'floor', 'ground', 'centre', 'mall',
  'restoran', 'restaurant', 'cafe', 'kedai', 'klinik', 'masjid', 'sdn', 'bhd', 'the', 'and',
]);

const textWords = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// A query's words: the first 6 are plenty to find a place.
export const queryWords = (q) => textWords(q).slice(0, 6);

// "Nando's Bangsar" -> "nando"* "s" "bangsar"*: distinctive words as prefixes, so results appear while typing, and
// common or short ones as whole words, which only narrow theirs (cheap: the cost is in what all the words match).
// The last word, maybe half typed, is left to hasAll unless it's distinctive. null without a distinctive word ("jalan",
// "kl"): around() answers those.
export function ftsQuery(q) {
  const words = queryWords(q);
  const distinct = (w) => w.length >= 3 && !COMMON.has(w);
  if (!words.some(distinct)) return null;
  return words
    .map((w, i) => (distinct(w) ? `"${w}"*` : i < words.length - 1 ? `"${w}"` : null))
    .filter(Boolean)
    .join(' ');
}

// Every query word starts a word of the place's name or address.
const hasAll = (r, words) => {
  const text = textWords(`${r.name} ${r.address}`); // all of them: "Nu Sentral" is the 7th word of "KFC, Lot No. 16, Level 5, …"
  return words.every((w) => text.some((t) => t.startsWith(w)));
};

const toPlace = (r, near) => ({
  id: r.id,
  name: r.name,
  address: r.address,
  lat: r.lat,
  lng: r.lng,
  category: r.category || r.kind,
  kind: r.kind,
  source: r.source,
  ...(near ? { km: Math.round(distance(near, [r.lng, r.lat]) / 100) / 10 } : {}),
});

export function locationsRepo(db) {
  const match = (fts, box) =>
    db
      .prepare(
        // Candidates: landmarks first, then the shortest names (the score below does the ranking; bm25 would mark
        // down a place for a long address).
        `SELECT l.id, l.name, l.address, l.category, l.kind, l.lat, l.lng, l.source
         FROM locations_fts JOIN locations l ON l.id = locations_fts.rowid
         WHERE locations_fts MATCH ? AND l.removed = 0 ${box ? 'AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?' : ''}
         ORDER BY l.kind = 'landmark' DESC, length(l.name) LIMIT ${CANDIDATES}`,
      )
      .bind(fts, ...(box ?? []))
      .all()
      .then((r) => r.results);

  // Names starting with what was typed, shortest first, near the person if possible. bm25 counts a row's whole
  // length, address too, so "Sunway Pyramid" with its address scores below a thousand shorter "… Sunway Pyramid"
  // shop names; this brings the place named so into the candidates anyway.
  const leading = async (words, near) => {
    const fts = `name : ^"${words.join(' ')}"*`;
    const q = (box) =>
      db
        .prepare(
          `SELECT l.id, l.name, l.address, l.category, l.kind, l.lat, l.lng, l.source
           FROM locations_fts JOIN locations l ON l.id = locations_fts.rowid
           WHERE locations_fts MATCH ? AND l.removed = 0 ${box ? 'AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?' : ''}
           ORDER BY l.kind = 'landmark' DESC, length(l.name) LIMIT 40`,
        )
        .bind(fts, ...(box ?? []))
        .all()
        .then((r) => r.results);
    const d = AROUND_DEG.at(-1);
    const found = near ? await q([near[1] - d, near[1] + d, near[0] - d, near[0] + d]) : [];
    return found.length >= 3 ? found : found.concat(await q());
  };

  // Names starting with the query in the ~30 x 30 km around near, by the (cell, name) index (see migrations): for a search of
  // only common or short words, which the full-text index can't answer cheaply.
  const around = ([lng, lat], q) => {
    const cy = Math.round(lat * 10), cx = Math.round(lng * 10);
    const cells = [];
    for (let dy = -AROUND_CELLS; dy <= AROUND_CELLS; dy++) for (let dx = -AROUND_CELLS; dx <= AROUND_CELLS; dx++) cells.push((cy + dy) * 2000 + cx + dx);
    return db
      .prepare(
        `SELECT id, name, address, category, kind, lat, lng, source FROM locations
         WHERE cell IN (${cells.map(() => '?').join(',')}) AND removed = 0 AND name LIKE ? ESCAPE '\\' LIMIT ${CANDIDATES}`,
      )
      .bind(...cells, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .all()
      .then((r) => r.results);
  };

  return {
    // Best matches for q, nearest first among equally good ones. near: [lng, lat] or null.
    async search(q, near, limit = 10) {
      const all = queryWords(q);
      if (!all.length) return [];
      const fts = ftsQuery(q);
      let rows;
      if (!fts) {
        rows = near ? await around(near, String(q).trim()) : [];
      } else {
        rows = [];
        const seen = new Set();
        for (const d of [...(near ? AROUND_DEG : []), null]) {
          const box = d === null ? undefined : [near[1] - d, near[1] + d, near[0] - d, near[0] + d];
          for (const r of await match(fts, box)) if (!seen.has(r.id) && hasAll(r, all)) seen.add(r.id), rows.push(r);
          if (rows.length >= limit) break;
        }
        for (const r of await leading(all, near).catch(() => [])) if (!seen.has(r.id)) seen.add(r.id), rows.push(r);
      }
      const words = all.length;
      const score = (r) => {
        const km = near ? distance(near, [r.lng, r.lat]) / 1000 : 0;
        // Lower is better. A name that starts with the query does better still, and
        // a landmark (a mall, a station, a park) over a shop that only carries its name, and the places people head
        // for (a mall, a station, an airport) over other landmarks: "trx" is The Exchange TRX before TRX City Park.
        const starts = r.name.toLowerCase().startsWith(String(q).trim().toLowerCase()) ? -2 : 0;
        const exact = textWords(r.name).join(' ') === all.join(' ') ? -1.5 : 0; // "jalan ampang": the road itself
        // Only for what was named: "jalan ampang" is the road, not Ampang Park on it.
        const named = hasAll({ name: r.name, address: '' }, all);
        const landmark = r.kind === 'landmark' && named ? (VENUES.has(r.category) ? -4.5 : -2) : 0;
        // A landmark more sources list ("osm+overture+foursquare") is one more people know; not so a chain's branch,
        // where the nearest KFC is the one wanted.
        const known = r.kind === 'landmark' && named ? -2 * (String(r.source).split('+').length - 1) : 0;
        // How much of the query is in the name, and how near the name is to just that. Not bm25: it counts a row's
        // whole length, address too, so a mall with its full address lost to the shops named after it.
        const nameWords = textWords(r.name);
        const inName = all.filter((w) => nameWords.some((t) => t.startsWith(w))).length;
        const relevance = -10 * (inName / all.length) - 4 * Math.min(1, all.length / Math.max(1, nameWords.length));
        // Only Foursquare lists it: the source with the most check-in pages made up on the spot ("Trx").
        const unconfirmed = r.source === 'foursquare' ? 1.5 : 0;
        return relevance + starts + exact + landmark + known + unconfirmed + Math.log1p(km);
      };
      return rows
        .map((r) => ({ r, s: score(r) }))
        .sort((a, b) => a.s - b.s)
        .slice(0, limit)
        .map(({ r }) => toPlace(r, near));
    },

    // The closest named thing to a point (a street or a place), for "what's here?".
    async nearest([lng, lat], maxM = 120) {
      const d = 0.002;
      // The ~1 km squares (spot, see migrations) the search box touches: by index, not every row.
      const spots = [...new Set([lat - d, lat + d].flatMap((y) => [lng - d, lng + d].map((x) => Math.round(y * 100) * 20000 + Math.round(x * 100))))];
      const { results } = await db
        .prepare(
          `SELECT id, name, address, category, kind, lat, lng, source FROM locations
           WHERE spot IN (${spots.map(() => '?').join(',')}) AND removed = 0 AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 200`,
        )
        .bind(...spots, lat - d, lat + d, lng - d, lng + d)
        .all();
      const best = results.map((r) => ({ r, m: distance([lng, lat], [r.lng, r.lat]) })).filter((x) => x.m <= maxM).sort((a, b) => a.m - b.m)[0];
      return best ? toPlace(best.r) : null;
    },

    // A wrong place out of search (testers only, see src/worker.js).
    async remove(id) {
      const row = await db.prepare('SELECT id, name, address FROM locations WHERE id = ? AND removed = 0').bind(id).first();
      if (!row) return false;
      await db.batch([
        db.prepare('UPDATE locations SET removed = 1 WHERE id = ?').bind(id),
        db.prepare(`INSERT INTO locations_fts (locations_fts, rowid, name, address) VALUES ('delete', ?, ?, ?)`).bind(id, row.name, row.address),
      ]);
      return true;
    },
  };
}
