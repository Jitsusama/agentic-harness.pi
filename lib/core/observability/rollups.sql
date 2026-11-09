-- Weekly per-model, per-persona summaries over every row held, unioned
-- with the legacy rollups table, which holds the only record of runs an
-- earlier retention pass deleted. A week's length is written in from
-- WEEK_MS in store.ts.
SELECT * FROM (
	SELECT
		(started_at / :week_ms) * :week_ms AS week_start,
		model, persona,
		COUNT(*) AS run_count,
		SUM(retries_to_valid) AS total_retries,
		SUM(warning_count) AS total_warnings,
		SUM(tokens_total) AS tokens_total,
		SUM(cost_total) AS cost_total,
		SUM(tokens_cache_read) AS cache_read,
		SUM(tokens_input + tokens_cache_read) AS fresh_input
	FROM runs GROUP BY week_start, model, persona
	UNION ALL
	SELECT week_start, model, persona, run_count, total_retries,
		total_warnings, tokens_total, cost_total, cache_read, fresh_input
	FROM rollups
)
ORDER BY week_start ASC, model ASC, persona ASC;
