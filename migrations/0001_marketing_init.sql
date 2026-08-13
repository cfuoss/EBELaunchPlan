CREATE TABLE IF NOT EXISTS campaigns (
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

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  description TEXT,
  channel TEXT NOT NULL,
  retailer TEXT,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  ptype TEXT,
  discount REAL,
  baseline REAL,
  promo_rev REAL,
  post_rev REAL,
  true_cost REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_promotions_channel ON promotions(channel);
CREATE INDEX IF NOT EXISTS idx_promotions_campaign ON promotions(campaign_id);
