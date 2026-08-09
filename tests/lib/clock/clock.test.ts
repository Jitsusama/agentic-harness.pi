/**
 * What a duration bounding a child process may be.
 *
 * The rules belong to the runner and are applied by everybody who
 * reads a duration out of a config file, which is the point of the
 * module: the runner is the last place they can be applied, and a
 * refusal that arrives there arrives as a thrown error in the middle
 * of a paid round rather than as an answer about a file.
 */

import { describe, expect, it } from "vitest";
import {
	CLOCK_CEILING_MS,
	CLOCK_FLOOR_MS,
	whyUnusableClock,
	whyUnusableClocks,
} from "../../../lib/clock/index.js";

describe("whether one duration can be used", () => {
	it("says nothing about a duration that can", () => {
		expect(whyUnusableClock("timeoutMs", 45 * 60 * 1000)).toBeUndefined();
		expect(whyUnusableClock("timeoutMs", CLOCK_FLOOR_MS)).toBeUndefined();
		expect(whyUnusableClock("timeoutMs", CLOCK_CEILING_MS)).toBeUndefined();
	});

	it("says nothing about one nobody set", () => {
		// Absent means the runner's own default stands, which is a
		// different thing from a value that cannot be used.
		expect(whyUnusableClock("timeoutMs", undefined)).toBeUndefined();
	});

	it("names the floor, and the mistake that lands under it", () => {
		// Seconds where milliseconds are meant is the one somebody
		// actually writes, and 45 is a perfectly plausible thing to type.
		const why = whyUnusableClock("backstopMs", 45);

		expect(why).toContain("backstopMs is 45ms");
		expect(why).toContain(`${CLOCK_FLOOR_MS}ms floor`);
		expect(why).toContain("Milliseconds, not seconds");
	});

	it("names the ceiling", () => {
		expect(whyUnusableClock("timeoutMs", CLOCK_CEILING_MS + 1)).toContain(
			"past the",
		);
	});

	it("refuses a duration that is not a whole number of them", () => {
		// A timer takes an integer, and the fractional value that reaches
		// one is either rounded silently or rejected loudly depending on
		// how far down it gets.
		expect(whyUnusableClock("timeoutMs", 1_500.5)).toContain(
			"whole number of milliseconds",
		);
		expect(whyUnusableClock("timeoutMs", Number.POSITIVE_INFINITY)).toContain(
			"whole number of milliseconds",
		);
		expect(whyUnusableClock("timeoutMs", Number.NaN)).toContain(
			"whole number of milliseconds",
		);
	});
});

describe("whether a set of durations can be used together", () => {
	it("says nothing about a set that can", () => {
		expect(
			whyUnusableClocks({
				timeoutMs: 45 * 60 * 1000,
				idleTimeoutMs: 15 * 60 * 1000,
				wrapUpReserveMs: 5 * 60 * 1000,
			}),
		).toBeUndefined();
	});

	it("refuses an idle guard that outlives the wall", () => {
		// No single value is wrong, which is why the pair needs a rule:
		// the wall fires first however patient the guard is, so somebody
		// who moved one column of the table gets neither clock they
		// meant.
		const why = whyUnusableClocks({
			timeoutMs: 600_000,
			idleTimeoutMs: 900_000,
		});

		expect(why).toContain("idleTimeoutMs (900000ms)");
		expect(why).toContain("timeoutMs (600000ms)");
	});

	it("lets a zero reserve through, and nothing else under the floor", () => {
		// Zero is the documented way to switch the soft deadline off, so
		// it is the one value under the floor that means something rather
		// than being a mistake.
		expect(whyUnusableClocks({ wrapUpReserveMs: 0 })).toBeUndefined();
		expect(whyUnusableClocks({ wrapUpReserveMs: 500 })).toContain("floor");
		// And it stays a mistake for the two that are limits, since a
		// zero there stops the run the instant it starts.
		expect(whyUnusableClocks({ timeoutMs: 0 })).toContain("floor");
		expect(whyUnusableClocks({ idleTimeoutMs: 0 })).toContain("floor");
	});

	it("reports a bad value before it reports a bad pair", () => {
		// Both are wrong here. The value is the one somebody can act on,
		// and a pair complaint about a number that was never usable
		// sends them to look at the wrong column.
		expect(
			whyUnusableClocks({ timeoutMs: 45, idleTimeoutMs: 900_000 }),
		).toContain("Milliseconds, not seconds");
	});
});
