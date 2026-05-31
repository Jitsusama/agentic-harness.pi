/** A FIFO async mutex: serialize critical sections within one process. */

/** A mutex that runs critical sections one at a time. */
export interface AsyncMutex {
	/**
	 * Run `fn` once the mutex is free, blocking later callers
	 * until it settles. Returns `fn`'s result; rejections
	 * propagate to the caller and still release the lock.
	 */
	runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/** Create an unlocked FIFO mutex. */
export function createMutex(): AsyncMutex {
	// The tail of the queue: every new section chains onto it,
	// so sections run in the order `runExclusive` was called.
	// We swallow the predecessor's rejection here (the original
	// caller already owns it) so one failure never stalls the
	// chain.
	let tail: Promise<unknown> = Promise.resolve();
	return {
		runExclusive<T>(fn: () => Promise<T>): Promise<T> {
			const result = tail.then(fn, fn);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	};
}
