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

/** One reviewer's usage within a stage. */
export interface ReviewerUsageEntry {
	readonly reviewerId: string;
	readonly usage: ReviewerUsage;
}

/** Per-stage usage with the per-reviewer breakdown. */
export interface StageUsage {
	readonly total: ReviewerUsage | undefined;
	readonly perReviewer: readonly ReviewerUsageEntry[];
}

/**
 * Per-stage usage breakdown for the status panel. Each
 * stage carries an aggregate plus the per-reviewer list
 * so callers can render either summary or breakdown.
 *
 * Only the three research stages have subagents: council
 * (round 1), judge (round 2) and critique (round 3).
 * Round-4 decisions and applied edits happen in the main
 * agent's loop, which tracks its own costs externally.
 */
export interface UsageBreakdown {
	readonly council: StageUsage;
	readonly judge: StageUsage;
	readonly critique: StageUsage;
	/** Sum of the three stages (undefined if all are undefined). */
	readonly total: ReviewerUsage | undefined;
}

/**
 * Collect usage from a council run with the per-reviewer
 * breakdown intact, plus the stage total.
 */
export function councilRunUsage(run: CouncilRun | null): StageUsage {
	if (run === null) return { total: undefined, perReviewer: [] };
	const perReviewer = collectPerReviewer(
		run.reviewerOutputs.map((r) => ({
			reviewerId: r.reviewerId,
			usage: r.usage,
		})),
	);
	return {
		total: sumUsage(perReviewer.map((e) => e.usage)),
		perReviewer,
	};
}

/**
 * Collect usage from a critique run with the per-reviewer
 * breakdown intact.
 */
export function critiqueRunUsage(run: CritiqueRun | null): StageUsage {
	if (run === null) return { total: undefined, perReviewer: [] };
	const perReviewer = collectPerReviewer(
		run.reviewerOutputs.map((r) => ({
			reviewerId: r.reviewerId,
			usage: r.usage,
		})),
	);
	return {
		total: sumUsage(perReviewer.map((e) => e.usage)),
		perReviewer,
	};
}

function collectPerReviewer(
	entries: ReadonlyArray<{
		reviewerId: string;
		usage: ReviewerUsage | undefined;
	}>,
): ReviewerUsageEntry[] {
	const out: ReviewerUsageEntry[] = [];
	for (const entry of entries) {
		if (entry.usage === undefined) continue;
		out.push({ reviewerId: entry.reviewerId, usage: entry.usage });
	}
	return out;
}

/**
 * Build the three-stage breakdown the status panel
 * renders. Judge is a single-reviewer stage so its
 * per-reviewer list is at most one entry.
 */
export function summarizeUsage(input: {
	readonly council: CouncilRun | null;
	readonly judge: JudgeRun | null;
	readonly critique: CritiqueRun | null;
}): UsageBreakdown {
	const council = councilRunUsage(input.council);
	const judge: StageUsage = input.judge?.usage
		? {
				total: input.judge.usage,
				perReviewer: [
					{
						reviewerId: input.judge.judgeReviewerId,
						usage: input.judge.usage,
					},
				],
			}
		: { total: undefined, perReviewer: [] };
	const critique = critiqueRunUsage(input.critique);
	const total = sumUsage([council.total, judge.total, critique.total]);
	return { council, judge, critique, total };
}
