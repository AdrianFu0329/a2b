-- Devices using the app right now, for the cap on simultaneous users (see src/lib/presence.js).
CREATE TABLE IF NOT EXISTS presence (device TEXT PRIMARY KEY, user_id INTEGER, admitted INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS presence_seen ON presence (last_seen);
