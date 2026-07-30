import { describe, expect, it } from "vitest";
import {
	anchorableRanges,
	describeRanges,
	parseUnifiedDiff,
} from "../../../lib/review/index.js";

/** A diff of one file with one hunk, written the way git prints it. */
const oneHunk = `diff --git a/lib/a.ts b/lib/a.ts
--- a/lib/a.ts
+++ b/lib/a.ts
@@ -10,4 +10,5 @@ function held() {
 const before = 1;
-const gone = 2;
+const added = 2;
+const also = 3;
 const after = 4;
`;

describe("where a finding may anchor", () => {
	it("names the file it is talking about", () => {
		const [file] = anchorableRanges(parseUnifiedDiff(oneHunk));

		expect(file?.path).toBe("lib/a.ts");
	});

	it("covers the new side across context and added lines", () => {
		// Context is anchorable: a reviewer may legitimately point at an
		// unchanged line inside a hunk to say what the change breaks.
		const [file] = anchorableRanges(parseUnifiedDiff(oneHunk));

		expect(file?.new).toEqual([{ from: 10, to: 13 }]);
	});

	it("covers the old side across context and removed lines", () => {
		const [file] = anchorableRanges(parseUnifiedDiff(oneHunk));

		expect(file?.old).toEqual([{ from: 10, to: 12 }]);
	});

	it("keeps two hunks as two ranges rather than spanning the gap", () => {
		// The gap between hunks is not in the diff, so a range covering
		// it would invite a reviewer to anchor somewhere that cannot
		// hold a comment.
		const twoHunks = `diff --git a/lib/b.ts b/lib/b.ts
--- a/lib/b.ts
+++ b/lib/b.ts
@@ -1,2 +1,2 @@
 const a = 1;
+const b = 2;
@@ -40,2 +41,2 @@
 const y = 1;
+const z = 2;
`;

		const [file] = anchorableRanges(parseUnifiedDiff(twoHunks));

		expect(file?.new).toEqual([
			{ from: 1, to: 2 },
			{ from: 41, to: 42 },
		]);
	});

	it("gives a pure addition no old-side range at all", () => {
		// A new file has nothing on the left. Reporting an empty range
		// rather than a zero-width one keeps a caller from formatting
		// "old 0-0".
		const added = `diff --git a/lib/new.ts b/lib/new.ts
new file mode 100644
--- /dev/null
+++ b/lib/new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
`;

		const [file] = anchorableRanges(parseUnifiedDiff(added));

		expect(file?.new).toEqual([{ from: 1, to: 2 }]);
		expect(file?.old).toEqual([]);
	});

	it("gives a deletion no new-side range at all", () => {
		const deleted = `diff --git a/lib/old.ts b/lib/old.ts
deleted file mode 100644
--- a/lib/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;

		const [file] = anchorableRanges(parseUnifiedDiff(deleted));

		expect(file?.new).toEqual([]);
		expect(file?.old).toEqual([{ from: 1, to: 2 }]);
	});

	it("reports every changed file", () => {
		const two = `${oneHunk}diff --git a/lib/c.ts b/lib/c.ts
--- a/lib/c.ts
+++ b/lib/c.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

		expect(anchorableRanges(parseUnifiedDiff(two)).map((f) => f.path)).toEqual([
			"lib/a.ts",
			"lib/c.ts",
		]);
	});

	it("says nothing about a diff with no files", () => {
		expect(anchorableRanges(parseUnifiedDiff(""))).toEqual([]);
	});
});

describe("telling a reviewer where it may point", () => {
	it("writes one line per file, both sides named", () => {
		const text = describeRanges(anchorableRanges(parseUnifiedDiff(oneHunk)));

		expect(text).toBe("lib/a.ts: new 10-13 | old 10-12");
	});

	it("leaves out a side that has nothing", () => {
		// Printing "old none" would invite a reviewer to wonder what it
		// meant. Saying nothing about a side says it plainly.
		const added = `diff --git a/lib/new.ts b/lib/new.ts
--- /dev/null
+++ b/lib/new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
`;

		expect(describeRanges(anchorableRanges(parseUnifiedDiff(added)))).toBe(
			"lib/new.ts: new 1-2",
		);
	});

	it("separates several ranges on one side with commas", () => {
		const twoHunks = `diff --git a/lib/b.ts b/lib/b.ts
--- a/lib/b.ts
+++ b/lib/b.ts
@@ -1,1 +1,1 @@
+const b = 2;
@@ -40,1 +41,1 @@
+const z = 2;
`;

		expect(describeRanges(anchorableRanges(parseUnifiedDiff(twoHunks)))).toBe(
			"lib/b.ts: new 1-1, 41-41",
		);
	});

	it("writes a line per file", () => {
		const two = `${oneHunk}diff --git a/lib/c.ts b/lib/c.ts
--- a/lib/c.ts
+++ b/lib/c.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

		expect(
			describeRanges(anchorableRanges(parseUnifiedDiff(two))).split("\n"),
		).toHaveLength(2);
	});

	it("says so plainly when nothing can be anchored", () => {
		// An empty string here would read as a bug in the prompt.
		expect(describeRanges([])).toMatch(/no|nothing/i);
	});
});
