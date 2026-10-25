-- Toll plaza details from OpenStreetMap (name, car price, ways to pay), cached per plaza. See src/lib/tolls.js.
CREATE TABLE IF NOT EXISTS toll_plazas (key TEXT PRIMARY KEY, info TEXT NOT NULL, fetched_at INTEGER NOT NULL);
