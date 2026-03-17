/**
 * PR Review state — domain model for a structured code review.
 *
 * Three levels:
 *   PRTarget      — identifies which PR is being reviewed
 *   ReviewSession — the active review with context and comments
 *   PRReviewState — runtime state (enabled, session, phase)
 */

// ---- PR identity ----

/** Identifies the PR under review. */
export interface PRTarget {
	owner: string;
	repo: string;
	number: number;
	branch: string;
	baseBranch: string;
	author: string;
}

// ---- Gathered context ----

/** PR metadata fetched from GitHub. */
export interface PRMetadata {
	number: number;
	title: string;
	body: string;
	author: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	state: string;
}

/** A parsed diff file with hunks. */
export interface DiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

/** A single hunk in a diff file. */
export interface DiffHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

/** A single line in a diff hunk. */
export interface DiffLine {
	type: "context" | "added" | "removed";
	content: string;
	oldLineNumber: number | null;
	newLineNumber: number | null;
}

/** An issue linked to the PR. */
export interface LinkedIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	comments: IssueComment[];
	parentIssue: { number: number; title: string; body: string } | null;
	subIssues: { number: number; title: string; state: string }[];
	url: string;
}

/** A comment on an issue or PR. */
export interface IssueComment {
	author: string;
	body: string;
	createdAt: string;
}

/** A PR related to the same issue. */
export interface RelatedPR {
	number: number;
	title: string;
	state: string;
	branch: string;
	relationship: "sibling" | "parent" | "child";
	url: string;
}

/** All context gathered about the PR. */
export interface GatheredContext {
	pr: PRMetadata;
	diff: string;
	diffFiles: DiffFile[];
	issues: LinkedIssue[];
	siblingPRs: RelatedPR[];
	prComments: IssueComment[];
}

// ---- Previous reviews (re-review support) ----

/** Summary of a previous review by the current user. */
export interface PreviousReview {
	id: string;
	state: string;
	submittedAt: string;
	body: string;
	threadCount: number;
}

/** A thread from a previous review. */
export interface PreviousThread {
	id: string;
	file: string;
	line: number;
	body: string;
	isResolved: boolean;
	resolvedBy: "self" | "author" | "other" | null;
	comments: PreviousThreadComment[];
}

/** A comment within a previous review thread. */
export interface PreviousThreadComment {
	author: string;
	body: string;
	createdAt: string;
}

/** Previous review data bundled for the session. */
export interface PreviousReviewData {
	reviews: PreviousReview[];
	threads: PreviousThread[];
}

// ---- Review comments ----

/** Conventional comment labels. */
export type ConventionalLabel =
	| "praise"
	| "nitpick"
	| "suggestion"
	| "issue"
	| "question"
	| "thought"
	| "todo"
	| "note"
	| "chore";

/** A review comment with inline lifecycle status. */
export interface ReviewComment {
	id: string;
	file: string;
	startLine: number;
	endLine: number;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
	status: "draft" | "accepted" | "rejected";
}

/** GitHub review verdict. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// ---- Review session ----

/** An active PR review — everything about the review in progress. */
export interface ReviewSession {
	/** The PR being reviewed. */
	pr: PRTarget;
	/** Gathered context (null until fetched, not persisted). */
	context: GatheredContext | null;
	/** Path to the git worktree, or null if using cwd. */
	worktreePath: string | null;
	/** Whether we created the worktree (vs using cwd). */
	usingWorktree: boolean;
	/** Previous review data when re-reviewing. */
	previousReview: PreviousReviewData | null;
	/** Comments collected during the review. */
	comments: ReviewComment[];
	/** The review body text. */
	body: string;
	/** The verdict (approve, request changes, comment). */
	verdict: ReviewVerdict;
}

// ---- Comment helpers ----

/** Generate a unique comment ID. */
function nextId(): string {
	return `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a comment to the session. Returns the new comment. */
export function addComment(
	session: ReviewSession,
	data: Omit<ReviewComment, "id" | "status">,
): ReviewComment {
	const comment: ReviewComment = { ...data, id: nextId(), status: "draft" };
	session.comments.push(comment);
	return comment;
}

/** Update an existing comment. Returns true if found. */
export function updateComment(
	session: ReviewSession,
	id: string,
	updates: Partial<Omit<ReviewComment, "id">>,
): boolean {
	const comment = session.comments.find((c) => c.id === id);
	if (!comment) return false;
	Object.assign(comment, updates);
	return true;
}

/** Remove a comment by ID. Returns true if found. */
export function removeComment(session: ReviewSession, id: string): boolean {
	const index = session.comments.findIndex((c) => c.id === id);
	if (index === -1) return false;
	session.comments.splice(index, 1);
	return true;
}

/** Get all comments with a given status. */
export function commentsByStatus(
	session: ReviewSession,
	status: ReviewComment["status"],
): ReviewComment[] {
	return session.comments.filter((c) => c.status === status);
}

/** Get comments for a specific file. */
export function commentsForFile(
	session: ReviewSession,
	path: string,
): ReviewComment[] {
	return session.comments.filter((c) => c.file === path);
}

// ---- Runtime state ----

/** Review workflow phases. */
export type ReviewPhase =
	| "gathering"
	| "context"
	| "description"
	| "analyzing"
	| "files"
	| "vetting"
	| "posting";

/** Runtime state for the PR review extension. */
export interface PRReviewState {
	enabled: boolean;
	session: ReviewSession | null;
	phase: ReviewPhase;
	fileIndex: number;
}

/** Create the initial state. */
export function createState(): PRReviewState {
	return {
		enabled: false,
		session: null,
		phase: "gathering",
		fileIndex: 0,
	};
}

/** Reset state to defaults. */
export function resetState(state: PRReviewState): void {
	state.enabled = false;
	state.session = null;
	state.phase = "gathering";
	state.fileIndex = 0;
}

/** Create a new review session. */
export function createSession(
	pr: PRTarget,
	context: GatheredContext,
): ReviewSession {
	return {
		pr,
		context,
		worktreePath: null,
		usingWorktree: false,
		previousReview: null,
		comments: [],
		body: "",
		verdict: "COMMENT",
	};
}
