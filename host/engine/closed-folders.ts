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
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Where in the home folder the fence keeps pi's state read-only (fence-home.ts). */
export const CLOSED_STATE = ".local/state/pi";

/**
 * `path` spelled through where the home folder really lies, as where
 * /home links to /var/home, so unclosedIn judges only the links below
 * it: those above lie outside the home, where no fenced command may
 * write, and unclosedIn judges who else may write the folders they
 * lead to. Each link on the home's way must be root's or this
 * account's, in a folder no other may rename it out of (linksHeld),
 * or another could point it at a tree a fenced command filled. A path
 * outside the home, a home that can't be read, or one through a link
 * another could swap, is left as it is, which unclosedIn refuses.
 */
export function throughHome(path: string, home = homedir()): string {
	const at = relative(home, path);
	if (at.startsWith("..") || isAbsolute(at)) return path;
	try {
		if (!linksHeld(home)) return path;
		return join(realpathSync(home), at);
	} catch {
		return path;
	}
}

/**
 * Whether each link on `path`'s way is root's or this account's and
 * lies in a folder no other may rename it out of, as notHeldAbove
 * judges. A link is followed to its real path, and the walk goes on
 * from there.
 */
function linksHeld(path: string): boolean {
	let at: string = sep;
	for (const part of path.split(sep).filter(Boolean)) {
		const next = join(at, part);
		const held = lstatSync(next);
		if (!held.isSymbolicLink()) {
			at = next;
			continue;
		}
		if (held.uid !== 0 && held.uid !== process.getuid?.()) return false;
		if (notHeldAbove(at) !== undefined) return false;
		at = realpathSync(next);
	}
	return true;
}

/**
 * Why `folder` doesn't lie closed in `closed`, or undefined where it
 * does: spelled as it really is, through no link, and it and each
 * folder from `closed` down to it this account's own, which no other
 * may write. Another account could otherwise rename one away and put
 * its own, holding its own record, there. Each folder above `closed`
 * must be root's or this account's, and written by no other unless it
 * is sticky, as /tmp is, where none may rename what isn't theirs.
 */
export function unclosedIn(folder: string, closed: string): string | undefined {
	const folders = downTo(folder, closed);
	if (folders === undefined) return `${folder} lies outside ${closed}`;
	for (const each of folders) {
		const why = notOwnAlone(each);
		if (why !== undefined) return `${each} ${why}`;
	}
	for (let above = dirname(closed); ; above = dirname(above)) {
		const why = notHeldAbove(above);
		if (why !== undefined) return `${above} ${why}`;
		if (dirname(above) === above) return undefined;
	}
}

/**
 * Clear group and other write from each folder from `closed` down to
 * `folder` that is this account's own and no link, and from those
 * between the home and `closed` where `closed` is pi's state in a home
 * (as `.local` and `.local/state`), as code before this host may have
 * made them under a looser umask; unclosedIn then judges them as they
 * stand. The home itself is left as the person keeps it. Each change is
 * said on stderr, from and to, so a program that wanted its folder open
 * to the group can be traced back here. The walk stops at the first
 * that isn't at its real path, so nothing past a link is changed; a link swapped in at
 * the last part after that look is refused by the open, though one
 * higher up may still be followed.
 */
export function closeToOthers(folder: string, closed: string): void {
	const inHome = closed.endsWith(`${sep}${CLOSED_STATE}`)
		? closed.slice(0, -(CLOSED_STATE.length + 1))
		: closed;
	const folders = downTo(folder, inHome)?.slice(inHome === closed ? 0 : 1);
	for (const each of folders ?? []) {
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
			if (held.uid === process.getuid?.() && (held.mode & 0o022) !== 0) {
				const was = held.mode & 0o7777;
				fchmodSync(opened, was & 0o7755);
				process.stderr.write(
					`pi-host: closed ${each} to others' writes, from ${was.toString(8)} to ${(was & 0o7755).toString(8)}, so a fence can be told\n`,
				);
			}
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

/** Why no other account is kept from renaming what `folder` holds, or undefined. */
function notHeldAbove(folder: string): string | undefined {
	let held: Stats;
	try {
		held = lstatSync(folder);
	} catch {
		return "can't be read";
	}
	if (!held.isDirectory()) return "is not a folder";
	if (held.uid !== 0 && held.uid !== process.getuid?.())
		return "is another account's";
	if ((held.mode & 0o022) !== 0 && (held.mode & 0o1000) === 0)
		return "may be written by another account";
	return undefined;
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
