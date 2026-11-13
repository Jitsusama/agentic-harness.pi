/**
 * A reading of the install that every conversation of one load shares.
 *
 * A host runs each conversation through the same evaluation of an
 * extension, and an install check that read the disk and asked git for
 * each one spent the host's one loop on the same answer again: a soak
 * of twelve conversations spent 1.9 s parsing one pnpm record
 * (13 November).
 */

/** Options for {@link sharedReading}. */
export interface SharedReadingOptions {
	/** How old a reading may grow before it is taken again; never, by default. */
	readonly maxAgeMs?: number;
	/** The clock, in milliseconds. */
	readonly now?: () => number;
}

/**
 * Share `read`'s answer among its callers: taken again only when a
 * caller names a key other than the one it was taken for, or once it
 * is older than `maxAgeMs`. A caller naming no key takes whichever
 * reading stands. A promise is shared as it is, so callers that ask
 * while one is out wait on the same reading.
 */
export function sharedReading<K, T>(
	read: () => T,
	options: SharedReadingOptions = {},
): (key?: K) => T {
	const clock = options.now ?? Date.now;
	const maxAge = options.maxAgeMs ?? Number.POSITIVE_INFINITY;
	let last: { key: K | undefined; at: number; value: T } | undefined;
	return (key) => {
		const standing =
			last &&
			(key === undefined || last.key === key) &&
			clock() - last.at < maxAge;
		if (last && standing) return last.value;
		last = { key: key ?? last?.key, at: clock(), value: read() };
		return last.value;
	};
}
