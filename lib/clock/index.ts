/**
 * What a duration bounding a child process may be.
 *
 * These rules belong to the runner: it is the thing that refuses a
 * timeout below a floor, above a ceiling, or paired with an idle clock
 * that outlives it. But the runner is the last place they can be
 * applied, and by then somebody's roster has been read, a change has
 * been fetched, a tree has been cut, and the refusal arrives as a
 * thrown error in the middle of a round instead of as an answer about
 * a config file.
 *
 * So the rules live in neither surface, the same way the thinking
 * levels do. One definition, two readers: the runner throws with it
 * and the roster refuses with it, and they cannot come to disagree
 * about what a usable clock is.
 */

/** The shortest duration worth calling a timeout. */
export const CLOCK_FLOOR_MS = 1000;

/** The longest one, past which a runaway is indistinguishable. */
export const CLOCK_CEILING_MS = 8 * 60 * 60 * 1000;

/**
 * Why this duration cannot be used, if it cannot.
 *
 * Names the value and the bound it missed, because the reader of this
 * has a number in a file and needs to know which way to move it. The
 * common mistake is writing seconds where milliseconds are meant,
 * which is why the floor exists at all: 45 is a perfectly plausible
 * thing to write and stops the child before it has started.
 */
export function whyUnusableClock(
	field: string,
	value: number | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value)
	) {
		return `${field} must be a whole number of milliseconds, and is ${String(value)}.`;
	}
	if (value < CLOCK_FLOOR_MS) {
		return `${field} is ${value}ms, which is below the ${CLOCK_FLOOR_MS}ms floor and would stop the run almost at once. Milliseconds, not seconds.`;
	}
	if (value > CLOCK_CEILING_MS) {
		return `${field} is ${value}ms, which is past the ${CLOCK_CEILING_MS}ms ceiling.`;
	}
	return undefined;
}

/**
 * Why this set of clocks cannot be used together, if it cannot.
 *
 * The pair rule is the one nobody trips over by writing a bad number:
 * an idle guard that outlives the wall means the wall fires first
 * however patient the guard is, which is a footgun for somebody who
 * moved one column of the sizing table.
 *
 * A zero reserve is the documented way to switch the soft deadline
 * off, so it is the one value under the floor that means something.
 */
export function whyUnusableClocks(clocks: {
	timeoutMs?: number;
	idleTimeoutMs?: number;
	wrapUpReserveMs?: number;
}): string | undefined {
	const each =
		whyUnusableClock("timeoutMs", clocks.timeoutMs) ??
		whyUnusableClock("idleTimeoutMs", clocks.idleTimeoutMs) ??
		(clocks.wrapUpReserveMs === 0
			? undefined
			: whyUnusableClock("wrapUpReserveMs", clocks.wrapUpReserveMs));
	if (each !== undefined) return each;
	const { timeoutMs, idleTimeoutMs } = clocks;
	if (
		timeoutMs !== undefined &&
		idleTimeoutMs !== undefined &&
		idleTimeoutMs > timeoutMs
	) {
		return `idleTimeoutMs (${idleTimeoutMs}ms) outlives timeoutMs (${timeoutMs}ms), so the wall clock fires first however patient the idle guard is.`;
	}
	return undefined;
}
