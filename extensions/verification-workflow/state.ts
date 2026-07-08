/**
 * Session state for the verification workflow: the files
 * touched during the current turn, the errors still
 * outstanding, how many times the fast layer has asked the
 * agent to fix them in a row, and the last outcome for the
 * status line.
 */

import type { FileError } from "../../lib/verification/index.js";

/** The last thing the fast layer concluded, for the status line. */
export type VerifyOutcome = "unknown" | "clean" | "failing" | "deferred";

/** Mutable per-session verification state. */
export interface VerificationState {
	/** Absolute paths edited or written during the current turn. */
	touched: Set<string>;
	/** Errors still outstanding on files this loop is watching. */
	pending: FileError[];
	/** The fix request queued for the next request's context, if any. */
	pendingMessage: string | null;
	/** Consecutive fast-layer fix requests since the last clean pass. */
	attempts: number;
	/** Last fast-layer outcome, for the status line. */
	outcome: VerifyOutcome;
}

/** The number of fix requests before the loop gives up and hands back. */
export const MAX_FIX_ATTEMPTS = 3;

/** Create the initial verification state. */
export function createVerificationState(): VerificationState {
	return {
		touched: new Set(),
		pending: [],
		pendingMessage: null,
		attempts: 0,
		outcome: "unknown",
	};
}
