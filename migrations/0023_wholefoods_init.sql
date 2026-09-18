-- Whole Foods raw sales data, extracted from the "Raw Data" table in the
-- Whole Foods Sales Report Power BI semantic model. Source-only columns
-- (excludes DAX-calculated columns like Year/Month/State/DaysReported that
-- are derivable from Date/Store and, in a couple of cases, TODAY()-relative).

CREATE TABLE raw_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT,
  store TEXT,
  status TEXT,
  store_num INTEGER,
  nat_upc INTEGER,
  flavor TEXT,
  size REAL,
  uom TEXT,
  date TEXT,
  net_sales REAL,
  unit_sales INTEGER,
  brand_name TEXT,
  family TEXT,
  category TEXT,
  subcategory TEXT,
  class TEXT,
  asin TEXT,
  channel TEXT,
  net_sales_ly REAL,
  pct_net_sales_yoy TEXT,
  unit_sales_ly INTEGER,
  pct_unit_sales_yoy TEXT,
  avg_net_retail_price REAL,
  gross_sales REAL,
  return_sales REAL,
  gross_units INTEGER,
  return_units INTEGER,
  source TEXT,
  source_name TEXT
);

CREATE INDEX idx_wholefoods_raw_date ON raw_data(date);
CREATE INDEX idx_wholefoods_raw_store ON raw_data(store);
CREATE INDEX idx_wholefoods_raw_flavor ON raw_data(flavor);
CREATE INDEX idx_wholefoods_raw_asin ON raw_data(asin);
