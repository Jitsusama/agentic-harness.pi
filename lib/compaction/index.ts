/**
 * Compaction: the decision logic for when summarising context pays for
 * itself, the session history it starts from, the recorded draw of the
 * threshold it fires at, the back-off after a compaction fails, and the
 * guard that keeps a reserve setting from breaking that decision.
 *
 * Pure and standalone. None of these touches pi's live compaction
 * behaviour; `compaction-workflow` wires them into a running trigger.
 */

export {
	type CompactionFailure,
	FAILURE_ENTRY,
	failureRecord,
	turnsBeforeRetry,
	wasCancelled,
} from "./failure.ts";
export { type CompactionHistory, compactionHistory } from "./history.ts";
export { type PaybackInput, paybackMargin, paybackTest } from "./payback.ts";
export { clampReserveTokens } from "./reserve.ts";
export {
	currentThresholdDraw,
	drawThreshold,
	THRESHOLD_ENTRY,
	type ThresholdDraw,
	USUAL_THRESHOLD,
} from "./threshold.ts";
export {
	compactionPays,
	type TriggerDecision,
	type TriggerInput,
} from "./trigger.ts";
