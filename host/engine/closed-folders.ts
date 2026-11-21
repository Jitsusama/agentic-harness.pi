/**
 * Whether the folder a host keeps its record in is closed to every other
 * account, from the folder the fence keeps read-only down to it, and
 * closing it where code before the host left it open. SessionHost names a
 * session's fence in that record only while it is (session-host.ts).
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

/**
 * Whether `folder` lies in `closed`, spelled as it really is, through no
 * link, and it and each folder from `closed` down to it are this
 * account's own, which no other may write: another account could
 * otherwise rename one away and put its own, holding its own record, there.
 */
export function closedIn(folder: string, closed: string): boolean {
	const folders = downTo(folder, closed);
	return folders !== undefined && folders.every(ownAlone);
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

/** Whether `folder` is a real folder of this account's, no other may write. */
function ownAlone(folder: string): boolean {
	let real: string;
	let held: Stats;
	try {
		real = realpathSync(folder);
		held = lstatSync(folder);
	} catch {
		return false;
	}
	return (
		real === folder &&
		held.isDirectory() &&
		held.uid === process.getuid?.() &&
		(held.mode & 0o022) === 0
	);
}

/**
 * Clear group and other write from each folder from `closed` down to
 * `folder` that is this account's own and no link, as code before this
 * host may have made them under a looser umask; closedIn then judges
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
			// closedIn names no fence for a folder it can't read.
			return;
		}
		try {
			const held = fstatSync(opened);
			if (held.uid === process.getuid?.() && (held.mode & 0o022) !== 0)
				fchmodSync(opened, held.mode & 0o7755);
		} catch {
			// As above: left as it is, closedIn judges it.
		} finally {
			closeSync(opened);
		}
	}
}
