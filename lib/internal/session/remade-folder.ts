/**
 * A window's folder removed and made again under the same path, as a
 * checkout does to its folders. A holder that has run for hours keeps
 * the folder it began in by inode, so once that folder is made again
 * the holder and everything it starts sit in a folder that no longer
 * exists, though one does at the same path. pi asks for its folder as
 * it starts and exits 1 at once when there is none ("The current
 * working directory no longer exists"), which is how a released
 * window's plain pi died within its first second on 19 November, under
 * a holder six hours old, while a new window in the same path was
 * ready within 25 s. The join itself never asks, so it runs there fine.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Whether an error is the one that says a path is gone. */
function isGone(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The folder a window's next program should start in afresh: the one
 * `env`'s PWD names, when the folder this process runs in is gone and a
 * folder stands at that path again. Otherwise nothing, and what comes
 * next starts where this process runs, as it always did.
 */
export function remadeFolder(
	env: NodeJS.ProcessEnv = process.env,
	here: () => string = () => process.cwd(),
): string | undefined {
	try {
		here();
		return undefined;
	} catch (error) {
		if (!isGone(error)) return undefined;
	}
	const folder = env.PWD;
	if (folder === undefined || !isAbsolute(folder)) return undefined;
	try {
		return statSync(folder).isDirectory() ? folder : undefined;
	} catch {
		// Gone at that path too, or unreadable: nothing to start in, so
		// what comes next starts where this process runs and says why.
		return undefined;
	}
}

/**
 * `words` as a holder runs them, started in `folder` by its path: the
 * shell enters it and becomes the program, so the process the holder
 * started, which its record names, is still the one that runs.
 */
export function startingIn(folder: string, words: readonly string[]): string[] {
	return [
		"sh",
		"-c",
		'cd -- "$1" || exit; shift; exec "$@"',
		"sh",
		folder,
		...words,
	];
}
