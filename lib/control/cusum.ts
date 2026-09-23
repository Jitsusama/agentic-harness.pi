/**
 * CUSUM against a frozen baseline: the cumulative-sum control chart
 * for catching a shift too gradual for any single point to explain,
 * without ever letting the baseline it is measured against drift to
 * follow the shift.
 *
 * "Frozen" is the entire point. A baseline recomputed from recent data
 * would absorb a slow drift as the new normal before it ever crossed a
 * threshold, which is exactly how an unmonitored parameter keeps
 * getting nudged: each nudge looks small against whatever the recent
 * average already became. Computing the baseline once, from a
 * reference period chosen deliberately, and never touching it again is
 * what lets a slow drift still show up as a large cumulative deviation.
 */

export interface CusumBaseline {
	readonly mean: number;
	readonly stdDev: number;
}

/** Mean and population standard deviation of a reference series, frozen once and never recomputed. */
export function computeBaseline(reference: readonly number[]): CusumBaseline {
	if (reference.length === 0) {
		throw new Error(
			"computeBaseline needs at least one value in the reference series",
		);
	}
	const mean =
		reference.reduce((sum, value) => sum + value, 0) / reference.length;
	const variance =
		reference.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		reference.length;
	return { mean, stdDev: Math.sqrt(variance) };
}

export interface CusumOptions {
	readonly baseline: CusumBaseline;
	/** Allowance before a deviation starts accumulating, in standard deviations. Default 0.5. */
	readonly slackStdDevs?: number;
	/** Cumulative deviation, in standard deviations, that counts as a signal. Default 5. */
	readonly thresholdStdDevs?: number;
}

export interface CusumPoint {
	readonly index: number;
	readonly value: number;
	/** Cumulative upward deviation after this point. */
	readonly upper: number;
	/** Cumulative downward deviation after this point. */
	readonly lower: number;
	readonly signal: "upper" | "lower" | null;
}

const DEFAULT_SLACK_STD_DEVS = 0.5;
const DEFAULT_THRESHOLD_STD_DEVS = 5;

/** Run two-sided CUSUM over `series` against a frozen `baseline`. */
export function cusum(
	series: readonly number[],
	options: CusumOptions,
): CusumPoint[] {
	const { baseline } = options;
	const slack =
		(options.slackStdDevs ?? DEFAULT_SLACK_STD_DEVS) * baseline.stdDev;
	const threshold =
		(options.thresholdStdDevs ?? DEFAULT_THRESHOLD_STD_DEVS) * baseline.stdDev;

	const points: CusumPoint[] = [];
	let upper = 0;
	let lower = 0;
	for (let i = 0; i < series.length; i++) {
		const value = series[i];
		const deviation = value - baseline.mean;
		upper = Math.max(0, upper + deviation - slack);
		lower = Math.max(0, lower - deviation - slack);
		const signal =
			upper > threshold ? "upper" : lower > threshold ? "lower" : null;
		points.push({ index: i, value, upper, lower, signal });
	}
	return points;
}
