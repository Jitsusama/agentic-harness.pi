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
 * it is spent, so neither is touched. A tree's branch stays, so cutting
 * the tree again at the same branch puts a session back where it left
 * off, unless origin's trunk holds every commit on it: then there is
 * nothing to come back to, and it goes with its config section, as it
 * does when a tree is released (`merged-branch.ts`).
 *
 * A branch whose tree went before its pull request merged is left by
 * that, so each checkout the records name is also searched for
 * branches trunk holds that nobody has moved for
 * {@link PUSHED_SETTLE_MS}, which go the same way (`sweep-branches.ts`).
 *
 * A session can take a spent tree up again at any moment, so the last
 * look happens under the record's own lock, where that session writes
 * its claim. The lock is meant for milliseconds, so under it the tree
 * is only moved aside and its record forgotten; the removal, which for
 * a tree with a build in it takes seconds, runs after. A session that
 * then asks for the tree finds no record and no folder, and cuts afresh.
 *
 * A tree another provider cut, such as a World dev tree, goes through
 * that provider, and only once it says nothing would be lost. One whose
 * clone was deleted keeps only its folder, which goes as it is
 * (`sweep-orphan.ts`). One sweep runs at a time (`sweep-lock.ts`).
 *
 * A snapshot a live session holds goes too, once nothing has used it
 * for hours and it is as it was cut (`sweep-idle.ts`): a session asking
 * for it again gets it cut afresh.
 *
 * Every tree it keeps, held or not, gives up its dev shell's Nix roots
 * once nobody has entered it for a while (`dev-shell-roots.ts`): they
 * are a cache direnv rebuilds on the next entry, and left alone they
 * keep their store paths from the collector for as long as the tree
 * stands.
 *
 * Long because the steps left here share one lock, one reading of the
 * records and one outcome: each step that stands alone already lives
 * beside it, and splitting the rest would pass all three through every
 * call.
 */

import { randomBytes } from "node:crypto";
import type { Exec } from "../exec/index.ts";
import { isLockHeld } from "../internal/file-lock.ts";
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
import { dropMergedBranch, type WentBranch } from "./merged-branch.ts";
import { dropSettledBranches } from "./sweep-branches.ts";
import {
	checkoutOf,
	eachIdleSnapshot,
	type IdleSnapshot,
	lastUsed,
	mainCheckoutOf,
} from "./sweep-idle.ts";
import { type LockFresh, sweepLock } from "./sweep-lock.ts";
import { goneGitDir, standingRepository, takeOrphan } from "./sweep-orphan.ts";
import { markEnded, restingSince } from "./sweep-rest.ts";
import { orphanedTrees } from "./tidy.ts";
import { pinnedCommit } from "./tree.ts";

/** The provider a git worktree's record names. */
const GIT_WORKTREE = "git-worktree";

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
	 * Paths something else says it wants, such as a quest's trees, held
	 * for good or only until spent, or how to ask for them, which may be
	 * waited on. Asked only once the sweep holds its lock and isn't
	 * resting, since asking can be dear: a quest answered by signing its
	 * whole tree on a host's shared thread, and sixty conversations'
	 * first sweeps asking at once held a host's thread past its watchdog
	 * on 18 November, though all but one of them then skipped.
	 */
	claims: SweepClaims | (() => SweepClaims | Promise<SweepClaims>);
	/** The file that keeps two sweeps from running at once. */
	lockPath: string;
	/**
	 * How often, and for how long, a running sweep touches its lock; every
	 * minute for five awake hours by default.
	 */
	lockFresh?: LockFresh;
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
	/**
	 * How many snapshots a live session holds and nothing has used for
	 * hours one sweep may take; `IDLE_TAKES_PER_SWEEP` by default, which
	 * keeps a sweep on a host's thread short.
	 */
	idleTakes?: number;
	/**
	 * How long after it reaches those snapshots, in milliseconds of awake
	 * time, a sweep may go on judging them past the `IDLE_TAKES_PER_SWEEP`
	 * a host takes, so a loaded machine, where each is slow, gets fewer
	 * rather than a longer sweep; no limit by default. The ended trees
	 * judged before them, which can take most of an hour, don't count.
	 * It stops new judging only: a judgement or take begun runs to its
	 * end, each git call within its own limit, so the bound is soft by as
	 * long as one of those takes.
	 */
	idleWithinMs?: number;
	/**
	 * Milliseconds on a clock that stands still while the machine sleeps,
	 * as the sweep lock's freshness counts, so a suspend or a clock set
	 * back neither spends `idleWithinMs` nor stretches it;
	 * `performance.now` by default.
	 */
	awake?: () => number;
	/**
	 * Waited on before each idle snapshot's take but the first, so a sweep
	 * taking many leaves the disk's directory locks free between its
	 * removals; nothing by default. Its time counts against `idleWithinMs`.
	 */
	betweenIdleTakes?: () => Promise<void>;
	/** The time now, in milliseconds since the epoch; the clock's own by default. */
	now?: () => number;
}

/**
 * What holders claim: paths held for good, or those and the paths held
 * only while they are still work, which reclaim's rules may take once
 * nothing else holds them, as `orphanedTrees` says under `spendable`.
 */
export type SweepClaims =
	| readonly string[]
	| { held: readonly string[]; untilSpent: readonly string[] };

/** A tree the sweep took back, with the branch it leaves behind. */
export interface SweptTree {
	path: string;
	branch?: string;
	/** Set when its branch went too, origin's trunk holding all of it. */
	branchGone?: true;
	/** The remote-tracking branch that holds its commit, when trunk didn't. */
	remote?: string;
	/** The sessions its record named, so one reopened can recut it. */
	sessions?: string[];
	/** The commit a snapshot taken from a live session was pinned at. */
	commit?: string;
	/** Why a tree a live session held was taken. */
	why?: string;
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
	/**
	 * Checkouts whose branches with no tree went, origin's trunk holding
	 * them and nobody having moved them for a day, and which.
	 */
	branches: DroppedBranches[];
	/**
	 * Why the snapshots open sessions hold went unjudged this sweep, those
	 * not yet taken kept: the machine unable to say which processes hold
	 * trees, a judgement throwing as it chose, or a take failing, such as
	 * on a records folder that refuses writes. One whose record's lock a
	 * live writer holds too long is kept alone, under `kept`, and the rest
	 * go on.
	 */
	idleUnjudged?: string;
	/**
	 * How many aged snapshots nothing was seen working in it left
	 * unjudged, when its count or `idleWithinMs` stopped it with some left.
	 */
	idleLeft?: number;
	/**
	 * How long, in milliseconds of awake time, judging and taking those
	 * snapshots took, so a slow run's idle phase can be told from the rest:
	 * the census of processes, the pauses and the dating of every live
	 * snapshot included, so not quite none even when none was old enough to
	 * judge. Unset when the sweep never reached the idle phase. Awake time
	 * stops while the machine sleeps, so it can't be taken from a
	 * wall-clock span to time the rest.
	 */
	idleMs?: number;
}

/**
 * A checkout whose settled, merged branches the sweep dropped, each with
 * the commit it pointed at, so `git branch <name> <commit>` puts one
 * back.
 */
export interface DroppedBranches {
	checkout: string;
	went: WentBranch[];
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
		branches: [],
	};
	const now = deps.now?.() ?? Date.now();
	const awake = deps.awake ?? (() => performance.now());
	const resting = restingSince(deps.lockPath, now, deps.restMs);
	if (resting !== undefined) return { ...outcome, rested: resting };
	const release = sweepLock(deps.lockPath, deps.lockFresh);
	if (typeof release === "string") return { ...outcome, skipped: release };
	try {
		// Asked at once, before any wait, so a conversation that closes
		// while the sweep runs has already said what its quests hold.
		const asked =
			typeof deps.claims === "function" ? await deps.claims() : deps.claims;
		const claims = "held" in asked ? asked.held : asked;
		const untilSpent = "held" in asked ? asked.untilSpent : [];
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
		const spendable = untilSpent.map(resolved);
		const repositories = await byRepository(deps, ended, outcome);
		for (const tree of repositories.orphans) {
			await takeOrphan(deps, facts, tree, outcome);
		}
		for (const [main, trees] of repositories.byMain) {
			await sweepRepository(deps, facts, main, trees, {
				remembered,
				spendable,
				unattributed: [...unattributed].map(resolved),
				outcome,
			});
		}
		await dropSettledBranches(
			deps,
			[...repositories.byMain.keys()],
			held.filter((tree) => tree.providerId === GIT_WORKTREE),
			now - PUSHED_SETTLE_MS,
			outcome,
		);
		const live = [...new Map(held.map((tree) => [tree.path, tree])).values()];
		const { idleWithinMs } = deps;
		// Read as the idle phase begins, not as the run does: the ended trees
		// before it can spend the whole bound, leaving only a host's share.
		const began = awake();
		const spent = () =>
			idleWithinMs !== undefined && awake() - began >= idleWithinMs;
		try {
			const askedAt = (path: string, key?: string) =>
				deps.memory.askedAt(path, key);
			// A snapshot a quest claims stays, spent or not, as its session
			// stands open and may come back to it.
			const choice = {
				...deps,
				claims: [...claims, ...untilSpent],
				now,
				askedAt,
				...(deps.idleTakes === undefined ? {} : { most: deps.idleTakes }),
				spent,
				left: (count: number) => {
					outcome.idleLeft = count;
				},
			};
			// Each is taken before the next is judged, so the time judging
			// takes always buys takes.
			let before = false;
			for await (const idle of eachIdleSnapshot(live, choice)) {
				if (before) await deps.betweenIdleTakes?.();
				before = true;
				try {
					await takeIdle(deps, facts, idle, now, outcome);
				} catch (error) {
					// One record's lock held too long keeps that snapshot alone:
					// ending a run of hundreds there would cost the outside stamp
					// and send the hosts back to sweeping on their own threads.
					// Any other failure, which every take may meet or which may
					// leave a tree moved aside, ends the run unjudged, so the run
					// says so and leaves no stamp.
					if (!isLockHeld(error)) throw error;
					outcome.kept.push({ path: idle.tree.path, why: messageOf(error) });
				}
			}
		} catch (error) {
			// A census or a take failing leaves the other providers' trees
			// and the dev shells' roots to go as before.
			outcome.idleUnjudged = messageOf(error);
		}
		outcome.idleMs = Math.round(awake() - began);
		const others = deps.memory
			.recall()
			.filter(
				(tree) => tree.providerId !== GIT_WORKTREE && !heldPaths.has(tree.path),
			);
		for (const tree of others) {
			// Other providers' rules know nothing of a quest's claim, so it
			// holds their trees for good.
			await releaseThroughProvider(
				deps,
				facts,
				tree,
				[...remembered, ...spendable],
				outcome,
			);
		}
		await dropIdleRoots(deps, outcome);
	} finally {
		markEnded(deps.lockPath, deps.now?.() ?? Date.now());
		release();
	}
	return outcome;
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
		const found = await checkoutOf(deps.exec, tree.path);
		if ("unread" in found) {
			const gitDir = goneGitDir(tree.path);
			if (gitDir !== undefined && deps.wentWithFinishedWork?.(gitDir)) {
				orphans.push(tree);
			} else {
				outcome.kept.push({
					path: tree.path,
					why: unreadWhy(found.unread, gitDir),
				});
			}
			continue;
		}
		const { main } = found;
		repositories.set(main, [...(repositories.get(main) ?? []), tree]);
	}
	return { byMain: repositories, orphans };
}

/**
 * Why a tree whose repository git couldn't name is kept. Its repository
 * is gone only when the git folder its `.git` file names, `goneGitDir`,
 * is gone along with the repository holding it: pi's git refuses such a
 * tree too, as no worktree names it back, so the code git answered can't
 * say. A pruned entry in a standing repository is told apart. Where the
 * folder stands, a refusal, as in a tree whose repository the fence
 * doesn't guard, is told from git failing, as it does when it times out,
 * and the sweep log says which.
 */
function unreadWhy(
	unread: "refused" | "failed",
	lostGitDir: string | undefined,
): string {
	if (lostGitDir !== undefined) {
		const repository = standingRepository(lostGitDir);
		return repository === undefined
			? "its repository is gone"
			: `git's entry for it in ${repository} is gone, though the repository stands`;
	}
	return unread === "refused"
		? "pi won't run git there, so it can't be judged"
		: "git couldn't name its repository";
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
		spendable: readonly string[];
		unattributed: readonly string[];
		outcome: SweepOutcome;
	},
): Promise<void> {
	const { outcome } = held;
	const pins = await neverLeftPins(deps.exec, trees);
	let plan: ReturnType<typeof orphanedTrees>;
	try {
		const trunk = await trunkOf(deps.exec, main);
		const spendable = new Set(held.spendable);
		const worktrees = await createGitHistory({ exec: deps.exec }).worktrees(
			main,
			trunk,
			{ claimed: (path) => spendable.has(resolved(path)) },
		);
		plan = orphanedTrees({
			mainPath: resolved(main),
			worktrees: worktrees.map((tree) => ({
				...tree,
				path: resolved(tree.path),
			})),
			remembered: held.remembered,
			spendable: held.spendable,
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
	const offered = (tree: HeldTree) =>
		plan.reclaimable.find((one) => one.path === resolved(tree.path));
	const claimedPaths = new Set(held.spendable);
	for (const tree of trees) {
		const path = resolved(tree.path);
		const offer = offered(tree);
		if (offer === undefined) {
			const retained = plan.retained.find((one) => one.path === path);
			outcome.kept.push({
				path: tree.path,
				why: retained?.why ?? "git doesn't list it as a worktree",
			});
			continue;
		}
		const remote = offer.pushed
			? await remoteHolding(deps.exec, tree.path)
			: undefined;
		await takeBack(
			deps,
			facts,
			main,
			tree,
			{
				path: tree.path,
				...(offer.branch ? { branch: offer.branch } : {}),
				...(remote ? { remote } : {}),
				...(tree.sessions?.length ? { sessions: [...tree.sessions] } : {}),
			},
			outcome,
			// A claimed tree is one a session comes back to, and the takes
			// before it may have taken minutes, so who works in it is asked
			// again under its record's lock, just before the move, as an idle
			// snapshot's is.
			claimedPaths.has(path)
				? (take) =>
						deps.memory.whileUnheld(
							tree.path,
							async () => !(await takenUpAgain(deps, tree)) && take(),
							facts,
						)
				: undefined,
		);
	}
}

/**
 * Whether a live session works in a tree a quest claims, asked again
 * just before it goes: the sessions' records and hosts' rosters are read
 * afresh, and so are the processes when the machine has a reader for
 * them. A reader that can't say keeps the tree; with no reader at all,
 * the records and rosters alone decide.
 */
async function takenUpAgain(deps: SweepDeps, tree: HeldTree): Promise<boolean> {
	if ((await treesInUse(deps, [tree])).length > 0) return true;
	if (deps.busyAmong === undefined) return false;
	const path = resolved(tree.path);
	const busy = await deps.busyAmong([path]);
	return busy === undefined || busy.has(path);
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
 * Take a snapshot a live session holds and nothing has used since
 * `idle.usedAt`, as {@link takeBack} does, unless a session asks for it
 * meanwhile. Logged with its sessions and commit, so the session that
 * asks for it again can be told why it is cut afresh.
 */
async function takeIdle(
	deps: SweepDeps,
	facts: ProcessFacts,
	idle: IdleSnapshot,
	now: number,
	outcome: SweepOutcome,
): Promise<void> {
	const { tree, commit, usedAt } = idle;
	const main = await mainCheckoutOf(deps.exec, tree.path);
	if (main === undefined) return;
	const hours = Math.floor((now - usedAt) / 3_600_000);
	const sessions = tree.sessions?.length
		? { sessions: [...tree.sessions] }
		: {};
	const why = `unused for ${hours} h while its session stayed open`;
	await takeBack(
		deps,
		facts,
		main,
		tree,
		{ path: tree.path, ...sessions, commit, why },
		outcome,
		// Who works in it, then its git and folder, are read again under the
		// lock just before the move, since the takes before it may have
		// taken minutes. A reading that can't say keeps it. The walk of
		// every process holds the lock for under a second, where an ask
		// waits ten.
		(take) =>
			deps.memory.whileUnusedSince(
				tree.path,
				usedAt,
				async () => {
					const path = resolved(tree.path);
					const busy = await deps.busyAmong?.([path]);
					return (
						busy !== undefined &&
						!busy.has(path) &&
						lastUsed(tree, deps.memory.askedAt(tree.path, tree.identity.key)) <=
							usedAt &&
						take()
					);
				},
				// Its own record only, read and removed by name, so a run of
				// hundreds of takes never lists the records folder for one.
				tree.identity.key,
			),
	);
}

/**
 * Move a tree aside under its record's lock, then remove it. A removal
 * git refuses puts the tree and its record back as they were. `guard`
 * runs the move only while the tree may go: by default, while every
 * session its record names has ended.
 */
async function takeBack(
	deps: SweepDeps,
	facts: ProcessFacts,
	main: string,
	tree: HeldTree,
	taken: SweptTree,
	outcome: SweepOutcome,
	guard: (take: () => Promise<boolean>) => Promise<HeldTree | undefined> = (
		take,
	) => deps.memory.whileUnheld(tree.path, take, facts),
): Promise<void> {
	const aside = `${tree.path}.going-${randomBytes(4).toString("hex")}`;
	const git = (...args: string[]) => deps.exec("git", ["-C", main, ...args]);
	let moveRefused: string | undefined;
	const forgotten = await guard(async () => {
		const moved = await git("worktree", "move", tree.path, aside);
		if (moved.code !== 0) moveRefused = said(moved);
		return moved.code === 0;
	});
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
		const gone =
			taken.branch !== undefined &&
			(await dropMergedBranch(deps.exec, main, taken.branch));
		outcome.taken.push(gone ? { ...taken, branchGone: true } : taken);
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

/** What git said when it refused, in its own words. */
function said(result: { stdout: string; stderr: string }): string {
	return (result.stderr.trim() || result.stdout.trim()).replace(/^fatal: /, "");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
