import { describe, expect, it } from "vitest";
import { computeBaseline, cusum } from "../../../lib/control/index.js";

describe("computing a frozen baseline", () => {
	it("reads the mean and population standard deviation of a reference series", () => {
		const baseline = computeBaseline([2, 4, 4, 4, 5, 5, 7, 9]);
		expect(baseline.mean).toBeCloseTo(5, 5);
		expect(baseline.stdDev).toBeCloseTo(2, 5);
	});

	it("refuses an empty reference series rather than dividing by zero", () => {
		expect(() => computeBaseline([])).toThrow();
	});
});

describe("running CUSUM against a frozen baseline", () => {
	it("stays quiet on a series that never leaves the baseline", () => {
		const baseline = { mean: 10, stdDev: 1 };
		const series = [10, 9, 11, 10, 9, 11, 10];
		const points = cusum(series, { baseline });
		expect(points.every((p) => p.signal === null)).toBe(true);
	});

	it("signals an upward shift once the cumulative deviation crosses the threshold", () => {
		const baseline = { mean: 10, stdDev: 1 };
		// A sustained shift to 14 (four standard deviations above target)
		// should accumulate past a five-sigma threshold within a handful
		// of points, the way CUSUM is meant to catch a shift a single
		// point would not.
		const series = [10, 10, 14, 14, 14, 14, 14, 14];
		const points = cusum(series, { baseline });
		const signalled = points.find((p) => p.signal === "upper");
		expect(signalled).toBeDefined();
	});

	it("signals a downward shift the same way, on the lower sum", () => {
		const baseline = { mean: 10, stdDev: 1 };
		const series = [10, 10, 6, 6, 6, 6, 6, 6];
		const points = cusum(series, { baseline });
		const signalled = points.find((p) => p.signal === "lower");
		expect(signalled).toBeDefined();
	});

	it("does not chase the baseline: a frozen baseline stays what it was computed as", () => {
		// The point of "frozen" is that a slow drift is exactly what this
		// is meant to catch, so passing the same baseline object to two
		// separate calls must give the same answer regardless of what
		// either series contains.
		const baseline = { mean: 10, stdDev: 1 };
		const first = cusum([10, 12, 12], { baseline });
		const second = cusum([10, 12, 12], { baseline });
		expect(first).toEqual(second);
	});

	it("treats a smaller slack as more sensitive to the same shift", () => {
		const baseline = { mean: 10, stdDev: 1 };
		const series = [10, 11, 11, 11, 11];
		const sensitive = cusum(series, { baseline, slackStdDevs: 0.1 });
		const lenient = cusum(series, { baseline, slackStdDevs: 2 });
		const lastSensitive = sensitive[sensitive.length - 1];
		const lastLenient = lenient[lenient.length - 1];
		expect(lastSensitive.upper).toBeGreaterThan(lastLenient.upper);
	});
});
