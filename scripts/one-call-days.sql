-- The model turns of each of the seven days before :until_ms, by how
-- many tool calls each made. A day is the 24 hours ending :until_ms
-- less `ago` days. Times are epoch milliseconds, written as the
-- ledger's ISO text so the comparisons stay on its strings.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
),
calls AS (
	SELECT session_id, entry_id, count(*) AS n
	FROM tool_calls, bounds
	WHERE timestamp >= bounds.since
	GROUP BY session_id, entry_id
)
SELECT
	cast(julianday(bounds.until) - julianday(t.timestamp) AS integer) AS ago,
	count(*) AS turns,
	sum(coalesce(c.n, 0) = 0) AS none,
	sum(c.n = 1) AS one,
	sum(c.n > 1) AS several
FROM bounds, turns t
LEFT JOIN calls c ON c.session_id = t.session_id AND c.entry_id = t.entry_id
WHERE t.kind = 'assistant'
	AND t.timestamp >= bounds.since
	AND t.timestamp < bounds.until
GROUP BY ago
