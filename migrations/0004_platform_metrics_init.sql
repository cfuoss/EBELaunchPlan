-- Platform (Amazon listing) review metrics, uploaded from metric-data.xlsx.
-- platform_metric_rows is fully replaced on every upload (each file is a
-- full snapshot, not incremental data).
-- platform_metric_map persists across uploads: once an item name is mapped
-- to a product group/flavor (auto-suggested or manually corrected), that
-- mapping carries forward automatically for future uploads of the same
-- item name, so only genuinely new item names need review each time.

CREATE TABLE platform_metric_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  product_group TEXT NOT NULL,
  flavor TEXT NOT NULL,
  review_count INTEGER NOT NULL,
  star_rating REAL NOT NULL,
  refund_rate REAL,
  ordered_units INTEGER,
  ordered_revenue REAL,
  raw_product_group TEXT,
  uploaded_at TEXT NOT NULL,
  source_file TEXT
);

CREATE TABLE platform_metric_map (
  item_name TEXT PRIMARY KEY,
  product_group TEXT NOT NULL,
  flavor TEXT NOT NULL,
  auto_suggested INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
