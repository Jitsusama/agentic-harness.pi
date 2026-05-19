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

import type { CouncilDispatch } from "./council.js";
import {
	type CritiqueRun,
	type ReviewerCritiqueOutput,
	runCritique,
} from "./critique.js";
import type { FindingLocation } from "./findings.js";
import type { JudgeRun } from "./judge.js";
import type { PrWorkflowState } from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Inputs for `runCritiqueAction`. */
export interface RunCritiqueActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	readonly now?: () => Date;
}

/** Result of running the critique. */
export type CritiqueActionResult =
	| { ok: true; run: CritiqueRun }
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
	const run = await runCritique({
		runId,
		council: state.council.lastRun,
		judge: state.council.lastJudge,
		roster: state.council.roster,
		target: {
			owner: state.pr.reference.owner,
			repo: state.pr.reference.repo,
			sha: state.pr.metadata.head.sha,
		},
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
	});
	state.council.lastCritique = run;
	return { ok: true, run };
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
