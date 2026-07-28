import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../../lib/review";

const modified = `diff --git a/lib/app.ts b/lib/app.ts
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
`;

describe("parseUnifiedDiff", () => {
	it("reads nothing out of an empty diff", () => {
		expect(parseUnifiedDiff("")).toEqual({ files: [] });
	});

	it("names the old and new paths of a modified file", () => {
		const [file] = parseUnifiedDiff(modified).files;
		expect(file.oldPath).toBe("lib/app.ts");
		expect(file.newPath).toBe("lib/app.ts");
		expect(file.status).toBe("modified");
	});

	it("carries the blob ids from the index line", () => {
		const [file] = parseUnifiedDiff(modified).files;
		expect(file.oldBlob).toBe("83db48f");
		expect(file.newBlob).toBe("bf269f4");
	});

	it("reads the hunk's old and new ranges", () => {
		const [hunk] = parseUnifiedDiff(modified).files[0].hunks;
		expect(hunk.oldStart).toBe(1);
		expect(hunk.oldCount).toBe(4);
		expect(hunk.newStart).toBe(1);
		expect(hunk.newCount).toBe(5);
	});

	it("numbers each line on the side it exists on", () => {
		const [hunk] = parseUnifiedDiff(modified).files[0].hunks;
		expect(hunk.lines).toEqual([
			{ kind: "context", oldLine: 1, newLine: 1, text: "const one = 1;" },
			{ kind: "removed", oldLine: 2, text: "const two = 2;" },
			{ kind: "added", newLine: 2, text: 'const two = "two";' },
			{ kind: "added", newLine: 3, text: "const three = 3;" },
			{ kind: "context", oldLine: 3, newLine: 4, text: "const four = 4;" },
			{ kind: "context", oldLine: 4, newLine: 5, text: "const five = 5;" },
		]);
	});

	it("reads an added file as having no old side", () => {
		const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+first
+second
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.status).toBe("added");
		expect(file.oldPath).toBeUndefined();
		expect(file.newPath).toBe("new.ts");
	});

	it("reads a deleted file as having no new side", () => {
		const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index e69de29..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-was here
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.status).toBe("deleted");
		expect(file.oldPath).toBe("gone.ts");
		expect(file.newPath).toBeUndefined();
	});

	it("reads a rename as both paths with a similarity", () => {
		const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 92%
rename from old/name.ts
rename to new/name.ts
index 83db48f..bf269f4 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-one
+two
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.status).toBe("renamed");
		expect(file.oldPath).toBe("old/name.ts");
		expect(file.newPath).toBe("new/name.ts");
		expect(file.similarity).toBe(92);
	});

	it("keeps several files in the order the diff lists them", () => {
		const diff = `${modified}diff --git a/second.ts b/second.ts
index 1111111..2222222 100644
--- a/second.ts
+++ b/second.ts
@@ -10,2 +10,2 @@ function context() {
-before
+after
 tail
`;
		const model = parseUnifiedDiff(diff);
		expect(model.files.map((f) => f.newPath)).toEqual([
			"lib/app.ts",
			"second.ts",
		]);
		expect(model.files[1].hunks[0].oldStart).toBe(10);
	});

	it("keeps the section heading a hunk header carries", () => {
		const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -10,2 +10,2 @@ function context() {
-before
+after
 tail
`;
		const [hunk] = parseUnifiedDiff(diff).files[0].hunks;
		expect(hunk.section).toBe("function context() {");
	});

	it("treats an omitted count as a single line", () => {
		const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -7 +7 @@
-before
+after
`;
		const [hunk] = parseUnifiedDiff(diff).files[0].hunks;
		expect(hunk.oldCount).toBe(1);
		expect(hunk.newCount).toBe(1);
	});

	it("does not mistake a no-newline marker for content", () => {
		const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-before
\\ No newline at end of file
+after
`;
		const [hunk] = parseUnifiedDiff(diff).files[0].hunks;
		expect(hunk.lines.map((l) => l.kind)).toEqual(["removed", "added"]);
	});

	it("records a binary file with no hunks", () => {
		const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.binary).toBe(true);
		expect(file.hunks).toEqual([]);
	});

	it("takes paths from the file header when git omits the pair", () => {
		// Binary files and bare mode changes carry no `---`
		// or `+++` lines, so the header is the only source.
		const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.oldPath).toBe("logo.png");
		expect(file.newPath).toBe("logo.png");
	});

	it("handles paths containing spaces", () => {
		const diff = `diff --git a/some dir/my file.ts b/some dir/my file.ts
index 1111111..2222222 100644
--- a/some dir/my file.ts
+++ b/some dir/my file.ts
@@ -1 +1 @@
-a
+b
`;
		const [file] = parseUnifiedDiff(diff).files;
		expect(file.newPath).toBe("some dir/my file.ts");
	});
});
