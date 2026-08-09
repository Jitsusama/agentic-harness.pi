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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	budgetFor,
	REVIEWER_ANSWER_MS,
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
			wrapUpReserveMs: REVIEWER_ANSWER_MS,
		});
	});

	it("keeps the answer's time inside the backstop, not beside it", () => {
		// The reserve is carved out of the wall clock rather than added
		// to it. A reserve as large as the budget would leave a reviewer
		// no time to find anything before being asked what it found.
		const budget = reviewerBudget(undefined);

		expect(budget.wrapUpReserveMs).toBeLessThan(budget.timeoutMs / 2);
	});

	it("takes the answer's budget from config too", () => {
		expect(reviewerBudget({ answerMs: 90_000 })).toMatchObject({
			wrapUpReserveMs: 90_000,
		});
		expect(reviewerBudget({ answerMs: -1 })).toMatchObject({
			wrapUpReserveMs: REVIEWER_ANSWER_MS,
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
			wrapUpReserveMs: REVIEWER_ANSWER_MS,
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

	it("allows a retry after an idle stop, unchanged budget and all", () => {
		// An idle clock fires because a reviewer went quiet: a hang, a
		// slow tool, a provider stalling. None of those are arithmetic
		// the way a wall clock is, so this is the retry most likely to
		// work and refusing it was blocking the good case.
		expect(
			retryWouldRepeat(
				{ limit: "idle", detail: "idle", budgetMs: 600_000 },
				{ timeoutMs: 2_700_000, idleTimeoutMs: 600_000 },
			),
		).toBe(undefined);
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

describe("what bounds one participant", () => {
	const round = reviewerBudget(undefined);

	it("holds a participant to the round's clocks by default", () => {
		// A roster where nobody says otherwise is one fan-out under one
		// set of numbers, which is what it has always been.
		expect(budgetFor({ id: "hawk" }, round)).toEqual(round);
	});

	it("gives one participant the wall it needs", () => {
		// The reason this is a knob at all. A roster mixing a small fast
		// model with a large one at high thinking has to be sized for the
		// slowest, so either the fast reviewers hold slots nobody needs
		// them to hold or the slow one is cut off mid-thought. The evidence
		// is the incident this work came out of: rounds of 15.6, 16.0,
		// 15.1 and 15.8 minutes lost two, three, six and seven reviewers,
		// while the 7.8 and 8.4 minute rounds beside them lost none.
		const slower = budgetFor({ id: "opus", backstopMs: 90 * 60 * 1000 }, round);

		expect(slower.timeoutMs).toBe(90 * 60 * 1000);
		// And nothing else moves with it, since the three clocks answer
		// three different questions.
		expect(slower.idleTimeoutMs).toBe(round.idleTimeoutMs);
		expect(slower.wrapUpReserveMs).toBe(round.wrapUpReserveMs);
	});

	it("takes each clock on its own", () => {
		expect(
			budgetFor({ id: "owl", idleMs: 20 * 60 * 1000 }, round),
		).toMatchObject({
			idleTimeoutMs: 20 * 60 * 1000,
			timeoutMs: round.timeoutMs,
		});
		expect(budgetFor({ id: "owl", answerMs: 90_000 }, round)).toMatchObject({
			wrapUpReserveMs: 90_000,
		});
	});

	it("lets a participant switch its own soft deadline off", () => {
		// Zero is the documented way to turn the soft deadline off, and it
		// has to keep meaning that one level down. Treated as a typo here,
		// a participant asking not to be interrupted would fall back to
		// the round's reserve and be interrupted anyway.
		expect(budgetFor({ id: "wren", answerMs: 0 }, round)).toMatchObject({
			wrapUpReserveMs: 0,
		});
	});

	it("is what every place a reviewer is bounded asks for", () => {
		// The join, which is the failure this project keeps making: two
		// spawn sites and a retry gate each take a budget, and a
		// per-participant clock honoured at one of the three is a clock
		// that works in a waiting round and not in a detached one, or
		// works until somebody retries.
		//
		// Found by reading the file rather than by driving it, because
		// the two spawns want a live provider and a tree, and a gate that
		// needs both is a gate nobody runs.
		const source = readFileSync(
			new URL(
				"../../extensions/review-integration/tools/ask.ts",
				import.meta.url,
			),
			"utf8",
		);
		// The declaration is one of these, so the call sites are one
		// fewer than the mentions.
		const asks = source.split("budgetForRound()").length - 2;
		const resolved = source.split("budgetFor(participant,").length - 1;

		// Both numbers named, since a pair compared only against each
		// other agrees just as happily at zero: a file that had stopped
		// bounding reviewers at all would pass.
		expect({ asks, resolved }).toEqual({ asks: 3, resolved: 3 });
	});

	it("ignores a clock that could not be used", () => {
		// The same rule the round's own config gets. A zero or negative
		// backstop would stop this reviewer the instant it started, which
		// is never what somebody writing one meant.
		expect(budgetFor({ id: "wren", backstopMs: 0 }, round)).toEqual(round);
		expect(budgetFor({ id: "wren", idleMs: -1 }, round)).toEqual(round);
	});
});
