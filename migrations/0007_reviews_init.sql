-- The reviews table: source of truth for written reviews going forward,
-- replacing the single R2 JSON blob (reviews/ebe_review_data_updated.json)
-- that /api/reviews/report and the import pipeline used to read/rewrite in
-- full on every change. `source` distinguishes Amazon-scraped reviews from
-- Okendo (on-site) reviews so the report can filter/compare by source instead
-- of treating both as one undifferentiated pool.
--
-- id is the natural key from each source (Amazon Review ID, or Okendo's
-- stable per-review `hash`) -- already unique per review, and what the old
-- importer deduped on, so reused here instead of a synthetic key.

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  author TEXT,
  title TEXT,
  content TEXT,
  rating INTEGER NOT NULL,
  sentiment TEXT NOT NULL,
  taxonomy_id INTEGER REFERENCES product_taxonomy(id),
  raw_product_name TEXT,
  date TEXT,
  helpful INTEGER NOT NULL DEFAULT 0,
  verified TEXT,
  variations TEXT,
  pack_size TEXT,
  themes TEXT NOT NULL DEFAULT '[]',
  positive_keywords TEXT,
  negative_keywords TEXT,
  mixed_keywords TEXT,
  imported_at TEXT NOT NULL,
  source_file TEXT
);

CREATE INDEX idx_reviews_source ON reviews(source);
CREATE INDEX idx_reviews_taxonomy ON reviews(taxonomy_id);
CREATE INDEX idx_reviews_sentiment ON reviews(sentiment);
