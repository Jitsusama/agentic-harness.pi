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
 *
 * Inside a user namespace that maps no root, as the fence's bubblewrap
 * makes, root's files show as owned by the kernel's overflow user. That
 * owner counts as root there: no account inside the namespace is it,
 * and the kernel lets none of them change a file whose owner it doesn't
 * map, so it holds a file exactly as root outside does.
 */

import {
	accessSync,
	constants,
	lstatSync,
	readFileSync,
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
	/** The owners that are root here; root's alone where none says. */
	rootOwners?(): readonly number[];
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
	rootOwners: () => rootOwnersHere(),
};

/** The owners that are root in this process's namespace, read once. */
let rootHere: readonly number[] | undefined;

/** `rootOwners`, read once for this process. */
function rootOwnersHere(): readonly number[] {
	rootHere ??= rootOwners((path) => readFileSync(path, "utf8"));
	return rootHere;
}

/**
 * The owner root's files show as in this process's user namespace, as
 * `/proc/self/uid_map` says: the inner id the outer root maps to, or the
 * overflow user where the namespace maps no root. Never the inner 0 of a
 * namespace that maps someone else there, as `unshare -r` maps the
 * person, since their own files would then pass as root's. Root alone
 * where there is no `/proc`, as on a Mac.
 *
 * Where root is unmapped, the overflow user also stands for every other
 * account the namespace leaves out. That trusts their files too, which
 * a fenced command can't make: it runs as the person, whom the
 * namespace maps.
 */
export function rootOwners(read: (path: string) => string): readonly number[] {
	try {
		const inner = innerRoot(read("/proc/self/uid_map"));
		if (inner !== undefined) return [inner];
		return [Number(read("/proc/sys/kernel/overflowuid").trim())];
	} catch {
		// No `/proc`: no user namespaces, so root is root.
		return [0];
	}
}

/** The inner id a `uid_map` maps the outer root to, if it maps it. */
function innerRoot(map: string): number | undefined {
	for (const line of map.split("\n")) {
		const [inside, outside, count] = line.trim().split(/\s+/).map(Number);
		if (inside === undefined || outside === undefined || count === undefined) {
			continue;
		}
		if (outside <= 0 && outside + count > 0) return inside - outside;
	}
	return undefined;
}

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
	const root = look.rootOwners?.() ?? [0];
	if (stats === undefined || !root.includes(stats.uid)) return false;
	if (stats.isSymbolicLink()) return true;
	if (path === STORE) {
		return (stats.mode & STICKY) !== 0 && (stats.mode & WORLD_WRITE) === 0;
	}
	return (stats.mode & OTHERS_WRITE) === 0;
}
