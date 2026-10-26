// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { ensureSchema } from './lib/schema.js';
import {
  hashPassword, verifyPassword, normalizeEmail, validatePassword, cleanName, createSession, currentUser, destroySession,
  sessionCookie, publicUser,
} from './lib/auth.js';
import { searchPlaces, reverseGeocode, fetchRoutes, fetchRouteAttributes, annotateWithReports, httpError, bbox, roadMidpoint, MAX_EXCLUDE } from './lib/providers.js';
import { constructionTwins } from './lib/construction.js';
import { liveTraffic, applyTraffic } from './lib/traffic.js';
import { parkingNear } from './lib/parking.js';
import { plazaDetails } from './lib/tolls.js';
import { reportsRepo } from './lib/reports.js';
import { presenceRepo, limits, validDevice } from './lib/presence.js';
import { usageRepo, USAGE_DAYS, dayOf } from './lib/usage.js';

const MAX_BODY = 64 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 8;
const RECENTS_KEPT = 20;
const FULL_MESSAGE = 'A2B is full right now. You will be let in when a spot opens.';
const SETTINGS_KEYS = { voice: 'boolean', speed_warning: 'boolean', units: ['metric', 'imperial'], theme: ['auto', 'day', 'night'], avoid_tolls: 'boolean', avoid_highways: 'boolean', avoid_ferries: 'boolean', alerts: 'boolean' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, database: Boolean(env.DB) });
      if (!env.DB) throw httpError('Database is not configured (see README).', 500);
      await ensureSchema(env.DB);
      return await route(request, env, url);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      return json({ error: e.message || String(e), code: e.code }, e.status && e.status < 600 ? e.status : 500);
    }
  },

  // Daily housekeeping (see [triggers] in wrangler.toml). Reports are kept: they count towards drivers' stats.
  async scheduled(_event, env) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM trips WHERE updated_at < ?').bind(now - 2 * 86400_000),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - LOGIN_WINDOW_MS),
      env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 86400_000),
      env.DB.prepare('DELETE FROM usage_devices WHERE day < ?').bind(dayOf(now - USAGE_DAYS * 86400_000)),
      env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(dayOf(now - USAGE_DAYS * 86400_000)),
    ]);
  },
};

async function route(request, env, url) {
  const db = env.DB;
  const method = request.method;
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean); // ['api', ...]
  const user = await currentUser(db, request);
  const reports = reportsRepo(db);
  const needUser = () => {
    if (!user) throw httpError('Sign in first.', 401);
    return user;
  };
  // Search and routing use the free public servers, so they need one of the spots (see presence.js).
  // Older copies of the app don't send a device id; they're let through until they update.
  const presence = presenceRepo(db);
  const usage = usageRepo(db);
  const count = (field) => usage.bump(field).catch((e) => console.warn('usage', e.message)); // never fails a request
  const device = request.headers.get('x-a2b-device');
  const needSpot = async () => {
    if (!validDevice(device) || (user && isTester(env, user)) || (await presence.hasSpot(device))) return;
    throw Object.assign(httpError(FULL_MESSAGE, 503), { code: 'full' });
  };

  if (path === '/api/presence' && method === 'POST') {
    if (!validDevice(device)) throw httpError('Missing device id.', 400);
    const result = await presence.checkIn(device, user, limits(env), { always: Boolean(user && isTester(env, user)) });
    await usage.sawDevice(device, user, result).catch((e) => console.warn('usage', e.message));
    return json(result);
  }

  // The owner's usage dashboard; anyone else gets a plain "not found".
  if (path === '/api/stats' && method === 'GET') {
    if (!user || !isTester(env, user)) throw httpError('Not found.', 404);
    return json(await usage.report(limits(env)));
  }

  // ---------- Accounts ----------
  if (path === '/api/auth/signup' && method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email) throw httpError('Enter a valid email address.', 400);
    const bad = validatePassword(body.password);
    if (bad) throw httpError(bad, 400);
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw httpError('An account with this email already exists. Log in instead.', 409);
    const { hash, salt } = await hashPassword(body.password);
    const settings = cleanSettings(body.settings ?? {});
    const row = await db
      .prepare('INSERT INTO users (email, name, pass_hash, pass_salt, settings, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .bind(email, cleanName(body.name, email), hash, salt, JSON.stringify(settings), Date.now())
      .first();
    await count('signups');
    return withSession(request, db, row, 201);
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email) throw httpError('Wrong email or password.', 401);
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, Date.now() - LOGIN_WINDOW_MS).first();
    if (recent.n >= LOGIN_MAX_FAILURES) throw httpError('Too many wrong passwords. Try again in 15 minutes.', 429);
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!row || !(await verifyPassword(String(body.password ?? ''), row.pass_hash, row.pass_salt))) {
      await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
      throw httpError('Wrong email or password.', 401);
    }
    await db.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
    return withSession(request, db, row, 200);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await destroySession(db, request);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, null) });
  }

  if (path === '/api/me' && method === 'GET') {
    if (!user) return json({ user: null });
    return json({ user: publicUser(user), stats: await reports.stats(user.id), tester: isTester(env, user) });
  }

  if (path === '/api/me' && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const sets = [], args = [];
    if ('name' in body) sets.push('name = ?'), args.push(cleanName(body.name, u.email));
    for (const k of ['home', 'work']) {
      if (k in body) sets.push(`${k} = ?`), args.push(body[k] ? JSON.stringify(cleanPlace(body[k])) : null);
    }
    if ('settings' in body) sets.push('settings = ?'), args.push(JSON.stringify({ ...JSON.parse(u.settings || '{}'), ...cleanSettings(body.settings) }));
    if ('password' in body) {
      if (!(await verifyPassword(String(body.current_password ?? ''), u.pass_hash, u.pass_salt))) throw httpError('Current password is wrong.', 403);
      const bad = validatePassword(body.password);
      if (bad) throw httpError(bad, 400);
      const { hash, salt } = await hashPassword(body.password);
      sets.push('pass_hash = ?', 'pass_salt = ?'), args.push(hash, salt);
    }
    if (!sets.length) return json({ user: publicUser(u) });
    const row = await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...args, u.id).first();
    return json({ user: publicUser(row) });
  }

  if (path === '/api/me' && method === 'DELETE') {
    const u = needUser();
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM places WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM trips WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM votes WHERE user_id = ?').bind(u.id),
      db.prepare('UPDATE reports SET removed = 1 WHERE user_id = ?').bind(u.id),
      db.prepare("UPDATE users SET email = 'deleted-' || id || '@invalid', name = 'Former driver', pass_hash = '', pass_salt = '', home = NULL, work = NULL WHERE id = ?").bind(u.id),
    ]);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, null) });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const rows = (await db.prepare("SELECT id, name, points FROM users WHERE pass_hash != '' ORDER BY points DESC, id LIMIT 20").all()).results;
    return json({ leaders: rows.map((r) => ({ name: r.name, points: r.points, me: user?.id === r.id })) });
  }

  // ---------- Places: saved favourites and recent destinations ----------
  if (path === '/api/places' && method === 'GET') {
    const u = needUser();
    const rows = (await db.prepare('SELECT * FROM places WHERE user_id = ? ORDER BY used_at DESC LIMIT 100').bind(u.id).all()).results;
    return json({ saved: rows.filter((r) => r.kind === 'saved'), recent: rows.filter((r) => r.kind === 'recent').slice(0, RECENTS_KEPT) });
  }

  // A guest who signs up brings the places saved on this device into the new account, in one go.
  if (path === '/api/places/import' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const now = Date.now();
    const have = (await db.prepare('SELECT kind, lat, lng FROM places WHERE user_id = ?').bind(u.id).all()).results;
    const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0002 && Math.abs(a.lng - b.lng) < 0.0002;
    const inserts = [];
    for (const [kind, cap] of [['saved', 100], ['recent', RECENTS_KEPT]]) {
      const list = Array.isArray(body[kind]) ? body[kind].slice(0, cap) : [];
      const taken = have.filter((r) => r.kind === kind);
      list.forEach((raw, i) => {
        let p;
        try {
          p = cleanPlace(raw);
        } catch {
          return; // skip a malformed entry rather than lose the rest
        }
        if (taken.some((t) => near(t, p))) return;
        taken.push(p);
        const usedAt = Number.isFinite(Number(raw.used_at)) && Number(raw.used_at) <= now ? Number(raw.used_at) : now - i; // keep the list's order
        inserts.push(db.prepare('INSERT INTO places (user_id, kind, name, address, lat, lng, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(u.id, kind, p.name, p.address, p.lat, p.lng, usedAt));
      });
    }
    if (inserts.length) await db.batch(inserts);
    await db
      .prepare(`DELETE FROM places WHERE user_id = ? AND kind = 'recent' AND id NOT IN (SELECT id FROM places WHERE user_id = ? AND kind = 'recent' ORDER BY used_at DESC LIMIT ${RECENTS_KEPT})`)
      .bind(u.id, u.id)
      .run();
    const rows = (await db.prepare('SELECT * FROM places WHERE user_id = ? ORDER BY used_at DESC LIMIT 100').bind(u.id).all()).results;
    return json({ imported: inserts.length, saved: rows.filter((r) => r.kind === 'saved'), recent: rows.filter((r) => r.kind === 'recent').slice(0, RECENTS_KEPT) });
  }

  if (path === '/api/places' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const kind = body.kind === 'saved' ? 'saved' : 'recent';
    const p = cleanPlace(body);
    const now = Date.now();
    // One row per place and kind: re-using a destination just moves it to the top.
    const existing = await db
      .prepare('SELECT id FROM places WHERE user_id = ? AND kind = ? AND ABS(lat - ?) < 0.0002 AND ABS(lng - ?) < 0.0002')
      .bind(u.id, kind, p.lat, p.lng)
      .first();
    let row;
    if (existing) {
      row = await db.prepare('UPDATE places SET used_at = ?, name = ?, address = ? WHERE id = ? RETURNING *').bind(now, p.name, p.address, existing.id).first();
    } else {
      row = await db
        .prepare('INSERT INTO places (user_id, kind, name, address, lat, lng, used_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(u.id, kind, p.name, p.address, p.lat, p.lng, now)
        .first();
    }
    if (kind === 'recent') {
      await db
        .prepare(`DELETE FROM places WHERE user_id = ? AND kind = 'recent' AND id NOT IN (SELECT id FROM places WHERE user_id = ? AND kind = 'recent' ORDER BY used_at DESC LIMIT ${RECENTS_KEPT})`)
        .bind(u.id, u.id)
        .run();
    }
    return json({ place: row }, existing ? 200 : 201);
  }

  if (parts[1] === 'places' && parts[2] && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw httpError('Name cannot be empty.', 400);
    const row = await db.prepare('UPDATE places SET name = ? WHERE id = ? AND user_id = ? RETURNING *').bind(name, Number(parts[2]), u.id).first();
    if (!row) throw httpError('Place not found.', 404);
    return json({ place: row });
  }

  if (parts[1] === 'places' && parts[2] && method === 'DELETE') {
    const u = needUser();
    await db.prepare('DELETE FROM places WHERE id = ? AND user_id = ?').bind(Number(parts[2]), u.id).run();
    return json({ ok: true });
  }

  // ---------- Search and routing ----------
  if (path === '/api/search' && method === 'GET') {
    await needSpot();
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    if (q.length < 2) return json({ places: [] });
    await count('searches');
    // Round the location to ~1 km so nearby people typing the same thing share a cached answer.
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN);
    const lat = round(num(url, 'lat')), lng = round(num(url, 'lng'));
    const lang = (url.searchParams.get('lang') ?? 'en').slice(0, 5);
    const key = new Request(`https://cache.a2b/search?q=${encodeURIComponent(q.toLowerCase())}&lat=${lat}&lng=${lng}&lang=${lang}`);
    const cache = globalThis.caches?.default;
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    const res = json(await searchPlaces(env, { q, lat, lng, lang }), 200, { 'cache-control': 'public, max-age=600' });
    if (cache) await cache.put(key, res.clone());
    return res;
  }

  if (path === '/api/parking' && method === 'GET') {
    await needSpot();
    const lat = num(url, 'lat'), lng = num(url, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError('lat and lng are required.', 400);
    // Car parks don't move: share answers for the same spot (to ~100 m) for a day.
    const key = new Request(`https://cache.a2b/parking?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`);
    const cache = globalThis.caches?.default;
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    const res = json({ parking: await parkingNear(env, [lng, lat]) }, 200, { 'cache-control': 'public, max-age=86400' });
    if (cache) await cache.put(key, res.clone());
    return res;
  }

  if (path === '/api/reverse' && method === 'GET') {
    await needSpot();
    const lat = num(url, 'lat'), lng = num(url, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError('lat and lng are required.', 400);
    return json({ place: await reverseGeocode(env, { lat, lng }) });
  }

  if (path === '/api/route' && method === 'POST') {
    await needSpot();
    const body = await readJson(request);
    const from = lngLat(body.from), to = lngLat(body.to);
    if (!from || !to) throw httpError('Route needs a start and a destination.', 400);
    const area = bbox([from, to], 0.05);
    const exclude = body.avoid_closures === false ? [] : await reports.closuresNear(area);
    const via = (Array.isArray(body.via) ? body.via : []).slice(0, 3).map(lngLat).filter(Boolean);
    const opts = {
      from, to, via, exclude,
      avoid: body.avoid ?? {},
      units: body.units === 'imperial' ? 'imperial' : 'metric',
      lang: typeof body.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang) ? body.lang : 'en-US',
      heading: Number(body.heading),
    };
    const first = await fetchRoutes(env, opts);
    let { routes } = first;
    const closuresIgnored = first.dropped;
    // A route along a road that's probably still being built (see construction.js): ask again around it, and
    // take the new routes unless they're a lot slower. Kept routes that still use one carry a warning.
    let constructionAvoided = 0;
    let twins = await constructionTwins(env.ASSETS, routes).catch(() => routes.map(() => []));
    const spots = twins.flat().slice(0, MAX_EXCLUDE - exclude.length);
    if (spots.length && !closuresIgnored) {
      const again = await fetchRoutes(env, { ...opts, exclude: [...exclude, ...spots] }).catch(() => null);
      const fastest = (rs) => Math.min(...rs.map((r) => r.duration));
      if (again && !again.dropped && fastest(again.routes) <= fastest(routes) * 1.5 + 300) {
        routes = again.routes;
        constructionAvoided = spots.length;
        twins = await constructionTwins(env.ASSETS, routes).catch(() => routes.map(() => []));
      }
    }
    routes.forEach((r, i) => {
      if (twins[i]?.length) r.warning = 'construction';
    });
    const [live] = await Promise.all([
      reports.inBox(bbox(routes.flatMap((r) => [r.coords[0], r.coords.at(-1)]).concat([from, to]), 0.2), user?.id),
      // Speed limits and toll plazas are nice-to-haves: a slow or failing lookup never holds up the route.
      ...routes.map(async (r) => {
        const a = await fetchRouteAttributes(env, r.shapes, r.coords).catch(() => null);
        r.limits = a?.limits ?? null;
        r.tolls = (a?.tolls ?? []).map((at) => ({ at }));
      }),
      // Live traffic, when TomTom is set up: the route's time with today's traffic, and where the jams are.
      ...routes.map(async (r) => {
        if (!env.TOMTOM_KEY) return;
        const [, traffic] = await Promise.all([count('tomtom'), liveTraffic(env, r).catch(() => null)]);
        applyTraffic(r, traffic);
      }),
    ]);
    for (const r of routes) delete r.shapes;
    const plazas = routes.flatMap((r) => r.tolls.map((t) => [t, r.coords[t.at]]));
    const details = await plazaDetails(db, plazas.map(([, p]) => p)).catch(() => []);
    plazas.forEach(([t], i) => Object.assign(t, details[i] ?? {}));
    annotateWithReports(routes, live);
    routes.sort((a, b) => a.duration - b.duration);
    await count('routes');
    return json({ routes, closures_avoided: closuresIgnored ? 0 : exclude.length, closures_ignored: closuresIgnored, construction_avoided: constructionAvoided });
  }

  // ---------- Reports ----------
  if (path === '/api/reports' && method === 'GET') {
    const box = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw httpError('bbox=west,south,east,north is required.', 400);
    const [w, s, e, n] = box;
    // Very zoomed-out views would return the whole world; clamp to a sane area around the centre.
    const cx = (w + e) / 2, cy = (s + n) / 2;
    const hw = Math.min((e - w) / 2, 1.5), hh = Math.min((n - s) / 2, 1);
    return json({ reports: await reports.inBox([cx - hw, cy - hh, cx + hw, cy + hh], user?.id), now: Date.now() });
  }

  if (path === '/api/reports' && method === 'POST') {
    const u = needUser();
    return json(await reports.create(u, await readJson(request), { roadAt: (p, heading) => roadMidpoint(env, p, heading) }), 201);
  }

  if (parts[1] === 'reports' && parts[3] === 'vote' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    return json(await reports.vote(u, Number(parts[2]), body.vote));
  }

  // ---------- Shared drives (live ETA link) ----------
  if (path === '/api/trips' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const dest = cleanPlace(body.destination ?? {});
    const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await db
      .prepare('INSERT INTO trips (token, user_id, dest_name, dest_lat, dest_lng, eta, route, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(token, u.id, dest.name, dest.lat, dest.lng, Number(body.eta) || null, JSON.stringify(simplify(body.route ?? [])), Date.now())
      .run();
    return json({ token, url: new URL(`/drive/${token}`, url).toString() }, 201);
  }

  if (parts[1] === 'trips' && parts[2] && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const sets = ['updated_at = ?'], args = [Date.now()];
    const pos = lngLat(body.position);
    if (pos) sets.push('lng = ?', 'lat = ?'), args.push(pos[0], pos[1]);
    if (Number.isFinite(Number(body.heading))) sets.push('heading = ?'), args.push(Number(body.heading));
    if (Number.isFinite(Number(body.eta))) sets.push('eta = ?'), args.push(Number(body.eta));
    if (Array.isArray(body.route)) sets.push('route = ?'), args.push(JSON.stringify(simplify(body.route)));
    // ended: 'arrived' (1) or 'stopped' (2, the driver stopped sharing). Stopping also forgets where they were.
    if (body.ended === 'stopped') sets.push('ended = 2', 'lat = NULL', 'lng = NULL', 'heading = NULL', "route = '[]'");
    else if (body.ended) sets.push('ended = 1');
    const res = await db
      .prepare(`UPDATE trips SET ${sets.join(', ')} WHERE token = ? AND user_id = ? AND ended = 0`)
      .bind(...args, parts[2], u.id)
      .run();
    if (!res.meta.changes) throw httpError('Drive not found.', 404);
    return json({ ok: true });
  }

  if (parts[1] === 'trips' && parts[2] && method === 'GET') {
    const t = await db
      .prepare('SELECT t.*, u.name AS driver FROM trips t JOIN users u ON u.id = t.user_id WHERE t.token = ?')
      .bind(parts[2])
      .first();
    if (!t || Date.now() - t.updated_at > 12 * 3600_000) throw httpError('This drive has ended or the link is wrong.', 404);
    return json({
      driver: t.driver,
      destination: { name: t.dest_name, lat: t.dest_lat, lng: t.dest_lng },
      position: t.lat == null ? null : { lat: t.lat, lng: t.lng, heading: t.heading },
      eta: t.eta,
      route: JSON.parse(t.route || '[]'),
      updated_at: t.updated_at,
      ended: Boolean(t.ended),
      stopped: t.ended === 2,
      now: Date.now(), // lets viewers line their clock up with updated_at
    });
  }

  throw httpError('Not found.', 404);
}

async function withSession(request, db, row, status) {
  const { token, expires } = await createSession(db, row.id);
  return json({ user: publicUser(row) }, status, { 'set-cookie': sessionCookie(request, token, expires) });
}

// Testing tools (demo drive) are for the accounts listed in the TESTER_EMAILS secret, comma separated
// (`wrangler secret put TESTER_EMAILS`), so the addresses never ship in the code.
function isTester(env, user) {
  const list = String(env.TESTER_EMAILS ?? '').split(',').map((e) => normalizeEmail(e)).filter(Boolean);
  return list.includes(normalizeEmail(user.email));
}

function cleanSettings(input) {
  const out = {};
  for (const [k, rule] of Object.entries(SETTINGS_KEYS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (rule === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(rule) && rule.includes(v)) out[k] = v;
  }
  return out;
}

function cleanPlace(p) {
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError('Place needs a valid location.', 400);
  return { name: String(p.name ?? 'Place').trim().slice(0, 80) || 'Place', address: String(p.address ?? '').trim().slice(0, 200), lat, lng };
}

function lngLat(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [lng, lat] = v.map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null;
}

// Keeps shared routes small: at most ~400 points.
function simplify(coords) {
  const pts = coords.map(lngLat).filter(Boolean);
  const step = Math.max(1, Math.ceil(pts.length / 400));
  const out = pts.filter((_, i) => i % step === 0);
  if (pts.length && out.at(-1) !== pts.at(-1)) out.push(pts.at(-1));
  return out.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
}

function num(url, key) {
  const v = url.searchParams.get(key);
  return v == null || v === '' ? NaN : Number(v);
}

async function readJson(request) {
  // Requiring a JSON content type also blocks cross-site form posts (they can't set it without CORS).
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw httpError('Body must be JSON.', 415);
  const text = await request.text();
  if (text.length > MAX_BODY) throw httpError('Request too large.', 413);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw httpError('Body must be JSON.', 400);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
