/**
 * Domain model for a structured code review, organized in
 * four levels:
 *
 *   PRTarget      : identifies which PR is being reviewed
 *   PRContext      : deep context gathered for review
 *   ReviewSession : the active review with comments and tab state
 *   ReviewObservation : a single comment with lifecycle status
 */

import {
	addItem,
	promoteStatus,
	removeItem,
	removeItems,
	statusStats,
	updateItem,
} from "../../lib/internal/comments/operations.js";
import type { LifecycleItem } from "../../lib/internal/comments/types.js";
import type { DiffFile } from "../../lib/internal/github/diff.js";

/** Identifies the PR under review. */
export interface PRTarget {
	owner: string;
	repo: string;
	number: number;
	branch: string;
	baseBranch: string;
	author: string;
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

/** An issue linked to the PR (deep: includes parent/sub-issues). */
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
export interface ReviewerStatus {
	login: string;
	verdict: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
	avatarUrl?: string;
}

/** Deep context gathered for a PR review. */
export interface PRContext {
	pr: PRMetadata;
	diff: string;
	diffFiles: DiffFile[];
	issues: LinkedIssue[];
	relatedPRs: RelatedPR[];
	references: Reference[];
	sourceFiles: SourceFile[];
	reviewers: ReviewerStatus[];
	prComments: IssueComment[];
	hitDepthLimit: boolean;
}

/** Comment categories: determines which tab a comment appears in. */
export type CommentCategory = "file" | "title" | "scope";

/** Comment lifecycle status. */
export type CommentStatus = "proposed" | "pending" | "approved" | "rejected";

/** A review comment with lifecycle status. */
export interface ReviewObservation extends LifecycleItem<CommentStatus> {
	file: string | null;
	startLine: number | null;
	endLine: number | null;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
	source: "ai" | "user";
	category: CommentCategory;
}

/** GitHub review verdict. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** Per-tab UI state. */
export interface TabState {
	passed: boolean;
	activeView: "overview" | "comments" | "raw";
	commentIndex: number;
}

/** Review workflow phases. */
export type ReviewPhase = "gathering" | "overview" | "reviewing" | "submitting";

/** An active PR review: everything about the review in progress. */
export interface ReviewSession {
	pr: PRTarget;
	/** Gathered context (null until fetched, not persisted). */
	context: PRContext | null;
	/** Path used for file reads (worktree or repo root). */
	repoPath: string;
	/** Path to the git worktree, or null if on the PR branch. */
	worktreePath: string | null;
	/** AI-generated PR synopsis (from generate-comments). */
	synopsis: string;
	/** AI-generated scope analysis (from generate-comments). */
	scopeAnalysis: string;
	/** Comments collected during the review. */
	comments: ReviewObservation[];
	/** Per-tab UI state. Key = tab id. */
	tabStates: Map<string, TabState>;
	/** The review body text. */
	reviewBody: string;
	/** The verdict (approve, request changes, comment). */
	verdict: ReviewVerdict;
	/** Current workflow phase. */
	phase: ReviewPhase;
}

/** ID prefix for review comments. */
const COMMENT_PREFIX = "rc";

/** Add a comment to the session. Defaults to pending status. */
export function addComment(
	session: ReviewSession,
	data: Omit<ReviewObservation, "id" | "status">,
	status: CommentStatus = "pending",
): ReviewObservation {
	return addItem(session.comments, { ...data, status }, COMMENT_PREFIX);
}

/** Update an existing comment. Returns true if found. */
export function updateComment(
	session: ReviewSession,
	id: string,
	updates: Partial<Omit<ReviewObservation, "id">>,
): boolean {
	return updateItem(session.comments, id, updates);
}

/** Remove a comment by ID. Returns true if found. */
export function removeComment(session: ReviewSession, id: string): boolean {
	return removeItem(session.comments, id);
}

/**
 * Remove multiple comments by ID. Returns which IDs were
 * removed and which weren't found.
 */
export function removeComments(
	session: ReviewSession,
	ids: string[],
): { removed: string[]; notFound: string[] } {
	return removeItems(session.comments, ids);
}

/** Format a comment as a single-line summary with its ID. */
export function formatCommentSummary(c: ReviewObservation): string {
	const location = c.file
		? c.startLine !== null
			? c.startLine !== c.endLine
				? `${c.file}:L${c.startLine}-${c.endLine}`
				: `${c.file}:L${c.startLine}`
			: c.file
		: "(PR-level)";

	const decorStr =
		c.decorations.length > 0 ? ` (${c.decorations.join(", ")})` : "";

	return `[${c.id}] ${location} ${c.label}${decorStr}: ${c.subject} [${c.status}]`;
}

/** Filter comments by category. */
export function commentsByCategory(
	session: ReviewSession,
	category: CommentCategory,
): ReviewObservation[] {
	return session.comments.filter((c) => c.category === category);
}

/** Get comments for a specific file. */
export function commentsForFile(
	session: ReviewSession,
	path: string,
): ReviewObservation[] {
	return session.comments.filter((c) => c.file === path);
}

/** All possible comment statuses, for stats computation. */
const COMMENT_STATUSES = [
	"proposed",
	"pending",
	"approved",
	"rejected",
] as const;

/** Count comments by status. */
export function commentStats(session: ReviewSession): {
	proposed: number;
	pending: number;
	approved: number;
	rejected: number;
} {
	return statusStats(session.comments, COMMENT_STATUSES);
}

/** Promote all proposed comments to pending. */
export function promoteProposedComments(session: ReviewSession): number {
	return promoteStatus(session.comments, "proposed", "pending");
}

/** Check if a tab is passed (all comments resolved or explicit). */
export function isTabPassed(session: ReviewSession, tabId: string): boolean {
	return session.tabStates.get(tabId)?.passed ?? false;
}

/** Mark a tab as explicitly passed. */
export function markTabPassed(session: ReviewSession, tabId: string): void {
	const existing = session.tabStates.get(tabId);
	if (existing) {
		existing.passed = true;
	} else {
		session.tabStates.set(tabId, {
			passed: true,
			activeView: "overview",
			commentIndex: 0,
		});
	}
}
