/**
 * The read front: how far a peer's read marker may move, which is only
 * past what it has been handed.
 *
 * A message is taken when it arrives, then judged (by a classifier, for
 * up to a few seconds), and handed over as a glance, a note or a turn;
 * one to act on waits up to a minute first. Moving the marker as it was
 * taken meant a reload in that time lost it: the next start caught up
 * only past the marker, and the waiting act went with the process. So
 * the marker moves only to the newest message handed over below every
 * one still waiting, and whatever a reload interrupts is caught up on
 * at the next start. Aquifer dequeues a command the same way, "only when
 * delivery crosses a recoverable handoff boundary".
 *
 * Message ids begin with the time they were stamped, so their order as
 * strings is the order they were sent.
 */

import type { Transport } from "./transport.ts";

/**
 * The ids a starting peer marks seen: those at the top of the folder at
 * or below the floor it catches up from, oldest first.
 *
 * Only the top is looked at again or watched, so an id moved to its
 * day's folder never comes back to be judged, and marking it would only
 * hold it in memory, in each conversation: the floor's whole day.
 * One written back at the top later is still never handed over, since
 * taking it finds it below the floor, though its answers and ends count.
 */
export function seenAtStart(
	transport: Pick<Transport, "recentIds">,
	floor: string,
): string[] {
	return transport.recentIds().filter((id) => id <= floor);
}

/** Where the marker may move as messages are taken and handed over. */
export interface ReadFront {
	/** A message reaching this peer was taken and is not yet handed over. */
	taken(id: string): void;
	/**
	 * These were handed over, or need nothing more. Answers the id the
	 * marker may now move to, when it may move at all.
	 */
	handed(ids: readonly string[]): string | undefined;
}

export function createReadFront(): ReadFront {
	const waiting = new Set<string>();
	// Handed over, but behind one still waiting, so the marker cannot pass.
	let behind: string[] = [];
	return {
		taken(id) {
			waiting.add(id);
		},
		handed(ids) {
			for (const id of ids) {
				if (!waiting.delete(id)) continue;
				behind.push(id);
			}
			const oldest = [...waiting].sort()[0];
			const passable = behind
				.filter((id) => oldest === undefined || id < oldest)
				.sort();
			const front = passable.pop();
			if (front === undefined) return undefined;
			behind = behind.filter((id) => id > front);
			return front;
		},
	};
}
