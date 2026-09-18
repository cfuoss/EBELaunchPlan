-- Adds Organic Traffic inputs (Sessions, Conversion Rate, Units Ordered,
-- Repeat Revenue) alongside the existing PPC budget drivers (Clicks, CPC,
-- Conversion Rate, AOV) on the same per-channel/month line item row. Purely
-- additive columns on the existing ad_budget_line_items table — no data loss,
-- existing rows just get NULLs for the new columns until filled in.

ALTER TABLE ad_budget_line_items ADD COLUMN sessions REAL;
ALTER TABLE ad_budget_line_items ADD COLUMN organic_conversion_rate REAL;
ALTER TABLE ad_budget_line_items ADD COLUMN units_ordered REAL;
ALTER TABLE ad_budget_line_items ADD COLUMN repeat_revenue REAL;
