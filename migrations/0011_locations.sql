-- A2B's own place search (see src/lib/locations.js): shops, landmarks, streets and addresses from Overture Maps and
-- OpenStreetMap (loaded by scripts/build-locations.py), and places drivers add. locations_fts is its full-text index,
-- kept in step by the code rather than triggers.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, source TEXT NOT NULL, user_id INTEGER, created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS locations_user ON locations (user_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS locations_fts USING fts5(name, address, content='locations', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
