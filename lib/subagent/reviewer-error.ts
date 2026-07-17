/**
 * A reviewer's final turn ending in a provider or transport
 * error rather than a normal stop. A dropped model stream
 * (the child still exits 0) is the common case: without this
 * signal the drop is indistinguishable from a reviewer that
 * finished but never called verify_output.
 */
export interface ReviewerError {
	/** The terminal turn's stop reason, e.g. "error". */
	readonly stopReason: string;
	/** The provider or transport error message, verbatim. */
	readonly message: string;
}

/** Whether a reviewer's terminal error is worth resuming. */
export type ReviewerErrorClass = "transient" | "fatal";

// A transient failure leaves the investigation intact and a
// resume is cheap and likely to succeed: a dropped, closed
// or reset stream, a socket or network timeout, a 5xx, or a
// rate limit. These patterns are matched case-insensitively
// against the provider's own error text.
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	/stream (ended|closed|dropped|disconnected)/i,
	/(econnreset|epipe|etimedout|econnrefused|enetunreach)/i,
	/socket hang up/i,
	/network (error|timeout)/i,
	/\btimed? ?out\b/i,
	/\b(500|502|503|504)\b/,
	/service unavailable/i,
	/\b429\b/,
	/rate.?limit/i,
	/overloaded/i,
	/temporarily unavailable/i,
];

/**
 * Classify a reviewer's terminal error as transient (worth
 * an automatic resume) or fatal (must surface for the user
 * to fix). An unrecognized error is treated as fatal so a
 * genuinely broken run never spins on a blind auto-resume.
 */
export function classifyReviewerError(
	error: ReviewerError,
): ReviewerErrorClass {
	const text = error.message;
	if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
		return "transient";
	}
	return "fatal";
}

/**
 * Human-readable warning for a reviewer's terminal error. A
 * transient drop is called out as recoverable; a fatal error
 * names the likely fix so the user is not left re-running a
 * broken configuration.
 */
export function describeReviewerError(error: ReviewerError): string {
	if (classifyReviewerError(error) === "transient") {
		return `Reviewer model stream ended before it could report (transient provider error): ${error.message}`;
	}
	return `Reviewer run ended on a ${error.stopReason} error and will not be resumed automatically (check credentials, model id and thinking level): ${error.message}`;
}
