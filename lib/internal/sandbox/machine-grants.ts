/**
 * What a machine's owner adds to the strict profile, for a machine whose
 * work lives outside the folder a session starts in.
 *
 * A World cloud node keeps its World git folder and trees on a disk of
 * their own, and its Delta token, package token and signing key in
 * memory, all outside the working folder, so a strict command reaches
 * none of them and no lane can fetch, build, sign or push. Only the
 * machine knows those paths, so the machine says them, in a file only
 * root can write: `/etc/pi-sandbox/strict-grants.json`, as
 * `{"read": [...], "write": [...]}`.
 *
 * The file is honoured only where nothing but root could have put it
 * there: a plain file, not a link, owned by root and writable by root
 * alone, in a folder that is the same. A file anyone else could write
 * would let a fenced command widen its own fence for the next one. So
 * such a file grants nothing, as does a missing one, one this account
 * can't read, or one of another shape, and each but the missing one says
 * why on stderr, once a process. A path in it counts only when it is
 * absolute and already in its plainest form, and never the root folder,
 * so a slip in the file can't grant the whole disk.
 *
 * Inside the fence's own root, which is a user namespace mapping only
 * the session's account, root's files show as the kernel's overflow
 * account, so there that account stands for root. Nothing the session
 * writes can show as it: the session's account is mapped, and only an
 * account outside the namespace shows as overflow, which in `/etc` is
 * root alone.
 */

import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

/** Where a machine's owner writes what the strict profile adds there. */
export const MACHINE_GRANTS = "/etc/pi-sandbox/strict-grants.json";

/** The paths a machine adds to the strict profile, by what they allow. */
export interface MachineGrants {
	readonly read: readonly string[];
	readonly write: readonly string[];
}

/** What is known of a path on disk without following it, as the grant needs. */
export interface GrantStat {
	readonly uid: number;
	readonly mode: number;
	readonly kind: "file" | "folder" | "link" | "other";
}

/** How the grant reads the disk and speaks, so a test can stand in. */
export interface GrantDisk {
	/** The path itself, never what a link leads to; none when missing. */
	lstat(path: string): GrantStat | undefined;
	read(path: string): string | undefined;
	say(why: string): void;
	/** The owner root's files show as here. */
	rootSeenAs(): number;
}

/** The account that alone may write the grant. */
const ROOT = 0;

/** Each line of it maps a range of this namespace's accounts outside. */
const UID_MAP = "/proc/self/uid_map";

/** The owner an unmapped account's files show as, by the kernel's word. */
const OVERFLOW_UID = "/proc/sys/kernel/overflowuid";

/** The kernel's overflow account where it doesn't say. */
const DEFAULT_OVERFLOW = 65534;

/** The mode bits that let a group or anyone else write. */
const WRITABLE_BY_OTHERS = 0o022;

/** No grant at all. */
const NONE: MachineGrants = { read: [], write: [] };

/** What this process has already said of a grant it refused. */
const said = new Set<string>();

/** The disk as it is. */
const DISK: GrantDisk = {
	lstat(path) {
		try {
			const found = lstatSync(path);
			const kind = found.isSymbolicLink()
				? "link"
				: found.isFile()
					? "file"
					: found.isDirectory()
						? "folder"
						: "other";
			return { uid: found.uid, mode: found.mode, kind };
		} catch {
			// Missing or out of reach: the grant is then simply not there.
			return undefined;
		}
	},
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Unreadable to this account: it grants nothing, and says so.
			return undefined;
		}
	},
	say(why) {
		if (said.has(why)) return;
		said.add(why);
		process.stderr.write(`pi: ${why}\n`);
	},
	rootSeenAs() {
		const map = DISK.read(UID_MAP);
		// No map is no Linux namespace to be in: root is root.
		if (map === undefined || rootMapped(map)) return ROOT;
		const overflow = Number.parseInt(DISK.read(OVERFLOW_UID) ?? "", 10);
		return Number.isInteger(overflow) ? overflow : DEFAULT_OVERFLOW;
	},
};

/** Whether a uid map maps this namespace's root to some account outside. */
export function rootMapped(map: string): boolean {
	return map
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.some(
			([inside, , count]) =>
				inside !== undefined &&
				count !== undefined &&
				inside <= ROOT &&
				ROOT < inside + count,
		);
}

/**
 * What the machine adds to the strict profile, read from `path`: nothing
 * unless only root could have written it, and only the paths in it that
 * name a place plainly.
 */
export function machineGrants(
	path: string = MACHINE_GRANTS,
	disk: GrantDisk = DISK,
): MachineGrants {
	const file = disk.lstat(path);
	if (file === undefined) return NONE;
	const refused = (why: string): MachineGrants => {
		disk.say(`the strict profile takes no grant from ${path}: ${why}`);
		return NONE;
	};
	const folder = disk.lstat(dirname(path));
	const root = disk.rootSeenAs();
	const unsafe =
		unsafeBecause(file, "file", root) ?? unsafeBecause(folder, "folder", root);
	if (unsafe) return refused(unsafe);
	const text = disk.read(path);
	if (text === undefined) return refused("it can't be read");
	let given: unknown;
	try {
		given = JSON.parse(text);
	} catch {
		// Said below: a grant that isn't JSON grants nothing.
		return refused("it isn't JSON");
	}
	if (typeof given !== "object" || given === null || Array.isArray(given)) {
		return refused('it isn\'t {"read": [...], "write": [...]}');
	}
	const read = pathsIn(Reflect.get(given, "read"));
	const write = pathsIn(Reflect.get(given, "write"));
	if (read === undefined || write === undefined) {
		return refused("read and write must each be a list of absolute paths");
	}
	return { read, write };
}

/**
 * Why `found`, which should be a `kind`, may have been written by someone
 * other than root, or none when only root could have.
 */
function unsafeBecause(
	found: GrantStat | undefined,
	kind: "file" | "folder",
	root: number,
): string | undefined {
	const what = kind === "file" ? "the file" : "its folder";
	if (found === undefined) return `${what} can't be read`;
	if (found.kind === "link") return `${what} is a link`;
	if (found.kind !== kind) return `${what} isn't a ${kind}`;
	if (found.uid !== root) return `${what} isn't root's`;
	if ((found.mode & WRITABLE_BY_OTHERS) !== 0) {
		return `${what} is writable by more than root`;
	}
	return undefined;
}

/**
 * The paths `listed` names, when it is a list of paths each absolute,
 * already plain and not the root folder; none when anything in it isn't,
 * since a file with one wrong entry may be wrong in ways that read right.
 * A list left out grants nothing of its kind.
 */
function pathsIn(listed: unknown): string[] | undefined {
	if (listed === undefined) return [];
	if (!Array.isArray(listed)) return undefined;
	const plain = listed.filter(
		(entry): entry is string =>
			typeof entry === "string" &&
			isAbsolute(entry) &&
			normalize(entry) === entry &&
			entry !== "/" &&
			!entry.endsWith("/"),
	);
	return plain.length === listed.length ? plain : undefined;
}
