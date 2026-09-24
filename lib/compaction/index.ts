/**
 * Compaction: when compacting pays for itself, the session history its
 * prices come from, how a summary is asked for, read and spliced onto
 * the cached conversation, where a summary written ahead keeps from,
 * what other extensions contribute to it, the back-off after a
 * compaction fails, and the guard that keeps a reserve setting from
 * breaking the decision.
 *
 * Pure and standalone. None of these touches pi's live compaction
 * behaviour; `compaction-workflow` wires them into a running trigger.
 */

export {
	isSummaryContributions,
	newContributions,
	SUMMARY_CONTRIBUTIONS,
	type SummaryContributions,
} from "./contributions.ts";
export {
	type CompactionFailure,
	FAILURE_ENTRY,
	failureRecord,
	turnsBeforeRetry,
	wasCancelled,
} from "./failure.ts";
export { type CompactionHistory, compactionHistory } from "./history.ts";
export { type PaybackInput, paybackMargin, paybackTest } from "./payback.ts";
export { type KeptBoundary, keptBoundary } from "./prepared.ts";
export { clampReserveTokens } from "./reserve.ts";
export {
	extendSentPayload,
	type FileOperations,
	readSummary,
	type SpliceOutcome,
	SUMMARY_SPAN,
	type SummaryInstructionOptions,
	type SummaryOutcome,
	type SummaryReply,
	summaryInstruction,
	withFileLists,
} from "./summary.ts";
export {
	type CompactionCost,
	type CompactionCostInput,
	type CompactionPrices,
	compactionCost,
	compactionPays,
	droppableRent,
	type IdleInput,
	idleCompactionPays,
	type TriggerDecision,
	type TriggerInput,
} from "./trigger.ts";
