import { describe, expect, it } from "vitest";
import {
	buildHunkRanges,
	clampToHunkRange,
	parseDiff,
} from "../../../../lib/internal/github/diff.js";

const DELETION_ONLY_DIFF = [
	"diff --git a/foo.txt b/foo.txt",
	"index abc1234..def5678 100644",
	"--- a/foo.txt",
	"+++ b/foo.txt",
	"@@ -10,5 +9,0 @@ surrounding context",
	"-old line 1",
	"-old line 2",
	"-old line 3",
	"-old line 4",
	"-old line 5",
	"",
].join("\n");

const SINGLE_LINE_HUNK_DIFF = [
	"diff --git a/bar.txt b/bar.txt",
	"index 111..222 100644",
	"--- a/bar.txt",
	"+++ b/bar.txt",
	"@@ -1 +1 @@",
	"-was",
	"+now",
	"",
].join("\n");

describe("buildHunkRanges", () => {
	it("yields a valid non-inverted range for a pure-deletion hunk", () => {
		const ranges = buildHunkRanges(parseDiff(DELETION_ONLY_DIFF));
		const foo = ranges.get("foo.txt");

		expect(foo).toHaveLength(1);
		const [range] = foo ?? [];
		// A pure deletion (@@ ... +9,0 @@) adds no new-side lines, so
		// the range must anchor at newStart rather than invert to
		// {start: 9, end: 8}, which no consumer can place a comment in.
		expect(range.end).toBeGreaterThanOrEqual(range.start);
		expect(range).toEqual({ start: 9, end: 9 });
	});

	it("yields a single-line range for a hunk with omitted counts", () => {
		const ranges = buildHunkRanges(parseDiff(SINGLE_LINE_HUNK_DIFF));
		// `@@ -1 +1 @@` omits the count, which means one line.
		expect(ranges.get("bar.txt")).toEqual([{ start: 1, end: 1 }]);
	});
});

describe("clampToHunkRange", () => {
	it("returns a line inside a hunk unchanged", () => {
		expect(clampToHunkRange(7, [{ start: 5, end: 10 }])).toBe(7);
	});

	it("snaps an out-of-range line to the nearest boundary", () => {
		expect(clampToHunkRange(20, [{ start: 5, end: 10 }])).toBe(10);
		expect(clampToHunkRange(1, [{ start: 5, end: 10 }])).toBe(5);
	});

	it("breaks an equidistant tie toward the lower boundary", () => {
		// Line 5 is three away from boundary 2 (end of the first hunk)
		// and three away from boundary 8 (start of the second); the
		// lower boundary must win deterministically.
		expect(
			clampToHunkRange(5, [
				{ start: 1, end: 2 },
				{ start: 8, end: 9 },
			]),
		).toBe(2);
	});

	it("returns the line unchanged when there are no ranges", () => {
		expect(clampToHunkRange(42, [])).toBe(42);
		expect(clampToHunkRange(42, undefined)).toBe(42);
	});
});
