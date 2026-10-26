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
 */

/** How long a reading stands before it's read again, unasked. */
export const USAGE_MAX_AGE_MS = 15_000;

export interface UsageReader<T> {
	/** The reading, from the source only when the held one won't do. */
	get(): T;
	/** Says the context changed, so the next get reads it afresh. */
	stale(): void;
}

export function usageReader<T>(
	read: () => T,
	now: () => number = Date.now,
): UsageReader<T> {
	let held: { value: T; at: number } | null = null;
	return {
		get() {
			const at = now();
			if (held === null || at - held.at >= USAGE_MAX_AGE_MS) {
				held = { value: read(), at };
			}
			return held.value;
		},
		stale() {
			held = null;
		},
	};
}
