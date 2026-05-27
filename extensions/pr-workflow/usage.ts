/**
 * Helpers for aggregating per-subagent `ReviewerUsage`
 * blocks. Used by the fix action, status panel and any
 * future cost-aware code paths.
 *
 * All math is plain addition over the five token channels
 * (input, output, cacheRead, cacheWrite, total) and the
 * five cost channels (same shape). Missing usage blocks
 * are skipped, never coerced to zero.
 */

import type { ReviewerUsage } from "../../lib/subagent/subagent.js";
import type { CritiqueRun } from "./critique.js";
import type { CouncilRun } from "./findings.js";
import type { JudgeRun } from "./judge.js";

/**
 * Sum a list of usage blocks element-wise. Returns
 * undefined when the list has no usage entries so callers
 * can distinguish "no data" from "zero spend".
 */
export function sumUsage(
	usages: ReadonlyArray<ReviewerUsage | undefined>,
): ReviewerUsage | undefined {
	const present = usages.filter((u): u is ReviewerUsage => u !== undefined);
	if (present.length === 0) return undefined;

	const tokens = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	const cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	for (const u of present) {
		tokens.input += u.tokens.input;
		tokens.output += u.tokens.output;
		tokens.cacheRead += u.tokens.cacheRead;
		tokens.cacheWrite += u.tokens.cacheWrite;
		tokens.total += u.tokens.total;
		cost.input += u.cost.input;
		cost.output += u.cost.output;
		cost.cacheRead += u.cost.cacheRead;
		cost.cacheWrite += u.cost.cacheWrite;
		cost.total += u.cost.total;
	}
	return { tokens, cost };
}

/**
 * Per-stage usage breakdown for the status panel. Each
 * field is undefined when no subagent in that stage
 * surfaced usage (or that stage hasn't run yet).
 *
 * Only the three research stages have subagents: council
 * (round 1), judge (round 2) and critique (round 3).
 * Round-4 decisions and applied edits happen in the main
 * agent's loop, which tracks its own costs externally.
 */
export interface UsageBreakdown {
	readonly council: ReviewerUsage | undefined;
	readonly judge: ReviewerUsage | undefined;
	readonly critique: ReviewerUsage | undefined;
	/** Sum of the three stages (undefined if all are undefined). */
	readonly total: ReviewerUsage | undefined;
}

/**
 * Collect usage from a council run by summing every
 * reviewer output's usage block.
 */
export function councilRunUsage(
	run: CouncilRun | null,
): ReviewerUsage | undefined {
	if (run === null) return undefined;
	return sumUsage(run.reviewerOutputs.map((r) => r.usage));
}

/**
 * Collect usage from a critique run by summing every
 * reviewer output's usage block.
 */
export function critiqueRunUsage(
	run: CritiqueRun | null,
): ReviewerUsage | undefined {
	if (run === null) return undefined;
	return sumUsage(run.reviewerOutputs.map((r) => r.usage));
}

/**
 * Build the three-stage breakdown the status panel
 * renders.
 */
export function summarizeUsage(input: {
	readonly council: CouncilRun | null;
	readonly judge: JudgeRun | null;
	readonly critique: CritiqueRun | null;
}): UsageBreakdown {
	const council = councilRunUsage(input.council);
	const judge = input.judge?.usage;
	const critique = critiqueRunUsage(input.critique);
	const total = sumUsage([council, judge, critique]);
	return { council, judge, critique, total };
}
