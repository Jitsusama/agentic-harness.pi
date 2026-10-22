/**
 * What waits to start a turn once the mesh settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createActs,
	spreadOf,
} from "../../../extensions/mesh-workflow/acts.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Acts for session "s" waiting a second plus its spread, and what they did. */
function waiting(spreadMs = 0) {
	const acted: string[][] = [];
	const acts = createActs<string>("s", { settleMs: 1000, spreadMs }, (items) =>
		acted.push(items),
	);
	return { acts, acted };
}

describe("acts", () => {
	it("are acted on together once they have waited", () => {
		const { acts, acted } = waiting();

		acts.add("first");
		vi.advanceTimersByTime(600);
		acts.add("second");
		vi.advanceTimersByTime(399);
		expect(acted).toEqual([]);
		vi.advanceTimersByTime(1);

		expect(acted).toEqual([["first", "second"]]);
	});

	it("are never acted on once taken", () => {
		const { acts, acted } = waiting();

		acts.add("first");
		expect(acts.take()).toEqual(["first"]);
		vi.advanceTimersByTime(5000);

		expect(acted).toEqual([]);
	});

	it("are acted on without what was dropped, and not at all when all was", () => {
		const { acts, acted } = waiting();

		acts.add("first");
		acts.drop((one) => one === "first");
		vi.advanceTimersByTime(1000);
		acts.add("second");
		acts.add("third");
		acts.drop((one) => one === "second");
		vi.advanceTimersByTime(1000);

		expect(acted).toEqual([["third"]]);
	});
});

describe("a session's share of the spread", () => {
	it("is its own, the same each time, and within the spread", () => {
		const shares = ["a", "b", "01a16183-df31", "01a15f3a-2255"].map((one) =>
			spreadOf(one, 30_000),
		);

		expect(new Set(shares).size).toBe(shares.length);
		expect(spreadOf("a", 30_000)).toBe(shares[0]);
		for (const share of shares) {
			expect(share).toBeGreaterThanOrEqual(0);
			expect(share).toBeLessThanOrEqual(30_000);
		}
		expect(spreadOf("a", 0)).toBe(0);
	});

	it("adds to the wait", () => {
		const spread = spreadOf("s", 500);
		const { acts, acted } = waiting(500);
		expect(spread).toBeGreaterThan(0);

		acts.add("first");
		vi.advanceTimersByTime(1000 + spread - 1);
		expect(acted).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(acted).toEqual([["first"]]);
	});
});
