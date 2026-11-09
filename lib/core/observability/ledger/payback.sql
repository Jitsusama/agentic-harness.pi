-- Each real compaction beside what it dropped, how many turns came
-- after it, what the first of them still carried, and its model's cache
-- read and write rates: what the payback test is judged from.
WITH rates AS (
	SELECT model,
		SUM(cost_cache_read) * 1.0 / SUM(tokens_cache_read) AS read_rate,
		SUM(cost_cache_write) * 1.0 / SUM(tokens_cache_write) AS write_rate
	FROM turns
	WHERE kind = 'assistant'
		AND tokens_cache_read > 0 AND tokens_cache_write > 0
	GROUP BY model
),
compactions AS (
	SELECT digest, session_id, timestamp, dropped_before, model
	FROM turns
	WHERE kind = 'compaction' AND dropped_before IS NOT NULL
),
after_turns AS (
	SELECT c.digest AS compaction_digest,
		t.tokens_input + t.tokens_cache_read + t.tokens_cache_write
			AS resident,
		ROW_NUMBER() OVER (
			PARTITION BY c.digest ORDER BY t.timestamp ASC
		) AS rn
	FROM compactions c
	JOIN turns t
		ON t.session_id = c.session_id AND t.timestamp > c.timestamp
),
after_agg AS (
	SELECT compaction_digest,
		COUNT(*) AS remaining,
		MAX(CASE WHEN rn = 1 THEN resident END) AS retained
	FROM after_turns
	GROUP BY compaction_digest
)
SELECT c.dropped_before AS dropped_before,
	a.remaining AS remaining,
	a.retained AS retained,
	r.read_rate AS read_rate,
	r.write_rate AS write_rate
FROM compactions c
LEFT JOIN after_agg a ON a.compaction_digest = c.digest
LEFT JOIN rates r ON r.model = c.model;
