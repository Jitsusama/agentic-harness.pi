/**
 * What people said about a change.
 *
 * Three shapes, because the backends agree there are three:
 * a review (a verdict with a summary), a thread (an anchored
 * exchange), and a message (a remark about the change as a
 * whole). They are separate feeds, not one list, and
 * flattening them would lose the distinction every backend
 * bothers to keep.
 *
 * Thread identity is opaque on purpose. The backends key a
 * reply differently, one by the thread and one by the
 * comment that started it, so a caller hands back the whole
 * thread and the provider takes whichever key it needs.
 */

import type { Anchor } from "./anchor.js";
import type { Actor } from "./change.js";

/**
 * The reactions available. Both forges surveyed support
 * exactly this set, so it is modelled as a closed list
 * rather than an open string.
 */
export type Reaction =
	| "+1"
	| "-1"
	| "laugh"
	| "confused"
	| "heart"
	| "hooray"
	| "rocket"
	| "eyes";

/** How many people reacted one way, and whether you did. */
export interface ReactionCount {
	reaction: Reaction;
	count: number;
	/** True when the authenticated actor is among them. */
	mine?: boolean;
}

/** Something someone wrote. */
export interface Message {
	/** Provider-scoped id. Never parsed by consumers. */
	id: string;
	author: Actor;
	body: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	reactions?: ReactionCount[];
}

/** An anchored exchange about part of a change. */
export interface Thread {
	/** Provider-scoped id. Never parsed by consumers. */
	id: string;
	resolved: boolean;
	/** Who resolved it, when the provider records that. */
	resolvedBy?: Actor;
	/**
	 * Where the thread attaches. Absent for threads a
	 * provider hangs off the review rather than a line.
	 */
	anchor?: Anchor;
	/**
	 * Whether the thread's anchor still describes the change.
	 * Absent when the provider cannot tell, which is
	 * different from known-current.
	 */
	stale?: boolean;
	/** In the order they were written. */
	comments: Message[];
}

/**
 * A reviewer's position. The three every backend can express,
 * whether as an event, a vote or a trailer. A provider that
 * knows a fourth reports it through its own extensions
 * rather than widening this.
 */
export type Verdict = "approve" | "request-changes" | "comment";

/** A submitted review. */
export interface Review {
	id: string;
	author: Actor;
	verdict: Verdict;
	body: string;
	submittedAt?: string;
	url?: string;
	/** Provider vocabulary for the verdict, when it differs. */
	nativeVerdict?: string;
}

/** One anchored remark within a review being posted. */
export interface AnchoredComment {
	anchor: Anchor;
	body: string;
}

/** A review about to be posted. */
export interface WireReview {
	verdict: Verdict;
	/** The summary. Some providers require one for a verdict. */
	body: string;
	comments: AnchoredComment[];
}

/** What a provider hands back after writing something. */
export interface Posted {
	/** Provider-scoped id of what was created, when known. */
	id?: string;
	url?: string;
}
