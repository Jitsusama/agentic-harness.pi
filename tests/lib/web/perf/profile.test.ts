/**
 * Turning a sampling profile into "what was slow".
 */

import { describe, expect, it } from "vitest";
import {
	foldProfile,
	type RawProfile,
	renderHotspots,
} from "../../../../lib/web/perf/profile.js";

/**
 * A profile shaped the way the protocol sends one: nodes with
 * ids, a flat list of which node each sample landed in, and the
 * gap before each sample in microseconds.
 */
const profile = (
	samples: number[],
	deltas: number[],
	nodes?: RawProfile["nodes"],
): RawProfile => ({
	startTime: 0,
	endTime: 1_000_000,
	samples,
	timeDeltas: deltas,
	nodes: nodes ?? [
		{
			id: 1,
			callFrame: { functionName: "(root)", url: "", lineNumber: -1 },
			children: [2, 3],
		},
		{
			id: 2,
			callFrame: {
				functionName: "parseEverything",
				url: "https://shop.example/app.js",
				lineNumber: 40,
			},
		},
		{
			id: 3,
			callFrame: {
				functionName: "tidy",
				url: "https://shop.example/app.js",
				lineNumber: 90,
			},
		},
	],
});

describe("foldProfile", () => {
	it("ranks functions by the time actually spent in them", () => {
		// Three samples in parseEverything, one in tidy, each 10ms.
		const folded = foldProfile(
			profile([2, 2, 2, 3], [10_000, 10_000, 10_000, 10_000]),
		);

		expect(folded.hotspots[0]?.function).toBe("parseEverything");
		expect(folded.hotspots[0]?.selfMs).toBeCloseTo(30, 0);
		expect(folded.hotspots[1]?.function).toBe("tidy");
	});

	it("keeps where the function lives, so it can be found", () => {
		const folded = foldProfile(profile([2], [10_000]));

		expect(folded.hotspots[0]?.url).toBe("https://shop.example/app.js");
		expect(folded.hotspots[0]?.line).toBe(40);
	});

	it("reports the share of the time, not just the milliseconds", () => {
		const folded = foldProfile(profile([2, 3], [10_000, 10_000]));

		expect(folded.hotspots[0]?.share).toBeCloseTo(0.5, 2);
	});

	it("names time spent in the engine rather than hiding it", () => {
		// A sample in (root) is real time that belongs to nobody's
		// function. Dropping it makes the shares add up to more than
		// the time that passed.
		const folded = foldProfile(profile([1, 2], [10_000, 10_000]));

		expect(folded.hotspots.some((spot) => spot.function === "(root)")).toBe(
			true,
		);
	});

	it("survives a profile that caught nothing", () => {
		// A page that was idle profiles to no samples at all, and
		// that is an answer rather than an error.
		const folded = foldProfile(profile([], []));

		expect(folded.hotspots).toEqual([]);
		expect(folded.sampledMs).toBe(0);
	});

	it("gives an anonymous function a name you can look up", () => {
		const folded = foldProfile(
			profile(
				[2],
				[10_000],
				[
					{
						id: 2,
						callFrame: {
							functionName: "",
							url: "https://shop.example/app.js",
							lineNumber: 12,
						},
					},
				],
			),
		);

		expect(folded.hotspots[0]?.function).toContain("anonymous");
	});
});

describe("renderHotspots", () => {
	it("leads with the worst offender", () => {
		const rendered = renderHotspots(
			foldProfile(profile([2, 2, 3], [10_000, 10_000, 10_000])),
		);

		expect(rendered.indexOf("parseEverything")).toBeLessThan(
			rendered.indexOf("tidy"),
		);
	});

	it("says plainly when nothing ran", () => {
		expect(
			renderHotspots(foldProfile(profile([], []))).toLowerCase(),
		).toContain("no javascript");
	});
});
