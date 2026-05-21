/**
 * Stack-wide review action.
 *
 * Runs one council fan-out over the whole stack, then one
 * stack judge. Per-PR judge findings are written into the
 * cursor/snapshot slots that `findings`, `decide`,
 * `fix-next` and `post` already read. Cross-PR judge
 * findings are written to the top-level finding slot used
 * by `scope=stack` decisions.
 */

import type { DiffFile } from "../../lib/internal/github/diff.js";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import type { CouncilDispatch } from "./council.js";
import {
	type CouncilProgress,
	type CouncilProgressEntry,
	NULL_PROGRESS,
	safelyNotify,
	summarizeStreamActivity,
} from "./council-progress.js";
import type { PrMetadata } from "./fetch.js";
import { rememberAllocatedFindings } from "./finding-ids.js";
import type { Finding, ReviewerOutput } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import {
	rememberParticipantIdentities,
	rememberParticipantIdentity,
} from "./participant-identities.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { StackFinding, StackFindingRun } from "./stack-findings.js";
import {
	buildStackJudgePrompt,
	buildStackReviewPrompt,
	parseStackJudgeOutput,
	parseStackReviewOutput,
	type StackJudgePrContext,
	type StackReviewerOutput,
	type StackReviewPrInput,
} from "./stack-review.js";
import type { PrRunSnapshot, PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Helpers needed to resolve non-cursor PR context. */
export interface StackReviewFetchers {
	readonly metadata: (reference: PRReference) => Promise<PrMetadata>;
	readonly diff: (reference: PRReference) => Promise<DiffFile[]>;
}

/** Inputs for `runStackReviewAction`. */
export interface RunStackReviewActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly fetchers: StackReviewFetchers;
	readonly signal?: AbortSignal;
	/** Optional observer for stack review fan-out and judge progress. */
	readonly progress?: CouncilProgress;
	readonly now?: () => Date;
}

/** Per-PR result summary for the user-facing action output. */
export interface StackReviewActionPrResult {
	readonly prNumber: number;
	readonly findingCount: number;
}

/** Full successful result of a stack-wide review. */
export interface StackReviewActionRun {
	readonly id: string;
	readonly startedAt: string;
	readonly cursorPrNumber: number;
	readonly reviewedPrs: readonly StackReviewActionPrResult[];
	readonly crossPrFindingCount: number;
	readonly reviewerOutputs: readonly StackReviewerOutput[];
	readonly warnings: readonly string[];
}

/** Outcome of `runStackReviewAction`. */
export type StackReviewActionResult =
	| { ok: true; run: StackReviewActionRun }
	| { ok: false; error: string };

interface ResolvedPr {
	readonly reference: PRReference;
	readonly metadata: PrMetadata;
	readonly files: readonly DiffFile[];
}

/** Run stack-wide review and write results into workflow state. */
export async function runStackReviewAction(
	input: RunStackReviewActionInput,
): Promise<StackReviewActionResult> {
	const { state } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}
	if (state.council.roster.length === 0) {
		return {
			ok: false,
			error:
				"Council roster is empty. Call pr_workflow action=council-config first.",
		};
	}
	if (state.council.judge === null) {
		return {
			ok: false,
			error:
				"Judge not configured. Call pr_workflow action=judge-config first.",
		};
	}
	if (state.pr.metadata === null) {
		return {
			ok: false,
			error: "PR metadata is missing. Reload before running review.",
		};
	}

	const now = input.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const runId = `stack-review-${startedAt}`;
	const cursorPrNumber = state.pr.reference.number;
	const judge = state.council.judge;
	const progress = input.progress ?? NULL_PROGRESS;
	const progressWarnings: string[] = [];
	const warnings: string[] = [];

	safelyNotify(
		() => progress.start(progressEntries(state.council.roster, judge)),
		"start",
		progressWarnings,
	);

	const resolved = await resolveStackPrs(state, input.fetchers);
	const tip = resolved[resolved.length - 1];
	if (!tip) {
		safelyNotify(() => progress.finish(), "finish", progressWarnings);
		return { ok: false, error: "No PR context available for review." };
	}

	const handle = await input.registry.ensure({
		owner: tip.reference.owner,
		repo: tip.reference.repo,
		sha: tip.metadata.head.sha,
		branch: tip.metadata.head.ref,
	});

	const reviewPrompt = buildStackReviewPrompt({
		cursorPrNumber,
		prs: resolved.map(toPromptPr),
	});

	const settled = await Promise.allSettled(
		state.council.roster.map(async (reviewer) => {
			safelyNotify(
				() => progress.reviewerStarted(reviewer.id),
				`started(${reviewer.id})`,
				progressWarnings,
			);
			try {
				const value = await input.dispatch({
					reviewer,
					prompt: reviewPrompt,
					cwd: handle.path,
					signal: input.signal,
					onEvent: (event) =>
						notifyActivity(progress, progressWarnings, reviewer.id, event),
				});
				const parsed = parseStackReviewOutput(value.finalAssistantText, {
					runId,
					reviewerId: reviewer.id,
					startId: 0,
				});
				const output: StackReviewerOutput = {
					reviewerId: reviewer.id,
					perPr: parsed.perPr,
					crossPr: parsed.crossPr,
					warnings: [...value.warnings, ...parsed.warnings],
				};
				safelyNotify(
					() =>
						progress.reviewerCompleted(
							reviewer.id,
							reviewerProgressOutput(output),
						),
					`completed(${reviewer.id})`,
					progressWarnings,
				);
				return value;
			} catch (err) {
				const message = errorMessage(err);
				safelyNotify(
					() => progress.reviewerFailed(reviewer.id, message),
					`failed(${reviewer.id})`,
					progressWarnings,
				);
				throw err;
			}
		}),
	);

	let nextId = state.nextFindingId;
	const reviewerOutputs: StackReviewerOutput[] = [];
	for (let i = 0; i < settled.length; i++) {
		const reviewer = state.council.roster[i];
		const result = settled[i];
		if (result.status === "rejected") {
			const message = errorMessage(result.reason);
			warnings.push(`${reviewer.id}: Reviewer dispatch failed: ${message}`);
			reviewerOutputs.push({
				reviewerId: reviewer.id,
				perPr: new Map(),
				crossPr: [],
				warnings: [`Reviewer dispatch failed: ${message}`],
			});
			continue;
		}
		const parsed = parseStackReviewOutput(result.value.finalAssistantText, {
			runId,
			reviewerId: reviewer.id,
			startId: nextId,
		});
		nextId = nextIdAfterReviewer(nextId, parsed);
		rememberStackReviewAllocation(state, parsed.perPr, parsed.crossPr);
		const output: StackReviewerOutput = {
			reviewerId: reviewer.id,
			perPr: parsed.perPr,
			crossPr: parsed.crossPr,
			warnings: [...result.value.warnings, ...parsed.warnings],
		};
		for (const warning of output.warnings)
			warnings.push(`${reviewer.id}: ${warning}`);
		reviewerOutputs.push(output);
	}

	const judgeRunId = `stack-judge-${startedAt}`;
	const judgePrompt = buildStackJudgePrompt({
		cursorPrNumber,
		prs: resolved.map(toJudgePr),
		reviewerOutputs,
	});
	safelyNotify(
		() => progress.reviewerStarted(judge.id),
		`started(${judge.id})`,
		progressWarnings,
	);
	const judged = await input.dispatch({
		reviewer: judge,
		prompt: judgePrompt,
		cwd: handle.path,
		signal: input.signal,
		onEvent: (event) =>
			notifyActivity(progress, progressWarnings, judge.id, event),
	});
	const parsedJudge = parseStackJudgeOutput(judged.finalAssistantText, {
		runId: judgeRunId,
		judgeReviewerId: judge.id,
		startId: nextId,
	});
	rememberStackReviewAllocation(state, parsedJudge.perPr, parsedJudge.crossPr);
	for (const warning of [...judged.warnings, ...parsedJudge.warnings]) {
		warnings.push(`${judge.id}: ${warning}`);
	}
	safelyNotify(
		() =>
			progress.reviewerCompleted(
				judge.id,
				judgeProgressOutput(judge.id, parsedJudge.perPr, parsedJudge.crossPr, [
					...judged.warnings,
					...parsedJudge.warnings,
				]),
			),
		`completed(${judge.id})`,
		progressWarnings,
	);

	const reviewedPrs = writePerPrJudgeRuns({
		state,
		resolved,
		cursorPrNumber,
		judge,
		judgeRunId,
		startedAt,
		perPr: parsedJudge.perPr,
		selfSignal: parsedJudge.selfSignal,
		warnings: parsedJudge.warnings,
	});
	state.stackFindingRun = {
		id: judgeRunId,
		startedAt,
		reviewerId: judge.id,
		findings: parsedJudge.crossPr,
		warnings: [...judged.warnings, ...parsedJudge.warnings],
		...(judged.usage ? { usage: judged.usage } : {}),
	} satisfies StackFindingRun;
	rememberParticipantIdentities(state, "reviewer", state.council.roster);
	rememberParticipantIdentity(state, "judge", judge);
	state.stackDecisions = new Map();

	safelyNotify(() => progress.finish(), "finish", progressWarnings);
	warnings.push(...progressWarnings);

	return {
		ok: true,
		run: {
			id: runId,
			startedAt,
			cursorPrNumber,
			reviewedPrs,
			crossPrFindingCount: parsedJudge.crossPr.length,
			reviewerOutputs,
			warnings,
		},
	};
}

/** Render the stack-wide review result for the tool output. */
export function formatStackReviewActionSummary(
	run: StackReviewActionRun,
): string {
	const lines: string[] = [];
	lines.push(`Stack review ${run.id} (cursor #${run.cursorPrNumber})`);
	lines.push(`Started: ${run.startedAt}`);
	lines.push(
		`Reviewers: ${run.reviewerOutputs.length}; cross-PR findings: ${run.crossPrFindingCount}`,
	);
	lines.push("");
	for (const pr of run.reviewedPrs) {
		const marker = pr.prNumber === run.cursorPrNumber ? "▶" : " ";
		const noun = pr.findingCount === 1 ? "finding" : "findings";
		lines.push(`${marker} PR #${pr.prNumber}: ${pr.findingCount} ${noun}`);
	}
	if (run.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const warning of run.warnings) lines.push(`  ! ${warning}`);
	}
	lines.push("");
	lines.push(
		"Cursor PR findings are ready. Run action=findings to review them.",
	);
	lines.push(
		"Stack mates are stashed; action=stack-next / action=stack-prev returns the next PR ref, then action=load hydrates its findings.",
	);
	return lines.join("\n");
}

function progressEntries(
	reviewers: readonly CouncilReviewer[],
	judge: CouncilReviewer,
): CouncilProgressEntry[] {
	return [...reviewers, judge].map((reviewer) => ({
		reviewer,
		state: "pending",
		findingCount: 0,
		warnings: [],
		error: "",
		activity: "",
	}));
}

function notifyActivity(
	progress: CouncilProgress,
	warnings: string[],
	reviewerId: string,
	event: unknown,
): void {
	const activity = summarizeStreamActivity(event);
	if (activity === null) return;
	safelyNotify(
		() => progress.reviewerActivity?.(reviewerId, activity),
		`activity(${reviewerId})`,
		warnings,
	);
}

function reviewerProgressOutput(output: StackReviewerOutput): ReviewerOutput {
	return progressOutput(
		output.reviewerId,
		stackReviewerFindingCount(output),
		output.warnings,
	);
}

function judgeProgressOutput(
	reviewerId: string,
	perPr: ReadonlyMap<number, readonly Finding[]>,
	crossPr: readonly StackFinding[],
	warnings: readonly string[],
): ReviewerOutput {
	return progressOutput(
		reviewerId,
		stackJudgeFindingCount(perPr, crossPr),
		warnings,
	);
}

function progressOutput(
	reviewerId: string,
	findingCount: number,
	warnings: readonly string[],
): ReviewerOutput {
	return {
		reviewerId,
		findings: Array.from({ length: findingCount }, (_, id) =>
			placeholderFinding(id),
		),
		warnings: [...warnings],
	};
}

function placeholderFinding(id: number): Finding {
	return {
		id,
		location: { kind: "global" },
		label: "note",
		decorations: [],
		subject: "progress placeholder",
		discussion: "progress placeholder",
		category: "scope",
		origin: { kind: "user" },
		state: "draft",
	};
}

function stackReviewerFindingCount(output: StackReviewerOutput): number {
	return stackJudgeFindingCount(output.perPr, output.crossPr);
}

function stackJudgeFindingCount(
	perPr: ReadonlyMap<number, readonly unknown[]>,
	crossPr: readonly unknown[],
): number {
	let count = crossPr.length;
	for (const findings of perPr.values()) count += findings.length;
	return count;
}

async function resolveStackPrs(
	state: PrWorkflowState,
	fetchers: StackReviewFetchers,
): Promise<ResolvedPr[]> {
	const pr = state.pr;
	if (pr === null || pr.metadata === null) return [];
	const entries = pr.stack?.entries ?? [
		{
			reference: pr.reference,
			title: pr.metadata.title,
			baseRefName: pr.metadata.base.ref,
			headRefName: pr.metadata.head.ref,
		},
	];
	return Promise.all(
		entries.map(async (entry): Promise<ResolvedPr> => {
			if (entry.reference.number === pr.reference.number) {
				return {
					reference: entry.reference,
					metadata: pr.metadata as PrMetadata,
					files: pr.files ?? [],
				};
			}
			const [metadata, files] = await Promise.all([
				fetchers.metadata(entry.reference),
				fetchers.diff(entry.reference),
			]);
			return { reference: entry.reference, metadata, files };
		}),
	);
}

function toPromptPr(pr: ResolvedPr): StackReviewPrInput {
	return {
		prNumber: pr.reference.number,
		title: pr.metadata.title,
		description: pr.metadata.body,
		files: pr.files,
	};
}

function toJudgePr(pr: ResolvedPr): StackJudgePrContext {
	return { prNumber: pr.reference.number, title: pr.metadata.title };
}

function nextIdAfterReviewer(
	startId: number,
	parsed: {
		perPr: Map<number, readonly unknown[]>;
		crossPr: readonly unknown[];
	},
): number {
	let count = parsed.crossPr.length;
	for (const findings of parsed.perPr.values()) count += findings.length;
	return startId + count;
}

function rememberStackReviewAllocation(
	state: PrWorkflowState,
	perPr: ReadonlyMap<number, readonly Finding[]>,
	crossPr: readonly Finding[],
): void {
	for (const findings of perPr.values()) {
		rememberAllocatedFindings(state, findings);
	}
	rememberAllocatedFindings(state, crossPr);
}

function writePerPrJudgeRuns(input: {
	readonly state: PrWorkflowState;
	readonly resolved: readonly ResolvedPr[];
	readonly cursorPrNumber: number;
	readonly judge: CouncilReviewer;
	readonly judgeRunId: string;
	readonly startedAt: string;
	readonly perPr: Map<number, import("./findings.js").Finding[]>;
	readonly selfSignal: JudgeRun["selfSignal"];
	readonly warnings: readonly string[];
}): StackReviewActionPrResult[] {
	const results: StackReviewActionPrResult[] = [];
	for (const pr of input.resolved) {
		const findings = input.perPr.get(pr.reference.number) ?? [];
		const judgeRun: JudgeRun = {
			id: `${input.judgeRunId}-pr-${pr.reference.number}`,
			startedAt: input.startedAt,
			judgeReviewerId: input.judge.id,
			selfSignal: input.selfSignal,
			consolidatedFindings: findings,
			warnings: [...input.warnings],
		};
		if (pr.reference.number === input.cursorPrNumber) {
			input.state.council.lastRun = null;
			input.state.council.lastJudge = judgeRun;
			input.state.council.lastCritique = null;
			input.state.council.decisions = new Map();
		} else {
			input.state.stackRuns.set(
				pr.reference.number,
				replaceWithStackJudgeSnapshot(judgeRun),
			);
		}
		results.push({
			prNumber: pr.reference.number,
			findingCount: findings.length,
		});
	}
	return results;
}

function replaceWithStackJudgeSnapshot(run: JudgeRun): PrRunSnapshot {
	return {
		lastRun: null,
		lastJudge: run,
		lastCritique: null,
		decisions: new Map<number, FindingDecision>(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
