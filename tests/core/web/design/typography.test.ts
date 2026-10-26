/**
 * Judging how text blocks end.
 */

import { describe, expect, it } from "vitest";
import {
	analyseTypography,
	RUNT_WIDTH_SHARE,
	renderTypography,
	type TextBlock,
} from "../../../../lib/core/web/design/typography.ts";

const block = (over: Partial<TextBlock> = {}): TextBlock => ({
	selector: "p.lede",
	tag: "p",
	textLength: 200,
	containerWidth: 600,
	lineCount: 3,
	lastLine: { words: 8, width: 400, text: "a comfortably full last line" },
	...over,
});

describe("analyseTypography", () => {
	it("passes a block whose last line is full", () => {
		expect(analyseTypography([block()])).toEqual([]);
	});

	it("calls one word alone an orphan", () => {
		const findings = analyseTypography([
			block({ lastLine: { words: 1, width: 60, text: "alone" } }),
		]);
		expect(findings.map((one) => one.kind)).toEqual(["orphan"]);
	});

	it("calls a short narrow last line a runt", () => {
		const findings = analyseTypography([
			block({ lastLine: { words: 3, width: 100, text: "just three words" } }),
		]);
		expect(findings.map((one) => one.kind)).toEqual(["runt"]);
	});

	it("leaves a short last line alone when it is wide enough", () => {
		// Three words filling a third of the container is a line, not
		// a stub: word count alone cannot condemn it.
		const wide = block({
			lastLine: {
				words: 3,
				width: 600 * RUNT_WIDTH_SHARE,
				text: "three wide words",
			},
		});
		expect(analyseTypography([wide])).toEqual([]);
	});

	it("does not judge a block that never wrapped", () => {
		const single = block({
			lineCount: 1,
			lastLine: { words: 1, width: 60, text: "headline" },
		});
		expect(analyseTypography([single])).toEqual([]);
	});

	it("marks a heading orphan as a heading", () => {
		const findings = analyseTypography([
			block({
				tag: "h2",
				selector: "h2.title",
				lastLine: { words: 1, width: 90, text: "stranded" },
			}),
		]);
		expect(findings[0]?.heading).toBe(true);
	});

	it("orders headings first and orphans before runts", () => {
		const findings = analyseTypography([
			block({ lastLine: { words: 3, width: 80, text: "runt line here" } }),
			block({ lastLine: { words: 1, width: 40, text: "alone" } }),
			block({
				tag: "h3",
				lastLine: { words: 1, width: 40, text: "stranded" },
			}),
		]);
		expect(
			findings.map((one) => `${one.heading ? "h" : "b"}-${one.kind}`),
		).toEqual(["h-orphan", "b-orphan", "b-runt"]);
	});

	it("does not divide by a zero-width container", () => {
		const zero = block({
			containerWidth: 0,
			lastLine: { words: 2, width: 10, text: "two words" },
		});
		expect(analyseTypography([zero])).toEqual([]);
	});
});

describe("renderTypography", () => {
	it("passes a page whose blocks all end cleanly", () => {
		const out = renderTypography([block()], analyseTypography([block()]));
		expect(out.startsWith("PASS")).toBe(true);
		expect(out).toContain("ends cleanly");
	});

	it("warns rather than fails, because this is taste", () => {
		const bad = [block({ lastLine: { words: 1, width: 60, text: "alone" } })];
		const out = renderTypography(bad, analyseTypography(bad));
		expect(out.startsWith("WARN")).toBe(true);
		expect(out).toContain('"alone"');
	});

	it("says what was left out at capture", () => {
		const out = renderTypography([], []);
		expect(out).toContain("balance");
	});

	it("counts heading findings in the headline", () => {
		const bad = [
			block({
				tag: "h2",
				lastLine: { words: 1, width: 60, text: "stranded" },
			}),
		];
		const out = renderTypography(bad, analyseTypography(bad));
		expect(out).toContain("1 in headings");
	});
});
