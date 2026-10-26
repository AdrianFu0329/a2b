-- Feedback sent from Settings, read by the owner in Settings › Testing › Feedback (see src/worker.js).
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, user_id INTEGER, device TEXT, message TEXT NOT NULL, app TEXT, ua TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_device ON feedback (device, created_at);
