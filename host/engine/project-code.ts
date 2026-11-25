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
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder pi reads a project's own settings and resources from, as pi names it. */
export const OWN_FOLDER = ".pi";

/** The bits of a file's mode a copy keeps: its permissions alone. */
const FILE_MODE = 0o777;

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

/**
 * Sources pi fetches rather than reads from the disk, as pi's isLocalPath
 * tells them: by these prefixes alone, so a `user@host:` source is a path
 * to pi, and is walked.
 */
const FETCHED = /^(npm|git|github|http|https|ssh|builtin):/;

/** How deep a link may lead before the walk stops following it. */
const MOST_FOLDERS_DEEP = 24;

const MIB = 1024 * 1024;

/** The most entries one folder's code may hold and still be checked. */
export const MOST_ENTRIES = 10_000;

/** The most bytes one folder's code may hold and still be checked. */
export const MOST_BYTES = 64 * MIB;

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
	/**
	 * Each file's place within the folder, the last to change status first,
	 * for saying what changed: nobody can set a change time back, so code
	 * planted among files allowed before is named ahead of them.
	 */
	readonly files: readonly string[];
	/** The newest time any file of it, or a link to one, changed status. */
	readonly newest: number;
	/** False when it couldn't be checked whole, so it can never be pinned. */
	readonly complete: boolean;
	/** What kept it from being checked whole, when it wasn't. */
	readonly unchecked?: string;
}

/** Whether a folder's code may load, and why. */
export type CodeStanding =
	| { readonly kind: "none" }
	| { readonly kind: "pinned"; readonly code: ProjectCode }
	| {
			readonly kind: "unpinned";
			readonly code: ProjectCode;
			/** Why the pins couldn't be read, when they couldn't: the code may well be what was allowed. */
			readonly pinsUnread?: string;
	  };

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
 * The pins as read, and whether they may be written over: only when
 * they were read whole or there were none, so a read that failed for a
 * moment never takes every other folder's pins with it.
 */
interface ReadPins {
	readonly pins: Pins;
	readonly writable: boolean;
	/** Read, but not as pins: kept aside before new ones are written. */
	readonly damaged?: boolean;
}

/**
 * The code `cwd`'s .pi holds, or undefined when it holds none. Links are
 * followed, since pi loads what they lead to, and the link itself counts
 * too, so a link moved to another file is a change. Nothing the disk
 * does stops the walk with an error: what can't be read leaves the code
 * unchecked, since a file behind an entry the host can't read may still
 * be one pi loads, and could change unseen.
 */
export function projectCode(cwd: string): ProjectCode | undefined {
	return readProject(cwd).code;
}

/** One file of a copy: its place within the .pi, its bytes and its mode. */
export interface CopiedFile {
	readonly place: string;
	readonly text: Buffer;
	readonly mode: number;
}

/**
 * A folder's .pi as one read found it: its code, and every file pi may
 * read there, code and words, as the same bytes the code's digest was
 * taken over, so a copy of them loads exactly what was checked.
 */
export interface ProjectCopy {
	readonly code: ProjectCode | undefined;
	readonly files: readonly CopiedFile[];
	/** Why a copy can't stand in for the .pi, when it can't. */
	readonly uncopyable?: string;
	/** Why some of its words were left out of the copy, when some were. */
	readonly wordsLeftOut?: string;
}

/**
 * Read `cwd`'s .pi once for a copy: its code as projectCode finds it,
 * keeping each file's bytes as hashed, then the rest of it as words: all
 * of it when it holds no code, else what the code walk leaves to words.
 * The words walk never reads the settings or the entries pi runs as
 * code, so nothing it reads loads as code unhashed. A copy can't stand
 * in for a .pi whose settings name code by an absolute path, or one
 * leading out of it, since pi would still read that code where it is.
 * Words that can't be read are left out, said, since leaving out words
 * loads less and never anything unchecked.
 */
export function projectCopy(cwd: string): ProjectCopy {
	const kept = new Map<string, CopiedFile>();
	const keep =
		(over: boolean) =>
		(place: string, text: Buffer, mode: number): void => {
			const inside = relative(OWN_FOLDER, place);
			if (leavesFolder(inside)) return;
			// What the code was hashed from wins over a second read of the same file as words.
			if (over || !kept.has(inside))
				kept.set(inside, { place: inside, text, mode });
		};
	const base = join(cwd, OWN_FOLDER);
	const read = readProject(cwd, keep(true));
	const words = walker(cwd, keep(false), { lenient: true });
	if (read.code)
		for (const name of WORDS_ENTRIES) words.take(join(base, name), 1);
	else words.take(base, 0, (name) => name === SETTINGS || isCode(name));
	const leftOut = words.leftOut();
	const uncopyable =
		read.outside.length > 0
			? `its settings name ${read.outside.map(printable).join(", ")}, which pi would load from where it is rather than from the copy`
			: undefined;
	return {
		code: read.code,
		files: [...kept.values()],
		...(uncopyable ? { uncopyable } : {}),
		...(leftOut ? { wordsLeftOut: leftOut } : {}),
	};
}

/** A file's bytes as one read found them, for whoever keeps them. */
type Keep = (place: string, text: Buffer, mode: number) => void;

function readProject(
	cwd: string,
	keep?: Keep,
): { code: ProjectCode | undefined; outside: readonly string[] } {
	const base = join(cwd, OWN_FOLDER);
	const settings = join(base, SETTINGS);
	const { said, text, mode } = settingsRead(settings);
	if (keep && text) keep(relative(cwd, settings), text, mode);
	const outside = said?.outside ?? [];
	const holdsCode =
		said !== undefined ||
		CODE_ENTRIES.some((entry) => exists(join(base, entry)));
	if (!holdsCode) return { code: undefined, outside };
	const walk = walker(cwd, keep);
	walk.take(base, 0, (name) => name === SETTINGS || isWords(name));
	if (said !== undefined) {
		walk.counted("settings", relative(cwd, settings), said.digest);
		walk.stamp(settings);
		if (said.unchecked) walk.unchecked(said.unchecked);
		for (const named of said.paths) walk.take(named, 0);
	}
	return { code: walk.code(), outside };
}

interface Walker {
	/** Count `path` and, for a folder, all it holds, but for top-level names `skip` says to leave. */
	take(path: string, depth: number, skip?: (name: string) => boolean): void;
	/** Count a file the walk didn't read itself, as `kind`. */
	counted(kind: string, place: string, value: string): void;
	/** Count when `path`, and what it leads to, last changed status. */
	stamp(path: string): void;
	/** Leave the code unchecked, saying why, unless something already has. */
	unchecked(why: string): void;
	code(): ProjectCode;
	/** Why a lenient walk left something out, or stopped, when it did. */
	leftOut(): string | undefined;
}

/**
 * Walk what `cwd`'s .pi holds, counting it for a digest and handing
 * each file read to `keep`. A strict walk, for code, stops at the first
 * thing it can't read whole; a lenient one, for words, skips it, saying
 * so, and stops only at its limits.
 */
function walker(
	cwd: string,
	keep?: Keep,
	options: { readonly lenient?: boolean } = {},
): Walker {
	const lines: string[] = [];
	const files: { readonly place: string; time: number }[] = [];
	const folders = new Set<string>();
	// Folders walked leaving some names out, so a later walk reaching one takes those too.
	const partly = new Map<string, (name: string) => boolean>();
	let newest = 0;
	let entries = 0;
	let bytes = 0;
	let unchecked: string | undefined;
	let skipped: string | undefined;
	// Each file kept, and where each folder was first walked, so a folder reached again is kept there too.
	const keptFiles: { readonly place: string; text: Buffer; mode: number }[] =
		[];
	const firstAt = new Map<string, string>();
	const line = (kind: string, place: string, value: string): void => {
		lines.push(JSON.stringify([kind, place, value]));
	};
	const stop = (why: string): void => {
		unchecked ??= why;
	};
	const fault = (why: string): void => {
		if (options.lenient) skipped ??= why;
		else stop(why);
	};
	const kept = (place: string, text: Buffer, mode: number): void => {
		if (!keep) return;
		keep(place, text, mode);
		keptFiles.push({ place, text, mode });
	};
	// Write the files kept under `first` again under `place`, as pi reads them there too.
	const keepAgain = (first: string | undefined, place: string): void => {
		if (!keep || first === undefined) return;
		const under = `${first}${sep}`;
		for (const file of keptFiles.filter((each) => each.place.startsWith(under)))
			keep(join(place, file.place.slice(under.length)), file.text, file.mode);
	};
	const full = (): boolean => {
		if (entries > MOST_ENTRIES) stop(`it holds over ${MOST_ENTRIES} entries`);
		if (bytes > MOST_BYTES) stop(`it holds over ${MOST_BYTES / MIB} MiB`);
		return unchecked !== undefined;
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
					// The digest counts it once; the copy holds it at each place pi may read it.
					keepAgain(firstAt.get(key), place);
					const leftBefore = partly.get(key);
					if (!leftBefore) return;
					partly.delete(key);
					const left = readdirSync(path).filter(leftBefore).sort();
					for (const name of left) take(join(path, name), depth + 1);
					return;
				}
				folders.add(key);
				firstAt.set(key, place);
				if (skip) partly.set(key, skip);
				if (depth >= MOST_FOLDERS_DEEP) {
					// What lies below goes unread, so a change there would go unseen.
					line("too-deep", place, "");
					fault(`its folders go over ${MOST_FOLDERS_DEEP} deep`);
					return;
				}
				const names = readdirSync(path)
					.filter((name) => !skip?.(name))
					.sort();
				for (const name of names) take(join(path, name), depth + 1);
				return;
			}
			const sum = fileDigest(path, MOST_BYTES - bytes);
			if (sum === undefined) {
				// A pipe or a device has no contents to pin, yet pi reads whatever comes through it.
				line("other", place, "");
				fault(
					`it holds ${printable(place)}, which is neither a file nor a folder`,
				);
				return;
			}
			bytes += sum.size;
			if (sum.digest === undefined || sum.text === undefined) return;
			kept(place, sum.text, sum.mode);
			line("file", place, sum.digest);
			files.push({ place, time: Math.max(own.ctimeMs, seen.ctimeMs) });
		} catch (error) {
			// pi may still load what lies behind it, by name, so it can't count as known.
			line("unreadable", place, errorCode(error));
			fault(`the host can't read ${printable(place)} (${errorCode(error)})`);
		}
	};
	return {
		take,
		counted(kind, place, value) {
			line(kind, place, value);
			files.push({ place, time: 0 });
		},
		stamp(path) {
			try {
				const own = lstatSync(path, { throwIfNoEntry: false });
				const seen = statSync(path, { throwIfNoEntry: false });
				const time = Math.max(own?.ctimeMs ?? 0, seen?.ctimeMs ?? 0);
				newest = Math.max(newest, time);
				const place = relative(cwd, path);
				for (const file of files)
					if (file.place === place) file.time = Math.max(file.time, time);
			} catch (error) {
				const place = relative(cwd, path);
				line("unreadable", place, errorCode(error));
				stop(`the host can't read ${printable(place)} (${errorCode(error)})`);
			}
		},
		unchecked: stop,
		leftOut() {
			full();
			return unchecked ?? skipped;
		},
		code() {
			full();
			const digest = createHash("sha256")
				.update(lines.join("\n"))
				.digest("hex");
			const named = [...files]
				.sort(
					(a, b) =>
						b.time - a.time ||
						(a.place < b.place ? -1 : a.place > b.place ? 1 : 0),
				)
				.map((file) => file.place);
			return unchecked === undefined
				? { digest, files: named, newest, complete: true }
				: { digest, files: named, newest, complete: false, unchecked };
		},
	};
}

/**
 * A regular file's size, and its digest, bytes and mode when it is no
 * larger than `room`, or undefined for anything else. Opened without
 * waiting, then checked through the open file, so a pipe swapped in
 * after the walk looked can't hold the host up, and a file past the room
 * left is never read, so a planted sparse file costs the host nothing.
 */
function fileDigest(
	path: string,
	room: number,
): { digest?: string; text?: Buffer; mode: number; size: number } | undefined {
	const read = regularFile(path, room);
	if (read === undefined) return undefined;
	if (typeof read === "number") return { size: read, mode: 0 };
	const { text, mode } = read;
	return { digest: sha256(text), text, mode, size: text.length };
}

/**
 * A regular file's contents and mode, its size alone when it is past
 * `room`, or undefined when it isn't a regular file. Read no further
 * than `room`, so a file that grows after its size was seen can't hold
 * the host up.
 */
function regularFile(
	path: string,
	room: number,
): { text: Buffer; mode: number } | number | undefined {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const seen = fstatSync(fd);
		if (!seen.isFile()) return undefined;
		if (seen.size > room) return seen.size;
		const mode = seen.mode & FILE_MODE;
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			// Sized to the file at first, so a small file costs no more than itself.
			const want = chunks.length === 0 ? seen.size + 1 : MIB;
			const chunk = Buffer.allocUnsafe(Math.min(want, MIB, room + 1 - total));
			// Past the room: what was read says how far.
			if (chunk.length === 0) return total;
			const got = readSync(fd, chunk, 0, chunk.length, null);
			if (got === 0) return { text: Buffer.concat(chunks, total), mode };
			chunks.push(chunk.subarray(0, got));
			total += got;
		}
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

function isCode(name: string): boolean {
	return (CODE_ENTRIES as readonly string[]).includes(name);
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
	/** What they name by an absolute path, or a relative one leading out of their folder. */
	readonly outside: readonly string[];
	/** What kept the settings, or what they name, from being read whole. */
	readonly unchecked?: string;
}

/** The settings as read: what code they hold, and the bytes and mode read, when read whole. */
interface SettingsRead {
	readonly said: CodeSettings | undefined;
	readonly text?: Buffer;
	readonly mode: number;
}

/**
 * The digest of the code settings `file` holds, and the places on the
 * disk they name, or undefined when it holds none, with the bytes they
 * were read from. A file pi can't read as settings counts whole, since
 * what it would make of it can't be said.
 */
function settingsRead(file: string): SettingsRead {
	const problem = (digest: string, unchecked: string): SettingsRead => ({
		said: { digest, paths: [], outside: [], unchecked },
		mode: 0,
	});
	let text: Buffer;
	let mode: number;
	try {
		if (!statSync(file, { throwIfNoEntry: false }))
			return { said: undefined, mode: 0 };
		const read = regularFile(file, MOST_BYTES);
		if (read === undefined)
			return problem(
				"not a file",
				"its settings aren't a file, so what pi reads there can't be pinned",
			);
		if (typeof read === "number")
			return problem(
				"too large",
				`its settings are over ${MOST_BYTES / MIB} MiB`,
			);
		({ text, mode } = read);
	} catch (error) {
		return problem(
			`unreadable ${errorCode(error)}`,
			`the host can't read its settings (${errorCode(error)})`,
		);
	}
	return { said: codeSettings(text, file), text, mode };
}

/** The code settings `text`, read from `file`, holds, or undefined when it holds none. */
function codeSettings(text: Buffer, file: string): CodeSettings | undefined {
	const whole = { digest: sha256(text), paths: [], outside: [] };
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
	const named = PATH_SETTINGS.map((key) =>
		namedPaths(Reflect.get(parsed, key), base),
	);
	const unchecked = named.find((found) => found.unchecked)?.unchecked;
	return {
		digest: sha256(JSON.stringify(picked)),
		paths: named.flatMap((found) => found.paths),
		outside: named.flatMap((found) => found.outside),
		...(unchecked ? { unchecked } : {}),
	};
}

/**
 * The places on the disk a packages or extensions setting names, as pi
 * resolves them against the settings' folder. A pattern counts from the
 * folder it starts in, since pi may load anything under it; one whose
 * start the host can't tell, behind a brace or a group, or a file URL it
 * can't read, leaves the code unchecked rather than guess.
 */
function namedPaths(
	value: unknown,
	base: string,
): { paths: string[]; outside: string[]; unchecked?: string } {
	// pi spreads the setting into a list, so a string names each of its characters.
	const entries: unknown[] =
		typeof value === "string" ? [...value] : Array.isArray(value) ? value : [];
	const paths: string[] = [];
	const outside: string[] = [];
	for (const entry of entries) {
		const place = namedPath(entry, base);
		if (place === undefined) continue;
		if (typeof place !== "string")
			return { paths, outside, unchecked: place.unchecked };
		paths.push(place);
		// Said as written, so the person can tell which entry to change.
		if (!namedWithin(entry, base, place)) outside.push(trimmedSource(entry));
	}
	return { paths, outside };
}

/**
 * Whether `entry` names `place` relative to its settings' folder `base`
 * and within it, so a copy of that folder holds what it names. A step
 * up anywhere in it counts as leading out, since one after a wildcard
 * may climb past the folder its start is in.
 */
function namedWithin(entry: unknown, base: string, place: string): boolean {
	const source = trimmedSource(entry);
	const relativeSource =
		!(isAbsolute(source) || source.startsWith("file:")) &&
		source !== "~" &&
		!source.startsWith("~/") &&
		!source.split(/[\\/]/).includes("..");
	return relativeSource && !leavesFolder(relative(base, place));
}

/** The source one settings entry names, without the marks pi reads before it. */
function trimmedSource(entry: unknown): string {
	return (
		sourceOf(entry)
			?.trim()
			.replace(/^[+!-]+/, "") ?? ""
	);
}

/** Whether a place `relative` gave leads out of the folder it was taken from: by a whole step up, not a name starting with dots. */
function leavesFolder(place: string): boolean {
	return place === ".." || place.startsWith(`..${sep}`) || isAbsolute(place);
}

/** The source one settings entry names, a string or an object's source. */
function sourceOf(entry: unknown): string | undefined {
	const source =
		typeof entry === "string"
			? entry
			: typeof entry === "object" && entry !== null && "source" in entry
				? entry.source
				: undefined;
	return typeof source === "string" ? source : undefined;
}

/** The place one entry names, nothing for one pi fetches, or why it can't be told. */
function namedPath(
	entry: unknown,
	base: string,
): string | { unchecked: string } | undefined {
	const source = sourceOf(entry);
	if (source === undefined) return undefined;
	const trimmed = source.trim().replace(/^[+!-]+/, "");
	if (trimmed === "" || FETCHED.test(trimmed)) return undefined;
	const said = printable(trimmed);
	if (/[{(]/.test(trimmed))
		return {
			unchecked: `its settings name ${said}, a pattern it can't follow`,
		};
	// A wildcard may sit inside a name, so the walk starts at the folder above it.
	const wild = trimmed.search(/[*?[]/);
	const literal =
		wild < 0 ? trimmed : trimmed.slice(0, trimmed.lastIndexOf("/", wild) + 1);
	let local: string;
	try {
		local = literal.startsWith("file:")
			? fileURLToPath(literal)
			: literal === "~" || literal.startsWith("~/")
				? join(homedir(), literal.slice(1))
				: literal;
	} catch {
		return {
			unchecked: `its settings name ${said}, which isn't a place it can read`,
		};
	}
	return isAbsolute(local) ? local : resolve(base, local);
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
	if (existsSync(file)) return;
	try {
		writePins(file, { since: now(), folders: {}, allowed: [] });
	} catch {
		// With no pins to read nothing is pinned, so code asks rather than the build failing.
	}
}

/** Whether `cwd`'s code may load as it stands, by the pins in `agentDir`. */
export function codeStanding(
	cwd: string,
	agentDir: string,
	now: () => number = Date.now,
): CodeStanding {
	startPins(agentDir, now);
	return standingOf(cwd, agentDir, projectCode(cwd), now);
}

/** Whether `code`, as read from `cwd`, may load, by the pins in `agentDir`. */
export function standingOf(
	cwd: string,
	agentDir: string,
	code: ProjectCode | undefined,
	now: () => number = Date.now,
): CodeStanding {
	startPins(agentDir, now);
	const file = join(agentDir, PINS_FILE);
	const { pins, damaged } = readPins(file);
	if (!code) return { kind: "none" };
	if (!code.complete) return { kind: "unpinned", code };
	const pinned =
		pins.folders[cwd] === code.digest ||
		pins.allowed.includes(code.digest) ||
		heldForLife.has(lifeKey(agentDir, code.digest));
	if (pinned) return { kind: "pinned", code };
	// The start is whole milliseconds and a change's time finer, so the same millisecond counts as before.
	if (Math.floor(code.newest) <= pins.since) {
		pin(cwd, agentDir, code);
		return { kind: "pinned", code };
	}
	if (pins !== DAMAGED) return { kind: "unpinned", code };
	// Saying so sends whoever reads it to the pins, not hunting for planted code.
	const pinsUnread = damaged
		? `${printable(file)} can't be read as pins; a yes keeps it beside them as ${printable(`${file}.damaged`)} and starts them afresh`
		: `the host can't read ${printable(file)}`;
	return { kind: "unpinned", code, pinsUnread };
}

/**
 * Digests allowed in this host's life, by agent folder: a yes holds
 * until the host stops even when its pins can't be written.
 */
const heldForLife = new Set<string>();

function lifeKey(agentDir: string, digest: string): string {
	return `${agentDir}\0${digest}`;
}

/**
 * Pin `code` as `cwd`'s, and as allowed wherever it is found; code too
 * large to check never is. Says why when the pins couldn't be written,
 * and the yes then holds for the host's life alone.
 */
export function pin(
	cwd: string,
	agentDir: string,
	code: ProjectCode,
): string | undefined {
	if (!code.complete) return undefined;
	heldForLife.add(lifeKey(agentDir, code.digest));
	// Pins started before this yes keep the host's first look as it was.
	startPins(agentDir);
	const file = join(agentDir, PINS_FILE);
	const { pins, writable, damaged } = readPins(file);
	try {
		// Damaged pins are copied beside, for whoever looks at why they broke, and the new
		// ones renamed over them, so no moment finds the file gone and starts it afresh.
		if (damaged) copyFileSync(file, `${file}.damaged`);
		// Not over pins it couldn't read.
		else if (!writable) return `the host couldn't read ${printable(file)}`;
		writePins(file, {
			since: pins.since,
			folders: { ...pins.folders, [cwd]: code.digest },
			allowed: [
				code.digest,
				...pins.allowed.filter((digest) => digest !== code.digest),
			].slice(0, MOST_ALLOWED),
		});
		return undefined;
	} catch (error) {
		// A full disk or a read-only agent folder.
		return `the host couldn't write ${printable(file)} (${errorCode(error)})`;
	}
}

/** What to say of code that may not load, naming a few of its files, the newest first. */
export function unpinnedSaying(
	cwd: string,
	standing: { readonly code: ProjectCode; readonly pinsUnread?: string },
): string {
	const { code, pinsUnread } = standing;
	const where = printable(cwd);
	if (!code.complete)
		return `${where}'s .pi holds code pi would run outside the sandbox that the host can't check whole, since ${code.unchecked ?? "it is too large"}, so it can't be allowed until that changes`;
	const count = code.files.length;
	const named = code.files.slice(0, NAMED_FILES).map(printable).join(", ");
	const more = count > NAMED_FILES ? ` and ${count - NAMED_FILES} more` : "";
	const files = count === 1 ? "1 file" : `${count} files, the newest first`;
	const which = named ? ` (${files}: ${named}${more})` : "";
	if (pinsUnread)
		return `${where}'s .pi holds code pi would run outside the sandbox${which} that the host can't tell was allowed before, since ${pinsUnread}`;
	return `${where}'s .pi holds code pi would run outside the sandbox${which} that is new or changed since it was last allowed`;
}

/**
 * A name as a question may show it: printable ASCII alone, and cut short
 * from the front, since a path's end is what names its folder or file.
 */
export function printable(name: string): string {
	const plain = name.replace(/[^\x20-\x7e]/g, "?");
	return plain.length > LONGEST_NAME
		? `...${plain.slice(plain.length - (LONGEST_NAME - 3))}`
		: plain;
}

/**
 * The pins, read as damaged, which pins nothing, when they can't be
 * read. Only pins read whole, or none at all, may be written over.
 */
function readPins(file: string): ReadPins {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		// Gone, or unreadable for now: nothing is pinned, so nothing loads unasked.
		return { pins: DAMAGED, writable: errorCode(error) === "ENOENT" };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isPins(parsed))
			return { pins: DAMAGED, writable: false, damaged: true };
		const allowed = parsed.allowed ?? [];
		return {
			pins: { since: parsed.since, folders: parsed.folders, allowed },
			writable: true,
		};
	} catch {
		return { pins: DAMAGED, writable: false, damaged: true };
	}
}

function writePins(file: string, pins: Pins): void {
	// Written whole and renamed into place, so a reader never meets half of it.
	const staged = `${file}.${process.pid}.staged`;
	try {
		writeFileSync(staged, `${JSON.stringify(pins, null, "\t")}\n`, {
			mode: 0o600,
		});
		renameSync(staged, file);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
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
