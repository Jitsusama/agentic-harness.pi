-- Record a subagent's run, or replace what an earlier write said of it.
INSERT INTO runs (
	run_id, subagent_id, kind, model, persona, verify_outcome,
	retries_to_valid, warning_count, exit_code,
	tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
	cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
	started_at, metered, session_id, cwd, repo, ended_at,
	thinking_level, subagent_session_ids
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (run_id, subagent_id) DO UPDATE SET
	kind = excluded.kind, model = excluded.model,
	persona = excluded.persona, verify_outcome = excluded.verify_outcome,
	retries_to_valid = excluded.retries_to_valid,
	warning_count = excluded.warning_count,
	exit_code = excluded.exit_code,
	tokens_input = excluded.tokens_input,
	tokens_output = excluded.tokens_output,
	tokens_cache_read = excluded.tokens_cache_read,
	tokens_cache_write = excluded.tokens_cache_write,
	tokens_total = excluded.tokens_total,
	cost_input = excluded.cost_input,
	cost_output = excluded.cost_output,
	cost_cache_read = excluded.cost_cache_read,
	cost_cache_write = excluded.cost_cache_write,
	cost_total = excluded.cost_total,
	started_at = excluded.started_at, metered = excluded.metered,
	session_id = excluded.session_id, cwd = excluded.cwd,
	repo = excluded.repo, ended_at = excluded.ended_at,
	thinking_level = excluded.thinking_level,
	subagent_session_ids = excluded.subagent_session_ids;
