/**
 * The marks a host's heap tiers weigh growth from: the lowest share of
 * V8's limit its heap has read, not counting heap a park frees, since a
 * wake fills it again. A restart on that would end the host's background
 * work for memory the next host loads the same.
 *
 * The reading moves only as V8 collects in full, and is the lower of its
 * last two, so one taken before a change can stand for a long while
 * after it. Until two fresh readings have come after the host's first
 * look, the marks follow the reading, since the collections before may
 * have run before its resumed conversations had loaded; several
 * collections Node delivers at once give one reading.
 *
 * A parked conversation leaves what the host runs and stays on its
 * roster. When one parks, the marks it parked under are kept, and its
 * wake puts them back at least that high, so whatever its park let them
 * fall to is undone; a close lets that go, as its heap is room now. A
 * park and wake that both fall between two looks show as a conversation
 * that began again, and count as a wake under the marks as they stand.
 * After any wake the marks don't fall until V8 has collected in full
 * twice once the wake's conversations have had time to load. A wake
 * while that while is open doesn't lengthen it, since a host's wakes can
 * come every few minutes and would otherwise hold the marks up all day,
 * so room a close freed would never count; one after its time is up
 * waits only for two fresh readings of its own.
 *
 * One parked, or begun again, before the marks were set did so under
 * no mark, so its wake lets the gap tier's mark rise with the readings
 * for that same while, the reading that ends the while included. The
 * urgent tier's floor never rises so, since wakes can follow each other
 * all day, and a climb beside them would otherwise run into V8's limit
 * unseen.
 */

/** How long after a wake its conversations are given to load before readings count. */
export const HEAP_SETTLE_MS = 10 * 60_000;

/** The fresh readings a reading needs to have caught up, being the lower of the last two. */
const READINGS_CAUGHT_UP = 2;

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
	/** How many readings V8's full collections have given, or nothing when each is fresh, as a test's are. */
	readonly readings?: number;
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

/** Since a wake: until when its conversations load, and the readings counted after. */
interface Loading {
	readonly loadedAt: number;
	readingsThen: number | undefined;
}

/** Whether the readings have caught up since `loading` began. */
function loaded(loading: Loading, look: HeapLook): boolean {
	if (look.now < loading.loadedAt) return false;
	if (look.readings === undefined) return true;
	loading.readingsThen ??= look.readings;
	return look.readings >= loading.readingsThen + READINGS_CAUGHT_UP;
}

/** Marks that weigh each look and answer what each tier weighs growth from, or nothing before. */
export function heapMark(): {
	/** Weigh one look; answers whether it set the marks for the first time. */
	weigh(look: HeapLook): boolean;
	/** What the gap tier weighs growth from, or nothing until the marks are set. */
	lowest(): number | undefined;
	/** What the urgent tier weighs growth from, which no wake lifts past a mark it held, or nothing until set. */
	floor(): number | undefined;
	held(): MarkHeld;
} {
	let marks: Marks | undefined;
	let firstReadings: number | undefined;
	let set = false;
	// Each parked conversation's marks when its park was first seen.
	const parkedUnder = new Map<string, Marks | undefined>();
	let begunAt = new Map<string, number>();
	// Since any wake: the marks don't fall. Since one under no mark: the gap tier's rises.
	let settling: Loading | undefined;
	let rising: Loading | undefined;

	function since(look: HeapLook): Loading {
		return { loadedAt: look.now + HEAP_SETTLE_MS, readingsThen: undefined };
	}

	// A wake's while: a new one when none is open, else the open one, its
	// fresh readings counted from this wake once its time is up.
	function woken(open: Loading | undefined, look: HeapLook): Loading {
		if (open === undefined) return since(look);
		if (look.now >= open.loadedAt && look.readings !== undefined)
			open.readingsThen = look.readings;
		return open;
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
			if (then !== undefined && then !== at) {
				woke = true;
				if (!set) unmarked = true;
			}
			begun.set(id, at);
		}
		begunAt = begun;
		// Marks not yet set are no marks to put back.
		for (const id of parked)
			if (!parkedUnder.has(id)) parkedUnder.set(id, set ? marks : undefined);
		return { woke, unmarked };
	}

	return {
		lowest: () => (set ? marks?.lowest : undefined),
		floor: () => (set ? marks?.floor : undefined),
		held: () => (rising ? "rising" : settling ? "settling" : undefined),
		weigh(look) {
			const { woke, unmarked } = wakes(look);
			if (woke) settling = woken(settling, look);
			if (unmarked) rising = woken(rising, look);
			firstReadings ??= look.readings ?? 0;
			if (!set) {
				marks = { lowest: look.share, floor: look.share };
				set =
					look.readings === undefined ||
					look.readings >= firstReadings + READINGS_CAUGHT_UP;
				return set;
			}
			if (marks === undefined) return false;
			// Weighed before a window ends, since the reading that ends it is
			// the first to have caught up with the wake.
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
			if (rising && loaded(rising, look)) rising = undefined;
			if (settling && loaded(settling, look)) settling = undefined;
			return false;
		},
	};
}
