/**
 * The code a folder's own .pi makes pi run outside the sandbox, and
 * whether the host may load it: only as it stood when it was allowed.
 *
 * A fenced command can write a trusted folder's .pi, and the host loads
 * that folder's extensions, MCP servers and packages outside the fence
 * at the conversation's next load. So trusting a folder isn't enough:
 * the host pins the exact contents of that code in its agent folder,
 * which no fenced command can write, and loads it only while it still
 * matches. Code already on the disk when the host first pinned anything
 * is pinned as it is found, so what worked before keeps working; code
 * that arrives or changes after needs the person's yes.
 *
 * Once a .pi holds any code, every file in it counts, not only the code
 * pi names: an extension reads its own files beside it, as one that
 * runs the commands a JSON file in .pi lists does. Skills, prompts,
 * themes and the system prompt files are words pi reads, not code it
 * runs, so they stay under pi's own trust alone, as do the settings
 * that change how pi behaves rather than what it runs. What the
 * settings name on the disk as extensions or packages counts too,
 * wherever it is.
 *
 * Code outside .pi that pinned code imports or runs is not pinned; a
 * walk too large to check is never pinned, so it never loads unasked.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The entries of a folder's .pi that pi runs as code, as pi names them. */
const CODE_ENTRIES = ["extensions", "mcp.json", "npm", "git"] as const;

/** The entries of a folder's .pi that are words pi reads, never code. */
const WORDS_ENTRIES = [
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

/** The folder's own settings, of which only CODE_SETTINGS count. */
const SETTINGS = "settings.json";

/**
 * The settings that start a program outside the sandbox, or say where
 * pi sends its traffic or keeps its conversations. The rest, such as
 * compaction's, change how pi behaves, not what runs, so they stay
 * under pi's own trust alone.
 */
const CODE_SETTINGS = [
	"packages",
	"extensions",
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"selfUpdateCommand",
	"externalEditor",
	"httpProxy",
	"sessionDir",
] as const;

/** The settings whose entries name extensions or packages on the disk. */
const PATH_SETTINGS = ["packages", "extensions"] as const;

/** Sources pi fetches rather than reads from the disk, as pi's isLocalPath tells them. */
const FETCHED = /^(npm|git|github|http|https|ssh|builtin):|^[\w.-]+@[\w.-]+:/;

/** How deep a link may lead before the walk stops following it. */
const MOST_FOLDERS_DEEP = 24;

/** The most entries one folder's code may hold and still be checked. */
export const MOST_ENTRIES = 10_000;

/** The most bytes one folder's code may hold and still be checked. */
export const MOST_BYTES = 64 * 1024 * 1024;

/** How many digests the host keeps as allowed wherever they are found. */
const MOST_ALLOWED = 500;

/** How many of a folder's files a question names, and how long each may be. */
const NAMED_FILES = 3;
const LONGEST_NAME = 80;

/** The file the pins are kept in, in the host's agent folder. */
export const PINS_FILE = "project-code.json";

/** A folder's code, as one digest over every file of it. */
export interface ProjectCode {
	/** What the code holds, by each file's place and contents. */
	readonly digest: string;
	/** Each file's place within the folder, for saying what changed. */
	readonly files: readonly string[];
	/** The newest time any file of it, or a link to one, changed status. */
	readonly newest: number;
	/** False when it was too large to check whole, so it can never be pinned. */
	readonly complete: boolean;
}

/** Whether a folder's code may load, and why. */
export type CodeStanding =
	| { readonly kind: "none" }
	| { readonly kind: "pinned"; readonly code: ProjectCode }
	| { readonly kind: "unpinned"; readonly code: ProjectCode };

interface Pins {
	/** When the host first pinned anything: code older than this was there before it. */
	readonly since: number;
	/** The code each folder last held when it was allowed. */
	readonly folders: Record<string, string>;
	/** Code allowed anywhere, newest first, so the same code in a new tree loads too. */
	readonly allowed: readonly string[];
}

/** Pins nothing can be read from: nothing counts as there before them, so nothing is pinned unasked. */
const DAMAGED: Pins = { since: 0, folders: {}, allowed: [] };

/**
 * The code `cwd`'s .pi holds, or undefined when it holds none. Links are
 * followed, since pi loads what they lead to, and the link itself counts
 * too, so a link moved to another file is a change. Nothing the disk
 * does stops the walk with an error: what can't be read is counted as
 * unreadable, so it reads as a change rather than as nothing.
 */
export function projectCode(cwd: string): ProjectCode | undefined {
	const base = join(cwd, ".pi");
	const settings = join(base, SETTINGS);
	const said = codeSettings(settings);
	const holdsCode =
		said !== undefined ||
		CODE_ENTRIES.some((entry) => exists(join(base, entry)));
	if (!holdsCode) return undefined;
	const walk = walker(cwd);
	walk.take(base, 0, (name) => name === SETTINGS || isWords(name));
	if (said !== undefined) {
		walk.counted("settings", relative(cwd, settings), said.digest);
		walk.stamp(settings);
		for (const named of said.paths) walk.take(named, 0);
	}
	return walk.code();
}

interface Walker {
	/** Count `path` and, for a folder, all it holds, but for top-level names `skip` says to leave. */
	take(path: string, depth: number, skip?: (name: string) => boolean): void;
	/** Count a file the walk didn't read itself, as `kind`. */
	counted(kind: string, place: string, value: string): void;
	/** Count when `path`, and what it leads to, last changed status. */
	stamp(path: string): void;
	code(): ProjectCode;
}

function walker(cwd: string): Walker {
	const lines: string[] = [];
	const files: string[] = [];
	const folders = new Set<string>();
	let newest = 0;
	let entries = 0;
	let bytes = 0;
	let complete = true;
	const line = (kind: string, place: string, value: string): void => {
		lines.push(JSON.stringify([kind, place, value]));
	};
	const full = (): boolean => {
		if (entries > MOST_ENTRIES || bytes > MOST_BYTES) complete = false;
		return !complete;
	};
	const take = (
		path: string,
		depth: number,
		skip?: (name: string) => boolean,
	): void => {
		if (full()) return;
		entries += 1;
		const place = relative(cwd, path);
		try {
			const own = lstatSync(path, { throwIfNoEntry: false });
			if (!own) return;
			newest = Math.max(newest, own.ctimeMs);
			if (own.isSymbolicLink()) line("link", place, readlinkSync(path));
			const seen = statSync(path, { throwIfNoEntry: false });
			if (!seen) return;
			newest = Math.max(newest, seen.ctimeMs);
			if (seen.isDirectory()) {
				const key = `${seen.dev}:${seen.ino}`;
				if (folders.has(key)) {
					line("again", place, "");
					return;
				}
				folders.add(key);
				if (depth >= MOST_FOLDERS_DEEP) {
					// What lies below goes unread, so a change there would go unseen.
					line("too-deep", place, "");
					complete = false;
					return;
				}
				const names = readdirSync(path)
					.filter((name) => !skip?.(name))
					.sort();
				for (const name of names) take(join(path, name), depth + 1);
				return;
			}
			const sum = fileDigest(path);
			if (sum === undefined) {
				line("other", place, "");
				return;
			}
			bytes += sum.size;
			line("file", place, sum.digest);
			files.push(place);
		} catch (error) {
			line("unreadable", place, errorCode(error));
		}
	};
	return {
		take,
		counted(kind, place, value) {
			line(kind, place, value);
			files.push(place);
		},
		stamp(path) {
			try {
				const own = lstatSync(path, { throwIfNoEntry: false });
				const seen = statSync(path, { throwIfNoEntry: false });
				newest = Math.max(newest, own?.ctimeMs ?? 0, seen?.ctimeMs ?? 0);
			} catch (error) {
				line("unreadable", relative(cwd, path), errorCode(error));
			}
		},
		code() {
			full();
			const digest = createHash("sha256")
				.update(lines.join("\n"))
				.digest("hex");
			return { digest, files, newest, complete };
		},
	};
}

/**
 * A regular file's digest and size, or undefined for anything else.
 * Opened without waiting, then checked through the open file, so a pipe
 * swapped in after the walk looked can't hold the host up.
 */
function fileDigest(
	path: string,
): { digest: string; size: number } | undefined {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		const text = readFileSync(fd);
		return {
			digest: createHash("sha256").update(text).digest("hex"),
			size: text.length,
		};
	} finally {
		closeSync(fd);
	}
}

function exists(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	} catch {
		// Unreadable counts as there: the walk then says so.
		return true;
	}
}

function isWords(name: string): boolean {
	return (WORDS_ENTRIES as readonly string[]).includes(name);
}

function errorCode(error: unknown): string {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: "error";
}

interface CodeSettings {
	readonly digest: string;
	/** What the settings name on the disk as extensions or packages. */
	readonly paths: readonly string[];
}

/**
 * The digest of the code settings `file` holds, and the places on the
 * disk they name, or undefined when it holds none. A file pi can't read
 * as settings counts whole, since what it would make of it can't be
 * said.
 */
function codeSettings(file: string): CodeSettings | undefined {
	let text: Buffer;
	try {
		if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
		text = readFileSync(file);
	} catch (error) {
		return { digest: `unreadable ${errorCode(error)}`, paths: [] };
	}
	const whole = { digest: sha256(text), paths: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.toString("utf8"));
	} catch {
		// Not settings pi can read: the whole file is what counts.
		return whole;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return whole;
	const picked = CODE_SETTINGS.filter((key) => key in parsed).map((key) => [
		key,
		Reflect.get(parsed, key),
	]);
	if (picked.length === 0) return undefined;
	const base = join(file, "..");
	const paths = PATH_SETTINGS.flatMap((key) =>
		namedPaths(Reflect.get(parsed, key), base),
	);
	return { digest: sha256(JSON.stringify(picked)), paths };
}

/**
 * The places on the disk a packages or extensions setting names, as pi
 * resolves them against the settings' folder. A pattern counts from the
 * folder it starts in, since pi may load anything under it.
 */
function namedPaths(value: unknown, base: string): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const source =
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && "source" in entry
					? entry.source
					: undefined;
		if (typeof source !== "string") return [];
		const trimmed = source.trim().replace(/^[+!-]+/, "");
		if (trimmed === "" || FETCHED.test(trimmed)) return [];
		const literal = trimmed.split(/[*?[{]/, 1)[0] ?? "";
		const local = literal.startsWith("file:")
			? fileURLToPath(literal)
			: literal === "~" || literal.startsWith("~/")
				? join(homedir(), literal.slice(1))
				: literal;
		return [isAbsolute(local) ? local : resolve(base, local)];
	});
}

function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Start the host's pins the first time it looks at any folder, code or
 * none, so code already there by then is pinned as found, and code that
 * comes after never is.
 */
export function startPins(
	agentDir: string,
	now: () => number = Date.now,
): void {
	const file = join(agentDir, PINS_FILE);
	if (!existsSync(file))
		writePins(file, { since: now(), folders: {}, allowed: [] });
}

/** Whether `cwd`'s code may load as it stands, by the pins in `agentDir`. */
export function codeStanding(
	cwd: string,
	agentDir: string,
	now: () => number = Date.now,
): CodeStanding {
	startPins(agentDir, now);
	const pins = readPins(join(agentDir, PINS_FILE));
	const code = projectCode(cwd);
	if (!code) return { kind: "none" };
	if (!code.complete) return { kind: "unpinned", code };
	if (pins.folders[cwd] === code.digest || pins.allowed.includes(code.digest))
		return { kind: "pinned", code };
	if (code.newest < pins.since) {
		pin(cwd, agentDir, code);
		return { kind: "pinned", code };
	}
	return { kind: "unpinned", code };
}

/** Pin `code` as `cwd`'s, and as allowed wherever it is found; code too large to check never is. */
export function pin(cwd: string, agentDir: string, code: ProjectCode): void {
	if (!code.complete) return;
	const file = join(agentDir, PINS_FILE);
	const pins = readPins(file);
	writePins(file, {
		since: pins.since,
		folders: { ...pins.folders, [cwd]: code.digest },
		allowed: [
			code.digest,
			...pins.allowed.filter((digest) => digest !== code.digest),
		].slice(0, MOST_ALLOWED),
	});
}

/** What to say of code that may not load, naming a few of its files. */
export function unpinnedSaying(cwd: string, code: ProjectCode): string {
	const where = printable(cwd);
	if (!code.complete)
		return `${where}'s .pi holds code pi would run outside the sandbox that is too large to check (over ${MOST_ENTRIES} entries or ${MOST_BYTES / 1024 / 1024} MiB), so it can't be allowed`;
	const count = code.files.length;
	const named = code.files.slice(0, NAMED_FILES).map(printable).join(", ");
	const more = count > NAMED_FILES ? ` and ${count - NAMED_FILES} more` : "";
	const files = count === 1 ? "1 file" : `${count} files`;
	const which = named ? ` (${files}: ${named}${more})` : "";
	return `${where}'s .pi holds code pi would run outside the sandbox${which} that is new or changed since it was last allowed`;
}

/**
 * A name as a question may show it: printable ASCII alone, and cut short
 * from the front, since a path's end is what names its folder or file.
 */
function printable(name: string): string {
	const plain = name.replace(/[^\x20-\x7e]/g, "?");
	return plain.length > LONGEST_NAME
		? `...${plain.slice(plain.length - (LONGEST_NAME - 3))}`
		: plain;
}

/** The pins, read as damaged, which pins nothing, when they can't be read. */
function readPins(file: string): Pins {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isPins(parsed)) return DAMAGED;
		const allowed = parsed.allowed ?? [];
		return { since: parsed.since, folders: parsed.folders, allowed };
	} catch {
		// Gone or unreadable: nothing is pinned, so nothing loads unasked.
		return DAMAGED;
	}
}

function writePins(file: string, pins: Pins): void {
	// Written whole and renamed into place, so a reader never meets half of it.
	const staged = `${file}.${process.pid}.staged`;
	writeFileSync(staged, `${JSON.stringify(pins, null, "\t")}\n`, {
		mode: 0o600,
	});
	renameSync(staged, file);
}

function isPins(
	value: unknown,
): value is Omit<Pins, "allowed"> & { allowed?: string[] } {
	if (typeof value !== "object" || value === null) return false;
	if (!("since" in value && typeof value.since === "number")) return false;
	if (!("folders" in value)) return false;
	const { folders } = value;
	const foldersRead =
		typeof folders === "object" &&
		folders !== null &&
		Object.values(folders).every((digest) => typeof digest === "string");
	if (!foldersRead) return false;
	if (!("allowed" in value)) return true;
	const { allowed } = value;
	return (
		Array.isArray(allowed) &&
		allowed.every((digest) => typeof digest === "string")
	);
}
