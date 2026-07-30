/**
 * Authoring through a tool is not a way around the conventions.
 *
 * A guardian intercepts `gh pr create` and holds it to the PR format,
 * the title convention and the prose standard. `review_offer propose`
 * never touches a shell, so every one of those rules was reachable and
 * unenforced on the newer path, and the better the tool got the more
 * attractive that path became.
 */

import { describe, expect, it } from "vitest";
import { proposalComplaint } from "../../extensions/review-integration/conventions.js";

/** A body with the three sanctioned sections and nothing else. */
const GOOD_BODY = [
	"### 🌐 Situation",
	"",
	"The handle is never closed.",
	"",
	"### 🔧 Resolution",
	"",
	"Close it.",
	"",
	"### 🔬 Validation",
	"",
	"A test that fails without the change.",
].join("\n");

describe("holding a proposal to the conventions", () => {
	it("passes a well-formed title and body", () => {
		expect(
			proposalComplaint("Close the Leaked Handle", GOOD_BODY),
		).toBeUndefined();
	});

	it("refuses an invented section", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			`${GOOD_BODY}\n\n### 📝 Notes\n\nExtra.`,
		);

		expect(complaint).toContain("does not match the PR format");
		expect(complaint).toContain("not a way around it");
	});

	it("refuses a missing section", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			"### 🌐 Situation\n\nOnly one.",
		);

		expect(complaint).toContain("does not match the PR format");
	});

	it("refuses a conventional-commit title", () => {
		// A PR title is descriptive, not a commit subject.
		const complaint = proposalComplaint(
			"fix(review): close the handle",
			GOOD_BODY,
		);

		expect(complaint).toContain("title does not match");
	});

	it("refuses prose violations in the body", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			GOOD_BODY.replace("Close it.", "Close it \u2014 properly."),
		);

		expect(complaint).toContain("prose standard");
	});

	it("reports structure before prose", () => {
		// No point polishing words in a section that should not exist.
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			`${GOOD_BODY.replace("Close it.", "Close it \u2014 properly.")}\n\n### 📝 Notes\n\nExtra.`,
		);

		expect(complaint).toContain("PR format");
		expect(complaint).not.toContain("prose standard");
	});

	it("says one habit once rather than once per instance", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			GOOD_BODY.replace("Close it.", "a \u2014 b \u2014 c \u2014 d"),
		);
		const lines = (complaint ?? "").split("\n");

		expect(lines.filter((line) => line.includes("times"))).toHaveLength(1);
	});

	it("has nothing to say about an edit that changes neither", () => {
		// `edit` can move a base and leave the words alone.
		expect(proposalComplaint(undefined, undefined)).toBeUndefined();
	});

	it("checks a title on its own when only the title changes", () => {
		expect(proposalComplaint("fix(x): y", undefined)).toContain("title");
	});

	it("ignores an empty body rather than calling it malformed", () => {
		// Absent and empty mean the same thing here: nothing to judge.
		expect(proposalComplaint(undefined, "   ")).toBeUndefined();
	});
});
