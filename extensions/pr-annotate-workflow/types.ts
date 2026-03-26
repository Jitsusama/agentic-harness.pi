/**
 * Domain types for the PR annotation workflow: proposed review
 * comments and the result of vetting them with the user.
 */

/** A comment proposed by the LLM for self-review annotation. */
export interface ProposedComment {
	path: string;
	line: number;
	startLine?: number;
	/** Concise summary of the comment's concern (e.g., "missing null check"). */
	subject?: string;
	body: string;
	rationale: string;
	side: string;
}

/** Result of the user vetting proposed comments. */
export interface VetResult {
	approved: ProposedComment[];
	rejected: number;
	edited: number;
	redirectFeedback?: string;
	/** File and comment the user was viewing when they redirected. */
	redirectComment?: ProposedComment;
	userRequests: string[];
}
