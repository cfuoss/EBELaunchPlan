-- Bottoms-up Ad Spend Budget planner (starts with Amazon, built to extend to
-- other channels later). ad_budget_versions/ad_budget_line_items hold
-- user-entered budget drivers (Clicks, CPC, Conversion Rate, AOV) per
-- channel/month, saved as named, loadable versions (whole-version replace on
-- save, same model as the existing Monthly Channel Budget vs Actuals
-- tracker's budget_versions/budget_line_items). Spend, Ad Orders, Ad Sales,
-- and ROAS are derived client-side from those four inputs, not stored.
--
-- Actuals are pulled live from Triple Whale on page load (channel='amazon',
-- Every Body Eat account only) rather than cached — see getAmazonAdActuals in
-- src/index.js. ad_actuals_manual holds manually-entered actuals for months
-- Triple Whale has no data for (e.g. the Jan-Apr 2026 gap before Amazon Ads
-- was connected there); when present for a channel/month, a manual row wins
-- over the live Triple Whale value for that month.

CREATE TABLE IF NOT EXISTS ad_budget_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_budget_line_items (
  version_id TEXT NOT NULL REFERENCES ad_budget_versions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  clicks REAL,
  cpc REAL,
  conversion_rate REAL,
  aov REAL,
  PRIMARY KEY (version_id, channel, month)
);

CREATE INDEX IF NOT EXISTS idx_ad_budget_line_items_version ON ad_budget_line_items(version_id);

CREATE TABLE IF NOT EXISTS ad_budget_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ad_actuals_manual (
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  clicks REAL,
  spend REAL,
  orders REAL,
  ad_sales REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, month)
);
