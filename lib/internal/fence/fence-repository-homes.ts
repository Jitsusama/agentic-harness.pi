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
 * file naming `/` (ISXEG8 6bc32d5e). The settings are read again
 * whenever they change, so a process that read them before a home was
 * named binds it from its next command on.
 *
 * Naming a folder vouches for what it holds then. From then on, the git
 * guard trusts a named home only while it is the very folder pi first
 * found there, as pi's record says: the first pi process to read a home
 * writes down which folder it is (its device, inode and birth time), or
 * that it found none it could keep, in pi's state, which the fence keeps
 * read-only to every command. Each process asks that one record, so a
 * home one process left unbound (a home pi couldn't make, a home made
 * again after something outside took it away) is trusted by no process
 * after. A home pi makes again, or that turns up where pi found none, is
 * still kept read-only but trusted no more, until the person, having
 * checked what it holds, removes its record.
 *
 * A named home is made before each fenced command where it is missing,
 * since its parent stays writable to a command, which could otherwise
 * make the home while it runs.
 */

import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cacheDir, stateDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { packageRoot } from "./installed-only.ts";

/** How deep repositories may sit in a named home, as in `~/src`. */
export const NAMED_HOME_DEPTH = 4;

/** The person's settings file, from the home folder alone. */
const SETTINGS = [".config", "pi", "agentic-harness.pi", "config.json"];

/**
 * Where pi records which folder each named home first was, from the
 * home folder alone, in what the fence keeps read-only (`.local/state/pi`).
 */
const RECORDS = [
	".local",
	"state",
	"pi",
	"agentic-harness.pi",
	"fence",
	"named-homes",
];

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
	/**
	 * Which folder `path` is, as its device, inode and birth time, or
	 * nothing for no folder: an inode number a removed folder freed may
	 * be given to the next one made, but not its birth time.
	 */
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
			// A folder pi can't make now is left out of this read; whatever
			// makes it later is trusted by no process (its record says none).
			return false;
		}
	},
	identity(path) {
		try {
			const found = lstatSync(path, { throwIfNoEntry: false, bigint: true });
			return found?.isDirectory() === true
				? `${found.dev}:${found.ino}:${found.birthtimeNs}`
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

/**
 * pi's own cache and state folders, wherever `XDG_CACHE_HOME` and
 * `XDG_STATE_HOME` put them: the fence binds a quest's scratch, its
 * shared folder and the session's trees back writable in them, which
 * in a named home would be a writable spot the git guard trusts.
 */
function pisOwnFolders(): string[] {
	return [cacheDir("fence"), stateDir("fence")].map((path) =>
		dirname(dirname(path)),
	);
}

/** Why `path` can't be a repository home here, or nothing where it can. */
function refusal(
	path: unknown,
	home: string,
	install: string,
	own: readonly string[],
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
	const mine = own.find((each) => within(path, each) || within(each, path));
	if (mine !== undefined) {
		return `${path} holds or lies in ${mine}, pi's own folder, where the fence lets commands write`;
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
		own = pisOwnFolders(),
		disk = LIVE,
	}: {
		platform?: NodeJS.Platform;
		install?: string;
		own?: readonly string[];
		disk?: NamedHomeDisk;
	} = {},
): NamedHomes {
	const homes: string[] = [];
	const refused: string[] = [];
	for (const path of named(home)) {
		const why =
			platform === "linux"
				? (refusal(path, home, install, own, disk) ??
					madeOrWhyNot(path, home, install, own, disk))
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
	own: readonly string[],
	disk: NamedHomeDisk,
): string | undefined {
	if (typeof path !== "string" || disk.kind(path) !== undefined) return;
	if (!disk.make(path)) return `${path} is missing, and pi can't make it`;
	return (
		refusal(path, home, install, own, disk) ??
		(disk.kind(path) === "folder"
			? undefined
			: `${path} is no folder pi can read`)
	);
}

/** The record of which folder `top` first was, under `home`. */
function recordOf(home: string, top: string): string {
	const name = createHash("sha256").update(top).digest("hex");
	return join(home, ...RECORDS, `${name}.json`);
}

/**
 * Which folder pi first found at `top`: its identity, `null` where pi
 * found none it could keep, or nothing where no record can be read.
 */
function recorded(home: string, top: string): string | null | undefined {
	let text: string;
	try {
		text = readFileSync(recordOf(home, top), "utf8");
	} catch {
		// No record, or none pi can read, vouches for no folder.
		return undefined;
	}
	try {
		const record: unknown = JSON.parse(text);
		if (!isRecord(record) || record.home !== top) return undefined;
		return typeof record.folder === "string" || record.folder === null
			? record.folder
			: undefined;
	} catch {
		// A record that doesn't parse vouches for no folder.
		return undefined;
	}
}

/**
 * Write down `seen` as the folder `top` first was, unless a record is
 * there already, which then stands: whole or not at all, since another
 * process may be writing the same record at once.
 */
function recordFirst(home: string, top: string, seen: string | null): void {
	const record = recordOf(home, top);
	const draft = `${record}.${process.pid}.${Date.now()}`;
	try {
		mkdirSync(dirname(record), { recursive: true });
		writeFileSync(
			draft,
			`${JSON.stringify({ home: top, folder: seen, at: new Date().toISOString() })}\n`,
			{ flag: "wx" },
		);
		linkSync(draft, record);
	} catch {
		// Recorded already, by this process or another, which stands; or pi
		// can't write its state, so no record vouches and nothing is trusted.
	}
	try {
		unlinkSync(draft);
	} catch {
		// A draft never written is none to take away, and one pi can't take
		// away is left beside the records, which never read it.
	}
}

/** The settings file as it stands, to tell when it changed. */
function settingsStamp(home: string): string {
	try {
		const found = statSync(join(home, ...SETTINGS), { bigint: true });
		return `${found.dev}:${found.ino}:${found.size}:${found.mtimeNs}:${found.ctimeNs}`;
	} catch {
		// No settings file to read is a stamp of its own.
		return "none";
	}
}

/** A process's last read: the homes kept, and the settings it was read from. */
interface Read {
	readonly stamp: string;
	readonly homes: readonly string[];
}

const READ = new Map<string, Read>();

/** What has been said of a refused home, so each is said once a process. */
const SAID = new Set<string>();

/** The home folder as one place, however it is spelled. */
function oneHome(home: string): string {
	try {
		return realpathSync(home);
	} catch {
		// A home folder pi can't follow is taken as it is spelled.
		return home;
	}
}

/**
 * The homes named for `home`, read again whenever the settings change,
 * with each named path's first folder written down where none is yet.
 */
function currentRead(home: string): Read {
	const stamp = settingsStamp(home);
	const known = READ.get(home);
	if (known?.stamp === stamp) return known;
	const { homes, refused } = readNamedHomes(home);
	for (const why of refused) {
		if (SAID.has(why)) continue;
		SAID.add(why);
		process.emitWarning(`pi's fence keeps no repository home here: ${why}.`);
	}
	for (const path of named(home)) {
		if (typeof path !== "string" || !isAbsolute(path)) continue;
		const kept = homes.includes(path) ? LIVE.identity(path) : undefined;
		recordFirst(home, path, kept ?? null);
	}
	const read = { stamp, homes };
	READ.set(home, read);
	return read;
}

/**
 * The repository homes the person's settings name for `home`, read and
 * followed again whenever the settings change. What is refused is said
 * once a process, as a warning, and left out; a missing home is made, or
 * refused where pi can't make it.
 */
export function namedRepositoryHomes(home: string): readonly string[] {
	return currentRead(oneHome(home)).homes;
}

/**
 * Make again each named home gone since the settings were read, before a
 * fenced command starts, so the command finds it bound read-only rather
 * than missing in a writable parent. One made again is trusted no more
 * (`namedHomeHolds`).
 */
export function remakeNamedHomes(
	home: string,
	disk: NamedHomeDisk = LIVE,
): void {
	for (const top of namedRepositoryHomes(home)) {
		if (disk.kind(top) === undefined) disk.make(top);
	}
}

/**
 * Whether the named home `top` is still the folder pi first found
 * there, as pi's record says, which alone the git guard trusts: one
 * made again since, put in its place, or turned up where pi found none,
 * may hold what a command wrote while it was unbound.
 */
export function namedHomeHolds(
	home: string,
	top: string,
	disk: NamedHomeDisk = LIVE,
): boolean {
	const one = oneHome(home);
	if (!currentRead(one).homes.includes(top)) return false;
	// A record the person took away, having checked the folder, is written
	// again as the folder now stands; no command can take one away.
	if (recorded(one, top) === undefined) {
		recordFirst(one, top, disk.identity(top) ?? null);
	}
	const first = recorded(one, top);
	return typeof first === "string" && disk.identity(top) === first;
}

/**
 * Why the named home `top` is trusted no more, with what the person can
 * do about it, or nothing where it is trusted or no named home.
 */
export function namedHomeDoubt(home: string, top: string): string | undefined {
	const one = oneHome(home);
	if (!currentRead(one).homes.includes(top)) return undefined;
	if (namedHomeHolds(home, top)) return undefined;
	return `${top} is not the folder pi first found there (made again, replaced, or turned up where pi found none), so git outside the fence trusts no repository in it; once you have checked what it holds, remove ${recordOf(one, top)} and pi takes it as it then stands`;
}
