-- Amazon Income Statement tab: version-scoped single-value rate assumptions
-- (rate applies to every month of that version, unlike the per-month PPC/
-- Traffic Budget inputs) plus a monthly $ actuals cache/manual-override pair
-- mirroring the ad_budget_traffic_actuals / ad_actuals_manual pattern.
-- item_key values: shipping_income_chargeback, promotions, selling_fees,
-- refunds_spoils, fba_fees, misc_other_fees, shipping_freight_out,
-- fba_fees_storage. Amazon Advertising is deliberately excluded — its budget
-- and actual are pulled directly from the existing PPC Budget tab instead.

CREATE TABLE IF NOT EXISTS ad_budget_income_rates (
  version_id TEXT NOT NULL REFERENCES ad_budget_versions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  item_key TEXT NOT NULL,
  rate REAL,
  PRIMARY KEY (version_id, channel, item_key)
);

-- Populated from Sophie Society's get_financial_summary (SP-API Finances
-- feed) for the 5 item_keys it actually covers (promotions, selling_fees,
-- refunds_spoils, fba_fees, misc_other_fees). Same reasoning as
-- ad_budget_traffic_actuals: no server-callable REST API on that MCP, so this
-- is populated via the manual/testing ingest route, not a live per-request call.
CREATE TABLE IF NOT EXISTS ad_budget_income_actuals (
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  item_key TEXT NOT NULL,
  amount REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, month, item_key)
);

-- Manual entry for the 3 item_keys with no live source (shipping_income_chargeback,
-- shipping_freight_out, fba_fees_storage) — also usable to correct any of the
-- other 5 for a given month. A manual row always takes priority over the
-- Sophie-sourced cache above, same override pattern as ad_actuals_manual.
CREATE TABLE IF NOT EXISTS ad_income_actuals_manual (
  channel TEXT NOT NULL,
  month TEXT NOT NULL,
  item_key TEXT NOT NULL,
  amount REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, month, item_key)
);
