import { describe, expect, it } from "vitest";
import {
	type ActionabilityFacts,
	judgeActionability,
	sameBox,
} from "../../../../lib/web/element/index.js";

/** An element ready to be acted on, for tests to spoil. */
const READY: ActionabilityFacts = {
	present: true,
	visibility: { state: "visible", because: "it is on screen" },
	enabled: true,
	settled: true,
};

describe("judgeActionability", () => {
	it("calls a present, visible, enabled, still element ready", () => {
		expect(judgeActionability(READY)).toEqual({ ready: true });
	});

	it("names absence when the element is not there", () => {
		expect(judgeActionability({ ...READY, present: false })).toEqual({
			ready: false,
			blocker: "it is not in the page",
		});
	});

	it("passes on the visibility verdict rather than restating it", () => {
		// The verdict already explains itself, and inventing a
		// second wording for the same fact invites the two to
		// disagree.
		expect(
			judgeActionability({
				...READY,
				visibility: { state: "covered", because: "div id=veil covers it" },
			}),
		).toEqual({ ready: false, blocker: "div id=veil covers it" });
	});

	it("names being disabled", () => {
		expect(judgeActionability({ ...READY, enabled: false })).toEqual({
			ready: false,
			blocker: "it is disabled",
		});
	});

	it("names still moving", () => {
		expect(judgeActionability({ ...READY, settled: false })).toEqual({
			ready: false,
			blocker: "it is still moving",
		});
	});

	it("reports the most fundamental problem first", () => {
		// Reporting that a missing element is also disabled would
		// send someone looking at the wrong thing.
		const verdict = judgeActionability({
			present: false,
			enabled: false,
			settled: false,
			visibility: { state: "covered", because: "something covers it" },
		});
		expect(verdict.blocker).toBe("it is not in the page");
	});

	it("prefers a visibility problem over being disabled", () => {
		const verdict = judgeActionability({
			...READY,
			enabled: false,
			visibility: { state: "off screen", because: "it needs scrolling to" },
		});
		expect(verdict.blocker).toBe("it needs scrolling to");
	});

	it("judges without a visibility verdict rather than refusing", () => {
		expect(
			judgeActionability({ present: true, enabled: true, settled: true }),
		).toEqual({ ready: true });
	});
});

describe("sameBox", () => {
	it("calls an unmoved box the same", () => {
		const box = { x: 1, y: 2, width: 3, height: 4 };
		expect(sameBox(box, { ...box })).toBe(true);
	});

	it("calls a moved box different", () => {
		expect(
			sameBox(
				{ x: 1, y: 2, width: 3, height: 4 },
				{ x: 9, y: 2, width: 3, height: 4 },
			),
		).toBe(false);
	});

	it("ignores a wobble too small to matter", () => {
		// Sub-pixel layout jitter is not movement, and treating it
		// as such would make an element never settle.
		expect(
			sameBox(
				{ x: 1, y: 2, width: 3, height: 4 },
				{ x: 1.4, y: 2, width: 3, height: 4 },
			),
		).toBe(true);
	});

	it("counts a resize as movement", () => {
		expect(
			sameBox(
				{ x: 1, y: 2, width: 3, height: 4 },
				{ x: 1, y: 2, width: 30, height: 4 },
			),
		).toBe(false);
	});

	it("treats a box that appeared or vanished as movement", () => {
		const box = { x: 1, y: 2, width: 3, height: 4 };
		expect(sameBox(undefined, box)).toBe(false);
		expect(sameBox(box, undefined)).toBe(false);
	});
});
