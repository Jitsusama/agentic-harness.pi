/**
 * The strict profile's own folders on disk: made before a command runs,
 * refused when one isn't a plain folder of this account's alone, and
 * swept once their session is gone.
 *
 * landrun skips a path that isn't there, and nothing inside could make
 * one, so each folder is made first. Then each is checked without
 * following it: a fenced command, or any caller of pi-fence, can write
 * the sandbox's folder in the home, and could put a link where a
 * session's temporary folder goes; the session's next strict command
 * would then be granted write and run on wherever it leads. So a folder
 * that is a link, or anything but a folder, or another account's,
 * refuses the command. One others may write is narrowed to this
 * account's alone, since a folder made before this check may have taken
 * the umask's mode.
 *
 * A temporary folder named by a process's pid is made empty the first
 * time that process makes it: pids wrap, and an earlier process with the
 * same pid may have left files there, even a program this one would run.
 * It is emptied only once checked to be a real folder of this account's,
 * and checked again once made anew, so emptying never follows a link.
 * A session's folder is kept as it was, for the session resumed, and so
 * is one handed down in `TMPDIR`, which a live process still uses.
 *
 * Nothing else removes a session's temporary folder, so they would pile
 * up under the cache: once a process, those of sessions gone are swept.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { codeOf } from "../fence/fence-log.ts";
import { removeTree, removeTreeOff } from "../files/remove-tree.ts";
import {
	FOLDER_NAME,
	sandboxFolders,
	temporaryFolders,
} from "./strict-rules.ts";

/** The bits that let anyone but the owner reach a folder. */
const OTHERS = 0o077;

/** How long a session's folder lies unchanged before its session counts as gone. */
const SESSION_GONE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** A folder named for a process rather than a session, and its pid. */
const PID_FOLDER = /^pid-(\d+)$/;

/** The temporary folders this process has made empty, so each is emptied once. */
const madeFresh = new Set<string>();

/** The homes whose gone sessions this process has begun to sweep, so each is swept once. */
const sweeping = new Set<string>();

/** How the folders are made and read, so a test can stand in. */
export interface FolderDisk {
	make(folder: string): void;
	/** The folder itself, never what a link leads to; none when missing. */
	look(
		folder: string,
	):
		| { readonly folder: boolean; readonly uid: number; readonly mode: number }
		| undefined;
	narrow(folder: string): void;
	/** Removes the folder and all in it, never following a link. */
	empty(folder: string): void;
	readonly uid: number | undefined;
}

const DISK: FolderDisk = {
	make: (folder) => mkdirSync(folder, { recursive: true, mode: 0o700 }),
	look: (folder) => {
		const seen = lstatSync(folder, { throwIfNoEntry: false });
		return seen === undefined
			? undefined
			: { folder: seen.isDirectory(), uid: seen.uid, mode: seen.mode };
	},
	narrow: (folder) => chmodSync(folder, 0o700),
	empty: (folder) => removeTree(folder),
	uid: process.getuid?.(),
};

/**
 * Makes the sandbox's folders for the home `home` and the session `env`
 * names, answering why no command may run when one can't be made or
 * isn't a plain folder of this account's, or nothing when all are. The
 * temporary folder this process names by its own pid starts empty, the
 * first time only, so what its own commands write there stays.
 */
export function makeSandboxFolders(
	home: string,
	env: NodeJS.ProcessEnv,
	disk: FolderDisk = DISK,
): string | undefined {
	const folders = sandboxFolders(home, env);
	for (const folder of Object.values(folders)) {
		const unmade = madeOurs(folder, disk);
		if (unmade) return unmade;
	}
	const temporary = folders.temporary;
	if (!startsFresh(temporary, env)) return undefined;
	try {
		disk.empty(temporary);
	} catch (error) {
		return `the strict sandbox couldn't empty its folder ${temporary}, which an earlier process may have left (${String(error)}), so no command runs`;
	}
	madeFresh.add(temporary);
	return madeOurs(temporary, disk);
}

/**
 * Whether `temporary` is the folder this process names by its own pid,
 * not handed down in `TMPDIR` and not yet emptied by this process.
 */
function startsFresh(temporary: string, env: NodeJS.ProcessEnv): boolean {
	return (
		basename(temporary) === `pid-${process.pid}` &&
		temporary !== env.TMPDIR &&
		!madeFresh.has(temporary)
	);
}

/**
 * Makes `folder` and checks it is a plain folder of this account's
 * alone, narrowing one others may reach; answers why not, or nothing.
 */
function madeOurs(folder: string, disk: FolderDisk): string | undefined {
	try {
		disk.make(folder);
	} catch (error) {
		return `the strict sandbox couldn't make its folder ${folder} (${String(error)}), so no command runs`;
	}
	const seen = disk.look(folder);
	if (seen === undefined || !seen.folder) {
		return `the strict sandbox's folder ${folder} is a link or not a folder, so no command runs: remove it and try again`;
	}
	if (disk.uid !== undefined && seen.uid !== disk.uid) {
		return `the strict sandbox's folder ${folder} belongs to another account, so no command runs`;
	}
	if ((seen.mode & OTHERS) === 0) return undefined;
	try {
		disk.narrow(folder);
	} catch (error) {
		return `the strict sandbox's folder ${folder} is open to other accounts and couldn't be narrowed (${String(error)}), so no command runs`;
	}
	return undefined;
}

/**
 * Removes the temporary folders under the home folder `home` whose
 * session is gone, and answers which. A pid's folder goes once no
 * process holds the pid; a session's once nothing in it, however deep,
 * changed for a week, since nothing says whether a session lives. Never
 * the folder of the session `env` names, nor the one it was handed, and
 * never anything but a real folder named as a session's: a link is
 * neither followed nor removed, nor any link inside a folder followed.
 */
export async function sweepGoneSessions(
	home: string,
	env: NodeJS.ProcessEnv,
	now: number = Date.now(),
): Promise<string[]> {
	const every = temporaryFolders(home);
	if (!(await isRealFolder(every))) return [];
	const live = new Set([sandboxFolders(home, env).temporary, env.TMPDIR]);
	const swept: string[] = [];
	for (const name of await readdir(every)) {
		const folder = join(every, name);
		if (!FOLDER_NAME.test(name) || live.has(folder)) continue;
		if (!(await isRealFolder(folder))) continue;
		if (!(await sessionGone(folder, now))) continue;
		await removeTreeOff(folder);
		swept.push(folder);
	}
	return swept;
}

/**
 * Starts `sweepGoneSessions` for the home folder `home` the first time
 * this process asks, and leaves it to run beside the command, which it
 * never holds up.
 */
export function sweepGoneSessionsOnce(
	home: string,
	env: NodeJS.ProcessEnv,
): void {
	if (sweeping.has(home)) return;
	sweeping.add(home);
	sweepGoneSessions(home, env).catch(() => {
		// A folder left is only room taken: the next process sweeps again.
	});
}

/** Whether `folder`'s session is gone, by its pid or by how long it lay unchanged. */
async function sessionGone(folder: string, now: number): Promise<boolean> {
	const pid = PID_FOLDER.exec(basename(folder))?.[1];
	if (pid !== undefined) return !processLives(Number(pid));
	return !(await changedSince(folder, now - SESSION_GONE_AFTER_MS));
}

/** Whether a process holds `pid`: one another account runs still does. */
function processLives(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) !== "ESRCH";
	}
}

/**
 * Whether `path`, or anything under it, changed after `since`, following
 * no link: a link's own time counts, not what it leads to. It stops at
 * the first that did, so a live session's folder is seldom walked far.
 * What can't be read, or goes while it is walked, counts as changed, so
 * a folder is kept whenever its age can't be told.
 */
async function changedSince(path: string, since: number): Promise<boolean> {
	try {
		const found = await lstat(path);
		if (found.mtimeMs > since) return true;
		if (!found.isDirectory()) return false;
		for (const name of await readdir(path)) {
			if (await changedSince(join(path, name), since)) return true;
		}
		return false;
	} catch {
		// Unreadable or gone mid-walk: kept, as changed, since its age is unknown.
		return true;
	}
}

/** Whether `path` is a folder itself, not a link to one, nor missing. */
async function isRealFolder(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}
