/**
 * Programs that run outside a sandbox, found only where the system's
 * administrator alone can put them.
 *
 * The sandbox's own programs (bwrap, landrun), the ones it lets run
 * outside it (nix-offload, env) and pi-spawner, which starts every
 * command, decide what a fenced command can reach. Found on `PATH`, any
 * of them could be one a fenced command planted: `PATH` holds folders
 * the fence leaves writable, such as a project's `.direnv/bin`, and the
 * next pi started there would run the planted one unfenced. Asking that
 * it lie in the Nix store doesn't help either, since an untrusted Nix
 * client can add a path there.
 *
 * So a program is taken only from the system's own profile folders, and
 * only when every step of the way to it, links followed, is owned by
 * root and writable by nobody else. The store's own folder is the one
 * step that is group-writable: anyone may add a path to it, but nobody
 * may change one that is there, and a path is reached only through
 * root's links.
 */

import {
	accessSync,
	constants,
	lstatSync,
	readlinkSync,
	type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { posix } from "node:path";

/** The store's folder, whose paths can't change once added. */
const STORE = "/nix/store";

/** The most links a lookup follows, as the kernel's own limit. */
const MOST_LINKS = 40;

/** Writable by the group or by everyone. */
const OTHERS_WRITE = 0o022;

/** Writable by everyone. */
const WORLD_WRITE = 0o002;

/** Mode bits saying a folder is sticky: its entries are their owners' alone. */
const STICKY = 0o1000;

/** What a lookup reads of the file system; each defaults to the real one. */
export interface Look {
	lstat(path: string): Pick<Stats, "uid" | "mode" | "isSymbolicLink">;
	readlink(path: string): string;
	runnable(path: string): boolean;
}

const real: Look = {
	lstat: (path) => lstatSync(path),
	readlink: (path) => readlinkSync(path),
	runnable(path) {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			// Not runnable by this user, or not there.
			return false;
		}
	},
};

/** The folders the system's profiles put this user's programs in. */
export function systemFolders(user: string = userInfo().username): string[] {
	return [`/etc/profiles/per-user/${user}/bin`, "/run/current-system/sw/bin"];
}

/**
 * Where `program` really is, links followed, when one of `folders`
 * holds it and nothing on the way to it is anyone's but root's;
 * otherwise nothing.
 */
export function systemProgram(
	program: string,
	folders: readonly string[] = systemFolders(),
	look: Look = real,
): string | undefined {
	if (program.includes("/")) return undefined;
	for (const folder of folders) {
		const found = sealedPath(posix.join(folder, program), look);
		if (found !== undefined && look.runnable(found)) return found;
	}
	return undefined;
}

/**
 * `path` resolved, when every step of it, and of every link it follows,
 * is owned by root and writable by nobody else.
 */
export function sealedPath(
	path: string,
	look: Look = real,
): string | undefined {
	if (!posix.isAbsolute(path) || !sealed("/", look)) return undefined;
	let at = "/";
	let rest = path.split("/").filter(Boolean);
	let links = 0;
	while (rest.length > 0) {
		const [part, ...after] = rest;
		rest = after;
		if (part === undefined || part === ".") continue;
		if (part === "..") {
			at = posix.dirname(at);
			continue;
		}
		const next = posix.join(at, part);
		const stats = statsOf(next, look);
		if (stats === undefined || !sealed(next, look, stats)) return undefined;
		if (!stats.isSymbolicLink()) {
			at = next;
			continue;
		}
		links += 1;
		if (links > MOST_LINKS) return undefined;
		const target = look.readlink(next);
		if (posix.isAbsolute(target)) at = "/";
		rest = [...target.split("/").filter(Boolean), ...rest];
	}
	return at;
}

function statsOf(
	path: string,
	look: Look,
): ReturnType<Look["lstat"]> | undefined {
	try {
		return look.lstat(path);
	} catch {
		// Not there, so nothing is found through it.
		return undefined;
	}
}

/**
 * Whether only root can change what `path` is: root owns it and nobody
 * else may write it, save the store's sticky folder. A link's own mode
 * means nothing; the folder holding it is what keeps it.
 */
function sealed(
	path: string,
	look: Look,
	stats: ReturnType<Look["lstat"]> | undefined = statsOf(path, look),
): boolean {
	if (stats === undefined || stats.uid !== 0) return false;
	if (stats.isSymbolicLink()) return true;
	if (path === STORE) {
		return (stats.mode & STICKY) !== 0 && (stats.mode & WORLD_WRITE) === 0;
	}
	return (stats.mode & OTHERS_WRITE) === 0;
}
