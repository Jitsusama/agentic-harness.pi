/**
 * The ledger: a store of billable turns, and what one is.
 *
 * Cost is derived from the logs a harness already writes rather than
 * recorded a second time, so there is exactly one writer of the truth
 * and the ledger can be rebuilt from scratch whenever its shape
 * changes.
 *
 * Reading those logs is not here. A turn is a portable idea; the format
 * it was written in is not, so each harness parses its own and hands
 * over records. This module knows what a turn is and where to keep it.
 */

export {
	type CostDimension,
	type CostSlice,
	LEDGER_QUERY_ROW_CAP,
	type LedgerReader,
	type LedgerTotal,
	openLedgerReader,
	openTurnStore,
	type RecordOutcome,
	type TurnStore,
} from "./store.ts";
export type {
	CallScope,
	CompactionFacts,
	DroppedCallRecord,
	PaybackReplay,
	QueryAnswer,
	Regret,
	RegretReport,
	RepeatedCall,
	SessionRecord,
	ToolCallRecord,
	TurnFacts,
	TurnKind,
	TurnPrecedent,
	TurnRecord,
	VerifierKind,
	VerifierOutcome,
} from "./types.ts";
