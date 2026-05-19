/**
 * Fix action: drain the fix queue.
 *
 * Iterates findings the user verdict'd as `fix` (in
 * round 4), dispatches one fix subagent per finding,
 * aggregates results. The action is the public surface;
 * the dispatch boundary (`RunFix`) is injected so unit
 * tests don't spawn pi.
 *
 * Refuses bad state up front:
 *   - no PR loaded
 *   - no previous council run (no worktree to dispatch
 *     against)
 *   - nothing queued for fix
 *
 * Processes serially: the worktree is shared across
 * subagents, so concurrent dispatches would race on
 * file writes.
 */

import type { Finding } from "./findings.js";
import type { FixOutput, RunFixOptions } from "./fix.js";
import type { PrWorkflowState } from "./state.js";
import type { FindingDecision } from "./synthesis.js";

/**
 * Boundary the action uses to dispatch one fix
 * subagent. Production wraps `runFix` from `fix.ts`;
 * tests substitute a stub.
 */
export type RunFix = (
	options: Omit<RunFixOptions, "runPi" | "tools">,
) => Promise<
	| { ok: true; output: FixOutput; stderr: string }
	| { ok: false; error: string; stderr?: string }
>;

/** Inputs to the action handler. */
export interface RunFixActionInput {
	readonly state: PrWorkflowState;
	readonly runFix: RunFix;
}

/** Per-finding outcome the action surfaces. */
export interface FixSucceeded {
	readonly findingId: number;
	readonly summary: string;
	readonly modifiedFiles: string[];
}
export interface FixFailed {
	readonly findingId: number;
	readonly error: string;
}

/** Result of running the action. */
export type RunFixActionResult =
	| {
			ok: true;
			results: { succeeded: FixSucceeded[]; failed: FixFailed[] };
	  }
	| { ok: false; error: string };

/**
 * Drain the fix queue. Returns aggregate results once
 * every queued finding has been attempted (success or
 * failure does not halt the queue).
 */
export async function runFixAction(
	input: RunFixActionInput,
): Promise<RunFixActionResult> {
	const { state, runFix } = input;

	if (state.pr === null) {
		return { ok: false, error: "No PR loaded; call action=load first." };
	}
	const council = state.council.lastRun;
	if (council === null) {
		return {
			ok: false,
			error:
				"No council run found. Run action=council before queueing fixes; the council worktree is reused.",
		};
	}

	const queued = collectQueued(state);
	if (queued.length === 0) {
		return {
			ok: false,
			error:
				"Nothing queued for fix. Decide findings with verdict=fix to queue them, then call action=fix.",
		};
	}

	const succeeded: FixSucceeded[] = [];
	const failed: FixFailed[] = [];

	// Serial — see module header. Workers share a worktree.
	for (const { finding, decision } of queued) {
		const result = await runFix({
			finding,
			worktreePath: council.worktreePath,
			model: state.council.fixModel ?? undefined,
			prTitle: state.pr.metadata?.title,
			userInstructions: decision.instructions,
		});
		if (result.ok) {
			succeeded.push({
				findingId: finding.id,
				summary: result.output.summary,
				modifiedFiles: result.output.modifiedFiles,
			});
		} else {
			failed.push({ findingId: finding.id, error: result.error });
		}
	}

	return { ok: true, results: { succeeded, failed } };
}

interface QueuedEntry {
	readonly finding: Finding;
	readonly decision: Extract<FindingDecision, { verdict: "fix" }>;
}

function collectQueued(state: PrWorkflowState): QueuedEntry[] {
	const judge = state.council.lastJudge;
	if (judge === null) return [];
	const queued: QueuedEntry[] = [];
	for (const finding of judge.consolidatedFindings) {
		const decision = state.council.decisions.get(finding.id);
		if (decision !== undefined && decision.verdict === "fix") {
			queued.push({ finding, decision });
		}
	}
	return queued;
}

/**
 * Render the action result as user-facing prose. The
 * agent uses this to summarise the queue drain in the
 * conversation.
 */
export function formatFixSummary(result: RunFixActionResult): string {
	if (!result.ok) return result.error;
	const { succeeded, failed } = result.results;
	const total = succeeded.length + failed.length;
	const lines: string[] = [
		`Fix queue drained: ${succeeded.length}/${total} applied${failed.length > 0 ? `, ${failed.length} failed` : ""}.`,
	];
	for (const s of succeeded) {
		const filesPart =
			s.modifiedFiles.length === 0
				? "(no files modified)"
				: s.modifiedFiles.join(", ");
		lines.push(`  ✓ [${s.findingId}] ${s.summary} — ${filesPart}`);
	}
	for (const f of failed) {
		lines.push(`  ✗ [${f.findingId}] ${f.error}`);
	}
	return lines.join("\n");
}
