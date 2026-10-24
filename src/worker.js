import { ensureSchema } from './lib/schema.js';
import {
  hashPassword, verifyPassword, normalizeEmail, validatePassword, cleanName, createSession, currentUser, destroySession,
  sessionCookie, publicUser,
} from './lib/auth.js';
import { searchPlaces, reverseGeocode, fetchRoutes, annotateWithReports, httpError, bbox } from './lib/providers.js';
import { reportsRepo } from './lib/reports.js';

const MAX_BODY = 64 * 1024;
const RECENTS_KEPT = 20;
const SETTINGS_KEYS = { voice: 'boolean', units: ['metric', 'imperial'], theme: ['auto', 'day', 'night'], avoid_tolls: 'boolean', avoid_highways: 'boolean', avoid_ferries: 'boolean', alerts: 'boolean' };

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
      return json({ error: e.message || String(e) }, e.status && e.status < 600 ? e.status : 500);
    }
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
    return withSession(request, db, row, 201);
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const row = email && (await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first());
    if (!row || !(await verifyPassword(String(body.password ?? ''), row.pass_hash, row.pass_salt))) throw httpError('Wrong email or password.', 401);
    return withSession(request, db, row, 200);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await destroySession(db, request);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, null) });
  }

  if (path === '/api/me' && method === 'GET') {
    if (!user) return json({ user: null });
    return json({ user: publicUser(user), stats: await reports.stats(user.id) });
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
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    if (q.length < 2) return json({ places: [] });
    const places = await searchPlaces(env, { q, lat: num(url, 'lat'), lng: num(url, 'lng'), lang: url.searchParams.get('lang') ?? 'en' });
    return json({ places }, 200, { 'cache-control': 'public, max-age=300' });
  }

  if (path === '/api/reverse' && method === 'GET') {
    const lat = num(url, 'lat'), lng = num(url, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError('lat and lng are required.', 400);
    return json({ place: await reverseGeocode(env, { lat, lng }) });
  }

  if (path === '/api/route' && method === 'POST') {
    const body = await readJson(request);
    const from = lngLat(body.from), to = lngLat(body.to);
    if (!from || !to) throw httpError('Route needs a start and a destination.', 400);
    const area = bbox([from, to], 0.05);
    const exclude = body.avoid_closures === false ? [] : await reports.closuresNear(area);
    const routes = await fetchRoutes(env, {
      from, to, exclude,
      avoid: body.avoid ?? {},
      units: body.units === 'imperial' ? 'imperial' : 'metric',
      lang: typeof body.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang) ? body.lang : 'en-US',
      heading: Number(body.heading),
    });
    const live = await reports.inBox(bbox(routes.flatMap((r) => [r.coords[0], r.coords.at(-1)]).concat([from, to]), 0.2), user?.id);
    annotateWithReports(routes, live);
    routes.sort((a, b) => a.duration - b.duration);
    return json({ routes, closures_avoided: exclude.length });
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
    return json(await reports.create(u, await readJson(request)), 201);
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
    const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
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
    if (body.ended) sets.push('ended = 1');
    const res = await db.prepare(`UPDATE trips SET ${sets.join(', ')} WHERE token = ? AND user_id = ?`).bind(...args, parts[2], u.id).run();
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
    });
  }

  throw httpError('Not found.', 404);
}

async function withSession(request, db, row, status) {
  const { token, expires } = await createSession(db, row.id);
  return json({ user: publicUser(row) }, status, { 'set-cookie': sessionCookie(request, token, expires) });
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
