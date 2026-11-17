/**
 * Telling pi's stale-context error from any other.
 *
 * After a reload or a session switch, the `pi` and `ctx` an extension
 * captured throw on use, saying they are stale. A callback pi calls
 * later (a compaction ending, a timer) meets that with nobody above it
 * to catch, and an uncaught throw takes pi down. The runtime that
 * replaced it has its own state, so such a callback has nothing left
 * to do. Only that error is passed over: any other is a real fault.
 */

/** The words pi's stale-context error carries, in pi 1.3 and 1.4. */
const STALE = "is stale after session replacement or reload";

/** Whether `error` is pi saying a captured `pi` or `ctx` was replaced. */
export function isStaleContext(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE);
}

/**
 * A callback that does nothing once its runtime has been replaced,
 * rather than throwing where nothing catches. Any other error still
 * throws.
 */
export function whileCurrent<T extends unknown[]>(
	callback: (...args: T) => void,
): (...args: T) => void {
	return (...args) => {
		try {
			callback(...args);
		} catch (error) {
			if (!isStaleContext(error)) throw error;
		}
	};
}
