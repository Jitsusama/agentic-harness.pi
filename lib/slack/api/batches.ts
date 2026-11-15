/**
 * Looking ids up a batch at a time, as the resolvers do for the users
 * and conversations a page of messages names.
 */

/**
 * How many lookups run at once. The info methods the resolvers call
 * are Tier 3 or 4 (50 to 100 a minute), so twenty at a time sits well
 * inside both.
 */
const BATCH_SIZE = 20;

/**
 * Look each id up, twenty at a time, checking `signal` before each
 * batch. Answers false when the signal stopped it before every batch
 * ran, so a caller can skip what it would have done with the answers.
 */
export async function inBatches(
	ids: Iterable<string>,
	lookUp: (id: string) => Promise<void>,
	signal?: AbortSignal,
): Promise<boolean> {
	const all = [...ids];
	for (let at = 0; at < all.length; at += BATCH_SIZE) {
		if (signal?.aborted) return false;
		await Promise.all(all.slice(at, at + BATCH_SIZE).map(lookUp));
	}
	return true;
}
