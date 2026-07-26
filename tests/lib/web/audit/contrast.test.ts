/**
 * Contrast arithmetic and the thresholds it is held to.
 *
 * The reference ratios are the ones WCAG's own examples quote,
 * so a change in the formula shows up as a disagreement with
 * the specification rather than with a number I chose.
 */

import { describe, expect, it } from "vitest";
import {
	composite,
	contrastRatio,
	formatRgb,
	isOpaque,
	isTransparent,
	parseRgb,
	type Rgba,
	relativeLuminance,
} from "../../../../lib/web/audit/colour.js";
import {
	isLargeText,
	judgeNonText,
	judgeText,
	renderContrast,
	textThreshold,
	undecidable,
} from "../../../../lib/web/audit/contrast.js";

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const REBECCA: Rgba = { r: 102, g: 51, b: 153, a: 1 };

describe("relativeLuminance", () => {
	it("puts white at one and black at zero", () => {
		expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
		expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5);
	});

	it("weights green far above blue, as the eye does", () => {
		const green = relativeLuminance({ r: 0, g: 255, b: 0, a: 1 });
		const blue = relativeLuminance({ r: 0, g: 0, b: 255, a: 1 });
		expect(green).toBeGreaterThan(blue * 9);
	});

	it("ignores alpha, since a translucent colour has none of its own", () => {
		expect(relativeLuminance({ ...REBECCA, a: 0.1 })).toBe(
			relativeLuminance(REBECCA),
		);
	});
});

describe("contrastRatio", () => {
	it("gives 21 to 1 for black on white, the maximum there is", () => {
		expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 2);
	});

	it("gives 1 to 1 for a colour against itself", () => {
		expect(contrastRatio(REBECCA, REBECCA)).toBeCloseTo(1, 5);
	});

	it("does not care which colour is named first", () => {
		expect(contrastRatio(REBECCA, WHITE)).toBeCloseTo(
			contrastRatio(WHITE, REBECCA),
			10,
		);
	});

	it("gives 8.41 for rebeccapurple on white", () => {
		// Worked through by hand against the formula: the linearized
		// channels are 0.1329, 0.0331 and 0.3186, weighting to a
		// luminance of 0.0749, so 1.05 / 0.1249 is 8.41. The two
		// tests above are the real anchors, since 21:1 and 1:1 are
		// fixed by the specification rather than by this arithmetic.
		expect(contrastRatio(REBECCA, WHITE)).toBeCloseTo(8.41, 2);
	});
});

describe("composite", () => {
	it("returns the top colour when it is opaque", () => {
		expect(composite(REBECCA, WHITE)).toEqual(REBECCA);
	});

	it("returns the bottom colour when the top is invisible", () => {
		expect(composite({ ...REBECCA, a: 0 }, WHITE)).toEqual(WHITE);
	});

	it("meets in the middle at half alpha", () => {
		const blended = composite({ ...BLACK, a: 0.5 }, WHITE);
		expect(blended.r).toBeCloseTo(128, -1);
		expect(blended.a).toBe(1);
	});

	it("stays transparent when nothing underneath is opaque either", () => {
		const blended = composite({ ...BLACK, a: 0 }, { r: 0, g: 0, b: 0, a: 0 });
		expect(isTransparent(blended)).toBe(true);
	});

	it("makes a translucent foreground judgeable at all", () => {
		// Half-alpha black on white should land near mid grey, which
		// fails normal text against white.
		const over = composite({ ...BLACK, a: 0.5 }, WHITE);
		expect(contrastRatio(over, WHITE)).toBeLessThan(4.5);
	});
});

describe("parseRgb", () => {
	it("reads the comma syntax getComputedStyle produces", () => {
		expect(parseRgb("rgb(102, 51, 153)")).toEqual(REBECCA);
	});

	it("reads the alpha form", () => {
		expect(parseRgb("rgba(1, 2, 3, 0.5)")).toEqual({
			r: 1,
			g: 2,
			b: 3,
			a: 0.5,
		});
	});

	it("reads the space and slash syntax", () => {
		expect(parseRgb("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
	});

	it("refuses modern syntax rather than guessing at it", () => {
		// Chrome returns these from getComputedStyle unconverted, and
		// a wrong guess here would be a confidently wrong audit.
		expect(parseRgb("oklch(0.7 0.1 200)")).toBeUndefined();
		expect(parseRgb("color(display-p3 1 0 0)")).toBeUndefined();
		expect(parseRgb("lab(50 40 59.5)")).toBeUndefined();
	});

	it("refuses a keyword, which computed styles never return anyway", () => {
		expect(parseRgb("rebeccapurple")).toBeUndefined();
		expect(parseRgb("")).toBeUndefined();
	});
});

describe("isLargeText", () => {
	it("calls 24px normal text large", () => {
		expect(isLargeText({ fontSizePx: 24, fontWeight: 400 })).toBe(true);
		expect(isLargeText({ fontSizePx: 23.9, fontWeight: 400 })).toBe(false);
	});

	it("lets bold text be large from 18.66px, which is 14pt", () => {
		expect(isLargeText({ fontSizePx: 18.66, fontWeight: 700 })).toBe(true);
		expect(isLargeText({ fontSizePx: 18.66, fontWeight: 400 })).toBe(false);
	});
});

describe("textThreshold", () => {
	it("holds normal text to 4.5 at AA and 7 at AAA", () => {
		const normal = { fontSizePx: 16, fontWeight: 400 };
		expect(textThreshold(normal, "AA")).toBe(4.5);
		expect(textThreshold(normal, "AAA")).toBe(7);
	});

	it("relaxes large text to 3 at AA and 4.5 at AAA", () => {
		const large = { fontSizePx: 32, fontWeight: 400 };
		expect(textThreshold(large, "AA")).toBe(3);
		expect(textThreshold(large, "AAA")).toBe(4.5);
	});
});

describe("judgeText", () => {
	const sizing = { fontSizePx: 16, fontWeight: 400 };

	it("passes rebeccapurple on white for normal text", () => {
		const verdict = judgeText({
			foreground: REBECCA,
			background: WHITE,
			sizing,
		});
		expect(verdict.kind === "judged" && verdict.passes).toBe(true);
	});

	it("fails mid grey on white, and says what was needed", () => {
		const verdict = judgeText({
			foreground: { r: 150, g: 150, b: 150, a: 1 },
			background: WHITE,
			sizing,
		});
		expect(verdict.kind === "judged" && verdict.passes).toBe(false);
		expect(verdict.kind === "judged" && verdict.required).toBe(4.5);
	});

	it("passes at AA and fails the same pair at AAA", () => {
		const grey = { r: 117, g: 117, b: 117, a: 1 };
		const aa = judgeText({ foreground: grey, background: WHITE, sizing });
		const aaa = judgeText({
			foreground: grey,
			background: WHITE,
			sizing,
			level: "AAA",
		});
		expect(aa.kind === "judged" && aa.passes).toBe(true);
		expect(aaa.kind === "judged" && aaa.passes).toBe(false);
	});

	it("does not fail a ratio that rounds to exactly the threshold", () => {
		// A pair quoted as 4.5 that fails on the fourth decimal reads
		// as a bug in the tool, not in the page.
		const verdict = judgeText({
			foreground: { r: 255, g: 255, b: 255, a: 1 },
			background: { r: 118, g: 118, b: 118, a: 1 },
			sizing,
		});
		if (verdict.kind !== "judged") throw new Error("should have judged");
		expect(verdict.ratio).toBeGreaterThanOrEqual(4.5);
		expect(verdict.passes).toBe(true);
	});
});

describe("judgeNonText", () => {
	it("holds a control to 3 to 1 however big it is", () => {
		const verdict = judgeNonText({
			foreground: { r: 118, g: 118, b: 118, a: 1 },
			background: WHITE,
		});
		expect(verdict.kind === "judged" && verdict.required).toBe(3);
		expect(verdict.kind === "judged" && verdict.passes).toBe(true);
	});

	it("fails a focus ring too faint to see", () => {
		const verdict = judgeNonText({
			foreground: { r: 220, g: 220, b: 220, a: 1 },
			background: WHITE,
		});
		expect(verdict.kind === "judged" && verdict.passes).toBe(false);
	});
});

describe("renderContrast", () => {
	it("quotes the ratio, the threshold and the colours", () => {
		const out = renderContrast(
			judgeText({
				foreground: REBECCA,
				background: WHITE,
				sizing: { fontSizePx: 16, fontWeight: 400 },
			}),
		);
		expect(out).toContain("8.41:1");
		expect(out).toContain("4.5:1 AA");
		expect(out).toContain("rgb(102, 51, 153)");
	});

	it("says short rather than met when it fails", () => {
		const out = renderContrast(
			judgeText({
				foreground: { r: 200, g: 200, b: 200, a: 1 },
				background: WHITE,
				sizing: { fontSizePx: 16, fontWeight: 400 },
			}),
		);
		expect(out).toContain("falls short");
	});

	it("passes on why it could not decide, rather than claiming a pass", () => {
		const out = renderContrast(undecidable("the background is a gradient"));
		expect(out).toContain("could not be determined");
		expect(out).toContain("gradient");
	});
});

describe("formatting helpers", () => {
	it("prints an opaque colour without an alpha nobody needs", () => {
		expect(formatRgb(REBECCA)).toBe("rgb(102, 51, 153)");
	});

	it("prints alpha when there is any", () => {
		expect(formatRgb({ ...REBECCA, a: 0.5 })).toBe("rgba(102, 51, 153, 0.5)");
	});

	it("knows opaque from transparent", () => {
		expect(isOpaque(REBECCA)).toBe(true);
		expect(isTransparent({ ...REBECCA, a: 0 })).toBe(true);
	});
});
