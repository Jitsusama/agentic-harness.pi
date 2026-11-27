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
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
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
}

const LIVE: NamedHomeDisk = {
	kind(path) {
		const found = lstatSync(path, { throwIfNoEntry: false });
		if (!found) return undefined;
		if (found.isSymbolicLink()) return "link";
		return found.isDirectory() ? "folder" : "other";
	},
	real: (path) => realpathSync(path),
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
	if (kind !== "folder") return `${path} is no folder`;
	if (disk.real(path) !== path) return `${path} lies past a link`;
	return undefined;
}

/**
 * The repository homes the settings under `home` name, judged. A home
 * not on this machine is skipped, never made; one on a machine other
 * than Linux is refused, since only Linux's fence keeps a folder outside
 * the home folder read-only.
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
				? refusal(path, home, install, disk)
				: `${String(path)} is outside the home folder, which only Linux's fence keeps read-only`;
		if (why) refused.push(why);
		else if (
			typeof path === "string" &&
			disk.kind(path) === "folder" &&
			!homes.includes(path)
		)
			homes.push(path);
	}
	return { homes, refused };
}

const READ = new Map<string, readonly string[]>();

/**
 * The repository homes the person's settings name for `home`, read and
 * followed once a process. What is refused is said once, as a warning,
 * and left out.
 */
export function namedRepositoryHomes(home: string): readonly string[] {
	const known = READ.get(home);
	if (known) return known;
	const { homes, refused } = readNamedHomes(home);
	for (const why of refused) {
		process.emitWarning(`pi's fence keeps no repository home here: ${why}.`);
	}
	READ.set(home, homes);
	return homes;
}
