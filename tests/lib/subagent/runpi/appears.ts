/**
 * Waiting for a real process to write a file, for tests that start one.
 *
 * Shared because the supervisor's process tests each wrote the same
 * wait, and a wait is where a suite on a loaded machine either keeps
 * going or fails for no reason.
 */

import { readFile } from "node:fs/promises";

/**
 * Room for a real process to be scheduled on a pool that may be
 * saturated, sometimes two levels deep.
 *
 * Nothing that uses it waits on work: the processes it covers sleep,
 * write a file or are meant to be stopped, so this is only room for the
 * operating system to get round to them.
 */
export const APPEARS_WITHIN_MS = 60_000;

/**
 * Wait for a path to hold parseable JSON that is `enough`, or give up
 * saying so.
 */
export async function appears<T>(
	path: string,
	enough: (value: T) => boolean = () => true,
): Promise<T> {
	const until = Date.now() + APPEARS_WITHIN_MS;
	while (Date.now() < until) {
		try {
			const value = JSON.parse(await readFile(path, "utf8")) as T;
			if (enough(value)) return value;
		} catch {
			// Not written, or half-written. Both mean "not yet".
		}
		// A poll's pause, for the process to write.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${path} never appeared within ${APPEARS_WITHIN_MS}ms`);
}
