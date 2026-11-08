-- A subagent of a run is one row. A store written before that rule may
-- hold duplicates, and the index can't be added over them. They are
-- captured before anything is removed, keeping the latest of each pair
-- where it was: nothing is deleted that is not first copied somewhere it
-- can be recovered from.
CREATE TABLE IF NOT EXISTS runs_superseded AS SELECT * FROM runs WHERE 0;
INSERT INTO runs_superseded SELECT * FROM runs WHERE rowid NOT IN (
	SELECT MAX(rowid) FROM runs GROUP BY run_id, subagent_id
);
DELETE FROM runs WHERE rowid NOT IN (
	SELECT MAX(rowid) FROM runs GROUP BY run_id, subagent_id
);
CREATE UNIQUE INDEX runs_identity ON runs (run_id, subagent_id);
