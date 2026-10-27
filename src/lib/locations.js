// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A2B's own place search: shops, landmarks, streets and addresses loaded from Overture Maps and OpenStreetMap
// (scripts/build-locations.py), plus places drivers add. Searched with SQLite full-text search in D1, so finding a
// place needs no outside service. locations_fts is kept in step here rather than with triggers.

import { distance } from '../../public/geo.js';
import { httpError } from './providers.js';

const NEAR_DEG = 0.45; // ~50 km around the person: look here first
const CANDIDATES = 120; // text matches to rank by distance
const ADD_PER_DAY = 20; // places one account can add a day
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
        // bm25 is negative, more so for better matches; a name that starts with the query does better still.
        const starts = r.name.toLowerCase().startsWith(String(q).trim().toLowerCase()) ? -2 : 0;
        return r.rank + starts + Math.log1p(km) * (words > 1 ? 0.6 : 1);
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

    async add(user, body) {
      const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
      const address = String(body?.address ?? '').trim().replace(/\s+/g, ' ');
      const category = String(body?.category ?? '').trim().toLowerCase();
      const lat = Number(body?.lat), lng = Number(body?.lng);
      if (name.length < 2 || name.length > 80) throw httpError('Give the place a name (2 to 80 characters).', 400);
      if (address.length > 120 || category.length > 40) throw httpError('That address or category is too long.', 400);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError('The place needs a position on the map.', 400);
      const since = Date.now() - 86_400_000;
      const { n } = await db.prepare('SELECT count(*) AS n FROM locations WHERE user_id = ? AND created_at > ?').bind(user.id, since).first();
      if (n >= ADD_PER_DAY) throw httpError(`You can add up to ${ADD_PER_DAY} places a day.`, 429);
      const row = await db
        .prepare(
          `INSERT INTO locations (name, address, category, kind, lat, lng, source, user_id, created_at)
           VALUES (?, ?, ?, 'place', ?, ?, 'driver', ?, ?) RETURNING id`,
        )
        .bind(name, address, category, lat, lng, user.id, Date.now())
        .first();
      await db.prepare('INSERT INTO locations_fts (rowid, name, address) VALUES (?, ?, ?)').bind(row.id, name, address).run();
      return { id: row.id, name, address, lat, lng, category: category || 'place', kind: 'place', source: 'driver' };
    },

    async mine(user) {
      const { results } = await db
        .prepare(`SELECT id, name, address, category, kind, lat, lng, source FROM locations WHERE user_id = ? AND removed = 0 ORDER BY created_at DESC LIMIT 200`)
        .bind(user.id)
        .all();
      return results.map((r) => toPlace(r));
    },

    // Drivers remove their own; testers can remove any place, including loaded ones that are wrong.
    async remove(user, id, { tester = false } = {}) {
      const row = await db.prepare('SELECT id, name, address, user_id FROM locations WHERE id = ? AND removed = 0').bind(id).first();
      if (!row || (!tester && row.user_id !== user.id)) throw httpError('Place not found.', 404);
      await db.batch([
        db.prepare('UPDATE locations SET removed = 1 WHERE id = ?').bind(id),
        db.prepare(`INSERT INTO locations_fts (locations_fts, rowid, name, address) VALUES ('delete', ?, ?, ?)`).bind(id, row.name, row.address),
      ]);
    },
  };
}
