/**
 * Waiting for a condition instead of sleeping for a duration.
 *
 * A fixed sleep is the worst of both worlds. It is as slow as its
 * longest expected case on every run, and it is still too short on a
 * loaded machine, so it is simultaneously the reason a suite is slow
 * and the reason it is flaky. Those look like two problems and are
 * one.
 *
 * Polling inverts both properties: it returns the moment the thing is
 * true, so a fast machine pays almost nothing, and it keeps waiting
 * when the machine is busy, so load stops producing failures.
 *
 * Use {@link until} to prove something happens. Proving something
 * does *not* happen is the one case that still needs a real wait,
 * since there is no event to observe; use {@link quietFor} for that,
 * and keep it proportional to the interval under test rather than
 * picking a comfortable-looking number.
 */

/** How often to re-check, in milliseconds. */
const POLL_MS = 5;

/**
 * Wait until `predicate` returns true, then return.
 *
 * Throws with `what` in the message if the timeout passes first, so a
 * failure says which condition never came true rather than only that
 * a promise timed out.
 */
export async function until(
	what: string,
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for ${what}. The condition never became true.`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/**
 * Wait a real interval, for proving that nothing happens.
 *
 * Only for asserting absence, where there is no event to poll for.
 * Pass the interval being tested and how many of them should go by,
 * so the wait is justified by the thing under test rather than by
 * how long feels safe.
 */
export async function quietFor(
	intervalMs: number,
	intervals = 5,
): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, intervalMs * intervals));
}
