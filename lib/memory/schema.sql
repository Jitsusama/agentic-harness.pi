-- The memory store's one table, made when missing.
CREATE TABLE IF NOT EXISTS facts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	scope TEXT NOT NULL,
	text TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	source TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	created_at INTEGER NOT NULL,
	recalled_count INTEGER NOT NULL DEFAULT 0,
	last_recalled_at INTEGER
);
CREATE INDEX IF NOT EXISTS facts_scope_status ON facts (scope, status);
