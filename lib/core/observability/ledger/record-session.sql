-- Record a session, or widen what is known of one already held.
INSERT INTO sessions (
	session_id, cwd, repo, quest, first_seen, last_seen
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	cwd = excluded.cwd,
	repo = excluded.repo,
	quest = excluded.quest,
	first_seen = MIN(first_seen, excluded.first_seen),
	last_seen = MAX(last_seen, excluded.last_seen);
