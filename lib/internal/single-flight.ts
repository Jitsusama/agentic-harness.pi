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
