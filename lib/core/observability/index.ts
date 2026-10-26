/**
 * Observability: first-class run telemetry for subagent and
 * council fan-outs.
 *
 * The parent session records one {@link RunRecord} per
 * subagent as it finishes, into a SQLite table kept in its
 * own database file. Rows are queryable on demand, roll up
 * into periodic per-model and per-persona summaries before
 * they age out, and drive a compact status-line figure.
 *
 * The ledger beside it covers the other side of the bill: the
 * main loop's own turns, addressed by content so a total can
 * be trusted.
 *
 * Reading a harness's log format into those turns is that
 * harness's own business and lives in its package.
 */

export {
	type CallScope,
	type CompactionFacts,
	type CostDimension,
	type CostSlice,
	type DroppedCallRecord,
	LEDGER_QUERY_ROW_CAP,
	type LedgerReader,
	type LedgerTotal,
	openLedgerReader,
	openTurnStore,
	type PaybackReplay,
	type QueryAnswer,
	type RecordOutcome,
	type Regret,
	type RegretReport,
	type RepeatedCall,
	type SessionRecord,
	type ToolCallRecord,
	type TurnFacts,
	type TurnKind,
	type TurnPrecedent,
	type TurnRecord,
	type TurnStore,
	type VerifierKind,
	type VerifierOutcome,
} from "./ledger/index.ts";

export {
	type RunRecorder,
	type RunRecordInput,
	recordRunEverywhere,
	registerRunRecorder,
	runRecordFrom,
} from "./recorder.ts";
export { openRunStore, type RunQuery, type RunStore } from "./store.ts";
export type {
	RunCost,
	RunRecord,
	RunRollup,
	RunSummary,
	RunTokens,
	VerifyOutcome,
} from "./types.ts";
