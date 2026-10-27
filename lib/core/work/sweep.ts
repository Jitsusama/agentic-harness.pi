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
 *
 * A tree another provider cut, such as a World dev tree, goes through
 * that provider, and only once it says nothing would be lost.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Exec } from "../exec/index.ts";
import { type ProcessFacts, systemFacts } from "../process/index.ts";
import type { HeldTree, TreeProvider } from "./broker.ts";
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
	/**
	 * Whether a repository that is gone went with work that has finished,
	 * named by the git folder a tree's `.git` file points at, so a tree
	 * left from it may go too. Without it, every such tree is kept.
	 */
	wentWithFinishedWork?(gitDir: string): boolean;
	/**
	 * The providers loaded, for trees a provider other than git cut,
	 * which go through that provider's own release. Without it, or for a
	 * provider that can't say whether a tree is spent, every one is kept.
	 */
	providers?(): readonly TreeProvider[];
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
	/** Git or its provider wouldn't remove it, and it is back where it was. */
	refused: LeftTree[];
	/** Reclaim's rules keep it, or it couldn't be judged. */
	kept: LeftTree[];
}

/**
 * Take back every git worktree the broker cut whose recorded sessions
 * have all ended and that reclaim's rules would take: clean, and merged
 * into trunk or, detached, at a commit some ref holds. Then every other
 * provider's unshareable tree whose provider says it is spent, through
 * that provider. Says what it took, what was refused and what it kept,
 * tree by tree.
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
		const repositories = await byRepository(deps, ended, outcome);
		for (const tree of repositories.orphans) {
			await takeOrphan(deps, facts, tree, outcome);
		}
		for (const [main, trees] of repositories.byMain) {
			await sweepRepository(deps, facts, main, trees, {
				remembered,
				unattributed: [...unattributed].map(resolved),
				outcome,
			});
		}
		const others = deps.memory
			.recall()
			.filter(
				(tree) => tree.providerId !== GIT_WORKTREE && !heldPaths.has(tree.path),
			);
		for (const tree of others) {
			await releaseThroughProvider(deps, facts, tree, remembered, outcome);
		}
	} finally {
		release();
	}
	return outcome;
}

/**
 * Each repository's main checkout, with its ended trees, and the trees
 * whose repository went with finished work.
 */
async function byRepository(
	deps: SweepDeps,
	trees: readonly HeldTree[],
	outcome: SweepOutcome,
): Promise<{ byMain: Map<string, HeldTree[]>; orphans: HeldTree[] }> {
	const repositories = new Map<string, HeldTree[]>();
	const orphans: HeldTree[] = [];
	for (const tree of trees) {
		const common = await deps.exec("git", [
			"-C",
			tree.path,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (common.code !== 0) {
			const gitDir = goneGitDir(tree.path);
			if (gitDir !== undefined && deps.wentWithFinishedWork?.(gitDir)) {
				orphans.push(tree);
			} else {
				outcome.kept.push({ path: tree.path, why: "its repository is gone" });
			}
			continue;
		}
		const dir = common.stdout.trim();
		const main = basename(dir) === ".git" ? dirname(dir) : dir;
		repositories.set(main, [...(repositories.get(main) ?? []), tree]);
	}
	return { byMain: repositories, orphans };
}

/**
 * Take a tree another provider cut, through that provider, once it says
 * nothing would be lost.
 *
 * Such a tree can't be moved aside first: its provider finds it by
 * where it stands, and may have more to undo than the folder, as World
 * resets a tree's processes and datastores. So instead this session
 * becomes its only holder under the record's lock, which makes the
 * broker hand it to nobody else, and the removal runs after. A
 * shareable tree is never taken that way, since another session may
 * join one whoever holds it.
 */
async function releaseThroughProvider(
	deps: SweepDeps,
	facts: ProcessFacts,
	tree: HeldTree,
	remembered: readonly string[],
	outcome: SweepOutcome,
): Promise<void> {
	const keep = (why: string): void => {
		outcome.kept.push({ path: tree.path, why });
	};
	if (covered(resolved(tree.path), remembered)) {
		keep("something still holds it");
		return;
	}
	if (tree.identity.shareable) {
		keep("it is shareable, so a session could join it while it is removed");
		return;
	}
	const provider = deps.providers?.().find((one) => one.id === tree.providerId);
	if (provider?.whyKept === undefined) {
		keep(`${tree.providerId} can't say whether it is spent`);
		return;
	}
	let why: string | undefined;
	try {
		why = await provider.whyKept(tree);
	} catch (error) {
		why = `${tree.providerId} couldn't judge it: ${messageOf(error)}`;
	}
	if (why !== undefined) {
		keep(why);
		return;
	}
	const before = await deps.memory.holdWhileUnheld(tree.path, facts);
	if (before === undefined) {
		keep("a session took it up again");
		return;
	}
	try {
		await provider.release(tree);
		deps.memory.forget(tree.path);
		outcome.taken.push({ path: tree.path });
	} catch (error) {
		// Whatever the provider left stands where it was, and goes back to
		// the sessions that held it, for the next sweep to judge again.
		deps.memory.remember(before);
		outcome.refused.push({ path: tree.path, why: messageOf(error) });
	}
}

/**
 * Whether a path is one something wants, or inside or around one: a
 * claim may name a tree's checkout where its record names the folder
 * holding it.
 */
function covered(path: string, wanted: readonly string[]): boolean {
	return wanted.some(
		(one) =>
			one === path || one.startsWith(`${path}/`) || path.startsWith(`${one}/`),
	);
}

/**
 * The git folder a worktree's `.git` file points at, when that folder
 * is gone, or nothing for a tree whose repository still stands or that
 * isn't a worktree at all.
 */
function goneGitDir(path: string): string | undefined {
	try {
		const said = /^gitdir: (.+)$/m.exec(
			readFileSync(join(path, ".git"), "utf8"),
		)?.[1];
		if (said === undefined) return undefined;
		const gitDir = resolve(path, said.trim());
		return existsSync(gitDir) ? undefined : gitDir;
	} catch {
		// No `.git` file, or a `.git` folder: not a worktree of a lost clone.
		return undefined;
	}
}

/**
 * Take a tree whose repository went with finished work: its commits
 * went with the clone, and git can no longer read it, so only its
 * folder is left. Moved aside under its record's lock, as
 * {@link takeBack} does, then removed.
 */
async function takeOrphan(
	deps: SweepDeps,
	facts: ProcessFacts,
	tree: HeldTree,
	outcome: SweepOutcome,
): Promise<void> {
	const aside = `${tree.path}.going-${randomBytes(4).toString("hex")}`;
	let moveRefused: string | undefined;
	const forgotten = await deps.memory.whileUnheld(
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
	if (forgotten === undefined) {
		if (moveRefused !== undefined) {
			outcome.refused.push({ path: tree.path, why: moveRefused });
		} else {
			outcome.kept.push({ path: tree.path, why: "a session took it up again" });
		}
		return;
	}
	try {
		rmSync(aside, { recursive: true, force: true });
		outcome.taken.push({ path: tree.path });
	} catch (error) {
		// Read-only module caches refuse a plain removal. What is left goes
		// back where it was, with its record, for the next sweep.
		const why = messageOf(error);
		try {
			renameSync(aside, tree.path);
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
