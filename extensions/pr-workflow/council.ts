/**
 * Council orchestrator.
 *
 * Composes the council primitives:
 *
 *   - `WorktreeRegistry` provisions one shared worktree
 *     at the PR head SHA.
 *   - `buildReviewerPrompt` builds the round-1 prompt
 *     from the target.
 *   - `dispatch` (injected; production = `runReviewer`)
 *     spawns one pi subagent per reviewer with the
 *     worktree path as cwd.
 *   - `parseReviewerOutput` turns each reviewer's final
 *     assistant text into Findings, stamping origin with
 *     `runId` and `reviewerId` and allocating ids from a
 *     monotonic sequence so findings stay
 *     globally-numbered within the run.
 *
 * Fan-out is concurrent; one reviewer failing surfaces
 * as a warning on that reviewer's output rather than
 * aborting the run. Worktree cleanup is the caller's
 * responsibility (via the registry); we do not release
 * the tree at the end of a council run because
 * subsequent rounds will reuse it.
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { CouncilRun, ReviewerOutput } from "./findings.js";
import { parseReviewerOutput } from "./parse.js";
import { buildReviewerPrompt } from "./prompts.js";
import type {
	CouncilReviewer,
	RunPi,
	RunReviewerOptions,
	RunReviewerResult,
} from "./reviewer.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Target a council run inspects. */
export interface CouncilTarget {
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;
	readonly prNumber: number;
	readonly title: string;
	readonly description: string;
	readonly files: DiffFile[];
}

/** Injectable reviewer-dispatch function. */
export type CouncilDispatch = (
	opts: Omit<RunReviewerOptions, "runPi"> & { readonly runPi?: RunPi },
) => Promise<RunReviewerResult>;

/** Options for one council run. */
export interface RunCouncilOptions {
	readonly runId: string;
	readonly target: CouncilTarget;
	readonly reviewers: readonly CouncilReviewer[];
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
}

/** Run round-1 fan-out against `target`. */
export async function runCouncil(
	options: RunCouncilOptions,
): Promise<CouncilRun> {
	const handle = await options.registry.ensure({
		owner: options.target.owner,
		repo: options.target.repo,
		sha: options.target.sha,
	});

	const prompt = buildReviewerPrompt({
		prTitle: options.target.title,
		prDescription: options.target.description,
		files: options.target.files,
	});

	// Each reviewer needs a contiguous slice of finding ids.
	// We can't know how many findings each will return
	// until they're parsed, so we serialize id assignment
	// AFTER results land — dispatch is still concurrent.
	const settled = await Promise.allSettled(
		options.reviewers.map((reviewer) =>
			options.dispatch({
				reviewer,
				prompt,
				cwd: handle.path,
				signal: options.signal,
			}),
		),
	);

	let nextId = 1;
	const reviewerOutputs: ReviewerOutput[] = [];
	for (let i = 0; i < settled.length; i++) {
		const reviewer = options.reviewers[i];
		const result = settled[i];
		if (result.status === "rejected") {
			const message =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			reviewerOutputs.push({
				reviewerId: reviewer.id,
				findings: [],
				warnings: [`Reviewer dispatch failed: ${message}`],
			});
			continue;
		}
		const value = result.value;
		const parsed = parseReviewerOutput(value.finalAssistantText, {
			reviewerId: reviewer.id,
			runId: options.runId,
			startId: nextId,
		});
		nextId += parsed.findings.length;
		reviewerOutputs.push({
			reviewerId: reviewer.id,
			findings: parsed.findings,
			warnings: [...value.warnings, ...parsed.warnings],
		});
	}

	return {
		id: options.runId,
		startedAt: new Date().toISOString(),
		target: { kind: "diff", prNumber: options.target.prNumber },
		reviewerOutputs,
		worktreePath: handle.path,
	};
}
