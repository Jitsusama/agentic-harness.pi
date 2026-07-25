import { describe, expect, it } from "vitest";
import {
	judgeVisibility,
	type VisibilityFacts,
} from "../../../../lib/web/element/index.js";

const VIEWPORT = { width: 800, height: 600 };

/** A plainly visible element, for tests to spoil one fact of. */
const SEEN: VisibilityFacts = {
	rendered: true,
	border: { x: 8, y: 8, width: 118, height: 39 },
	viewport: VIEWPORT,
};

describe("judgeVisibility", () => {
	it("calls a rendered, unobstructed element visible", () => {
		expect(judgeVisibility(SEEN)).toEqual({
			state: "visible",
			because: "it is on screen and receives its own centre",
		});
	});

	it("says an element with no box is not rendered", () => {
		// display none reports no box model at all, which is a
		// different thing from being scrolled away.
		expect(judgeVisibility({ rendered: false })).toEqual({
			state: "not rendered",
			because: "it has no box, so display is none or it is not in the page",
		});
	});

	it("says an element collapsed to nothing has zero size", () => {
		const verdict = judgeVisibility({
			...SEEN,
			border: { x: 8, y: 8, width: 0, height: 39 },
		});
		expect(verdict).toEqual({
			state: "zero size",
			because: "it measures 0 by 39",
		});
	});

	it("says an element below the fold is off screen", () => {
		const verdict = judgeVisibility({
			...SEEN,
			border: { x: 8, y: 4008, width: 144, height: 39 },
		});
		expect(verdict).toEqual({
			state: "off screen",
			because: "it sits outside the 800 by 600 viewport and needs scrolling to",
		});
	});

	it("counts an element partly in view as on screen", () => {
		// Half a button is still clickable, and calling it off
		// screen would send a caller scrolling for no reason.
		const verdict = judgeVisibility({
			...SEEN,
			border: { x: 8, y: 580, width: 144, height: 39 },
		});
		expect(verdict.state).toBe("visible");
	});

	it("names what is covering an element", () => {
		const verdict = judgeVisibility({ ...SEEN, coveredBy: "div id=veil" });
		expect(verdict).toEqual({
			state: "covered",
			because: "div id=veil is painted over its centre",
		});
	});

	it("says an element faded out is transparent", () => {
		expect(judgeVisibility({ ...SEEN, opacity: 0 })).toEqual({
			state: "transparent",
			because: "its opacity is 0",
		});
	});

	it("says an element hidden by visibility is not rendered", () => {
		// It still reports a box, so the box alone cannot tell.
		expect(judgeVisibility({ ...SEEN, visibility: "hidden" })).toEqual({
			state: "not rendered",
			because: "its visibility is hidden",
		});
	});

	it("reports the most fundamental problem first", () => {
		// An element that is not rendered cannot also be usefully
		// described as covered, and saying so would send someone
		// looking for an overlay that is not the cause.
		const verdict = judgeVisibility({
			rendered: false,
			coveredBy: "div id=veil",
			opacity: 0,
		});
		expect(verdict.state).toBe("not rendered");
	});

	it("prefers zero size over being covered", () => {
		const verdict = judgeVisibility({
			...SEEN,
			border: { x: 8, y: 8, width: 0, height: 0 },
			coveredBy: "div id=veil",
		});
		expect(verdict.state).toBe("zero size");
	});

	it("judges without a viewport rather than refusing", () => {
		// A capture may not carry one; that is no reason to
		// withhold everything else known about the element.
		const verdict = judgeVisibility({
			rendered: true,
			border: { x: 8, y: 8, width: 118, height: 39 },
		});
		expect(verdict.state).toBe("visible");
	});
});
