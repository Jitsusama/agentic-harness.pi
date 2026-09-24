import { describe, expect, it } from "vitest";
import {
	currentThresholdDraw,
	drawThreshold,
	THRESHOLD_ENTRY,
} from "../../../lib/compaction/index.ts";

/** A random source that answers these values in turn. */
function answers(...values: number[]): () => number {
	let next = 0;
	return () => values[next++];
}

describe("drawing the threshold a stretch of session compacts at", () => {
	it("takes the usual threshold, √2, most of the time, and says how likely that was", () => {
		expect(drawThreshold(answers(0.5), 0.1)).toEqual({
			threshold: Math.SQRT2,
			propensity: 0.9,
			explored: false,
		});
	});

	it("sometimes compacts a little earlier or later, at an equal and recorded chance", () => {
		expect(drawThreshold(answers(0.05, 0.9), 0.1)).toEqual({
			threshold: 2,
			propensity: 0.05,
			explored: true,
		});
		expect(drawThreshold(answers(0.05, 0.1), 0.1)).toEqual({
			threshold: 1,
			propensity: 0.05,
			explored: true,
		});
	});

	it("always takes the usual threshold, for certain, when exploring is off", () => {
		expect(drawThreshold(answers(0), 0)).toEqual({
			threshold: Math.SQRT2,
			propensity: 1,
			explored: false,
		});
	});
});

describe("reading back the threshold this stretch already drew", () => {
	const draw = { threshold: Math.SQRT2, propensity: 0.05, explored: true };
	const entry = { type: "custom", customType: THRESHOLD_ENTRY, data: draw };
	const turn = { type: "message", message: { role: "assistant", usage: {} } };

	it("finds the draw made since the last compaction, so a resumed session keeps it", () => {
		expect(
			currentThresholdDraw([turn, { type: "compaction" }, entry, turn]),
		).toEqual(draw);
	});

	it("does not carry a draw across a compaction, which starts a new stretch", () => {
		expect(
			currentThresholdDraw([entry, turn, { type: "compaction" }, turn]),
		).toBeNull();
	});

	it("ignores other extensions' entries and draws it cannot read", () => {
		expect(
			currentThresholdDraw([
				{ type: "custom", customType: "something-else", data: draw },
				{
					type: "custom",
					customType: THRESHOLD_ENTRY,
					data: { threshold: "high" },
				},
			]),
		).toBeNull();
	});
});
