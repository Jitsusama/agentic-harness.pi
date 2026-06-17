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
import type {
	CouncilReviewer,
	RunPi,
	RunReviewerOptions,
	RunReviewerResult,
} from "../../lib/subagent/subagent.js";
import { isReviewerCancelledError } from "./cancellation.js";
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
import type { ReviewThreadPromptContext } from "./thread-context.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Target a council run inspects. */
export interface CouncilTarget {
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;
	readonly branch?: string;
	readonly prNumber: number;
	readonly title: string;
	readonly description: string;
	readonly files: DiffFile[];
	readonly threadContext?: ReviewThreadPromptContext;
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
	/**
	 * Resolve a reviewer's standing charter (its persona prose)
	 * by reviewer id. The charter rides to the subagent as the
	 * system prompt. Injected so the council stays
	 * filesystem-free: the action layer reads persona files and
	 * supplies this. Reviewers with no charter dispatch without
	 * a system prompt, exactly as before personas existed.
	 */
	readonly charterFor?: (reviewerId: string) => string | undefined;
	readonly signal?: AbortSignal;
	/**
	 * First session-global finding id available to this run.
	 * Used only when `allocate` is absent (the fake-runner and
	 * older tests). Production passes `allocate` instead so
	 * concurrent runs can't snapshot the same starting id.
	 */
	readonly startId?: number;
	/**
	 * Reserve a contiguous block of `count` finding ids and
	 * return its first id. Called synchronously per reviewer
	 * once the fan-out has settled, so two runs sharing one
	 * session never overlap: the first run's loop drains and
	 * advances the session counter before the second's begins.
	 */
	readonly allocate?: (count: number) => number;
	/** Provider or repository context appended to reviewer prompts. */
	readonly promptAddendum?: string;
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
	/**
	 * Resolve the reviewer's standing charter by id, forwarded
	 * to the subagent as its system prompt. Same contract as
	 * {@link RunCouncilOptions.charterFor}; the retry path honours
	 * it so a retried reviewer keeps its persona voice.
	 */
	readonly charterFor?: (reviewerId: string) => string | undefined;
	readonly signal?: AbortSignal;
	/** Provider or repository context appended to the reviewer prompt. */
	readonly promptAddendum?: string;
	/**
	 * Starting finding id. Findings get assigned ids
	 * sequentially from this value. Used only when `allocate`
	 * is absent.
	 */
	readonly startId: number;
	/**
	 * Reserve a contiguous block of `count` finding ids and
	 * return its first id. Called synchronously once the
	 * reviewer output is parsed, so a retry concurrent with
	 * another run never overlaps ids.
	 */
	readonly allocate?: (count: number) => number;
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
		...(options.target.branch ? { branch: options.target.branch } : {}),
	});
	const prompt = buildReviewerPrompt({
		prTitle: options.target.title,
		prDescription: options.target.description,
		files: options.target.files,
		...(options.target.threadContext
			? { threadContext: options.target.threadContext }
			: {}),
		...(options.promptAddendum
			? { promptAddendum: options.promptAddendum }
			: {}),
	});
	const charter = options.charterFor?.(options.reviewer.id);
	try {
		const value = await options.dispatch({
			reviewer: options.reviewer,
			prompt,
			cwd: handle.path,
			runId: options.runId,
			signal: options.signal,
			expectedVerificationStage: "council",
			...(charter ? { systemPrompt: charter } : {}),
		});
		const counted = parseReviewerOutput(value.finalAssistantText, {
			reviewerId: options.reviewer.id,
			runId: options.runId,
			startId: 0,
			diffFiles: options.target.files,
		});
		const base = options.allocate?.(counted.findings.length) ?? options.startId;
		const parsed = parseReviewerOutput(value.finalAssistantText, {
			reviewerId: options.reviewer.id,
			runId: options.runId,
			startId: base,
			diffFiles: options.target.files,
		});
		return {
			reviewerId: options.reviewer.id,
			findings: parsed.findings,
			warnings: [...value.warnings, ...parsed.warnings],
			...(value.usage ? { usage: value.usage } : {}),
			...(value.verification ? { verification: value.verification } : {}),
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
	const startedAt = new Date().toISOString();
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

	// finish() restores the editor the panel captured on
	// start(); it must run no matter how the run exits, or a
	// throw (notably from registry.ensure) strands the panel and
	// the user's keyboard. Guarded so it fires exactly once.
	let finished = false;
	const finishOnce = (): void => {
		if (finished) return;
		finished = true;
		safelyNotify(() => progress.finish(), "finish", progressWarnings);
	};

	try {
		const handle = await options.registry.ensure({
			owner: options.target.owner,
			repo: options.target.repo,
			sha: options.target.sha,
			...(options.target.branch ? { branch: options.target.branch } : {}),
		});

		const prompt = buildReviewerPrompt({
			prTitle: options.target.title,
			prDescription: options.target.description,
			files: options.target.files,
			...(options.target.threadContext
				? { threadContext: options.target.threadContext }
				: {}),
			...(options.promptAddendum
				? { promptAddendum: options.promptAddendum }
				: {}),
		});

		// Each reviewer needs a contiguous slice of finding ids.
		// We can't know how many findings each will return
		// until they're parsed, so we serialize id assignment
		// AFTER results land — dispatch is still concurrent.
		const settled = await Promise.allSettled(
			options.reviewers.map(async (reviewer) => {
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
				const charter = options.charterFor?.(reviewer.id);
				try {
					const value = await options.dispatch({
						reviewer,
						prompt,
						cwd: handle.path,
						runId: options.runId,
						signal: options.signal,
						expectedVerificationStage: "council",
						onEvent,
						...(charter ? { systemPrompt: charter } : {}),
					});
					const parsed = parseReviewerOutput(value.finalAssistantText, {
						reviewerId: reviewer.id,
						runId: options.runId,
						startId: 0,
						diffFiles: options.target.files,
					});
					safelyNotify(
						() =>
							progress.reviewerCompleted(reviewer.id, {
								reviewerId: reviewer.id,
								findings: parsed.findings,
								warnings: [...value.warnings, ...parsed.warnings],
								...(value.usage ? { usage: value.usage } : {}),
							}),
						`completed(${reviewer.id})`,
						progressWarnings,
					);
					return value;
				} catch (err) {
					if (isReviewerCancelledError(err)) {
						safelyNotify(
							() => progress.reviewerCancelled?.(reviewer.id),
							`cancelled(${reviewer.id})`,
							progressWarnings,
						);
					} else {
						const message = err instanceof Error ? err.message : String(err);
						safelyNotify(
							() => progress.reviewerFailed(reviewer.id, message),
							`failed(${reviewer.id})`,
							progressWarnings,
						);
					}
					throw err;
				}
			}),
		);

		let nextId = options.startId ?? 1;
		// Allocate ids at assignment time. When `allocate` is
		// present it reads-and-advances the live session counter
		// synchronously, so concurrent runs get disjoint blocks;
		// otherwise we fall back to the local `startId` sequence.
		const allocate =
			options.allocate ??
			((count: number): number => {
				const start = nextId;
				nextId += count;
				return start;
			});
		const reviewerOutputs: ReviewerOutput[] = [];
		for (let i = 0; i < settled.length; i++) {
			const reviewer = options.reviewers[i];
			const result = settled[i];
			if (result.status === "rejected") {
				const cancelled = isReviewerCancelledError(result.reason);
				const message = cancelled
					? "Reviewer cancelled by user."
					: result.reason instanceof Error
						? result.reason.message
						: String(result.reason);
				reviewerOutputs.push({
					reviewerId: reviewer.id,
					findings: [],
					warnings: [
						cancelled ? message : `Reviewer dispatch failed: ${message}`,
					],
				});
				continue;
			}
			const value = result.value;
			// Parse once to learn the count, reserve that many ids,
			// then parse again from the reserved base so finding ids
			// and their origins carry the session-global numbers.
			const counted = parseReviewerOutput(value.finalAssistantText, {
				reviewerId: reviewer.id,
				runId: options.runId,
				startId: 0,
				diffFiles: options.target.files,
			});
			const base = allocate(counted.findings.length);
			const parsed = parseReviewerOutput(value.finalAssistantText, {
				reviewerId: reviewer.id,
				runId: options.runId,
				startId: base,
				diffFiles: options.target.files,
			});
			const output: ReviewerOutput = {
				reviewerId: reviewer.id,
				findings: parsed.findings,
				warnings: [...value.warnings, ...parsed.warnings],
				...(value.usage ? { usage: value.usage } : {}),
				...(value.verification ? { verification: value.verification } : {}),
			};
			reviewerOutputs.push(output);
		}

		finishOnce();

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
			startedAt,
			target: { kind: "diff", prNumber: options.target.prNumber },
			reviewerOutputs,
		};
	} finally {
		finishOnce();
	}
}
