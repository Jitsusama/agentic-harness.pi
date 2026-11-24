/**
 * Taking the trees whose repository went with finished work.
 *
 * A worktree of a clone that was deleted keeps only its folder: its
 * commits went with the clone, and git can no longer read it, so there
 * is nothing to remove through git and nothing left to lose. Its
 * `.git` file still names the git folder it was cut from, which is how
 * one is told apart from a tree whose repository stands.
 */

import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isLockHeld } from "../internal/file-lock.ts";
import type { ProcessFacts } from "../process/index.ts";
import type { HeldTree } from "./broker.ts";
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
		rmSync(aside, { recursive: true, force: true });
		outcome.taken.push({ path: tree.path });
	} catch (error) {
		// Read-only module caches refuse a plain removal. What is left goes
		// back where it was, with its record and its `.git` file, for the
		// next sweep.
		const why = messageOf(error);
		try {
			renameSync(aside, tree.path);
			const home = join(tree.path, ".git");
			if (dotGit !== undefined && !existsSync(home))
				writeFileSync(home, dotGit);
			deps.memory.remember(forgotten);
			outcome.refused.push({ path: tree.path, why });
		} catch (back) {
			outcome.refused.push({
				path: tree.path,
				why: `${why}; what is left is at ${aside}: ${messageOf(back)}`,
			});
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
