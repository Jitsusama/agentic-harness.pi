-- Everything the ledger holds, with the turns that carried no cost
-- counted apart, so a total can say what it is missing.
SELECT
	SUM(cost_total) AS cost,
	COUNT(*) AS turns,
	SUM(CASE WHEN cost_total IS NULL THEN 1 ELSE 0 END) AS unmetered,
	SUM(tokens_cache_write) AS cache_write,
	SUM(cache_write_1h) AS cache_write_1h
FROM turns;
