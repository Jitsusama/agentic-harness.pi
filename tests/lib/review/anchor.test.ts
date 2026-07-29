import { describe, expect, it } from "vitest";
import { anchorable, parseUnifiedDiff } from "../../../lib/review";

// Old side lines 1-4, new side 1-5: line 2 was replaced and a
// line added, so each side holds a line the other does not.
const diff = parseUnifiedDiff(`diff --git a/lib/app.ts b/lib/app.ts
index 83db48f..bf269f4 100644
--- a/lib/app.ts
+++ b/lib/app.ts
@@ -1,4 +1,5 @@
 const one = 1;
-const two = 2;
+const two = "two";
+const three = 3;
 const four = 4;
 const five = 5;
@@ -20,2 +21,2 @@ function later() {
-const twenty = 20;
+const twenty = "twenty";
 const tail = 1;
`);

describe("anchorable", () => {
	it("refuses a file the diff does not touch", () => {
		const check = anchorable(diff, {
			subject: "file",
			path: "lib/other.ts",
		});
		expect(check).toEqual({ anchored: false, reason: "file-absent" });
	});

	it("accepts a file-level anchor on a file the diff touches", () => {
		const check = anchorable(diff, { subject: "file", path: "lib/app.ts" });
		expect(check.anchored).toBe(true);
	});

	it("accepts an added line on the new side", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			line: 3,
		});
		expect(check.anchored).toBe(true);
	});

	it("accepts a removed line on the old side", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "old",
			line: 2,
		});
		expect(check.anchored).toBe(true);
	});

	it("accepts a context line on either side", () => {
		const old = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "old",
			line: 4,
		});
		const now = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			line: 5,
		});
		expect([old.anchored, now.anchored]).toEqual([true, true]);
	});

	it("refuses a line the chosen side does not hold", () => {
		// New-side line 3 exists, but old-side line 3 in the
		// diff is `const four`, and old side has no line 6.
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "old",
			line: 6,
		});
		expect(check).toEqual({ anchored: false, reason: "line-absent" });
	});

	it("refuses a line outside every hunk", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			line: 12,
		});
		expect(check).toEqual({ anchored: false, reason: "line-absent" });
	});

	it("accepts a multi-line range inside one hunk", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			startLine: 2,
			line: 4,
		});
		expect(check.anchored).toBe(true);
	});

	it("refuses a range whose start comes after its end", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			startLine: 4,
			line: 2,
		});
		expect(check).toEqual({ anchored: false, reason: "range-inverted" });
	});

	it("refuses a range that spans two hunks", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			startLine: 3,
			line: 21,
		});
		expect(check).toEqual({
			anchored: false,
			reason: "range-crosses-hunks",
		});
	});

	it("matches a renamed file by the path of the side asked for", () => {
		const renamed = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-one
+two
`);
		const byOld = anchorable(renamed, {
			subject: "line",
			path: "old.ts",
			blob: "old",
			line: 1,
		});
		const byNew = anchorable(renamed, {
			subject: "line",
			path: "new.ts",
			blob: "new",
			line: 1,
		});
		const crossed = anchorable(renamed, {
			subject: "line",
			path: "new.ts",
			blob: "old",
			line: 1,
		});
		expect([byOld.anchored, byNew.anchored, crossed.anchored]).toEqual([
			true,
			true,
			false,
		]);
	});

	it("reports the file and hunk it anchored to", () => {
		const check = anchorable(diff, {
			subject: "line",
			path: "lib/app.ts",
			blob: "new",
			line: 21,
		});
		expect(check.anchored && check.file.newPath).toBe("lib/app.ts");
		expect(check.anchored && check.hunk?.section).toBe("function later() {");
	});

	it("refuses a remark about the whole change, without blaming a file", () => {
		// Some remarks are about the change itself: its shape, its
		// scope, the commit it sits on. There is no place in a diff
		// for one, and saying "that file is not in the diff" about a
		// remark that named no file would be a lie.
		const diff = parseUnifiedDiff(`diff --git a/lib/app.ts b/lib/app.ts
index 1111111..2222222 100644
--- a/lib/app.ts
+++ b/lib/app.ts
@@ -1,2 +1,3 @@
 context
+added
 context
`);

		expect(anchorable(diff, { subject: "change" })).toEqual({
			anchored: false,
			reason: "not-a-place",
		});
	});

	it("refuses a whole-change remark the same way when the diff is empty", () => {
		// The refusal is a property of the remark, not of the diff,
		// so an empty diff must not make it read as a missing file.
		expect(anchorable({ files: [] }, { subject: "change" })).toEqual({
			anchored: false,
			reason: "not-a-place",
		});
	});

	it("refuses to anchor a line in a binary file", () => {
		const binary = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`);
		const check = anchorable(binary, {
			subject: "line",
			path: "logo.png",
			blob: "new",
			line: 1,
		});
		expect(check).toEqual({ anchored: false, reason: "line-absent" });
	});
});
