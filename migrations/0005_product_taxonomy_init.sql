-- Consolidated product taxonomy: the single canonical (product_group, flavor)
-- list, replacing the two hardcoded copies that previously lived in
-- src/index.js (PRODUCT_TAXONOMY) and update-reviews.html (TAXONOMY), plus
-- product_aliases, a generic raw-identifier -> taxonomy mapping table that
-- replaces platform_metric_map and the amazon-product-table.json R2 document,
-- and adds the Okendo product-name mapping this same problem needed next.
--
-- product_aliases.source values: 'platform_metric' (Amazon listing item_name
-- from metric-data.xlsx uploads), 'amazon_sku' (Amazon Product Table SKU
-- rows -- fnsku/asin/pack_size/bc_item_number carry the rest of that row's
-- detail), 'okendo_name' (Okendo CSV productName).
--
-- auto_suggested = 1 means an automatic keyword match produced this mapping
-- and it has not been human-reviewed yet (same convention platform_metric_map
-- already used) -- surfaced in the taxonomy admin UI for confirmation.

CREATE TABLE product_taxonomy (
  id INTEGER PRIMARY KEY,
  product_group TEXT NOT NULL,
  flavor TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(product_group, flavor)
);

CREATE TABLE product_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taxonomy_id INTEGER NOT NULL REFERENCES product_taxonomy(id),
  source TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  fnsku TEXT,
  asin TEXT,
  pack_size TEXT,
  bc_item_number TEXT,
  auto_suggested INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(source, raw_value)
);

CREATE INDEX idx_product_aliases_lookup ON product_aliases(source, raw_value);
CREATE INDEX idx_product_aliases_taxonomy ON product_aliases(taxonomy_id);
