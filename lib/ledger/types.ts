import type {
	DroppedCallRecord,
	SessionRecord,
	ToolCallRecord,
	TurnRecord,
} from "@jitsusama/agentic-harness.core/observability";

export type {
	DroppedCallRecord,
	ToolCallRecord,
} from "@jitsusama/agentic-harness.core/observability";

/**
 * What a scan saw, so any aggregate built on it can state its own
 * coverage. An aggregate that cannot say what it missed is not evidence.
 */
export interface ScanCoverage {
	/** Lines offered to the scan. */
	readonly lines: number;
	/** Lines that parsed as JSON. */
	readonly parsed: number;
	/** Lines that did not, counted rather than thrown. */
	readonly unparseable: number;
	/** Turns carrying a cost. */
	readonly billable: number;
	/** Turns that should have carried a cost and did not. */
	readonly unmetered: number;
}

/**
 * The turns one session log yielded, and what reading it missed.
 *
 * A scan is a pi-shaped thing: it comes of parsing pi's log format. The
 * records it produces are not, which is why they are core's types and
 * this is not.
 */
export interface LedgerScan {
	readonly turns: TurnRecord[];
	readonly calls: ToolCallRecord[];
	readonly dropped: DroppedCallRecord[];
	readonly coverage: ScanCoverage;
	readonly session: SessionRecord;
}
