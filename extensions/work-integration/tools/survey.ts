/**
 * Tidy and reclaim: what a repository has finished with, reported and
 * never removed by one, and the trees beside it nothing holds, taken back
 * by the other with every branch kept.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import { citeListing } from "../../../lib/core/result/listing.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import type { TreeBroker } from "../../../lib/core/work/broker.ts";
import {
	devShellRoots,
	rootsReport,
} from "../../../lib/core/work/dev-shell-roots.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../../lib/core/work/events.ts";
import {
	createGitHistory,
	type WorkHistory,
} from "../../../lib/core/work/history.ts";
import { treesToKeep } from "../../../lib/core/work/in-use.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import {
	type ReclaimOutcome,
	reclaimTrees,
} from "../../../lib/core/work/reclaim.ts";
import { createGitStacks } from "../../../lib/core/work/stacks.ts";
import {
	GUARD_WORDS,
	type KeptTree,
	plainWords,
	type SetAsideTree,
	type StrandedSigns,
	type StrandedTree,
	setAside,
	setAsideEarlier,
	splitStranded,
	strandedDir,
	strandedTrees,
} from "../../../lib/core/work/stranded.ts";
import { surveyTarget } from "../../../lib/core/work/survey.ts";
import {
	type OrphanPlan,
	orphanedTrees,
	tidyPlan,
} from "../../../lib/core/work/tidy.ts";
import {
	duMeasure,
	formatSize,
	measureEach,
	type Size,
	sum,
} from "../../../lib/internal/quest/workspace/footprint.ts";
import { gitTreeRootOf } from "../../../lib/internal/quest/workspace/git-signals.ts";
import { gitRules } from "../../../lib/internal/sandbox/sandbox.ts";
import { gitRun } from "../../../lib/internal/sandbox/tree-git.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import { count } from "../../../lib/ui/count.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { treeBroker, treeDir } from "../broker.ts";
import { GLYPH } from "../render.ts";
import { useSigns } from "../sweep.ts";
import { resolved } from "./held.ts";
import { type Answer, refuse, say } from "./shared.ts";

/**
 * How long tidy may spend sizing the spent trees it names. A cargo
 * target can run to tens of gigabytes; past this it says "at least".
 */
const TIDY_MEASURE_MS = 15_000;

/**
 * How long one tree's status may take before tidy keeps it unread. A
 * World tree holding 2.3 million files took 46 s at load 40, and one
 * took 733 s, which held every survey of the trees beside it.
 */
const TIDY_STATUS_MS = 60_000;

/**
 * Tidy or reclaim the repository a call names, or the one it is asked
 * from.
 *
 * tidy and reclaim survey a repository rather than operate on a tree,
 * and the checkout a person naturally asks from is the main one, which
 * the broker never holds. Routing them past the held-tree gate is what
 * lets the question be asked where it actually comes up. The verbs that
 * commit, push and replay stay gated.
 */
export async function survey(
	pi: ExtensionAPI,
	exec: Exec,
	broker: TreeBroker,
	action: "tidy" | "reclaim",
	asked: { tree?: string; trunk?: string },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Answer> {
	const target = surveyTarget({
		...(asked.tree ? { tree: asked.tree } : {}),
		held: broker
			.held()
			.map((one) => ({ key: one.identity.key, path: one.path })),
		// Where the person asking stands, which is the conversation's
		// folder: on a host the process's is the host's, shared by
		// every conversation it runs.
		cwd: sessionCwd(ctx),
		gitRootOf: gitTreeRootOf,
	});
	if (!target.ok) {
		return refuse(`${GLYPH.refused} ${target.refusal}`);
	}
	return await surveyRepo(
		pi,
		exec,
		target,
		action,
		asked.trunk ?? "main",
		ctx,
		signal,
	);
}

/**
 * Which trees beside this one nothing owns any more.
 *
 * Shared by `tidy`, which reports them, and `reclaim`, which acts on
 * exactly what it offered. One function because the two must never
 * disagree about what is safe: a reclaim that recomputed the set with
 * a subtly different question would remove something the report never
 * showed anybody.
 */
async function treesLeftBehind(
	pi: ExtensionAPI,
	history: WorkHistory,
	broker: TreeBroker,
	mainPath: string,
	trunk: string,
	signal: AbortSignal | undefined,
): Promise<LeftBehind> {
	// This broker is not the only thing that cuts a worktree. A quest
	// holds trees against a piece of work and knows nothing about this
	// memory, and from git's side that is indistinguishable from a tree
	// somebody leaked. Asking is the only way to tell, and the very
	// first run against a real repo offered up a tree a quest owned.
	// The person asked for this survey, so a tree a quest holds only
	// while it is still work is held here all the same: only the
	// unattended sweep spends them.
	const claims: TreeClaims = { paths: [], untilSpent: [], answering: [] };
	pi.events.emit(WORK_TREE_CLAIMS, claims);
	await Promise.all(claims.answering ?? []);

	const unattributed = new Set(broker.unattributed().map((one) => one.path));
	// A record's owners name processes, and a session resumed in a new one
	// still works in its trees: on 10 November reclaim would have taken 59
	// snapshots two running sessions named, so it asks what the sweep asks.
	const remembered = [
		...(await treesToKeep(broker, useSigns())),
		...claims.paths,
		...(claims.untilSpent ?? []),
	].map(resolved);
	// The checkout and every held tree are kept whatever they hold, so
	// git is asked nothing more of them than where they are.
	const keeping = new Set([resolved(mainPath), ...remembered]);

	const worktrees = (
		await history.worktrees(mainPath, trunk, {
			kept: (path) => keeping.has(resolved(path)),
			statusExec: spawnExec({
				...(signal ? { signal } : {}),
				timeoutMs: TIDY_STATUS_MS,
			}),
		})
	).map((tree) => ({
		...tree,
		path: resolved(tree.path),
	}));
	const plan = orphanedTrees({
		mainPath: resolved(mainPath),
		worktrees,
		// `stillHeld`, not `held`. A tree stays in the record after the
		// session that cut it has gone, deliberately, so that the next
		// session can find it: asking the wider question here meant every
		// tree ever cut answered "something still holds it" and nothing
		// was ever reclaimable.
		//
		// Minus the unattributable ones, which `stillHeld` counts as held
		// because it must fail safe on its own. Left in both sets they
		// answer the held question first and the branch reporting them
		// never runs, which is a whole feature that reads as implemented
		// and does nothing. A claim is added back afterwards, since a
		// quest saying it wants a tree outranks a record saying nothing.
		remembered,
		unattributed: [...unattributed].map(resolved),
	});
	return {
		...plan,
		// Not every record: one whose sessions have all ended holds
		// nothing, and its tree, which release can't take since git won't
		// run there, goes only by being set aside under its record's lock.
		// One a running session holds is among `keeping`.
		...(await strandedBeside(
			[...keeping, ...unattributed, ...worktrees.map((tree) => tree.path)].map(
				resolved,
			),
		)),
	};
}

/** The trees left behind beside a checkout, and those nothing can use. */
interface LeftBehind extends OrphanPlan {
	/** Trees git won't read that nothing holds, which reclaim sets aside. */
	stranded: StrandedTree[];
	/** Stranded trees kept for now, each saying why. */
	strandedKept: KeptTree[];
}

/** What tells a stranded tree is still being made or used, read now. */
function strandedSigns(): StrandedSigns {
	const busyAmong = useSigns().busyAmong;
	return busyAmong === undefined ? {} : { busyAmong };
}

/**
 * The trees where the broker cuts them that nothing holds and git won't
 * read, whichever checkout they came from. No checkout's git lists one
 * cut from a clone git won't run in, so this is the only survey that
 * can see it, and every snapshot of its commit fails until it goes. One
 * a process works in, or that the machine can't say of, is kept: the
 * record is the broker's, but a reader may still stand in the folder.
 */
async function strandedBeside(
	kept: readonly string[],
): Promise<{ stranded: StrandedTree[]; strandedKept: KeptTree[] }> {
	const rules = gitRules();
	const found = strandedTrees({
		dir: treeDir(),
		kept: new Set(kept),
		refusal: (path) => {
			const run = gitRun(path, ["rev-parse", "HEAD"], rules);
			// The guard's words name a path a fenced command can choose.
			return "refused" in run ? GUARD_WORDS : undefined;
		},
	});
	const split = await splitStranded(found, strandedSigns());
	return { stranded: split.free, strandedKept: split.kept };
}

/**
 * Set aside the stranded trees the survey offered, asked about again
 * just before they move, since a cut or a reader may have come to one
 * while the checkout's trees were reclaimed, and one with a record only
 * under that record's lock. One look for them all, since each walks
 * every process.
 */
async function setStrandedAside(
	trees: readonly StrandedTree[],
): Promise<SetAsideTree[]> {
	if (trees.length === 0) return [];
	const again = await splitStranded(trees, strandedSigns());
	return [
		...again.kept.map((tree) => ({ kind: "kept" as const, ...tree })),
		...(await setAside(again.free, {
			into: strandedDir(treeDir()),
			// The memory the sweep takes trees under, so the two judge a
			// record the same way and under the same lock.
			records: createTreeMemory(treeRecordDir()),
		})),
	];
}

/** What became of one stranded tree, as a line under reclaim's count. */
function movedLine(tree: SetAsideTree): string {
	switch (tree.kind) {
		case "set-aside":
			return `   ${GLYPH.named} ${displayPath(tree.path)}, set aside whole at ${displayPath(tree.aside)}`;
		case "gone":
			return `   ${GLYPH.clean} ${displayPath(tree.path)}: gone by its turn, as another reclaim or the sweep took it`;
		case "kept":
			return keptLine(tree);
		case "refused":
			return `   ${GLYPH.refused} ${displayPath(tree.path)}: moving it was refused: ${tree.why}`;
	}
}

/**
 * A tree the survey keeps, and why. A judgement call is marked apart
 * from a refusal: the difference is whether anybody could act on it.
 */
function keptLine(tree: { path: string; why: string; decide?: boolean }) {
	return `   ${tree.decide ? GLYPH.undecided : GLYPH.refused} ${displayPath(tree.path)}: ${tree.why}`;
}

/**
 * Report or act on what a repository has finished with.
 *
 * These two are the survey verbs, and they read a checkout rather
 * than operate on a held tree. That is why they take a target from
 * `surveyTarget` instead of the broker: the main checkout is where
 * the question comes up and the one place the broker never holds.
 */
async function surveyRepo(
	pi: ExtensionAPI,
	exec: Exec,
	target: { key: string; path: string },
	action: "tidy" | "reclaim",
	trunk: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Answer> {
	const history = createGitHistory({ exec });
	// A held tree's key is a name; an unheld checkout's is its path, and
	// this is the line a person reads. The tree lines below already put
	// a tilde on a path, so a raw one in the headline above them was
	// only ever the seam showing.
	const named = displayPath(target.key);
	const orphans = await treesLeftBehind(
		pi,
		history,
		treeBroker(),
		target.path,
		trunk,
		signal,
	);

	if (action === "reclaim") {
		// The one cleanup verb here that acts. Removing a worktree
		// takes the directory and git's bookkeeping and leaves the
		// branch, so the commits stay reachable and re-cutting the
		// tree at the same branch puts a person back where they were.
		// That is what a branch deletion cannot offer, and why tidy
		// refuses to act while this does not. A branch origin's trunk
		// already has all of goes too, which loses nothing.
		if (orphans.reclaimable.length === 0 && orphans.stranded.length === 0) {
			// Said as a no-op rather than as a success, and it names
			// what was considered so the answer is not mistaken for
			// having looked in the wrong place.
			const kept = orphans.retained.filter(
				(tree) => tree.path !== resolved(target.path),
			);
			return say(
				[
					`${GLYPH.clean} No tree beside ${named} is going spare, against ${trunk}.`,
					...kept.map(keptLine),
					...orphans.strandedKept.map(keptLine),
				].join("\n"),
				{ ok: true, reclaimed: 0, setAside: 0 },
			);
		}

		const outcome: ReclaimOutcome =
			orphans.reclaimable.length === 0
				? { trees: [] }
				: await reclaimTrees(
						{ exec, mainPath: target.path },
						orphans.reclaimable,
					);
		// Moved, never removed: git can't say whether one holds work. A
		// failure here is said beside what was already taken back, rather
		// than losing that report.
		let moved: SetAsideTree[] = [];
		let unmoved: string | undefined;
		try {
			moved = await setStrandedAside(orphans.stranded);
		} catch (error) {
			unmoved = plainWords(
				error instanceof Error ? error.message : String(error),
			);
		}
		const setAsideCount = moved.filter((t) => t.kind === "set-aside").length;
		const took = outcome.trees.filter((t) => t.kind === "reclaimed");
		const kept = took.some((t) => t.branch && !t.branchGone);
		const branchOf = (tree: (typeof took)[number]) =>
			tree.branch === undefined
				? ""
				: tree.branchGone
					? `, ${tree.branch} gone, since origin's trunk has all of it`
					: `, ${tree.branch} kept`;
		return say(
			[
				// Past tense, because this one did something.
				...(outcome.trees.length === 0
					? []
					: [
							`${GLYPH.named} Took back ${count(took.length, "tree", "trees")} beside ${named}.`,
						]),
				...outcome.trees.map((tree) =>
					tree.kind === "reclaimed"
						? `   ${GLYPH.named} ${displayPath(tree.path)}${branchOf(tree)}`
						: `   ${GLYPH.refused} ${displayPath(tree.path)}: ${tree.why}`,
				),
				// Stranded trees are counted apart, since they come from
				// whichever clone cut them, not from this checkout.
				...(moved.length === 0
					? []
					: [
							setAsideCount === 0
								? `${GLYPH.clean} Set aside none of the trees git won't read where the broker cuts them.`
								: `${GLYPH.named} Set aside ${count(setAsideCount, "tree", "trees")} git won't read where the broker cuts them.`,
						]),
				...moved.map(movedLine),
				...(unmoved === undefined
					? []
					: [
							`${GLYPH.refused} Setting aside the trees git won't read stopped partway, so some may be in ${displayPath(strandedDir(treeDir()))} and the rest where they were, as \`work tidy\` shows: ${unmoved}`,
						]),
				...orphans.strandedKept.map(keptLine),
				...(kept
					? [
							"",
							"Every branch kept is still where it was. Cut a tree at one",
							"again to pick that work back up.",
						]
					: []),
				...(setAsideCount > 0
					? [
							"",
							"A tree set aside keeps every file it held, and its name is free",
							"to cut again. Its .git is kept as .git-was, since the git entry",
							"it named may by then belong to a tree cut at its name, so copy",
							"out what is wanted and delete it once nothing in it is wanted.",
						]
					: []),
			].join("\n"),
			{ ok: true, reclaimed: took.length, setAside: setAsideCount },
		);
	}

	// Reported, never done. Landing is not an instant: a change
	// handed to a merge queue merges later and from somewhere
	// else, so the moment somebody asks to merge is the moment
	// nothing is cleanable yet. This is the verb they come back
	// to afterwards, and it hands back a plan rather than a
	// result because deleting a branch is not undoable.
	const head = await history.head(target.path);
	const tracked = await createGitStacks({
		exec,
		rebaser: createGitRebaser({ exec }),
	}).read(target.path);
	const plan = tidyPlan({
		trunk,
		current: head.branch ?? "",
		branches: await history.branches(target.path, trunk),
		tracked: tracked.map((step) => step.name),
	});

	// One record per line below, so a plan too long to read whole is
	// stored and queried rather than read at its full length: a
	// checkout with hundreds of merged branches answered 43 KB.
	type Verdict = "can go" | "decide" | "kept";
	const records: { what: string; verdict: Verdict; why?: string }[] = [];
	const lines: string[] = [];
	for (const gone of plan.removable) {
		records.push({ what: gone.branch, verdict: "can go" });
		lines.push(
			`   ${GLYPH.named} ${gone.branch}${gone.alsoUntrack ? ", and untrack it" : ""}`,
		);
	}
	for (const kept of plan.keeping) {
		records.push({
			what: kept.branch,
			verdict: kept.decide ? "decide" : "kept",
			why: kept.why,
		});
		// A judgement call is marked apart from a refusal. The
		// difference is whether anybody could act on it.
		lines.push(
			`   ${kept.decide ? GLYPH.undecided : GLYPH.refused} ${kept.branch}: ${kept.why}`,
		);
	}
	if (plan.prunable) {
		lines.push(
			`   ${GLYPH.named} tracking refs for branches the remote dropped`,
		);
	}
	// Sized only when there is a spent tree to size, at the lowest
	// priority and under one short deadline, so tidy stays a quick
	// question and a huge build directory reads as "at least".
	const sizes =
		orphans.reclaimable.length === 0
			? new Map<string, Size>()
			: await measureEach(
					orphans.reclaimable.map((tree) => tree.path),
					duMeasure({ deadlineMs: TIDY_MEASURE_MS }),
				);
	for (const tree of orphans.reclaimable) {
		const size = sizes.get(tree.path);
		records.push({ what: displayPath(tree.path), verdict: "can go" });
		lines.push(
			`   ${GLYPH.named} ${displayPath(tree.path)}, a tree nothing holds${tree.branch ? ` (${tree.branch})` : ""}${size ? `, ${formatSize(size)}` : ""}`,
		);
	}
	for (const tree of orphans.stranded) {
		records.push({
			what: displayPath(tree.path),
			verdict: "can go",
			why: tree.why,
		});
		lines.push(
			`   ${GLYPH.named} ${displayPath(tree.path)}, a tree nothing holds that git won't read: ${tree.why}`,
		);
	}
	for (const tree of orphans.strandedKept) {
		records.push({
			what: displayPath(tree.path),
			verdict: "kept",
			why: tree.why,
		});
		lines.push(keptLine(tree));
	}
	const freed = sizes.size > 0 ? sum([...sizes.values()]) : undefined;
	for (const tree of orphans.retained) {
		// The checkout itself is left out. It is retained for a
		// reason nobody needs telling, and saying it every time
		// trains people to skip the list that also holds the one
		// line they must read.
		if (tree.path === resolved(target.path)) continue;
		records.push({
			what: displayPath(tree.path),
			verdict: tree.decide ? "decide" : "kept",
			why: tree.why,
		});
		lines.push(keptLine(tree));
	}

	// The Nix roots each tree's dev shell holds, since those keep store
	// paths from the collector for as long as the tree stands, and which
	// trees lose theirs at the next sweep. Links read, nothing followed,
	// so it costs a directory listing a tree.
	const roots = rootsReport(
		[...orphans.reclaimable, ...orphans.retained]
			.filter((tree) => tree.path !== resolved(target.path))
			.map((tree) => {
				const held = devShellRoots(tree.path);
				return {
					path: displayPath(tree.path),
					roots: held.roots.length,
					...(held.lastTouched === undefined
						? {}
						: { lastTouched: held.lastTouched }),
				};
			}),
		Date.now(),
	);
	if (roots.length > 0) lines.push("", ...roots);

	const spent = plan.removable.length + orphans.reclaimable.length;
	const headline = [
		spent === 0
			? `${GLYPH.clean} Nothing in ${named} has been spent yet, against ${trunk}.`
			: `${GLYPH.named} ${count(spent, "thing", "things")} in ${named} can go, against ${trunk}.`,
		// Counted apart: no checkout's git lists them, so they are found
		// where the broker cuts trees, whichever clone cut them.
		...(orphans.stranded.length === 0
			? []
			: [
					`${GLYPH.named} ${count(orphans.stranded.length, "tree", "trees")} git won't read can be set aside where the broker cuts them.`,
				]),
	].join("\n");
	const earlier = setAsideEarlier(strandedDir(treeDir()));
	// The advice is the trailer, so it survives a cut list: it is
	// what the reader acts on once they have read the list.
	const advice = [
		"Nothing has been removed. Delete the branches you agree with,",
		"and prefer git branch -d, which refuses anything trunk does not",
		"contain and is the check rather than the obstacle.",
		...(orphans.reclaimable.length === 0
			? []
			: [
					// The one place a reader is sent to a verb rather than
					// left with a git call the guide tells them never to
					// make. Trees are reclaimable precisely because the
					// branch survives the removal.
					"",
					`For the ${count(orphans.reclaimable.length, "tree", "trees")} nothing holds, work reclaim takes them`,
					`back${freed ? `, freeing ${formatSize(freed)}` : ""}. Each branch stays exactly where it is, so re-cutting`,
					"the tree puts you back.",
				]),
		...(orphans.stranded.length === 0
			? []
			: [
					// Every cut at one's name fails until it goes, and only this
					// survey sees it, so the way out is said here.
					"",
					`For the ${count(orphans.stranded.length, "tree", "trees")} git won't read, work reclaim moves each aside`,
					`whole, to ${displayPath(strandedDir(treeDir()))}, deleting nothing, so its name can be cut again.`,
				]),
		// What reclaim set aside stays until somebody deletes it, so the
		// folder is named while it holds anything.
		...(earlier === 0
			? []
			: [
					"",
					`${count(earlier, "tree", "trees")} set aside earlier wait in ${displayPath(strandedDir(treeDir()))}.`,
					"Delete each once nothing in it is wanted.",
				]),
	].join("\n");
	return say(
		citeListing(openSessionStore(ctx), {
			view: [headline, ...lines].join("\n"),
			records,
			unit: "branches and trees",
			narrowing:
				'Query the stored result by verdict, such as $[?(@.verdict=="can go")].what.',
			trailer: advice,
		}),
		{
			ok: true,
			removable: plan.removable.length,
			reclaimable: orphans.reclaimable.length,
			stranded: orphans.stranded.length,
		},
	);
}
