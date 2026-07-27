/**
 * What the page cost the person waiting for it.
 *
 * The numbers come from the browser's own performance observers,
 * which is the only place they can honestly come from: largest
 * contentful paint and layout shift are defined by what the
 * renderer did, not by anything measurable from outside.
 *
 * What this module adds is the arithmetic the observers leave to
 * the caller, and one piece of it matters more than the rest.
 * Cumulative layout shift is not the sum of every shift, though
 * summing is the obvious reading of the name. It is the largest
 * sum within a session window, so a page that shifts a little
 * every few seconds over a long visit is not punished as though
 * it had shifted once, enormously.
 */

/** Where a metric falls against the published thresholds. */
export type Rating = "good" | "needs-improvement" | "poor";

/** One layout shift the browser recorded. */
export interface Shift {
	readonly value: number;
	readonly time: number;
	readonly sources: readonly {
		readonly node: string | null;
		readonly from: readonly [number, number] | null;
		readonly to: readonly [number, number] | null;
	}[];
}

/** A stretch where the main thread could not respond. */
export interface LongTask {
	readonly time: number;
	readonly duration: number;
}

/** Everything the observers gathered. */
export interface Vitals {
	readonly lcp?: {
		readonly time: number;
		readonly size: number;
		readonly element: string | null;
		readonly url: string | null;
	};
	readonly shifts: readonly Shift[];
	readonly longTasks: readonly LongTask[];
	readonly paints: Readonly<Record<string, number>>;
	readonly nav?: {
		readonly domContentLoaded: number;
		readonly load: number;
		readonly responseStart: number;
		readonly transferSize: number;
	};
	/** Set when the bootstrap itself could not run at all. */
	readonly error?: string;
	/** Entry types that are being observed. */
	readonly installed?: readonly string[];
	/** Entry types that could not be observed, and why. */
	readonly unavailable?: readonly string[];
}

/**
 * Whether an entry type was actually being watched.
 *
 * An observer that never installed reports nothing, which looks
 * exactly like a page with nothing to report. Cumulative layout
 * shift is the one that matters: it was pushed unconditionally,
 * so a capture where no observer ran still answered 0.000 and
 * PASS, and the renderer's "Nothing was measured" branch could
 * never be reached.
 */
export function watching(vitals: Vitals, type: string): boolean {
	// A capture from before this was recorded says nothing either
	// way; treat it as watching, which is how it behaved then.
	return vitals.installed === undefined || vitals.installed.includes(type);
}

/** A shift more than this far after the last one starts a new window. */
export const SESSION_GAP_MS = 1000;

/** No session window runs longer than this. */
export const SESSION_CAP_MS = 5000;

/**
 * The published good and poor boundaries, in order.
 *
 * `longTask` is the per-task pair: a task over 50ms is long, and
 * the deduction that turns a set of long tasks into total
 * blocking time is taken against that 50. `tbt` is the separate
 * pair for the aggregate. Reusing the per-task numbers to rate
 * the sum called 210ms of total blocking time poor, when the
 * published boundary for poor is 600, and because perf sits in
 * the health digest an ordinary page dragged the whole digest
 * to FAIL.
 */
export const THRESHOLDS = {
	lcp: { good: 2500, poor: 4000 },
	cls: { good: 0.1, poor: 0.25 },
	fcp: { good: 1800, poor: 3000 },
	ttfb: { good: 800, poor: 1800 },
	longTask: { good: 50, poor: 200 },
	tbt: { good: 200, poor: 600 },
} as const;

/** Rate a measurement against its thresholds. */
export function rate(
	value: number,
	bounds: { readonly good: number; readonly poor: number },
): Rating {
	if (value <= bounds.good) return "good";
	return value <= bounds.poor ? "needs-improvement" : "poor";
}

/**
 * Cumulative layout shift, as the metric is actually defined.
 *
 * Shifts are grouped into windows: a gap of a second starts a
 * new one, and no window runs past five seconds. The score is
 * the largest window, not the total. Summing everything would
 * report a page that nudges once a minute as worse than one
 * that jumps once on load, which is backwards.
 */
export function cumulativeShift(shifts: readonly Shift[]): number {
	let worst = 0;
	let windowTotal = 0;
	let windowStart = 0;
	let previous = 0;

	for (const shift of shifts) {
		const startsNew =
			windowTotal > 0 &&
			(shift.time - previous > SESSION_GAP_MS ||
				shift.time - windowStart > SESSION_CAP_MS);
		if (startsNew) {
			worst = Math.max(worst, windowTotal);
			windowTotal = 0;
			windowStart = shift.time;
		}
		if (windowTotal === 0) windowStart = shift.time;
		windowTotal += shift.value;
		previous = shift.time;
	}
	return Math.max(worst, windowTotal);
}

/** What most moved the page, and how much. */
export function worstShiftSources(
	shifts: readonly Shift[],
	limit = 5,
): readonly { readonly node: string; readonly moved: number }[] {
	const blame = new Map<string, number>();
	for (const shift of shifts) {
		// A shift with several sources shares its score among them,
		// because there is no way to tell which one moved the page.
		const share =
			shift.sources.length > 0 ? shift.value / shift.sources.length : 0;
		for (const source of shift.sources) {
			const node = source.node ?? "(unnamed)";
			blame.set(node, (blame.get(node) ?? 0) + share);
		}
	}
	return [...blame.entries()]
		.map(([node, moved]) => ({ node, moved }))
		.sort((a, b) => b.moved - a.moved)
		.slice(0, limit);
}

/** One metric, rated. */
export interface Measure {
	readonly name: string;
	readonly value: number;
	readonly unit: "ms" | "score";
	readonly rating: Rating;
	/** What the value points at, when the browser said. */
	readonly detail?: string;
}

/** Read the vitals into rated measures. */
export function measure(vitals: Vitals): readonly Measure[] {
	const measures: Measure[] = [];

	const ttfb = vitals.nav?.responseStart;
	if (ttfb !== undefined) {
		measures.push({
			name: "time to first byte",
			value: ttfb,
			unit: "ms",
			rating: rate(ttfb, THRESHOLDS.ttfb),
		});
	}

	const fcp = vitals.paints["first-contentful-paint"];
	if (fcp !== undefined) {
		measures.push({
			name: "first contentful paint",
			value: fcp,
			unit: "ms",
			rating: rate(fcp, THRESHOLDS.fcp),
		});
	}

	if (vitals.lcp) {
		measures.push({
			name: "largest contentful paint",
			value: vitals.lcp.time,
			unit: "ms",
			rating: rate(vitals.lcp.time, THRESHOLDS.lcp),
			...(vitals.lcp.element === null ? {} : { detail: vitals.lcp.element }),
		});
	}

	const cls = cumulativeShift(vitals.shifts);
	if (watching(vitals, "layout-shift")) {
		measures.push({
			name: "cumulative layout shift",
			value: Math.round(cls * 1000) / 1000,
			unit: "score",
			rating: rate(cls, THRESHOLDS.cls),
			...(vitals.shifts.length === 0
				? {}
				: {
						detail: `${vitals.shifts.length} shift${
							vitals.shifts.length === 1 ? "" : "s"
						}`,
					}),
		});
	}

	const blocking = vitals.longTasks.reduce(
		(sum, task) => sum + Math.max(0, task.duration - THRESHOLDS.longTask.good),
		0,
	);
	// Watched for, not found, is the same rule layout shift follows
	// and the exact mirror of the bug that rule was written for. A
	// page that blocked nobody is good news; reporting nothing at
	// all made it indistinguishable from a page nobody watched, and
	// two reads of one page could answer four measures and PASS or
	// five and FAIL with no way to tell which had happened.
	if (watching(vitals, "longtask")) {
		measures.push({
			name: "total blocking time",
			value: Math.round(blocking),
			unit: "ms",
			rating: rate(blocking, THRESHOLDS.tbt),
			...(vitals.longTasks.length === 0
				? {}
				: {
						detail: `${vitals.longTasks.length} long task${
							vitals.longTasks.length === 1 ? "" : "s"
						}`,
					}),
		});
	}

	return measures;
}
