/**
 * The marks a host's heap tiers weigh growth from: the lowest share of
 * V8's limit its heap has read, not counting heap a park frees, since a
 * wake fills it again. A restart on that would end the host's background
 * work for memory the next host loads the same.
 *
 * The reading moves only as V8 collects in full, and is the lower of its
 * last two, so one taken before a change can stand for a long while
 * after it. Until V8 has collected twice after the host's first look,
 * the marks follow the reading, since the collections before may have
 * run before its resumed conversations had loaded.
 *
 * A parked conversation leaves what the host runs and stays on its
 * roster. When one parks, the marks it parked under are kept, and its
 * wake puts them back at least that high, so whatever its park let them
 * fall to is undone; a close lets that go, as its heap is room now. A
 * park and wake that both fall between two looks show as a conversation
 * that began again, and count as a wake under the marks as they stand.
 * After any wake the marks don't fall until V8 has collected in full
 * twice once the wake's conversations have had time to load.
 *
 * One parked before the first look parked under no mark, so its wake
 * lets the gap tier's mark rise with the readings for that same while.
 * The urgent tier's floor never rises so, since wakes can follow each
 * other all day, and a climb beside them would otherwise run into V8's
 * limit unseen.
 */

/** How long after a wake its conversations are given to load before collections count. */
export const HEAP_SETTLE_MS = 10 * 60_000;

/** The full collections a reading needs to have caught up, being the lower of the last two. */
const COLLECTIONS_CAUGHT_UP = 2;

/** A conversation the host runs, as one look sees it. */
export interface RunningLook {
	readonly id: string;
	/** Its place in the order conversations began on the host; a wake gives a new one. */
	readonly begun?: number;
}

/** What one look sees. */
export interface HeapLook {
	/** The share of V8's limit the heap holds, from 0 to 1. */
	readonly share: number;
	/** The conversations on the roster that aren't running, by id. */
	readonly parked: readonly string[];
	readonly running: readonly RunningLook[];
	/** How many full collections V8 has run, or nothing when each reading is fresh, as a test's are. */
	readonly collections?: number;
	/** Epoch milliseconds. */
	readonly now: number;
}

/** What the marks stand at while a wake's conversations load, or nothing once they have. */
export type MarkHeld = "settling" | "rising" | undefined;

/** The two marks: the gap tier's, and the urgent tier's floor. */
interface Marks {
	readonly lowest: number;
	readonly floor: number;
}

/** Since a wake: until when its conversations load, and the collections counted after. */
interface Loading {
	readonly loadedAt: number;
	collectionsThen: number | undefined;
}

/** Whether the readings have caught up since `loading` began. */
function loaded(loading: Loading, look: HeapLook): boolean {
	if (look.now < loading.loadedAt) return false;
	if (look.collections === undefined) return true;
	loading.collectionsThen ??= look.collections;
	return look.collections >= loading.collectionsThen + COLLECTIONS_CAUGHT_UP;
}

/** Marks that weigh each look and answer what each tier weighs growth from, or nothing before. */
export function heapMark(): {
	/** Weigh one look; answers whether it set the marks for the first time. */
	weigh(look: HeapLook): boolean;
	/** What the gap tier weighs growth from. */
	lowest(): number | undefined;
	/** What the urgent tier weighs growth from, which no wake lifts past a mark it held. */
	floor(): number | undefined;
	held(): MarkHeld;
} {
	let marks: Marks | undefined;
	let firstCollections: number | undefined;
	let set = false;
	// Each parked conversation's marks when its park was first seen.
	const parkedUnder = new Map<string, Marks | undefined>();
	let begunAt = new Map<string, number>();
	// Since any wake: the marks don't fall. Since one under no mark: the gap tier's rises.
	let settling: Loading | undefined;
	let rising: Loading | undefined;

	function since(look: HeapLook): Loading {
		return { loadedAt: look.now + HEAP_SETTLE_MS, collectionsThen: undefined };
	}

	function restore(under: Marks): void {
		if (marks === undefined) return;
		marks = {
			lowest: Math.max(marks.lowest, under.lowest),
			floor: Math.max(marks.floor, under.floor),
		};
	}

	// Whether the look shows a wake, putting back what each woken one parked under.
	function wakes(look: HeapLook): { woke: boolean; unmarked: boolean } {
		const parked = new Set(look.parked);
		const running = new Map(look.running.map(({ id, begun }) => [id, begun]));
		let woke = false;
		let unmarked = false;
		for (const [id, under] of parkedUnder) {
			if (parked.has(id)) continue;
			parkedUnder.delete(id);
			if (!running.has(id)) continue;
			woke = true;
			if (under === undefined) unmarked = true;
			else restore(under);
		}
		const begun = new Map<string, number>();
		for (const { id, begun: at } of look.running) {
			if (at === undefined) continue;
			const then = begunAt.get(id);
			if (then !== undefined && then !== at) woke = true;
			begun.set(id, at);
		}
		begunAt = begun;
		for (const id of parked)
			if (!parkedUnder.has(id)) parkedUnder.set(id, marks);
		return { woke, unmarked };
	}

	return {
		lowest: () => marks?.lowest,
		floor: () => marks?.floor,
		held: () => (rising ? "rising" : settling ? "settling" : undefined),
		weigh(look) {
			const { woke, unmarked } = wakes(look);
			if (woke) settling = since(look);
			if (unmarked) rising = since(look);
			firstCollections ??= look.collections ?? 0;
			const caughtUp =
				look.collections === undefined ||
				look.collections >= firstCollections + COLLECTIONS_CAUGHT_UP;
			if (!set) {
				marks = { lowest: look.share, floor: look.share };
				set = caughtUp;
				return set;
			}
			if (rising && loaded(rising, look)) rising = undefined;
			if (settling && loaded(settling, look)) settling = undefined;
			if (marks === undefined) return false;
			if (rising)
				marks = {
					lowest: Math.max(marks.lowest, look.share),
					floor: marks.floor,
				};
			else if (!settling)
				marks = {
					lowest: Math.min(marks.lowest, look.share),
					floor: Math.min(marks.floor, look.share),
				};
			return false;
		},
	};
}
