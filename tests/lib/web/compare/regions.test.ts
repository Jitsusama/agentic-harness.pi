/**
 * Grouping changed pixels into places a person can look at.
 */

import { describe, expect, it } from "vitest";
import {
	attributeRegions,
	CELL_SIZE,
	type Comparison,
	clusterRegions,
	type Placed,
	type Region,
	renderComparison,
} from "../../../../lib/web/compare/regions.js";

/** Build a change mask with the given rectangles filled in. */
const mask = (
	width: number,
	height: number,
	boxes: readonly [number, number, number, number][],
): Uint8Array => {
	const out = new Uint8Array(width * height);
	for (const [x, y, w, h] of boxes) {
		for (let row = y; row < y + h; row += 1) {
			for (let col = x; col < x + w; col += 1) {
				out[row * width + col] = 1;
			}
		}
	}
	return out;
};

describe("clusterRegions", () => {
	it("finds nothing in an unchanged image", () => {
		expect(clusterRegions(mask(64, 64, []), 64, 64)).toEqual([]);
	});

	it("gathers one changed block into one region", () => {
		const regions = clusterRegions(mask(64, 64, [[10, 10, 20, 20]]), 64, 64);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.pixels).toBe(400);
	});

	it("keeps two distant changes apart", () => {
		const regions = clusterRegions(
			mask(200, 200, [
				[0, 0, 20, 20],
				[150, 150, 20, 20],
			]),
			200,
			200,
		);
		expect(regions).toHaveLength(2);
	});

	it("joins neighbouring pieces into the thing that moved", () => {
		// Pixel-exact grouping would call these two changes; they
		// are one paragraph shifting, which is what the grid is for.
		const regions = clusterRegions(
			mask(200, 50, [
				[10, 10, 30, 10],
				[44, 10, 30, 10],
			]),
			200,
			50,
		);
		expect(regions).toHaveLength(1);
	});

	it("joins a change running diagonally", () => {
		const regions = clusterRegions(
			mask(64, 64, [
				[0, 0, 8, 8],
				[8, 8, 8, 8],
				[16, 16, 8, 8],
			]),
			64,
			64,
		);
		expect(regions).toHaveLength(1);
	});

	it("puts the biggest change first", () => {
		const regions = clusterRegions(
			mask(300, 300, [
				[0, 0, 10, 10],
				[200, 200, 50, 50],
			]),
			300,
			300,
		);
		expect(regions[0]?.pixels).toBe(2500);
	});

	it("drops a speck too small to be a change", () => {
		expect(clusterRegions(mask(64, 64, [[10, 10, 1, 1]]), 64, 64)).toEqual([]);
	});

	it("reports the real bounds of the change, not the grid cells", () => {
		// The grid decides what groups together and must not decide
		// the bounds. Snapping out to cell edges made a region
		// slightly larger than the element it came from, so nothing
		// contained it and every change was blamed on the body.
		const [region] = clusterRegions(mask(64, 64, [[10, 10, 20, 20]]), 64, 64);
		expect(region?.x).toBe(10);
		expect(region?.y).toBe(10);
		expect(region?.width).toBe(20);
		expect(region?.height).toBe(20);
	});

	it("gives an element's own change bounds it can contain", () => {
		const element: Placed = {
			selector: ".accent",
			rect: { x: 10, y: 10, width: 20, height: 20 },
		};
		const regions = clusterRegions(mask(64, 64, [[10, 10, 20, 20]]), 64, 64);
		expect(attributeRegions(regions, [element])[0]?.selector).toBe(".accent");
	});

	it("does not run a region past the edge of the image", () => {
		const [region] = clusterRegions(mask(20, 20, [[12, 12, 8, 8]]), 20, 20);
		expect((region?.x ?? 0) + (region?.width ?? 0)).toBeLessThanOrEqual(20);
	});

	it("copes with an image of no size", () => {
		expect(clusterRegions(new Uint8Array(0), 0, 0)).toEqual([]);
	});

	it("takes a caller's cell size when the default is too coarse", () => {
		const twoBoxes = mask(64, 16, [
			[0, 0, 4, 4],
			[10, 0, 4, 4],
		]);
		expect(clusterRegions(twoBoxes, 64, 16, { cell: 2 })).toHaveLength(2);
		expect(clusterRegions(twoBoxes, 64, 16, { cell: CELL_SIZE })).toHaveLength(
			1,
		);
	});
});

describe("attributeRegions", () => {
	const elements: readonly Placed[] = [
		{ selector: "body", rect: { x: 0, y: 0, width: 800, height: 600 } },
		{ selector: "main", rect: { x: 0, y: 100, width: 800, height: 400 } },
		{ selector: "#hero", rect: { x: 10, y: 110, width: 300, height: 200 } },
	];

	const region = (over: Partial<Region>): Region => ({
		x: 20,
		y: 120,
		width: 40,
		height: 40,
		pixels: 100,
		...over,
	});

	it("names the smallest element that contains the change", () => {
		// Everything is inside body, and saying so helps nobody.
		expect(attributeRegions([region({})], elements)[0]?.selector).toBe("#hero");
	});

	it("leaves a region spanning two elements unattributed", () => {
		// Blaming their common ancestor would say "something under
		// main changed", which is not an answer.
		const wide = region({ x: 0, y: 120, width: 700, height: 10 });
		expect(attributeRegions([wide], [elements[2] as Placed])[0]?.selector).toBe(
			undefined,
		);
	});

	it("says nothing when there are no elements to blame", () => {
		expect(attributeRegions([region({})], [])[0]?.selector).toBeUndefined();
	});

	it("matches an element whose box is fractional", () => {
		// Layout rects are fractional and pixel regions are whole,
		// so an element starting at 442.5 paints row 442. Comparing
		// the raw numbers rejected it by half a pixel and sent every
		// change to the body.
		const accent: Placed = {
			selector: ".accent",
			rect: { x: 0, y: 442.5, width: 800, height: 66.4 },
		};
		const change = region({ x: 0, y: 442, width: 800, height: 66 });
		expect(attributeRegions([change], [accent])[0]?.selector).toBe(".accent");
	});
});

describe("renderComparison", () => {
	const compared = (over: Partial<Comparison> = {}): Comparison =>
		({
			kind: "compared",
			width: 800,
			height: 600,
			changedPixels: 5000,
			fraction: 5000 / 480000,
			regions: [
				{ x: 8, y: 8, width: 64, height: 64, pixels: 4000, selector: "#hero" },
				{ x: 300, y: 400, width: 32, height: 32, pixels: 1000 },
			],
			...over,
		}) as Comparison;

	it("says identical rather than reporting zero of everything", () => {
		expect(
			renderComparison(compared({ changedPixels: 0, fraction: 0 })),
		).toContain("Identical");
	});

	it("leads with pixels, share and how many separate places", () => {
		const out = renderComparison(compared());
		expect(out).toContain("5000 pixels differ");
		expect(out).toContain("2 separate regions");
	});

	it("names where each change is and what it sits on", () => {
		expect(renderComparison(compared())).toContain("#hero");
	});

	it("warns when a difference is small enough to be noise", () => {
		const out = renderComparison(
			compared({ changedPixels: 12, fraction: 12 / 480000 }),
		);
		expect(out).toContain("rendering noise");
	});

	it("refuses two images that cannot be compared, and says why", () => {
		const out = renderComparison({
			kind: "incomparable",
			because: "the baseline is 800 by 600 and this one is 1024 by 768",
		});
		expect(out).toContain("cannot be compared");
		expect(out).toContain("1024 by 768");
	});

	it("lists the files it wrote, since an unnamed one is unopenable", () => {
		const out = renderComparison(compared(), ["/tmp/a/diff-01.png"]);
		expect(out).toContain("diff-01.png");
	});

	it("counts a long tail of regions rather than listing them", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			x: index * 10,
			y: 0,
			width: 8,
			height: 8,
			pixels: 64,
		}));
		expect(renderComparison(compared({ regions: many }))).toContain(
			"and 12 more regions",
		);
	});
});
