/**
 * Replaying a held tree's branch onto a base, and carrying on or backing
 * out of a replay that stopped, with the halt said so the next move is
 * obvious.
 */

import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import type { HeldTree } from "../../../lib/core/work/broker.ts";
import { FETCH_MS, refreshStart } from "../../../lib/core/work/fresh-start.ts";
import {
	createGitRebaser,
	type Settling,
	type TrunkLeft,
} from "../../../lib/core/work/rebase.ts";
import { createGitStacks } from "../../../lib/core/work/stacks.ts";
import { remoteTrunk } from "../../../lib/core/work/tree-git.ts";
import { GLYPH } from "../render.ts";
import { settlingLines } from "./settling.ts";
import { type Answer, refuse, say } from "./shared.ts";

/**
 * Replay a branch, or end a replay that stopped.
 *
 * The three verbs live together because they are one state machine, and the
 * halt is the state worth writing carefully: a caller who is told only that
 * something failed has to work out from the repository itself whether a rebase
 * is part-way through, which is exactly the knowledge the tool already had.
 */
export async function replay(
	exec: Exec,
	found: HeldTree,
	action: "rebase" | "resume" | "abandon",
	onto: string | undefined,
	signal?: AbortSignal,
): Promise<Answer> {
	const rebaser = createGitRebaser({ exec });

	if (action === "resume" || action === "abandon") {
		const outcome =
			action === "resume"
				? await rebaser.resume(found.path)
				: await rebaser.abandon(found.path);
		if (outcome.kind === "refused") {
			return refuse(`${GLYPH.refused} ${outcome.reason}`);
		}
		if (outcome.kind === "halted") {
			// Said the same way the first halt is said. A stack halts more than once,
			// and the second one used to print no branch at all, which is the moment
			// a reader most needs to know which branch they are being asked about.
			return refuse(
				haltLines(outcome.conflicted, subjectOfHalt(outcome), outcome),
			);
		}
		if (outcome.kind === "abandoned") {
			return say(
				`${GLYPH.tree} Replay abandoned. ${outcome.branch} is back where it was.`,
				{ ok: true, branch: outcome.branch },
			);
		}
		// The replay landed, so the stack's record of where this branch sits is now
		// out of date, and only a restack that ran to completion used to update it. A
		// halt settled by hand is the documented way out of the commonest failure
		// here, and it left the boundary describing the branch as it was before the
		// replay: the next restack then measured from there and handed the branch
		// copies of its parent's history.
		await createGitStacks({ exec, rebaser }).settled(found.path);
		return say(
			[
				`${GLYPH.tree} ${outcome.branch} replayed.`,
				...settlingLines(outcome),
			].join("\n"),
			{ ok: true, branch: outcome.branch },
		);
	}

	if (onto === undefined) {
		return refuse(
			`${GLYPH.refused} Name what to replay onto, with onto. A rebase has no sensible default: replaying onto the wrong base rewrites every commit on the branch.`,
		);
	}

	// A remote's branch is replayed onto as the remote holds it: replayed
	// onto the last fetch's origin/main, a branch went up a merge behind and
	// its checks ran against a main that was no longer there.
	const fetching = spawnExec({
		...(signal ? { signal } : {}),
		timeoutMs: FETCH_MS,
	});
	const fresh = await refreshStart(fetching, found.path, onto, signal);
	// Which commits are trunk's is judged by the remote's trunk, so it is
	// fetched too: one fetched long ago would take trunk's later commits on
	// the branch for its own.
	const trunk = await remoteTrunk(exec, found.path);
	const trunkFresh =
		trunk === undefined || trunk === fresh.start
			? undefined
			: await refreshStart(fetching, found.path, trunk, signal);
	const stale = [fresh.stale, trunkFresh?.stale].filter(
		(said): said is string => said !== undefined,
	);
	const named = (ref: string) => (ref === fresh.start ? onto : ref);
	const outcome = await rebaser.rebase(found.path, fresh.start);
	if (outcome.kind === "refused") {
		return refuse([`${GLYPH.refused} ${outcome.reason}`, ...stale].join("\n"));
	}
	if (outcome.kind === "already-there") {
		return say(
			[
				`${GLYPH.clean} ${outcome.branch} is already on top of ${named(outcome.onto)}. Nothing to replay.`,
				...stale,
			].join("\n"),
			{ ok: true, branch: outcome.branch, replayed: 0 },
		);
	}
	if (outcome.kind === "halted") {
		return refuse(
			[
				haltLines(
					outcome.conflicted,
					`${outcome.branch} onto ${named(outcome.onto)}${outcome.at === undefined ? "" : `, at ${outcome.at}`}`,
					outcome,
				),
				...cutLines(outcome.trunk, named(outcome.onto)),
			].join("\n"),
		);
	}
	// A branch with no commits of its own isn't replayed but moved up to a
	// base that moved on, and "0 commits" would read as nothing happening.
	const done =
		outcome.commits === 0
			? `${outcome.branch} moved up to ${named(outcome.onto)}, with no commits of its own to replay.`
			: `${outcome.branch} replayed onto ${named(outcome.onto)}, ${outcome.commits} ${outcome.commits === 1 ? "commit" : "commits"}.`;
	return say(
		[
			`${GLYPH.tree} ${done}`,
			...cutLines(outcome.trunk, named(outcome.onto)),
			...settlingLines(outcome),
			...stale,
		].join("\n"),
		{
			ok: true,
			branch: outcome.branch,
			replayed: outcome.commits,
		},
	);
}

/**
 * How a halt names itself, when git's replay state said enough to.
 *
 * Built to read the same whether it came from starting a replay or carrying one
 * on, because to the person reading it they are the same event.
 */
function subjectOfHalt(halt: {
	branch?: string;
	onto?: string;
	at?: string;
}): string | undefined {
	if (halt.branch === undefined) return undefined;
	const onto = halt.onto ? ` onto ${halt.onto}` : "";
	const at = halt.at ? `, at ${halt.at}` : "";
	return `${halt.branch}${onto}${at}`;
}

/**
 * A halt, said so the next move is obvious.
 *
 * The paths are the work, and the two verbs are the only ways out, so both are
 * named. A halt is reported through the refusal path because the tree is not
 * where it was asked to be, but it is a state to act on rather than an error.
 */
/**
 * What a replay started from trunk says, since it left trunk's commits
 * off the branch where a plain one would have carried them.
 */
function cutLines(trunk: TrunkLeft | undefined, onto: string): string[] {
	if (trunk === undefined) return [];
	const commits = trunk.left === 1 ? "commit" : "commits";
	return [
		`   Replayed from ${trunk.name}: the branch held ${trunk.left} of its ${commits} that ${onto} lacks, which stay on ${trunk.name} rather than being carried as the branch's own.`,
	];
}

function haltLines(
	conflicted: readonly string[],
	what?: string,
	settling?: Settling,
): string {
	const head =
		what === undefined ? "Replay halted." : `Replay halted: ${what}.`;
	const paths =
		conflicted.length === 0
			? ["   nothing is unmerged, so something else stopped it"]
			: conflicted.map((path) => `   ${GLYPH.dirty} ${path}`);
	const before = settlingLines(settling);
	return [
		`${GLYPH.refused} ${head}`,
		...paths,
		...(before.length > 0 ? ["", "Settled on the way:", ...before] : []),
		"",
		"Settle these, then resume: a text file edited clean of its markers is staged by the resume itself. Or abandon, and the tree goes back to where it started.",
	].join("\n");
}
