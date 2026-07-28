/**
 * The view of a pull request's conversation, and the two writes
 * that act on it.
 *
 * Reading is the substrate's job now: `readConversation` asks a
 * provider's conversation facet for the anchored threads and the
 * change's top-level comments, and `threadViewFrom` maps them
 * onto the shape below. What arrives is two collections, which is
 * the distinction that matters. An anchored thread can be replied
 * to and resolved; a comment on the change as a whole can be
 * neither, and is listed for context.
 *
 * Reply and resolve still go out through this extension's own
 * GraphQL. They are mutations rather than reads, and moving them
 * onto the facet is a separate step.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGraphQL } from "../../lib/internal/github/graphql.js";
import type {
	ChangeRef,
	ConversationFacet,
	Message,
	Thread,
} from "../../lib/review/index.js";

/** Single comment inside a review thread. */
export interface ReviewThreadComment {
	readonly id: string;
	/** Login of the author. `"ghost"` for deleted accounts. */
	readonly author: string;
	readonly body: string;
	readonly createdAt: string;
	readonly url: string;
}

/** A review thread on a pull request. */
export interface ReviewThread {
	readonly id: string;
	readonly kind: "review-thread" | "review-level";
	readonly isResolved: boolean;
	readonly isOutdated: boolean;
	/** Null for PR-level threads (not anchored to a file). */
	readonly path: string | null;
	/** Null for PR-level threads or threads whose anchor was lost. */
	readonly line: number | null;
	readonly comments: ReviewThreadComment[];
}

const REPLY_MUTATION = `mutation AddThreadReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment { id url }
  }
}`;

const RESOLVE_MUTATION = `mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

/** Reply to an existing thread. Returns the new comment URL. */
export async function replyToThread(
	pi: ExtensionAPI,
	threadId: string,
	body: string,
): Promise<string> {
	const raw = await runGraphQL<unknown>(pi, REPLY_MUTATION, {
		threadId,
		body,
	});
	const comment = extractReplyComment(raw);
	return comment.url;
}

/** Resolve a thread. Returns the new resolved state. */
export async function resolveThread(
	pi: ExtensionAPI,
	threadId: string,
): Promise<boolean> {
	const raw = await runGraphQL<unknown>(pi, RESOLVE_MUTATION, { threadId });
	return extractResolvedState(raw);
}

function extractReplyComment(raw: unknown): { url: string } {
	if (!isRecord(raw)) {
		throw new Error("Reply response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("Reply response missing `data`");
	}
	const payload = data.addPullRequestReviewThreadReply;
	if (!isRecord(payload)) {
		throw new Error("Reply response missing payload");
	}
	const comment = payload.comment;
	if (!isRecord(comment)) {
		throw new Error("Reply response missing comment");
	}
	return { url: expectString(comment, "url") };
}

function extractResolvedState(raw: unknown): boolean {
	if (!isRecord(raw)) {
		throw new Error("Resolve response was not an object");
	}
	const data = raw.data;
	if (!isRecord(data)) {
		throw new Error("Resolve response missing `data`");
	}
	const payload = data.resolveReviewThread;
	if (!isRecord(payload)) {
		throw new Error("Resolve response missing payload");
	}
	const thread = payload.thread;
	if (!isRecord(thread)) {
		throw new Error("Resolve response missing thread");
	}
	return expectBoolean(thread, "isResolved");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`Review threads: \`${key}\` is not a string`);
	}
	return value;
}

function expectBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`Review threads: \`${key}\` is not a boolean`);
	}
	return value;
}

/**
 * The view of a change's conversation that this workflow's
 * actions speak, built from what the substrate reports.
 *
 * Two things arrive separately and are shown as one numbered
 * list. Anchored threads hang off a place in the diff and can be
 * replied to and resolved. The change's top-level comments hang
 * off the change itself and can be neither, which is why they
 * are tagged rather than merged: the actions refuse both
 * operations on sight instead of letting a person discover it
 * from a rejected request.
 *
 * Anchored threads come first, because the numbered list is what
 * a person names when they reply.
 */
export function threadViewFrom(
	threads: readonly Thread[],
	messages: readonly Message[],
): ReviewThread[] {
	return [...threads.map(anchoredThreadView), ...messages.map(changeWideView)];
}

/**
 * Read a change's whole conversation through the substrate.
 *
 * The two halves arrive from different reads and neither depends
 * on the other, so they are asked for together. Reading only the
 * threads is the tempting mistake: it loses every top-level
 * comment and still looks like a working read.
 */
export async function readConversation(
	conversation: ConversationFacet,
	change: ChangeRef,
): Promise<ReviewThread[]> {
	const [threads, messages] = await Promise.all([
		conversation.threads(change),
		conversation.messages(change),
	]);
	return threadViewFrom(threads, messages);
}

function anchoredThreadView(thread: Thread): ReviewThread {
	const anchor = thread.anchor;
	return {
		id: thread.id,
		// Even a thread whose anchor is gone entirely stays a
		// review thread. It can still be replied to and resolved,
		// so calling it change-wide would refuse both.
		kind: "review-thread",
		isResolved: thread.resolved,
		// The substrate leaves staleness absent when the provider
		// cannot tell. The view has only a boolean, and claiming a
		// thread is outdated on no evidence is the worse error.
		isOutdated: thread.stale === true,
		path: anchor?.path ?? null,
		line: anchor?.subject === "line" ? anchor.line : null,
		comments: thread.comments.map(commentView),
	};
}

function changeWideView(message: Message): ReviewThread {
	return {
		id: message.id,
		kind: "review-level",
		isResolved: false,
		isOutdated: false,
		path: null,
		line: null,
		comments: [commentView(message)],
	};
}

function commentView(message: Message): ReviewThreadComment {
	return {
		id: message.id,
		author: message.author.id,
		body: message.body,
		// Both are optional upstream and required here. A renderer
		// would rather lay out an empty string than the word
		// undefined.
		createdAt: message.createdAt ?? "",
		url: message.url ?? "",
	};
}
