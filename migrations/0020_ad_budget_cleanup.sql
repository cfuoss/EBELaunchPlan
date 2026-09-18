-- Removes schema left behind by superseded designs, confirmed unreferenced
-- in src/index.js and empty in production before this migration:
--
-- 1. ad_budget_line_items.{sessions, organic_conversion_rate, units_ordered,
--    repeat_revenue, organic_aov, repeat_sales_pct} — added in 0014-0016 for
--    an "Organic Traffic on the PPC line item" design that was superseded by
--    the dedicated ad_budget_traffic_line_items table (0017). Never migrated
--    off; all-NULL across every existing row.
--
-- 2. ad_budget_income_actuals — created in 0019 to cache Sophie Society's
--    Financial Summary feed, but Income Statement actuals were switched to
--    live Business Central queries instead (see getIncomeActualsFromBc /
--    getRevenueActualsFromBc in src/index.js) before this table was ever
--    written to. 0 rows, zero code references.

ALTER TABLE ad_budget_line_items DROP COLUMN sessions;
ALTER TABLE ad_budget_line_items DROP COLUMN organic_conversion_rate;
ALTER TABLE ad_budget_line_items DROP COLUMN units_ordered;
ALTER TABLE ad_budget_line_items DROP COLUMN repeat_revenue;
ALTER TABLE ad_budget_line_items DROP COLUMN organic_aov;
ALTER TABLE ad_budget_line_items DROP COLUMN repeat_sales_pct;

DROP TABLE ad_budget_income_actuals;
