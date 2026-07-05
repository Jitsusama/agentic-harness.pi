import { describe, expect, it } from "vitest";
import {
	bottom,
	bump,
	diffRanks,
	nextRank,
	type RankEntry,
	after as rankAfter,
	before as rankBefore,
	renumber,
	sink,
	sortByRank,
	top,
} from "../../../lib/internal/quest/ranking";

const SET: RankEntry[] = [
	{ id: "A", rank: 1 },
	{ id: "B", rank: 2 },
	{ id: "C", rank: 3 },
	{ id: "D", rank: 4 },
];

describe("nextRank", () => {
	it("returns one past the highest existing rank", () => {
		expect(nextRank([1, 2, 4])).toBe(5);
	});

	it("starts at 1 for an empty group", () => {
		expect(nextRank([])).toBe(1);
	});
});

describe("sortByRank", () => {
	it("orders by rank ascending, id stable on ties", () => {
		const out = sortByRank([
			{ id: "C", rank: 2 },
			{ id: "A", rank: 1 },
			{ id: "B", rank: 2 },
		]);
		expect(out.map((e) => e.id)).toEqual(["A", "B", "C"]);
	});
});

describe("renumber", () => {
	it("contiguates 1..N preserving order", () => {
		const out = renumber([
			{ id: "A", rank: 10 },
			{ id: "B", rank: 20 },
			{ id: "C", rank: 30 },
		]);
		expect(out.map((e) => e.rank)).toEqual([1, 2, 3]);
	});
});

describe("top / bottom / bump / sink", () => {
	it("top moves an entry to rank 1", () => {
		const out = top(SET, "C");
		expect(out.map((e) => e.id)).toEqual(["C", "A", "B", "D"]);
		expect(out.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
	});

	it("bottom moves an entry to rank N", () => {
		const out = bottom(SET, "B");
		expect(out.map((e) => e.id)).toEqual(["A", "C", "D", "B"]);
	});

	it("bump swaps with the entry above", () => {
		const out = bump(SET, "C");
		expect(out.map((e) => e.id)).toEqual(["A", "C", "B", "D"]);
	});

	it("bump at rank 1 is a no-op (still renumbers)", () => {
		const messy: RankEntry[] = [
			{ id: "A", rank: 10 },
			{ id: "B", rank: 20 },
		];
		const out = bump(messy, "A");
		expect(out).toEqual([
			{ id: "A", rank: 1 },
			{ id: "B", rank: 2 },
		]);
	});

	it("sink swaps with the entry below", () => {
		const out = sink(SET, "B");
		expect(out.map((e) => e.id)).toEqual(["A", "C", "B", "D"]);
	});

	it("sink at the bottom is a no-op (still renumbers)", () => {
		const out = sink(SET, "D");
		expect(out.map((e) => e.id)).toEqual(["A", "B", "C", "D"]);
	});
});

describe("before / after", () => {
	it("before places id immediately before target", () => {
		const out = rankBefore(SET, "D", "B");
		expect(out.map((e) => e.id)).toEqual(["A", "D", "B", "C"]);
	});

	it("before adjusts target index when moving down", () => {
		const out = rankBefore(SET, "A", "C");
		expect(out.map((e) => e.id)).toEqual(["B", "A", "C", "D"]);
	});

	it("after places id immediately after target", () => {
		const out = rankAfter(SET, "A", "C");
		expect(out.map((e) => e.id)).toEqual(["B", "C", "A", "D"]);
	});

	it("after adjusts target index when moving up", () => {
		const out = rankAfter(SET, "D", "B");
		expect(out.map((e) => e.id)).toEqual(["A", "B", "D", "C"]);
	});

	it("before/after with same id is a no-op renumber", () => {
		const out = rankBefore(SET, "B", "B");
		expect(out).toEqual(SET);
	});

	it("returns a clean renumber when id is missing", () => {
		const out = bump(SET, "Z");
		expect(out).toEqual(SET);
	});
});

describe("diffRanks", () => {
	it("reports only changed ranks", () => {
		const a = SET;
		const b = top(SET, "C");
		const diff = diffRanks(a, b);
		expect(diff.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
			{ id: "A", from: 1, to: 2 },
			{ id: "B", from: 2, to: 3 },
			{ id: "C", from: 3, to: 1 },
		]);
	});
});
