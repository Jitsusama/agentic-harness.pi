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
const misordered: SectionViolation = {
	kind: "section",
	issue: "misordered",
	found: "### 🌐 Situation then ### 🔧 Resolution then ### 🔬 Validation",
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

	it("names the required order under an out-of-order instruction", () => {
		const message = formatSectionBlock([misordered], "PR", "github-pr-format");
		expect(message).toMatch(/out of order/i);
		expect(message).toContain(
			"### 🌐 Situation then ### 🔧 Resolution then ### 🔬 Validation",
		);
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
