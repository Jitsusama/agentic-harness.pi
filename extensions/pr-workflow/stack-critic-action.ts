/**
 * Action handlers for `stack-critic-config` and
 * `stack-critic` tool actions.
 *
 * Mirrors the shape of `judge-action.ts`: pure
 * functions over `PrWorkflowState`, dispatch boundary
 * injected so unit tests don't spawn pi. The
 * `runStackCriticAction` handler is where guard
 * checks live and where the per-PR aggregation
 * (live judge run + snapshotted judge runs) happens.
 */

import type { CouncilDispatch } from "./council.js";
import type { Finding } from "./findings.js";
import type { CouncilReviewer } from "./reviewer.js";
import {
	runStackCritic,
	type StackCriticPrContext,
	type StackCriticRun,
} from "./stack-critic.js";
import type { PrWorkflowState } from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Result of a state-mutating action. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Inputs for `configureStackCritic`. */
export interface ConfigureStackCriticInput {
	readonly stackCritic: CouncilReviewer;
}

/** Set the stack-critic reviewer for the next stack run. */
export function configureStackCritic(
	state: PrWorkflowState,
	input: ConfigureStackCriticInput,
): ActionResult {
	if (input.stackCritic.id.trim() === "") {
		return {
			ok: false,
			error:
				"Stack-critic reviewer id is empty: every finding needs a stamping reviewer id.",
		};
	}
	state.council.stackCritic = { ...input.stackCritic };
	return { ok: true };
}

/** Inputs for `runStackCriticAction`. */
export interface RunStackCriticActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly now?: () => Date;
}

/** Result of running the stack critic. */
export type StackCriticActionResult =
	| { ok: true; run: StackCriticRun }
	| { ok: false; error: string };

/**
 * Run the stack critic against the discovered stack.
 * Stores the resulting `StackCriticRun` in
 * `state.stackCritic` on success.
 *
 * Guards:
 *   - PR must be loaded and fully fetched.
 *   - Stack must have been discovered.
 *   - Stack-critic reviewer must be configured.
 *   - At least one PR in the stack must have judge
 *     findings (live or snapshotted). Without that,
 *     there's nothing to synthesize.
 */
export async function runStackCriticAction(
	input: RunStackCriticActionInput,
): Promise<StackCriticActionResult> {
	const { state } = input;
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "No PR loaded; call pr_workflow action=load first.",
		};
	}
	if (state.pr.stack === null) {
		return {
			ok: false,
			error:
				"No stack discovered. Call pr_workflow action=stack on a PR that's part of a stack.",
		};
	}
	if (state.council.stackCritic === null) {
		return {
			ok: false,
			error:
				"Stack-critic reviewer not configured. Call pr_workflow action=stack-critic-config first.",
		};
	}

	const cursorPrNumber = state.pr.reference.number;
	const perPr = aggregatePerPr(state, cursorPrNumber);
	const totalFindings = perPr.reduce(
		(sum, pr) => sum + pr.judgeFindings.length,
		0,
	);
	if (totalFindings === 0) {
		return {
			ok: false,
			error:
				"No judge findings on any PR in the stack. Run pr_workflow action=judge on at least one PR first.",
		};
	}

	const now = input.now ?? (() => new Date());
	const runId = `stack-critic-${now().toISOString()}`;
	const run = await runStackCritic({
		runId,
		cursorPrNumber,
		perPr,
		reviewer: state.council.stackCritic,
		target: {
			owner: state.pr.reference.owner,
			repo: state.pr.reference.repo,
			sha: state.pr.metadata.head.sha,
		},
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		now,
	});
	state.stackCritic = run;
	return { ok: true, run };
}

/**
 * Build per-PR context from the live council state and
 * the off-cursor snapshots. The cursor PR's body comes
 * from its loaded metadata; off-cursor PR bodies are
 * unavailable in v1 (snapshots don't store metadata).
 */
function aggregatePerPr(
	state: PrWorkflowState,
	cursorPrNumber: number,
): StackCriticPrContext[] {
	if (state.pr === null || state.pr.stack === null) {
		return [];
	}
	const cursorBody = state.pr.metadata?.body ?? "";
	const result: StackCriticPrContext[] = [];
	for (const entry of state.pr.stack.entries) {
		const prNumber = entry.reference.number;
		const isCursor = prNumber === cursorPrNumber;
		const judgeFindings = isCursor
			? (state.council.lastJudge?.consolidatedFindings ?? [])
			: (state.stackRuns.get(prNumber)?.lastJudge?.consolidatedFindings ?? []);
		result.push({
			prNumber,
			title: entry.title,
			body: isCursor ? cursorBody : "",
			judgeFindings: judgeFindings as readonly Finding[],
		});
	}
	return result;
}

/** Render a `StackCriticRun` as a multi-line summary. */
export function formatStackCriticSummary(run: StackCriticRun): string {
	const lines: string[] = [];
	lines.push(`Stack-critic run ${run.id}`);
	lines.push(`Reviewer: ${run.reviewerId}`);
	lines.push("");
	const count = run.findings.length;
	const noun = count === 1 ? "finding" : "findings";
	lines.push(`${count} cross-PR ${noun}:`);
	for (const finding of run.findings) {
		lines.push(
			`  [${finding.id}] [${finding.label}] ${finding.subject} (home: #${finding.homePrNumber}; spans: ${finding.spans.join(", ")})`,
		);
		lines.push(`     ${finding.discussion}`);
	}
	if (run.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const warning of run.warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return lines.join("\n");
}
