/**
 * State creation and manipulation for the annotation workflow.
 */

import {
	addItem,
	findItem,
	removeItem,
	removeItems,
	statusStats,
	updateItem,
} from "../../lib/internal/comments/operations.js";
import type {
	AnnotateComment,
	AnnotateSession,
	AnnotateStatus,
	PRAnnotateState,
} from "./types.js";

/** ID prefix for annotation comments. */
const COMMENT_PREFIX = "ac";

/** All annotation statuses, for stats computation. */
const ANNOTATE_STATUSES = ["pending", "approved", "rejected"] as const;

/** Create the initial runtime state. */
export function createState(): PRAnnotateState {
	return { enabled: false, session: null };
}

/** Reset state to defaults. */
export function resetState(state: PRAnnotateState): void {
	state.enabled = false;
	state.session = null;
}

/** Create a new annotation session. */
export function createSession(
	pr: number,
	repo: string | null,
): AnnotateSession {
	return {
		pr,
		repo,
		reviewBody: "",
		comments: [],
		diffFiles: [],
	};
}

/** Add a comment to the session. */
export function addComment(
	session: AnnotateSession,
	data: Omit<AnnotateComment, "id" | "status">,
	status: AnnotateStatus = "pending",
): AnnotateComment {
	return addItem(session.comments, { ...data, status }, COMMENT_PREFIX);
}

/** Find a comment by ID. */
export function findComment(
	session: AnnotateSession,
	id: string,
): AnnotateComment | undefined {
	return findItem(session.comments, id);
}

/** Update a comment by ID. Returns true if found. */
export function updateComment(
	session: AnnotateSession,
	id: string,
	updates: Partial<Omit<AnnotateComment, "id">>,
): boolean {
	return updateItem(session.comments, id, updates);
}

/** Remove a comment by ID. Returns true if found. */
export function removeComment(session: AnnotateSession, id: string): boolean {
	return removeItem(session.comments, id);
}

/** Remove multiple comments by ID. */
export function removeComments(
	session: AnnotateSession,
	ids: string[],
): { removed: string[]; notFound: string[] } {
	return removeItems(session.comments, ids);
}

/** Count comments by status. */
export function commentStats(session: AnnotateSession): {
	pending: number;
	approved: number;
	rejected: number;
} {
	return statusStats(session.comments, ANNOTATE_STATUSES);
}

/** Format a comment as a single-line summary with its ID. */
export function formatCommentSummary(c: AnnotateComment): string {
	const range = c.startLine
		? `${c.path}:L${c.startLine}-${c.line}`
		: `${c.path}:L${c.line}`;
	return `[${c.id}] ${range}: ${c.subject ?? c.body.split("\n")[0]} [${c.status}]`;
}

/** Get comments for a specific file path. */
export function commentsForFile(
	session: AnnotateSession,
	path: string,
): AnnotateComment[] {
	return session.comments.filter((c) => c.path === path);
}
