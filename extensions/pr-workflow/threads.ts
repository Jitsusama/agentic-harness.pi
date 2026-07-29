/**
 * The view of a change's conversation that this workflow speaks.
 *
 * No GitHub in here, and no network. The substrate does the reading
 * and the writing; this maps what it reports onto the shape the
 * actions already consume. `readConversation` asks a provider's
 * conversation facet for the anchored threads and the change's
 * top-level comments, and `threadViewFrom` projects them.
 *
 * They arrive as two collections, and that is the distinction that
 * matters. An anchored thread can be replied to and resolved; a
 * comment on the change as a whole can be neither, and is listed
 * for context.
 */

import {
	anchorPath,
	type ChangeRef,
	type ConversationFacet,
	type Message,
	type Thread,
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
	/**
	 * The substrate record this view was projected from, kept so a
	 * write can be keyed the way its own provider keys it.
	 *
	 * One backend addresses a reply by the thread, another by the
	 * comment that started it, and the contract deliberately does
	 * not say which field matters. Rebuilding a record from the id
	 * alone would work against GitHub and quietly address the
	 * wrong comment elsewhere.
	 *
	 * Absent on a change-wide comment, which can be neither
	 * replied to nor resolved, and on a snapshot restored from a
	 * session that predates this field.
	 */
	readonly source?: Thread;
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
		path: anchor ? (anchorPath(anchor) ?? null) : null,
		line: anchor?.subject === "line" ? anchor.line : null,
		comments: thread.comments.map(commentView),
		source: thread,
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
