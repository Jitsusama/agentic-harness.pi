/**
 * Waiting on work no longer than a caller can afford: what it settles
 * to in time, or nothing once the time has passed.
 */

/**
 * What `work` settles to within `ms`, or nothing once that has passed.
 * The limit is kept by a timer of its own, so work that ignores the
 * signal it was handed still can't hold its caller longer. Work that
 * fails in time fails here too.
 */
export async function settledWithin<T>(
	work: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(resolve, ms, undefined);
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}
