-- The run store's tables, made when missing. Columns added after a
-- table's first shape are not here: the migration in store.ts adds them.
CREATE TABLE IF NOT EXISTS runs (
	run_id TEXT NOT NULL,
	subagent_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	model TEXT NOT NULL,
	persona TEXT NOT NULL,
	verify_outcome TEXT NOT NULL,
	retries_to_valid INTEGER NOT NULL,
	warning_count INTEGER NOT NULL,
	exit_code INTEGER NOT NULL,
	tokens_input INTEGER NOT NULL,
	tokens_output INTEGER NOT NULL,
	tokens_cache_read INTEGER NOT NULL,
	tokens_cache_write INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cost_input REAL NOT NULL,
	cost_output REAL NOT NULL,
	cost_cache_read REAL NOT NULL,
	cost_cache_write REAL NOT NULL,
	cost_total REAL NOT NULL,
	started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_run_id ON runs (run_id);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
-- The rollups table is legacy and is never written to again. It holds
-- the only surviving record of 2,199 runs whose raw rows an earlier
-- retention pass deleted, so it is read and never dropped.
CREATE TABLE IF NOT EXISTS rollups (
	week_start INTEGER NOT NULL,
	model TEXT NOT NULL,
	persona TEXT NOT NULL,
	run_count INTEGER NOT NULL,
	total_retries INTEGER NOT NULL,
	total_warnings INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cost_total REAL NOT NULL,
	cache_read INTEGER NOT NULL,
	fresh_input INTEGER NOT NULL,
	PRIMARY KEY (week_start, model, persona)
);
