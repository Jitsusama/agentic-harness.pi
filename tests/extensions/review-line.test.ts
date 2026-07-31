/**
 * One review, one line.
 *
 * The empty-body case is the reason this test exists. It rendered as a line of
 * three spaces, because the first line of an empty body is an empty string, and it
 * read as a body that had failed to load rather than one that was never written.
 * It survived a long time because the formatting lived inside the tool's execute,
 * where no test could reach it.
 */

import { describe, expect, it } from "vitest";
import { reviewLine } from "../../extensions/review-integration/tools/see.js";

/** A review, with only the fields a line is made of. */
function review(verdict: string, body: string) {
	return { author: { id: "Jitsusama" }, verdict, body };
}

describe("a review as one line", () => {
	it("says so when there are no words, rather than leaving a blank", () => {
		const line = reviewLine(review("comment", ""));

		expect(line).toContain("no comment");
		// The old rendering left a second line holding nothing but indentation.
		expect(line.split("\n")).toHaveLength(1);
		expect(line.trimEnd()).toBe(line);
	});

	it("treats a body of only whitespace the same way", () => {
		// A newline and some spaces is not something somebody said.
		const line = reviewLine(review("approve", "\n   \n"));

		expect(line).toContain("no comment");
		expect(line.split("\n")).toHaveLength(1);
	});

	it("shows the first thing said, on its own line", () => {
		const line = reviewLine(
			review("request-changes", "This needs a test.\nAnd a name."),
		);

		expect(line.split("\n")).toEqual([
			expect.stringContaining("request-changes"),
			"   This needs a test.",
		]);
	});

	it("skips a leading blank line to find what was actually said", () => {
		// A body that opens with a blank line used to report nothing, which is the
		// same fault as the empty one wearing a different hat.
		const line = reviewLine(review("comment", "\nThe real remark."));

		expect(line).toContain("The real remark.");
		expect(line).not.toContain("no comment");
	});

	it("names who decided and what they decided", () => {
		const line = reviewLine(review("approve", "Looks right."));

		expect(line).toContain("Jitsusama");
		expect(line).toContain("approve");
	});
});
