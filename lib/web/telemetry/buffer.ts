/**
 * A bounded record of things that happened.
 *
 * A page can log thousands of lines and issue hundreds of
 * requests. Keeping all of it risks the process; keeping a
 * silent subset risks the reader's conclusions. This keeps the
 * most recent within a budget and always says how much it had
 * to drop, so a partial record is never mistaken for a whole
 * one.
 */

/** An item as recorded, with its place in the sequence. */
export interface Recorded<T> {
	readonly seq: number;
	readonly item: T;
}

/** How much a buffer is willing to hold. */
export interface BufferLimits {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

/** A bounded, cursor-readable record. */
export interface RingBuffer<T> {
	push(item: T): void;
	all(): readonly Recorded<T>[];
	since(cursor: number): readonly Recorded<T>[];
	readonly dropped: number;
	readonly size: number;
	readonly cursor: number;
}

/** Entries a buffer holds before it starts evicting. */
export const DEFAULT_MAX_ENTRIES = 2000;

/** Bytes a buffer holds before it starts evicting. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Create a buffer that keeps the most recent entries. */
export function createRingBuffer<T>(limits: BufferLimits = {}): RingBuffer<T> {
	const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;

	const held: { record: Recorded<T>; weight: number }[] = [];
	let seen = 0;
	let dropped = 0;
	let weight = 0;

	/**
	 * Drop the oldest until the buffer is inside its budget. The
	 * last entry always stays, even when it alone exceeds the
	 * budget: an oversized record should be expensive to read,
	 * not invisible.
	 */
	const evict = (): void => {
		while (held.length > 1 && (held.length > maxEntries || weight > maxBytes)) {
			const oldest = held.shift();
			if (!oldest) break;
			weight -= oldest.weight;
			dropped += 1;
		}
	};

	return {
		push(item) {
			seen += 1;
			const cost = weigh(item);
			held.push({ record: { seq: seen, item }, weight: cost });
			weight += cost;
			evict();
		},
		all: () => held.map((entry) => entry.record),
		since: (cursor) =>
			held.filter((entry) => entry.record.seq > cursor).map((e) => e.record),
		get dropped() {
			return dropped;
		},
		get size() {
			return held.length;
		},
		get cursor() {
			return seen;
		},
	};
}

/** Roughly what an entry costs to keep. */
function weigh(item: unknown): number {
	if (typeof item === "string") return item.length;
	try {
		return JSON.stringify(item)?.length ?? 0;
	} catch {
		// A value that will not serialize (a cycle, a bigint) still
		// occupies space; charge it a nominal amount rather than
		// letting it weigh nothing and evade the budget.
		return 256;
	}
}
