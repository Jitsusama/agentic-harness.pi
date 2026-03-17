/**
 * PR Review action handlers — thin functions that guard,
 * operate, and return briefings.
 *
 * Each handler receives a HandlerDeps bundle. The index.ts
 * switch statement delegates to these. All handlers are stubs
 * pending implementation in later milestones.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { PRReviewState } from "./state.js";

// ---- Types ----

/** Structured comment input from the tool parameters. */
export interface CommentInput {
	file: string | null;
	startLine: number | null;
	endLine: number | null;
	label: string;
	decorations: string[];
	subject: string;
	discussion: string;
	category: "file" | "title" | "scope";
}

/** Source file role description from generate-comments. */
export interface SourceRoleInput {
	path: string;
	role: string;
}

/** Dependencies shared by all handlers. */
export interface HandlerDeps {
	state: PRReviewState;
	pi: ExtensionAPI;
}

// ---- Helpers ----

/** Build a simple text tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Stub result for unimplemented handlers. */
function notImplemented(action: string) {
	return textResult(`Action '${action}' is not implemented yet.`);
}

// ---- Handlers ----

/** Activate: parse PR ref, resolve repo, crawl context. */
export async function handleActivate(
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
	_prInput: string | null,
) {
	return notImplemented("activate");
}

/** Generate comments: agent provides analysis and comments. */
export async function handleGenerateComments(
	_deps: HandlerDeps,
	_synopsis: string | null,
	_scopeAnalysis: string | null,
	_sourceRoles: SourceRoleInput[] | null,
	_comments: CommentInput[] | null,
) {
	return notImplemented("generate-comments");
}

/** Overview: show Phase 1 overview panel. */
export async function handleOverview(
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
) {
	return notImplemented("overview");
}

/** Review: show Phase 2 review panel. */
export async function handleReview(_deps: HandlerDeps, _ctx: ExtensionContext) {
	return notImplemented("review");
}

/** Add a review comment. */
export function handleAddComment(
	_deps: HandlerDeps,
	_comment: CommentInput | undefined,
) {
	return notImplemented("add-comment");
}

/** Update an existing comment. */
export function handleUpdateComment(
	_deps: HandlerDeps,
	_commentId: string | null,
	_comment: CommentInput | undefined,
) {
	return notImplemented("update-comment");
}

/** Remove a comment by ID. */
export function handleRemoveComment(
	_deps: HandlerDeps,
	_commentId: string | null,
) {
	return notImplemented("remove-comment");
}

/** Submit: show final review summary panel. */
export async function handleSubmit(
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
	_reviewBody: string | null,
	_verdict: string | null,
) {
	return notImplemented("submit");
}

/** Post: submit review to GitHub. */
export async function handlePost(_deps: HandlerDeps) {
	return notImplemented("post");
}

/** Deactivate: clean up and exit review mode. */
export async function handleDeactivate(
	_deps: HandlerDeps,
	_ctx: ExtensionContext,
) {
	return notImplemented("deactivate");
}
