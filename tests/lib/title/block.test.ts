import { describe, expect, it } from "vitest";
import {
	formatTitleBlock,
	type TitleViolation,
} from "../../../lib/title/index.js";

const cc: TitleViolation = {
	kind: "title",
	issue: "conventional-commit",
	found: "chore(monitoring):",
};
const tooLong: TitleViolation = {
	kind: "title",
	issue: "over-length",
	found: "84 characters (limit 72)",
};
const sentenceCase: TitleViolation = {
	kind: "title",
	issue: "sentence-case",
	found: "replica, memory, subprocesses",
};

describe("formatTitleBlock", () => {
	it("returns an empty string when there are no violations", () => {
		expect(formatTitleBlock([], "PR", "github-pr-format")).toBe("");
	});

	it("names the offending prefix and points at the skills", () => {
		const message = formatTitleBlock([cc], "PR", "github-pr-format");
		expect(message).toContain("chore(monitoring):");
		expect(message).toMatch(/conventional commit/i);
		expect(message).toContain("github-pr-format");
		expect(message).toContain("github-cli-convention");
	});

	it("uses the entity label", () => {
		const message = formatTitleBlock([cc], "issue", "github-issue-format");
		expect(message).toContain("issue");
		// The skill name appears twice (intro + closing pointer); just
		// confirm it is in the message.
		expect(message).toContain("github-issue-format");
	});

	it("names the length and limit on an over-length title", () => {
		const message = formatTitleBlock([tooLong], "PR", "github-pr-format");
		expect(message).toContain("84");
		expect(message).toContain("72");
		expect(message).toMatch(/upper bound is\s+enforced/i);
	});

	it("names the offending words and the Title Case rule on a sentence-case title", () => {
		const message = formatTitleBlock([sentenceCase], "PR", "github-pr-format");
		expect(message).toContain("replica, memory, subprocesses");
		expect(message).toMatch(/Title Case/i);
		expect(message).toMatch(/proper noun/i);
	});

	it("reports both violations when a title is both conventional commit and over-length", () => {
		const message = formatTitleBlock([cc, tooLong], "PR", "github-pr-format");
		expect(message).toContain("chore(monitoring):");
		expect(message).toContain("84");
	});
});
