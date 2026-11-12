-- Each session's assistant turns between :since_ms and :until_ms, what
-- its cache reads cost and how many tokens they read, and the tools it
-- called as `name=count` joined by commas. Times are epoch milliseconds.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
),
calls AS (
	SELECT session_id, name, count(*) AS n
	FROM tool_calls, bounds
	WHERE timestamp >= bounds.since AND timestamp < bounds.until
	GROUP BY session_id, name
),
called AS (
	SELECT session_id, group_concat(name || '=' || n, ',') AS called
	FROM calls
	GROUP BY session_id
),
steps AS (
	SELECT
		session_id,
		count(*) AS turns,
		sum(cost_cache_read) AS readCost,
		sum(tokens_cache_read) AS readTokens
	FROM turns, bounds
	WHERE kind = 'assistant'
		AND timestamp >= bounds.since
		AND timestamp < bounds.until
	GROUP BY session_id
)
SELECT
	s.session_id AS session,
	s.turns,
	s.readCost,
	s.readTokens,
	c.called
FROM steps s
LEFT JOIN called c ON c.session_id = s.session_id
