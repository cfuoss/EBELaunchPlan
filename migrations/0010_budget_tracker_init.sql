-- Monthly Channel Budget vs Actuals tracker.
-- budget_versions/budget_line_items hold user-entered budget numbers, saved as
-- named, loadable versions (whole-version replace on save, same model as
-- promotions/campaigns). channel_actuals is a cache of TripleWhale-derived
-- actuals (sales + ad spend per channel per month) — refreshed by calling
-- PUT /api/marketing/budget/actuals, not pulled live by the Worker itself.

CREATE TABLE IF NOT EXISTS budget_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budget_line_items (
  version_id TEXT NOT NULL REFERENCES budget_versions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  budget_sales REAL,
  budget_spend REAL,
  PRIMARY KEY (version_id, channel, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_version ON budget_line_items(version_id);

CREATE TABLE IF NOT EXISTS channel_actuals (
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  actual_sales REAL,
  actual_spend REAL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, month)
);

CREATE TABLE IF NOT EXISTS budget_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
