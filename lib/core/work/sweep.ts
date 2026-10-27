/**
 * Taking back the trees whose sessions have all ended, without asking.
 *
 * `reclaim` takes back what nothing owns, but only when somebody runs
 * it in the right checkout, and nobody does: on 26 October one machine
 * held 185 git worktrees whose every recorded session had ended, 48 of
 * them (5.6 GiB) ones reclaim would have taken. A tree's owner ending
 * is the moment it is spent, so this runs reclaim's own rules over
 * every repository the broker has cut in, for the trees whose records
 * say every holder has gone.
 *
 * It is narrower than reclaim on purpose. A worktree the broker has no
 * record of may be anybody's, and a record that names nobody can't say
 * it is spent, so neither is touched. A branch is never deleted: the
 * commits stay where they were, and cutting the tree again at the same
 * branch puts a session back where it left off.
 *
 * A session can take a spent tree up again at any moment, so the last
 * look happens under the record's own lock, where that session writes
 * its claim. The lock is meant for milliseconds, so under it the tree
 * is only moved aside and its record forgotten; the removal, which for
 * a tree with a build in it takes seconds, runs after. A session that
 * then asks for the tree finds no record and no folder, and cuts afresh.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import type { Exec } from "../exec/index.ts";
import { type ProcessFacts, systemFacts } from "../process/index.ts";
import type { HeldTree } from "./broker.ts";
import { createGitHistory } from "./history.ts";
import type { TreeMemory } from "./memory.ts";
import { orphanedTrees } from "./tidy.ts";

/** The provider a git worktree's record names. */
const GIT_WORKTREE = "git-worktree";

/**
 * How old a sweep's lock may be before it is taken over whoever holds
 * it: past any real sweep, so its holder stopped rather than working.
 */
const SWEEP_STALE_MS = 60 * 60 * 1000;

/** What a sweep needs. */
export interface SweepDeps {
	exec: Exec;
	memory: TreeMemory;
	/** Paths something else says it wants, such as a quest's trees. */
	claims: readonly string[];
	/** The file that keeps two sweeps from running at once. */
	lockPath: string;
	facts?: ProcessFacts;
}

/** A tree the sweep took back, with the branch it leaves behind. */
export interface SweptTree {
	path: string;
	branch?: string;
}

/** A tree the sweep left, and why. */
export interface LeftTree {
	path: string;
	why: string;
}

/** What one sweep did. */
export interface SweepOutcome {
	/** Why it did nothing at all, when another sweep was running. */
	skipped?: string;
	taken: SweptTree[];
	/** Git wouldn't remove it, and it is back where it was. */
	refused: LeftTree[];
	/** Reclaim's rules keep it, or it couldn't be judged. */
	kept: LeftTree[];
}

/**
 * Take back every git worktree the broker cut whose recorded sessions
 * have all ended and that reclaim's rules would take: clean, and merged
 * into trunk or, detached, at a commit some ref holds. Says what it
 * took, what git refused and what it kept, tree by tree.
 */
export async function sweepEndedTrees(deps: SweepDeps): Promise<SweepOutcome> {
	const outcome: SweepOutcome = { taken: [], refused: [], kept: [] };
	const release = sweepLock(deps.lockPath);
	if (typeof release === "string") return { ...outcome, skipped: release };
	try {
		const facts = deps.facts ?? systemFacts;
		const held = await deps.memory.heldNow(facts);
		const heldPaths = new Set(held.map((tree) => tree.path));
		const ended = deps.memory
			.recall()
			.filter(
				(tree) => tree.providerId === GIT_WORKTREE && !heldPaths.has(tree.path),
			);
		const unattributed = new Set(
			deps.memory.unattributed().map((tree) => tree.path),
		);
		const remembered = [
			...held
				.filter((tree) => !unattributed.has(tree.path))
				.map((tree) => tree.path),
			...deps.claims,
		].map(resolved);
		for (const [main, trees] of await byRepository(deps.exec, ended, outcome)) {
			await sweepRepository(deps, facts, main, trees, {
				remembered,
				unattributed: [...unattributed].map(resolved),
				outcome,
			});
		}
	} finally {
		release();
	}
	return outcome;
}

/** Each repository's main checkout, with its ended trees. */
async function byRepository(
	exec: Exec,
	trees: readonly HeldTree[],
	outcome: SweepOutcome,
): Promise<Map<string, HeldTree[]>> {
	const repositories = new Map<string, HeldTree[]>();
	for (const tree of trees) {
		const common = await exec("git", [
			"-C",
			tree.path,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (common.code !== 0) {
			outcome.kept.push({ path: tree.path, why: "its repository is gone" });
			continue;
		}
		const dir = common.stdout.trim();
		const main = basename(dir) === ".git" ? dirname(dir) : dir;
		repositories.set(main, [...(repositories.get(main) ?? []), tree]);
	}
	return repositories;
}

/** Reclaim's rules over one repository's ended trees, and acting on them. */
async function sweepRepository(
	deps: SweepDeps,
	facts: ProcessFacts,
	main: string,
	trees: readonly HeldTree[],
	held: {
		remembered: readonly string[];
		unattributed: readonly string[];
		outcome: SweepOutcome;
	},
): Promise<void> {
	const { outcome } = held;
	let plan: ReturnType<typeof orphanedTrees>;
	try {
		const trunk = await trunkOf(deps.exec, main);
		const worktrees = await createGitHistory({ exec: deps.exec }).worktrees(
			main,
			trunk,
		);
		plan = orphanedTrees({
			mainPath: resolved(main),
			worktrees: worktrees.map((tree) => ({
				...tree,
				path: resolved(tree.path),
			})),
			remembered: held.remembered,
			unattributed: held.unattributed,
		});
	} catch (error) {
		for (const tree of trees) {
			outcome.kept.push({ path: tree.path, why: messageOf(error) });
		}
		return;
	}
	for (const tree of trees) {
		const path = resolved(tree.path);
		const offered = plan.reclaimable.find((one) => one.path === path);
		if (offered === undefined) {
			const retained = plan.retained.find((one) => one.path === path);
			outcome.kept.push({
				path: tree.path,
				why: retained?.why ?? "git doesn't list it as a worktree",
			});
			continue;
		}
		await takeBack(deps, facts, main, tree, offered.branch, outcome);
	}
}

/**
 * Move a tree aside under its record's lock, then remove it. A removal
 * git refuses puts the tree and its record back as they were.
 */
async function takeBack(
	deps: SweepDeps,
	facts: ProcessFacts,
	main: string,
	tree: HeldTree,
	branch: string | undefined,
	outcome: SweepOutcome,
): Promise<void> {
	const aside = `${tree.path}.going-${randomBytes(4).toString("hex")}`;
	const git = (...args: string[]) => deps.exec("git", ["-C", main, ...args]);
	let moveRefused: string | undefined;
	const forgotten = await deps.memory.whileUnheld(
		tree.path,
		async () => {
			const moved = await git("worktree", "move", tree.path, aside);
			if (moved.code !== 0) moveRefused = said(moved);
			return moved.code === 0;
		},
		facts,
	);
	if (forgotten === undefined) {
		if (moveRefused !== undefined) {
			outcome.refused.push({ path: tree.path, why: moveRefused });
		} else {
			outcome.kept.push({
				path: tree.path,
				why: "a session took it up again",
			});
		}
		return;
	}
	const removed = await git("worktree", "remove", aside);
	if (removed.code === 0) {
		outcome.taken.push({ path: tree.path, ...(branch ? { branch } : {}) });
		return;
	}
	const back = await git("worktree", "move", aside, tree.path);
	if (back.code === 0) deps.memory.remember(forgotten);
	outcome.refused.push({
		path: tree.path,
		why:
			back.code === 0
				? said(removed)
				: `${said(removed)}; it is left at ${aside}: ${said(back)}`,
	});
}

/** The branch trunk is, as the remote names it, else main. */
async function trunkOf(exec: Exec, main: string): Promise<string> {
	const head = await exec("git", [
		"-C",
		main,
		"symbolic-ref",
		"-q",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	if (head.code === 0 && head.stdout.trim() !== "") return head.stdout.trim();
	const remote = await exec("git", [
		"-C",
		main,
		"rev-parse",
		"-q",
		"--verify",
		"refs/remotes/origin/main",
	]);
	return remote.code === 0 ? "origin/main" : "main";
}

/**
 * Hold the sweep's lock, answering how to let it go, or why another
 * sweep has it. A lock whose holder has ended, or that has stood past
 * {@link SWEEP_STALE_MS}, is moved aside and taken over. Unlike the
 * record locks this never waits: a second sweep has nothing to add.
 */
function sweepLock(lockPath: string): (() => void) | string {
	for (let tries = 0; tries < 2; tries += 1) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			return () => {
				// Only our own lock: one taken over from us is its new holder's.
				if (holderOf(lockPath) === process.pid)
					rmSync(lockPath, { force: true });
			};
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		const holder = holderOf(lockPath);
		if (holder !== undefined && isAlive(holder) && !isStale(lockPath)) {
			return `another sweep is running, pid ${holder}`;
		}
		const stale = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
		try {
			renameSync(lockPath, stale);
			rmSync(stale, { force: true });
		} catch (error) {
			// Somebody else moved it first, which is theirs to hold now.
			if (!hasCode(error, "ENOENT")) throw error;
		}
	}
	return "another sweep took the lock as this one did";
}

function holderOf(lockPath: string): number | undefined {
	try {
		const pid = Number(readFileSync(lockPath, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		// Gone or half-written: nobody this can name holds it.
		return undefined;
	}
}

function isStale(lockPath: string): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs > SWEEP_STALE_MS;
	} catch {
		// Gone since it was read, so nothing stands in the way.
		return true;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return hasCode(error, "EPERM");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

/** A path with its links resolved, as git reports one. */
function resolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Gone from disk: its own name is still the best one for it.
		return path;
	}
}

/** What git said when it refused, in its own words. */
function said(result: { stdout: string; stderr: string }): string {
	return (result.stderr.trim() || result.stdout.trim()).replace(/^fatal: /, "");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
