/**
 * The margin a stretch of session compacts at, drawn with a recorded
 * chance so the choice can be measured rather than only argued for.
 *
 * The payback test fires once the reads saved reach a multiple of what
 * compacting costs. The replay put the cheapest multiple at one, but
 * nearly flat around it, and a compaction interrupts the user and loses
 * detail the replay cannot price, so the usual multiple is √2: over the
 * month from 2026-08-24 that is 8 percent fewer compactions for about
 * $70 more ($9,376 against $9,306). The replay could compare multiples
 * only by simulating what a session would have done, and a live policy
 * that always picks one leaves nothing to compare against: with a
 * propensity of exactly one, inverse-propensity and doubly-robust
 * estimates are undefined. So a share of stretches compact a little
 * earlier (at 1) or later (at 2), and each draw is written to the
 * session log with the probability it had, before anything it
 * influences has happened. Stretches logged before this, at a usual
 * multiple of one with arms at 1/√2 and √2, are a different policy and
 * are told apart by the thresholds they record.
 *
 * A stretch runs from one compaction to the next. The draw is made once
 * per stretch and read back from the log on resume, so a restart does
 * not draw again and weight the stretch twice.
 */

import { choseWithPropensity } from "../control/index.ts";

/** The session entry a draw is recorded under. */
export const THRESHOLD_ENTRY = "compaction-threshold";

/** The margin the payback test uses when nothing is being explored. */
export const USUAL_THRESHOLD = Math.SQRT2;

/**
 * Earlier and later, a factor of √2 either side of the usual √2, so
 * neither direction is favoured. The earlier arm is the replay's
 * cheapest margin, which keeps it measured against the one in use.
 * Written out rather than multiplied, so they record exactly 1 and 2.
 */
const EXPLORED_THRESHOLDS = [1, 2] as const;

/** One stretch's threshold, and the chance it had of being chosen. */
export interface ThresholdDraw {
	readonly threshold: number;
	readonly propensity: number;
	readonly explored: boolean;
}

/**
 * Draw the threshold for a new stretch: the usual one except for a
 * `explorationRate` share of stretches, split evenly between earlier
 * and later.
 */
export function drawThreshold(
	random: () => number,
	explorationRate: number,
): ThresholdDraw {
	const choice = choseWithPropensity({
		deterministic: USUAL_THRESHOLD,
		alternatives: EXPLORED_THRESHOLDS,
		explorationRate,
		random,
	});
	return {
		threshold: choice.value,
		propensity: choice.propensity,
		explored: choice.explored,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isDraw(value: unknown): value is ThresholdDraw {
	return (
		isRecord(value) &&
		typeof value.threshold === "number" &&
		typeof value.propensity === "number" &&
		typeof value.explored === "boolean"
	);
}

/**
 * The draw recorded since the branch's last compaction, or null when
 * this stretch has not drawn yet.
 */
export function currentThresholdDraw(
	entries: readonly unknown[],
): ThresholdDraw | null {
	let draw: ThresholdDraw | null = null;
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction") {
			draw = null;
		} else if (
			entry.type === "custom" &&
			entry.customType === THRESHOLD_ENTRY &&
			isDraw(entry.data)
		) {
			draw = entry.data;
		}
	}
	return draw;
}
