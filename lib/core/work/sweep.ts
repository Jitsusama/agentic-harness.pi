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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
	eachIdleWorktree,
	IDLE_TAKES_PER_SWEEP,
	type IdleChoice,
	type IdleSnapshot,
	type IdleWorktree,
	lastUsed,
	mainCheckoutOf,
	nothingOnlyHere,
} from "./sweep-idle.ts";
import {
	branchesKeptFor,
	KEPT_BRANCHES,
	keepBranch,
} from "./sweep-kept-branches.ts";
import { type LockFresh, sweepLock } from "./sweep-lock.ts";
import {
	finishStoppedRemovals,
	goneGitDir,
	standingRepository,
	takeOrphan,
} from "./sweep-orphan.ts";
import { markEnded, restingSince } from "./sweep-rest.ts";
import {
	type MovedAside,
	moveAside,
	putBack,
	removeAside,
	whyGitKeeps,
} from "./sweep-take.ts";
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

/**
 * How many trees a sweep asks git's status of at once. On 25 November
 * eight at once, in core.nix's worktrees, stood seven deep waiting on
 * the disk while Joel's browser waited up to 11 s on the file system's
 * commits, and a sweep is never in a hurry.
 */
const SWEEP_STATUS_AT_ONCE = 1;

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
	/**
	 * What each tree's status runs through, so a runner can answer a tree
	 * unchanged since the last sweep from what it said then; `exec` when
	 * absent.
	 */
	statusExec?: Exec;
	/** The time now, in milliseconds since the epoch; the clock's own by default. */
	now?: () => number;
	/**
	 * Where the broker cuts its trees, so the removals there that stopped
	 * part way are finished. Without it, they stay.
	 */
	treesDir?: string;
	/**
	 * The head commits of the pull requests merged into a checkout's
	 * trunk, `base`, each with its number, or why its forge can't say. A
	 * clean ended tree at one of them goes, as one trunk holds does.
	 * Without it none is asked, as in a host, whose every sweep would
	 * otherwise list each repository over the network with the lock held.
	 */
	mergedHeads?: (
		checkout: string,
		base: string,
	) => Promise<ReadonlyMap<string, number> | string>;
	/**
	 * How long, in milliseconds of awake time, a sweep that finds another
	 * running waits its turn for the lock, looking again every
	 * `lockWaitEveryMs`; none by default, as a host's sweep stands down.
	 */
	lockWaitMs?: number;
	/** How often a sweep waiting its turn looks at the lock again. */
	lockWaitEveryMs?: number;
}

/** How often a sweep waiting its turn looks at the lock again, by default. */
const LOCK_WAIT_EVERY_MS = 10 * 1000;

/**
 * What holders claim: paths held for good, or those and the paths held
 * only while they are still work, which reclaim's rules may take once
 * nothing else holds them, as `orphanedTrees` says under `spendable`.
 * Of those, `idleMayTake` names the ones a holder lets the idle rules
 * take: a worktree a day idle in its open session, clean and pushed, is
 * taken by them only when it is named there, and every other one held
 * until spent stays. A snapshot held until spent stays either way.
 */
export type SweepClaims =
	| readonly string[]
	| {
			held: readonly string[];
			untilSpent: readonly string[];
			idleMayTake?: readonly string[];
	  };

/** A tree the sweep took back, with the branch it leaves behind. */
export interface SweptTree {
	path: string;
	branch?: string;
	/** Set when its branch went too, origin's trunk holding all of it. */
	branchGone?: true;
	/** The remote-tracking branch that holds its commit, when trunk didn't. */
	remote?: string;
	/** The pull request merged at its HEAD, when trunk didn't hold it. */
	landed?: number;
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
	 * How many day-idle worktrees of live sessions nothing was seen
	 * working in it left unjudged, when its share or `idleWithinMs`
	 * stopped it with some left.
	 */
	idleWorktreesLeft?: number;
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
	/**
	 * The checkouts whose merged pull requests couldn't be listed, and why,
	 * so a runner without gh's login says so rather than keeping every
	 * squash-merged tree in silence.
	 */
	unlisted?: { checkout: string; why: string }[];
	/**
	 * How long, in milliseconds of awake time, it waited its turn for the
	 * lock, when it waited, which its own time then leaves out.
	 */
	waitedMs?: number;
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
	let now = deps.now?.() ?? Date.now();
	const awake = deps.awake ?? (() => performance.now());
	const resting = restingSince(deps.lockPath, now, deps.restMs);
	if (resting !== undefined) return { ...outcome, rested: resting };
	let release = sweepLock(deps.lockPath, deps.lockFresh);
	const waitFrom = awake();
	const waitUntil = waitFrom + (deps.lockWaitMs ?? 0);
	while (typeof release === "string" && awake() < waitUntil) {
		await new Promise((done) =>
			setTimeout(done, deps.lockWaitEveryMs ?? LOCK_WAIT_EVERY_MS),
		);
		release = sweepLock(deps.lockPath, deps.lockFresh);
	}
	const waitedMs = awake() - waitFrom;
	if (typeof release === "string") {
		return {
			...outcome,
			skipped: release,
			...(waitedMs > 0 && deps.lockWaitMs ? { waitedMs } : {}),
		};
	}
	if (
		deps.lockWaitMs &&
		waitedMs >= (deps.lockWaitEveryMs ?? LOCK_WAIT_EVERY_MS)
	) {
		outcome.waitedMs = waitedMs;
		// The clock its cut-offs and ages read from, as of its turn.
		now = deps.now?.() ?? Date.now();
	}
	try {
		// Asked at once, before any wait, so a conversation that closes
		// while the sweep runs has already said what its quests hold.
		const ask = async () =>
			typeof deps.claims === "function" ? await deps.claims() : deps.claims;
		const asked = await ask();
		const claims = "held" in asked ? asked.held : asked;
		const untilSpent = "held" in asked ? asked.untilSpent : [];
		const idleMayTake = new Set("held" in asked ? asked.idleMayTake : []);
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
		if (deps.treesDir !== undefined) {
			// Every recorded tree and every claim is somebody's, whatever
			// git makes of it, and so is the folder holding one.
			const known = [
				...deps.memory.recall().map((tree) => resolved(tree.path)),
				...remembered,
				...spendable,
			];
			await finishStoppedRemovals(deps, deps.treesDir, known, now, outcome);
		}
		for (const [main, trees] of repositories.byMain) {
			await sweepRepository(deps, facts, main, trees, {
				remembered,
				spendable,
				unattributed: [...unattributed].map(resolved),
				outcome,
			});
		}
		const keptDir = join(dirname(deps.lockPath), KEPT_BRANCHES);
		await dropSettledBranches(
			deps,
			[...repositories.byMain.keys()],
			held.filter((tree) => tree.providerId === GIT_WORKTREE),
			now - PUSHED_SETTLE_MS,
			outcome,
			await branchesKeptFor(deps.exec, keptDir, await deps.liveSessions?.()),
		);
		const live = [...new Map(held.map((tree) => [tree.path, tree])).values()];
		const letGo = await stillLetGo(
			deps.claims,
			ask,
			untilSpent,
			idleMayTake,
			outcome,
		);
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
			const choice: IdleChoice = {
				...deps,
				claims: [...claims, ...untilSpent],
				now,
				askedAt,
				spent,
				left: (count: number) => {
					outcome.idleLeft = count;
				},
			};
			// Each is taken before the next is judged, so the time judging
			// takes always buys takes.
			let before = false;
			let given = 0;
			// Worktrees, a day idle and the larger, go first with half the
			// share, so a backlog of snapshots never starves them; the
			// snapshots take the rest, and a run on a host's thread holds it
			// no longer than before.
			const share = deps.idleTakes ?? IDLE_TAKES_PER_SWEEP;
			const worktrees: IdleChoice = {
				...choice,
				// A quest lists every tree it ever cut, and those lists alone kept
				// every idle worktree of an open quest: what its holder lets go, goes.
				claims: [...claims, ...untilSpent.filter((path) => !letGo.has(path))],
				most: Math.ceil(share / 2),
				left: (count: number) => {
					outcome.idleWorktreesLeft = count;
				},
			};
			for await (const idle of eachIdleWorktree(live, worktrees)) {
				if (before) await deps.betweenIdleTakes?.();
				before = true;
				given += 1;
				await takeIdleWorktree(deps, facts, idle, now, outcome, keptDir);
			}
			for await (const idle of eachIdleSnapshot(live, {
				...choice,
				most: share - given,
			})) {
				if (before) await deps.betweenIdleTakes?.();
				before = true;
				// Any failure but a held lock, which every take may meet or which
				// may leave a tree moved aside, ends the run unjudged, so the run
				// says so and leaves no stamp.
				await takeIdle(deps, facts, idle, now, outcome);
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
 * What idle rules may take of `idleMayTake`, the trees holders let them
 * take as the run began. Holders chose before the trees above went, and
 * minutes may pass before the idle phase: a tree they kept from those
 * rules may go meanwhile, taken or stuck aside by this run, or released
 * by its own session, and leave an older tree its only one. So holders
 * that can be asked again always are, and only what both answers name
 * may go, since a holder judges again by what stands. Claims that are a
 * list, which can't be asked again, let none go once this run took or
 * refused a tree they kept, and an ask that fails lets none go.
 */
async function stillLetGo(
	claims: SweepDeps["claims"],
	ask: () => Promise<SweepClaims>,
	untilSpent: readonly string[],
	idleMayTake: ReadonlySet<string>,
	outcome: SweepOutcome,
): Promise<ReadonlySet<string>> {
	const keptFromIdle = new Set(
		untilSpent.filter((path) => !idleMayTake.has(path)).map(resolved),
	);
	const touched = [...outcome.taken, ...outcome.refused].some((tree) =>
		keptFromIdle.has(resolved(tree.path)),
	);
	if (typeof claims !== "function") return touched ? new Set() : idleMayTake;
	if (idleMayTake.size === 0) return idleMayTake;
	try {
		const again = await ask();
		const fresh = new Set("held" in again ? again.idleMayTake : []);
		return new Set([...idleMayTake].filter((path) => fresh.has(path)));
	} catch {
		// Nobody answered again, so nobody let anything go again.
		return new Set();
	}
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
	let before: HeldTree | undefined;
	try {
		before = await deps.memory.holdWhileUnheld(tree.path, facts);
	} catch (error) {
		if (!keptForItsLock(tree, error, outcome)) throw error;
		return;
	}
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
		// One listing for the repository, not one ask a tree: core.nix's
		// trees alone numbered 397 on 25 November.
		const listing = await deps.mergedHeads?.(
			main,
			trunk.replace(/^origin\//, ""),
		);
		const merged = typeof listing === "string" ? undefined : listing;
		if (typeof listing === "string") {
			outcome.unlisted = [
				...(outcome.unlisted ?? []),
				{ checkout: main, why: listing },
			];
		}
		const spendable = new Set(held.spendable);
		// Only the trees this sweep judges are asked anything: every other
		// worktree beside them, live sessions' and the person's own, is one
		// it takes nothing from, and asking each its status every hour was
		// about 2,000 statuses across three repositories.
		const ours = new Set(trees.map((tree) => resolved(tree.path)));
		const worktrees = await createGitHistory({ exec: deps.exec }).worktrees(
			main,
			trunk,
			{
				claimed: (path) => spendable.has(resolved(path)),
				kept: (path) => !ours.has(resolved(path)),
				atOnce: SWEEP_STATUS_AT_ONCE,
				...(deps.statusExec ? { statusExec: deps.statusExec } : {}),
			},
		);
		// The others were asked nothing, so they would read as clean: the
		// plan sees only this sweep's own, and can offer nothing else.
		plan = orphanedTrees({
			mainPath: resolved(main),
			worktrees: worktrees
				.map((tree) => ({ ...tree, path: resolved(tree.path) }))
				.filter((tree) => ours.has(tree.path)),
			remembered: held.remembered,
			spendable: held.spendable,
			unattributed: held.unattributed,
			settled: (path) =>
				headStillSince(path, (deps.now?.() ?? Date.now()) - PUSHED_SETTLE_MS),
			stillPinned: (path, commit) =>
				commit !== undefined && pins.get(path) === commit,
			...(merged ? { landed: (commit: string) => merged.get(commit) } : {}),
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
	let landedTakes = 0;
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
		// Set under the lock, so a keep can say a reading that couldn't tell
		// kept the tree rather than blame a session.
		let unread = false;
		// Set under the lock when a landed tree left its merged head.
		let left = false;
		const landed = offer.landed !== undefined;
		// Merged at its HEAD when chosen, and taken only while it still sits
		// there on the same branch, read again under its record's lock.
		const stillLanded = async () =>
			!landed ||
			(offer.branch !== undefined &&
				offer.commit !== undefined &&
				(await stillAt(deps.exec, tree.path, offer.branch, offer.commit)));
		// A landed tree goes the hour its pull request merged, with no day's
		// settle, and the first run takes the backlog of hundreds: each but
		// the first waits the runner's pause between removals, which hold
		// the directory locks Joel's windows stalled on.
		if (landed && landedTakes++ > 0) await deps.betweenIdleTakes?.();
		await takeBack(
			deps,
			facts,
			main,
			tree,
			{
				path: tree.path,
				...(offer.branch ? { branch: offer.branch } : {}),
				...(remote ? { remote } : {}),
				...(offer.landed === undefined ? {} : { landed: offer.landed }),
				...(tree.sessions?.length ? { sessions: [...tree.sessions] } : {}),
			},
			outcome,
			// A claimed tree is one a session comes back to, as a landed one
			// is just after its merge, and the takes before it may have taken
			// minutes, so who works in it is asked again under its record's
			// lock, just before the move, as an idle snapshot's is.
			(take) =>
				deps.memory.whileUnheld(
					tree.path,
					async () => {
						if (claimedPaths.has(path) || landed) {
							const again = await takenUpAgain(deps, tree);
							unread = again === "can't say";
							if (again !== "left") return false;
						}
						left = !(await stillLanded());
						return !left && take();
					},
					facts,
				),
			{ unread: () => unread, left: () => left },
		);
	}
}

/**
 * Whether a worktree's HEAD is still `branch`, at `commit`. A tree that
 * can't say is not.
 */
async function stillAt(
	exec: Exec,
	path: string,
	branch: string,
	commit: string,
): Promise<boolean> {
	const git = (...args: string[]) =>
		exec("git", ["-C", path, "--no-optional-locks", ...args]);
	const ref = await git("symbolic-ref", "--quiet", "HEAD");
	const head = await git("rev-parse", "HEAD");
	return (
		ref.code === 0 &&
		head.code === 0 &&
		ref.stdout.trim() === `refs/heads/${branch}` &&
		head.stdout.trim() === commit
	);
}

/**
 * Whether a live session works in a tree a quest claims, asked again
 * just before it goes: the sessions' records and hosts' rosters are read
 * afresh, and so are the processes when the machine has a reader for
 * them. A reader that can't say keeps the tree, and says so apart from a
 * session's taking it up; with no reader at all, the records and rosters
 * alone decide.
 */
async function takenUpAgain(
	deps: SweepDeps,
	tree: HeldTree,
): Promise<"taken up" | "left" | "can't say"> {
	if ((await treesInUse(deps, [tree])).length > 0) return "taken up";
	if (deps.busyAmong === undefined) return "left";
	const path = resolved(tree.path);
	const busy = await deps.busyAmong([path]);
	if (busy === undefined) return "can't say";
	return busy.has(path) ? "taken up" : "left";
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
	let unread = false;
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
		// every process holds the lock for under a second, and lsof on a
		// Mac for about two and a half and never past five, where an ask
		// waits ten.
		(take) =>
			deps.memory.whileUnusedSince(
				tree.path,
				usedAt,
				async () => {
					const path = resolved(tree.path);
					const busy = await deps.busyAmong?.([path]);
					unread = busy === undefined;
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
		{ unread: () => unread },
	);
}

/**
 * Take a worktree a live session left clean, its branch on a remote, as
 * {@link takeIdle} takes a snapshot, keeping its branch at its head for
 * as long as a session its record names lives, so asking for it again
 * checks out the same branch and head. Who works in it, its use and what
 * only it holds are read again under its record's lock.
 */
async function takeIdleWorktree(
	deps: SweepDeps,
	facts: ProcessFacts,
	idle: IdleWorktree,
	now: number,
	outcome: SweepOutcome,
	keptDir: string,
): Promise<void> {
	const { tree, branch, commit, remote, usedAt } = idle;
	const main = await mainCheckoutOf(deps.exec, tree.path);
	if (main === undefined) return;
	const hours = Math.floor((now - usedAt) / 3_600_000);
	const sessions = [...(tree.sessions ?? [])];
	const why = `unused for ${hours} h while its session stayed open, its branch on ${remote}`;
	const taken = outcome.taken.length;
	let unread = false;
	// The note goes in first, so a sweep cut off mid-take leaves the branch
	// kept, and comes out again when the tree stays.
	const unkeep = keepBranch(keptDir, {
		checkout: main,
		branch,
		commit,
		path: tree.path,
		sessions,
		takenAt: now,
	});
	try {
		await takeBack(
			deps,
			facts,
			main,
			tree,
			{
				path: tree.path,
				branch,
				...(sessions.length > 0 ? { sessions } : {}),
				commit,
				remote,
				why,
			},
			outcome,
			(take) =>
				deps.memory.whileUnusedSince(
					tree.path,
					usedAt,
					async () => {
						const path = resolved(tree.path);
						const busy = await deps.busyAmong?.([path]);
						unread = busy === undefined;
						return (
							busy !== undefined &&
							!busy.has(path) &&
							lastUsed(
								tree,
								deps.memory.askedAt(tree.path, tree.identity.key),
							) <= usedAt &&
							(await stillOnlyElsewhere(
								deps.exec,
								tree.path,
								branch,
								commit,
							)) &&
							take()
						);
					},
					tree.identity.key,
				),
			{ keepBranch: true, unread: () => unread },
		);
	} finally {
		// Undone only while the tree stands where it was: one moved aside
		// whose leftovers wouldn't all go has left its path all the same,
		// and its session still needs its branch and the telling.
		if (outcome.taken.length === taken && existsSync(tree.path)) unkeep();
	}
}

/**
 * Whether a worktree still holds nothing found only there, on the same
 * branch at the same head, read again under its record's lock just
 * before it goes, since a session may have written, committed or
 * switched there while the sweep chose.
 */
async function stillOnlyElsewhere(
	exec: Exec,
	path: string,
	branch: string,
	commit: string,
): Promise<boolean> {
	const now = await nothingOnlyHere(exec, path);
	return now?.branch === branch && now.commit === commit;
}

/**
 * Move a tree aside under its record's lock, then remove it, with no git
 * command that reads every worktree but a merged branch's drop (see
 * `sweep-take.ts`). A removal git
 * would refuse puts the tree and its record back as they were. `guard`
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
	how: {
		keepBranch?: boolean;
		unread?: () => boolean;
		left?: () => boolean;
	} = {},
): Promise<void> {
	const aside = `${tree.path}.going-${randomBytes(4).toString("hex")}`;
	let moveRefused: string | undefined;
	let moved: MovedAside | undefined;
	let forgotten: HeldTree | undefined;
	try {
		forgotten = await guard(async () => {
			const move = moveAside(tree.path, aside, main);
			if (typeof move === "string") moveRefused = move;
			else moved = move;
			return moved !== undefined;
		});
	} catch (error) {
		if (!keptForItsLock(tree, error, outcome)) throw error;
		return;
	}
	if (forgotten === undefined || moved === undefined) {
		if (moveRefused !== undefined) {
			outcome.refused.push({ path: tree.path, why: moveRefused });
		} else {
			// A reading that couldn't say, as when lsof is cut at its limit,
			// is told apart from a session at work there, so a log that
			// keeps saying it shows the reader failing, not the sessions.
			outcome.kept.push({
				path: tree.path,
				why: how.unread?.()
					? "the machine can't say which processes hold it"
					: how.left?.()
						? "it left the merged pull request's head since it was judged"
						: "a session took it up again",
			});
		}
		return;
	}
	const kept = await whyGitKeeps(deps.exec, moved.aside);
	if (kept !== undefined) {
		const back = putBack(moved, tree.path);
		const why = back.why === undefined ? kept : `${kept}; ${back.why}`;
		if (!back.home) {
			outcome.refused.push({ path: tree.path, why });
			return;
		}
		// A tree at its own path keeps its record, whatever else went wrong,
		// so its sessions and the next sweep still know it.
		try {
			deps.memory.remember(forgotten);
			outcome.refused.push({ path: tree.path, why });
		} catch (error) {
			outcome.refused.push({
				path: tree.path,
				why: `${kept}; it is back, but its record can't be written again: ${messageOf(error)}`,
			});
		}
		return;
	}
	// Read-only module caches refuse a plain removal, as they refuse git's,
	// which forgets the tree all the same: what is left stays aside, as
	// git's remove left it, and the refusal says where.
	const stays = await removeAside(moved);
	if (stays !== undefined) {
		outcome.refused.push({ path: tree.path, why: stays });
		return;
	}
	const gone =
		taken.branch !== undefined &&
		how.keepBranch !== true &&
		(await dropMergedBranch(deps.exec, main, taken.branch));
	outcome.taken.push(gone ? { ...taken, branchGone: true } : taken);
}

/**
 * Keep `tree` when `error` is another process holding its record's lock
 * past the wait, saying whether it did. One record's lock held too long
 * keeps that tree alone: ending a run of hundreds there would cost the
 * outside stamp and send the hosts back to sweeping on their own threads,
 * as one did 40 minutes into a run on 22 November.
 */
function keptForItsLock(
	tree: HeldTree,
	error: unknown,
	outcome: SweepOutcome,
): boolean {
	if (!isLockHeld(error)) return false;
	outcome.kept.push({ path: tree.path, why: messageOf(error) });
	return true;
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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
