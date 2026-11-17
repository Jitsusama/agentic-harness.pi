/** A FIFO async mutex: serialize critical sections within one process. */

/** How a caller may bound its wait for the mutex. */
export interface ExclusiveOptions {
	/**
	 * Stops the wait. A section stopped while it queues rejects at
	 * once with an `AbortError` and never runs; one that has already
	 * started is the section's own business, since only it knows how
	 * to stop part-way.
	 */
	signal?: AbortSignal;
}

/** A mutex that runs critical sections one at a time. */
export interface AsyncMutex {
	/**
	 * Run `fn` once the mutex is free, blocking later callers
	 * until it settles. Returns `fn`'s result; rejections
	 * propagate to the caller and still release the lock.
	 */
	runExclusive<T>(fn: () => Promise<T>, options?: ExclusiveOptions): Promise<T>;
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
		runExclusive<T>(
			fn: () => Promise<T>,
			options: ExclusiveOptions = {},
		): Promise<T> {
			const { signal } = options;
			const place = { started: false };
			// A stopped waiter keeps its place in the chain, so the order
			// of everybody behind it holds, but skips its section when its
			// turn comes rather than running work nobody is waiting for.
			const turn = (): Promise<T> => {
				if (signal?.aborted) return Promise.reject(stopped(signal));
				place.started = true;
				return fn();
			};
			const result = tail.then(turn, turn);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			if (!signal) return result;
			return leaveWhileQueued(result, signal, place);
		},
	};
}

/**
 * The section's outcome, or a rejection the moment the signal stops
 * while the section is still queued. Once it has started, its caller
 * waits for it: leaving then would report a failure for work that
 * goes on changing things afterwards.
 */
function leaveWhileQueued<T>(
	result: Promise<T>,
	signal: AbortSignal,
	place: { started: boolean },
): Promise<T> {
	if (signal.aborted) {
		// The chain still owns `result`; this caller has left it.
		result.catch(() => undefined);
		return Promise.reject(stopped(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			if (place.started) return;
			result.catch(() => undefined);
			reject(stopped(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		result.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function stopped(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new Error("Stopped while waiting its turn.");
	error.name = "AbortError";
	return error;
}
