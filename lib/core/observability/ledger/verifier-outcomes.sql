-- Pass, fail and unknown counts for each kind of verifier that ran.
SELECT verifier_kind,
	SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) AS passed,
	SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS failed,
	SUM(CASE WHEN is_error IS NULL THEN 1 ELSE 0 END) AS unknown
FROM tool_calls
WHERE verifier_kind IS NOT NULL
GROUP BY verifier_kind;
