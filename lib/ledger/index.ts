/**
 * Reading pi's session logs into billable turns.
 *
 * This knows pi's log format: which entry types are billable, that a
 * compaction carries its usage at the top level rather than under
 * `message`, that a session header names the working directory, and
 * that a quest-workflow entry names the quest. None of that is portable
 * to another harness, which is why it lives here and not in the core
 * package, where it sat until the layering was noticed.
 *
 * What is portable stays in core: the turn and its record, the store
 * that holds them, and the summaries computed over them.
 */

export { readTurns, SCAN_VERSION } from "./scan.js";
export { LEDGER_SCOPE, RETRIEVAL_TOOLS, WRITER_TOOLS } from "./scope.js";
export { repoOf } from "./session.js";
export type {
	DroppedCallRecord,
	LedgerScan,
	ScanCoverage,
	ToolCallRecord,
} from "./types.js";
