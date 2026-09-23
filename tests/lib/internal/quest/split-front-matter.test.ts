import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "../../../../lib/internal/quest/frontmatter.ts";

describe("splitFrontMatter", () => {
	it("separates the block from the body", () => {
		expect(splitFrontMatter("---\na: 1\nb: 2\n---\n# T\n")).toEqual({
			fmText: "a: 1\nb: 2",
			body: "# T\n",
		});
	});

	it("drops one blank line after the closing fence, and only one", () => {
		expect(splitFrontMatter("---\na: 1\n---\n\n# T")?.body).toBe("# T");
		expect(splitFrontMatter("---\na: 1\n---\n\n\n# T")?.body).toBe("\n# T");
	});

	it("accepts an empty block", () => {
		expect(splitFrontMatter("---\n---\nbody")).toEqual({
			fmText: "",
			body: "body",
		});
	});

	it("gives an empty body when the closing fence ends the text", () => {
		expect(splitFrontMatter("---\na: 1\n---")).toEqual({
			fmText: "a: 1",
			body: "",
		});
	});

	it("recognises fences with surrounding whitespace or carriage returns", () => {
		expect(splitFrontMatter("---\r\na: 1\r\n---\r\nbody")).toEqual({
			fmText: "a: 1\r",
			body: "body",
		});
		expect(splitFrontMatter(" --- \na: 1\n  ---\t\nbody")).toEqual({
			fmText: "a: 1",
			body: "body",
		});
	});

	it("ends the block at the first closing fence", () => {
		expect(splitFrontMatter("---\na: 1\n---\nx\n---\ny")).toEqual({
			fmText: "a: 1",
			body: "x\n---\ny",
		});
	});

	it("refuses text without an opening or a closing fence", () => {
		expect(splitFrontMatter("# T\n---\na: 1\n---\n")).toBeUndefined();
		expect(splitFrontMatter("---\na: 1\n")).toBeUndefined();
		expect(splitFrontMatter("")).toBeUndefined();
	});
});
