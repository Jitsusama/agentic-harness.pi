import { describe, expect, it } from "vitest";
import { detectSectionViolations } from "../../../lib/sections/index.js";

const PR = ["### 🌐 Situation", "### 🔧 Resolution", "### 🔬 Validation"];

const cleanPr = [
	"Part of #1",
	"",
	"### 🌐 Situation",
	"The thing was broken.",
	"",
	"### 🔧 Resolution",
	"We fixed it.",
	"",
	"### 🔬 Validation",
	"A test proves it.",
].join("\n");

describe("detectSectionViolations", () => {
	it("passes a body with exactly the sanctioned sections", () => {
		expect(detectSectionViolations(cleanPr, PR)).toEqual([]);
	});

	it("flags a heading that is not sanctioned as invented", () => {
		const body = `${cleanPr}\n\n### Testing\nran it`;
		const violations = detectSectionViolations(body, PR);
		expect(violations).toContainEqual({
			kind: "section",
			issue: "invented",
			found: "### Testing",
		});
	});

	it("flags a sanctioned name at the wrong heading level as invented", () => {
		const body = cleanPr.replace("### 🌐 Situation", "## 🌐 Situation");
		const violations = detectSectionViolations(body, PR);
		expect(violations).toContainEqual({
			kind: "section",
			issue: "invented",
			found: "## 🌐 Situation",
		});
		// The level-2 heading does not satisfy the level-3 requirement,
		// so Situation also reads as missing.
		expect(violations).toContainEqual({
			kind: "section",
			issue: "missing",
			found: "### 🌐 Situation",
		});
	});

	it("flags a sanctioned name with the wrong emoji as invented", () => {
		const body = cleanPr.replace("### 🌐 Situation", "### 🌍 Situation");
		const violations = detectSectionViolations(body, PR);
		expect(violations.some((v) => v.issue === "invented")).toBe(true);
	});

	it("flags a missing required section", () => {
		const body = [
			"### 🌐 Situation",
			"broken",
			"",
			"### 🔧 Resolution",
			"fixed",
		].join("\n");
		const violations = detectSectionViolations(body, PR);
		expect(violations).toContainEqual({
			kind: "section",
			issue: "missing",
			found: "### 🔬 Validation",
		});
	});

	it("flags a complete body whose sections are out of order", () => {
		const body = [
			"### 🔧 Resolution",
			"fixed",
			"",
			"### 🌐 Situation",
			"broken",
			"",
			"### 🔬 Validation",
			"proven",
		].join("\n");
		const violations = detectSectionViolations(body, PR);
		expect(violations).toContainEqual({
			kind: "section",
			issue: "misordered",
			found: "### 🌐 Situation then ### 🔧 Resolution then ### 🔬 Validation",
		});
		// All three are present, so neither invented nor missing fires.
		expect(violations.some((v) => v.issue === "invented")).toBe(false);
		expect(violations.some((v) => v.issue === "missing")).toBe(false);
	});

	it("does not flag order when the sections are in the sanctioned order", () => {
		expect(
			detectSectionViolations(cleanPr, PR).some(
				(v) => v.issue === "misordered",
			),
		).toBe(false);
	});

	it("ignores hashes inside a fenced code block", () => {
		const body = [
			"### 🌐 Situation",
			"broken",
			"",
			"### 🔧 Resolution",
			"```sh",
			"### not a heading",
			"```",
			"",
			"### 🔬 Validation",
			"proven",
		].join("\n");
		expect(detectSectionViolations(body, PR)).toEqual([]);
	});

	it("tolerates extra spaces after the hashes and trailing whitespace", () => {
		const body = cleanPr.replace("### 🌐 Situation", "###   🌐 Situation   ");
		expect(detectSectionViolations(body, PR)).toEqual([]);
	});
});
