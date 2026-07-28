/**
 * The space between two elements, as a designer asks about it.
 */

import { describe, expect, it } from "vitest";
import type { Rect } from "../../../../lib/web/element/box.js";
import {
	measureBetween,
	renderMeasurement,
} from "../../../../lib/web/element/measure.js";

const at = (x: number, y: number, width: number, height: number): Rect => ({
	x,
	y,
	width,
	height,
});

describe("measureBetween", () => {
	it("measures the gap between two boxes side by side", () => {
		// The literal question: is that gap 16 or 12.
		const measured = measureBetween(at(0, 0, 100, 40), at(116, 0, 100, 40));

		expect(measured.horizontal).toEqual({ kind: "gap", pixels: 16 });
	});

	it("measures the gap between two boxes stacked", () => {
		const measured = measureBetween(at(0, 0, 100, 40), at(0, 52, 100, 40));

		expect(measured.vertical).toEqual({ kind: "gap", pixels: 12 });
	});

	it("says two boxes overlap rather than reporting a negative gap", () => {
		// A negative gap reads as a small gap at a glance, and the
		// repair for an overlap is nothing like the repair for a gap.
		const measured = measureBetween(at(0, 0, 100, 40), at(90, 0, 100, 40));

		expect(measured.horizontal.kind).toBe("overlap");
		expect(measured.horizontal.pixels).toBe(10);
	});

	it("reports boxes that share an axis as neither apart nor overlapping", () => {
		// Two boxes in a row share every row of pixels vertically.
		// Calling that a zero gap invites someone to go looking for
		// the margin that closed it.
		const measured = measureBetween(at(0, 0, 100, 40), at(116, 0, 100, 40));

		expect(measured.vertical.kind).toBe("spans");
	});

	it("notices edges that line up", () => {
		const measured = measureBetween(at(0, 0, 100, 40), at(0, 52, 140, 40));

		expect(measured.aligned).toContain("left");
		expect(measured.aligned).not.toContain("right");
	});

	it("notices centres that line up when no edge does", () => {
		const measured = measureBetween(at(0, 0, 100, 40), at(20, 52, 60, 40));

		expect(measured.aligned).toContain("horizontal centre");
		expect(measured.aligned).not.toContain("left");
	});

	it("reports a size difference small enough to be a mistake", () => {
		// Two buttons meant to match, one a pixel out, is a real
		// defect and invisible to the eye.
		const measured = measureBetween(at(0, 0, 100, 40), at(0, 52, 99, 40));

		expect(measured.sameSize).toBe(false);
		expect(measured.widthDelta).toBe(1);
	});

	it("calls identical boxes the same size", () => {
		const measured = measureBetween(at(0, 0, 100, 40), at(0, 52, 100, 40));

		expect(measured.sameSize).toBe(true);
	});
});

describe("renderMeasurement", () => {
	it("leads with the gap, which is what was asked", () => {
		const rendered = renderMeasurement(
			measureBetween(at(0, 0, 100, 40), at(116, 0, 100, 40)),
			"button Save",
			"button Cancel",
		);

		expect(rendered).toContain("16");
		expect(rendered).toContain("button Save");
		expect(rendered).toContain("button Cancel");
	});

	it("says so when two elements sit on top of each other", () => {
		const rendered = renderMeasurement(
			measureBetween(at(0, 0, 100, 40), at(10, 10, 100, 40)),
			"a",
			"b",
		);

		expect(rendered.toLowerCase()).toContain("overlap");
	});
});
