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
 * why on stderr, once a process. One entry the profile can't take
 * refuses the whole file, naming the entry, since a file with one wrong
 * entry may be wrong in ways that read right. An entry is taken only
 * when it is absolute, already in its plainest form and free of commas
 * (landrun splits a rule at each), passes through no link, and neither
 * is, holds nor lies in a home: the fence lays homes after the grants
 * and hides secrets in them, so a grant there would be read-only inside
 * while Landlock called it writable. Nor may it be or hold a folder the
 * system or the fence needs whole (`/dev`, `/proc`, `/usr`, a runtime
 * folder and the like), or lie in `/proc` or `/sys`, and a device is
 * granted only to write, since bubblewrap binds a read-only one nodev.
 *
 * A grant must also leave alone what the fence lays itself, since it is
 * bound after most of it and would undo it. A written entry may not be,
 * hold or lie in a repository home the person names, which the fence
 * keeps read-only so git runs there unfenced, nor lie in a runtime
 * folder, whose doors the fence lets through read-only. No entry may be,
 * hold or lie in one of those doors or pi's folder beside them, nor in
 * `/tmp`, `/var/tmp` or `/dev/shm`, where any account could lay a link
 * in a missing entry's place before bubblewrap follows it. And no entry
 * may lie within a written one: Landlock and the bind would make it
 * writable whatever it was granted as, and a command could swap it for a
 * link, refusing the whole file to every command after.
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
import {
	FENCE_RUNTIME_FOLDER,
	LET_THROUGH,
} from "../fence/fence-let-through.ts";
import { namedRepositoryHomes } from "../fence/fence-repository-homes.ts";

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
 * The session a machine's grants are judged for: the home the fence
 * lays for it, its runtime folder, the node's worker socket it lets
 * through, and the repository homes its settings name, read from the
 * home's settings unless given.
 */
export interface GrantPlace {
	readonly home: string;
	readonly runtimeDir?: string | undefined;
	readonly workerSocket?: string | undefined;
	readonly repositoryHomes?: readonly string[];
}

/**
 * What reads a machine's grants for a session's place: `machineGrants`,
 * unless a caller hands in its own, as a test does so as not to read
 * this machine's file.
 */
export type GrantsReader = (place: GrantPlace) => MachineGrants;

/**
 * The place a session at `home` is judged as, naming only what it has:
 * a runtime folder and a worker socket left unset are left out.
 */
export function grantPlace(
	home: string,
	runtimeDir: string | undefined,
	workerSocket: string | undefined,
): GrantPlace {
	return {
		home,
		...(runtimeDir === undefined ? {} : { runtimeDir }),
		...(workerSocket === undefined ? {} : { workerSocket }),
	};
}

/**
 * What the machine adds to the strict profile for the session at
 * `place`, read from `path`: nothing unless only root could have written
 * it and every entry in it is one the profile can take for that session.
 */
export function machineGrants(
	place: GrantPlace,
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
	const unknown = Object.keys(given).filter((key) => !KEYS.includes(key));
	if (unknown.length > 0) {
		return refused(
			`it names ${unknown.join(", ")}, which is neither read nor write`,
		);
	}
	const read = Reflect.get(given, "read") ?? [];
	const write = Reflect.get(given, "write") ?? [];
	if (!isList(read) || !isList(write)) {
		return refused("read and write must each be a list of paths");
	}
	const { home } = place;
	const repositoryHomes = place.repositoryHomes ?? namedRepositoryHomes(home);
	for (const [use, listed] of [
		["read", read],
		["write", write],
	] as const) {
		for (const entry of listed) {
			const why = entryRefusal(entry, use, home, repositoryHomes, disk);
			if (why) return refused(`${JSON.stringify(entry)} under ${use} ${why}`);
		}
	}
	const within = withinWritten(read, write);
	if (within) return refused(within);
	return { read: read as string[], write: write as string[] };
}

/** The keys a grant may have. */
const KEYS: readonly string[] = ["read", "write"];

/**
 * Folders a grant may neither name nor hold, by their parts, `*` standing
 * for any one: bound over, each would take from every command what the
 * system or the fence lays there, and a runtime folder would bring past
 * the fence everything it hides there.
 */
const WHOLE: readonly string[] = [
	"/bin",
	"/boot",
	"/dev/pts",
	"/dev/shm",
	"/etc",
	"/lib",
	"/lib64",
	"/nix",
	"/run/user/*",
	"/sbin",
	"/tmp",
	"/usr",
	"/var",
];

/** Folders no grant may name, hold or lie in. */
const SEALED: readonly string[] = ["/proc", "/sys"];

/** Folders that hold homes, which no grant may name, hold or lie in. */
const HOMES: readonly string[] = ["/home/*", "/root"];

/**
 * Folders any account may write, where a missing entry could be laid as
 * a link before bubblewrap follows it, which no grant may name, hold or
 * lie in.
 */
const OPEN_TO_ALL: readonly string[] = ["/tmp", "/var/tmp", "/dev/shm"];

/** Any account's runtime folder. */
const RUNTIME_FOLDER = "/run/user/*";

/**
 * What the fence lays in a runtime folder itself, which no grant may
 * name, hold or lie in: bound again, a door the fence lets through only
 * read-only, or keeps from a language server, would come back as granted.
 */
const FENCES_OWN: readonly string[] = [
	...LET_THROUGH,
	FENCE_RUNTIME_FOLDER,
].map((name) => `${RUNTIME_FOLDER}/${name}`);

/**
 * Why an entry of `read` or `write` lies within an entry of `write`, or
 * none when none does.
 */
function withinWritten(
	read: readonly string[],
	write: readonly string[],
): string | undefined {
	const entries = [
		...read.map((entry) => ({ entry, use: "read" })),
		...write.map((entry) => ({ entry, use: "write" })),
	];
	for (const [at, written] of write.entries()) {
		// Every entry but this written one itself, a second copy of it included.
		const inside = entries.find(
			(other, index) =>
				index !== read.length + at && holds(written, other.entry),
		);
		if (inside) {
			return `${JSON.stringify(inside.entry)} under ${inside.use} lies within ${JSON.stringify(written)} under write`;
		}
	}
	return undefined;
}

/** Whether `listed` is a list of strings. */
function isList(listed: unknown): listed is string[] {
	return (
		Array.isArray(listed) && listed.every((entry) => typeof entry === "string")
	);
}

/**
 * Why the strict profile can't take `entry` to `use`, or none when it
 * can, `home` being this account's.
 */
function entryRefusal(
	entry: string,
	use: "read" | "write",
	home: string,
	repositoryHomes: readonly string[],
	disk: GrantDisk,
): string | undefined {
	if (
		!isAbsolute(entry) ||
		normalize(entry) !== entry ||
		entry === "/" ||
		entry.endsWith("/")
	) {
		return "isn't an absolute path in its plainest form, other than /";
	}
	if (entry.includes(",")) return "holds a comma, which landrun reads as two";
	const home_ = [...HOMES, home].find(
		(folder) => holds(entry, folder) || holds(folder, entry),
	);
	if (home_) return `is, holds or lies in a home (${home_})`;
	const repository =
		use === "write" &&
		repositoryHomes.find((top) => holds(entry, top) || holds(top, entry));
	if (repository) {
		return `is, holds or lies in a repository home (${repository}), which the fence keeps read-only`;
	}
	const sealed = SEALED.find(
		(folder) => holds(entry, folder) || holds(folder, entry),
	);
	if (sealed) return `is, holds or lies in ${sealed}`;
	const whole = WHOLE.find((folder) => holds(entry, folder));
	if (whole) return `is or holds ${whole}, which the fence needs whole`;
	const laid = [...OPEN_TO_ALL, ...FENCES_OWN].find(
		(folder) => holds(entry, folder) || holds(folder, entry),
	);
	if (laid) return `is, holds or lies in ${laid}`;
	if (use === "write" && holds(RUNTIME_FOLDER, entry)) {
		return `lies in a runtime folder (${RUNTIME_FOLDER}), whose doors the fence lets through read-only`;
	}
	if (entry === "/dev") return "is /dev, which the fence lays itself";
	if (use === "read" && holds("/dev", entry)) {
		return "is a device, which works only granted to write";
	}
	const link = linkOn(entry, disk);
	if (link) return `passes through a link at ${link}`;
	return undefined;
}

/**
 * Whether `outer` is `inner` or a folder holding it, `*` in either
 * standing for any one part, so `/run/user/1001` is `/run/user/*`.
 */
function holds(outer: string, inner: string): boolean {
	const outers = outer.split("/").slice(1);
	const inners = inner.split("/").slice(1);
	return (
		outers.length <= inners.length &&
		outers.every(
			(part, at) => part === "*" || inners[at] === "*" || part === inners[at],
		)
	);
}

/**
 * The first folder or file along `path` that is a link, or none; the
 * walk stops where the path runs out on disk, since a missing path is
 * left out of the fence anyway.
 */
function linkOn(path: string, disk: GrantDisk): string | undefined {
	const parts = path.split("/").slice(1);
	for (let end = 1; end <= parts.length; end++) {
		const along = `/${parts.slice(0, end).join("/")}`;
		const found = disk.lstat(along);
		if (found === undefined) return undefined;
		if (found.kind === "link") return along;
	}
	return undefined;
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
