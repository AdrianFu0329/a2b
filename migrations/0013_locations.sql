-- A2B's own place search (see src/lib/locations.js): shops, landmarks, streets and addresses from Overture Maps and
-- OpenStreetMap (loaded by scripts/build-locations.py), and places drivers add. locations_fts is its full-text index,
-- kept in step by the code rather than triggers. cell is the 0.1° square a place is in (lat x 10 rows of 2000), for
-- looking around a person without the full-text index (see COMMON there); spot is the 0.01° square (~1 km), for
-- what's at a point (nearest there), which would otherwise read every row.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, source TEXT NOT NULL, user_id INTEGER, created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
  cell INTEGER GENERATED ALWAYS AS (CAST(round(lat * 10) AS INTEGER) * 2000 + CAST(round(lng * 10) AS INTEGER)) VIRTUAL,
  spot INTEGER GENERATED ALWAYS AS (CAST(round(lat * 100) AS INTEGER) * 20000 + CAST(round(lng * 100) AS INTEGER)) VIRTUAL
);
CREATE INDEX IF NOT EXISTS locations_user ON locations (user_id, created_at) WHERE user_id IS NOT NULL; -- drivers' places only
CREATE INDEX IF NOT EXISTS locations_cell_name ON locations (cell, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS locations_spot ON locations (spot);
CREATE VIRTUAL TABLE IF NOT EXISTS locations_fts USING fts5(name, address, content='locations', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
