-- Splits the Traffic Budget (Sessions, Conversion Rate, AOV, Repeat Sales %)
-- out of the single channel-level ad_budget_line_items row into its own
-- per-product-group table, keyed by ASIN. The old traffic-related columns on
-- ad_budget_line_items (sessions, organic_conversion_rate, units_ordered,
-- organic_aov, repeat_sales_pct) are left in place but no longer written to —
-- same purely-additive, never-remove pattern as prior migrations.

CREATE TABLE IF NOT EXISTS ad_budget_traffic_line_items (
  version_id TEXT NOT NULL REFERENCES ad_budget_versions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  asin TEXT NOT NULL,
  month TEXT NOT NULL,
  sessions REAL,
  conversion_rate REAL,
  aov REAL,
  repeat_sales_pct REAL,
  PRIMARY KEY (version_id, channel, asin, month)
);

CREATE INDEX IF NOT EXISTS idx_ad_budget_traffic_line_items_version ON ad_budget_traffic_line_items(version_id);
