/**
 * CI state for a change.
 *
 * The interesting distinction is between a check that failed
 * and a check that has not reported yet. One backend
 * represents the latter as a null status rather than a
 * pending one, and a consumer that folds the two together
 * will tell someone their change is broken when nothing has
 * run.
 */

/** Where one check stands. */
export type CheckState =
	| "passing"
	| "failing"
	| "pending"
	/** Registered but yet to report anything. */
	| "unreported"
	| "skipped";

/** One check. */
export interface Check {
	name: string;
	state: CheckState;
	url?: string;
	/** True when the change cannot merge without it. */
	required?: boolean;
	summary?: string;
}

/**
 * What came of asking for checks to run again.
 *
 * A union rather than nothing, because the two outcomes need
 * different things from the reader. `started` means CI has been
 * asked and the answer will arrive later, so a caller polls or
 * waits. `declined` means the backend understood and refused, and
 * the reason belongs to the backend rather than to us: a change
 * that has already landed, a queue that will not accept a retry, a
 * pipeline nobody recognizes.
 *
 * `which` echoes back what was actually rerun. Asking for one
 * pipeline by name and being given all of them is a difference the
 * caller cannot otherwise see, and it costs real CI minutes.
 */
export type RerunOutcome =
	| { kind: "started"; which?: string; url?: string }
	| { kind: "declined"; reason: string };

/** Every check on a change, plus the answer people want. */
export interface ChecksRollup {
	/**
	 * The rollup. `pending` while anything required is still
	 * running or unreported; `failing` when anything required
	 * failed.
	 */
	state: CheckState;
	checks: Check[];
}
