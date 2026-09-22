import { describe, expect, it } from "vitest";
import {
	billedTokens,
	fitToBudget,
	PIXEL_BUDGET,
} from "../../extensions/image-budget-workflow/budget.js";

describe("billedTokens", () => {
	it("prices an image by its pixels, not its payload", () => {
		// A 415,508-character base64 image billed 1,789 tokens against a
		// real provider. Measuring payload length and calling it tokens
		// overstated every image here by about 48 times.
		expect(billedTokens(2858, 1428)).toBeCloseTo(5441, -1);
		expect(billedTokens(1429, 714)).toBeCloseTo(1360, -1);
	});
});

describe("fitToBudget", () => {
	it("leaves an image already within the allowance alone", () => {
		// Untouched means untouched: no re-encode, no quality loss, and no
		// worker spun up for nothing.
		expect(fitToBudget(1429, 714)).toBeNull();
		expect(fitToBudget(800, 600)).toBeNull();
	});

	it("brings a 2x window capture down to about logical resolution", () => {
		const fit = fitToBudget(2858, 1428);

		expect(fit).not.toBeNull();
		if (!fit) return;
		expect(fit.maxWidth * fit.maxHeight).toBeLessThanOrEqual(PIXEL_BUDGET);
		// Near enough to halving, which is what undoing a 2x capture is.
		expect(fit.maxWidth).toBeGreaterThan(1400);
		expect(fit.maxWidth).toBeLessThan(1800);
	});

	it("keeps the aspect ratio, so nothing is stretched", () => {
		const fit = fitToBudget(3216, 2090);

		expect(fit).not.toBeNull();
		if (!fit) return;
		expect(fit.maxWidth / fit.maxHeight).toBeCloseTo(3216 / 2090, 2);
	});

	it("never enlarges a small image to fill the allowance", () => {
		// Spending the budget because it is there would cost tokens and
		// add no detail that was not in the original.
		expect(fitToBudget(100, 50)).toBeNull();
	});

	it("holds the allowance even for an extreme panorama", () => {
		const fit = fitToBudget(20_000, 400);

		expect(fit).not.toBeNull();
		if (!fit) return;
		expect(fit.maxWidth * fit.maxHeight).toBeLessThanOrEqual(PIXEL_BUDGET);
	});

	it("declines to guess at a degenerate size", () => {
		// A zero or negative dimension means the decoder did not report a
		// size. Scaling by a ratio built from it would be arithmetic on a
		// value that means nothing.
		expect(fitToBudget(0, 1000)).toBeNull();
		expect(fitToBudget(-1, -1)).toBeNull();
	});
});
