import { describe, expect, it } from "vitest";
import {
	formatSectionBlock,
	type SectionViolation,
} from "../../../lib/sections/index.js";

const invented: SectionViolation = {
	kind: "section",
	issue: "invented",
	found: "### Testing",
};
const missing: SectionViolation = {
	kind: "section",
	issue: "missing",
	found: "### 🔬 Validation",
};

describe("formatSectionBlock", () => {
	it("returns an empty string when there are no violations", () => {
		expect(formatSectionBlock([], "PR", "github-pr-format")).toBe("");
	});

	it("names invented headings under a remove instruction", () => {
		const message = formatSectionBlock([invented], "PR", "github-pr-format");
		expect(message).toContain("### Testing");
		expect(message).toMatch(/remove or rename/i);
	});

	it("names missing headings under an add instruction", () => {
		const message = formatSectionBlock([missing], "PR", "github-pr-format");
		expect(message).toContain("### 🔬 Validation");
		expect(message).toMatch(/missing/i);
	});

	it("points at the format skill and the entity label", () => {
		const message = formatSectionBlock(
			[invented, missing],
			"issue",
			"github-issue-format",
		);
		expect(message).toContain("github-issue-format");
		expect(message).toContain("issue");
	});
});
