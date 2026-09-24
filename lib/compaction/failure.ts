/**
 * What to do after a compaction fails.
 *
 * pi's `compact()` aborts the run in progress before it summarises, so
 * a trigger that fires again on the very next turn after a failure
 * aborts that turn too. A failure that repeats (a summary cut off at
 * the token cap does, every time) then stops the user's work on every
 * turn and pays the summariser to read the whole context at full input
 * price each time. That is what happened in September 2026: sessions
 * near 315k tokens failed at the 13,107-token summary cap four times in
 * fifteen minutes, each one an interrupted run the user had to restart.
 *
 * So a failure waits a number of turns that doubles with each failure
 * in a row, up to a ceiling, and is written to the session log: pi
 * itself only shows a failed compaction as a passing notice, which is
 * why no search of the logs could find one.
 */

/** Custom entry type a failed compaction is recorded under. */
export const FAILURE_ENTRY = "compaction-failed";

/** Turns to wait after the first failure in a row. */
const FIRST_RETRY_TURNS = 8;

/**
 * Longest wait, so a session that keeps growing is still offered a
 * compaction now and then rather than never again.
 */
const MAX_RETRY_TURNS = 128;

/** pi's message for a compaction the user or an extension cancelled. */
const CANCELLED_MESSAGE = "Compaction cancelled";

/** A failed compaction as the session log records it. */
export interface CompactionFailure {
	/** Context size the compaction was asked at. */
	tokens: number;
	/** pi's error message. */
	error: string;
	/** Failures in a row, this one included. */
	consecutiveFailures: number;
	/** Turns the trigger now waits before it may fire again. */
	retryAfterTurns: number;
}

/**
 * Turns to wait before offering another compaction after this many
 * failures in a row: none after none, then eight, doubling to 128.
 */
export function turnsBeforeRetry(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0;
	return Math.min(
		MAX_RETRY_TURNS,
		FIRST_RETRY_TURNS * 2 ** (consecutiveFailures - 1),
	);
}

/**
 * Whether the compaction was cancelled rather than failed: the user
 * pressed escape, or an extension declined it. A cancelled run was
 * stopped on purpose and is not resumed.
 */
export function wasCancelled(error: Error): boolean {
	return error.message === CANCELLED_MESSAGE;
}

/** The session log record of a failed compaction. */
export function failureRecord(
	tokens: number,
	error: Error,
	consecutiveFailures: number,
): CompactionFailure {
	return {
		tokens,
		error: error.message,
		consecutiveFailures,
		retryAfterTurns: turnsBeforeRetry(consecutiveFailures),
	};
}
