-- The ledger's tables, made when missing.
--
-- digest is the primary key of turns rather than the session and entry
-- pair, which is what makes recording idempotent. sightings keeps the
-- fact that several logs held the same turn, so nothing is hidden by
-- deduplicating it: the turn is billed once and known to have been seen
-- more than once.
--
-- Columns added after a table's first shape are not here: migrate() in
-- store.ts adds them to a ledger made before them.
CREATE TABLE IF NOT EXISTS turns (
	digest TEXT PRIMARY KEY,
	entry_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	kind TEXT NOT NULL,
	model TEXT NOT NULL,
	tokens_input INTEGER NOT NULL,
	tokens_output INTEGER NOT NULL,
	tokens_cache_read INTEGER NOT NULL,
	tokens_cache_write INTEGER NOT NULL,
	tokens_total INTEGER NOT NULL,
	cache_write_1h INTEGER NOT NULL,
	cost_input REAL,
	cost_output REAL,
	cost_cache_read REAL,
	cost_cache_write REAL,
	cost_total REAL,
	dropped_before INTEGER,
	first_kept_entry_id TEXT
);
CREATE INDEX IF NOT EXISTS turns_timestamp ON turns (timestamp);
CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id);
CREATE INDEX IF NOT EXISTS turns_session_time ON turns (session_id, timestamp);
CREATE TABLE IF NOT EXISTS sightings (
	digest TEXT NOT NULL,
	session_id TEXT NOT NULL,
	PRIMARY KEY (digest, session_id)
);
CREATE TABLE IF NOT EXISTS tool_calls (
	digest TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	call_id TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	name TEXT NOT NULL,
	args_digest TEXT NOT NULL,
	path TEXT,
	result_chars INTEGER,
	result_digest TEXT,
	is_error INTEGER,
	verifier_kind TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_verifier ON tool_calls (verifier_kind);
CREATE INDEX IF NOT EXISTS tool_calls_args ON tool_calls (session_id, args_digest);
CREATE INDEX IF NOT EXISTS tool_calls_path ON tool_calls (path);
CREATE INDEX IF NOT EXISTS tool_calls_session_verifier
	ON tool_calls (session_id, timestamp) WHERE verifier_kind IS NOT NULL;
CREATE TABLE IF NOT EXISTS dropped_calls (
	digest TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	dropped_at_entry_id TEXT NOT NULL,
	dropped_at_timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	cwd TEXT,
	repo TEXT,
	quest TEXT,
	first_seen TEXT,
	last_seen TEXT
);
