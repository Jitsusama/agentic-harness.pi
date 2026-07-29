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
