/**
 * Removing a folder and everything in it without being led out of it.
 *
 * Node 22's `rmSync`, and every Node's `fs.promises.rm`, walk a tree by
 * path: each entry is checked to be no link, then opened or unlinked by
 * its whole path from the top. A process that can still write inside the
 * tree swaps a subfolder for a link between the check and the unlink, and
 * the walk carries on in whatever the link names, deleting with pi's own
 * rights. A fenced command still running in a tree pi releases, or
 * anything it left there, can so delete what the fence kept from it.
 * A race of 2,000 files lost 99 of the linked folder's to Node 22 in its
 * first round; Node 24's `rmSync` lost none in 60 (R-rm-follows-links,
 * 25 November).
 *
 * The system's own `rm` walks by descriptor: it opens each folder with
 * no-follow and unlinks names inside the folder it holds open, so a swap
 * mid-walk removes the link, never what it names. coreutils and the Mac's
 * BSD `rm` both do. It is taken only from folders nobody but root can
 * change (system-program.ts), never from `PATH`, which holds folders the
 * fence leaves writable. Where none is there, nothing is removed and the
 * call throws, since the only other walk is the one that follows links.
 *
 * What needs no walk needs no `rm`: a file, a link or an empty folder is
 * removed straight away, by a call that never follows its last name, so
 * a lock or a claim costs no process.
 */

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, rmdir, unlink } from "node:fs/promises";
import { systemFolders, systemProgram } from "../sandbox/system-program.ts";

/**
 * Where root alone puts an `rm`: the system's profiles on NixOS and
 * nix-darwin, then the base system's own, where a Mac keeps BSD's and
 * another Linux keeps coreutils'.
 */
export function removerFolders(): string[] {
	return [...systemFolders(), "/bin", "/usr/bin"];
}

/**
 * The name `rm` runs under. The system's is often a link into one program
 * for all of coreutils, which picks what to be by the name it is run as,
 * and the found path is that program's own, links followed. `spawn` keeps
 * it; `execFile` drops it, so neither call here goes through that.
 */
const RM_NAME = "rm";

/** The longest an `rm` may take, so a stalled disk can't hold a caller. */
const RM_TIMEOUT_MS = 10 * 60_000;

/** The system's `rm`, or a thrown error saying none could be trusted. */
function systemRm(folders: readonly string[]): string {
	const rm = systemProgram("rm", folders);
	if (rm !== undefined) return rm;
	throw new Error(
		`no rm found where only root can put one (${folders.join(", ")}), ` +
			"so the tree is left in place rather than walked by path",
	);
}

/** The arguments that remove `path` and all under it, never following it. */
function rmArgs(path: string): string[] {
	return ["-rf", "--", path];
}

/** An error's code, when it has one. */
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Removes `path` and everything under it, as `rmSync` with `recursive`
 * and `force` would, but by descriptor. Nothing there is no error.
 */
export function removeTree(
	path: string,
	folders: readonly string[] = removerFolders(),
): void {
	if (removedWithoutWalk(path)) return;
	const run = spawnSync(systemRm(folders), rmArgs(path), {
		argv0: RM_NAME,
		encoding: "utf8",
		stdio: ["ignore", "ignore", "pipe"],
		timeout: RM_TIMEOUT_MS,
	});
	if (run.error) throw run.error;
	if (run.status !== 0) {
		throw new Error(
			`rm couldn't remove ${path}: ${run.stderr.trim() || `exit ${run.status}`}`,
		);
	}
}

/** `removeTree`, off the thread, for a caller that shares it. */
export async function removeTreeOff(
	path: string,
	folders: readonly string[] = removerFolders(),
): Promise<void> {
	if (await removedWithoutWalkOff(path)) return;
	const rm = systemRm(folders);
	const said = await new Promise<string | undefined>((resolve, reject) => {
		const child = spawn(rm, rmArgs(path), {
			argv0: RM_NAME,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: RM_TIMEOUT_MS,
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (status, signal) => {
			if (status === 0) resolve(undefined);
			else resolve(stderr.trim() || `exit ${status ?? signal}`);
		});
	});
	if (said !== undefined) {
		throw new Error(`rm couldn't remove ${path}: ${said}`);
	}
}

/**
 * Whether `path` is gone with no walk: it wasn't there, or it was a file,
 * a link or an empty folder and is removed. Neither call follows the last
 * name, so a link is removed, never what it names. Anything else, a full
 * folder above all, is left for `rm`.
 */
function removedWithoutWalk(path: string): boolean {
	try {
		if (!lstatSync(path).isDirectory()) unlinkSync(path);
		else rmdirSync(path);
		return true;
	} catch (error) {
		// Gone already is done; anything else, rm decides.
		return code(error) === "ENOENT";
	}
}

/** `removedWithoutWalk`, off the thread. */
async function removedWithoutWalkOff(path: string): Promise<boolean> {
	try {
		if (!(await lstat(path)).isDirectory()) await unlink(path);
		else await rmdir(path);
		return true;
	} catch (error) {
		// Gone already is done; anything else, rm decides.
		return code(error) === "ENOENT";
	}
}
