-- Live-traffic lookups per day, to watch TomTom's free quota on the usage dashboard.
ALTER TABLE usage_daily ADD COLUMN tomtom INTEGER NOT NULL DEFAULT 0;
