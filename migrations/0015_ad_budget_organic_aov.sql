-- Adds an Organic AOV input to the Traffic subsection so Total Sales
-- (Units Ordered x AOV, plus Repeat Revenue) can be calculated there. Purely
-- additive column on the existing ad_budget_line_items table.

ALTER TABLE ad_budget_line_items ADD COLUMN organic_aov REAL;
