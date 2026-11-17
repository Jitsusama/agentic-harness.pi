/**
 * The folder in the login's runtime folder that quest locks are made
 * in, and the one test of it that the lock and the fence share: a
 * fenced writer and one outside take the same lock only while both
 * judge this folder the same way.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Where in a login's runtime folder each quest's lock is made. */
export const QUEST_LOCKS = join("agentic-harness.pi", "quest-locks");

/**
 * The session bus's socket, which only the machine's own runtime folder
 * holds: the fence never lets it through (`NEVER_THROUGH`).
 */
const SESSION_BUS = "bus";

/** The only mode the folder may have: its owner's alone. */
const OWNER_ONLY = 0o700;

/** Whether `run` is a login's own runtime folder, holding its session bus. */
export function holdsSessionBus(run: string): boolean {
	try {
		return lstatSync(join(run, SESSION_BUS)).isSocket();
	} catch {
		// No bus there: inside the fence, or no login's folder.
		return false;
	}
}

/**
 * How the lock folder at `folder` stands: `absent` where nothing is
 * there, `ours` where it is a folder, not a link, this user owns and
 * only this user may enter, and `refused` for anything else, which no
 * writer locks in: another's folder, a link, a file, or the empty
 * file the fence leaves where it wouldn't let a folder through.
 */
export function lockFolder(folder: string): "absent" | "ours" | "refused" {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(folder);
	} catch {
		// Nothing there to lock in, nor anything to refuse.
		return "absent";
	}
	const owner = process.getuid?.();
	const ours =
		stat.isDirectory() &&
		(owner === undefined || stat.uid === owner) &&
		(stat.mode & 0o777) === OWNER_ONLY;
	return ours ? "ours" : "refused";
}
