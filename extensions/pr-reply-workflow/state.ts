/**
 * Defines the runtime state shape for PR reply mode, including
 * thread lifecycle states and their transitions.
 */

/** Review thread workflow states. */
export type ThreadState =
	| "pending" // Not yet addressed
	| "implementing" // Currently being worked on
	| "addressed" // Code changes made, reply pending
	| "replied" // Reply posted to GitHub
	| "passed"; // Reviewed, moving on

/** GitHub review states. */
export type ReviewState =
	| "APPROVED"
	| "CHANGES_REQUESTED"
	| "COMMENTED"
	| "DISMISSED";

/** Single comment in a review thread. */
export interface Comment {
	id: string;
	/** Numeric ID used by the REST API (in_reply_to). */
	databaseId: number;
	author: string;
	body: string;
	createdAt: string;
	inReplyTo: string | null;
}

/** Review thread: a code comment and its replies. */
export interface Thread {
	id: string; // Top-level comment ID
	reviewId: string;
	reviewer: string;
	reviewState: ReviewState;
	file: string;
	line: number;
	originalLine: number | null; // Present if outdated
	startLine: number | null; // Multi-line range start
	comments: Comment[];
	isOutdated: boolean;
	isResolved: boolean;
}

/** GitHub review: a reviewer's overall feedback. */
export interface Review {
	id: string;
	author: string;
	state: ReviewState;
	submittedAt: string;
	body: string;
	threadIds: string[]; // References to threads in this review
}

/** Per-thread analysis from the LLM's batch pre-analysis. */
export interface ThreadAnalysis {
	/** LLM's recommended action. */
	recommendation: "implement" | "reply" | "pass";
	/** LLM's analysis text (markdown). */
	analysis: string;
}

/** Per-reviewer character assessment from the LLM. */
export interface ReviewerAnalysis {
	/** Overall character of this review. */
	assessment: string;
}

/** Saved workspace position for dismiss/restore. */
export interface WorkspacePosition {
	/** Index of the active tab (0 = summary, 1+ = reviewer tabs). */
	tabIndex: number;
	/** Thread selection index per reviewer tab. */
	threadIndices: Map<string, number>;
}

/** Runtime state for PR reply mode. */
export interface PRReplyState {
	enabled: boolean;

	// PR context
	prNumber: number | null;
	owner: string | null;
	repo: string | null;
	branch: string | null;

	// Reviews (sorted by priority) and threads (grouped by review)
	reviews: Review[];
	threads: Thread[];
	threadStates: Map<string, ThreadState>;

	// Batch analysis from the LLM
	threadAnalyses: Map<string, ThreadAnalysis>;
	reviewerAnalyses: Map<string, ReviewerAnalysis>;

	// Workspace position: preserved across dismiss/restore
	workspacePosition: WorkspacePosition | null;

	// Currently selected thread ID: set by workspace actions
	currentThreadId: string | null;

	// Legacy navigation: kept for backward compat during transition
	/** @deprecated Use workspacePosition instead. */
	reviewIndex: number;
	/** @deprecated Use workspacePosition instead. */
	reviewIntroduced: boolean;
	/** @deprecated Use workspacePosition instead. */
	threadIndexInReview: number;

	// Implementation tracking
	threadCommits: Map<string, string[]>; // thread ID -> commit SHAs
	implementationStartSHA: string | null; // HEAD when implementation started

	// TDD coordination
	awaitingTDDCompletion: boolean;
	tddThreadId: string | null;
}

/**
 * Review priority for iteration order.
 * CHANGES_REQUESTED first, then COMMENTED, then APPROVED.
 */
const REVIEW_PRIORITY: Record<ReviewState, number> = {
	CHANGES_REQUESTED: 0,
	COMMENTED: 1,
	APPROVED: 2,
	DISMISSED: 3,
};

/** Sort reviews by priority (mutates the array). */
export function sortReviewsByPriority(reviews: Review[]): void {
	reviews.sort(
		(a, b) => (REVIEW_PRIORITY[a.state] ?? 3) - (REVIEW_PRIORITY[b.state] ?? 3),
	);
}

/**
 * Get the threads for a specific review, sorted by file then line.
 */
export function threadsForReview(
	review: Review,
	allThreads: Thread[],
): Thread[] {
	return allThreads
		.filter((t) => review.threadIds.includes(t.id))
		.sort((a, b) => {
			if (a.file !== b.file) return a.file.localeCompare(b.file);
			return a.line - b.line;
		});
}

/**
 * Thread priority for display. CHANGES_REQUESTED threads
 * take precedence over optional feedback.
 */
export function threadPriority(thread: Thread): "required" | "optional" {
	return thread.reviewState === "CHANGES_REQUESTED" ? "required" : "optional";
}

/** Create the initial PR reply state. */
export function createPRReplyState(): PRReplyState {
	return {
		enabled: false,
		prNumber: null,
		owner: null,
		repo: null,
		branch: null,
		reviews: [],
		threads: [],
		threadStates: new Map(),
		threadAnalyses: new Map(),
		reviewerAnalyses: new Map(),
		workspacePosition: null,
		currentThreadId: null,
		reviewIndex: 0,
		reviewIntroduced: false,
		threadIndexInReview: 0,
		threadCommits: new Map(),
		implementationStartSHA: null,
		awaitingTDDCompletion: false,
		tddThreadId: null,
	};
}
