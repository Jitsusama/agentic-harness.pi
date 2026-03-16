/**
 * PR Review state — shape, defaults, comment lifecycle.
 *
 * Tracks the full review workflow from activation through
 * context gathering, analysis, file review, and posting.
 */

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

/** Comment vetting states. */
export type CommentState = "draft" | "accepted" | "rejected" | "edited";

/** Review workflow phases. */
export type ReviewPhase =
	| "gathering"
	| "context"
	| "description"
	| "analyzing"
	| "files"
	| "vetting"
	| "posting";

/** A single review comment in conventional comments format. */
export interface ReviewComment {
	id: string;
	file: string;
	startLine: number;
	endLine: number;
	label: ConventionalLabel;
	decorations: string[];
	subject: string;
	discussion: string;
	source: "llm" | "user";
}

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

/** A comment on an issue. */
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

/** An external link found in PR/issue bodies. */
export interface ExternalLink {
	url: string;
	title: string;
	summary: string | null;
	source: string;
	domain: string;
}

/** All context gathered during the gathering phase. */
export interface GatheredContext {
	pr: PRMetadata;
	diff: string;
	diffFiles: DiffFile[];
	issues: LinkedIssue[];
	parentIssues: LinkedIssue[];
	siblingPRs: RelatedPR[];
	externalLinks: ExternalLink[];
	prComments: IssueComment[];
}

/** GitHub review verdict. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** A previous review thread from an earlier review by the user. */
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

/** Summary of a previous review by the current user. */
export interface PreviousReview {
	id: string;
	state: string;
	submittedAt: string;
	body: string;
	threadCount: number;
}

/** Runtime state for PR review mode. */
export interface PRReviewState {
	enabled: boolean;

	// PR context
	prNumber: number | null;
	owner: string | null;
	repo: string | null;
	prBranch: string | null;
	baseBranch: string | null;
	prAuthor: string | null;
	worktreePath: string | null;
	usingWorktree: boolean;

	// Gathered context
	context: GatheredContext | null;

	// Previous reviews (re-review support)
	isReReview: boolean;
	previousReviews: PreviousReview[];
	previousThreads: PreviousThread[];

	// Analysis
	analysis: string | null;
	researchNotes: string[];

	// Phase tracking
	phase: ReviewPhase;
	fileIndex: number;
	commentIndex: number;

	// Comments
	comments: ReviewComment[];
	commentStates: Map<string, CommentState>;
	descriptionComments: ReviewComment[];

	// Review
	reviewBody: string | null;
	verdict: ReviewVerdict;
}

/** Create the initial PR review state. */
export function createPRReviewState(): PRReviewState {
	return {
		enabled: false,
		prNumber: null,
		owner: null,
		repo: null,
		prBranch: null,
		baseBranch: null,
		prAuthor: null,
		worktreePath: null,
		usingWorktree: false,
		context: null,
		isReReview: false,
		previousReviews: [],
		previousThreads: [],
		analysis: null,
		researchNotes: [],
		phase: "gathering",
		fileIndex: 0,
		commentIndex: 0,
		comments: [],
		commentStates: new Map(),
		descriptionComments: [],
		reviewBody: null,
		verdict: "COMMENT",
	};
}

/** Reset state to defaults (for deactivation). */
export function resetState(state: PRReviewState): void {
	Object.assign(state, createPRReviewState());
}

/** Count comments in a given state. */
export function countCommentsByState(
	state: PRReviewState,
	commentState: CommentState,
): number {
	let count = 0;
	for (const [, value] of state.commentStates) {
		if (value === commentState) count++;
	}
	return count;
}

/** Generate a unique comment ID. */
export function nextCommentId(): string {
	return `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
