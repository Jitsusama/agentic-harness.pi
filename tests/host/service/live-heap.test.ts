/** The heap a host weighs itself by: what V8 held after its last full collection. */
import { describe, expect, it } from "vitest";
import { heapAfterFullCollections } from "../../../host/service/live-heap.ts";

const MB = 1024 * 1024;

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
		v8.collect(3300);
		expect(heap.read().usedBytes).toBe(3300 * MB);
	});

	it("stops watching once stopped", () => {
		const v8 = fakeV8(900);
		const heap = heapAfterFullCollections(v8.watch, v8.read);
		expect(v8.watching()).toBe(true);
		heap.stop();
		expect(v8.watching()).toBe(false);
	});
});
