/**
 * Whether this session is the first on the machine to take a walk in
 * the current window.
 *
 * Some walks at session start are about the machine rather than the
 * session: the look for subagents whose supervisor died reads every
 * run ever kept, 480 of them on 3 November, and took a second and a
 * half of CPU at every start and every reload. Sessions start and
 * reload together (a restart reopens every one, an install reloads
 * every one), so the same walk ran dozens of times over the same
 * files in the same minute, each finding what the first had found.
 *
 * The claim is a file named for the window, created only if it is not
 * there yet, which the filesystem decides for every process at once:
 * exactly one of the sessions asking in a window is told to go ahead.
 */

import { open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isAlreadyThere } from "./errno.ts";

/**
 * Claim `name`'s walk for the window holding `now`, in `dir`.
 *
 * True for the first session to ask in the window, false for every
 * other one. True as well when the claim cannot be written for any
 * reason but another session's claim, since then the walk is what
 * every start did before there was a window: a session that skips it
 * on a fault nobody hears about would leave an orphan running.
 */
export async function firstInWindow(
	dir: string,
	name: string,
	windowMs: number,
	now: number = Date.now(),
): Promise<boolean> {
	const prefix = `.${name}-walked-`;
	const claim = `${prefix}${Math.floor(now / windowMs)}`;
	try {
		await (await open(join(dir, claim), "wx")).close();
	} catch (error) {
		return !isAlreadyThere(error);
	}
	await forgetEarlierWindows(dir, prefix, claim);
	return true;
}

/** Remove the claims of windows before this one, which nothing reads. */
async function forgetEarlierWindows(
	dir: string,
	prefix: string,
	kept: string,
): Promise<void> {
	const entries = await readdir(dir).catch(() => []);
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || entry === kept) continue;
		// Another session forgetting the same one first is the same outcome.
		await rm(join(dir, entry), { force: true }).catch(() => undefined);
	}
}
