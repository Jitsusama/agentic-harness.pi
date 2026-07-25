import { describe, expect, it } from "vitest";
import {
	centreOf,
	cornersOf,
	normalizeBoxModel,
	type RawBoxModel,
} from "../../../../lib/web/element/index.js";

/**
 * A capture shaped the way Chrome returns it for the clear
 * button in the element fixture: quads run clockwise from the
 * top left corner.
 */
const CAPTURE: RawBoxModel = {
	content: [30, 20, 96, 20, 96, 39, 30, 39],
	padding: [10, 10, 116, 10, 116, 49, 10, 49],
	border: [8, 8, 118, 8, 118, 51, 8, 51],
	margin: [0, 0, 126, 0, 126, 59, 0, 59],
	width: 110,
	height: 43,
};

describe("normalizeBoxModel", () => {
	it("reads a quad as a position and a size", () => {
		expect(normalizeBoxModel(CAPTURE).border).toEqual({
			x: 8,
			y: 8,
			width: 110,
			height: 43,
		});
	});

	it("reads each of the four boxes", () => {
		const box = normalizeBoxModel(CAPTURE);
		expect({
			content: box.content.width,
			padding: box.padding.width,
			border: box.border.width,
			margin: box.margin.width,
		}).toEqual({ content: 66, padding: 106, border: 110, margin: 126 });
	});

	it("keeps the size the capture reported", () => {
		const box = normalizeBoxModel(CAPTURE);
		expect([box.width, box.height]).toEqual([110, 43]);
	});

	it("reads a box that has been rotated off the axes", () => {
		// A transformed element reports a quad that is not a
		// rectangle. Its extent is still the honest answer to
		// where the element is.
		const rotated = normalizeBoxModel({
			...CAPTURE,
			border: [50, 0, 100, 50, 50, 100, 0, 50],
		});
		expect(rotated.border).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it("reads a box that has been collapsed to nothing", () => {
		const empty = normalizeBoxModel({
			...CAPTURE,
			border: [5, 5, 5, 5, 5, 5, 5, 5],
			width: 0,
			height: 0,
		});
		expect(empty.border).toEqual({ x: 5, y: 5, width: 0, height: 0 });
	});
});

describe("centreOf", () => {
	it("finds the middle of a box", () => {
		expect(centreOf({ x: 10, y: 20, width: 100, height: 40 })).toEqual({
			x: 60,
			y: 40,
		});
	});
});

describe("cornersOf", () => {
	it("names the four corners, pulled inside the edge", () => {
		// A hit test exactly on the boundary can land on the
		// neighbour, so the points sit just inside.
		expect(cornersOf({ x: 0, y: 0, width: 100, height: 50 }, 2)).toEqual([
			{ x: 2, y: 2 },
			{ x: 98, y: 2 },
			{ x: 98, y: 48 },
			{ x: 2, y: 48 },
		]);
	});

	it("keeps the corners inside a box too small to inset", () => {
		// Insetting a 3px box by 2px from both sides would put the
		// left corner to the right of the right one.
		expect(cornersOf({ x: 0, y: 0, width: 3, height: 3 }, 2)).toEqual([
			{ x: 1.5, y: 1.5 },
			{ x: 1.5, y: 1.5 },
			{ x: 1.5, y: 1.5 },
			{ x: 1.5, y: 1.5 },
		]);
	});
});
