/**
 * The context's usage, read once per change rather than once per frame.
 *
 * pi answers getContextUsage() by rebuilding the session's projection from
 * its whole history, which costs more the longer a session runs. The line
 * is drawn with every frame of pi's working animation, about 24 a second,
 * so reading it in render kept a long session's pi at half a core while it
 * only waited on a tool. The figure only moves when the context does, so
 * it's held until an event says the context changed, and for no longer
 * than fifteen seconds in case one happens that no event names. It was
 * a second, and on 26 October a profile of a working session found that
 * second's rebuilds the costliest thing the harness did in a frame.
 *
 * While the agent works, every tool result changes the context, and on
 * 11 November a profile found the line rebuilding about once a second,
 * 1.6 s of a working session's thirty. So a change is read at most once
 * every few seconds; one put off asks for a frame when it falls due, so
 * the last figure shows even once the animation stops.
 */

/** How long a reading stands before it's read again, unasked. */
export const USAGE_MAX_AGE_MS = 15_000;

/** How long after one reading a change may be read again. */
export const USAGE_MIN_GAP_MS = 5_000;

export interface UsageReader<T> {
	/** The reading, from the source only when the held one won't do. */
	get(): T;
	/** Says the context changed, so a get reads it afresh once the gap allows. */
	stale(): void;
}

/**
 * A reader of `read`, kept between changes and read at most once a gap;
 * `wake` is told how long until a change it put off falls due.
 */
export function usageReader<T>(
	read: () => T,
	now: () => number = Date.now,
	wake: (afterMs: number) => void = () => undefined,
): UsageReader<T> {
	let held: { value: T; at: number } | null = null;
	let changed = false;
	let woken = false;
	return {
		get() {
			const at = now();
			if (held === null) {
				held = { value: read(), at };
				return held.value;
			}
			const age = at - held.at;
			if (age >= USAGE_MAX_AGE_MS || (changed && age >= USAGE_MIN_GAP_MS)) {
				held = { value: read(), at };
				changed = false;
				woken = false;
			} else if (changed && !woken) {
				woken = true;
				wake(USAGE_MIN_GAP_MS - age);
			}
			return held.value;
		},
		stale() {
			changed = true;
		},
	};
}
