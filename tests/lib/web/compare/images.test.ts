/**
 * Diffing two real PNGs, including the case the whole design
 * turns on: two images that are not the same size.
 */

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareImages } from "../../../../lib/web/compare/images.js";

/** A solid image, optionally with a coloured block painted in. */
const image = (
	width: number,
	height: number,
	block?: { x: number; y: number; w: number; h: number },
): PNG => {
	const png = new PNG({ width, height });
	png.data.fill(255);
	if (!block) return png;
	for (let y = block.y; y < block.y + block.h; y += 1) {
		for (let x = block.x; x < block.x + block.w; x += 1) {
			const at = (y * width + x) * 4;
			png.data[at] = 20;
			png.data[at + 1] = 120;
			png.data[at + 2] = 40;
		}
	}
	return png;
};

describe("compareImages", () => {
	it("reports two identical images as unchanged", () => {
		const result = compareImages(image(64, 64), image(64, 64));
		expect(result.comparison.kind).toBe("compared");
		expect(
			result.comparison.kind === "compared" && result.comparison.changedPixels,
		).toBe(0);
	});

	it("writes no diff image when nothing differs", () => {
		// A blank overlay is a file somebody opens to learn nothing.
		expect(compareImages(image(64, 64), image(64, 64)).image).toBeUndefined();
	});

	it("finds a changed block and its position", () => {
		const result = compareImages(
			image(64, 64),
			image(64, 64, { x: 16, y: 16, w: 8, h: 8 }),
		);
		if (result.comparison.kind !== "compared") throw new Error("not compared");
		expect(result.comparison.changedPixels).toBe(64);
		expect(result.comparison.regions[0]?.x).toBe(16);
		expect(result.comparison.regions[0]?.width).toBe(8);
	});

	it("produces a diff image when something changed", () => {
		const result = compareImages(
			image(64, 64),
			image(64, 64, { x: 16, y: 16, w: 8, h: 8 }),
		);
		expect(result.image).toBeInstanceOf(Buffer);
	});

	it("refuses two images of different sizes rather than cropping", () => {
		// Padding one to fit would produce a number, and the number
		// would be a lie: everything below the join reads as changed.
		const result = compareImages(image(64, 64), image(64, 96));
		expect(result.comparison.kind).toBe("incomparable");
		expect(
			result.comparison.kind === "incomparable" && result.comparison.because,
		).toContain("64 by 96");
	});

	it("says a page that changed size is itself the result", () => {
		const result = compareImages(image(800, 600), image(1024, 600));
		expect(
			result.comparison.kind === "incomparable" && result.comparison.because,
		).toContain("changed size");
	});

	it("names the element a change sits on", () => {
		const result = compareImages(
			image(64, 64),
			image(64, 64, { x: 16, y: 16, w: 8, h: 8 }),
			[{ selector: "#block", rect: { x: 14, y: 14, width: 12, height: 12 } }],
		);
		expect(
			result.comparison.kind === "compared" &&
				result.comparison.regions[0]?.selector,
		).toBe("#block");
	});

	it("brings regions back to CSS pixels when the shot was scaled", () => {
		// A retina screenshot is twice the size of the layout the
		// elements were measured in, so an unscaled region would be
		// attributed against coordinates that do not exist.
		const result = compareImages(
			image(64, 64),
			image(64, 64, { x: 16, y: 16, w: 8, h: 8 }),
			[],
			{ scale: 2 },
		);
		expect(
			result.comparison.kind === "compared" && result.comparison.regions[0]?.x,
		).toBe(8);
	});

	it("reports the share of the image that changed", () => {
		const result = compareImages(
			image(100, 100),
			image(100, 100, { x: 0, y: 0, w: 10, h: 10 }),
		);
		expect(
			result.comparison.kind === "compared" && result.comparison.fraction,
		).toBeCloseTo(0.01, 5);
	});
});
