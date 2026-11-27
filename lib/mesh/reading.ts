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

/**
 * The ids a starting peer marks seen: those at the top of the folder at
 * or below the floor it catches up from, oldest first.
 *
 * Only the top is looked at again or watched, so an id moved to its
 * day's folder never comes back to be judged, and marking it would only
 * hold it in memory, in each conversation: the floor's whole day.
 * One written back at the top later is still never handed over, since
 * taking it finds it below the floor, though its answers and ends count.
 * Taken from the top's ids as the catch-up listed them, oldest first.
 */
export function seenAtStart(top: readonly string[], floor: string): string[] {
	return top.filter((id) => id <= floor);
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
	/**
	 * These were taken before they were read, and once read are not to be
	 * handed over: the marker passes them as it passes any id never taken.
	 * Answers the id the marker may now move to, as `handed` does, since
	 * those handed behind them meanwhile may now be passed.
	 */
	letGo(ids: readonly string[]): string | undefined;
}

/** Where the marker may move, from nothing taken yet. */
export function createReadFront(): ReadFront {
	const waiting = new Set<string>();
	// Handed over, but behind one still waiting, so the marker cannot pass.
	let behind: string[] = [];
	// The newest handed over below every one still waiting, if any.
	const passable = (): string | undefined => {
		const oldest = [...waiting].sort()[0];
		const front = behind
			.filter((id) => oldest === undefined || id < oldest)
			.sort()
			.pop();
		if (front === undefined) return undefined;
		behind = behind.filter((id) => id > front);
		return front;
	};
	return {
		taken(id) {
			waiting.add(id);
		},
		handed(ids) {
			for (const id of ids) {
				if (!waiting.delete(id)) continue;
				behind.push(id);
			}
			return passable();
		},
		letGo(ids) {
			for (const id of ids) waiting.delete(id);
			return passable();
		},
	};
}
