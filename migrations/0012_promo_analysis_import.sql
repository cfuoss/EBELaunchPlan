-- Populates baseline/promo/post units & $, cost-per-redemption, and true_cost
-- for the 12 completed Retail promotions from the attached SPINS/Treater POS
-- results file (ebe_promo_performance_data.xlsx). Weekly rates from that file
-- were scaled to each promo's own date-range length (days/7) to get period
-- totals, matching how Baseline $/Promo $/Post $ are already used elsewhere
-- in this tool. Cost per Redemption = the file's Discount $/Unit; Whole Foods
-- Market rows have no discount/trade-spend data on file (Treater POS has no
-- promo/non-promo price split), so cost_per_redemption/true_cost are left
-- NULL there rather than guessed.

UPDATE promotions SET baseline_units=160.0, baseline=957.54, promo_units=124.9, promo_rev=473.17, post_units=167.7, post_rev=994.10, cost_per_redemption=2.1951, true_cost=274.17, updated_at=datetime('now') WHERE id='P53'; -- The Fresh Market 1/25-1/28
UPDATE promotions SET baseline_units=1585.3, baseline=9606.66, promo_units=1689.1, promo_rev=7699.27, post_units=1993.2, post_rev=12651.41, cost_per_redemption=1.4301, true_cost=2415.58, updated_at=datetime('now') WHERE id='P50'; -- Albertsons Companies 1/28-2/24
UPDATE promotions SET baseline_units=282.5, baseline=1692.32, promo_units=169.7, promo_rev=858.38, post_units=360.6, post_rev=2153.78, cost_per_redemption=0.8854, true_cost=150.25, updated_at=datetime('now') WHERE id='P49'; -- Raley's Supermarkets 2/6-3/5
UPDATE promotions SET baseline_units=3448.1, baseline=20633.86, promo_units=13812.2, promo_rev=59195.58, post_units=7971.8, post_rev=48610.11, cost_per_redemption=1.7018, true_cost=23505.60, updated_at=datetime('now') WHERE id='P51'; -- Sprouts 2/11-2/24
UPDATE promotions SET baseline_units=1091.0, baseline=6230.32, promo_units=1171.2, promo_rev=5705.31, post_units=1512.2, post_rev=8444.98, cost_per_redemption=0.8599, true_cost=1007.11, updated_at=datetime('now') WHERE id='P47'; -- NCG 3/1-3/29
UPDATE promotions SET baseline_units=1312.3, baseline=7044.16, promo_units=1786.3, promo_rev=7974.11, post_units=1679.9, post_rev=8536.65, cost_per_redemption=0.9007, true_cost=1608.92, updated_at=datetime('now') WHERE id='P46'; -- Natural Grocers 3/1-3/30
UPDATE promotions SET baseline_units=1796.1, baseline=10758.90, promo_units=2022.4, promo_rev=10192.39, post_units=1580.5, post_rev=9380.38, cost_per_redemption=0.9371, true_cost=1895.19, updated_at=datetime('now') WHERE id='P45'; -- The Fresh Market 3/2-4/4
UPDATE promotions SET baseline_units=13744.9, baseline=89201.28, promo_units=13398.2, promo_rev=74390.32, post_units=13570.6, post_rev=87981.16, cost_per_redemption=0.9072, true_cost=12154.85, updated_at=datetime('now') WHERE id='P43'; -- Sprouts 4/29-5/26
UPDATE promotions SET baseline_units=506.1, baseline=2525.30, promo_units=1.9, promo_rev=7.39, post_units=753.5, post_rev=3760.14, cost_per_redemption=1.0102, true_cost=1.92, updated_at=datetime('now') WHERE id='P41'; -- Wegmans 5/18-5/31
UPDATE promotions SET baseline_units=14194.1, baseline=88241.66, promo_units=24601.0, promo_rev=153215.18, post_units=17442.3, post_rev=108803.32, cost_per_redemption=NULL, true_cost=NULL, updated_at=datetime('now') WHERE id='P48'; -- Whole Foods Market 2/25-3/10
UPDATE promotions SET baseline_units=27026.4, baseline=168688.12, promo_units=37215.7, promo_rev=231040.66, post_units=29114.3, post_rev=181974.34, cost_per_redemption=NULL, true_cost=NULL, updated_at=datetime('now') WHERE id='P44'; -- Whole Foods Market 4/22-5/12
UPDATE promotions SET baseline_units=28215.0, baseline=176125.92, promo_units=56480.7, promo_rev=345252.50, post_units=33013.6, post_rev=198761.71, cost_per_redemption=NULL, true_cost=NULL, updated_at=datetime('now') WHERE id='P33'; -- Whole Foods Market 7/8-7/28
