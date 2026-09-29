/**
 * How long a browser call may ask the page to keep at something.
 *
 * A stopped call answers at once, but its session stays taken until
 * the browser finishes what it was asked, since a wait, a recording
 * or a keyboard walk cannot be stopped part-way from here. So these
 * bounds are what bound the wait of whichever call comes next, and
 * an ask beyond one is refused rather than quietly shortened: a
 * shorter wait than the caller named would read as a page that never
 * got there.
 */

/**
 * The longest a wait may be given, whether as its timeout or as a
 * plain duration. Two minutes covers a slow build, a cold start or a
 * deliberate animation; anything longer is better polled.
 */
export const MAX_WAIT_MS = 120_000;

/** The longest a CPU profile may record. */
export const MAX_PROFILE_MS = 60_000;

/**
 * The most Tab presses a keyboard walk may be given. Ten times the
 * default ceiling, which already covers a page's every control twice.
 */
export const MAX_WALK_STOPS = 4_000;

/**
 * A refusal for a number over its bound, or undefined when it is
 * within it or not given.
 */
export function beyondBound(
	what: string,
	asked: number | undefined,
	most: number,
	instead: string,
): string | undefined {
	if (asked === undefined || asked <= most) return undefined;
	return `${what} can be at most ${most}, and ${asked} was asked. ${instead}`;
}
