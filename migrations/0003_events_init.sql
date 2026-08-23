CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,
  end_date TEXT,
  status TEXT,
  owner TEXT,
  brief TEXT,
  assets_needed TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
