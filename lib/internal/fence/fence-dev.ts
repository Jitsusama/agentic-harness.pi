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
 * lock file beside it and a rename.
 *
 * Each pi process makes its own, at the session's first fenced command,
 * in a folder named for the session and the process, and keeps them for
 * the rest of its life, since a command still running, a `dev up` in the
 * background, holds them bound. So a second process laying a fence for
 * the same session, `pi-fence` or another pi, never touches a running
 * command's copies, and the next pi starts from the person's files
 * again. A folder whose process has ended is removed by the next one
 * made, and the runtime folder goes at logout.
 *
 * `GIT_CONFIG_GLOBAL` takes the place of both global files git reads,
 * `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, so git's copy
 * includes the second by its path ahead of the first's settings, in the
 * order git reads them, and an include the first names by a relative
 * path is named from the home folder, where git would have found it.
 * `~/.gitconfig` includes dev's settings by their path, which inside
 * leads to the copy.
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
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { PLAIN_SESSION } from "./fence-github.ts";

/** dev's settings folder, as a path from the home folder. */
export const DEV_SETTINGS = join(".config", "dev");

/** git's global settings file, as a path from the home folder. */
const GIT_GLOBAL = ".gitconfig";

/** pi's folder in the runtime folder, and the sessions' copies in it. */
const FOLDER = join("pi-fence", "dev");

/** A copies folder's name: the session's id, a dot, and its process's id. */
const OWNED = /^[A-Za-z0-9_-]{1,64}\.(\d+)$/;

/** A section's opening line in git's settings, and whether it is an include. */
const SECTION = /^\s*\[([^\]]*)\]/;
const INCLUDE = /^(include|includeif)\b/i;

/** An include's path line: what comes before the value, and the value. */
const PATH_LINE = /^(\s*path\s*=\s*)(.*?)\s*$/i;

/** A session's copies: dev's settings folder, and the folder holding git's global file. */
export interface DevCopies {
	readonly dev: string;
	readonly git: string;
}

/**
 * The pi process making copies: the folders it has made, or `null` for
 * one it couldn't make, its id, and how it tells whether another
 * process is still running.
 */
export interface DevMaker {
	readonly made: Map<string, DevCopies | null>;
	readonly pid: number;
	readonly alive: (pid: number) => boolean;
}

/** This pi process, as it makes copies. */
const THIS_PI: DevMaker = {
	made: new Map(),
	pid: process.pid,
	alive: running,
};

/** The global settings file in a session's git folder, for `GIT_CONFIG_GLOBAL`. */
export function gitGlobalIn(folder: string): string {
	return join(folder, "config");
}

/**
 * The session `session`'s copies of dev's and git's settings from the
 * home folder `home`, in pi's folder in the runtime folder `env` names:
 * made the first time this pi asks and kept after; or nothing without a
 * runtime folder, a session id naming one folder, or dev's settings, or
 * when they can't be made, which isn't tried again, so the command runs
 * as it did before, with both read-only.
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
	const folder = join(runtimeDir, FOLDER, `${session}.${pi.pid}`);
	const kept = pi.made.get(folder);
	if (kept === null) return undefined;
	if (kept && isFolder(kept.dev) && isFolder(kept.git)) return kept;
	const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
	const copies = freshCopies(home, configHome, runtimeDir, folder, pi);
	pi.made.set(folder, copies ?? null);
	return copies;
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
	try {
		// Only pi's folders are made, never the runtime folder (fence-copy.ts
		// says why), and each is checked to be the person's own folder, not
		// a link a command left for the copy to follow.
		for (const made of [join(runtimeDir, "pi-fence"), sessions]) {
			if (!existsSync(made)) mkdirSync(made, { mode: 0o700 });
			if (!isOwnFolder(made)) return undefined;
		}
		removeEnded(sessions, pi);
		// A folder of a process that ended under this one's id.
		if (existsSync(folder) || isLink(folder)) {
			if (!isFolder(folder)) return undefined;
			rmSync(folder, { recursive: true, force: true });
		}
		mkdirSync(folder, { mode: 0o700 });
		const dev = join(folder, "dev");
		const git = join(folder, "git");
		// A link stays a link, leading where the person's does, so a file
		// the fence hides stays hidden rather than copied where it reads.
		cpSync(join(home, DEV_SETTINGS), dev, { recursive: true });
		chmodSync(dev, 0o700);
		mkdirSync(git, { mode: 0o700 });
		writeFileSync(gitGlobalIn(git), globalSettings(home, configHome), {
			mode: 0o600,
		});
		return { dev, git };
	} catch {
		// No copies to bind: dev's settings stay read-only, as before.
		return undefined;
	}
}

/**
 * Removes each folder in `sessions` whose process has ended; a link
 * there is removed as a link, never followed.
 */
function removeEnded(sessions: string, pi: DevMaker): void {
	for (const name of readdirSync(sessions)) {
		const owner = OWNED.exec(name)?.[1];
		if (owner === undefined) continue;
		const pid = Number(owner);
		if (pid === pi.pid || pi.alive(pid)) continue;
		rmSync(join(sessions, name), { recursive: true, force: true });
	}
}

/**
 * git's global settings for the copy: the XDG file in `configHome`
 * included by its path where there is one, then `~/.gitconfig`'s, with
 * each include named by a relative path named from `home`.
 */
function globalSettings(home: string, configHome: string): string {
	const xdg = join(configHome, "git", "config");
	const global = join(home, GIT_GLOBAL);
	return [
		existsSync(xdg) ? `[include]\n\tpath = ${quotedValue(xdg)}\n` : "",
		existsSync(global) ? fromHome(readFileSync(global, "utf8"), home) : "",
	].join("");
}

/** git settings `text`, read from `home`, with its includes' relative paths named from there. */
function fromHome(text: string, home: string): string {
	let including = false;
	return text
		.split("\n")
		.map((line) => {
			const section = SECTION.exec(line)?.[1];
			if (section !== undefined) including = INCLUDE.test(section.trim());
			const path = including ? PATH_LINE.exec(line) : null;
			if (!path) return line;
			const [, before = "", raw = ""] = path;
			const value = raw.replace(/^"(.*)"$/, "$1");
			if (value === "" || isAbsolute(value) || value.startsWith("~"))
				return line;
			return `${before}${quotedValue(join(home, value))}`;
		})
		.join("\n");
}

/** `value` as a quoted git settings value. */
function quotedValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Whether the process `pid` is still running, as far as this one can tell. */
function running(pid: number): boolean {
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

/** Whether `path` is a link. */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		// Not there.
		return false;
	}
}
