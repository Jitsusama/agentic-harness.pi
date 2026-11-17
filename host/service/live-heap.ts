/**
 * The heap a host weighs itself by: what V8 kept after its last full
 * collection, rather than its used heap as it stands. The used heap
 * counts garbage no collection has swept yet, and V8 lets old space grow
 * well past what it keeps before it collects, so one reading between
 * collections can sit far above the live set; a host that ended its
 * conversations' turns on such a reading would end them for memory the
 * next collection frees. Near its limit V8 collects in full often, so
 * the reading after the last one follows what it really holds.
 *
 * Node says a collection happened only after it, on the loop, so the
 * reading taken then also counts what was allocated in between: a
 * little, and on the high side.
 *
 * A turn's passing data can be live as one collection runs, and nothing
 * sweeps it until the next, which may not come for a long while once the
 * heap stops growing. So the reading is the lower of the last two full
 * collections: a spike shows in only one, while a heap really climbing
 * toward the limit makes V8 collect in full again and again.
 */

import { constants, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

/** How much heap the host uses, against the most V8 allows it. */
export interface HeapUse {
	readonly usedBytes: number;
	readonly limitBytes: number;
}

/** This process's heap as it stands, garbage included, as V8 counts it. */
function heapNow(): HeapUse {
	const { used_heap_size, heap_size_limit } = getHeapStatistics();
	return { usedBytes: used_heap_size, limitBytes: heap_size_limit };
}

/** Whether a performance entry is one of V8's full (mark-compact) collections. */
function isFullCollection(entry: PerformanceEntry): boolean {
	const detail: unknown = Reflect.get(entry, "detail");
	const kind =
		typeof detail === "object" && detail !== null
			? Reflect.get(detail, "kind")
			: undefined;
	return kind === constants.NODE_PERFORMANCE_GC_MAJOR;
}

/**
 * Calls `onFull` with how many of V8's full collections Node delivered
 * at once, which may be several back to back near the limit; answers the
 * function that stops.
 */
function watchFullCollections(onFull: (count: number) => void): () => void {
	const observer = new PerformanceObserver((list) => {
		const count = list.getEntries().filter(isFullCollection).length;
		if (count > 0) onFull(count);
	});
	observer.observe({ entryTypes: ["gc"] });
	return () => observer.disconnect();
}

/**
 * The lower of the heap after V8's last two full collections, read as
 * Node delivers them; after only one, that one; before any, the heap as
 * it stands. Several delivered at once give one reading, the heap after
 * the last. It counts every full collection too, since the reading moves
 * only at one. `watch` and `read` are V8's by default; tests give their
 * own.
 */
export function heapAfterFullCollections(
	watch: (onFull: (count: number) => void) => () => void = watchFullCollections,
	read: () => HeapUse = heapNow,
): { read(): HeapUse; collections(): number; stop(): void } {
	let last: HeapUse | undefined;
	let before: HeapUse | undefined;
	let collections = 0;
	const stop = watch((count) => {
		before = last;
		last = read();
		collections += count;
	});
	return {
		collections: () => collections,
		read: () => {
			if (last === undefined) return read();
			if (before === undefined || last.usedBytes <= before.usedBytes)
				return last;
			return before;
		},
		stop,
	};
}
