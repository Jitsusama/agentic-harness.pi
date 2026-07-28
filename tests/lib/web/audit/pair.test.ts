/**
 * Contrast between two named elements.
 *
 * The judgement is easy; choosing what to compare is not. Every case
 * here pins the choice as well as the verdict, because a ratio whose
 * operands are a guess is worse than no ratio.
 */

import { describe, expect, it } from "vitest";
import {
	foldPair,
	type PaintedSide,
	renderPair,
} from "../../../../lib/web/audit/pair.js";

const side = (over: Partial<PaintedSide> = {}): PaintedSide => ({
	hasText: false,
	...over,
});

const body = { fontSizePx: 16, fontWeight: 400 };

describe("foldPair", () => {
	it("judges text against a background under 1.4.3", () => {
		const report = foldPair({
			one: side({
				hasText: true,
				color: "rgb(255, 255, 255)",
				sizing: body,
			}),
			other: side({ backgroundColor: "rgb(0, 0, 0)" }),
			bar: "AA",
		});

		expect(report.criterion).toBe("1.4.3");
		expect(report.required).toBe(4.5);
		expect(report.ratio).toBeCloseTo(21, 0);
		expect(report.verdict).toBe("pass");
		// The operands are part of the answer, not an implementation
		// detail: a caller who disagrees needs to see the choice.
		expect(report.compared.one).toBe("color");
		expect(report.compared.other).toBe("background-color");
	});

	it("judges two painted surfaces under 1.4.11 at three to one", () => {
		// Neither side has text, so this is a boundary between two
		// things, which is the non-text criterion and a lower bar.
		const report = foldPair({
			one: side({ backgroundColor: "rgb(255, 255, 255)" }),
			other: side({ backgroundColor: "rgb(100, 100, 100)" }),
			bar: "AA",
		});

		expect(report.criterion).toBe("1.4.11");
		expect(report.required).toBe(3);
		expect(report.compared.one).toBe("background-color");
	});

	it("holds large text to the lower bar the criterion gives it", () => {
		const large = { fontSizePx: 24, fontWeight: 400 };
		const report = foldPair({
			one: side({ hasText: true, color: "rgb(148, 148, 148)", sizing: large }),
			other: side({ backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AA",
		});

		expect(report.required).toBe(3);
	});

	it("asks more of both criteria at AAA", () => {
		const report = foldPair({
			one: side({ hasText: true, color: "rgb(0, 0, 0)", sizing: body }),
			other: side({ backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AAA",
		});

		expect(report.required).toBe(7);
	});

	it("falls back to the border when a side paints no background", () => {
		// A control outlined against a page is the commonest 1.4.11
		// case, and its background is usually transparent.
		const report = foldPair({
			one: side({
				backgroundColor: "rgba(0, 0, 0, 0)",
				borderColor: "rgb(0, 0, 0)",
			}),
			other: side({ backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AA",
		});

		expect(report.compared.one).toBe("border-color");
		expect(report.verdict).toBe("pass");
	});

	it("ignores the surface's own text colour", () => {
		// Found against a real page, not here: every fixture in this file
		// gave the second side no text, so both sides offering their text
		// colour went unnoticed until a card containing a word compared
		// black against black and reported 1:1 for readable text.
		const report = foldPair({
			one: side({
				hasText: true,
				color: "rgb(0, 0, 0)",
				sizing: body,
			}),
			other: side({
				hasText: true,
				color: "rgb(0, 0, 0)",
				backgroundColor: "rgb(250, 250, 250)",
			}),
			bar: "AA",
		});

		expect(report.compared.other).toBe("background-color");
		expect(report.ratio).toBeGreaterThan(4.5);
		expect(report.verdict).toBe("pass");
	});

	it("lets the subject alone decide the criterion", () => {
		// A surface with text does not make this a text comparison; what
		// is being judged is the shape sitting on it.
		const report = foldPair({
			one: side({ backgroundColor: "rgb(0, 0, 0)" }),
			other: side({ hasText: true, backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AA",
		});

		expect(report.criterion).toBe("1.4.11");
		expect(report.required).toBe(3);
	});

	it("declines when a side paints nothing at all", () => {
		const report = foldPair({
			one: side({ backgroundColor: "rgba(0, 0, 0, 0)" }),
			other: side({ backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AA",
		});

		expect(report.verdict).toBe("undecidable");
		expect(report.undecided).toMatch(/nothing/i);
	});

	it("declines a colour it cannot read rather than assuming one", () => {
		// The same rule the rest of this module follows: an unreadable
		// colour is a refusal, never a substitution.
		const report = foldPair({
			one: side({ hasText: true, color: "oklch(0.7 0.1 200)", sizing: body }),
			other: side({ backgroundColor: "rgb(255, 255, 255)" }),
			bar: "AA",
		});

		expect(report.verdict).toBe("undecidable");
		expect(report.undecided).toMatch(/could not be read/i);
	});
});

describe("renderPair", () => {
	it("says the ratio, the bar and what it compared", () => {
		const said = renderPair(
			foldPair({
				one: side({ hasText: true, color: "rgb(0, 0, 0)", sizing: body }),
				other: side({ backgroundColor: "rgb(255, 255, 255)" }),
				bar: "AA",
			}),
		);

		expect(said).toContain("PASS");
		expect(said).toContain("21.00:1");
		expect(said).toContain("4.5:1");
		expect(said).toMatch(/1\.4\.3/);
		expect(said).toContain("color");
		expect(said).toContain("background-color");
	});

	it("warns rather than passing when it could not decide", () => {
		const said = renderPair(
			foldPair({
				one: side({ backgroundColor: "rgba(0, 0, 0, 0)" }),
				other: side({ backgroundColor: "rgb(255, 255, 255)" }),
				bar: "AA",
			}),
		);

		expect(said).toContain("WARN");
		expect(said).not.toContain("PASS");
	});
});
