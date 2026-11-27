/**
 * Repository homes outside the home folder, named in the person's own
 * settings as `sections.fence.repositoryHomes`, which the fence keeps
 * read-only as it keeps `~/src`: a room keeps its sessions' clones under
 * `/world/runs`, where no repository home reached before, so the work
 * tool refused every tree cut there (WCJQSG 3f2fa40c).
 *
 * Read only from `~/.config/pi/agentic-harness.pi/config.json`, which the
 * fence keeps read-only to every command, never from `XDG_CONFIG_HOME`
 * or a project's settings, either of which a command could point at a
 * file naming `/` (ISXEG8 6bc32d5e). Each home is judged and followed
 * once, when first read, and the answer stands for the process.
 *
 * A named home is never missing while a fenced command runs: pi makes
 * one that is missing, at the first read and before each command, since
 * its parent stays writable to a command, which could otherwise make
 * the home and plant a repository there for git outside the fence to
 * trust. A home pi can't make, no command, running as the same person
 * with less, can make either. And the git guard trusts a named home
 * only while it is the folder the first read found, so one replaced
 * since is kept read-only but trusted no more.
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord } from "../record.ts";
import { packageRoot } from "./installed-only.ts";

/** How deep repositories may sit in a named home, as in `~/src`. */
export const NAMED_HOME_DEPTH = 4;

/** The person's settings file, from the home folder alone. */
const SETTINGS = [".config", "pi", "agentic-harness.pi", "config.json"];

/** What the settings name, judged: the homes kept, and why each other isn't. */
export interface NamedHomes {
	readonly homes: readonly string[];
	readonly refused: readonly string[];
}

/** What the disk says of a path, as the judge needs it. */
export interface NamedHomeDisk {
	/** A path's kind, without following a link at its end; nothing where none is. */
	kind(path: string): "folder" | "link" | "other" | undefined;
	/** The path with every link followed. */
	real(path: string): string;
	/** Make a missing folder and those above it, saying whether it could. */
	make(path: string): boolean;
	/** Which folder `path` is, as its device and inode, or nothing for no folder. */
	identity(path: string): string | undefined;
}

const LIVE: NamedHomeDisk = {
	kind(path) {
		let found: ReturnType<typeof lstatSync>;
		try {
			found = lstatSync(path, { throwIfNoEntry: false });
		} catch {
			// A path pi can't search is refused as no folder rather than left
			// to throw, which would fail every fenced command with it.
			return "other";
		}
		if (!found) return undefined;
		if (found.isSymbolicLink()) return "link";
		return found.isDirectory() ? "folder" : "other";
	},
	real: (path) => realpathSync(path),
	make(path) {
		try {
			mkdirSync(path, { recursive: true });
			return true;
		} catch {
			// A folder pi can't make, no fenced command can make either; the
			// caller says so and leaves the home out.
			return false;
		}
	},
	identity(path) {
		try {
			const found = lstatSync(path, { throwIfNoEntry: false, bigint: true });
			return found?.isDirectory() === true
				? `${found.dev}:${found.ino}`
				: undefined;
		} catch {
			// A folder pi can't look at is no folder it can vouch for.
			return undefined;
		}
	},
};

/** Whether `path` is `folder` or lies in it. */
function within(path: string, folder: string): boolean {
	const at = relative(folder, path);
	return (
		at === "" || !(at === ".." || at.startsWith(`..${sep}`) || isAbsolute(at))
	);
}

/** What the settings file names, or nothing where it names none. */
function named(home: string): unknown[] {
	let text: string;
	try {
		text = readFileSync(join(home, ...SETTINGS), "utf8");
	} catch {
		// No settings file names no home: the fence keeps only its own.
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A file that doesn't parse names no home; the config loader says why.
		return [];
	}
	const sections = isRecord(parsed) ? parsed.sections : undefined;
	const fence = isRecord(sections) ? sections.fence : undefined;
	const homes = isRecord(fence) ? fence.repositoryHomes : undefined;
	if (homes === undefined) return [];
	return Array.isArray(homes) ? homes : [homes];
}

/** Why `path` can't be a repository home here, or nothing where it can. */
function refusal(
	path: unknown,
	home: string,
	install: string,
	disk: NamedHomeDisk,
): string | undefined {
	if (typeof path !== "string") return `${JSON.stringify(path)} is no path`;
	if (!isAbsolute(path) || resolve(path) !== path) {
		return `${path} is not a whole path written plainly`;
	}
	if (path === sep) return `${path} is the whole disk`;
	const homes = [home, ...(disk.kind(home) ? [disk.real(home)] : [])];
	if (homes.some((each) => within(path, each) || within(each, path))) {
		return `${path} is the home folder, in it or above it, which the fence lays itself`;
	}
	if (within(path, install) || within(install, path)) {
		return `${path} holds or lies in the harness's own install`;
	}
	const kind = disk.kind(path);
	if (kind === undefined) return undefined;
	if (kind === "link") return `${path} is a link`;
	if (kind !== "folder") return `${path} is no folder pi can read`;
	if (disk.real(path) !== path) return `${path} lies past a link`;
	return undefined;
}

/**
 * The repository homes the settings under `home` name, judged. A home
 * that passes but is missing is made, judged again as made, and refused
 * where it can't be; one on a machine other than Linux is refused, since
 * only Linux's fence keeps a folder outside the home folder read-only.
 */
export function readNamedHomes(
	home: string,
	{
		platform = process.platform,
		install = packageRoot(),
		disk = LIVE,
	}: {
		platform?: NodeJS.Platform;
		install?: string;
		disk?: NamedHomeDisk;
	} = {},
): NamedHomes {
	const homes: string[] = [];
	const refused: string[] = [];
	for (const path of named(home)) {
		const why =
			platform === "linux"
				? (refusal(path, home, install, disk) ??
					madeOrWhyNot(path, home, install, disk))
				: `${String(path)} is outside the home folder, which only Linux's fence keeps read-only`;
		if (why) refused.push(why);
		else if (typeof path === "string" && !homes.includes(path)) {
			homes.push(path);
		}
	}
	return { homes, refused };
}

/**
 * Why a home that passed its judging is still no home, once a missing
 * one is made and judged again, or nothing where it stands.
 */
function madeOrWhyNot(
	path: unknown,
	home: string,
	install: string,
	disk: NamedHomeDisk,
): string | undefined {
	if (typeof path !== "string" || disk.kind(path) !== undefined) return;
	if (!disk.make(path)) return `${path} is missing, and pi can't make it`;
	return (
		refusal(path, home, install, disk) ??
		(disk.kind(path) === "folder"
			? undefined
			: `${path} is no folder pi can read`)
	);
}

/** A process's first read: the homes kept, and which folder each was. */
interface FirstRead {
	readonly homes: readonly string[];
	readonly identities: ReadonlyMap<string, string | undefined>;
}

const READ = new Map<string, FirstRead>();

/** The first read of the homes named for `home`, made once a process. */
function firstRead(home: string): FirstRead {
	const known = READ.get(home);
	if (known) return known;
	const { homes, refused } = readNamedHomes(home);
	for (const why of refused) {
		process.emitWarning(`pi's fence keeps no repository home here: ${why}.`);
	}
	const read = {
		homes,
		identities: new Map(homes.map((top) => [top, LIVE.identity(top)])),
	};
	READ.set(home, read);
	return read;
}

/**
 * The repository homes the person's settings name for `home`, read and
 * followed once a process. What is refused is said once, as a warning,
 * and left out; a missing home is made, or refused where pi can't.
 */
export function namedRepositoryHomes(home: string): readonly string[] {
	return firstRead(home).homes;
}

/**
 * Make again each named home gone since the first read, before a
 * fenced command starts, so no command ever runs while one is missing.
 * One pi can't make again stays missing, which no command can make.
 */
export function remakeNamedHomes(
	home: string,
	disk: NamedHomeDisk = LIVE,
): void {
	for (const top of firstRead(home).homes) {
		if (disk.kind(top) === undefined) disk.make(top);
	}
}

/**
 * Whether the named home `top` is still the folder the first read
 * found, which alone the git guard trusts: one made again since, or put
 * in its place, may hold what a command wrote while it was gone.
 */
export function namedHomeHolds(
	home: string,
	top: string,
	disk: NamedHomeDisk = LIVE,
): boolean {
	const first = firstRead(home).identities.get(top);
	return first !== undefined && disk.identity(top) === first;
}
