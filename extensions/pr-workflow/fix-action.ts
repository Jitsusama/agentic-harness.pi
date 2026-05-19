/**
 * Action layer for the fix queue.
 *
 * Three small actions:
 *
 *   - `nextFixAction` — return the next pending fix and a
 *     prose summary for the agent to read aloud. Pure
 *     read; no state mutation.
 *   - `recordFixDoneAction` — record that a commit landed
 *     for a queued fix.
 *   - `recordFixSkipAction` — record that a queued fix was
 *     abandoned.
 *
 * Edits, checks, commits, and pushes all happen in the
 * main agent loop using normal tooling. The fix queue is
 * just a state-tracker that supplies the recipe and
 * records outcomes.
 */

import {
	type FixContext,
	type FixOutcomeResult,
	getNextFix,
	recordFixDone,
	recordFixSkip,
	summarizeFixQueue,
} from "./fix.js";
import type { PrWorkflowState } from "./state.js";

/** Result tag every action returns. */
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Return the next pending fix and a human-readable
 * summary. When the queue is empty the result still
 * reports `ok: true` with `context: null` and a summary
 * so the agent can say "queue done" without an error
 * path.
 */
export function nextFixAction(
	state: PrWorkflowState,
): Result<{ context: FixContext | null; summary: string }> {
	if (state.pr === null) {
		return { ok: false, error: "Load a PR before walking the fix queue." };
	}
	if (state.council.lastJudge === null) {
		return {
			ok: false,
			error: "Run the council and judge before queueing fixes.",
		};
	}
	const counts = summarizeFixQueue(state);
	const context = getNextFix(state);
	const summary = formatNextFix(context, counts);
	return { ok: true, context, summary };
}

/**
 * Record a commit against a queued fix. The agent calls
 * this after `commit-guardian` confirms the commit
 * landed.
 */
export function recordFixDoneAction(input: {
	state: PrWorkflowState;
	findingId: number;
	commitSha: string;
	now?: () => Date;
}): FixOutcomeResult {
	const { state, findingId, commitSha, now } = input;
	return recordFixDone(state, findingId, commitSha, now);
}

/**
 * Record that a queued fix was abandoned. The reason is
 * surfaced in the findings view so the user can see why
 * the finding stalled.
 */
export function recordFixSkipAction(input: {
	state: PrWorkflowState;
	findingId: number;
	reason: string;
	now?: () => Date;
}): FixOutcomeResult {
	const { state, findingId, reason, now } = input;
	return recordFixSkip(state, findingId, reason, now);
}

/**
 * Render a one-line status line for the `status` action's
 * output and a longer block for `fix-next`. Kept in this
 * file so the format stays close to the action that uses
 * it.
 */
export function formatFixQueueStatus(state: PrWorkflowState): string {
	const counts = summarizeFixQueue(state);
	const total = counts.pending + counts.committed + counts.skipped;
	if (total === 0) return "fix queue: empty";
	return `fix queue: ${counts.pending} pending, ${counts.committed} committed, ${counts.skipped} skipped`;
}

function formatNextFix(
	context: FixContext | null,
	counts: { pending: number; committed: number; skipped: number },
): string {
	if (context === null) {
		const handled = counts.committed + counts.skipped;
		if (handled === 0) return "No fixes queued.";
		return `Queue done. ${counts.committed} committed, ${counts.skipped} skipped.`;
	}
	const lines: string[] = [];
	lines.push(
		`Next fix: finding ${context.findingId} — ${context.finding.subject}`,
	);
	lines.push(`Location: ${formatLocation(context.finding)}`);
	if (context.instructions) {
		lines.push(`Instructions: ${context.instructions}`);
	}
	lines.push(`Discussion: ${context.finding.discussion}`);
	lines.push(
		`Queue: ${counts.pending} pending (including this one), ${counts.committed} committed, ${counts.skipped} skipped.`,
	);
	return lines.join("\n");
}

function formatLocation(finding: FixContext["finding"]): string {
	const loc = finding.location;
	switch (loc.kind) {
		case "line":
			return `${loc.file}:${loc.start}-${loc.end}`;
		case "file":
			return loc.file;
		case "global":
			return "(scope)";
	}
}
