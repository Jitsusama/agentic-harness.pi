import { describe, expect, it } from "vitest";
import {
	foldHover,
	type HoverMeasurement,
	renderHover,
} from "../../../../lib/web/element/hover.js";

const TINT: HoverMeasurement[] = [
	{
		element: "a.both",
		hover: [{ property: "background-color", from: "white", to: "#eef" }],
		focus: [{ property: "background-color", from: "white", to: "#eef" }],
	},
	{
		element: "button.hoveronly",
		hover: [{ property: "background-color", from: "white", to: "#333" }],
		focus: [],
	},
	{
		element: "span.beaten",
		hover: [],
		focus: [],
	},
];

/** Thirty links sharing one treatment, which must not print thirty times. */
const MANY: HoverMeasurement[] = Array.from({ length: 30 }, (_, index) => ({
	element: `a.many:nth-of-type(${index + 1})`,
	hover: [{ property: "outline-color", from: "black", to: "blue" }],
	focus: [],
}));

describe("foldHover", () => {
	it("counts every candidate it was given", () => {
		expect(foldHover(TINT, 0).candidates).toBe(3);
	});

	it("groups elements that realize the same change", () => {
		const report = foldHover(MANY, 0);

		expect(report.groups).toHaveLength(1);
		expect(report.groups[0]?.elements).toHaveLength(30);
	});

	it("keeps different treatments apart", () => {
		const report = foldHover(TINT, 0);

		// The two tints differ in colour, so they are two treatments even
		// though both change the same property.
		expect(report.groups).toHaveLength(2);
	});

	it("singles out a hover the keyboard never gets", () => {
		const report = foldHover(TINT, 0);

		expect(report.pointerOnly).toHaveLength(1);
		expect(report.pointerOnly[0]?.elements).toEqual(["button.hoveronly"]);
	});

	it("leaves alone a hover that focus matches", () => {
		const report = foldHover(TINT, 0);
		const named = report.pointerOnly.flatMap((group) => group.elements);

		expect(named).not.toContain("a.both");
	});

	it("names a hover rule that realizes nothing", () => {
		// A rule the cascade beat. The stylesheet says it hovers; the
		// computed style says it does not, and the computed style is what
		// the person sees.
		expect(foldHover(TINT, 0).inert).toEqual(["span.beaten"]);
	});

	it("does not count an inert candidate as a treatment", () => {
		const report = foldHover(TINT, 0);
		const grouped = report.groups.flatMap((group) => group.elements);

		expect(grouped).not.toContain("span.beaten");
	});

	it("carries forward the sheets it could not read", () => {
		expect(foldHover(TINT, 3).unreadableSheets).toBe(3);
	});

	it("leads with the treatment covering the most elements", () => {
		const report = foldHover([...TINT, ...MANY], 0);

		expect(report.groups[0]?.elements).toHaveLength(30);
	});
});

describe("renderHover", () => {
	it("says how many elements have a hover treatment", () => {
		expect(renderHover(foldHover(TINT, 0))).toContain("3");
	});

	it("collapses a large group instead of listing every element", () => {
		const text = renderHover(foldHover(MANY, 0));

		expect(text).toContain("30");
		expect(text.split("\n").length).toBeLessThan(20);
	});

	it("warns when hover is the only cue", () => {
		expect(renderHover(foldHover(TINT, 0))).toContain("keyboard");
	});

	it("stays quiet about the keyboard when every hover has a focus match", () => {
		const paired: HoverMeasurement[] = [
			{
				element: "a.both",
				hover: [{ property: "color", from: "black", to: "blue" }],
				focus: [{ property: "color", from: "black", to: "blue" }],
			},
		];

		expect(renderHover(foldHover(paired, 0))).not.toContain("keyboard");
	});

	it("admits a stylesheet it could not read", () => {
		// Silence here would be a report that looks complete while having
		// skipped a whole origin's styles.
		expect(renderHover(foldHover(TINT, 2))).toContain("could not be read");
	});

	it("says outright when nothing on the page hovers", () => {
		expect(renderHover(foldHover([], 0))).toContain("Nothing");
	});
});
