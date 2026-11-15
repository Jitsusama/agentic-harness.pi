/**
 * The keyboard walk. Every fixture here mirrors a shape taken
 * from a real capture, including the detail that a computed
 * outline keeps its width even when its style is none.
 */

import { describe, expect, it } from "vitest";
import {
	analyseWalk,
	indicatorOf,
	judgeIndicator,
	outOfVisualOrder,
	type WalkStop,
} from "../../../../lib/core/web/a11y/walk.ts";
import { AT_REST, candidate, capture, RINGED, stop } from "./walk-fixture.ts";

describe("judgeIndicator", () => {
	it("fails a ring too faint to see against its surface", () => {
		// The existence check passes here: the outline really does
		// appear on focus, so the walk records an indicator and says
		// nothing. But 2.4.11 asks whether it can be seen, and a pale
		// grey ring on white cannot. An indicator that exists and is
		// invisible is worse than none, because it satisfies every
		// check and still leaves someone unable to tell where they
		// are on the page.
		const verdict = judgeIndicator({
			indicator: "outline",
			resting: { ...AT_REST, backgroundColor: "rgb(255, 255, 255)" },
			focused: {
				...AT_REST,
				backgroundColor: "rgb(255, 255, 255)",
				outlineStyle: "solid",
				outlineColor: "rgb(233, 233, 233)",
			},
		});

		expect(verdict.standing).toBe("fail");
		expect(verdict.ratio).toBeLessThan(3);
	});

	it("passes a ring with enough contrast", () => {
		const verdict = judgeIndicator({
			indicator: "outline",
			resting: { ...AT_REST, backgroundColor: "rgb(255, 255, 255)" },
			focused: {
				...RINGED,
				backgroundColor: "rgb(255, 255, 255)",
			},
		});

		expect(verdict.standing).toBe("pass");
		expect(verdict.ratio).toBeGreaterThanOrEqual(3);
	});

	it("declines to judge a ring drawn as a shadow", () => {
		// A box shadow can be any number of layers, offset in any
		// direction, over whatever happens to be behind the element.
		// Which pixels changed is not answerable from the computed
		// value, and guessing would produce exactly the confident
		// wrong accessibility finding this package refuses to make.
		const verdict = judgeIndicator({
			indicator: "boxShadow",
			resting: AT_REST,
			focused: { ...AT_REST, boxShadow: "rgb(0, 90, 200) 0px 0px 0px 3px" },
		});

		expect(verdict.standing).toBe("undecided");
		expect(verdict.ratio).toBeUndefined();
	});

	it("declines when the surface behind the ring is see-through", () => {
		// A transparent background means the colour behind the ring
		// belongs to some ancestor, and the computed style does not
		// say which. Compositing against a guess is how a page gets
		// accused of a contrast failure it does not have.
		const verdict = judgeIndicator({
			indicator: "outline",
			resting: AT_REST,
			focused: RINGED,
		});

		expect(verdict.standing).toBe("undecided");
	});
});

describe("indicatorOf", () => {
	it("finds an outline that appears on focus", () => {
		expect(indicatorOf(AT_REST, RINGED)).toBe("outline");
	});

	it("says none when nothing at all changes", () => {
		expect(indicatorOf(AT_REST, AT_REST)).toBe("none");
	});

	it("ignores a width that persists behind a style of none", () => {
		// Chrome reports outlineWidth 3px even with outlineStyle
		// none. Comparing widths alone would invent an indicator.
		const wider = { ...AT_REST, outlineWidth: "5px" };
		expect(indicatorOf(AT_REST, wider)).toBe("none");
	});

	it("finds an indicator drawn as a shadow", () => {
		expect(
			indicatorOf(AT_REST, {
				...AT_REST,
				boxShadow: "rgb(0, 90, 200) 0px 0px 0px 3px",
			}),
		).toBe("boxShadow");
	});

	it("finds one drawn as a background change", () => {
		expect(
			indicatorOf(AT_REST, { ...AT_REST, backgroundColor: "rgb(0, 0, 255)" }),
		).toBe("background");
	});

	it("finds one drawn on the border", () => {
		expect(
			indicatorOf(AT_REST, { ...AT_REST, borderColor: "rgb(0, 0, 255)" }),
		).toBe("border");
	});

	it("notices a faint ring as an indicator, leaving brightness to others", () => {
		// Whether rgb(250,250,250) can be seen is a contrast
		// question. That it is drawn at all is this module's answer.
		const faint = {
			...AT_REST,
			outlineStyle: "solid",
			outlineColor: "rgb(250, 250, 250)",
		};
		expect(indicatorOf(AT_REST, faint)).toBe("outline");
	});
});

describe("analyseWalk", () => {
	it("reports the stops it was given", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "One"), candidate(1, "Two")],
				stops: [stop(0, "One"), stop(1, "Two")],
			}),
		);
		expect(found.stops).toHaveLength(2);
		expect(found.trap).toBeUndefined();
	});

	it("calls out a stop with no focus indicator", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "Ringed"), candidate(1, "Bare")],
				stops: [stop(0, "Ringed"), stop(1, "Bare", { focused: AT_REST })],
			}),
		);
		expect(found.noIndicator.map((s) => s.name)).toEqual(["Bare"]);
	});

	it("separates a ring too faint to see from no ring at all", () => {
		// Two different repairs. A control with no indicator needs one
		// written; a control with a pale one needs its colour changed.
		// Reporting them together would send someone looking for a
		// missing rule that is already there.
		const onWhite = { ...AT_REST, backgroundColor: "rgb(255, 255, 255)" };
		const found = analyseWalk(
			capture({
				candidates: [
					candidate(0, "Pale", { resting: onWhite }),
					candidate(1, "Bare", { resting: onWhite }),
					candidate(2, "Bright", { resting: onWhite }),
				],
				stops: [
					stop(0, "Pale", {
						focused: {
							...onWhite,
							outlineStyle: "solid",
							outlineColor: "rgb(233, 233, 233)",
						},
					}),
					stop(1, "Bare", { focused: onWhite }),
					stop(2, "Bright", {
						focused: {
							...RINGED,
							...onWhite,
							outlineStyle: "solid",
							outlineColor: "rgb(0, 102, 204)",
						},
					}),
				],
			}),
		);

		expect(found.faintIndicator.map((faint) => faint.stop.name)).toEqual([
			"Pale",
		]);
		expect(found.noIndicator.map((s) => s.name)).toEqual(["Bare"]);
		expect(found.faintIndicator[0]?.ratio).toBeLessThan(3);
	});

	it("does not call a whole-page loop a trap", () => {
		// A working tab order cycles too. What matters is whether
		// anything is left outside the cycle.
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "One"), candidate(1, "Two")],
				stops: [stop(0, "One"), stop(1, "Two"), stop(0, "One"), stop(1, "Two")],
			}),
		);
		expect(found.trap).toBeUndefined();
	});

	it("finds a trap when the cycle is smaller than the page", () => {
		const found = analyseWalk(
			capture({
				candidates: [
					candidate(0, "Outside"),
					candidate(1, "Trapped one"),
					candidate(2, "Trapped two"),
				],
				stops: [
					stop(1, "Trapped one"),
					stop(2, "Trapped two"),
					stop(1, "Trapped one"),
					stop(2, "Trapped two"),
				],
			}),
		);
		expect(found.trap).toBeDefined();
		expect(found.trap?.members.map((s) => s.name).sort()).toEqual([
			"Trapped one",
			"Trapped two",
		]);
	});

	it("records whether Escape got out of the trap", () => {
		const stuck = {
			candidates: [candidate(0, "Outside"), candidate(1, "In")],
			stops: [stop(1, "In"), stop(1, "In")],
		};
		expect(analyseWalk(capture(stuck)).trap).toMatchObject({
			escapeFreed: false,
		});
		expect(
			analyseWalk(capture({ ...stuck, escapeFreed: true })).trap,
		).toMatchObject({ escapeFreed: true });
	});

	it("lists focusable things the walk never arrived at", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "Seen"), candidate(1, "Skipped")],
				stops: [stop(0, "Seen")],
			}),
		);
		expect(found.missed.map((c) => c.name)).toEqual(["Skipped"]);
	});

	it("counts a radio group reached when Tab stopped on one of its radios", () => {
		const radio = (index: number, name: string, group: string) =>
			candidate(index, name, { tag: "INPUT", group });
		const found = analyseWalk(
			capture({
				candidates: [
					radio(0, "Small", "radio size"),
					radio(1, "Medium", "radio size"),
					radio(2, "Tea", "radio drink"),
					radio(3, "Coffee", "radio drink"),
				],
				stops: [stop(1, "Medium", { tag: "INPUT" })],
			}),
		);
		expect(found.missed.map((c) => c.name)).toEqual(["Tea", "Coffee"]);
	});

	it("does not call a radio group stranded when its tab stop cycles", () => {
		// The whole page tabs round and round, which is correct; the
		// group's other radios sit outside the cycle only because Tab
		// stops on one radio of a group.
		const found = analyseWalk(
			capture({
				candidates: [
					candidate(0, "Everyone", { tag: "INPUT", group: "radio who" }),
					candidate(1, "Joel", { tag: "INPUT", group: "radio who" }),
					candidate(2, "Save"),
				],
				stops: [
					stop(0, "Everyone", { tag: "INPUT" }),
					stop(2, "Save"),
					stop(0, "Everyone", { tag: "INPUT" }),
					stop(2, "Save"),
				],
			}),
		);
		expect(found.trap).toBeUndefined();
		expect(found.missed).toEqual([]);
	});

	it("flags focus landing off screen", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "Hidden away")],
				stops: [stop(0, "Hidden away", { inViewport: false })],
			}),
		);
		expect(found.offscreen).toHaveLength(1);
	});

	it("counts an offscreen stop once, not once per lap", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "Away"), candidate(1, "Here")],
				stops: [
					stop(0, "Away", { inViewport: false }),
					stop(1, "Here"),
					stop(0, "Away", { inViewport: false }),
					stop(1, "Here"),
				],
			}),
		);
		expect(found.offscreen).toHaveLength(1);
	});

	it("flags a positive tabindex", () => {
		const found = analyseWalk(
			capture({
				candidates: [
					candidate(0, "Normal"),
					candidate(1, "Pushy", {
						tabindex: 3,
					}),
				],
				stops: [stop(1, "Pushy"), stop(0, "Normal")],
			}),
		);
		expect(found.positiveTabindex.map((c) => c.name)).toEqual(["Pushy"]);
	});

	it("notices when tab order departs from document order", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "First"), candidate(1, "Second")],
				stops: [stop(1, "Second"), stop(0, "First")],
			}),
		);
		expect(found).toMatchObject({ reordered: true });
	});

	it("does not cry reorder over a straightforward page", () => {
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "a"), candidate(1, "b"), candidate(2, "c")],
				stops: [stop(0, "a"), stop(1, "b"), stop(2, "c")],
			}),
		);
		expect(found).toMatchObject({ reordered: false });
	});

	it("carries through what looked interactive but was unreachable", () => {
		const found = analyseWalk(
			capture({
				unreachable: [
					{ tag: "DIV", name: "Save", because: "has a click handler" },
				],
			}),
		);
		expect(found.unreachable).toHaveLength(1);
	});

	it("ignores stops that left the candidates entirely", () => {
		// Focus passing through the document body is a real stop but
		// not a candidate, and it should not count as one.
		const found = analyseWalk(
			capture({
				candidates: [candidate(0, "One")],
				stops: [stop(0, "One"), stop(-1, "", { tag: "BODY" })],
			}),
		);
		expect(found.offscreen).toHaveLength(0);
		expect(found.missed).toHaveLength(0);
	});
});

describe("tab order against the order things are read in", () => {
	const at = (
		name: string,
		index: number,
		left: number,
		top: number,
	): WalkStop => ({
		index,
		tag: "button",
		name,
		inViewport: true,
		focused: AT_REST,
		rect: { x: left, y: top, width: 80, height: 30 },
	});

	it("catches two controls on one line that tab right to left", () => {
		// flex-direction: row-reverse, or order: juggling. Visually
		// Back then Next; by keyboard Next then Back. Nothing else
		// explains it, which is what makes it worth reporting.
		const jumps = outOfVisualOrder(
			[at("Next", 0, 200, 100), at("Back", 1, 100, 100)],
			"ltr",
		);

		expect(jumps).toHaveLength(1);
		expect(jumps[0]?.before.name).toBe("Next");
		expect(jumps[0]?.after.name).toBe("Back");
	});

	it("says nothing about a row that tabs the way it reads", () => {
		expect(
			outOfVisualOrder(
				[at("Back", 0, 100, 100), at("Next", 1, 200, 100)],
				"ltr",
			),
		).toEqual([]);
	});

	it("does not accuse a column layout", () => {
		// Down the left column, then down the right: every pair is on
		// a different line, so none of them is a same-line inversion.
		// This is the false positive the check exists to avoid.
		expect(
			outOfVisualOrder(
				[
					at("One", 0, 100, 100),
					at("Two", 1, 100, 200),
					at("Three", 2, 300, 100),
					at("Four", 3, 300, 200),
				],
				"ltr",
			),
		).toEqual([]);
	});

	it("reads a right-to-left page right to left", () => {
		// The same geometry that is wrong in English is correct in
		// Arabic, so the direction has to come from the page.
		expect(
			outOfVisualOrder(
				[at("Next", 0, 200, 100), at("Back", 1, 100, 100)],
				"rtl",
			),
		).toEqual([]);
	});

	it("ignores a stop with no box", () => {
		const bodiless: WalkStop = {
			index: 0,
			tag: "button",
			name: "Ghost",
			inViewport: false,
			focused: AT_REST,
		};

		expect(
			outOfVisualOrder([bodiless, at("Back", 1, 100, 100)], "ltr"),
		).toEqual([]);
	});

	it("treats slightly offset controls as sharing a line", () => {
		// Buttons of different heights in a toolbar do not share a
		// top edge to the pixel, and demanding they do would miss
		// every real case.
		const jumps = outOfVisualOrder(
			[at("Next", 0, 200, 104), at("Back", 1, 100, 100)],
			"ltr",
		);

		expect(jumps).toHaveLength(1);
	});
});
