-- Each session's assistant turns between :since_ms and :until_ms, what
-- its cache reads cost and how many tokens they read, the tools it
-- called as `name=count` joined by commas, and whether the ledger holds
-- the calls its scripts made. A script's calls count under the tools
-- they ran, and the gateway's runner by the larger of its own calls and
-- the gateway calls held, since one made outside a script is both.
-- Times are epoch milliseconds.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
),
own AS (
	SELECT session_id, name, count(*) AS n
	FROM tool_calls, bounds
	WHERE timestamp >= bounds.since AND timestamp < bounds.until
	GROUP BY session_id, name
),
nested AS (
	SELECT session_id, name, via, count(*) AS n
	FROM inner_calls, bounds
	WHERE timestamp >= bounds.since AND timestamp < bounds.until
	GROUP BY session_id, name, via
),
gateway AS (
	SELECT session_id, max(n) AS n
	FROM (
		SELECT session_id, n FROM own WHERE name = 'tool_gateway_run_tool'
		UNION ALL
		SELECT session_id, sum(n) FROM nested
		WHERE via = 'tool_gateway_run_tool'
		GROUP BY session_id
	)
	GROUP BY session_id
),
calls AS (
	SELECT session_id, name, sum(n) AS n
	FROM (
		SELECT session_id, name, n FROM own
		WHERE name <> 'tool_gateway_run_tool'
		UNION ALL
		SELECT session_id, name, n FROM nested
		UNION ALL
		SELECT session_id, 'tool_gateway_run_tool', n FROM gateway
	)
	GROUP BY session_id, name
),
called AS (
	SELECT session_id, group_concat(name || '=' || n, ',') AS called
	FROM calls
	GROUP BY session_id
),
seen AS (
	SELECT DISTINCT session_id FROM nested
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
	c.called,
	CASE WHEN seen.session_id IS NULL THEN 0 ELSE 1 END AS seen
FROM steps s
LEFT JOIN called c ON c.session_id = s.session_id
LEFT JOIN seen ON seen.session_id = s.session_id
