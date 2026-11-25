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
 * mid-walk removes the link, never what it names. GNU coreutils' and the
 * Mac's BSD `rm` both do, and they are the ones a machine pi runs on
 * keeps where root alone puts programs; busybox's walks by path, so a
 * system whose own `rm` is busybox's gets no more than Node gives. It is
 * taken only from folders nobody but root can change (system-program.ts),
 * never from `PATH`, which holds folders the fence leaves writable. Where
 * none is there, nothing is removed and the call throws, since the only
 * other walk is the one that follows links.
 *
 * The promise is for the tree, not the way to it: `rm` looks up the
 * folders above the one it removes by path, as every call does. A caller
 * whose path runs through a folder a fenced command can write holds that
 * folder itself, or removes only what lies directly in one pi made.
 *
 * A tree with read-only folders, as Go's module cache makes, refuses
 * `rm`; the system's `chmod` then makes its folders writable by their
 * owner, walking by descriptor and passing links by as `rm` does, and
 * `rm` goes again.
 *
 * What needs no walk needs no `rm`: a file, a link or an empty folder is
 * removed straight away, by a call that never follows its last name, so
 * a lock or a claim costs no process.
 */

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";
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
 * The system's `rm` as a shell runs it: by the name it has in the first
 * of `folders` that holds one root alone keeps, links unfollowed, so a
 * program for all of coreutils still runs as `rm`; nothing where none
 * is kept so.
 */
export function systemRmCommand(
	folders: readonly string[] = removerFolders(),
): string | undefined {
	const kept = folders.find((folder) => systemProgram("rm", [folder]));
	return kept === undefined ? undefined : posix.join(kept, "rm");
}

/** The longest an `rm` may take, so a stalled disk can't hold a caller. */
const RM_TIMEOUT_MS = 10 * 60_000;

/** How many of `rm`'s lines an error keeps; the rest are counted. */
const LINES_KEPT = 3;

/** One program a removal runs: its path and the name it runs under. */
interface Program {
	readonly path: string;
	readonly name: string;
}

/**
 * The system's `name`, or a thrown error saying none could be trusted.
 * The system's is often a link into one program for all of coreutils,
 * which picks what to be by the name it is run as, and the found path is
 * that program's own, links followed. `spawn` keeps the name as
 * `argv0`; `execFile` drops it, so neither call here goes through that.
 */
function systemTool(name: string, folders: readonly string[]): Program {
	const path = systemProgram(name, folders);
	if (path !== undefined) return { path, name };
	throw new Error(
		`no ${name} found where only root can put one (${folders.join(", ")}), ` +
			"so the tree is left in place rather than walked by path",
	);
}

/** The arguments that remove `path` and all under it, never following it. */
function rmArgs(path: string): string[] {
	return ["-rf", "--", path];
}

/**
 * The arguments that make every folder in `path` writable by its owner,
 * links passed by, both under it and as `path` itself.
 */
function writableArgs(path: string): string[] {
	return ["-R", "-h", "u+w", "--", path];
}

/** An error's code, when it has one. */
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * `path` with no separator at its end, save the root's own: a trailing
 * one makes every call follow a link it ends at, `rm` included.
 */
function untrailed(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" ? path : trimmed;
}

/**
 * What `rm` said, its first lines kept and the rest counted: a tree of
 * read-only folders has it name every file it couldn't take.
 */
export function firstLines(said: string): string {
	const lines = said.trim().split("\n").filter(Boolean);
	const kept = lines.slice(0, LINES_KEPT).join("; ");
	const more = lines.length - LINES_KEPT;
	return more > 0 ? `${kept}; and ${more} more` : kept;
}

/** Why a run that ended with `status` or `signal` removed nothing more. */
function failure(
	stderr: string,
	status: number | null,
	signal: string | null,
): string {
	if (signal === "SIGTERM") return "timed out after 10 min, part removed";
	return firstLines(stderr) || `exit ${status ?? signal}`;
}

/** One synchronous run of `program`: undefined when it did all, else why. */
function runSync(program: Program, args: string[]): string | undefined {
	const run = spawnSync(program.path, args, {
		argv0: program.name,
		encoding: "utf8",
		maxBuffer: Number.POSITIVE_INFINITY,
		stdio: ["ignore", "ignore", "pipe"],
		timeout: RM_TIMEOUT_MS,
	});
	if (run.error) {
		if (code(run.error) === "ETIMEDOUT") {
			return "timed out after 10 min, part removed";
		}
		return run.error.message;
	}
	if (run.status === 0) return undefined;
	return failure(run.stderr, run.status, run.signal);
}

/** `runSync`, off the thread. */
function runOff(program: Program, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn(program.path, args, {
			argv0: program.name,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: RM_TIMEOUT_MS,
		});
		// Only the first lines are told, so only they are kept.
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 4096) stderr += chunk;
		});
		child.once("error", (error) => resolve(error.message));
		child.once("close", (status, signal) => {
			resolve(status === 0 ? undefined : failure(stderr, status, signal));
		});
	});
}

/**
 * Removes `path` and everything under it, as `rmSync` with `recursive`
 * and `force` would, but by descriptor. Nothing there is no error.
 */
export function removeTree(
	path: string,
	folders: readonly string[] = removerFolders(),
): void {
	const at = untrailed(path);
	if (removedWithoutWalk(at)) return;
	const rm = systemTool("rm", folders);
	if (runSync(rm, rmArgs(at)) === undefined) return;
	runSync(systemTool("chmod", folders), writableArgs(at));
	const said = runSync(rm, rmArgs(at));
	if (said !== undefined) throw new Error(`rm couldn't remove ${at}: ${said}`);
}

/** `removeTree`, off the thread, for a caller that shares it. */
export async function removeTreeOff(
	path: string,
	folders: readonly string[] = removerFolders(),
): Promise<void> {
	const at = untrailed(path);
	if (await removedWithoutWalkOff(at)) return;
	const rm = systemTool("rm", folders);
	if ((await runOff(rm, rmArgs(at))) === undefined) return;
	await runOff(systemTool("chmod", folders), writableArgs(at));
	const said = await runOff(rm, rmArgs(at));
	if (said !== undefined) throw new Error(`rm couldn't remove ${at}: ${said}`);
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
