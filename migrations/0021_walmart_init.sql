-- Walmart data store: Marketplace (orders/items) + Walmart Connect (ads).
-- walmart_tokens holds one row per API surface ('marketplace' or 'connect')
-- since each has its own OAuth credentials and independent token lifecycle
-- (mirrors the instacart_tokens pattern in the instacart-data-mcp Worker).

CREATE TABLE walmart_tokens (
  api TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

-- Marketplace orders (header) via the Orders API.
CREATE TABLE walmart_orders (
  purchase_order_id TEXT PRIMARY KEY,
  customer_order_id TEXT,
  order_date TEXT,
  status TEXT,
  order_type TEXT,
  shipping_method TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX idx_walmart_orders_date ON walmart_orders(order_date);
CREATE INDEX idx_walmart_orders_status ON walmart_orders(status);

-- Marketplace order line items, one row per line within an order.
CREATE TABLE walmart_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id TEXT NOT NULL REFERENCES walmart_orders(purchase_order_id),
  line_number TEXT,
  sku TEXT,
  item_name TEXT,
  quantity INTEGER,
  charge_amount REAL,
  charge_type TEXT,
  line_status TEXT
);

CREATE INDEX idx_walmart_order_lines_po ON walmart_order_lines(purchase_order_id);
CREATE INDEX idx_walmart_order_lines_sku ON walmart_order_lines(sku);

-- Walmart Connect (Sponsored Search / Display) campaign metadata.
CREATE TABLE walmart_ad_campaigns (
  campaign_id TEXT PRIMARY KEY,
  name TEXT,
  campaign_type TEXT,
  status TEXT,
  daily_budget REAL,
  total_budget REAL,
  start_date TEXT,
  end_date TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- Daily Walmart Connect performance metrics per campaign.
CREATE TABLE walmart_ad_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES walmart_ad_campaigns(campaign_id),
  report_date TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  attributed_sales REAL NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  UNIQUE(campaign_id, report_date)
);

CREATE INDEX idx_walmart_ad_perf_date ON walmart_ad_performance(report_date);
