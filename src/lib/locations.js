// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A2B's own place search: shops, landmarks, streets and addresses loaded from Overture Maps and OpenStreetMap
// (scripts/build-locations.py), searched with SQLite full-text search in D1, so finding a place needs no outside
// service. Rows marked removed are left out.

import { distance } from '../../public/geo.js';

const NEAR_DEG = 0.45; // ~50 km around the person: look here first
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

export function queryWords(q) {
  return String(q ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 6);
}

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
  const text = queryWords(`${r.name} ${r.address}`);
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
        `SELECT l.id, l.name, l.address, l.category, l.kind, l.lat, l.lng, l.source, bm25(locations_fts, 10.0, 1.0) AS rank
         FROM locations_fts JOIN locations l ON l.id = locations_fts.rowid
         WHERE locations_fts MATCH ? AND l.removed = 0 ${box ? 'AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?' : ''}
         ORDER BY rank LIMIT ${CANDIDATES}`,
      )
      .bind(fts, ...(box ?? []))
      .all()
      .then((r) => r.results);

  // Names starting with the query in the ~30 x 30 km around near, by the (cell, name) index (see migrations): for a search of
  // only common or short words, which the full-text index can't answer cheaply.
  const around = ([lng, lat], q) => {
    const cy = Math.round(lat * 10), cx = Math.round(lng * 10);
    const cells = [];
    for (let dy = -AROUND_CELLS; dy <= AROUND_CELLS; dy++) for (let dx = -AROUND_CELLS; dx <= AROUND_CELLS; dx++) cells.push((cy + dy) * 2000 + cx + dx);
    return db
      .prepare(
        `SELECT id, name, address, category, kind, lat, lng, source, 0 AS rank FROM locations
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
        rows = near ? await match(fts, [near[1] - NEAR_DEG, near[1] + NEAR_DEG, near[0] - NEAR_DEG, near[0] + NEAR_DEG]) : [];
        rows = rows.filter((r) => hasAll(r, all));
        if (rows.length < limit) {
          const seen = new Set(rows.map((r) => r.id));
          rows = rows.concat((await match(fts)).filter((r) => !seen.has(r.id) && hasAll(r, all)));
        }
      }
      const words = all.length;
      const score = (r) => {
        const km = near ? distance(near, [r.lng, r.lat]) / 1000 : 0;
        // bm25 is negative, more so for better matches; a name that starts with the query does better still, and
        // a landmark (a mall, a station, a park) over a shop that only carries its name, and the places people head
        // for (a mall, a station, an airport) over other landmarks: "trx" is The Exchange TRX before TRX City Park.
        const starts = r.name.toLowerCase().startsWith(String(q).trim().toLowerCase()) ? -2 : 0;
        const landmark = r.kind === 'landmark' ? (VENUES.has(r.category) ? -4.5 : -2) : 0;
        // Each more source that lists it ("osm+overture+foursquare"): the best sign of a place people know.
        const known = -1.5 * (String(r.source).split('+').length - 1);
        return r.rank + starts + landmark + known + Math.log1p(km) * (words > 1 ? 0.6 : 1);
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
      const { results } = await db
        .prepare(
          `SELECT id, name, address, category, kind, lat, lng, source FROM locations
           WHERE removed = 0 AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 200`,
        )
        .bind(lat - d, lat + d, lng - d, lng + d)
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
