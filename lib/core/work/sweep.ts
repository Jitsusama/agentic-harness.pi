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
 *
 * Every tree it keeps, held or not, gives up its dev shell's Nix roots
 * once nobody has entered it for a while (`dev-shell-roots.ts`): they
 * are a cache direnv rebuilds on the next entry, and left alone they
 * keep their store paths from the collector for as long as the tree
 * stands.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Exec } from "../exec/index.ts";
import { type ProcessFacts, systemFacts } from "../process/index.ts";
import type { HeldTree, TreeProvider } from "./broker.ts";
import { dropIdleDevShellRoots } from "./dev-shell-roots.ts";
import { createGitHistory } from "./history.ts";
import {
	headStillSince,
	resolvedPath as resolved,
	treeStillSince,
	treesInUse,
	type UseSigns,
} from "./in-use.ts";
import type { TreeMemory } from "./memory.ts";
import { orphanedTrees } from "./tidy.ts";
import { pinnedCommit } from "./tree.ts";

/** The provider a git worktree's record names. */
const GIT_WORKTREE = "git-worktree";

/**
 * How old a sweep's lock may be before it is taken over whoever holds
 * it: past any real sweep, so its holder stopped rather than working.
 */
const SWEEP_STALE_MS = 60 * 60 * 1000;

/**
 * How long a tree whose branch trunk doesn't contain, but its remote
 * does, sits with its HEAD still before the sweep takes it. A day, so a
 * session that ended mid-review, or one about to be reopened after a
 * restart, comes back to its tree; past that, a recut at the same
 * branch costs seconds, against the disk the trees held: 48 GiB on one
 * machine on 11 November, with 23% of its disk free.
 */
export const PUSHED_SETTLE_MS = 24 * 60 * 60 * 1000;

/** What a sweep needs. */
export interface SweepDeps extends UseSigns {
	exec: Exec;
	memory: TreeMemory;
	/**
	 * Paths something else says it wants, such as a quest's trees, or how
	 * to ask for them. Asked only once the sweep holds its lock and isn't
	 * resting, since asking can be dear: a quest answers by signing its
	 * whole tree, on a host's shared thread, and sixty conversations'
	 * first sweeps asking at once held a host's thread past its watchdog
	 * on 18 November, though all but one of them then skipped.
	 */
	claims: readonly string[] | (() => readonly string[]);
	/** The file that keeps two sweeps from running at once. */
	lockPath: string;
	/**
	 * How long after any sweep on this machine ends before another runs,
	 * in milliseconds, told by a stamp beside the lock. Without it a sweep
	 * runs whenever the lock is free.
	 */
	restMs?: number;
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
	/** The time now, in milliseconds since the epoch; the clock's own by default. */
	now?: () => number;
}

/** A tree the sweep took back, with the branch it leaves behind. */
export interface SweptTree {
	path: string;
	branch?: string;
	/** The remote-tracking branch that holds its commit, when trunk didn't. */
	remote?: string;
	/** The sessions its record named, so one reopened can recut it. */
	sessions?: string[];
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
	/** Why it did nothing at all, when a sweep ended within the rest. */
	rested?: string;
	taken: SweptTree[];
	/** Git or its provider wouldn't remove it, and it is back where it was. */
	refused: LeftTree[];
	/** Reclaim's rules keep it, or it couldn't be judged. */
	kept: LeftTree[];
	/** Trees whose dev-shell roots went, nobody having entered them. */
	dropped: DroppedRoots[];
}

/** A tree whose dev shell's Nix roots the sweep dropped, and how many. */
export interface DroppedRoots {
	path: string;
	roots: number;
}

/**
 * Take back every git worktree the broker cut whose recorded sessions
 * have all ended and that reclaim's rules would take: clean, and merged
 * into trunk or, detached, at a commit some ref holds or a snapshot
 * still at the commit it was cut at. Then every other
 * provider's unshareable tree whose provider says it is spent, through
 * that provider. Says what it took, what was refused and what it kept,
 * tree by tree.
 */
export async function sweepEndedTrees(deps: SweepDeps): Promise<SweepOutcome> {
	const outcome: SweepOutcome = {
		taken: [],
		refused: [],
		kept: [],
		dropped: [],
	};
	const now = deps.now?.() ?? Date.now();
	const resting = restingSince(deps.lockPath, now, deps.restMs);
	if (resting !== undefined) return { ...outcome, rested: resting };
	const release = sweepLock(deps.lockPath);
	if (typeof release === "string") return { ...outcome, skipped: release };
	try {
		// Asked at once, before any wait, so a conversation that closes
		// while the sweep runs has already said what its quests hold.
		const claims =
			typeof deps.claims === "function" ? deps.claims() : deps.claims;
		const facts = deps.facts ?? systemFacts;
		const inUse = await treesInUse(deps, deps.memory.recall());
		const held = [...(await deps.memory.heldNow(facts)), ...inUse];
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
			...claims,
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
		await dropIdleRoots(deps, outcome);
	} finally {
		markEnded(deps.lockPath, deps.now?.() ?? Date.now());
		release();
	}
	return outcome;
}

/** The stamp beside a sweep's lock that says when the last sweep ended. */
function endedStamp(lockPath: string): string {
	return `${lockPath}.ended`;
}

/**
 * Why a sweep should rest, when one ended within `restMs` of `now`.
 * Every conversation sweeps on its own timer, and one sweep reads every
 * tree: on 18 November about 120 of them kept one machine sweeping
 * without a break, each sweep 3 to 12 minutes long and every one taking
 * nothing, while the rest found the lock held about every 3 seconds.
 */
function restingSince(
	lockPath: string,
	now: number,
	restMs: number | undefined,
): string | undefined {
	if (restMs === undefined) return undefined;
	let ended: number;
	try {
		ended = statSync(endedStamp(lockPath)).mtimeMs;
	} catch {
		// No stamp, or none to read: rest from nothing, as a stamp that
		// couldn't be written does. The lock still keeps sweeps apart.
		return undefined;
	}
	const ago = now - ended;
	// A stamp from the future, as a clock set back leaves, rests nobody.
	return ago >= 0 && ago < restMs
		? `a sweep ended ${Math.round(ago / 1000)} s ago`
		: undefined;
}

/**
 * Stamp that a sweep has just ended, for {@link restingSince}, dated by
 * the sweep's own clock rather than the file system's, so the two
 * readings of the rest are of one clock. Only its time is read, so it
 * holds nothing.
 */
function markEnded(lockPath: string, at: number): void {
	const stamp = endedStamp(lockPath);
	try {
		writeFileSync(stamp, "");
		utimesSync(stamp, at / 1000, at / 1000);
	} catch {
		// A stamp that can't be written only lets the next sweep come
		// sooner, which the lock still keeps from overlapping this one.
	}
}

/**
 * Drop the dev-shell roots of every recorded tree still standing that
 * nobody has entered within the idle window and no process stands in.
 * A process standing in one may hold the shell direnv loaded there.
 */
async function dropIdleRoots(
	deps: SweepDeps,
	outcome: SweepOutcome,
): Promise<void> {
	const now = deps.now?.() ?? Date.now();
	const standing = ((await deps.standingIn?.()) ?? []).map(resolved);
	for (const tree of deps.memory.recall()) {
		const path = resolved(tree.path);
		if (standing.some((one) => one === path || one.startsWith(`${path}/`))) {
			continue;
		}
		const roots = dropIdleDevShellRoots(tree.path, now);
		if (roots > 0) outcome.dropped.push({ path: tree.path, roots });
	}
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
 *
 * A tree that moved within {@link PUSHED_SETTLE_MS} is kept without
 * asking, as a pushed git worktree is: on 13 November a provider called
 * a live World tree spent, clean on its branch, and the sweep took it
 * while the session working there stood in another folder.
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
	const since = (deps.now?.() ?? Date.now()) - PUSHED_SETTLE_MS;
	if (!treeStillSince(tree.path, since)) {
		keep("it moved within the last day, so a session may come back to it");
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

/**
 * The snapshots among `trees` whose HEAD never left the commit they were
 * cut at, by resolved path, with that commit. Only a tree's own record
 * says what it was cut at. Its HEAD's reflog says where HEAD has been:
 * a commit made there and then left, by checking the pin out again, is
 * held by that reflog alone, which the removal deletes, so a tree whose
 * reflog names any other commit, or that has none to read, is left out.
 */
async function neverLeftPins(
	exec: Exec,
	trees: readonly HeldTree[],
): Promise<Map<string, string>> {
	const pins = new Map<string, string>();
	for (const tree of trees) {
		const commit = pinnedCommit(tree.identity);
		if (commit === undefined) continue;
		const reflog = await exec("git", [
			"-C",
			tree.path,
			"reflog",
			"--format=%H",
			"HEAD",
		]);
		const been = reflog.stdout.split("\n").filter((line) => line !== "");
		if (reflog.code !== 0 || been.length === 0) continue;
		if (been.every((line) => line === commit)) {
			pins.set(resolved(tree.path), commit);
		}
	}
	return pins;
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
	const pins = await neverLeftPins(deps.exec, trees);
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
			settled: (path) =>
				headStillSince(path, (deps.now?.() ?? Date.now()) - PUSHED_SETTLE_MS),
			stillPinned: (path, commit) =>
				commit !== undefined && pins.get(path) === commit,
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
		const remote = offered.pushed
			? await remoteHolding(deps.exec, tree.path)
			: undefined;
		await takeBack(
			deps,
			facts,
			main,
			tree,
			{
				path: tree.path,
				...(offered.branch ? { branch: offered.branch } : {}),
				...(remote ? { remote } : {}),
				...(tree.sessions?.length ? { sessions: [...tree.sessions] } : {}),
			},
			outcome,
		);
	}
}

/**
 * The remote-tracking branch holding a tree's commit, for its log line,
 * when trunk doesn't hold it. Read from the refs the tree already has,
 * never fetched: a fetch costs time and fails inside the agent fence.
 */
async function remoteHolding(
	exec: Exec,
	path: string,
): Promise<string | undefined> {
	const found = await exec("git", [
		"-C",
		path,
		"for-each-ref",
		"--count=1",
		"--contains=HEAD",
		"--format=%(refname:short)",
		"refs/remotes",
	]);
	const name = found.stdout.trim();
	return found.code === 0 && name !== "" ? name : undefined;
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
	taken: SweptTree,
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
		outcome.taken.push(taken);
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

/** What git said when it refused, in its own words. */
function said(result: { stdout: string; stderr: string }): string {
	return (result.stderr.trim() || result.stdout.trim()).replace(/^fatal: /, "");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
