import type {
	SessionRecord,
	TurnRecord,
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
 * One tool call, addressed by what it asked rather than what it got
 * back, with no bytes of either kept.
 *
 * The digests are what make repetition visible: a call whose arguments
 * digest to something already seen asked a question the context could
 * already answer, and that is provable waste with no value judgement
 * in it.
 */
export interface ToolCallRecord {
	/** Content address of the call, stable across a forked log. */
	readonly digest: string;
	readonly sessionId: string;
	/** The assistant entry that made the call. */
	readonly entryId: string;
	/** The call's own id, which its result names. */
	readonly callId: string;
	readonly timestamp: string;
	readonly name: string;
	/** Digest of the arguments, never the arguments. */
	readonly argsDigest: string;
	/**
	 * The file the call declared, when it declared one. Only read, edit
	 * and write do. bash is the largest tool by a wide margin and names
	 * no path, so what it touches is not visible here and is not guessed
	 * at from a command line.
	 */
	readonly path: string | null;
	/** Characters the result came back with, or null if it never came. */
	readonly resultChars: number | null;
	/** Digest of the result text, or null if it never came. */
	readonly resultDigest: string | null;
	/** Whether the result came back an error. Null when it never came. */
	readonly isError: boolean | null;
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
	readonly coverage: ScanCoverage;
	readonly session: SessionRecord;
}
