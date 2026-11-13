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
