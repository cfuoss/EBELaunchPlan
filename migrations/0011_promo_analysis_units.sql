-- Promo Analysis rework: track units alongside dollars, and replace the
-- manually-entered "True Cost" with a formula:
--   Manufacturer Chargeback = Cost per Redemption x Promo Units (redemptions)
--   True Cost = Manufacturer Chargeback + Other Costs
-- true_cost stays as a stored column (now computed client-side and written
-- back on save, same save path as before) so ROI keeps reading it directly.

ALTER TABLE promotions ADD COLUMN baseline_units REAL;
ALTER TABLE promotions ADD COLUMN promo_units REAL;
ALTER TABLE promotions ADD COLUMN post_units REAL;
ALTER TABLE promotions ADD COLUMN cost_per_redemption REAL;
ALTER TABLE promotions ADD COLUMN other_costs REAL;
