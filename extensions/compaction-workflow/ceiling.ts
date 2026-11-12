/**
 * Which sessions hold their summary to a ceiling, while the ceiling is
 * on trial.
 *
 * A summary is asked for a tenth of what it replaces. That share was
 * measured on summaries with a median of about 6,600 tokens; at the
 * 200k contexts sessions now reach, it asks for 10k to 20k, and over
 * several folds one session's grew from 5k to 22k. A long summary is
 * paid for three times: written as output, written to the cache again
 * after the compaction, and read on every turn until the next one. So
 * half the sessions, chosen by the last digit of their id, hold it to
 * the size the share was measured at, and the other half are the
 * control. Whether the capped half fetches back more after a
 * compaction decides whether every session takes it.
 *
 * `PI_COMPACTION_SUMMARY_CEILING` sets it: `off` holds no session to
 * a ceiling, a number of tokens holds every session to that one, and
 * anything else, or nothing, runs the trial.
 */

/** The ceiling on trial: the size the tenth share was measured at. */
export const SUMMARY_CEILING_TOKENS = 6_000;

const HEX = 16;

/** The ceiling a session's summary is held to, or none. */
export function summaryCeiling(
	sessionId: string,
	setting: string | undefined,
): number | undefined {
	if (setting === "off") return undefined;
	const named = Number(setting);
	if (setting !== undefined && Number.isInteger(named) && named > 0) {
		return named;
	}
	return inTrial(sessionId) ? SUMMARY_CEILING_TOKENS : undefined;
}

/** Whether a session falls in the capped half: its id ends in an odd hex digit. */
function inTrial(sessionId: string): boolean {
	const digit = Number.parseInt(sessionId.slice(-1), HEX);
	return Number.isInteger(digit) && digit % 2 === 1;
}
