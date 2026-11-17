/** The heap a host weighs itself by: what V8 held after its last full collection. */
import { setTimeout as pause } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { heapAfterFullCollections } from "../../../host/service/live-heap.ts";

const MB = 1024 * 1024;

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
	let collected: (() => void) | undefined;
	let watching = false;
	return {
		read: () => ({ usedBytes: used, limitBytes: 4144 * MB }),
		watch: (onFull: () => void) => {
			collected = onFull;
			watching = true;
			return () => {
				watching = false;
			};
		},
		allocate: (mb: number) => {
			used = mb * MB;
		},
		collect: (toMb: number) => {
			used = toMb * MB;
			collected?.();
		},
		watching: () => watching,
	};
}

describe("heapAfterFullCollections", () => {
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
		const heap = heapAfterFullCollections(undefined, read);
		gc({ type: "minor", execution: "sync" });
		await pause(DELIVERED_MS);
		expect(read, "not after a minor collection").not.toHaveBeenCalled();

		gc({ type: "major", execution: "sync" });
		await vi.waitFor(() => expect(read).toHaveBeenCalled());

		heap.stop();
		read.mockClear();
		gc({ type: "major", execution: "sync" });
		await pause(DELIVERED_MS);
		expect(read, "stopped").not.toHaveBeenCalled();
	});

	it("stops watching once stopped", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		expect(v8.watching()).toBe(true);
		heap.stop();
		expect(v8.watching()).toBe(false);
	});
});
