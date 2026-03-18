/**
 * PR Review state — domain model for a structured code review.
 *
 * Four levels:
 *   PRTarget       — identifies which PR is being reviewed
 *   CrawlResult    — deep context gathered by the crawler
 *   ReviewSession  — the active review with comments and tab state
 *   PRReviewState  — runtime state (enabled, session)
 */

// Re-export diff types from the shared module so existing
// imports from state.ts continue to work.
export type { DiffFile, DiffHunk, DiffLine } from "../lib/github/diff.js";

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

// ---- Crawled context ----

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

/** An issue linked to the PR (deep — includes parent/sub-issues). */
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

/** A discovered reference from the crawl. */
export interface Reference {
	type: "issue" | "pr" | "commit" | "external" | "file";
	url: string;
	title: string;
	description: string;
	depth: number;
	source: string;
}

/** A source file the PR interacts with. */
export interface SourceFile {
	path: string;
	/** Filled by the agent during generate-comments phase. */
	role: string;
	url: string;
}

/** A reviewer and their current verdict. */
export interface Reviewer {
	login: string;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
	avatarUrl?: string;
}

/** Complete result from the deep context crawl. */
export interface CrawlResult {
	pr: PRMetadata;
	diff: string;
	diffFiles: DiffFile[];
	issues: LinkedIssue[];
	relatedPRs: RelatedPR[];
	references: Reference[];
	sourceFiles: SourceFile[];
	reviewers: Reviewer[];
	prComments: IssueComment[];
	hitDepthLimit: boolean;
}

// ---- Review comments ----

/** Comment categories — determines which tab a comment appears in. */
export type CommentCategory = "file" | "title" | "scope";

/** A review comment with lifecycle status. */
export interface ReviewComment {
	id: string;
	file: string | null;
	startLine: number | null;
	endLine: number | null;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
	status: "pending" | "approved" | "rejected";
	source: "ai" | "user";
	category: CommentCategory;
}

/** GitHub review verdict. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// ---- Tab state ----

/** Per-tab UI state. */
export interface TabState {
	handled: boolean;
	activeView: "overview" | "comments" | "raw";
	commentIndex: number;
}

// ---- Review session ----

/** Review workflow phases. */
export type ReviewPhase = "gathering" | "overview" | "reviewing" | "submitting";

/** An active PR review — everything about the review in progress. */
export interface ReviewSession {
	pr: PRTarget;
	/** Gathered context (null until fetched, not persisted). */
	context: CrawlResult | null;
	/** Path used for file reads (worktree or repo root). */
	repoPath: string;
	/** Path to the git worktree, or null if on the PR branch. */
	worktreePath: string | null;
	/** AI-generated PR synopsis (from generate-comments). */
	synopsis: string;
	/** AI-generated scope analysis (from generate-comments). */
	scopeAnalysis: string;
	/** Comments collected during the review. */
	comments: ReviewComment[];
	/** Per-tab UI state. Key = tab id. */
	tabStates: Map<string, TabState>;
	/** The review body text. */
	reviewBody: string;
	/** The verdict (approve, request changes, comment). */
	verdict: ReviewVerdict;
	/** Current workflow phase. */
	phase: ReviewPhase;
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
	const comment: ReviewComment = { ...data, id: nextId(), status: "pending" };
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

/** Filter comments by category. */
export function commentsByCategory(
	session: ReviewSession,
	category: CommentCategory,
): ReviewComment[] {
	return session.comments.filter((c) => c.category === category);
}

/** Get comments for a specific file. */
export function commentsForFile(
	session: ReviewSession,
	path: string,
): ReviewComment[] {
	return session.comments.filter((c) => c.file === path);
}

/** Count comments by status. */
export function commentStats(session: ReviewSession): {
	pending: number;
	approved: number;
	rejected: number;
} {
	let pending = 0;
	let approved = 0;
	let rejected = 0;
	for (const c of session.comments) {
		if (c.status === "pending") pending++;
		else if (c.status === "approved") approved++;
		else rejected++;
	}
	return { pending, approved, rejected };
}

/** Check if a tab is handled (all comments resolved or explicit). */
export function isTabHandled(session: ReviewSession, tabId: string): boolean {
	return session.tabStates.get(tabId)?.handled ?? false;
}

/** Mark a tab as explicitly handled. */
export function markTabHandled(session: ReviewSession, tabId: string): void {
	const existing = session.tabStates.get(tabId);
	if (existing) {
		existing.handled = true;
	} else {
		session.tabStates.set(tabId, {
			handled: true,
			activeView: "overview",
			commentIndex: 0,
		});
	}
}

// ---- Runtime state ----

/** Runtime state for the PR review extension. */
export interface PRReviewState {
	enabled: boolean;
	session: ReviewSession | null;
}

/** Create the initial state. */
export function createState(): PRReviewState {
	return {
		enabled: false,
		session: null,
	};
}

/** Reset state to defaults. */
export function resetState(state: PRReviewState): void {
	state.enabled = false;
	state.session = null;
}

/** Create a new review session. */
export function createSession(pr: PRTarget, repoPath: string): ReviewSession {
	return {
		pr,
		context: null,
		repoPath,
		worktreePath: null,
		synopsis: "",
		scopeAnalysis: "",
		comments: [],
		tabStates: new Map(),
		reviewBody: "",
		verdict: "COMMENT",
		phase: "gathering",
	};
}
