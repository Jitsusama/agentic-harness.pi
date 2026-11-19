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
 * lock file beside it and a rename. The copies are made at the
 * session's first fenced command and kept for the rest, since a command
 * still running, a `dev up` in the background, holds them bound; what a
 * command writes there stays in the session, and the session's next pi
 * starts from the person's files again. `~/.gitconfig` includes dev's settings by their path, which
 * inside leads to the copy.
 *
 * `XDG_CONFIG_HOME` is never moved instead: dev's installer carries it
 * into the units it writes when it differs from the default, so a moved
 * one makes dev rewrite its user units, which it must never do from a
 * fence.
 */

import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PLAIN_SESSION } from "./fence-github.ts";

/** dev's settings folder, as a path from the home folder. */
export const DEV_SETTINGS = join(".config", "dev");

/** git's global settings file, as a path from the home folder. */
const GIT_GLOBAL = ".gitconfig";

/** pi's folder in the runtime folder, and the sessions' copies in it. */
const FOLDER = join("pi-fence", "dev");

/** The sessions this pi has made copies for, and where. */
const MADE = new Map<string, DevCopies>();

/** A session's copies: dev's settings folder, and the folder holding git's global file. */
export interface DevCopies {
	readonly dev: string;
	readonly git: string;
}

/** The global settings file in a session's git folder, for `GIT_CONFIG_GLOBAL`. */
export function gitGlobalIn(folder: string): string {
	return join(folder, "config");
}

/**
 * The session `session`'s copies of dev's and git's settings from the
 * home folder `home`, in pi's folder in the runtime folder: made afresh
 * the first time this pi asks, as `made` records, and kept after; or
 * nothing without a runtime folder, a session id naming one folder, or
 * dev's settings, or when they can't be made, so the command runs as it
 * did before, with both read-only.
 */
export function fenceDevCopies(
	home: string,
	runtimeDir: string | undefined,
	session: string | undefined,
	made: Map<string, DevCopies> = MADE,
): DevCopies | undefined {
	if (!runtimeDir || !session || !PLAIN_SESSION.test(session)) return undefined;
	const settings = join(home, DEV_SETTINGS);
	if (!isFolder(settings)) return undefined;
	const sessions = join(runtimeDir, FOLDER);
	const folder = join(sessions, session);
	const kept = made.get(folder);
	if (kept && isFolder(kept.dev) && isFolder(kept.git)) return kept;
	const copies = freshCopies(home, runtimeDir, folder);
	if (copies) made.set(folder, copies);
	return copies;
}

/**
 * Copies of dev's and git's settings from the home folder `home` made in
 * `folder`, a session's in pi's folder in `runtimeDir`, replacing what
 * it held.
 */
function freshCopies(
	home: string,
	runtimeDir: string,
	folder: string,
): DevCopies | undefined {
	const sessions = join(runtimeDir, FOLDER);
	const settings = join(home, DEV_SETTINGS);
	try {
		// Only pi's folders are made, never the runtime folder (fence-copy.ts
		// says why), and each is checked to be a folder, not a link a
		// command left for the copy to follow.
		for (const made of [join(runtimeDir, "pi-fence"), sessions]) {
			if (!existsSync(made)) mkdirSync(made, { mode: 0o700 });
			if (!isFolder(made)) return undefined;
		}
		if (existsSync(folder) || isLink(folder)) {
			if (!isFolder(folder)) return undefined;
			rmSync(folder, { recursive: true, force: true });
		}
		mkdirSync(folder, { mode: 0o700 });
		const dev = join(folder, "dev");
		const git = join(folder, "git");
		// A link stays a link, leading where the person's does, so a file
		// the fence hides stays hidden rather than copied where it reads.
		cpSync(settings, dev, { recursive: true });
		chmodSync(dev, 0o700);
		mkdirSync(git, { mode: 0o700 });
		const global = join(home, GIT_GLOBAL);
		if (existsSync(global)) copyFileSync(global, gitGlobalIn(git));
		else writeFileSync(gitGlobalIn(git), "", { mode: 0o600 });
		return { dev, git };
	} catch {
		// No copies to bind: dev's settings stay read-only, as before.
		return undefined;
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

/** Whether `path` is a link. */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		// Not there.
		return false;
	}
}
