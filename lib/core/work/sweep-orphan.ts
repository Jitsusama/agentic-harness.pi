/**
 * Taking the trees whose repository went with finished work, and
 * finishing removals that stopped part way.
 *
 * A worktree of a clone that was deleted keeps only its folder: its
 * commits went with the clone, and git can no longer read it, so there
 * is nothing to remove through git and nothing left to lose. Its
 * `.git` file still names the git folder it was cut from, which is how
 * one is told apart from a tree whose repository stands.
 */

import { randomBytes } from "node:crypto";
import { existsSync, renameSync, type Stats, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { removeTree, removeTreeOff } from "../../internal/files/remove-tree.ts";
import { isLockHeld } from "../internal/file-lock.ts";
import type { ProcessFacts } from "../process/index.ts";
import type { HeldTree } from "./broker.ts";
import { resolvedPath } from "./in-use.ts";
import { readPlain } from "./plain-file.ts";
import type { SweepDeps, SweepOutcome } from "./sweep.ts";

/**
 * The git folder a worktree's `.git` file points at, when that folder
 * is gone, or nothing for a tree whose repository still stands or that
 * isn't a worktree at all.
 */
export function goneGitDir(path: string): string | undefined {
	// No plain `.git` file, as a `.git` folder: no worktree of a lost clone.
	const said = /^gitdir: (.+)$/m.exec(readPlain(join(path, ".git")) ?? "")?.[1];
	if (said === undefined) return undefined;
	const gitDir = resolve(path, said.trim());
	return existsSync(gitDir) ? undefined : gitDir;
}

/**
 * The git folder of the repository a gone worktree folder belonged to,
 * when that still stands: git pruned the tree's entry, as `git worktree
 * prune` does, but kept the repository.
 */
export function standingRepository(gitDir: string): string | undefined {
	const entries = dirname(gitDir);
	if (basename(entries) !== "worktrees") return undefined;
	const repository = dirname(entries);
	return existsSync(repository) ? repository : undefined;
}

/**
 * Take a tree whose repository went with finished work: its commits
 * went with the clone, and git can no longer read it, so only its
 * folder is left. Moved aside under its record's lock, as the sweep
 * takes any tree, then removed.
 */
export async function takeOrphan(
	deps: SweepDeps,
	facts: ProcessFacts,
	tree: HeldTree,
	outcome: SweepOutcome,
): Promise<void> {
	const aside = `${tree.path}.going-${randomBytes(4).toString("hex")}`;
	let moveRefused: string | undefined;
	let forgotten: HeldTree | undefined;
	try {
		forgotten = await deps.memory.whileUnheld(
			tree.path,
			async () => {
				try {
					renameSync(tree.path, aside);
					return true;
				} catch (error) {
					moveRefused = messageOf(error);
					return false;
				}
			},
			facts,
		);
	} catch (error) {
		// Another process holding its record's lock past the wait keeps this
		// tree alone, as it keeps any the sweep takes, rather than end the run.
		if (!isLockHeld(error)) throw error;
		outcome.kept.push({ path: tree.path, why: messageOf(error) });
		return;
	}
	if (forgotten === undefined) {
		if (moveRefused !== undefined) {
			outcome.refused.push({ path: tree.path, why: moveRefused });
		} else {
			outcome.kept.push({ path: tree.path, why: "a session took it up again" });
		}
		return;
	}
	// Its `.git` file is how the next sweep tells a lost clone's tree, and
	// a removal that stops part way may already have taken it.
	const dotGit = readPlain(join(aside, ".git"));
	try {
		removeTree(aside);
		outcome.taken.push({ path: tree.path });
	} catch (error) {
		// Read-only module caches refuse a plain removal. What is left goes
		// back where it was, with its record and its `.git` file, for the
		// next sweep.
		const why = messageOf(error);
		// Something standing at the tree's path by now, even an empty folder
		// a rename would land over, keeps what is left aside.
		if (existsSync(tree.path)) {
			outcome.refused.push({
				path: tree.path,
				why: `${why}; what is left is at ${aside}: its path is taken again`,
			});
			return;
		}
		try {
			renameSync(aside, tree.path);
		} catch (back) {
			outcome.refused.push({
				path: tree.path,
				why: `${why}; what is left is at ${aside}: ${messageOf(back)}`,
			});
			return;
		}
		deps.memory.remember(forgotten);
		outcome.refused.push({
			path: tree.path,
			why: restoreDotGit(tree.path, dotGit, why),
		});
	}
}

/**
 * Writes a put-back tree's `.git` file again if the removal took it,
 * creating it only, so it never follows a link or overwrites a file that
 * appeared meanwhile. The tree is home with its record either way; a
 * failure only adds to what the refusal says.
 */
function restoreDotGit(
	path: string,
	dotGit: string | undefined,
	why: string,
): string {
	if (dotGit === undefined) return why;
	try {
		writeFileSync(join(path, ".git"), dotGit, { flag: "wx" });
		return why;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return why;
		return `${why}; its .git file couldn't be written back: ${messageOf(error)}`;
	}
}

/**
 * How long a folder where the broker cuts trees, named as one but with
 * no `.git` and no record, stands untouched before a sweep finishes its
 * removal. A cut writes `.git` within seconds of making the folder, and
 * a release that stopped part way never comes back to it.
 */
export const STOPPED_REMOVAL_MS = 24 * 60 * 60 * 1000;

/** The names the broker gives the trees it cuts. */
const CUT_NAME = /^(snapshot|worktree)-/;

/**
 * What a sweep names a tree it has moved aside to remove: its name, then
 * this and four random bytes. A branch may hold the word, so only the
 * whole ending counts.
 */
const GOING = ".going-";

/** Whether `name` ends as a take's moved-aside tree is named. */
function setAside(name: string): boolean {
	return /\.going-[0-9a-f]{8}$/.test(name);
}

/**
 * How many stopped removals one sweep finishes, so a backlog goes over
 * several hours rather than holding a host's sweep for one long stretch.
 */
export const STOPPED_REMOVALS_PER_SWEEP = 10;

/**
 * Finish the removals in `dir` that stopped part way, under the sweep's
 * lock, so no take of this machine's runs beside them. A candidate is
 * named as a cut tree, a take's moved-aside one included, and has no
 * `.git`, no record or claim among `known` naming it or a folder in it,
 * and nothing added, removed or written at its top or in its first two
 * levels for {@link STOPPED_REMOVAL_MS}, as a release stopped in `git
 * worktree remove` leaves. A tree a take left aside because git said it
 * holds work keeps its `.git`, and so stays, as does one with a checkout
 * in a folder below its top, as World's trees keep theirs in `src`.
 *
 * Fresh leftovers come before ones set aside earlier, which a removal
 * may already have failed on. Who works in each is read just before it
 * is moved, since the removals before it may take minutes; one a process
 * works in stays and counts nothing against the sweep's number, and a
 * machine that can't say ends the pass. Each is read again on the disk
 * just before it is moved, read and removed without holding the thread,
 * with the idle takes' pause between them.
 */
export async function finishStoppedRemovals(
	deps: SweepDeps,
	dir: string,
	known: readonly string[],
	now: number,
	outcome: SweepOutcome,
): Promise<void> {
	const before = now - STOPPED_REMOVAL_MS;
	let tried = 0;
	for (const path of await candidates(dir)) {
		if (tried >= STOPPED_REMOVALS_PER_SWEEP) return;
		if (!(await stillStopped(path, known, before))) continue;
		// The pause comes first, so only the disk's own recheck stands
		// between the reading and the move.
		if (tried > 0) await deps.betweenIdleTakes?.();
		const busy = await deps.busyAmong?.([resolvedPath(path)]);
		if (busy === undefined) {
			// Blind for this one is blind for the rest.
			outcome.kept.push({
				path,
				why: "a removal stopped part way, but the machine can't say whether something works in it",
			});
			return;
		}
		if (busy.has(resolvedPath(path))) {
			outcome.kept.push({
				path,
				why: "a removal stopped part way, but something works in it",
			});
			continue;
		}
		if (await finish(path, known, before, outcome)) tried += 1;
	}
}

/**
 * The folders in `dir` named as cut trees, those a take set aside last,
 * so one a removal keeps failing on never stands before the rest.
 */
async function candidates(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		// No folder yet means nothing was ever cut, or removed.
		return [];
	}
	const cut = names.filter((name) => CUT_NAME.test(name)).sort();
	return [
		...cut.filter((name) => !setAside(name)),
		...cut.filter(setAside),
	].map((name) => join(dir, name));
}

/**
 * Whether `path` reads as a removal that stopped part way: a plain
 * folder named as a cut tree with no `.git` at its top or in a folder
 * just below, which nothing in `known` names or reaches into, untouched
 * since `before`.
 */
async function stillStopped(
	path: string,
	known: readonly string[],
	before: number,
): Promise<boolean> {
	const resolved = resolvedPath(path);
	return (
		CUT_NAME.test(basename(path)) &&
		(await isPlainFolder(path)) &&
		!(await lstatSafe(join(path, ".git"))) &&
		!known.some(
			(one) =>
				one === resolved ||
				one.startsWith(`${resolved}/`) ||
				resolved.startsWith(`${one}/`),
		) &&
		!(await checkoutBelow(path)) &&
		(await untouchedSince(path, before))
	);
}

/**
 * Whether a folder just below `path` holds a `.git`, as a tree whose
 * checkout sits in `src` does, or can't be read to tell.
 */
async function checkoutBelow(path: string): Promise<boolean> {
	try {
		for (const name of await readdir(path)) {
			if (await lstatSafe(join(path, name, ".git"))) return true;
		}
		return false;
	} catch {
		// Unreadable: kept as if it held one.
		return true;
	}
}

/**
 * Move `path` aside, unless a take already did, and remove it, once it
 * still reads as stopped: a cut may have begun in it since the listing.
 * Whether it tried, rather than finding the folder changed.
 */
async function finish(
	path: string,
	known: readonly string[],
	before: number,
	outcome: SweepOutcome,
): Promise<boolean> {
	if (!(await stillStopped(path, known, before))) {
		outcome.kept.push({
			path,
			why: "a removal seemed stopped, but the folder changed as the sweep came to it",
		});
		return false;
	}
	const aside = setAside(basename(path))
		? path
		: `${path}${GOING}${randomBytes(4).toString("hex")}`;
	try {
		if (aside !== path) renameSync(path, aside);
	} catch (error) {
		outcome.refused.push({ path, why: messageOf(error) });
		return true;
	}
	try {
		await removeTreeOff(aside);
		outcome.taken.push({ path, why: "its removal stopped part way" });
	} catch (error) {
		// Read-only module caches refuse a plain removal; what is left
		// stays aside for the next sweep to try again.
		outcome.refused.push({
			path,
			why: `${messageOf(error)}; what is left is at ${aside}`,
		});
	}
	return true;
}

/**
 * Whether nothing at `path` or in its first `depth` levels changed since
 * `before`. A write deeper down moves no folder's time this reads, but a
 * removal that stopped part way has nothing writing in it at all, and
 * whatever works in a folder is read apart by the busy reading.
 */
async function untouchedSince(
	path: string,
	before: number,
	depth = 2,
): Promise<boolean> {
	try {
		const stat = await lstat(path);
		if (stat.mtimeMs >= before) return false;
		if (depth === 0 || !stat.isDirectory()) return true;
		for (const name of await readdir(path)) {
			if (!(await untouchedSince(join(path, name), before, depth - 1))) {
				return false;
			}
		}
		return true;
	} catch {
		// Changing as it is read: touched.
		return false;
	}
}

/** Whether `path` is a folder, not a link to one. */
async function isPlainFolder(path: string): Promise<boolean> {
	const stat = await lstatSafe(path);
	return stat?.isDirectory() === true && !stat.isSymbolicLink();
}

/** What stands at `path`, without following a link, or nothing. */
async function lstatSafe(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch {
		// Nothing there.
		return undefined;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
