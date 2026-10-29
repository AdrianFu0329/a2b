// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A2B's own place search: shops, landmarks, streets and addresses loaded from Overture Maps and OpenStreetMap
// (scripts/build-locations.py), searched with SQLite full-text search in D1, so finding a place needs no outside
// service. Rows marked removed are left out.

import { distance } from '../../public/geo.js';

const NEAR_DEG = 0.45; // ~50 km around the person: look here first
const CANDIDATES = 120; // text matches to rank by distance
export const KINDS = ['place', 'landmark', 'street', 'address'];

// "Nando's Bangsar" -> "nando"* "s"* "bangsar"*: every word, as a prefix, so results appear while typing.
export function ftsQuery(q) {
  const words = String(q ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 6);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

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

  return {
    // Best matches for q, nearest first among equally good ones. near: [lng, lat] or null.
    async search(q, near, limit = 10) {
      const fts = ftsQuery(q);
      if (!fts) return [];
      let rows = near ? await match(fts, [near[1] - NEAR_DEG, near[1] + NEAR_DEG, near[0] - NEAR_DEG, near[0] + NEAR_DEG]) : [];
      if (rows.length < limit) {
        const seen = new Set(rows.map((r) => r.id));
        rows = rows.concat((await match(fts)).filter((r) => !seen.has(r.id)));
      }
      const words = fts.split(' ').length;
      const score = (r) => {
        const km = near ? distance(near, [r.lng, r.lat]) / 1000 : 0;
        // bm25 is negative, more so for better matches; a name that starts with the query does better still, and
        // a landmark (a mall, a station, a hospital) over a shop that only carries its name.
        const starts = r.name.toLowerCase().startsWith(String(q).trim().toLowerCase()) ? -2 : 0;
        const landmark = r.kind === 'landmark' ? -2 : 0;
        return r.rank + starts + landmark + Math.log1p(km) * (words > 1 ? 0.6 : 1);
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
