-- Each dropped call at its first re-ask after the drop, leaving out a
-- re-ask after a writer touched the dropped call's file, and every one
-- after that. SQLite takes a bare column alongside MIN from the row MIN
-- chose, which is what makes result_chars the first re-ask's own size.
--
-- ?1 is the retrieval tools as a JSON array, or null for every tool. ?2 is
-- the writer tools as a JSON array, empty when none are named. A list is
-- bound as JSON so the statement is the same whatever it holds.
SELECT dropped_calls.session_id AS session_id,
	dropped.name AS name,
	dropped.args_digest AS args_digest,
	dropped_calls.dropped_at_timestamp AS dropped_at_timestamp,
	MIN(re_ask.timestamp) AS re_asked_at_timestamp,
	re_ask.result_chars AS result_chars
FROM dropped_calls
JOIN tool_calls AS dropped
	ON dropped.digest = dropped_calls.digest
JOIN tool_calls AS re_ask
	ON re_ask.session_id = dropped_calls.session_id
	AND re_ask.args_digest = dropped.args_digest
	AND re_ask.timestamp > dropped_calls.dropped_at_timestamp
WHERE (?1 IS NULL OR dropped.name IN (SELECT value FROM json_each(?1)))
	AND NOT (
		dropped.path IS NOT NULL AND EXISTS (
			SELECT 1 FROM tool_calls AS written
			WHERE written.session_id = dropped.session_id
				AND written.path = dropped.path
				AND written.name IN (SELECT value FROM json_each(?2))
				AND written.timestamp > dropped.timestamp
				AND written.timestamp < re_ask.timestamp
		)
	)
GROUP BY dropped_calls.digest
ORDER BY re_asked_at_timestamp ASC;
