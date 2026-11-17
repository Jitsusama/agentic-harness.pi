/**
 * The mark a host's heap tiers weigh growth from: the lowest share of
 * V8's limit its heap has read since the first look, not counting heap
 * a park frees, since a wake fills it again. A restart on that would end
 * the host's background work for memory the next host loads the same.
 *
 * A parked conversation leaves what the host runs and stays on its
 * roster. When one parks, the mark it parked under is kept, and its
 * wake puts the mark back at least that high, so whatever its park let
 * the mark fall to is undone. A close lets that go: its heap is room
 * now. One parked before the first look parked under no mark, so its
 * wake lets the mark rise with the readings until they have caught up.
 *
 * The reading moves only as V8 collects in full, and is the lower of its
 * last two, so after a wake one taken before it can stand for a long
 * while. The mark doesn't fall from a wake until V8 has collected in
 * full twice after the wake's conversations have had time to load.
 */

/** How long after a wake its conversations are given to load before collections count. */
export const HEAP_SETTLE_MS = 10 * 60_000;

/** What one look sees. */
export interface HeapLook {
	/** The share of V8's limit the heap holds, from 0 to 1. */
	readonly share: number;
	/** The conversations on the roster that aren't running, by id. */
	readonly parked: readonly string[];
	/** The conversations running, by id. */
	readonly running: readonly string[];
	/** How many full collections V8 has run. */
	readonly collections: number;
	/** Epoch milliseconds. */
	readonly now: number;
}

/** Since a wake: until when its conversations load, and the collections counted after. */
interface Settling {
	readonly loadedAt: number;
	collectionsThen: number | undefined;
	// Whether a wake in it parked under no mark, so the mark rises with the readings.
	rising: boolean;
}

/** A mark that weighs each look and answers the lowest, or nothing before the first look. */
export function heapMark(): {
	/** Weigh one look; answers whether it was the first. */
	weigh(look: HeapLook): boolean;
	lowest(): number | undefined;
} {
	let lowest: number | undefined;
	// Each parked conversation's mark when its park was first seen.
	const parkedUnder = new Map<string, number | undefined>();
	let settling: Settling | undefined;

	function woke(look: HeapLook, unmarked: boolean): void {
		settling = {
			loadedAt: look.now + HEAP_SETTLE_MS,
			collectionsThen: undefined,
			rising: unmarked || (settling?.rising ?? false),
		};
	}

	// Whether the readings have caught up with the last wake, ending its settling.
	function caughtUp(look: HeapLook): boolean {
		if (settling === undefined) return true;
		if (look.now < settling.loadedAt) return false;
		settling.collectionsThen ??= look.collections;
		// The reading is the lower of the last two full collections.
		if (look.collections < settling.collectionsThen + 2) return false;
		settling = undefined;
		return true;
	}

	return {
		lowest: () => lowest,
		weigh(look) {
			const parked = new Set(look.parked);
			const running = new Set(look.running);
			for (const [id, under] of parkedUnder) {
				if (parked.has(id)) continue;
				parkedUnder.delete(id);
				if (!running.has(id)) continue;
				if (under !== undefined && lowest !== undefined)
					lowest = Math.max(lowest, under);
				woke(look, under === undefined);
			}
			for (const id of parked)
				if (!parkedUnder.has(id)) parkedUnder.set(id, lowest);
			if (lowest === undefined) {
				lowest = look.share;
				return true;
			}
			const rising = settling?.rising ?? false;
			if (!caughtUp(look)) {
				if (rising) lowest = Math.max(lowest, look.share);
				return false;
			}
			lowest = Math.min(lowest, look.share);
			return false;
		},
	};
}
