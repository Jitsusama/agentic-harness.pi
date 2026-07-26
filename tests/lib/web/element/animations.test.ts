import { describe, expect, it } from "vitest";
import {
	normalizeAnimations,
	type RawAnimation,
	renderAnimations,
} from "../../../../lib/web/element/index.js";

/**
 * A capture shaped the way the page reports it. Iteration
 * counts arrive as text because an endless animation counts
 * Infinity, which does not survive being serialized.
 */
const CAPTURE: readonly RawAnimation[] = [
	{
		name: "spin",
		kind: "animation",
		playState: "running",
		durationMs: 2000,
		easing: "linear",
		iterations: "Infinity",
	},
	{
		name: "background-color",
		kind: "transition",
		playState: "finished",
		durationMs: 300,
		easing: "ease",
		iterations: "1",
	},
];

describe("normalizeAnimations", () => {
	it("reads an endless animation as endless", () => {
		// Infinity does not survive being serialized, so the page
		// sends the word and a count of null would be a lie.
		expect(normalizeAnimations(CAPTURE)[0].iterations).toBe("endless");
	});

	it("reads a finite count as a number", () => {
		expect(normalizeAnimations(CAPTURE)[1].iterations).toBe("1");
	});

	it("keeps the timing the page reported", () => {
		const [spin] = normalizeAnimations(CAPTURE);
		expect([spin.durationMs, spin.easing, spin.playState]).toEqual([
			2000,
			"linear",
			"running",
		]);
	});

	it("tells a transition from an animation", () => {
		expect(normalizeAnimations(CAPTURE).map((a) => a.kind)).toEqual([
			"animation",
			"transition",
		]);
	});

	it("names an animation nobody named", () => {
		const [unnamed] = normalizeAnimations([
			{ kind: "animation", playState: "running" },
		]);
		expect(unnamed.name).toBe("unnamed");
	});
});

describe("renderAnimations", () => {
	it("says what is moving and how", () => {
		expect(renderAnimations(normalizeAnimations(CAPTURE))).toBe(
			[
				"spin  animation  running  2000ms  linear  endless",
				"background-color  transition  finished  300ms  ease",
			].join("\n"),
		);
	});

	it("says plainly when nothing is moving", () => {
		expect(renderAnimations([])).toBe("Nothing is animating.");
	});
});
