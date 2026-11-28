/**
 * The strict profile's own folders on disk: made before a command runs,
 * refused when one isn't a plain folder of this account's alone.
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
 * A temporary folder named by a process (its pid, and its pid namespace
 * where Linux has one) is made empty the first time that process makes
 * it: pids wrap, and an earlier process with the same pid may have left
 * files there, even a program this one would run. It is emptied only
 * once checked to be a real folder of this account's, and checked again
 * once made anew. The removal still goes by a path through `~/.cache`,
 * which fenced commands may write, so a link swapped in above it after
 * the check could lead it elsewhere; but only to a folder of this
 * process's name, which nothing of the person's takes. A session's
 * folder is kept as it was, for the session resumed, and so is one
 * handed down in `TMPDIR`, which a live process still uses. A folder an
 * earlier process made read-only inside is made writable to be emptied,
 * as it is this account's own. One that still won't empty refuses the
 * command, and the process's commands for {@link TRY_EMPTY_AGAIN_MS}
 * after, so a leftover tree isn't walked on every command; then the
 * next command tries again, since rm may have failed only for want of a
 * process under load. The refusal names the folder and none of what is
 * in it, since those names are an earlier writer's to choose and the
 * refusal reaches the model.
 *
 * What is emptied, and what won't empty, is kept once a process, not
 * once a module: each extension loads its own copy of this one, and a
 * reload another, and each would otherwise empty the folder again under
 * the commands that write there.
 *
 * Nothing yet removes the folders of sessions gone. A sweep by path
 * would run through `~/.cache`, which the fence lets commands write: one
 * swapping `tmp` for a link to the home after the sweep's checks would
 * have pi remove `~/src`. A sweep must hold the folder it removes from
 * first (`remove-tree.ts` says why).
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { removeTree } from "../files/remove-tree.ts";
import { processGlobal } from "../process/process-global.ts";
import { processFolderName, sandboxFolders } from "./strict-rules.ts";

/** The bits that let anyone but the owner reach a folder. */
const OTHERS = 0o077;

/** The temporary folders this process has made empty, so each is emptied once. */
const madeFresh = processGlobal(
	"agentic-harness.sandbox.made-fresh",
	() => new Set<string>(),
);

/**
 * How long a temporary folder that wouldn't empty refuses commands
 * before the next one tries again: long enough that a leftover tree is
 * walked once a minute at most, short enough that a passing failure
 * costs a minute.
 */
export const TRY_EMPTY_AGAIN_MS = 60_000;

/** The temporary folders that wouldn't empty, with why and when, so none is walked on every command. */
const wontEmpty = processGlobal(
	"agentic-harness.sandbox.wont-empty-since",
	() => new Map<string, { readonly refusal: string; readonly at: number }>(),
);

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
	empty: (folder) => removeTree(folder, undefined, { evenReadOnly: true }),
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
	now: () => number = Date.now,
): string | undefined {
	const folders = sandboxFolders(home, env);
	const temporary = folders.temporary;
	const stuck = wontEmpty.get(temporary);
	if (stuck !== undefined) {
		if (disk.look(temporary) === undefined) {
			// Removed by hand, so made anew below, with nothing in it.
			wontEmpty.delete(temporary);
			madeFresh.add(temporary);
		} else if (now() - stuck.at < TRY_EMPTY_AGAIN_MS) {
			return stuck.refusal;
		} else {
			// Its minute is up: this command tries to empty it again.
			wontEmpty.delete(temporary);
		}
	}
	for (const folder of Object.values(folders)) {
		const unmade = madeOurs(folder, disk);
		if (unmade) return unmade;
	}
	if (!startsFresh(temporary, env)) return undefined;
	try {
		disk.empty(temporary);
	} catch {
		// What rm said names what is in the folder, an earlier writer's
		// choice of words, so the refusal leaves it out.
		const refusal = `the strict sandbox couldn't empty its folder ${temporary}, which an earlier process may have left, so this command doesn't run; a command a minute on tries again, or remove the folder`;
		wontEmpty.set(temporary, { refusal, at: now() });
		return refusal;
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
		basename(temporary) === processFolderName() &&
		(env.TMPDIR === undefined || temporary !== resolve(env.TMPDIR)) &&
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
