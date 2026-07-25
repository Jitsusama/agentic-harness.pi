import { describe, expect, it } from "vitest";
import { createRingBuffer } from "../../../../lib/web/telemetry/index.js";

describe("createRingBuffer", () => {
	it("hands back what was put in, in order", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("first");
		buffer.push("second");
		expect(buffer.all().map((e) => e.item)).toEqual(["first", "second"]);
	});

	it("numbers entries so a reader can say where it stopped", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("a");
		buffer.push("b");
		expect(buffer.all().map((e) => e.seq)).toEqual([1, 2]);
	});

	it("returns only what arrived after a cursor", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("old");
		const mark = buffer.cursor;
		buffer.push("new");
		expect(buffer.since(mark).map((e) => e.item)).toEqual(["new"]);
	});

	it("returns everything for a cursor from before it started", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("a");
		expect(buffer.since(0).map((e) => e.item)).toEqual(["a"]);
	});

	it("returns nothing when nothing has happened since the cursor", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("a");
		expect(buffer.since(buffer.cursor)).toEqual([]);
	});

	it("keeps the most recent entries once it is full", () => {
		const buffer = createRingBuffer<string>({ maxEntries: 2 });
		buffer.push("a");
		buffer.push("b");
		buffer.push("c");
		expect(buffer.all().map((e) => e.item)).toEqual(["b", "c"]);
	});

	it("says how many it had to drop", () => {
		const buffer = createRingBuffer<string>({ maxEntries: 2 });
		for (const item of ["a", "b", "c", "d"]) buffer.push(item);
		expect(buffer.dropped).toBe(2);
	});

	it("keeps sequence numbers honest across a drop", () => {
		// The reader's cursor must still mean something after
		// eviction, so numbering counts everything ever seen.
		const buffer = createRingBuffer<string>({ maxEntries: 2 });
		for (const item of ["a", "b", "c"]) buffer.push(item);
		expect(buffer.all().map((e) => e.seq)).toEqual([2, 3]);
	});

	it("evicts by weight when entries are large", () => {
		const buffer = createRingBuffer<string>({ maxBytes: 20 });
		buffer.push("x".repeat(15));
		buffer.push("y".repeat(15));
		expect(buffer.all().map((e) => e.item)).toEqual(["y".repeat(15)]);
		expect(buffer.dropped).toBe(1);
	});

	it("keeps one entry even when it is larger than the budget", () => {
		// Dropping it would make a large record invisible rather
		// than merely expensive.
		const buffer = createRingBuffer<string>({ maxBytes: 10 });
		buffer.push("z".repeat(100));
		expect(buffer.all()).toHaveLength(1);
	});

	it("reports how many it is holding", () => {
		const buffer = createRingBuffer<string>();
		buffer.push("a");
		buffer.push("b");
		expect(buffer.size).toBe(2);
	});
});
