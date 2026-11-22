/**
 * The turns a capture drafts from: the whole session's, those a held
 * or rolled-over log left on disk included, since a correction early
 * in a long session is as worth capturing as a late one.
 */
import type { Turn } from "../../lib/core/governance/index.ts";
import { entriesToTurns } from "../../lib/internal/logs/transcript.ts";
import { ancestry } from "../../lib/internal/session/rollover.ts";

/** What of the session the turns are read from. */
export interface TurnSource {
	getBranch(): readonly unknown[];
	getEntries(): readonly unknown[];
}

/**
 * The session's user and assistant turns, oldest first. The parent
 * logs are read from disk on asking and never kept, as a capture is
 * asked for rarely.
 */
export function sessionTurns(session: TurnSource): Turn[] {
	return entriesToTurns([
		...ancestry(session.getBranch()),
		...session.getEntries(),
	]);
}
