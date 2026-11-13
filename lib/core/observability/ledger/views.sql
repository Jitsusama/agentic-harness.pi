-- The views a query is written against, dropped and made again on every
-- open, so a ledger always answers with this version's definitions
-- rather than whichever version first created it. Each is defined here
-- once, so a named report and an ad hoc query cannot disagree.
--
-- A name written as a bind parameter is a constant from store.ts,
-- written in as a number when the file is read, since a view can't
-- take bound parameters. A turn's quest is its own where the scan said and its
-- session's where it did not, the same rule questOf() writes in
-- store.ts.
DROP VIEW IF EXISTS compaction_moments;
DROP VIEW IF EXISTS runs;
DROP VIEW IF EXISTS cycles;
DROP VIEW IF EXISTS misses;
DROP VIEW IF EXISTS turn_facts;

CREATE VIEW turn_facts AS
SELECT t.digest, t.entry_id, t.session_id, t.timestamp,
	date(t.timestamp, 'localtime') AS day,
	t.kind, t.model, t.thinking_level,
	t.tokens_input + t.tokens_cache_read + t.tokens_cache_write AS context,
	t.tokens_input, t.tokens_output, t.tokens_cache_read,
	t.tokens_cache_write, t.cache_write_1h,
	t.cost_total AS cost, t.cost_input, t.cost_output,
	t.cost_cache_read, t.cost_cache_write,
	t.preceded_by, t.reloaded, t.gap_ms, t.new_tokens, t.stop_reason,
	t.thinking_chars, t.text_chars, t.run_id, t.run_turn,
	t.served_backend, t.served_account, t.served_edge, t.account_changed,
	t.dropped_before, t.first_kept_entry_id,
	s.repo, CASE WHEN t.quest IS NULL THEN s.quest ELSE NULLIF(t.quest, '') END AS quest, s.cwd,
	NULLIF(t.document, '') AS document
FROM turns AS t
LEFT JOIN sessions AS s ON s.session_id = t.session_id;

CREATE VIEW misses AS
SELECT f.*,
	f.tokens_cache_write - f.new_tokens - :miss_slack_tokens AS excess_tokens,
	(f.tokens_cache_write - f.new_tokens - :miss_slack_tokens)
		* f.cost_cache_write / f.tokens_cache_write AS excess_cost,
	CASE
		WHEN f.preceded_by = 'compaction' THEN 'after compaction'
		WHEN f.preceded_by = 'model' THEN 'model change'
		WHEN f.account_changed = 1 THEN 'served by another account'
		-- Each provider's backend keeps a cache of its own, and a failover
		-- to one names no account, so the backend is told apart here.
		WHEN f.served_backend <> (
			SELECT p.served_backend FROM turns AS p
			WHERE p.session_id = f.session_id AND p.kind = 'assistant'
				AND p.timestamp < f.timestamp
			ORDER BY p.timestamp DESC LIMIT 1
		) THEN 'served by another backend'
		WHEN f.gap_ms > :hour_ms THEN 'idle over an hour'
		WHEN f.gap_ms > :five_minutes_ms AND f.cache_write_1h = 0
			THEN 'idle over five minutes'
		WHEN f.preceded_by IN ('tools', 'system') AND f.reloaded = 1
			THEN 'prompt changed by a reload'
		WHEN f.preceded_by IN ('tools', 'system') THEN 'prompt changed'
		WHEN f.preceded_by = 'reload' THEN 'after reload'
		WHEN f.preceded_by = 'typed' THEN 'after a typed message'
		WHEN f.tokens_cache_read < :full_miss_read_tokens
			THEN 'full miss, unexplained'
		ELSE 'partial miss, unexplained'
	END AS cause
FROM turn_facts AS f
WHERE f.kind = 'assistant'
	AND f.gap_ms IS NOT NULL
	AND f.new_tokens IS NOT NULL
	AND f.tokens_cache_write > 0
	AND f.tokens_cache_write - f.new_tokens - :miss_slack_tokens
		> :miss_threshold_tokens;

CREATE VIEW cycles AS
WITH numbered AS (
	SELECT f.*,
		SUM(CASE WHEN f.kind = 'compaction' THEN 1 ELSE 0 END) OVER (
			PARTITION BY f.session_id ORDER BY f.timestamp, f.digest
			ROWS UNBOUNDED PRECEDING
		) AS cycle
	FROM turn_facts AS f
),
worked AS (
	SELECT n.*,
		ROW_NUMBER() OVER (
			PARTITION BY n.session_id, n.cycle ORDER BY n.timestamp, n.digest
		) AS first_rank,
		ROW_NUMBER() OVER (
			PARTITION BY n.session_id, n.cycle
			ORDER BY n.timestamp DESC, n.digest DESC
		) AS last_rank
	FROM numbered AS n
	WHERE n.cycle > 0 AND n.kind = 'assistant' AND n.context > 0
),
opened AS (
	SELECT session_id, cycle, digest AS compaction_digest,
		timestamp AS compacted_at, repo, quest
	FROM numbered WHERE kind = 'compaction'
),
last_cycle AS (
	SELECT session_id, MAX(cycle) AS cycles FROM numbered GROUP BY session_id
),
sided AS (
	SELECT session_id, cycle, SUM(cost) AS side_cost
	FROM numbered WHERE cycle > 0 AND kind = 'side'
	GROUP BY session_id, cycle
)
SELECT o.session_id, o.cycle, o.compaction_digest, o.compacted_at,
	MAX(w.timestamp) AS ended_at,
	COUNT(w.digest) AS turns,
	COALESCE(SUM(w.cost), 0) AS cost,
	COALESCE(MAX(sd.side_cost), 0) AS side_cost,
	MAX(CASE WHEN w.first_rank = 1 THEN w.context END) AS context_start,
	MAX(CASE WHEN w.last_rank = 1 THEN w.context END) AS context_end,
	o.cycle < l.cycles AS closed,
	o.repo, o.quest
FROM opened AS o
JOIN last_cycle AS l ON l.session_id = o.session_id
LEFT JOIN worked AS w ON w.session_id = o.session_id AND w.cycle = o.cycle
LEFT JOIN sided AS sd ON sd.session_id = o.session_id AND sd.cycle = o.cycle
GROUP BY o.session_id, o.cycle;

CREATE VIEW runs AS
SELECT run_id, MIN(session_id) AS session_id,
	MIN(timestamp) AS started_at, MAX(timestamp) AS ended_at,
	SUM(CASE WHEN kind = 'assistant' THEN 1 ELSE 0 END) AS turns,
	SUM(CASE WHEN kind = 'compaction' THEN 1 ELSE 0 END) AS compactions,
	COALESCE(SUM(cost), 0) AS cost,
	MAX(repo) AS repo, MAX(quest) AS quest
FROM turn_facts
WHERE run_id IS NOT NULL
GROUP BY run_id;

CREATE VIEW compaction_moments AS
WITH next_turn AS (
	SELECT c.digest, MIN(n.timestamp) AS next_at
	FROM turns AS c
	JOIN turns AS n
		ON n.session_id = c.session_id
		AND n.kind = 'assistant'
		AND n.timestamp > c.timestamp
	WHERE c.kind = 'compaction'
	GROUP BY c.digest
)
SELECT f.digest, f.session_id, f.timestamp, f.day, f.model,
	f.cost, f.dropped_before, f.gap_ms, f.run_id,
	f.run_turn AS turns_into_run,
	t.written, t.summariser, t.summary_ms, t.waited_ms, t.summary_chars,
	t.aborted_request, t.resumed, t.since_typed_ms,
	nx.next_at,
	CAST(ROUND((julianday(nx.next_at) - julianday(f.timestamp)) * 86400000)
		AS INTEGER) AS resume_ms,
	f.repo, f.quest
FROM turn_facts AS f
JOIN turns AS t ON t.digest = f.digest
LEFT JOIN next_turn AS nx ON nx.digest = f.digest
WHERE f.kind = 'compaction';
