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
		expect(message).toContain("github-issue-format");
	});
});
