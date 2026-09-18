-- Repeat Revenue ($) is replaced by Repeat Sales % (a directly-entered
-- percentage used in the Budget vs Actuals revenue-mix breakdown: Ad Sales %,
-- Repeat Sales %, Organic Sales %). Purely additive column; the old
-- repeat_revenue column is left in place but no longer written to.

ALTER TABLE ad_budget_line_items ADD COLUMN repeat_sales_pct REAL;
