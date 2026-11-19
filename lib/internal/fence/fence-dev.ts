/**
 * The session's own copies of dev's settings and git's global settings,
 * which a fenced `dev up` writes in place of the person's. Inside, mint,
 * dev's credential service, is out of reach, so dev's setup rewrites its
 * credential helper in `~/.config/dev` and tidies `~/.gitconfig` with
 * `git config --global`, on every call, and fails on the read-only home
 * (ISXEG8, 19 November). Both stay read-only to the fence: the person's
 * own git runs what they say. So each session gets copies, made outside
 * when its fence is laid, bound writable in their place: dev's folder
 * over `~/.config/dev`, and git's global file through
 * `GIT_CONFIG_GLOBAL`, in a folder of its own, since git writes it by a
 * lock file beside it and a rename. Nothing the fence hides is copied.
 *
 * Each pi process makes its own, at the session's first fenced command,
 * in a folder named for the session and the process, and keeps them
 * while the person's files stay as they were, since a command still
 * running, a `dev up` in the background, holds them bound. Once the
 * person's files change, the next command gets a fresh set in a folder
 * of its own, leaving the last one to whatever holds it. So a second
 * process laying a fence for the same session, `pi-fence` or another pi,
 * never touches a running command's copies, and the next pi starts from
 * the person's files again. A folder whose process has ended is removed
 * by the next one made, but only by a process in the same pid namespace,
 * which each folder names, since one in another, a `pi-fence` inside a
 * fence, sees none of the processes outside it; the runtime folder goes
 * at logout. None is made in a runtime folder others can reach.
 *
 * `GIT_CONFIG_GLOBAL` takes the place of both global files git reads,
 * `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, so git's copy
 * includes the second by its path ahead of the first's settings, in the
 * order git reads them, and an include the first names by a relative
 * path, or an `includeIf` whose `gitdir` starts `./`, is named from the
 * home folder, where git would have found it. `~/.gitconfig` includes
 * dev's settings by their path, which inside leads to the copy.
 *
 * `XDG_CONFIG_HOME` is never moved instead: dev's installer carries it
 * into the units it writes when it differs from the default, so a moved
 * one makes dev rewrite its user units, which it must never do from a
 * fence.
 */

import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PLAIN_SESSION } from "./fence-github.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";

/** dev's settings folder, as a path from the home folder. */
export const DEV_SETTINGS = join(".config", "dev");

/** git's global settings file, as a path from the home folder. */
const GIT_GLOBAL = ".gitconfig";

/** pi's folder in the runtime folder, and the sessions' copies in it. */
const FOLDER = join("pi-fence", "dev");

/**
 * A copies folder's name: the session's id, a dot, its process's id, and
 * for each set after the first, a dot and the set's number.
 */
const OWNED = /^[A-Za-z0-9_-]{1,64}\.(\d+)(?:\.\d+)?$/;

/** The file in each copies folder naming the pid namespace that made it. */
const NAMESPACE = "ns";

/** A section's opening line in git's settings: its name, and what follows it. */
const SECTION = /^(\s*)\[((?:[^\]"\\]|"(?:[^"\\]|\\.)*")*)\](.*)$/;
const INCLUDE = /^(include|includeif)\b/i;

/** An includeIf on a `gitdir` the file's own folder starts, `./`. */
const HERE = /^(includeif\s+")(gitdir(?:\/i)?:)\.\/((?:[^"\\]|\\.)*)"$/i;

/** An include's path setting: what comes before the value, and the value. */
const PATH_SETTING = /^(\s*path\s*=\s*)(.*)$/i;

/** A session's copies: dev's settings folder, and the folder holding git's global file. */
export interface DevCopies {
	readonly dev: string;
	readonly git: string;
}

/**
 * What a pi process has made for a session: its copies, or `null` where
 * they couldn't be made; what the person's files were when it made them;
 * and which set they are.
 */
export interface DevMade {
	readonly copies: DevCopies | null;
	readonly source: string;
	readonly generation: number;
}

/**
 * The pi process making copies: what it has made for each session, its
 * id, how it tells whether another process is still running, every mount
 * its processes see (nothing where they can't be read), its pid
 * namespace (empty where it can't be read), what the fence hides, as
 * paths from the home folder, and how it says why it made none.
 */
export interface DevMaker {
	readonly made: Map<string, DevMade>;
	readonly pid: number;
	readonly alive: (pid: number) => boolean;
	readonly mounts: () => string | undefined;
	readonly ns: string;
	readonly hidden: readonly string[];
	readonly tell: (why: string) => void;
}

/** This pi process, as it makes copies. */
const THIS_PI: DevMaker = {
	made: new Map(),
	pid: process.pid,
	alive: running,
	mounts: everyMount,
	ns: pidNamespace(),
	hidden: FENCE_HIDDEN.home,
	tell: (why) => process.emitWarning(`pi-fence: ${why}`),
};

/** The global settings file in a session's git folder, for `GIT_CONFIG_GLOBAL`. */
export function gitGlobalIn(folder: string): string {
	return join(folder, "config");
}

/**
 * The session `session`'s copies of dev's and git's settings from the
 * home folder `home`, in pi's folder in the runtime folder `env` names:
 * made the first time this pi asks, kept while the person's files stay
 * as they were, and made afresh once they change, the set before kept
 * where a fresh one can't be made; or nothing without a runtime folder, a
 * session id naming one folder, or dev's settings, or when the first
 * can't be made, which isn't tried again, so the command runs as it did
 * before, with both read-only.
 */
export function fenceDevCopies(
	home: string,
	env: { readonly XDG_RUNTIME_DIR?: string; readonly XDG_CONFIG_HOME?: string },
	session: string | undefined,
	pi: DevMaker = THIS_PI,
): DevCopies | undefined {
	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (!runtimeDir || !session || !PLAIN_SESSION.test(session)) return undefined;
	if (!isFolder(join(home, DEV_SETTINGS))) return undefined;
	const kept = pi.made.get(session);
	if (kept && kept.copies === null) return undefined;
	const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
	const source = sourceOf(home, configHome);
	if (
		kept?.copies &&
		kept.source === source &&
		isFolder(kept.copies.dev) &&
		isFolder(kept.copies.git)
	)
		return kept.copies;
	let generation = !kept
		? 0
		: kept.source === source
			? kept.generation
			: kept.generation + 1;
	const name = `${session}.${pi.pid}`;
	const folderOf = (set: number) =>
		join(runtimeDir, FOLDER, set === 0 ? name : `${name}.${set}`);
	// A folder under this pi's own id it doesn't know of is one it made
	// before a reload, which a running command may hold, so it's left be.
	while (existsSync(folderOf(generation)) || isLink(folderOf(generation)))
		generation++;
	const copies = freshCopies(
		home,
		configHome,
		runtimeDir,
		folderOf(generation),
		pi,
	);
	if (
		!copies &&
		kept?.copies &&
		isFolder(kept.copies.dev) &&
		isFolder(kept.copies.git)
	) {
		// The set before still works, so commands keep it, and the next one
		// tries a fresh set again.
		pi.made.set(session, { ...kept, generation });
		return kept.copies;
	}
	pi.made.set(session, { copies: copies ?? null, source, generation });
	return copies;
}

/**
 * What the person's files are now, as each one's identity, size and
 * times: git's two global files and everything in dev's folder, so a
 * change to any of them reads differently.
 */
function sourceOf(home: string, configHome: string): string {
	const dev = join(home, DEV_SETTINGS);
	let inDev: string[] = [];
	try {
		inDev = readdirSync(dev, { recursive: true, encoding: "utf8" }).sort();
	} catch {
		// Read as gone: the copy then fails and says nothing is made.
	}
	return [
		join(home, GIT_GLOBAL),
		join(configHome, "git", "config"),
		...inDev.map((entry) => join(dev, entry)),
	]
		.map(
			(path) =>
				`${path}\0${statOf(path, lstatSync)}\0${statOf(path, statSync)}`,
		)
		.join("\n");
}

/** `path`'s identity, size and times as `stat` reads them, or `-` where it can't. */
function statOf(path: string, stat: typeof lstatSync): string {
	try {
		const { ino, size, mode, mtimeMs, ctimeMs } = stat(path);
		return `${ino}:${size}:${mode}:${mtimeMs}:${ctimeMs}`;
	} catch {
		// Gone, or a link leading nowhere.
		return "-";
	}
}

/**
 * Copies of dev's and git's settings from the home folder `home` made in
 * `folder`, in pi's folder in `runtimeDir`, after removing the folders
 * of processes that have ended.
 */
function freshCopies(
	home: string,
	configHome: string,
	runtimeDir: string,
	folder: string,
	pi: DevMaker,
): DevCopies | undefined {
	const sessions = join(runtimeDir, FOLDER);
	// A runtime folder another account can reach would let it read the
	// copies' settings, or swap pi's folders as they're made.
	if (!isPrivateFolder(runtimeDir)) {
		pi.tell(
			`${runtimeDir} isn't a folder for this account alone, so dev's settings stay read-only in the fence`,
		);
		return undefined;
	}
	let started = false;
	try {
		// Only pi's folders are made, never the runtime folder (fence-copy.ts
		// says why), and each is checked to be the person's own folder, not
		// a link a command left for the copy to follow.
		for (const made of [join(runtimeDir, "pi-fence"), sessions]) {
			makeFolder(made);
			if (!isOwnFolder(made)) {
				pi.tell(
					`${made} isn't a folder of this account's own, so dev's settings stay read-only in the fence`,
				);
				return undefined;
			}
		}
		removeEnded(sessions, pi);
		// Made new, never taken over: a folder already there fails here.
		mkdirSync(folder, { mode: 0o700 });
		started = true;
		writeFileSync(join(folder, NAMESPACE), pi.ns, { mode: 0o600 });
		const dev = join(folder, "dev");
		const git = join(folder, "git");
		// A link stays a link, leading where the person's does, so a file
		// the fence hides stays hidden rather than copied where it reads;
		// what the fence hides in dev's folder isn't copied at all.
		const hidden = hiddenIn(pi.hidden);
		// A socket or a pipe there is something running, never settings, so
		// it isn't copied.
		cpSync(join(home, DEV_SETTINGS), dev, {
			recursive: true,
			filter: (from) =>
				isPlain(from) && !hidden(relative(home, from), isFolder(from)),
		});
		chmodSync(dev, 0o700);
		mkdirSync(git, { mode: 0o700 });
		writeFileSync(gitGlobalIn(git), globalSettings(home, configHome, hidden), {
			mode: 0o600,
		});
		return { dev, git };
	} catch (error) {
		// No copies to bind: dev's settings stay read-only, as before, and
		// what was made of this set goes, so no half set is left.
		if (started) {
			try {
				rmSync(folder, { recursive: true, force: true });
			} catch {
				// Left for this pi's end, as its other sets are.
			}
		}
		const said = error instanceof Error ? error.message : String(error);
		pi.tell(
			`dev's settings couldn't be copied (${said}), so they stay read-only in the fence`,
		);
		return undefined;
	}
}

/**
 * Whether a path from the home folder is one the fence hides, given the
 * fence's list `hidden`: a path ending in `/` hides a folder and all in it.
 */
function hiddenIn(
	hidden: readonly string[],
): (path: string, folder: boolean) => boolean {
	return (path, folder) =>
		hidden.some((entry) =>
			entry.endsWith("/")
				? (folder && `${path}/` === entry) || path.startsWith(entry)
				: path === entry,
		);
}

/** Makes the folder `path` for this account alone, where no one has yet. */
function makeFolder(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		// Another pi made it first, which isOwnFolder then judges.
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
			throw error;
	}
}

/**
 * Removes each folder in `sessions` whose process has ended, where this
 * process's pid namespace made it and no process still has it mounted,
 * as a command its pi left running would; a link there is removed as a
 * link, never followed. One that can't be removed is left for the next.
 */
function removeEnded(sessions: string, pi: DevMaker): void {
	let mounted: string | undefined | null = null;
	for (const name of readdirSync(sessions)) {
		const owner = OWNED.exec(name)?.[1];
		if (owner === undefined) continue;
		const pid = Number(owner);
		if (pid === pi.pid || pi.alive(pid)) continue;
		const path = join(sessions, name);
		try {
			if (isLink(path)) {
				unlinkSync(path);
				continue;
			}
			if (pi.ns === "" || namespaceOf(path) !== pi.ns) continue;
			// Read once, and only when a set might go.
			if (mounted === null) mounted = pi.mounts();
			if (mounted === undefined || mounted.includes(`/${FOLDER}/${name}/`))
				continue;
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Held by something this process can't remove; the next one tries.
		}
	}
}

/** The pid namespace a copies folder names, or nothing where it names none. */
function namespaceOf(folder: string): string | undefined {
	try {
		return readFileSync(join(folder, NAMESPACE), "utf8");
	} catch {
		// Not made by this code, or not readable: never removed.
		return undefined;
	}
}

/**
 * The mounts every process of this account sees, read once for each
 * mount namespace, or nothing where `/proc` can't be read.
 */
function everyMount(): string | undefined {
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
	} catch {
		// No /proc: whether a set is held can't be told, so none goes.
		return undefined;
	}
	const seen = new Set<string>();
	const mounts: string[] = [];
	for (const pid of pids) {
		try {
			const space = readlinkSync(`/proc/${pid}/ns/mnt`);
			if (seen.has(space)) continue;
			mounts.push(readFileSync(`/proc/${pid}/mountinfo`, "utf8"));
			seen.add(space);
		} catch {
			// Gone, or another account's, which never holds this one's copies.
		}
	}
	return mounts.join("");
}

/** This process's pid namespace, or empty where it can't be read. */
function pidNamespace(): string {
	try {
		return readlinkSync("/proc/self/ns/pid");
	} catch {
		// No /proc, as on a Mac: nothing is removed by namespace.
		return "";
	}
}

/**
 * git's global settings for the copy: the XDG file's in `configHome`,
 * then `~/.gitconfig`'s, as git reads both, each with its includes'
 * relative paths named from its own folder. Both are written out, not
 * included, since `git config --global` reads no includes; one the fence
 * hides, as `hidden` says, through a link or not, is left out.
 */
function globalSettings(
	home: string,
	configHome: string,
	hidden: (path: string, folder: boolean) => boolean,
): string {
	return [join(configHome, "git", "config"), join(home, GIT_GLOBAL)]
		.map((file) => {
			if (!existsSync(file)) return "";
			const real = realpathSync(file);
			const fromHomeFolder = relative(realpathSync(home), real);
			const inHome =
				!fromHomeFolder.startsWith("..") && !isAbsolute(fromHomeFolder);
			if (inHome && hidden(fromHomeFolder, false)) return "";
			const text = fromFolder(readFileSync(file, "utf8"), dirname(file));
			return text === "" || text.endsWith("\n") ? text : `${text}\n`;
		})
		.join("");
}

/**
 * git settings `text`, read from `folder`, with its includes' relative
 * paths, and the `gitdir` an `includeIf` names from the file's own
 * folder, named from there; its lines end as git's own do, whichever
 * ending it was written with.
 */
function fromFolder(text: string, folder: string): string {
	let including = false;
	return text
		.split(/\r?\n/)
		.map((line) => {
			const section = SECTION.exec(line);
			if (!section) return including ? withPath(line, folder) : line;
			const [, indent = "", name = "", rest = ""] = section;
			including = INCLUDE.test(name.trim());
			const header = `${indent}[${hereFrom(name, folder)}]`;
			return `${header}${including ? withPath(rest, folder) : rest}`;
		})
		.join("\n");
}

/** A section's name, with an `includeIf`'s `gitdir:./` named from `home`. */
function hereFrom(name: string, home: string): string {
	const here = HERE.exec(name.trim());
	if (!here) return name;
	const [, opening = "", kind = "", raw = ""] = here;
	const pattern = raw.replace(/\\(.)/g, "$1");
	let path = join(home, pattern);
	if ((pattern === "" || pattern.endsWith("/")) && !path.endsWith("/"))
		path += "/";
	return `${opening}${kind}${escaped(path)}"`;
}

/**
 * The setting `line` with a relative include path named from `home`;
 * an absolute path, one from `~`, one git expands, `%(prefix)`, an empty
 * one, or one this can't read, is left as it was.
 */
function withPath(line: string, home: string): string {
	const setting = PATH_SETTING.exec(line);
	if (!setting) return line;
	const [, before = "", raw = ""] = setting;
	const value = gitValue(raw);
	if (
		value === undefined ||
		value === "" ||
		isAbsolute(value) ||
		value.startsWith("~") ||
		value.startsWith("%(")
	)
		return line;
	return `${before}${quotedValue(join(home, value))}`;
}

/**
 * A git settings value as git reads it from `raw`: quotes joined, the
 * escapes git knows turned into what they stand for, an unquoted `;` or
 * `#` ending it, and unquoted space at its end trimmed; or nothing where
 * it runs on to the next line, or an escape git refuses.
 */
function gitValue(raw: string): string | undefined {
	const ESCAPES: Record<string, string> = {
		'"': '"',
		"\\": "\\",
		n: "\n",
		t: "\t",
		b: "\b",
	};
	let value = "";
	let kept = 0;
	let quoted = false;
	for (let at = 0; at < raw.length; at++) {
		const char = raw.charAt(at);
		if (char === "\\") {
			const next = raw.charAt(at + 1);
			const meant = ESCAPES[next];
			if (meant === undefined) return undefined;
			value += meant;
			kept = value.length;
			at++;
		} else if (char === '"') {
			quoted = !quoted;
			kept = value.length;
		} else if (!quoted && (char === ";" || char === "#")) {
			break;
		} else {
			value += char;
			if (quoted || !/\s/.test(char)) kept = value.length;
		}
	}
	if (quoted) return undefined;
	return value.slice(0, kept);
}

/** `value` as a quoted git settings value. */
function quotedValue(value: string): string {
	return `"${escaped(value)}"`;
}

/** `value` with what ends or escapes a quoted git value escaped. */
function escaped(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Whether the process `pid` is still running, as far as this one can tell. */
export function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Another account's process is running, though this one can't signal it.
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** Whether `path` is a folder itself, not a link to one. */
function isFolder(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		// Not there.
		return false;
	}
}

/** Whether `path` is a folder itself, owned by this process's account. */
function isOwnFolder(path: string): boolean {
	try {
		const stat = lstatSync(path);
		const uid = process.getuid?.();
		return stat.isDirectory() && (uid === undefined || stat.uid === uid);
	} catch {
		// Not there.
		return false;
	}
}

/** Whether `path` is this account's own folder, which no other may reach. */
function isPrivateFolder(path: string): boolean {
	try {
		return isOwnFolder(path) && (lstatSync(path).mode & 0o077) === 0;
	} catch {
		// Not there.
		return false;
	}
}

/** Whether `path` is a file, a folder or a link, not a socket, a pipe or a device. */
function isPlain(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
	} catch {
		// Gone as it was copied: nothing to copy.
		return false;
	}
}

/** Whether `path` is a link. */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		// Not there.
		return false;
	}
}
