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
import { MOST_LINKS } from "./leads-to.ts";

/** The store's folder, whose paths can't change once added. */
const STORE = "/nix/store";

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
	/** Whether this process's user namespace map can be read; taken as yes where none says. */
	readsMap?(): boolean;
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
	...namespaceLook((path) => readFileSync(path, "utf8")),
};

/** Where a process reads the map of its user namespace's ids. */
const UID_MAP = "/proc/self/uid_map";

/**
 * What one read of this process's user namespace says: the owners that
 * are root here, and whether its map could be read to say so. Both come
 * from the same read, so the cause given for trusting no owner always
 * agrees with the owners that decided it.
 */
export interface UserNamespace {
	readonly rootOwners: readonly number[];
	readonly readsMap: boolean;
}

/**
 * A look's `rootOwners` and `readsMap`, both answered from one read of
 * the map by `read`, made the first time either is asked and kept: the
 * way the real look answers them, so the cause `noOwner` gives is always
 * the one beside the owners that decided it. `uid` and `platform` are
 * this process's, as `userNamespace` takes them.
 */
export function namespaceLook(
	read: (path: string) => string,
	uid?: number,
	platform?: NodeJS.Platform,
): Required<Pick<Look, "rootOwners" | "readsMap">> {
	let here: UserNamespace | undefined;
	const namespace = () => {
		here ??= userNamespace(read, uid, platform);
		return here;
	};
	return {
		rootOwners: () => namespace().rootOwners,
		readsMap: () => namespace().readsMap,
	};
}

/**
 * The owners root's files show as in this process's user namespace, as
 * `/proc/self/uid_map` says: the inner id the outer root maps to, or the
 * overflow user where the namespace maps no root. Root alone where there
 * is no `/proc`, as on a Mac. None where no owner can be told from this
 * process's own, as the paragraphs below say.
 *
 * The map names ids of the namespace above, not the machine's, so the
 * one its 0 maps to is root only in the machine's own namespace, or
 * where it isn't this process: under `unshare -r`, nested or not, it is
 * the person, whose own files would then pass as root's.
 *
 * Where root is unmapped, the overflow user also stands for every other
 * account the namespace leaves out. That trusts their files too, which
 * a fenced command can't make: it runs as the person, whom the
 * namespace maps. So does the inner 0 when this process isn't it, as in
 * an unprivileged container, where it is the container's own root and
 * its programs are root's: a fenced command, running as the person,
 * can't make a file it owns.
 *
 * Outside the machine's own namespace, and outside a Mac, no id this
 * process holds is ever kept. In a namespace that maps nobody, as
 * `unshare -U` leaves one, this process is the overflow user too, and
 * its files would pass as root's. Nor is root assumed to be 0 there:
 * where the overflow user can't be read, only the inner 0 that isn't
 * this process is kept, so where it is, no program is found. Real root
 * in a namespace mapping only 0 to the one above is refused for the same
 * reason: from inside, it can't be told from the person under a nested
 * `unshare -r`. Where this process is the inner 0, it can give a file
 * to any id the map names, so the overflow user is kept only where the
 * map leaves it out, and the outer root's inner id never is. A Linux
 * whose `/proc` can't be read may be such a namespace too, so there this
 * process's own id is dropped as well.
 */
export function rootOwners(
	read: (path: string) => string,
	uid: number = process.getuid?.() ?? 0,
	platform: NodeJS.Platform = process.platform,
): readonly number[] {
	return userNamespace(read, uid, platform).rootOwners;
}

/**
 * The owners that are root in this process's user namespace, as
 * `rootOwners` says, and whether `/proc/self/uid_map` could be read,
 * both from the one read of it.
 */
export function userNamespace(
	read: (path: string) => string,
	uid: number = process.getuid?.() ?? 0,
	platform: NodeJS.Platform = process.platform,
): UserNamespace {
	let map: string;
	try {
		map = read(UID_MAP);
	} catch {
		// A Mac has no user namespaces, so root is root; a Linux without
		// `/proc` may be under `unshare -r`, where 0 is the person.
		const owners =
			platform === "linux" ? [0].filter((owner) => owner !== uid) : [0];
		return { rootOwners: owners, readsMap: false };
	}
	return { rootOwners: ownersBy(map, read, uid), readsMap: true };
}

/** The owners that are root by `map`, a `uid_map` read, for `uid`. */
function ownersBy(
	map: string,
	read: (path: string) => string,
	uid: number,
): readonly number[] {
	const inner = innerRoot(map);
	if (inner !== undefined && isMachines(map)) return [inner];
	// An inner 0 can give its files to the inner id the outer root maps to.
	if (inner !== undefined && uid === 0 && inner !== uid) return [];
	if (inner !== undefined && inner !== uid) return [inner];
	const overflow = overflowUser(read);
	const owners =
		overflow === undefined || (uid === 0 && maps(map, overflow))
			? [0]
			: [overflow, 0];
	return owners.filter((owner) => owner !== uid);
}

/** Whether a `uid_map` names `id` on its inner side. */
function maps(map: string, id: number): boolean {
	return map.split("\n").some((line) => {
		const [inside, , count] = line.trim().split(/\s+/).map(Number);
		return (
			inside !== undefined &&
			count !== undefined &&
			id >= inside &&
			id < inside + count
		);
	});
}

/** The overflow user's id, or undefined where it can't be read whole. */
function overflowUser(read: (path: string) => string): number | undefined {
	try {
		const said = read("/proc/sys/kernel/overflowuid").trim();
		return /^\d+$/.test(said) ? Number(said) : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a `uid_map` is the machine's own namespace's, mapping every id to itself. */
function isMachines(map: string): boolean {
	return map.trim().split(/\s+/).join(" ") === "0 0 4294967295";
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

/**
 * Whether no owner here can be told from this process's own, so no
 * program is ever found, whatever the folders hold.
 */
export function trustsNoOwner(look: Look = real): boolean {
	return (look.rootOwners?.() ?? [0]).length === 0;
}

/**
 * Why no owner here can be trusted: a user namespace whose ids pi can
 * give its files to, or a Linux whose `/proc/self/uid_map` can't be read
 * to say, whether `/proc` isn't mounted or pi may not open it.
 */
export type NoOwner = "namespace" | "unread";

/** Why no owner here can be trusted, or nothing where one can. */
export function noOwner(look: Look = real): NoOwner | undefined {
	if (!trustsNoOwner(look)) return undefined;
	return look.readsMap?.() === false ? "unread" : "namespace";
}

/** What no owner being trusted is, said in a clause, for every message that says it. */
export function noOwnerSaid(why: NoOwner): string {
	return why === "unread"
		? "no owner here can be told from pi's own, since /proc/self/uid_map can't " +
				"be read to say which user namespace pi is in"
		: "no owner here can be told from pi's own, as in a user namespace whose ids " +
				"pi can give its files to";
}

/**
 * What helps where no owner is trusted, as a sentence. No owner is
 * trusted only where pi is 0 (`rootOwners`), so running it as another id
 * always helps. Where the map can't be read, mounting `/proc` helps too,
 * but only where it then shows the machine's own namespace: one whose ids
 * pi can give its files to trusts root no more than now.
 */
export function noOwnerFix(why: NoOwner): string {
	return why === "unread"
		? "Mount /proc, which keeps pi working as root where its user namespace is " +
				"the machine's own, or run pi as an id other than 0, which works either way."
		: "Run pi as an id other than 0 there.";
}

/** Why some programs can't be run, said for a refusal, and what helps where anything does. */
export interface NotKept {
	readonly because: string;
	readonly fix?: string;
}

/**
 * Why `names` can't be run, said for a refusal: that no owner here can
 * be trusted, where `why` says none can, rather than blaming the folders,
 * which may well hold root's. `why` is always given, `undefined` meaning
 * an owner is trusted, so the reason is the one read beside the finder
 * that missed `names`, never the machine's in its place.
 */
export function notKept(
	names: readonly string[],
	why: NoOwner | undefined,
): NotKept {
	const listed = names.join(" and ");
	if (why) {
		return {
			because: `${listed} can't be trusted: ${noOwnerSaid(why)}`,
			fix: noOwnerFix(why),
		};
	}
	const is = names.length === 1 ? "isn't" : "aren't";
	return {
		because: `${listed} ${is} in the system's own profile, where only root puts programs`,
	};
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
 * is owned by root and writable by nobody else. It follows at most
 * `most` links, as many as this system would, so a path the system
 * can't open is never one it finds.
 */
export function sealedPath(
	path: string,
	look: Look = real,
	most: number = MOST_LINKS,
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
		if (links > most) return undefined;
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
