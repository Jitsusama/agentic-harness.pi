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

/**
 * The ids a peer has looked at, so a watcher that reports one twice, as
 * inotify does for a rename, and the minute's look that lists it again
 * hand it over once.
 *
 * Kept only while the top folder lists them. Every peer takes every id
 * that passes through the top, 19,000 to 24,000 a day on 24 to 26
 * November, and keeping each for the peer's life grew its heap by about
 * 1 MiB a day, though a settled id is never listed again. One written
 * back at the top is known by the copy its day's folder still holds
 * ({@link Transport.writtenBack}), not by being held here.
 */
export interface SeenIds {
	has(id: string): boolean;
	add(id: string): void;
	delete(id: string): void;
	clear(): void;
	/**
	 * Let go of each id missing from this listing of the top folder and
	 * the one before it. Missing from one alone, it may have landed after
	 * the listing passed its place, and is listed next time. An empty
	 * listing lets go of nothing, since it is a folder that won't list.
	 */
	keepListed(listed: readonly string[]): void;
}

export function createSeenIds(): SeenIds {
	const ids = new Set<string>();
	// Missing from the last listing, and let go of if missing from the next.
	let missing = new Set<string>();
	return {
		has: (id) => ids.has(id),
		add(id) {
			ids.add(id);
		},
		delete(id) {
			ids.delete(id);
			missing.delete(id);
		},
		clear() {
			ids.clear();
			missing = new Set();
		},
		keepListed(listed) {
			if (listed.length === 0) return;
			const atTop = new Set(listed);
			const missingNow = new Set<string>();
			for (const id of ids) {
				if (atTop.has(id)) continue;
				if (missing.has(id)) ids.delete(id);
				else missingNow.add(id);
			}
			missing = missingNow;
		},
	};
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
