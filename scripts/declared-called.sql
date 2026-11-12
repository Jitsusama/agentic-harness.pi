-- Declared, called: for each tool, in the sessions that held it during
-- an assistant turn between :since_ms and :until_ms (epoch ms), how
-- many held it, its size in each (comma-joined), how many called it and
-- how often, how many may have called it in a script nobody can see
-- into, and what re-reading it cost where it was never called, in
-- characters times dollars a cache-read token (divided by characters a
-- token in the script). A last row, kind 'sessions', counts the sessions
-- and joins each one's characters of declarations held a turn, and
-- counts those that worked with no declarations held yet.
--
-- What a session held comes from `declarations`, a fold of its system
-- messages: each row starts a span that the tool's next row ends. A
-- script's calls count under the tools they ran, and the gateway's
-- runner by the larger of its own calls and the gateway calls held,
-- since one made outside a script is in both tables.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
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
),
spans AS (
	SELECT
		d.session_id,
		d.tool,
		d.change,
		d.chars,
		max(d.timestamp, bounds.since) AS start,
		min(
			coalesce(
				lead(d.timestamp) OVER (
					PARTITION BY d.session_id, d.tool
					ORDER BY d.timestamp, d.seq
				),
				bounds.until
			),
			bounds.until
		) AS stop
	FROM declarations d
	JOIN steps s ON s.session_id = d.session_id, bounds
),
held AS (
	SELECT
		sp.session_id,
		sp.tool,
		sp.chars,
		sp.start,
		(
			SELECT count(*) FROM turns t
			WHERE t.session_id = sp.session_id
				AND t.kind = 'assistant'
				AND t.timestamp >= sp.start
				AND t.timestamp < sp.stop
		) AS turns
	FROM spans sp
	WHERE sp.change = 'added' AND sp.start < sp.stop
),
per AS (
	-- SQLite takes a bare column from the row max() picks: the size the
	-- tool was last held at.
	SELECT
		session_id,
		tool,
		sum(turns) AS turns,
		sum(turns * chars) AS charTurns,
		chars,
		max(start) AS latest
	FROM held
	GROUP BY session_id, tool
	HAVING sum(turns) > 0
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
unseen AS (
	-- Ran a script the ledger holds none of the calls of, judged script
	-- by script: one that called nothing reads so too, keeping the
	-- figure a floor.
	SELECT DISTINCT t.session_id
	FROM tool_calls t, bounds
	WHERE t.name = 'codemode'
		AND t.timestamp >= bounds.since
		AND t.timestamp < bounds.until
		AND NOT EXISTS (
			SELECT 1 FROM inner_calls i
			WHERE i.session_id = t.session_id AND i.outer_call_id = t.call_id
		)
),
judged AS (
	SELECT
		p.tool,
		p.chars,
		p.charTurns,
		coalesce(c.n, 0) AS n,
		u.session_id IS NOT NULL AS blind,
		s.readCost / nullif(s.readTokens, 0) AS price
	FROM per p
	JOIN steps s ON s.session_id = p.session_id
	LEFT JOIN calls c ON c.session_id = p.session_id AND c.name = p.tool
	LEFT JOIN unseen u ON u.session_id = p.session_id
)
SELECT
	'tool' AS kind,
	tool,
	count(*) AS sessions,
	group_concat(chars) AS sizes,
	sum(n > 0) AS calledIn,
	sum(n) AS calls,
	sum(n = 0 AND blind) AS scripted,
	coalesce(sum(CASE WHEN n = 0 AND NOT blind THEN charTurns * price END), 0)
		AS unusedCharCost
FROM judged
GROUP BY tool
UNION ALL
SELECT
	'sessions' AS kind,
	NULL AS tool,
	count(*) AS sessions,
	group_concat(held) AS sizes,
	(
		SELECT count(*) FROM steps
		WHERE session_id NOT IN (SELECT session_id FROM declarations)
	) AS calledIn,
	NULL,
	NULL,
	NULL
FROM (
	SELECT p.session_id, sum(p.charTurns) / s.turns AS held
	FROM per p
	JOIN steps s ON s.session_id = p.session_id
	GROUP BY p.session_id
)
