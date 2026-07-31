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
	/** The anchor no longer describes the change, so something moved under it. */
	| "changed"
	/**
	 * Closed with no reply, and nothing here shows the code moved.
	 *
	 * The one worth looking at, and worth stating carefully. It does not claim
	 * the code is unchanged, because that is not knowable from a thread: a
	 * remark can be answered by a conversation elsewhere, or be wrong, or be
	 * about something the author decided against. What it says is narrower and
	 * still useful: the thread says settled and nothing in the thread supports
	 * that, so it is the one to re-read.
	 */
	| "resolved-quietly"
	/** Still open and nobody has replied. */
	| "waiting"
	/** Not one of mine, so there is nothing to say about it. */
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
 * How one thread was received, for the actor who remarked on it.
 *
 * Order matters. A reply is the strongest signal, because somebody wrote words
 * aimed at the remark; a moved anchor is next, because something happened even
 * if nobody said so. Quiet is only reported once neither of those is true.
 *
 * What this deliberately does **not** do is read `stale: false` as "the code did
 * not move". Those are different claims, and the backends prove it: GitHub's
 * flag is whether the diff hunk is still present, so false does correlate with
 * unchanged code, while Meteorite reports false always, because its server keeps
 * the witness commit reachable and an anchor there can never strand. Inferring
 * "nothing changed" from that would accuse an author who fixed the code of
 * closing a thread and ignoring it, on the backend where most of this work
 * happens. So a positive `stale` is evidence and its absence is not evidence of
 * the opposite.
 */
export function receptionOf(thread: Thread, viewer: Actor): Reception {
	const mine = lastFrom(thread, viewer);
	if (mine === -1) return "unknown";

	const after = thread.comments.slice(mine + 1);
	if (after.some((comment) => !same(comment.author, viewer))) {
		return "answered";
	}

	if (thread.stale === true) return "changed";
	return thread.resolved ? "resolved-quietly" : "waiting";
}

/**
 * Why a reception reads the way it does, in words a listing can print.
 *
 * The wording carries the uncertainty, which is where it belongs. A quiet
 * resolution reads differently depending on whether the backend says anything
 * about the anchor at all, and saying which of the two you are looking at is the
 * difference between a reader who checks and a reader who accuses.
 */
function becauseOf(reception: Reception, thread: Thread): string {
	switch (reception) {
		case "answered":
			return "somebody replied after your remark";
		case "changed":
			return "the anchor no longer describes the change, so something moved under it";
		case "resolved-quietly": {
			const who =
				thread.resolvedBy === undefined
					? "resolved"
					: `resolved by ${thread.resolvedBy.name ?? thread.resolvedBy.id}`;
			return thread.stale === undefined
				? `${who} with no reply, and this backend does not say whether the code moved`
				: `${who} with no reply, and the anchor still describes the change`;
		}
		case "waiting":
			return "still open, and nobody has replied";
		case "unknown":
			return "you have not spoken in this thread";
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
		"resolved-quietly": 0,
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
