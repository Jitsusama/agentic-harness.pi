/**
 * The folder in the login's runtime folder that quest locks are made
 * in, and the one test of it that the lock and the fence share: a
 * fenced writer and one outside take the same lock only while both
 * judge this folder the same way.
 */

import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
} from "node:fs";
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

/** How the lock folder stands: what a writer locks in, or refuses. */
export type LockFolderStands = "absent" | "ours" | "refused";

/**
 * The quest lock folder in the runtime folder `run`, and how it stands,
 * as every writer and the fence judge it. Where `run` holds the session
 * bus the folder is made if it isn't there, and a mode another process
 * of this user's widened is put back, so one chmod from inside the fence
 * can't stop every writer. Where the bus is there but no folder could be
 * made, it is refused: a writer then locking in `.writing` would lock
 * where the fence's writers never look.
 */
export function questLockFolder(run: string): {
	readonly folder: string;
	readonly stands: LockFolderStands;
} {
	const folder = join(run, QUEST_LOCKS);
	const bus = holdsSessionBus(run);
	if (bus) {
		try {
			mkdirSync(folder, { recursive: true, mode: OWNER_ONLY });
		} catch {
			// Something else stands there: judged, and refused, below.
		}
	}
	mendMode(folder);
	const stands = lockFolder(folder);
	return { folder, stands: bus && stands === "absent" ? "refused" : stands };
}

/**
 * Put the folder's mode back to its owner's alone where it is a real
 * folder of this user's, opened without following a link so nothing
 * swapped in after a look is changed instead. Anything else is left for
 * `lockFolder` to refuse.
 */
function mendMode(folder: string): void {
	let fd: number;
	try {
		fd = openSync(
			folder,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
	} catch {
		// Absent, a link or not a folder: lockFolder judges it.
		return;
	}
	try {
		const stat = fstatSync(fd);
		const owner = process.getuid?.();
		const mine = owner === undefined || stat.uid === owner;
		if (mine && (stat.mode & 0o777) !== OWNER_ONLY) fchmodSync(fd, OWNER_ONLY);
	} catch {
		// Left as it is, and refused by lockFolder, which says so.
	} finally {
		closeSync(fd);
	}
}

/**
 * How the lock folder at `folder` stands: `absent` where nothing is
 * there, `ours` where it is a folder, not a link, this user owns and
 * only this user may enter, and `refused` for anything else, which no
 * writer locks in: another's folder, a link, a file, or the empty
 * file the fence leaves where it wouldn't let a folder through.
 */
export function lockFolder(folder: string): LockFolderStands {
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
