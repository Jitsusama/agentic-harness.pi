/**
 * Whether the host's records folder lies where no fenced command or
 * other account could put a record of its own in its place, and the
 * tidying of folders earlier code left open to the group, so the host
 * names a session's fence only where a mycelium node may trust it.
 */
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	realpathSync,
	type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Where in the home folder the fence keeps pi's state read-only (fence-home.ts). */
export const CLOSED_STATE = ".local/state/pi";

/**
 * Why `folder` doesn't lie closed in `closed`, or undefined where it
 * does: spelled as it really is, through no link, and it and each
 * folder from `closed` down to it this account's own, which no other
 * may write. Another account could otherwise rename one away and put
 * its own, holding its own record, there.
 */
export function unclosedIn(folder: string, closed: string): string | undefined {
	const folders = downTo(folder, closed);
	if (folders === undefined) return `${folder} lies outside ${closed}`;
	for (const each of folders) {
		const why = notOwnAlone(each);
		if (why !== undefined) return `${each} ${why}`;
	}
	return undefined;
}

/**
 * Clear group and other write from each folder from `closed` down to
 * `folder` that is this account's own and no link, as code before this
 * host may have made them under a looser umask; unclosedIn then judges
 * them as they stand. The walk stops at the first that isn't at its
 * real path, so nothing past a link is changed; a link swapped in at
 * the last part after that look is refused by the open, though one
 * higher up may still be followed.
 */
export function closeToOthers(folder: string, closed: string): void {
	for (const each of downTo(folder, closed) ?? []) {
		let opened: number;
		try {
			if (realpathSync(each) !== each) return;
			opened = openSync(
				each,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
		} catch {
			// unclosedIn names no fence for a folder it can't read.
			return;
		}
		try {
			const held = fstatSync(opened);
			if (held.uid === process.getuid?.() && (held.mode & 0o022) !== 0)
				fchmodSync(opened, held.mode & 0o7755);
		} catch {
			// As above: left as it is, unclosedIn judges it.
		} finally {
			closeSync(opened);
		}
	}
}

/** `closed` and each folder below it down to `folder`; none outside it. */
function downTo(folder: string, closed: string): string[] | undefined {
	const at = relative(closed, folder);
	if (at === "" || at.startsWith("..") || isAbsolute(at)) return undefined;
	const steps = at.split(sep);
	return [
		closed,
		...steps.map((_, i) => join(closed, ...steps.slice(0, i + 1))),
	];
}

/** Why `folder` isn't this account's alone, at its real path, or undefined. */
function notOwnAlone(folder: string): string | undefined {
	let real: string;
	let held: Stats;
	try {
		real = realpathSync(folder);
		held = lstatSync(folder);
	} catch {
		return "can't be read";
	}
	if (held.isSymbolicLink()) return "is a link";
	if (real !== folder) return "lies past a link";
	if (!held.isDirectory()) return "is not a folder";
	if (held.uid !== process.getuid?.()) return "is another account's";
	if ((held.mode & 0o022) !== 0) return "may be written by another account";
	return undefined;
}
