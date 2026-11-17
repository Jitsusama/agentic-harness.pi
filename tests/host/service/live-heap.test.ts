/** The heap a host weighs itself by: what V8 held after its last full collection. */
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { heapAfterFullCollections } from "../../../host/service/live-heap.ts";

const MB = 1024 * 1024;

/** The kind of collection a gc entry says it was. */
function kindOf(entry: PerformanceEntry): unknown {
	return Reflect.get(Object(Reflect.get(entry, "detail")), "kind");
}

/**
 * Counts what V8 says it collected, as the host's watcher hears it:
 * the deliveries holding a full collection, which the watcher reads at,
 * and the minor collections delivered.
 */
function collectionsSeen() {
	let majors = 0;
	let minors = 0;
	const observer = new PerformanceObserver((list) => {
		const kinds = list.getEntries().map(kindOf);
		if (kinds.includes(constants.NODE_PERFORMANCE_GC_MAJOR)) majors++;
		minors += kinds.filter(
			(kind) => kind === constants.NODE_PERFORMANCE_GC_MINOR,
		).length;
	});
	observer.observe({ entryTypes: ["gc"] });
	return {
		majors: () => majors,
		minors: () => minors,
		stop: () => observer.disconnect(),
	};
}

// Node hands an observer its gc entries after the collection, on the loop.
const DELIVERED_MS = 100;

/** V8's own gc, exposed in a new context as the engine's quiet collection does. */
function exposedGc(): (options: object) => void {
	setFlagsFromString("--expose-gc");
	const gc: unknown = runInNewContext("gc");
	if (typeof gc !== "function") throw new Error("V8 exposed no gc");
	return (options) => gc(options);
}

// A heap the test sets, and full collections it says happened.
function fakeV8(usedMb: number) {
	let used = usedMb * MB;
	let collected: ((count: number) => void) | undefined;
	let watching = false;
	return {
		read: () => ({ usedBytes: used, limitBytes: 4144 * MB }),
		watch: (onFull: (count: number) => void) => {
			collected = onFull;
			watching = true;
			return () => {
				watching = false;
			};
		},
		allocate: (mb: number) => {
			used = mb * MB;
		},
		// One delivery of `count` full collections, which Node may batch.
		collect: (toMb: number, count = 1) => {
			used = toMb * MB;
			collected?.(count);
		},
		watching: () => watching,
	};
}

describe("heapAfterFullCollections", () => {
	// The reading moves only as V8 collects in full, so a reader asking
	// whether it has caught up with a change counts them.
	it("counts V8's full collections since it began watching", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		expect(heap.collections(), "none yet").toBe(0);
		v8.collect(1200);
		v8.collect(1300);
		expect(heap.collections(), "two").toBe(2);
	});

	// Node can hand an observer several collections at once, as V8 runs
	// them back to back near its limit and in a last-resort collection,
	// but they give one reading, and a reader waiting for two fresh ones
	// would otherwise weigh one from before what it waits on.
	it("counts one reading for several full collections delivered at once", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		v8.collect(1200, 3);
		expect(heap.collections(), "three in one delivery, read once").toBe(1);
	});

	it("reads the heap as it stands before V8 has collected in full", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		expect(heap.read().usedBytes).toBe(900 * MB);
	});

	// used_heap_size counts garbage no collection has swept, so one
	// reading between collections can sit far above what V8 keeps.
	it("reads what the last full collection kept, not garbage allocated since", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		v8.collect(1200);
		v8.allocate(3700);
		expect(heap.read()).toEqual({
			usedBytes: 1200 * MB,
			limitBytes: 4144 * MB,
		});
	});

	// A turn's passing data, live as one collection ran, would otherwise
	// read as a full heap until the next, and end every turn for it.
	it("reads the lower of its last two full collections, so one spike doesn't count", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		v8.collect(1200);
		v8.collect(3400);
		expect(heap.read().usedBytes, "the spike").toBe(1200 * MB);
		v8.collect(1300);
		expect(heap.read().usedBytes, "after it").toBe(1300 * MB);
		v8.collect(3300);
		v8.collect(3400);
		expect(heap.read().usedBytes, "a real climb").toBe(3300 * MB);
	});

	it("reads as each of V8's own full collections ends, not after a minor one, until stopped", async () => {
		const gc = exposedGc();
		const read = vi.fn(() => ({ usedBytes: MB, limitBytes: 4144 * MB }));
		// V8 may run a full collection of its own meanwhile, which counts.
		const seen = collectionsSeen();
		const heap = heapAfterFullCollections(undefined, read);
		gc({ type: "minor", execution: "sync" });
		// Delivered to every observer at once, so the host's has it too.
		await vi.waitFor(() => expect(seen.minors()).toBeGreaterThan(0));
		seen.stop();
		expect(
			read.mock.calls.length,
			"not after a minor collection, only V8's own full ones",
		).toBe(seen.majors());
		expect(heap.collections(), "one reading for each delivery").toBe(
			read.mock.calls.length,
		);

		// Cleared, so only this collection can answer the wait.
		read.mockClear();
		gc({ type: "major", execution: "sync" });
		await vi.waitFor(() => expect(read).toHaveBeenCalled());

		heap.stop();
		read.mockClear();
		gc({ type: "major", execution: "sync" });
		// A real pause: a stopped watcher sends nothing to wait on.
		await pause(DELIVERED_MS);
		expect(read, "stopped").not.toHaveBeenCalled();
	});

	it("stops watching once stopped", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		expect(v8.watching(), "watching once made").toBe(true);
		heap.stop();
		expect(v8.watching(), "not watching once stopped").toBe(false);
	});
});
