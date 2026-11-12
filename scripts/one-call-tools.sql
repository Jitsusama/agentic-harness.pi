-- The one-call turns between :since_ms and :until_ms by tool, most
-- first, with how many came right after a one-call turn of the same
-- tool in the same session with only tool results between. Mesh
-- messages leave no mark in the ledger, so that count is a ceiling.
-- Times are epoch milliseconds.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
),
calls AS (
	SELECT session_id, entry_id, count(*) AS n, min(name) AS tool
	FROM tool_calls, bounds
	WHERE timestamp >= bounds.since
	GROUP BY session_id, entry_id
),
steps AS (
	SELECT
		CASE WHEN c.n = 1 THEN c.tool END AS tool,
		t.preceded_by AS precededBy,
		lag(CASE WHEN c.n = 1 THEN c.tool END)
			OVER (PARTITION BY t.session_id ORDER BY t.timestamp) AS before
	FROM bounds, turns t
	LEFT JOIN calls c ON c.session_id = t.session_id AND c.entry_id = t.entry_id
	WHERE t.kind = 'assistant'
		AND t.timestamp >= bounds.since
		AND t.timestamp < bounds.until
)
SELECT tool, count(*) AS turns, sum(coalesce(before = tool AND precededBy = 'results', 0)) AS afterItself
FROM steps
WHERE tool IS NOT NULL
GROUP BY tool
ORDER BY turns DESC, tool
LIMIT :shown
