-- Walmart's Traffic Budget now takes Units Ordered as a direct monthly input
-- (no Sessions/Conversion Rate to derive it from, unlike Amazon) — purely
-- additive column on the existing table, same pattern as every prior
-- ad_budget_traffic_line_items migration. Amazon rows leave this NULL and
-- keep deriving Units Ordered from sessions x conversion_rate as before.

ALTER TABLE ad_budget_traffic_line_items ADD COLUMN units_ordered REAL;
