/**
 * Action handlers for the `council` and `council-config`
 * tool actions.
 *
 * The tool surface in `index.ts` is a thin shell that
 * delegates here. The logic — input validation, dispatch
 * to the orchestrator, state persistence, summary
 * formatting — lives in pure functions for testability.
 */

import type { CouncilDispatch } from "./council.js";
import { runCouncil } from "./council.js";
import type { CouncilRun } from "./findings.js";
import type { CouncilReviewer } from "./reviewer.js";
import type { PrWorkflowState } from "./state.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Result of a state-mutating action handler. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Inputs for `configureCouncil`. */
export interface ConfigureCouncilInput {
	readonly reviewers: readonly CouncilReviewer[];
}

/**
 * Replace the session roster with the provided reviewers.
 * Validates non-empty and unique ids; errors are
 * structured for the tool layer to surface as text.
 */
export function configureCouncil(
	state: PrWorkflowState,
	input: ConfigureCouncilInput,
): ActionResult {
	if (input.reviewers.length === 0) {
		return {
			ok: false,
			error: "Council roster is empty: provide at least one reviewer.",
		};
	}
	const seen = new Set<string>();
	for (const r of input.reviewers) {
		if (seen.has(r.id)) {
			return {
				ok: false,
				error: `Duplicate reviewer id: "${r.id}". Reviewer ids stamp finding origin and must be unique.`,
			};
		}
		seen.add(r.id);
	}
	state.council.roster = input.reviewers.map((r) => ({ ...r }));
	return { ok: true };
}

/** Inputs for `runCouncilAction`. */
export interface RunCouncilActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	readonly signal?: AbortSignal;
	/** Override for tests; production uses `Date.now()`. */
	readonly now?: () => Date;
}

/** Result of a council action run. */
export type CouncilActionResult =
	| { ok: true; run: CouncilRun }
	| { ok: false; error: string };

/**
 * Run the council against the currently loaded PR. Stores
 * the resulting `CouncilRun` in `state.council.lastRun`
 * on success.
 */
export async function runCouncilAction(
	input: RunCouncilActionInput,
): Promise<CouncilActionResult> {
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

	const pr = state.pr;
	const metadata = pr.metadata;
	if (metadata === null) {
		return {
			ok: false,
			error:
				"PR metadata is missing. Reload the PR before running the council.",
		};
	}
	const files = pr.files ?? [];

	const now = input.now ?? (() => new Date());
	const runId = `council-${now().toISOString()}`;

	const target = {
		owner: pr.reference.owner,
		repo: pr.reference.repo,
		sha: metadata.head.sha,
		prNumber: pr.reference.number,
		title: metadata.title,
		description: "",
		files,
	};

	const run = await runCouncil({
		runId,
		target,
		reviewers: state.council.roster,
		registry: input.registry,
		dispatch: input.dispatch,
		signal: input.signal,
	});
	state.council.lastRun = run;
	return { ok: true, run };
}

/**
 * Render a `CouncilRun` as a multi-line summary suitable
 * for surfacing to the user via the tool's `content`.
 */
export function formatCouncilSummary(run: CouncilRun): string {
	const lines: string[] = [];
	lines.push(`Council run ${run.id} on PR #${run.target.prNumber}`);
	lines.push(`Started: ${run.startedAt}`);
	for (const output of run.reviewerOutputs) {
		const count = output.findings.length;
		const noun = count === 1 ? "finding" : "findings";
		lines.push("");
		lines.push(`▸ ${output.reviewerId} — ${count} ${noun}`);
		for (const finding of output.findings) {
			const loc = renderLocation(finding.location);
			lines.push(`  • [${finding.label}] ${finding.subject}  ${loc}`);
		}
		for (const warning of output.warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return lines.join("\n");
}

function renderLocation(
	loc: CouncilRun["reviewerOutputs"][number]["findings"][number]["location"],
): string {
	switch (loc.kind) {
		case "line":
			return loc.start === loc.end
				? `(${loc.file}:${loc.start})`
				: `(${loc.file}:${loc.start}-${loc.end})`;
		case "file":
			return `(${loc.file})`;
		case "global":
			return "(scope)";
	}
}
