/**
 * Batch decide action wrapper.
 *
 * Validates that a batch decide names a verdict that can be
 * applied without per-finding overrides, then runs the
 * decision across the id list and summarizes what landed
 * and what failed. Edit is excluded: it carries
 * finding-specific overrides and stays a single-finding
 * decide.
 */

import type { PrWorkflowState } from "./state.js";
import {
	type BatchDecideVerdict,
	type DecideFindingScope,
	decideFindings,
} from "./synthesis.js";

/** Result the tool renders for a batch decide. */
export interface DecideBatchActionResult {
	summary: string;
	details: Record<string, unknown>;
	isError: boolean;
}

/** Inputs to {@link decideBatchAction}. */
export interface DecideBatchActionInput {
	findingIds: number[];
	verdict?: string;
	scope?: DecideFindingScope;
	note?: string;
	reason?: string;
	instructions?: string;
}

const BATCHABLE_VERDICTS: readonly BatchDecideVerdict[] = [
	"endorse",
	"dismiss",
	"promote",
	"fix",
	"qualify",
];

function isBatchable(verdict: string): verdict is BatchDecideVerdict {
	return (BATCHABLE_VERDICTS as readonly string[]).includes(verdict);
}

/** Validate and run a batch decide, returning a rendered summary. */
export function decideBatchAction(
	state: PrWorkflowState,
	input: DecideBatchActionInput,
): DecideBatchActionResult {
	if (!input.verdict) {
		return {
			summary:
				"Batch decide requires a `verdict`. Batchable verdicts: " +
				`${BATCHABLE_VERDICTS.join(", ")}.`,
			details: { ok: false, error: "missing verdict" },
			isError: true,
		};
	}
	if (!isBatchable(input.verdict)) {
		return {
			summary:
				`Verdict "${input.verdict}" cannot be batched; it carries ` +
				"per-finding overrides. Decide it with a single findingId. " +
				`Batchable verdicts: ${BATCHABLE_VERDICTS.join(", ")}.`,
			details: { ok: false, error: `non-batchable verdict: ${input.verdict}` },
			isError: true,
		};
	}

	const result = decideFindings(state, {
		findingIds: input.findingIds,
		verdict: input.verdict,
		...(input.scope !== undefined ? { scope: input.scope } : {}),
		...(input.note !== undefined ? { note: input.note } : {}),
		...(input.reason !== undefined ? { reason: input.reason } : {}),
		...(input.instructions !== undefined
			? { instructions: input.instructions }
			: {}),
	});

	const noun = result.decided.length === 1 ? "finding" : "findings";
	const parts = [
		`Decided ${result.decided.length} ${noun} as ${input.verdict}.`,
	];
	if (result.failed.length > 0) {
		const ids = result.failed.map((f) => f.findingId).join(", ");
		parts.push(`Failed: ${ids}.`);
		// Surface the first distinct reason so a systematic
		// failure (wrong scope, no run) explains itself.
		const firstReason = result.failed[0]?.error;
		if (firstReason) parts.push(firstReason);
	}

	return {
		summary: parts.join(" "),
		details: {
			ok: result.decided.length > 0,
			decided: result.decided,
			failed: result.failed,
		},
		isError: result.decided.length === 0,
	};
}
