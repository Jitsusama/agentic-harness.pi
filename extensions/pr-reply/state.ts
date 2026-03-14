/**
 * PR Reply state — shape, defaults, thread lifecycle.
 */

/** Review thread workflow states. */
export type ThreadState =
	| "pending" // Not yet addressed
	| "implementing" // Currently being worked on
	| "addressed" // Code changes made, reply pending
	| "replied" // Reply posted to GitHub
	| "deferred" // Deferred for later in session
	| "skipped"; // Skipped indefinitely

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

/** Review thread — a code comment and its replies. */
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

/** GitHub review — a reviewer's overall feedback. */
export interface Review {
	id: string;
	author: string;
	state: ReviewState;
	submittedAt: string;
	body: string;
	threadIds: string[]; // References to threads in this review
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

	// Navigation — review-first, then thread within review
	/** Index into the sorted reviews array. */
	reviewIndex: number;
	/** Whether the current review's overview has been shown. */
	reviewIntroduced: boolean;
	/** Index of the current thread within the current review's threads. */
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

/** Default plan directory, shared with plan-mode. */
export const DEFAULT_PLAN_DIR = ".pi/plans";

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
		reviewIndex: 0,
		reviewIntroduced: false,
		threadIndexInReview: 0,
		threadCommits: new Map(),
		implementationStartSHA: null,
		awaitingTDDCompletion: false,
		tddThreadId: null,
	};
}
