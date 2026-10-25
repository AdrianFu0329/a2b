// Database tables, created on first use so a fresh deploy needs no migration step.
// Keep in sync with migrations/0001_init.sql (which the wrangler CLI path uses).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0, home TEXT, work TEXT, settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, subtype TEXT, lat REAL NOT NULL, lng REAL NOT NULL,
  heading REAL, comment TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  thanks INTEGER NOT NULL DEFAULT 0, still INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reports_live ON reports (expires_at, lat, lng);
CREATE INDEX IF NOT EXISTS reports_user ON reports (user_id, created_at);
CREATE TABLE IF NOT EXISTS votes (report_id INTEGER NOT NULL, user_id INTEGER NOT NULL, vote TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (report_id, user_id, vote));
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, address TEXT, lat REAL NOT NULL, lng REAL NOT NULL, used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS places_user ON places (user_id, kind, used_at);
CREATE TABLE IF NOT EXISTS trips (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, dest_name TEXT, dest_lat REAL NOT NULL, dest_lng REAL NOT NULL,
  lat REAL, lng REAL, heading REAL, eta INTEGER, route TEXT, updated_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trips_user ON trips (user_id, updated_at);
CREATE TABLE IF NOT EXISTS login_failures (email TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures (email, at);
CREATE TABLE IF NOT EXISTS toll_plazas (key TEXT PRIMARY KEY, info TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS closure_blocks (report_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL);
CREATE TABLE IF NOT EXISTS presence (device TEXT PRIMARY KEY, user_id INTEGER, admitted INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS presence_seen ON presence (last_seen);
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, peak_active INTEGER NOT NULL DEFAULT 0, peak_at INTEGER, signups INTEGER NOT NULL DEFAULT 0, routes INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage_devices (day TEXT NOT NULL, device TEXT NOT NULL, account INTEGER NOT NULL DEFAULT 0, turned_away INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, device))
`;

let ready = null;

export function ensureSchema(db) {
  ready ??= db
    .batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)))
    .catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}
