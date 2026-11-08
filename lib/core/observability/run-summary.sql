-- One run's subagents summed: outcomes, retries, warnings, tokens, cost.
SELECT
	COUNT(*) AS subagent_count,
	SUM(CASE WHEN verify_outcome = 'passed' THEN 1 ELSE 0 END) AS passed,
	SUM(CASE WHEN verify_outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
	SUM(retries_to_valid) AS total_retries,
	SUM(warning_count) AS total_warnings,
	SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END) AS unmetered,
	SUM(tokens_input) AS tokens_input,
	SUM(tokens_output) AS tokens_output,
	SUM(tokens_cache_read) AS tokens_cache_read,
	SUM(tokens_cache_write) AS tokens_cache_write,
	SUM(tokens_total) AS tokens_total,
	SUM(cost_input) AS cost_input,
	SUM(cost_output) AS cost_output,
	SUM(cost_cache_read) AS cost_cache_read,
	SUM(cost_cache_write) AS cost_cache_write,
	SUM(cost_total) AS cost_total
FROM runs WHERE run_id = ?;
