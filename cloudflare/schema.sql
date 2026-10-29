CREATE TABLE IF NOT EXISTS radar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  location TEXT NOT NULL,
  watched TEXT NOT NULL,
  available TEXT NOT NULL,
  last_check TEXT,
  last_error TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO radar (id, location, watched, available) VALUES (1, 'B2 4JH', '["R118","R255","R308","R215","R136","R153"]', '[]');
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_reports (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  available TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
