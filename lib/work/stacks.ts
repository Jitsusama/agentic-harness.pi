/**
 * Keeping a stack, and replaying it when what it sits on moves.
 *
 * The thinking lives in `stack.ts` and never touches a repository. This is the
 * adapter: it stores parentage, asks git to replay, and stops the moment a
 * replay halts.
 *
 * Parentage is stored in git's own config, under the branch it describes. That
 * puts it in the repository rather than in this package's state, which is the
 * property that matters: the record survives a session, is visible to anybody
 * who runs `git config`, and is deleted by git itself when the branch is. A
 * stack recorded in a tool's private state is a stack that quietly outlives the
 * branches it names.
 *
 * A stacked backend that tracks parentage itself is the reason this is a facet
 * rather than the implementation. On a repository driven by such a tool, its
 * record is the truth and this one would be a second opinion; a provider there
 * should offer its own `WorkStacks` instead of teaching this one a second
 * vocabulary.
 *
 * Restacking stops at the first halt and says what it did not reach. Carrying
 * on would replay later branches onto a parent that is mid-rebase, which
 * produces a stack that looks restacked and is built on a commit that is about
 * to be rewritten.
 */

import type { Exec } from "../exec/index.js";
import type { WorkRebaser } from "./rebase.js";
import {
	orderStack,
	planReorder,
	planRestack,
	reparentFault,
	type StackedBranch,
	type StackFault,
} from "./stack.js";
import { unattended } from "./unattended.js";

/**
 * Where parentage is recorded, under the branch it belongs to.
 *
 * Lowercase because that is what git stores. Config variable names are
 * case-insensitive and git normalizes them, so a key written as `workParent`
 * reads back as `workparent`: writing one spelling and comparing the other
 * found nothing, and every branch read as untracked. A fake exec cannot catch
 * that, since it answers with whatever spelling the test wrote.
 */
const PARENT_KEY = "workparent";
/** Where the last-aligned base is recorded. */
const BASE_KEY = "workbase";

/** What happened to one branch during a restack. */
export interface ReplayResult {
	branch: string;
	onto: string;
	outcome: "replayed" | "already-there" | "halted" | "skipped";
	/** Paths that disagree, when it halted. */
	conflicted?: readonly string[];
}

/** How a restack went. */
export type RestackOutcome =
	| {
			kind: "restacked";
			results: readonly ReplayResult[];
			/** Where the tree was left, which is where it started. */
			on?: string;
	  }
	| {
			kind: "halted";
			/** What was done, what stopped, and what was never reached. */
			results: readonly ReplayResult[];
			at: string;
			conflicted: readonly string[];
	  }
	| { kind: "faulted"; fault: StackFault }
	| { kind: "refused"; reason: string };

/** How a change to the stack's shape went. */
export type ShapeOutcome =
	| { kind: "shaped"; changed: readonly string[] }
	| { kind: "unchanged" }
	| { kind: "faulted"; fault: StackFault }
	| { kind: "refused"; reason: string };

/** Keeping and replaying a stack of branches. */
export interface WorkStacks {
	/** What this repository records about its stack. */
	read(treePath: string): Promise<readonly StackedBranch[]>;
	/** Record that a branch sits on another, or on trunk. */
	track(
		treePath: string,
		branch: string,
		parent?: string,
	): Promise<ShapeOutcome>;
	/** Forget a branch, moving whatever sat on it down onto its parent. */
	untrack(treePath: string, branch: string): Promise<ShapeOutcome>;
	/** Point a branch at a different parent. */
	reparent(
		treePath: string,
		branch: string,
		parent?: string,
	): Promise<ShapeOutcome>;
	/** Rearrange a chain into the order given, lowest first. */
	reorder(treePath: string, desired: readonly string[]): Promise<ShapeOutcome>;
	/**
	 * Which tracked branches no longer sit on the branch beneath them.
	 *
	 * The one fact about a stack that git will not tell you and that a listing of
	 * names cannot show. A branch drifts whenever what it sits on moves without it:
	 * its parent gets amended, or rebased, or reparented, and now the branch is
	 * built on a commit that is no longer anybody's tip. Until it is replayed the
	 * shape on paper and the shape in the commits disagree, and the whole point of
	 * recording a stack is to be told when that has happened.
	 *
	 * A root branch is judged against trunk, so trunk has to be named to judge one.
	 * Without it the roots are reported as undecidable rather than as aligned,
	 * because a listing that quietly calls an unknown "fine" is worse than one that
	 * says it does not know.
	 */
	drifted(treePath: string, trunk?: string): Promise<DriftReport>;
	/**
	 * Record where a branch sits, after a replay this object did not run.
	 *
	 * The boundary between a branch's commits and its parent's is written by a
	 * restack as it goes, which is fine until a restack halts. The way out of a halt
	 * is to settle the conflict and resume, and resume belongs to the rebaser, which
	 * knows nothing about stacks and so recorded nothing. That is the documented
	 * recovery from the commonest failure here, and it left the record describing a
	 * branch as it was several commits ago.
	 *
	 * The consequence was not a wrong label. The next restack measured the replay
	 * from that stale boundary, which sat below six of trunk's own commits, and so
	 * handed the branch copies of trunk's history and a conflict on each one.
	 *
	 * Naming no branch means the one checked out, which is where a resume leaves you.
	 * Untracked branches are ignored rather than refused: this is called on the way
	 * out of an operation that has already succeeded, and it has no standing to fail
	 * it.
	 */
	settled(treePath: string, branch?: string): Promise<void>;
	/** Replay the whole stack onto trunk, in order. */
	restack(treePath: string, trunk: string): Promise<RestackOutcome>;
	/**
	 * Fetch trunk, then replay the stack onto where it now is.
	 *
	 * The daily operation, and one verb rather than two because doing half of it
	 * is the mistake: restacking without fetching replays the stack onto a trunk
	 * as stale as the one it was already on, reports success, and leaves
	 * everything exactly as behind as it was.
	 */
	sync(treePath: string, trunk: string): Promise<SyncOutcome>;
}

/** Which branches are out of step with what they sit on. */
export interface DriftReport {
	/** Tracked branches no longer sitting on their parent's tip. */
	drifted: readonly string[];
	/**
	 * Branches whose alignment could not be judged, and why not.
	 *
	 * Reported rather than folded into either answer. Absent means unreported, not
	 * aligned, and a diagram that draws "could not tell" as "fine" is the reason
	 * somebody trusts a stale stack.
	 */
	undecided: readonly string[];
}

/** How a sync went. */
export type SyncOutcome =
	| {
			kind: "synced";
			/** True when fetching actually moved trunk. */
			moved: boolean;
			replay: RestackOutcome;
	  }
	| { kind: "refused"; reason: string };

/** Read one git value, scoped to the tree. */
async function ask(
	exec: Exec,
	treePath: string,
	args: readonly string[],
): Promise<string | undefined> {
	const result = await exec("git", ["-C", treePath, ...args]);
	if (result.code !== 0) return undefined;
	const said = result.stdout.trim();
	return said === "" ? undefined : said;
}

/** Every branch that exists in the repository. */
async function branchesIn(
	exec: Exec,
	treePath: string,
): Promise<readonly string[]> {
	const said = await ask(exec, treePath, [
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
	]);
	return said === undefined ? [] : said.split("\n").filter((one) => one !== "");
}

/** Read the stack from git config. */
async function readStack(
	exec: Exec,
	treePath: string,
): Promise<readonly StackedBranch[]> {
	const said = await ask(exec, treePath, [
		"config",
		"--get-regexp",
		`^branch\\..*\\.(${PARENT_KEY}|${BASE_KEY})$`,
	]);
	if (said === undefined) return [];

	const byName = new Map<string, { parent?: string; base?: string }>();
	for (const line of said.split("\n")) {
		// A root records an empty parent, and git prints that as the key, a
		// space, and nothing. Trimming the output eats that trailing space, so a
		// line with no separator is a key whose value is empty rather than a line
		// to skip. Skipping it made every root branch invisible, which read as
		// "nothing is tracked" and refused every restack.
		const gap = line.indexOf(" ");
		const key = gap === -1 ? line : line.slice(0, gap);
		const value = gap === -1 ? "" : line.slice(gap + 1).trim();
		// `branch.<name>.workParent`, and a branch name may carry dots, so the
		// name is everything between the first and last separator.
		const first = key.indexOf(".");
		const last = key.lastIndexOf(".");
		if (first === -1 || last <= first) continue;
		const name = key.slice(first + 1, last);
		// Lowercased for the same reason the keys are: git decides the case of
		// what it hands back, not the caller that wrote it.
		const which = key.slice(last + 1).toLowerCase();
		const held = byName.get(name) ?? {};
		if (which === PARENT_KEY) held.parent = value;
		if (which === BASE_KEY) held.base = value;
		byName.set(name, held);
	}

	return [...byName.entries()].map(([name, held]) => ({
		name,
		...(held.parent === undefined || held.parent === ""
			? {}
			: { parent: held.parent }),
		...(held.base === undefined ? {} : { base: held.base }),
	}));
}

/** Keep and replay a stack with plain git. */
export function createGitStacks(deps: {
	exec: Exec;
	rebaser: WorkRebaser;
}): WorkStacks {
	const { exec, rebaser } = deps;

	async function set(
		treePath: string,
		branch: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		const at = `branch.${branch}.${key}`;
		if (value === undefined) {
			// A missing key is not an error here: unsetting what was never set
			// is the state the caller asked for.
			await exec("git", ["-C", treePath, "config", "--unset", at]);
			return;
		}
		await exec("git", ["-C", treePath, "config", at, value]);
	}

	/** Where a ref currently points, if it exists. */
	async function tipOf(
		treePath: string,
		ref: string,
	): Promise<string | undefined> {
		return await ask(exec, treePath, ["rev-parse", "--verify", "--quiet", ref]);
	}

	/**
	 * Whether one commit is reachable from another.
	 *
	 * False rather than undefined when git cannot read a ref, because every caller
	 * here is asking in order to skip work, and an unreadable ref is not a reason to
	 * believe there is none to do.
	 */
	async function isAncestor(
		treePath: string,
		maybe: string,
		of: string,
	): Promise<boolean> {
		const said = await exec("git", [
			"-C",
			treePath,
			"merge-base",
			"--is-ancestor",
			maybe,
			of,
		]);
		return said.code === 0;
	}

	/**
	 * Whether a branch still sits on what it is supposed to sit on.
	 *
	 * One rule, in one place, because two callers ask this: a restack, deciding
	 * whether there is anything to replay, and a listing, deciding whether to warn.
	 * They were the same rule written once and read once, which is a rule waiting to
	 * be changed in one place only.
	 *
	 * The record says where the boundary is, and the boundary being the parent's tip
	 * is what aligned means. That cannot be replaced by asking the commits whether
	 * the parent's tip is an ancestor: a reordered branch still contains its old
	 * parent's tip while carrying commits that are no longer its own, so an ancestor
	 * test calls it settled and skips the replay that would put it right. Tried, and
	 * caught by the reorder test, which is the one place that distinction shows.
	 *
	 * But a record can be stale, and one stale case is not drift at all. It is only
	 * written by a restack that ran to completion, so a replay finished any other
	 * way leaves it describing a branch as it was, and that is the documented way out
	 * of a halt. The damage was not a wrong label: the next restack measured from a
	 * boundary sitting below six of trunk's own commits and handed the branch copies
	 * of them, conflicting on every one.
	 *
	 * The two are distinguishable, which is the whole reason this can be fixed here
	 * as well as at the source. A boundary that is itself an ancestor of the parent's
	 * tip, on a branch that already contains that tip, is describing a world that no
	 * longer exists: the branch has since been rebuilt on top of the parent, so there
	 * is nothing to replay and replaying anyway is what duplicates the parent's
	 * history. A reordered branch fails that test, because its boundary is its old
	 * parent's tip, which is a descendant of the new parent rather than an ancestor.
	 *
	 * An earlier version of this comment claimed a merge base would call a branch
	 * aligned with a parent it had never seen. That is not so, and it is worth saying
	 * plainly: where a parent has been rewritten the merge base is the old shared
	 * commit and the parent's tip is the new one, so they differ, which is the drifted
	 * answer and the right one.
	 */
	async function standingOf(
		treePath: string,
		branch: { name: string; base?: string },
		onto: string,
	): Promise<{
		standing: "aligned" | "drifted" | "unknown";
		/** The boundary, which a replay needs and a listing does not. */
		from?: string;
	}> {
		const from =
			branch.base ??
			(await ask(exec, treePath, ["merge-base", onto, branch.name]));
		const tip = await tipOf(treePath, onto);
		if (from === undefined || tip === undefined) {
			return { standing: "unknown", ...(from === undefined ? {} : { from }) };
		}
		if (from === tip) return { standing: "aligned", from };

		// The record disagrees with the parent's tip, which is drift unless the record
		// is the thing that is wrong. Two questions settle it, and both are cheap
		// enough to ask only here, on the branch that looked out of step.
		const holds = await isAncestor(treePath, onto, branch.name);
		const beneath = await isAncestor(treePath, from, onto);
		if (holds && beneath) return { standing: "aligned", from };
		return { standing: "drifted", from };
	}

	/**
	 * Record where a branch now sits on its parent.
	 *
	 * Called after a replay, when the branch genuinely sits on that commit.
	 * Not called when parentage changes, and that distinction is the whole
	 * correctness argument: the base is the boundary between a branch's own
	 * commits and its parent's, so writing the new parent's tip before
	 * anything has been replayed declares a boundary above the branch's own
	 * work and the next restack replays nothing at all.
	 */
	async function recordBase(
		treePath: string,
		branch: string,
		sitsOn: string,
	): Promise<void> {
		const tip = await tipOf(treePath, sitsOn);
		if (tip !== undefined) await set(treePath, branch, BASE_KEY, tip);
	}

	/**
	 * Record the boundary for a branch being tracked for the first time.
	 *
	 * Where the two have diverged, not where the parent is now. A parent that
	 * has moved since the branch was cut would otherwise put the boundary
	 * above commits the branch owns, and they would be dropped by the first
	 * replay rather than carried onto the new base.
	 */
	async function recordDivergence(
		treePath: string,
		branch: string,
		parent: string | undefined,
	): Promise<void> {
		if (parent === undefined) return;
		const shared = await ask(exec, treePath, ["merge-base", parent, branch]);
		if (shared !== undefined) await set(treePath, branch, BASE_KEY, shared);
	}

	return {
		read: (treePath) => readStack(exec, treePath),

		async track(treePath, branch, parent) {
			const exists = await branchesIn(exec, treePath);
			if (!exists.includes(branch)) {
				return {
					kind: "refused",
					reason: `There is no branch called ${branch} in this tree, so there is nothing to track.`,
				};
			}
			if (parent !== undefined && !exists.includes(parent)) {
				return {
					kind: "refused",
					reason: `There is no branch called ${parent} in this tree, so ${branch} cannot sit on it.`,
				};
			}
			const held = await readStack(exec, treePath);

			// Caught here rather than left to orderStack, whose advice for a parent it
			// does not know is "track it, or point this at something that is here".
			// That is sound for a reorder and actively wrong for the commonest track
			// there is: the first branch of a stack, named onto trunk. Following it
			// would make trunk a stack member, and a restack would then replay trunk
			// onto itself. The option that is actually wanted is the one orderStack
			// cannot see, because a pure function over a candidate stack is not told
			// which ref the trunk is.
			if (
				parent !== undefined &&
				!held.some((one) => one.name === parent) &&
				parent !== branch
			) {
				return {
					kind: "refused",
					reason: `${branch} cannot sit on ${parent} yet, because ${parent} is not tracked as part of this stack.\n\nIf ${parent} is your trunk, leave onto off entirely: a branch that sits directly on trunk is a root of the stack, and tracking the trunk would have a restack replay it onto itself.\n\nIf ${parent} belongs in the stack, track it first, then track ${branch} onto it.`,
				};
			}

			const already = held.some((one) => one.name === branch);
			const candidate = already
				? held.map((one) => (one.name === branch ? { ...one, parent } : one))
				: [...held, { name: branch, parent }];
			const fault = orderStack(candidate);
			if (fault.kind === "faulted") return fault;

			await set(treePath, branch, PARENT_KEY, parent ?? "");
			await recordDivergence(treePath, branch, parent);
			return { kind: "shaped", changed: [branch] };
		},

		async untrack(treePath, branch) {
			const held = await readStack(exec, treePath);
			const one = held.find((candidate) => candidate.name === branch);
			if (one === undefined) {
				return {
					kind: "refused",
					reason: `${branch} is not tracked, so there is nothing to forget.`,
				};
			}
			// Whatever sat on it moves down onto its parent. Leaving them
			// pointing at a branch nobody tracks is how a stack becomes
			// unorderable by removing one member of it.
			const changed = [branch];
			for (const above of held.filter(
				(candidate) => candidate.parent === branch,
			)) {
				await set(treePath, above.name, PARENT_KEY, one.parent ?? "");
				// The boundary is left alone. Nothing has been replayed, and the
				// commits this branch owns are still the ones above its old base.
				changed.push(above.name);
			}
			await set(treePath, branch, PARENT_KEY, undefined);
			await set(treePath, branch, BASE_KEY, undefined);
			return { kind: "shaped", changed };
		},

		async reparent(treePath, branch, parent) {
			const held = await readStack(exec, treePath);
			const fault = reparentFault(held, branch, parent);
			if (fault !== undefined) return { kind: "faulted", fault };
			const one = held.find((candidate) => candidate.name === branch);
			if (one?.parent === parent) return { kind: "unchanged" };
			await set(treePath, branch, PARENT_KEY, parent ?? "");
			// Deliberately not touching the boundary: the record has changed and
			// the commits have not, and a restack is what reconciles them.
			return { kind: "shaped", changed: [branch] };
		},

		async reorder(treePath, desired) {
			const held = await readStack(exec, treePath);
			const plan = planReorder(held, desired);
			if (plan.kind === "faulted") return plan;
			if (plan.steps.length === 0) return { kind: "unchanged" };
			for (const step of plan.steps) {
				await set(treePath, step.branch, PARENT_KEY, step.parent ?? "");
				// Same as a single reparent: the shape moves now, the commits move
				// when something replays them.
			}
			return {
				kind: "shaped",
				changed: plan.steps.map((step) => step.branch),
			};
		},

		async settled(treePath, branch) {
			const which =
				branch ??
				(await ask(exec, treePath, ["rev-parse", "--abbrev-ref", "HEAD"]));
			// Mid-replay HEAD is detached and answers "HEAD", which names no branch to
			// record against. Nothing to do rather than something wrong.
			if (which === undefined || which === "HEAD") return;
			const held = await readStack(exec, treePath);
			const one = held.find((candidate) => candidate.name === which);
			if (one?.parent === undefined) return;
			// Where the two now diverge, read from the commits. After a replay that
			// landed, this is the parent's tip; asking the commits rather than assuming
			// it keeps the answer right when the parent moved while the conflict was
			// being settled.
			await recordDivergence(treePath, which, one.parent);
		},

		async drifted(treePath, trunk) {
			const held = await readStack(exec, treePath);
			const drifted: string[] = [];
			const undecided: string[] = [];
			for (const branch of held) {
				const onto = branch.parent ?? trunk;
				if (onto === undefined) {
					// A root with no trunk named. Nothing to compare against.
					undecided.push(branch.name);
					continue;
				}
				const { standing } = await standingOf(treePath, branch, onto);
				if (standing === "unknown") undecided.push(branch.name);
				else if (standing === "drifted") drifted.push(branch.name);
			}
			return { drifted, undecided };
		},

		async restack(treePath, trunk) {
			if (await rebaser.halted(treePath)) {
				return {
					kind: "refused",
					reason:
						"A replay is already part-way through in this tree. Settle it first, then restack.",
				};
			}
			const held = await readStack(exec, treePath);
			if (held.length === 0) {
				return {
					kind: "refused",
					reason:
						"Nothing in this tree is tracked as part of a stack, so there is nothing to replay. Track a branch against what it sits on first.",
				};
			}
			const plan = planRestack(held, trunk);
			if (plan.kind === "faulted") return plan;

			// Where to come back to. A restack that leaves you on whichever
			// branch it replayed last has moved you without asking.
			const started = await ask(exec, treePath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);

			const results: ReplayResult[] = [];
			for (const [at, step] of plan.steps.entries()) {
				// The same question the listing asks, asked the same way. Two rules for
				// "is this branch where it should be" is how a diagram comes to say
				// needs replaying about a branch a restack then calls already in place.
				const { standing, from } = await standingOf(
					treePath,
					{
						name: step.branch,
						...(step.from === undefined ? {} : { base: step.from }),
					},
					step.onto,
				);
				if (standing === "aligned") {
					// Write the boundary down even though nothing was replayed. Aligned
					// means the branch sits on this tip, so this is either the value
					// already there or the repair of a record that had gone stale, and a
					// skip is the one moment that knows which without having to ask. Left
					// undone, a branch reached only by skips stays stale for good, and the
					// reasoning that tolerates a stale record has to hold forever instead
					// of just until the next restack.
					await recordBase(treePath, step.branch, step.onto);
					results.push({
						branch: step.branch,
						onto: step.onto,
						outcome: "already-there",
					});
					continue;
				}

				const checkout = await exec("git", [
					"-C",
					treePath,
					"checkout",
					step.branch,
				]);
				if (checkout.code !== 0) {
					return {
						kind: "refused",
						reason: `Could not check out ${step.branch}: ${checkout.stderr.trim() || `git checkout exited ${checkout.code}`}`,
					};
				}

				const args = ["-C", treePath, "rebase"];
				// The boundary is what separates this branch's commits from its
				// parent's. Without it the branch is handed copies of
				// everything the parent already carries.
				if (from !== undefined) args.push("--onto", step.onto, from);
				else args.push(step.onto);
				// Unattended for the same reason `resume` is: a replay that conflicts
				// and then continues will otherwise reach for an editor, and a
				// restack walks several branches, so one wedged step strands the rest
				// of the stack behind it.
				const replay = await exec("git", unattended(args));

				if (replay.code !== 0) {
					const conflicted = await conflictsIn(exec, treePath);
					results.push({
						branch: step.branch,
						onto: step.onto,
						outcome: "halted",
						conflicted,
					});
					// Everything above this is unreachable until the halt is
					// settled, and saying so is the difference between a
					// partial restack and a mystery.
					for (const later of plan.steps.slice(at + 1)) {
						results.push({
							branch: later.branch,
							onto: later.onto,
							outcome: "skipped",
						});
					}
					return {
						kind: "halted",
						results,
						at: step.branch,
						conflicted,
					};
				}

				await recordBase(treePath, step.branch, step.onto);
				// Now true: the replay just put the branch on that commit.
				results.push({
					branch: step.branch,
					onto: step.onto,
					outcome: "replayed",
				});
			}

			if (started !== undefined && started !== "HEAD") {
				await exec("git", ["-C", treePath, "checkout", started]);
			}
			return {
				kind: "restacked",
				results,
				...(started === undefined || started === "HEAD" ? {} : { on: started }),
			};
		},

		async sync(treePath, trunk) {
			// What the stack is replayed onto, and deliberately not the local branch.
			//
			// This used to fetch `main:main` so the local ref moved, on the reasoning
			// that a bare fetch leaves `main` where it was and replaying onto a stale
			// trunk is the failure this verb exists to prevent. The goal was right and
			// the conclusion was wrong: git refuses to fetch into a branch that is
			// checked out in any worktree of the repo, and trunk checked out in the
			// primary tree while the work happens in a linked one is not an unusual
			// arrangement, it is the normal one. So the daily verb failed outright on
			// the commonest layout, and said only what git said.
			//
			// A remote-tracking ref cannot be checked out anywhere, so it cannot be
			// blocked, and a bare fetch always moves it. Replaying onto that is what
			// the original comment wanted: a trunk that is genuinely current. The
			// local branch is not needed for any of this, which also means a tree with
			// no local trunk at all now syncs.
			const fetchedTrunk = `origin/${trunk}`;
			const before = await tipOf(treePath, fetchedTrunk);

			const fetched = await exec("git", [
				"-C",
				treePath,
				"fetch",
				"origin",
				trunk,
			]);
			if (fetched.code !== 0) {
				const said = [fetched.stderr.trim(), fetched.stdout.trim()]
					.filter((stream) => stream !== "")
					.join("\n");
				// A failed fetch stops the sync. Carrying on would replay the stack
				// onto a trunk as stale as the one it started on and call that
				// success, which is worse than doing nothing and saying so.
				return {
					kind: "refused",
					reason: `Could not fetch ${trunk} from origin, so there is nothing newer to replay onto and nothing was moved.\n\n${said || `git fetch exited ${fetched.code}`}`,
				};
			}

			const after = await tipOf(treePath, fetchedTrunk);
			return {
				kind: "synced",
				moved: before !== after,
				replay: await this.restack(treePath, fetchedTrunk),
			};
		},
	};
}

/** Paths git reports as unmerged. */
async function conflictsIn(
	exec: Exec,
	treePath: string,
): Promise<readonly string[]> {
	const said = await ask(exec, treePath, [
		"diff",
		"--name-only",
		"--diff-filter=U",
	]);
	return said === undefined ? [] : said.split("\n").filter((one) => one !== "");
}
