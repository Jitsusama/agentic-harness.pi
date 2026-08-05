/**
 * What bounds a reviewer, and what that bound is for.
 *
 * This file used to assert that a participant's wall clock sat well
 * inside the runner's ceiling, on the reasoning that the longest round
 * anybody had seen took two and a half minutes, so fifteen left ample
 * headroom. Six rounds later that reasoning is refuted. Duration alone
 * explains every outcome:
 *
 *   6.9 min   48 findings, nothing lost
 *   7.8 min   61 findings, nothing lost
 *   8.4 min   50 findings, nothing lost
 *   15.1 min  6 of 7 reviewers lost
 *   15.6 min  2 lost
 *   16.0 min  3 lost
 *   15.8 min  7 of 7 lost, $50.63 spent, zero findings
 *
 * Every round that finished under the bound lost nothing, and every
 * round that reached it lost reviewers in proportion. The bound was
 * doing the opposite of its job: it was not catching wedged reviewers,
 * it was killing working ones.
 *
 * So the wall clock is demoted. It is a backstop against a reviewer
 * nothing else will stop, and the thing that actually catches a wedged
 * one is the idle clock, which fires on silence rather than on effort.
 * A generous wall clock is only safe because the idle clock exists,
 * which is why both are asserted here together.
 */

import { describe, expect, it } from "vitest";
import {
	REVIEWER_BACKSTOP_MS,
	REVIEWER_IDLE_MS,
	retryWouldRepeat,
	reviewerBudget,
} from "../../extensions/review-integration/budget.js";
import { DEFAULT_RUN_PI_TIMEOUT_MS } from "../../lib/subagent/runpi/spawn.js";

describe("the wall clock as a backstop", () => {
	it("does not cut a reviewer off before the runner would", () => {
		// Undercutting the runner's own default is what made this a
		// budget rather than a backstop. The review path has no better
		// information than the runner about how long honest work takes.
		expect(REVIEWER_BACKSTOP_MS).toBeGreaterThanOrEqual(
			DEFAULT_RUN_PI_TIMEOUT_MS,
		);
	});

	it("leaves room for the rounds that were being killed", () => {
		// The longest round observed ran to 16 minutes and was still
		// working when it was stopped, so the floor is what we know was
		// not enough, with room for a larger diff than any seen yet.
		const longestObservedMs = 16 * 60 * 1000;

		expect(REVIEWER_BACKSTOP_MS).toBeGreaterThan(longestObservedMs * 2);
	});
});

describe("the idle clock as the liveness guard", () => {
	it("fires well before the backstop, so silence is caught first", () => {
		// If the backstop fired first, a wedged reviewer would hold a
		// slot for the whole budget and the generous wall clock would
		// be a cost rather than a safety net.
		expect(REVIEWER_IDLE_MS).toBeLessThan(REVIEWER_BACKSTOP_MS);
	});

	it("allows a long stretch of thinking before calling it wedged", () => {
		// A reviewer at high thinking against a large diff can be quiet
		// for minutes at a time. Calling that wedged would reintroduce
		// the bug this file documents, in a different clock.
		expect(REVIEWER_IDLE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
	});
});

describe("what a round is bounded by", () => {
	it("uses the defaults when config says nothing", () => {
		expect(reviewerBudget(undefined)).toEqual({
			timeoutMs: REVIEWER_BACKSTOP_MS,
			idleTimeoutMs: REVIEWER_IDLE_MS,
		});
	});

	it("takes an override from config, so nobody has to patch source", () => {
		// The original bad number was a constant in a panel module. The
		// fix is not a better constant, it is that the number stops
		// being ours alone to choose.
		expect(reviewerBudget({ backstopMs: 90 * 60 * 1000 })).toMatchObject({
			timeoutMs: 90 * 60 * 1000,
		});
		expect(reviewerBudget({ idleMs: 20 * 60 * 1000 })).toMatchObject({
			idleTimeoutMs: 20 * 60 * 1000,
		});
	});

	it("ignores a value that is not a usable number", () => {
		// A typo in config must not silently produce a zero budget,
		// which would stop every reviewer the instant it started.
		for (const bad of [0, -1, "45m", null, Number.NaN]) {
			expect(reviewerBudget({ backstopMs: bad })).toMatchObject({
				timeoutMs: REVIEWER_BACKSTOP_MS,
			});
		}
	});

	it("reads nothing out of a section that is not an object", () => {
		expect(reviewerBudget("nonsense")).toEqual({
			timeoutMs: REVIEWER_BACKSTOP_MS,
			idleTimeoutMs: REVIEWER_IDLE_MS,
		});
	});
});

describe("asking a stopped reviewer again", () => {
	// Every failed retry in the incident ran for 15.03 minutes and died
	// the same way, because nothing about the wall it hit had moved.
	// Three of those cost real money to learn nothing.
	const budget = { timeoutMs: 900_000, idleTimeoutMs: 600_000 };

	it("refuses while the budget that stopped it is unchanged", () => {
		const refusal = retryWouldRepeat(
			{ limit: "wall-clock", detail: "timed out", budgetMs: 900_000 },
			budget,
		);

		expect(refusal).toBeDefined();
		// The number to change has to be in the sentence, or the reader
		// is told no and left to go looking for the knob.
		expect(refusal).toContain("900000");
		expect(refusal).toMatch(/backstopMs/);
	});

	it("allows it once the budget has been raised", () => {
		expect(
			retryWouldRepeat(
				{ limit: "wall-clock", detail: "timed out", budgetMs: 900_000 },
				{ timeoutMs: 2_700_000, idleTimeoutMs: 600_000 },
			),
		).toBe(undefined);
	});

	it("measures an idle stop against the idle budget", () => {
		expect(
			retryWouldRepeat(
				{ limit: "idle", detail: "idle", budgetMs: 600_000 },
				{ timeoutMs: 2_700_000, idleTimeoutMs: 600_000 },
			),
		).toBeDefined();
	});

	it("says nothing about a reviewer that was never stopped", () => {
		expect(retryWouldRepeat(undefined, budget)).toBe(undefined);
	});

	it("allows a retry when the round did not record what stopped it", () => {
		// Rounds recorded before the budget was written down. Refusing on
		// a number nobody has would block every retry of an old round,
		// which is worse than allowing one that may repeat.
		expect(
			retryWouldRepeat({ limit: "wall-clock", detail: "timed out" }, budget),
		).toBe(undefined);
	});

	it("does not judge a cancelled reviewer against a clock", () => {
		// Cancelled and parent-exit are not budgets. Asking again is
		// exactly the right thing to do, and there is no number to raise.
		expect(
			retryWouldRepeat({ limit: "cancelled", detail: "cancelled" }, budget),
		).toBe(undefined);
	});
});
