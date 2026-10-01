/**
 * Compaction: when compacting pays for itself, the session history its
 * prices come from, the contract a summary provider implements and
 * registers over the bus, how a summary is asked for, read and spliced
 * onto the cached conversation, where a summary written ahead keeps from
 * and why the kept tail never starts on a custom entry, what other
 * extensions contribute to it and record about it, the outcome said on
 * the bus for every compaction, the back-off after a compaction fails,
 * the messages that resume a run it stopped, and the guard that keeps a
 * reserve setting from breaking the decision.
 *
 * Pure and standalone. None of these touches pi's live compaction
 * behaviour; `compaction-workflow` wires them into a running trigger.
 */

export {
	isSummaryContributions,
	newContributions,
	recordContribution,
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
export {
	COMPACTION_OUTCOME,
	type CompactionOutcome,
	emitOutcome,
	isCompactionOutcome,
} from "./outcome.ts";
export {
	type BoundaryEntry,
	type KeptBoundary,
	keptBoundary,
	pastCustomEntries,
} from "./prepared.ts";
export {
	COMPACTION_READY,
	COMPACTION_REGISTER_PROVIDER,
	COMPACTION_REQUEST,
	type CompactionAssessment,
	type CompactionAttempt,
	type CompactionFocus,
	type CompactionHostApi,
	type CompactionPreparation,
	type CompactionProvider,
	type CompactionReason,
	type CompactionRequest,
	type CompactionTiming,
	type CompactionWritten,
	combinedFocus,
	isCompactionProvider,
	registerCompactionProvider,
} from "./provider.ts";
export { clampReserveTokens } from "./reserve.ts";
export { FAILED_RESUME_TEXT, isResumeText, RESUME_TEXT } from "./resume.ts";
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
