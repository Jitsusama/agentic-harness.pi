/**
 * Action handler for the `critique` tool action.
 *
 * Runs round 3 against the most recent council + judge
 * runs, using the configured roster. Stores the
 * resulting CritiqueRun in `state.council.lastCritique`.
 *
 * Mirrors `judge-action.ts` and `council-action.ts`: a
 * pure function over `PrWorkflowState` with the dispatch
 * boundary injected so unit tests don't spawn pi.
 */

import { STALE_RUNTIME_WARNING_PREFIX } from "../../lib/subagent/health.js";
import type { CouncilDispatch } from "./council.js";
import { buildCharterMap } from "./council-action.js";
import type { CouncilProgress } from "./council-progress.js";
import {
	type CritiqueRun,
	type ReviewerCritiqueOutput,
	runCritique,
	runOneCritiqueReviewer,
} from "./critique.js";
import type {
	CouncilRun,
	Finding,
	FindingLocation,
	ReviewerOutput,
} from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { ReviewContextProviderBroker } from "./review-context.js";
import { composeRunAddendum } from "./run-intent.js";
import type { PrWorkflowState } from "./state.js";
import {
	loadReviewThreadPromptContext,
	type ReviewThreadsFetcher,
} from "./thread-context.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Inputs for `runCritiqueAction`. */
export interface RunCritiqueActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly reviewContexts?: ReviewContextProviderBroker;
	readonly fetchThreads?: ReviewThreadsFetcher;
	readonly progress?: CouncilProgress;
	readonly signal?: AbortSignal;
	readonly now?: () => Date;
	/**
	 * Resolve a persona id to its charter, so critique reviewers
	 * keep their persona lens. Same contract as the council action;
	 * critique reuses the same personas.
	 */
	readonly resolveCharter?: (personaId: string) => string | undefined;
	/** The user's per-run intent for this critique run, merged into the prompt addendum. */
	readonly intent?: string;
}

/** Result of running the critique. */
export type CritiqueActionResult =
	| { ok: true; run: CritiqueRun; judge: JudgeRun }
	| { ok: false; error: string };

/**
 * Run round 3: refuses without a council run, judge run,
 * or roster; otherwise dispatches the roster and
 * persists the result.
 */
export async function runCritiqueAction(
	input: RunCritiqueActionInput,
): Promise<CritiqueActionResult> {
	const { state } = input;
	if (state.council.lastRun === null) {
		const stackCritique = await runStackCritiqueAction(input);
		if (stackCritique !== null) return stackCritique;
		return {
			ok: false,
			error: "No council run available. Call pr_workflow action=council first.",
		};
	}
	if (state.council.lastJudge === null) {
		return {
			ok: false,
			error: "No judge run available. Call pr_workflow action=judge first.",
		};
	}
	if (state.council.roster.length === 0) {
		return {
			ok: false,
			error:
				"Critique roster is empty. Configure reviewers via " +
				"action=council-config first.",
		};
	}
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "PR is not fully loaded; reload before critiquing.",
		};
	}

	const now = input.now ?? (() => new Date());
	const runId = `critique-${now().toISOString()}`;
	const target = {
		owner: state.pr.reference.owner,
		repo: state.pr.reference.repo,
		sha: state.pr.metadata.head.sha,
		branch: state.pr.metadata.head.ref,
	};
	const [providerAddendum, threadContext] = await Promise.all([
		input.reviewContexts?.promptAddendum({
			...target,
			prNumber: state.pr.reference.number,
			stage: "critique",
		}),
		loadReviewThreadPromptContext(state, input.fetchThreads),
	]);
	const promptAddendum = composeRunAddendum(providerAddendum, input.intent);
	const charters = buildCharterMap(state.council.roster, input.resolveCharter);
	const run = await runCritique({
		runId,
		council: state.council.lastRun,
		judge: state.council.lastJudge,
		roster: state.council.roster,
		target,
		registry: input.registry,
		dispatch: input.dispatch,
		threadContext,
		progress: input.progress,
		signal: input.signal,
		charterFor: (id) => charters.get(id),
		...(promptAddendum ? { promptAddendum } : {}),
	});
	state.council.lastCritique = run;
	return { ok: true, run, judge: state.council.lastJudge };
}

async function runStackCritiqueAction(
	input: RunCritiqueActionInput,
): Promise<CritiqueActionResult | null> {
	const { state } = input;
	if (state.stackFindingRun === null) return null;
	if (state.council.roster.length === 0) {
		return {
			ok: false,
			error:
				"Critique roster is empty. Configure reviewers via " +
				"action=council-config first.",
		};
	}
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "PR is not fully loaded; reload before critiquing.",
		};
	}
	const judge = combinedStackJudge(state);
	if (judge === null) {
		return {
			ok: false,
			error:
				"Stack review findings are not loaded. Navigate the stack or rerun " +
				"pr_workflow action=review before critiquing.",
		};
	}
	const now = input.now ?? (() => new Date());
	const target = {
		owner: state.pr.reference.owner,
		repo: state.pr.reference.repo,
		sha: state.pr.metadata.head.sha,
		branch: state.pr.metadata.head.ref,
	};
	const [promptAddendum, threadContext] = await Promise.all([
		input.reviewContexts?.promptAddendum({
			...target,
			prNumber: state.pr.reference.number,
			stage: "critique",
		}),
		loadReviewThreadPromptContext(state, input.fetchThreads),
	]);
	const run = await runCritique({
		runId: `stack-critique-${now().toISOString()}`,
		council: emptyCouncilForStackCritique(state),
		judge,
		roster: state.council.roster,
		target,
		registry: input.registry,
		dispatch: input.dispatch,
		threadContext,
		progress: input.progress,
		signal: input.signal,
		...(promptAddendum ? { promptAddendum } : {}),
	});
	rememberStackCritique(state, run);
	return { ok: true, run, judge };
}

/** Inputs for `retryCritiqueReviewer`. */
export interface RetryCritiqueReviewerInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly reviewContexts?: ReviewContextProviderBroker;
	readonly fetchThreads?: ReviewThreadsFetcher;
	readonly reviewerId: string;
	readonly signal?: AbortSignal;
	/**
	 * Resolve a persona id to its charter, so a retried critique
	 * keeps its persona lens. Same contract as the council retry.
	 */
	readonly resolveCharter?: (personaId: string) => string | undefined;
	/** The user's per-run intent for this retry, merged into the prompt addendum. */
	readonly intent?: string;
}

/**
 * Re-run a single reviewer in the most recent critique
 * run and substitute their `ReviewerCritiqueOutput` in
 * place.
 *
 * Critique entries reference judge findings by
 * `findingId`, so there's no id allocation concern here
 * — the retried reviewer's new entries simply replace
 * their old ones. Decisions on judge findings are
 * unaffected; only this reviewer's positions on those
 * findings change.
 */
export async function retryCritiqueReviewer(
	input: RetryCritiqueReviewerInput,
): Promise<CritiqueActionResult> {
	const { state, reviewerId } = input;
	if (state.pr === null) {
		return {
			ok: false,
			error:
				"PR is not fully loaded; reload before retrying a critique reviewer.",
		};
	}
	const metadata = state.pr.metadata;
	if (metadata === null) {
		return {
			ok: false,
			error:
				"PR is not fully loaded; reload before retrying a critique reviewer.",
		};
	}
	if (state.council.lastRun === null) {
		const stackRetry = await retryStackCritiqueReviewer(input);
		if (stackRetry !== null) return stackRetry;
		return {
			ok: false,
			error: "No council run available. Call pr_workflow action=council first.",
		};
	}
	if (state.council.lastJudge === null) {
		return {
			ok: false,
			error: "No judge run available. Call pr_workflow action=judge first.",
		};
	}
	const lastCritique = state.council.lastCritique;
	if (lastCritique === null) {
		return {
			ok: false,
			error:
				"No critique run to retry. Call pr_workflow action=critique first.",
		};
	}
	const reviewer = state.council.roster.find((r) => r.id === reviewerId);
	if (!reviewer) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" is not in the current council roster.`,
		};
	}
	const existingIndex = lastCritique.reviewerOutputs.findIndex(
		(o) => o.reviewerId === reviewerId,
	);
	if (existingIndex < 0) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" has no output in the last critique run.`,
		};
	}

	const pr = state.pr;
	const target = {
		owner: pr.reference.owner,
		repo: pr.reference.repo,
		sha: metadata.head.sha,
		branch: metadata.head.ref,
	};
	const [providerAddendum, threadContext] = await Promise.all([
		input.reviewContexts?.promptAddendum({
			...target,
			prNumber: pr.reference.number,
			stage: "critique",
		}),
		loadReviewThreadPromptContext(state, input.fetchThreads),
	]);
	const promptAddendum = composeRunAddendum(providerAddendum, input.intent);
	const charters = buildCharterMap([reviewer], input.resolveCharter);
	const output = await runOneCritiqueReviewer({
		runId: lastCritique.id,
		council: state.council.lastRun,
		judge: state.council.lastJudge,
		reviewer,
		target,
		registry: input.registry,
		dispatch: input.dispatch,
		threadContext,
		signal: input.signal,
		charterFor: (id) => charters.get(id),
		...(promptAddendum ? { promptAddendum } : {}),
	});
	lastCritique.reviewerOutputs[existingIndex] = output;
	return { ok: true, run: lastCritique, judge: state.council.lastJudge };
}

async function retryStackCritiqueReviewer(
	input: RetryCritiqueReviewerInput,
): Promise<CritiqueActionResult | null> {
	const { state, reviewerId } = input;
	const stackCritique = state.stackFindingRun?.critique ?? null;
	if (stackCritique === null) return null;
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error:
				"PR is not fully loaded; reload before retrying a critique reviewer.",
		};
	}
	const reviewer = state.council.roster.find((r) => r.id === reviewerId);
	if (!reviewer) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" is not in the current council roster.`,
		};
	}
	const existingIndex = stackCritique.reviewerOutputs.findIndex(
		(o) => o.reviewerId === reviewerId,
	);
	if (existingIndex < 0) {
		return {
			ok: false,
			error: `Reviewer "${reviewerId}" has no output in the last critique run.`,
		};
	}
	const judge = combinedStackJudge(state);
	if (judge === null) {
		return {
			ok: false,
			error:
				"Stack review findings are not loaded. Navigate the stack or rerun " +
				"pr_workflow action=review before retrying critique.",
		};
	}
	const target = {
		owner: state.pr.reference.owner,
		repo: state.pr.reference.repo,
		sha: state.pr.metadata.head.sha,
		branch: state.pr.metadata.head.ref,
	};
	const [promptAddendum, threadContext] = await Promise.all([
		input.reviewContexts?.promptAddendum({
			...target,
			prNumber: state.pr.reference.number,
			stage: "critique",
		}),
		loadReviewThreadPromptContext(state, input.fetchThreads),
	]);
	const output = await runOneCritiqueReviewer({
		runId: stackCritique.id,
		council: emptyCouncilForStackCritique(state),
		judge,
		reviewer,
		target,
		registry: input.registry,
		dispatch: input.dispatch,
		threadContext,
		signal: input.signal,
		...(promptAddendum ? { promptAddendum } : {}),
	});
	stackCritique.reviewerOutputs[existingIndex] = output;
	rememberStackCritique(state, stackCritique);
	return { ok: true, run: stackCritique, judge };
}

function combinedStackJudge(state: PrWorkflowState): JudgeRun | null {
	const stackFindingRun = state.stackFindingRun;
	if (state.pr === null || stackFindingRun === null) return null;
	const findings: Finding[] = [];
	for (const number of stackPrNumbers(state)) {
		const judge = judgeForPr(state, number);
		if (judge) findings.push(...judge.consolidatedFindings);
	}
	findings.push(...stackFindingRun.findings);
	if (findings.length === 0) return null;
	return {
		id: `${stackFindingRun.id}-critique-target`,
		startedAt: stackFindingRun.startedAt,
		judgeReviewerId: stackFindingRun.reviewerId,
		selfSignal: state.council.lastJudge?.selfSignal ?? null,
		consolidatedFindings: findings,
		warnings: [...stackFindingRun.warnings],
	};
}

function stackPrNumbers(state: PrWorkflowState): number[] {
	const current = state.pr?.reference.number;
	const entries = state.pr?.stack?.entries ?? [];
	const numbers = entries.map((entry) => entry.reference.number);
	if (current !== undefined && !numbers.includes(current))
		numbers.push(current);
	return numbers;
}

function judgeForPr(state: PrWorkflowState, prNumber: number): JudgeRun | null {
	if (state.pr?.reference.number === prNumber) return state.council.lastJudge;
	return state.stackRuns.get(prNumber)?.lastJudge ?? null;
}

function emptyCouncilForStackCritique(state: PrWorkflowState): CouncilRun {
	return {
		id: `${state.stackFindingRun?.id ?? "stack-review"}-critique-source`,
		startedAt: state.stackFindingRun?.startedAt ?? new Date(0).toISOString(),
		target: { kind: "diff", prNumber: state.pr?.reference.number ?? 0 },
		reviewerOutputs: state.council.roster.map(
			(reviewer): ReviewerOutput => ({
				reviewerId: reviewer.id,
				findings: [],
				warnings: [],
			}),
		),
	};
}

function rememberStackCritique(state: PrWorkflowState, run: CritiqueRun): void {
	state.council.lastCritique = run;
	for (const number of stackPrNumbers(state)) {
		if (state.pr?.reference.number === number) continue;
		const snapshot = state.stackRuns.get(number);
		if (snapshot) snapshot.lastCritique = run;
	}
	if (state.stackFindingRun) {
		state.stackFindingRun = { ...state.stackFindingRun, critique: run };
	}
}

/** Inputs to `formatCritiqueSummary`. */
export interface FormatCritiqueSummaryInput {
	readonly judge: JudgeRun;
	readonly critique: CritiqueRun;
}

/**
 * Render the critique as a per-finding summary: each
 * consolidated finding followed by every reviewer's
 * position and rationale, with "no position" called out
 * so the gap is visible.
 */
export function formatCritiqueSummary(
	input: FormatCritiqueSummaryInput,
): string {
	const lines: string[] = [];
	lines.push(`Critique run ${input.critique.id}`);
	lines.push(`Reviewers: ${input.critique.reviewerOutputs.length}`);

	// When the pi runtime is stale every reviewer fails
	// identically and no retry will succeed until pi is
	// restarted. Surface a single session-level advisory
	// and suppress the misleading per-reviewer retry hint.
	const staleAdvisory = collectStaleRuntimeAdvisory(
		input.critique.reviewerOutputs,
	);
	if (staleAdvisory) {
		lines.push("");
		lines.push(`⚠ ${staleAdvisory}`);
	} else {
		// Empty-with-warnings is the classic 'reviewer
		// crashed' shape. Flag retry candidates up front so
		// the user sees the suggestion before scrolling
		// through per-finding positions.
		const retryCandidates = input.critique.reviewerOutputs.filter(
			(o) => o.critiques.length === 0 && o.warnings.length > 0,
		);
		if (retryCandidates.length > 0) {
			lines.push("");
			for (const c of retryCandidates) {
				lines.push(
					`⚠ ${c.reviewerId} returned no critiques with warnings; ` +
						`consider \`pr_workflow action=critique-retry reviewerId=${c.reviewerId}\`.`,
				);
			}
		}
	}

	lines.push("");
	if (input.judge.consolidatedFindings.length === 0) {
		lines.push("(no consolidated findings to critique)");
		return lines.join("\n");
	}
	for (const finding of input.judge.consolidatedFindings) {
		lines.push(
			`[${finding.id}] [${finding.label}] ${finding.subject} ${renderLocation(finding.location)}`,
		);
		for (const output of input.critique.reviewerOutputs) {
			const entry = output.critiques.find((c) => c.findingId === finding.id);
			if (entry) {
				lines.push(
					`   ${output.reviewerId}: ${entry.position} — ${entry.rationale}`,
				);
			} else {
				lines.push(`   ${output.reviewerId}: no position (silent)`);
			}
		}
	}
	const allWarnings = collectWarnings(input.critique.reviewerOutputs);
	if (allWarnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const w of allWarnings) lines.push(`  ! ${w}`);
	}
	return lines.join("\n");
}

/**
 * Return the first stale-runtime advisory found across
 * every reviewer's warnings, or null if none.
 *
 * `runReviewer` emits warnings prefixed with
 * `STALE_RUNTIME_WARNING_PREFIX` ("Pi runtime stale:")
 * when the running pi binary is gone or the subagent's
 * stderr carries the canonical ENOENT shape. The same
 * advisory text shows up on every reviewer so picking
 * the first one is correct.
 */
function collectStaleRuntimeAdvisory(
	outputs: readonly ReviewerCritiqueOutput[],
): string | null {
	for (const output of outputs) {
		for (const warning of output.warnings) {
			if (warning.startsWith(STALE_RUNTIME_WARNING_PREFIX)) return warning;
		}
	}
	return null;
}

function collectWarnings(outputs: readonly ReviewerCritiqueOutput[]): string[] {
	const all: string[] = [];
	for (const o of outputs) {
		for (const w of o.warnings) all.push(`${o.reviewerId}: ${w}`);
	}
	return all;
}

function renderLocation(loc: FindingLocation): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
