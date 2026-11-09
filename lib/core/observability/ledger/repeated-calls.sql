-- Arguments asked more than once inside one session, each asking against
-- the one before it, counting only those no writer touched the file of
-- in between, and saying which had a verifier run since.
--
-- ?1 is the retrieval tools as a JSON array, or null for every tool. ?2 is
-- the writer tools as a JSON array, empty when none are named. A list is
-- bound as JSON so the statement is the same whatever it holds.
WITH ordered AS (
	SELECT c.session_id, c.args_digest, c.name, c.path,
		c.timestamp, c.result_chars, c.verifier_kind,
		LAG(c.timestamp) OVER (
			PARTITION BY c.session_id, c.args_digest
			ORDER BY c.timestamp, c.digest
		) AS previous_at
	FROM tool_calls AS c
	WHERE ?1 IS NULL OR c.name IN (SELECT value FROM json_each(?1))
),
repeats AS (
	SELECT o.session_id, o.args_digest, o.name, o.result_chars,
		(o.verifier_kind IS NOT NULL OR EXISTS (
			SELECT 1 FROM tool_calls AS v
			WHERE v.session_id = o.session_id
				AND v.verifier_kind IS NOT NULL
				AND v.timestamp > o.previous_at
				AND v.timestamp < o.timestamp
		)) AS is_appraisal
	FROM ordered AS o
	WHERE o.previous_at IS NOT NULL AND NOT (
		o.path IS NOT NULL AND EXISTS (
			SELECT 1 FROM tool_calls AS written
			WHERE written.session_id = o.session_id
				AND written.path = o.path
				AND written.name IN (SELECT value FROM json_each(?2))
				AND written.timestamp > o.previous_at
				AND written.timestamp < o.timestamp
		)
	)
)
SELECT args_digest, name, COUNT(*) AS repeated,
	SUM(COALESCE(result_chars, 0)) AS repeated_chars,
	SUM(is_appraisal) AS appraisal,
	SUM(CASE WHEN is_appraisal THEN COALESCE(result_chars, 0) ELSE 0 END)
		AS appraisal_chars
FROM repeats
GROUP BY session_id, args_digest
ORDER BY repeated_chars DESC;
