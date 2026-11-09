-- How many dropped calls were of a retrieval tool: what a regret rate is
-- a share of. ?1 is the retrieval tools as a JSON array, or null for every
-- tool.
SELECT COUNT(*) AS in_scope
FROM dropped_calls
JOIN tool_calls AS dropped ON dropped.digest = dropped_calls.digest
WHERE ?1 IS NULL OR dropped.name IN (SELECT value FROM json_each(?1));
