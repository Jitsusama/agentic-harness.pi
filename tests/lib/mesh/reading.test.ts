/**
 * The read front: the marker moves only past what was handed over.
 */
import { describe, expect, it } from "vitest";
import { createReadFront } from "../../../lib/mesh/reading.ts";

describe("the read front", () => {
	it("moves to the newest handed over once nothing older waits", () => {
		const front = createReadFront();
		front.taken("100-A");
		front.taken("200-B");

		expect(front.handed(["200-B"])).toBeUndefined();
		expect(front.handed(["100-A"])).toBe("200-B");
	});

	it("moves past what was handed below one still waiting, and no further", () => {
		const front = createReadFront();
		for (const id of ["100-A", "200-B", "300-C"]) front.taken(id);

		expect(front.handed(["100-A", "300-C"])).toBe("100-A");
		expect(front.handed(["200-B"])).toBe("300-C");
	});

	it("ignores what it never saw taken, or saw handed already", () => {
		const front = createReadFront();
		front.taken("100-A");

		expect(front.handed(["050-X"])).toBeUndefined();
		expect(front.handed(["100-A"])).toBe("100-A");
		expect(front.handed(["100-A"])).toBeUndefined();
	});
});
