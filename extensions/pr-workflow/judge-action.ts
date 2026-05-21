/**
 * Action handlers for `judge-config` and `judge` tool
 * actions.
 *
 * Mirrors the shape of `council-action.ts`: pure
 * functions over `PrWorkflowState` with the dispatch
 * boundary injected so unit tests don't spawn pi.
 */

import type { CouncilDispatch } from "./council.js";
import { rememberAllocatedFindings } from "./finding-ids.js";
import { type JudgeRun, runJudge } from "./judge.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { PrWorkflowState } from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Result of a state-mutating action. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Inputs for `configureJudge`. */
export interface ConfigureJudgeInput {
	readonly judge: CouncilReviewer;
}

/** Set the judge reviewer for the next round-2 run. */
export function configureJudge(
	state: PrWorkflowState,
	input: ConfigureJudgeInput,
): ActionResult {
	if (input.judge.id.trim() === "") {
		return {
			ok: false,
			error: "Judge id is empty: every finding needs a stamping reviewer id.",
		};
	}
	state.council.judge = { ...input.judge };
	return { ok: true };
}

/** Inputs for `runJudgeAction`. */
export interface RunJudgeActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly now?: () => Date;
}

/** Result of running the judge. */
export type JudgeActionResult =
	| { ok: true; run: JudgeRun }
	| { ok: false; error: string };

/**
 * Run the judge round against the most recent council
 * run. Stores the resulting `JudgeRun` in
 * `state.council.lastJudge` on success.
 */
export async function runJudgeAction(
	input: RunJudgeActionInput,
): Promise<JudgeActionResult> {
	const { state } = input;
	if (state.council.lastRun === null) {
		return {
			ok: false,
			error: "No council run available. Call pr_workflow action=council first.",
		};
	}
	if (state.council.judge === null) {
		return {
			ok: false,
			error:
				"Judge not configured. Call pr_workflow action=judge-config first.",
		};
	}
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "PR is not fully loaded; reload before judging.",
		};
	}

	const now = input.now ?? (() => new Date());
	const runId = `judge-${now().toISOString()}`;
	const run = await runJudge({
		runId,
		council: state.council.lastRun,
		judge: state.council.judge,
		target: {
			owner: state.pr.reference.owner,
			repo: state.pr.reference.repo,
			sha: state.pr.metadata.head.sha,
		},
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
		startId: state.nextFindingId,
	});
	rememberAllocatedFindings(state, run.consolidatedFindings);
	state.council.lastJudge = run;
	state.council.lastCritique = null;
	state.council.decisions = new Map();
	return { ok: true, run };
}

/** Render a `JudgeRun` as a multi-line summary. */
export function formatJudgeSummary(run: JudgeRun): string {
	const lines: string[] = [];
	lines.push(`Judge run ${run.id}`);
	lines.push(`Judge: ${run.judgeReviewerId}`);
	if (run.selfSignal !== null) {
		lines.push(
			`Self-signal: ${run.selfSignal.confidence} — ${run.selfSignal.rationale}`,
		);
	} else {
		lines.push("Self-signal: (none)");
	}
	lines.push("");
	const count = run.consolidatedFindings.length;
	const noun = count === 1 ? "finding" : "findings";
	lines.push(`${count} consolidated ${noun}:`);
	for (const finding of run.consolidatedFindings) {
		const loc = renderLocation(finding.location);
		const raisedBy = finding.agreement?.raisedBy.join(", ") ?? "judge alone";
		lines.push(
			`  [${finding.id}] [${finding.label}] ${finding.subject} ${loc}`,
		);
		lines.push(`     raised by: ${raisedBy}`);
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

function renderLocation(
	loc: JudgeRun["consolidatedFindings"][number]["location"],
): string {
	switch (loc.kind) {
		case "line":
			return `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
