import { describe, expect, it } from "vitest";
import { detectSlackViolations } from "../../../lib/slack/index.js";

describe("detectSlackViolations", () => {
	it("passes ordinary prose and well-formed lists", () => {
		const text = [
			"Here is the plan.",
			"",
			"- first item",
			"- second item",
			"",
			"1. step one",
			"2. step two",
		].join("\n");
		expect(detectSlackViolations(text)).toEqual([]);
	});

	it("flags an image embed", () => {
		const violations = detectSlackViolations(
			"Look ![a chart](https://x/y.png).",
		);
		expect(violations.map((v) => v.kind)).toContain("slack-image");
	});

	it("flags a pipe table with a separator row", () => {
		const text = ["| Name | Age |", "| --- | --- |", "| Sam | 9 |"].join("\n");
		const violations = detectSlackViolations(text);
		expect(violations.map((v) => v.kind)).toContain("slack-table");
	});

	it("flags two or more consecutive pipe rows without a separator", () => {
		const text = ["| Sam | 9 |", "| Lee | 8 |"].join("\n");
		expect(detectSlackViolations(text).map((v) => v.kind)).toContain(
			"slack-table",
		);
	});

	it("flags a run of malformed ordered list items using parens", () => {
		const text = ["1) first", "2) second"].join("\n");
		expect(detectSlackViolations(text).map((v) => v.kind)).toContain(
			"slack-list",
		);
	});

	it("flags a run of bullets with no space after the marker", () => {
		const text = ["-first", "-second"].join("\n");
		expect(detectSlackViolations(text).map((v) => v.kind)).toContain(
			"slack-list",
		);
	});

	it("flags a run of glyph bullets that are not markdown markers", () => {
		const text = ["\u2022 Safe: gt restack", "\u2022 Not safe: gt get"].join(
			"\n",
		);
		expect(detectSlackViolations(text).map((v) => v.kind)).toContain(
			"slack-glyph-bullet",
		);
	});

	it("does not flag a single glyph-led line as a list", () => {
		// One glyph line is a one-item list at most; the run-of-two
		// threshold leaves it alone, like a lone dash line.
		expect(detectSlackViolations("\u2022 the only bullet here")).toEqual([]);
	});

	it("does not flag an inline mid-line glyph as a list", () => {
		// A middle dot inside prose never opens a line, so it is
		// never read as a bullet.
		expect(detectSlackViolations("The ratio is 3 \u00b7 4 \u00b7 5.")).toEqual(
			[],
		);
	});

	it("does not flag a single dash-led line as a malformed list", () => {
		// A lone "-5 degrees" is prose, not a one-item list.
		expect(detectSlackViolations("It dropped to -5 overnight.")).toEqual([]);
	});

	it("does not flag a single pipe line as a table", () => {
		expect(detectSlackViolations("Run `a | b` to pipe the output.")).toEqual(
			[],
		);
	});

	it("ignores pipes, dashes and image syntax inside code fences", () => {
		const text = [
			"```",
			"| not | a | table |",
			"| --- | --- | --- |",
			"![x](y.png)",
			"```",
		].join("\n");
		expect(detectSlackViolations(text)).toEqual([]);
	});
});
