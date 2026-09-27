-- Cache for daily PPC actuals (spend, clicks, orders, ad sales) per channel,
-- replacing the live Triple Whale ads_table query, which stopped returning
-- Amazon/Walmart ad data. Fed the same way as ad_budget_traffic_actuals: a
-- nightly scheduled Claude agent pulls Helium 10 Ads (14-day attribution)
-- and commits ad-actuals-latest.json to the cfuoss/ebe-data-cache GitHub
-- relay; the Worker's Cron Trigger upserts it here. Daily grain so partial
-- pulls and late Amazon attribution updates just overwrite their own days.

CREATE TABLE IF NOT EXISTS ad_budget_ad_actuals (
  channel TEXT NOT NULL,
  event_date TEXT NOT NULL,
  spend REAL,
  clicks REAL,
  orders REAL,
  ad_sales REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, event_date)
);
