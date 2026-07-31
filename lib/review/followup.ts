/**
 * Coming back to a change you have already reviewed.
 *
 * The audit round asks where an inbound thread stands: somebody remarked on my
 * change and I need to answer honestly. This is the mirror, and it was missing.
 * I left findings on somebody else's change, they pushed, and the question is
 * whether they addressed them or simply resolved the thread. Those two look
 * identical in a thread listing, and only one of them is fine.
 *
 * It is deliberately a computation rather than a round. No model is needed to
 * notice that a thread was closed with no reply and no change to the code under
 * it. Asking one would be slower, more expensive and less certain, and it would
 * dress a fact up as a judgement.
 *
 * What it cannot do is say whether the change was the *right* change. That needs
 * reading the diff, which is a review, and this is the thing that tells you
 * which threads are worth re-reading.
 */

import type { Actor } from "./change.js";
import type { Thread } from "./conversation.js";

/**
 * How one of my remarks was received, now the change has moved on.
 *
 * Called a reception rather than a standing because the audit round already
 * owns that word for the opposite direction: where an inbound thread stands
 * against my change. Two different questions sharing one noun would make every
 * later reader check which one they were holding.
 */
export type Reception =
	/** Somebody replied after my last remark. Read it. */
	| "answered"
	/** The code under the remark moved, so something was done about it. */
	| "changed"
	/**
	 * Closed with no reply and nothing touched under it.
	 *
	 * The one worth looking at. It is not necessarily wrong: a remark can be
	 * answered by a conversation elsewhere, or be wrong, or be about something
	 * the author decided against. But it is the only standing where the thread
	 * says settled and nothing supports that.
	 */
	| "resolved-in-silence"
	/** Still open, nobody has replied, nothing has moved. */
	| "waiting"
	/**
	 * Cannot be told apart, because the backend does not report whether an
	 * anchor still describes the change.
	 *
	 * Kept separate from `waiting` on purpose. "Nothing happened" and "I cannot
	 * see whether anything happened" are different answers, and merging them
	 * would let a backend that reports less look like a change that moved less.
	 */
	| "unknown";

/** One of my threads, and how it was received. */
export interface FollowUp {
	thread: Thread;
	reception: Reception;
	/** Said in words, for a listing. */
	because: string;
}

/** Whether two actors are the same person, as this backend names them. */
function same(one: Actor, other: Actor): boolean {
	// Ids only. A display name is not an identity: two people share one, and
	// one person changes theirs, and matching on it eventually attributes
	// somebody else's remark to you.
	return one.id === other.id;
}

/** The last comment in a thread written by this actor. */
function lastFrom(thread: Thread, who: Actor): number {
	let at = -1;
	thread.comments.forEach((comment, index) => {
		if (same(comment.author, who)) at = index;
	});
	return at;
}

/**
 * Where one thread stands for the actor who remarked on it.
 *
 * Order matters. A reply is the strongest signal, because somebody wrote words
 * aimed at the remark; a moved anchor is next, because something happened even
 * if nobody said so. Silence is only reported once neither of those is true.
 */
export function receptionOf(thread: Thread, viewer: Actor): Reception {
	const mine = lastFrom(thread, viewer);
	if (mine === -1) return "unknown";

	const after = thread.comments.slice(mine + 1);
	if (after.some((comment) => !same(comment.author, viewer))) {
		return "answered";
	}

	// `stale` means the anchor no longer describes the change, which is the
	// backend telling us the code under the remark moved.
	if (thread.stale === true) return "changed";
	if (thread.stale === undefined) return "unknown";

	return thread.resolved ? "resolved-in-silence" : "waiting";
}

/** Why a reception reads the way it does, in words a listing can print. */
function becauseOf(reception: Reception, thread: Thread): string {
	switch (reception) {
		case "answered":
			return "somebody replied after your remark";
		case "changed":
			return "the code under your remark moved";
		case "resolved-in-silence":
			return thread.resolvedBy === undefined
				? "resolved, with no reply and nothing changed under it"
				: `resolved by ${thread.resolvedBy.name ?? thread.resolvedBy.id}, with no reply and nothing changed under it`;
		case "waiting":
			return "still open, nothing said and nothing moved";
		case "unknown":
			return "this backend does not say whether the anchor still describes the change";
	}
}

/**
 * My threads on a change, and where each stands.
 *
 * Only threads I spoke in, since a thread I never joined is somebody else's
 * conversation and belongs to the audit round instead. Ordered so the ones
 * worth attention come first: a thread closed in silence, then one waiting, then
 * the ones something has already happened to.
 */
export function followUpOn(
	threads: readonly Thread[],
	viewer: Actor,
): readonly FollowUp[] {
	const rank: Record<Reception, number> = {
		"resolved-in-silence": 0,
		waiting: 1,
		answered: 2,
		changed: 3,
		unknown: 4,
	};

	return threads
		.filter((thread) => lastFrom(thread, viewer) !== -1)
		.map((thread) => {
			const reception = receptionOf(thread, viewer);
			return { thread, reception, because: becauseOf(reception, thread) };
		})
		.sort((one, other) => rank[one.reception] - rank[other.reception]);
}

/** How many of each reception, for a one-line summary. */
export function tallyReceptions(
	found: readonly FollowUp[],
): Partial<Record<Reception, number>> {
	const counted: Partial<Record<Reception, number>> = {};
	for (const one of found) {
		counted[one.reception] = (counted[one.reception] ?? 0) + 1;
	}
	return counted;
}
