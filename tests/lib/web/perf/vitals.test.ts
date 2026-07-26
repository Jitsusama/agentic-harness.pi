/**
 * Web vitals arithmetic. The fixture numbers are from a live
 * capture of a page built to shift twice and block once.
 */

import { describe, expect, it } from "vitest";
import { renderVitals } from "../../../../lib/web/perf/view.js";
import {
	cumulativeShift,
	measure,
	rate,
	type Shift,
	THRESHOLDS,
	type Vitals,
	worstShiftSources,
} from "../../../../lib/web/perf/vitals.js";

const shift = (
	value: number,
	time: number,
	nodes: string[] = ["div"],
): Shift => ({
	value,
	time,
	sources: nodes.map((node) => ({ node, from: [0, 0], to: [0, 60] })),
});

/** A live capture of the slow fixture. */
const CAPTURE: Vitals = {
	lcp: { time: 24, size: 79296, element: "div.hero", url: null },
	shifts: [shift(0.069, 413), shift(0.069, 813)],
	longTasks: [{ time: 1213, duration: 249 }],
	paints: { "first-paint": 28, "first-contentful-paint": 28 },
	nav: {
		domContentLoaded: 11.9,
		load: 12.1,
		responseStart: 3.5,
		transferSize: 1183,
	},
};

describe("rate", () => {
	it("calls a value at the good boundary good", () => {
		expect(rate(2500, THRESHOLDS.lcp)).toBe("good");
	});

	it("calls a value between the boundaries near", () => {
		expect(rate(3000, THRESHOLDS.lcp)).toBe("needs-improvement");
	});

	it("calls a value past the poor boundary poor", () => {
		expect(rate(4001, THRESHOLDS.lcp)).toBe("poor");
	});
});

describe("cumulativeShift", () => {
	it("is zero when nothing moved", () => {
		expect(cumulativeShift([])).toBe(0);
	});

	it("adds shifts inside the same window", () => {
		expect(cumulativeShift([shift(0.05, 100), shift(0.05, 500)])).toBeCloseTo(
			0.1,
			5,
		);
	});

	it("starts a new window after a second of quiet", () => {
		// The metric is the worst window, not the total, so a page
		// that nudges occasionally is not scored as one that jumped.
		expect(cumulativeShift([shift(0.05, 100), shift(0.05, 2000)])).toBeCloseTo(
			0.05,
			5,
		);
	});

	it("caps a window at five seconds however busy it is", () => {
		const steady = Array.from({ length: 12 }, (_, index) =>
			shift(0.02, index * 600),
		);
		// Twelve shifts of 0.02 total 0.24; no five second window
		// holds them all, so the score must come out lower.
		expect(cumulativeShift(steady)).toBeLessThan(0.24);
	});

	it("reports the worst window, not the first or the last", () => {
		const shifts = [
			shift(0.01, 0),
			shift(0.3, 3000),
			shift(0.02, 3200),
			shift(0.01, 9000),
		];
		expect(cumulativeShift(shifts)).toBeCloseTo(0.32, 5);
	});
});

describe("worstShiftSources", () => {
	it("names what moved the page most", () => {
		const blame = worstShiftSources([
			shift(0.3, 0, ["#banner"]),
			shift(0.05, 100, ["p"]),
		]);
		expect(blame[0]?.node).toBe("#banner");
	});

	it("shares a shift between its sources, since none can be blamed", () => {
		const blame = worstShiftSources([shift(0.2, 0, ["#a", "#b"])]);
		expect(blame[0]?.moved).toBeCloseTo(0.1, 5);
	});

	it("adds up a node that moved more than once", () => {
		const blame = worstShiftSources([
			shift(0.1, 0, ["#a"]),
			shift(0.1, 100, ["#a"]),
		]);
		expect(blame[0]?.moved).toBeCloseTo(0.2, 5);
	});

	it("names an unnamed source rather than dropping it", () => {
		expect(
			worstShiftSources([
				{
					value: 0.1,
					time: 0,
					sources: [{ node: null, from: null, to: null }],
				},
			])[0]?.node,
		).toBe("(unnamed)");
	});
});

describe("measure", () => {
	const measures = measure(CAPTURE);

	it("reads every metric the capture carried", () => {
		expect(measures.map((one) => one.name)).toEqual([
			"time to first byte",
			"first contentful paint",
			"largest contentful paint",
			"cumulative layout shift",
			"total blocking time",
		]);
	});

	it("says what painted largest, not only when", () => {
		const lcp = measures.find((one) => one.name.includes("largest"));
		expect(lcp?.detail).toBe("div.hero");
	});

	it("counts only the part of a long task that blocked", () => {
		// A task is long past fifty milliseconds, and only the
		// excess is blocking time: 249 less 50.
		const blocking = measures.find((one) => one.name.includes("blocking"));
		expect(blocking?.value).toBe(199);
	});

	it("rates the fixture the way it was built to be rated", () => {
		// This page paints fast and then misbehaves: two shifts four
		// hundred milliseconds apart fall in one window and total
		// 0.138, and a 249 millisecond task blocks for 199 of them.
		const byName = new Map(measures.map((one) => [one.name, one.rating]));
		expect(byName.get("largest contentful paint")).toBe("good");
		expect(byName.get("first contentful paint")).toBe("good");
		expect(byName.get("cumulative layout shift")).toBe("needs-improvement");
		expect(byName.get("total blocking time")).toBe("needs-improvement");
	});

	it("rates a page that behaves as good throughout", () => {
		const quiet = measure({ ...CAPTURE, shifts: [], longTasks: [] });
		expect(quiet.every((one) => one.rating === "good")).toBe(true);
	});

	it("rates a page that shifts badly as poor", () => {
		const bad = measure({ ...CAPTURE, shifts: [shift(0.4, 100)] });
		const cls = bad.find((one) => one.name.includes("shift"));
		expect(cls?.rating).toBe("poor");
	});

	it("still reports a shift score of zero when nothing moved", () => {
		// Absence of a metric and a metric of zero are different
		// claims, and only one of them is reassuring.
		const still = measure({ ...CAPTURE, shifts: [] });
		expect(still.find((one) => one.name.includes("shift"))?.value).toBe(0);
	});

	it("leaves out what the browser never reported", () => {
		const bare = measure({ shifts: [], longTasks: [], paints: {} });
		expect(bare.map((one) => one.name)).toEqual(["cumulative layout shift"]);
	});
});

describe("renderVitals", () => {
	it("passes a page inside every threshold", () => {
		const quiet: Vitals = { ...CAPTURE, shifts: [], longTasks: [] };
		const out = renderVitals(quiet, measure(quiet));
		expect(out.startsWith("PASS")).toBe(true);
		expect(out).toContain("Every measure is within its threshold");
	});

	it("warns about a page that paints fast and then misbehaves", () => {
		const out = renderVitals(CAPTURE, measure(CAPTURE));
		expect(out.startsWith("WARN")).toBe(true);
		expect(out).toContain("2 of 5 measures are outside");
	});

	it("names the worst measure, not merely the first bad one", () => {
		// A near-miss and a failure together: the headline has to
		// point at the failure. Sorting the wrong way named the
		// near-miss, which sends the reader at the smaller problem.
		const mixed: Vitals = {
			...CAPTURE,
			shifts: [shift(0.4, 100)],
			longTasks: [{ time: 1213, duration: 120 }],
		};
		const out = renderVitals(mixed, measure(mixed));
		expect(out).toContain("worst is cumulative layout shift");
	});

	it("names the worst measure when something is out", () => {
		const bad: Vitals = { ...CAPTURE, shifts: [shift(0.4, 100)] };
		const out = renderVitals(bad, measure(bad));
		expect(out.startsWith("FAIL")).toBe(true);
		expect(out).toContain("cumulative layout shift");
	});

	it("says what moved the page", () => {
		const out = renderVitals(CAPTURE, measure(CAPTURE));
		expect(out).toContain("What moved the page");
	});

	it("admits when the observers were never installed", () => {
		const out = renderVitals(
			{ shifts: [], longTasks: [], paints: {}, error: "no observers here" },
			[],
		);
		expect(out.startsWith("WARN")).toBe(true);
		expect(out).toContain("no observers here");
	});

	it("does not report a clean pass when nothing was measured", () => {
		const out = renderVitals({ shifts: [], longTasks: [], paints: {} }, []);
		expect(out.startsWith("WARN")).toBe(true);
	});
});
