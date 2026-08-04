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

		// The same explanation the guardian gives on `gh pr create`, naming
		// the heading rather than tallying an issue word against it.
		expect(complaint).toContain("github-pr-format");
		expect(complaint).toContain("Notes");
	});

	it("refuses a missing section", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			"### 🌐 Situation\n\nOnly one.",
		);

		expect(complaint).toContain("missing");
		expect(complaint).toContain("Resolution");
	});

	it("refuses a conventional-commit title", () => {
		// A PR title is descriptive, not a commit subject.
		const complaint = proposalComplaint(
			"fix(review): close the handle",
			GOOD_BODY,
		);

		expect(complaint).toContain("title convention");
		expect(complaint).toContain("fix(review):");
	});

	it("refuses prose violations in the body", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			GOOD_BODY.replace("Close it.", "Close it \u2014 properly."),
		);

		expect(complaint).toContain("prose-standard");
		expect(complaint).toContain("emdash");
	});

	it("reports structure first, and everything else with it", () => {
		// Structure leads, because there is no point polishing words in a
		// section that should not exist. It used to be the only thing said,
		// so fixing it revealed the next class and then the next, and each
		// round trip was another chance for something else to go wrong.
		const complaint = proposalComplaint(
			"fix(review): close the handle",
			`${GOOD_BODY.replace("Close it.", "Close it \u2014 properly.")}\n\n### 📝 Notes\n\nExtra.`,
		);
		const at = (needle: string) => (complaint ?? "").indexOf(needle);

		expect(complaint).toContain("sections");
		expect(complaint).toContain("title convention");
		expect(complaint).toContain("prose-standard");
		expect(at("sections")).toBeLessThan(at("title convention"));
		expect(at("title convention")).toBeLessThan(at("prose-standard"));
	});

	it("says one habit once rather than once per instance", () => {
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			GOOD_BODY.replace("Close it.", "a \u2014 b \u2014 c \u2014 d"),
		);
		const lines = (complaint ?? "").split("\n");

		// Three of them, named once with a count rather than three times.
		expect(lines.filter((line) => /\d+ emdash/.test(line))).toHaveLength(1);
		expect(complaint).toContain("3 emdashes");
	});

	it("names the offending word and its replacement", () => {
		// "use Canadian English spelling" without the word is a rule stated
		// at somebody rather than a thing they can act on.
		const complaint = proposalComplaint(
			"Close the Leaked Handle",
			GOOD_BODY.replace("Close it.", "Close the behavior."),
		);

		expect(complaint).toContain("behavior");
		expect(complaint).toContain("behaviour");
	});

	it("explains a title that is not Title Case instead of listing words", () => {
		// This used to print the rule name against its own internal tally,
		// which read as `sentence-case: fix(review, replay, whole, ...`.
		const complaint = proposalComplaint(
			"close the leaked handle in the parser",
			GOOD_BODY,
		);

		expect(complaint).toMatch(/Title Case/);
		expect(complaint).not.toMatch(/sentence-case:/);
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
