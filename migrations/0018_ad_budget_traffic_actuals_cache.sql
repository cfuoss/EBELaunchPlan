-- Cache for per-product (ASIN) Seller Central Sales & Traffic actuals, pulled
-- from Windsor.ai on a schedule (see the scheduled() cron handler in
-- src/index.js) rather than live on page load — Amazon's own Sales & Traffic
-- report generation is too slow (multi-minute) for a live per-request fetch.
-- Stored at DAILY grain (matching Amazon's native report) so re-aggregating
-- to months (or any other window) later never double-counts a partial pull;
-- the ad-budget/traffic-actuals API route sums these up to months for the
-- page. Each cron run re-upserts recent days, so a late-arriving Amazon
-- report correction just overwrites the cached row for that day.

CREATE TABLE IF NOT EXISTS ad_budget_traffic_actuals (
  channel TEXT NOT NULL,
  asin TEXT NOT NULL,
  event_date TEXT NOT NULL,
  sessions REAL,
  units_ordered REAL,
  sales_amount REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, asin, event_date)
);

CREATE INDEX IF NOT EXISTS idx_ad_budget_traffic_actuals_asin ON ad_budget_traffic_actuals(asin);
