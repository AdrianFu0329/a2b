-- Where a closure report blocks the road (the middle of the stretch the reporter was on; see roadMidpoint),
-- and roads OpenStreetMap marks as under construction, cached per tile (see src/lib/construction.js).
CREATE TABLE IF NOT EXISTS closure_blocks (report_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL);
CREATE TABLE IF NOT EXISTS construction_tiles (tile TEXT PRIMARY KEY, roads TEXT NOT NULL, fetched_at INTEGER NOT NULL);
