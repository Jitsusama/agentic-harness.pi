/**
 * Stack-level review convenience action.
 *
 * `review-all` is a thin Phase A wrapper: run
 * `council-all`, then immediately run `judge-all` over
 * the council results that were just stashed. It does
 * not introduce a new schema or prompt. The downstream
 * review surface remains the existing per-PR
 * `findings`/`decide`/`post` flow.
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { CouncilDispatch } from "./council.js";
import {
	type CouncilAllRun,
	formatCouncilAllSummary,
	runCouncilAllAction,
} from "./council-all-action.js";
import type { PrMetadata } from "./fetch.js";
import {
	formatJudgeAllSummary,
	type JudgeAllRun,
	runJudgeAllAction,
} from "./judge-all-action.js";
import type { PrWorkflowState } from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Helpers needed by both bulk phases. */
export interface ReviewAllFetchers {
	readonly metadata: (reference: PRReference) => Promise<PrMetadata>;
	readonly diff: (reference: PRReference) => Promise<DiffFile[]>;
}

/** Inputs for `runReviewAllAction`. */
export interface RunReviewAllActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly fetchers: ReviewAllFetchers;
	readonly now?: () => Date;
}

/** Full result returned by `runReviewAllAction`. */
export interface ReviewAllRun {
	readonly council: CouncilAllRun;
	readonly judge: JudgeAllRun;
}

/** Outcome of the review-all wrapper. */
export type ReviewAllActionResult =
	| { ok: true; run: ReviewAllRun }
	| { ok: false; error: string };

/** Run council-all, then judge-all, for the loaded stack. */
export async function runReviewAllAction(
	input: RunReviewAllActionInput,
): Promise<ReviewAllActionResult> {
	const council = await runCouncilAllAction({
		state: input.state,
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		fetchers: input.fetchers,
		now: input.now,
	});
	if (!council.ok) {
		return council;
	}

	const judge = await runJudgeAllAction({
		state: input.state,
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		fetchers: input.fetchers,
		now: input.now,
	});
	if (!judge.ok) {
		return judge;
	}

	return { ok: true, run: { council: council.run, judge: judge.run } };
}

/** Render the combined review-all result for the tool output. */
export function formatReviewAllSummary(run: ReviewAllRun): string {
	return [
		formatCouncilAllSummary(run.council),
		"",
		"---",
		"",
		formatJudgeAllSummary(run.judge),
		"",
		"All available PRs have council and judge runs. Use action=findings on the cursor PR, then stack-next / stack-prev to review each stashed PR.",
	].join("\n");
}
