/**
 * Domain types for the PR annotation workflow: self-review
 * comments with lifecycle status and session state.
 */

import type { LifecycleItem } from "../../lib/internal/comments/types.js";
import type { DiffFile } from "../../lib/internal/github/diff.js";

/** Annotation comment lifecycle status. */
export type AnnotateStatus = "pending" | "approved" | "rejected";

/** A self-review comment with lifecycle status. */
export interface AnnotateComment extends LifecycleItem<AnnotateStatus> {
	path: string;
	line: number;
	startLine?: number;
	/** Concise summary shown as the list label. */
	subject?: string;
	body: string;
	rationale: string;
	side: string;
}

/** An active annotation session. */
export interface AnnotateSession {
	pr: number;
	repo: string | null;
	reviewBody: string;
	comments: AnnotateComment[];
	diffFiles: DiffFile[];
}

/** Runtime state for the annotation workflow. */
export interface PRAnnotateState {
	enabled: boolean;
	session: AnnotateSession | null;
}
