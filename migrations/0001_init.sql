-- Keep in sync with src/lib/schema.js (which creates the same tables on first request).
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
CREATE INDEX IF NOT EXISTS trips_user ON trips (user_id, updated_at)
