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
import {
	type CouncilProgress,
	type CouncilProgressEntry,
	NULL_PROGRESS,
	safelyNotify,
	summarizeStreamActivity,
} from "./council-progress.js";
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
	/** First session-global finding id available to this run. */
	readonly startId?: number;
	/**
	 * Optional observer notified as each reviewer
	 * starts, completes or fails. Lets the UI render
	 * progress while a fan-out is in flight.
	 */
	readonly progress?: CouncilProgress;
}

/** Options for a single-reviewer council dispatch. */
export interface RunOneReviewerOptions {
	readonly runId: string;
	readonly target: CouncilTarget;
	readonly reviewer: CouncilReviewer;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	/**
	 * Starting finding id. Findings get assigned ids
	 * sequentially from this value. Callers retrying one
	 * reviewer mid-run pass `max(existingIds) + 1` to
	 * avoid collisions with un-retried output.
	 */
	readonly startId: number;
}

/**
 * Run a single reviewer against `target`. Acquires the
 * shared worktree, builds the prompt, dispatches, and
 * parses output, all with the same resilience as
 * `runCouncil` (rejections become warnings on the
 * output). The caller decides where the resulting
 * `ReviewerOutput` lands.
 */
export async function runOneCouncilReviewer(
	options: RunOneReviewerOptions,
): Promise<ReviewerOutput> {
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
	try {
		const value = await options.dispatch({
			reviewer: options.reviewer,
			prompt,
			cwd: handle.path,
			signal: options.signal,
		});
		const parsed = parseReviewerOutput(value.finalAssistantText, {
			reviewerId: options.reviewer.id,
			runId: options.runId,
			startId: options.startId,
		});
		return {
			reviewerId: options.reviewer.id,
			findings: parsed.findings,
			warnings: [...value.warnings, ...parsed.warnings],
			...(value.usage ? { usage: value.usage } : {}),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			reviewerId: options.reviewer.id,
			findings: [],
			warnings: [`Reviewer dispatch failed: ${message}`],
		};
	}
}

/** Run round-1 fan-out against `target`. */
export async function runCouncil(
	options: RunCouncilOptions,
): Promise<CouncilRun> {
	const progress = options.progress ?? NULL_PROGRESS;
	const progressWarnings: string[] = [];

	const startSnapshot: CouncilProgressEntry[] = options.reviewers.map(
		(reviewer) => ({
			reviewer,
			state: "pending",
			findingCount: 0,
			warnings: [],
			error: "",
			activity: "",
		}),
	);
	safelyNotify(() => progress.start(startSnapshot), "start", progressWarnings);

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
		options.reviewers.map((reviewer) => {
			safelyNotify(
				() => progress.reviewerStarted(reviewer.id),
				`started(${reviewer.id})`,
				progressWarnings,
			);
			const onEvent = (event: Record<string, unknown>): void => {
				const activity = summarizeStreamActivity(event);
				if (activity === null) return;
				safelyNotify(
					() => progress.reviewerActivity?.(reviewer.id, activity),
					`activity(${reviewer.id})`,
					progressWarnings,
				);
			};
			return options.dispatch({
				reviewer,
				prompt,
				cwd: handle.path,
				signal: options.signal,
				onEvent,
			});
		}),
	);

	let nextId = options.startId ?? 1;
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
			safelyNotify(
				() => progress.reviewerFailed(reviewer.id, message),
				`failed(${reviewer.id})`,
				progressWarnings,
			);
			continue;
		}
		const value = result.value;
		const parsed = parseReviewerOutput(value.finalAssistantText, {
			reviewerId: reviewer.id,
			runId: options.runId,
			startId: nextId,
		});
		nextId += parsed.findings.length;
		const output: ReviewerOutput = {
			reviewerId: reviewer.id,
			findings: parsed.findings,
			warnings: [...value.warnings, ...parsed.warnings],
			...(value.usage ? { usage: value.usage } : {}),
		};
		reviewerOutputs.push(output);
		safelyNotify(
			() => progress.reviewerCompleted(reviewer.id, output),
			`completed(${reviewer.id})`,
			progressWarnings,
		);
	}

	safelyNotify(() => progress.finish(), "finish", progressWarnings);

	if (progressWarnings.length > 0) {
		// Surface reporter failures as warnings on the
		// first reviewer so the user notices, without
		// derailing the actual run output.
		const first = reviewerOutputs[0];
		if (first) {
			first.warnings.push(...progressWarnings);
		}
	}

	return {
		id: options.runId,
		startedAt: new Date().toISOString(),
		target: { kind: "diff", prNumber: options.target.prNumber },
		reviewerOutputs,
	};
}
