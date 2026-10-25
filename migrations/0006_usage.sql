-- Daily usage numbers for the owner's dashboard (see src/lib/usage.js).
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, peak_active INTEGER NOT NULL DEFAULT 0, peak_at INTEGER, signups INTEGER NOT NULL DEFAULT 0, routes INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage_devices (day TEXT NOT NULL, device TEXT NOT NULL, account INTEGER NOT NULL DEFAULT 0, turned_away INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, device));
