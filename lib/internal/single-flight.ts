/**
 * One flight per key: callers who ask while one is in the air join it
 * rather than starting their own.
 *
 * Tool calls run in parallel, so two of them finding no client both
 * began a login, which put two panels and two callback servers up for
 * one account. Only what is still in flight is shared. Once a flight
 * lands, success or failure, the next caller starts a new one, so a
 * cancelled login is never the answer to every call after it, and
 * remembering a good answer stays the caller's cache.
 */
export function singleFlight<K, V>(): (
	key: K,
	start: () => Promise<V>,
) => Promise<V> {
	const inFlight = new Map<K, Promise<V>>();
	return (key, start) => {
		const joined = inFlight.get(key);
		if (joined) return joined;
		const flight = start().finally(() => {
			inFlight.delete(key);
		});
		inFlight.set(key, flight);
		return flight;
	};
}

/**
 * `work`, never run beside itself: a call while it runs is answered by
 * one more run once it ends, however many calls came meanwhile, so each
 * call is answered by a run that started after it. A run that fails
 * still lets the one after it run.
 *
 * A flight joined suits a clock, whose next tick looks again anyway;
 * this suits a watcher, whose ask passed over could leave a file that
 * arrived during the run unread until the clock came round.
 */
export function coalescing(work: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | undefined;
	let again: Promise<void> | undefined;
	const start = (): Promise<void> => {
		const run = (async () => work())();
		running = run;
		const landed = (): void => {
			if (running === run) running = undefined;
		};
		void run.then(landed, landed);
		return run;
	};
	return () => {
		if (running === undefined) return start();
		again ??= running.then(ended, ended).then(() => {
			again = undefined;
			return start();
		});
		return again;
	};
}

/** Nothing, for a run whose end is all that's waited on. */
function ended(): void {
	// How the run ended is its own caller's to hear.
}

/**
 * A module loaded on first use, once: callers who ask while it loads
 * join that load, and the module is kept once it lands. A failed load
 * is forgotten, so the next caller tries again.
 *
 * pi loads extensions through jiti, which hands a second import of a
 * module still being evaluated the half-made module. A call made then
 * finds that module's own imports undefined: on 13 November two of
 * three review_offer calls made at once failed reading `refuseFailure`.
 * Every lazy `import()` in an extension goes through one of these, as
 * `tests/package/lazy-imports-load-once.test.ts` holds.
 */
export function loadOnce<M>(load: () => Promise<M>): () => Promise<M> {
	let loading: Promise<M> | undefined;
	return () => {
		loading ??= load().catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
		return loading;
	};
}
