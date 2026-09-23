import { describe, expect, it } from "vitest";
import { BoundedTextCache } from "../../../lib/demote/index.ts";

describe("BoundedTextCache", () => {
	it("returns what was put in, by digest", () => {
		const cache = new BoundedTextCache(10);
		cache.set("d1", "hello");
		expect(cache.get("d1")).toBe("hello");
	});

	it("reports a miss as undefined, not as an error", () => {
		const cache = new BoundedTextCache(10);
		expect(cache.get("missing")).toBeUndefined();
	});

	it("evicts the oldest entry once past its capacity", () => {
		const cache = new BoundedTextCache(2);
		cache.set("d1", "one");
		cache.set("d2", "two");
		cache.set("d3", "three");
		expect(cache.get("d1")).toBeUndefined();
		expect(cache.get("d2")).toBe("two");
		expect(cache.get("d3")).toBe("three");
	});

	it("re-setting an existing digest counts as a fresh entry, not a duplicate slot", () => {
		const cache = new BoundedTextCache(2);
		cache.set("d1", "one");
		cache.set("d2", "two");
		cache.set("d1", "one-again");
		cache.set("d3", "three");
		// d1 was refreshed, so d2 (now the oldest) is the one evicted.
		expect(cache.get("d2")).toBeUndefined();
		expect(cache.get("d1")).toBe("one-again");
		expect(cache.get("d3")).toBe("three");
	});
});
