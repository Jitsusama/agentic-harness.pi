-- The void's turns between :since_ms and :until_ms, oldest first, with
-- what each cost. Times are epoch milliseconds. The quest is the void's,
-- VOID_QUEST in void-cost.ts, whose tests read it back.
WITH bounds AS (
	SELECT
		strftime('%Y-%m-%dT%H:%M:%fZ', :since_ms / 1000.0, 'unixepoch') AS since,
		strftime('%Y-%m-%dT%H:%M:%fZ', :until_ms / 1000.0, 'unixepoch') AS until
)
SELECT timestamp, cost_total AS cost
FROM turns, bounds
WHERE quest = 'QEST-20261112-8GYNJ6'
	AND timestamp >= bounds.since
	AND timestamp < bounds.until
ORDER BY timestamp
