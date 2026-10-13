/**
 * A round's roster is chosen in layers, and says which one chose.
 *
 * The order is the whole contract: what a round names beats what its
 * quest names, which beats what its project names, which beats the
 * roster in the file, which beats the one the package ships. A round
 * that quietly asked a different layer's reviewers is the surprise the
 * layers were built to end, so each step of the order has a case.
 */

import { describe, expect, it } from "vitest";
import {
	asItRuns,
	BUILT_IN_ROSTER,
	chooseRoster,
	DEFAULT_MAX_REVIEWERS,
	maxReviewers,
	setSizes,
	sourceSentence,
	tooMany,
} from "../../extensions/review-integration/roster.ts";

const PATH = "/config/pi/agentic-harness.pi/config.json";

const SECTION = {
	reviewers: [{ id: "configured" }],
	sets: {
		deep: { reviewers: [{ id: "a" }, { id: "b" }, { id: "c" }] },
		quick: { reviewers: [{ id: "q" }] },
	},
	quests: { "QEST-1": "quick" },
	projects: { "github:Jitsusama/agentic-harness.pi": "deep" },
};

const PROJECT = "github:Jitsusama/agentic-harness.pi";

/** The ids a choice would ask, or its refusal. */
function idsOf(choice: ReturnType<typeof chooseRoster>): string[] | string {
	if ("refusal" in choice) return choice.refusal;
	const value = choice.value as { reviewers: { id: string }[] };
	return value.reviewers.map((one) => one.id);
}

describe("choosing a round's roster", () => {
	it("asks the set the round names over everything else", () => {
		const choice = chooseRoster(
			SECTION,
			{ set: "deep", quest: "QEST-1", project: PROJECT },
			PATH,
		);

		expect(idsOf(choice)).toEqual(["a", "b", "c"]);
		expect("source" in choice && choice.source).toEqual({
			kind: "round",
			set: "deep",
		});
	});

	it("asks the quest's set over the project's", () => {
		const choice = chooseRoster(
			SECTION,
			{ quest: "QEST-1", project: PROJECT },
			PATH,
		);

		expect(idsOf(choice)).toEqual(["q"]);
	});

	it("asks the project's set over the configured roster", () => {
		const choice = chooseRoster(
			SECTION,
			{ quest: "QEST-2", project: PROJECT },
			PATH,
		);

		expect(idsOf(choice)).toEqual(["a", "b", "c"]);
	});

	it("asks the configured roster when no set applies", () => {
		const choice = chooseRoster(SECTION, { project: "github:x/y" }, PATH);

		expect(idsOf(choice)).toEqual(["configured"]);
	});

	it("asks the built-in roster when the file has none", () => {
		const choice = chooseRoster(undefined, {}, PATH);

		expect("source" in choice && choice.source).toEqual({ kind: "built-in" });
		expect("value" in choice && choice.value).toBe(BUILT_IN_ROSTER);
	});

	it("asks the built-in roster by name, even over a configured one", () => {
		const choice = chooseRoster(SECTION, { set: "built-in" }, PATH);

		expect("value" in choice && choice.value).toBe(BUILT_IN_ROSTER);
	});

	it("refuses a set nobody defined, naming the ones that exist", () => {
		// Falling through to another layer would run a council on
		// reviewers nobody chose, which costs what a round costs.
		const choice = chooseRoster(SECTION, { set: "huge" }, PATH);

		expect(idsOf(choice)).toMatch(/"huge"/);
		expect(idsOf(choice)).toMatch(/built-in, deep, quick/);
		expect(idsOf(choice)).toContain(PATH);
	});

	it("refuses a quest entry naming a missing set, naming the entry", () => {
		const choice = chooseRoster(
			{ ...SECTION, quests: { "QEST-1": "gone" } },
			{ quest: "QEST-1" },
			PATH,
		);

		expect(idsOf(choice)).toMatch(/review\.ask\.quests\.QEST-1/);
	});

	it("says which layer chose, in a sentence", () => {
		expect(
			sourceSentence({ kind: "quest", quest: "QEST-1", set: "quick" }, PATH),
		).toBe("the quick set, which review.ask.quests names for QEST-1");
		expect(sourceSentence({ kind: "built-in" }, PATH)).toMatch(
			/built-in roster.*review\.ask/,
		);
	});
});

describe("what a participant runs on", () => {
	it("runs a participant with no model on the session's, at high", () => {
		// Leaving the model out used to hand the child pi's defaultModel,
		// while the listing said it ran on the session's.
		const roster = asItRuns(
			{ reviewers: [{ id: "a" }], judge: { id: "judge" } },
			"anthropic/claude-opus-5-5",
		);

		expect(roster.reviewers[0]).toEqual({
			id: "a",
			model: "anthropic/claude-opus-5-5",
			thinkingLevel: "high",
		});
		expect(roster.judge?.model).toBe("anthropic/claude-opus-5-5");
	});

	it("keeps what a participant says for itself", () => {
		const roster = asItRuns(
			{
				reviewers: [
					{ id: "a", model: "openai/gpt-5.6", thinkingLevel: "xhigh" },
				],
			},
			"anthropic/claude-opus-5-5",
		);

		expect(roster.reviewers[0]).toEqual({
			id: "a",
			model: "openai/gpt-5.6",
			thinkingLevel: "xhigh",
		});
	});

	it("leaves the model alone when the session has none", () => {
		const roster = asItRuns({ reviewers: [{ id: "a" }] });

		expect(roster.reviewers[0]).toEqual({ id: "a", thinkingLevel: "high" });
	});
});

describe("how many reviewers a round may ask", () => {
	it("allows eight unless the config says otherwise", () => {
		expect(maxReviewers(undefined)).toBe(DEFAULT_MAX_REVIEWERS);
		expect(DEFAULT_MAX_REVIEWERS).toBe(8);
		expect(maxReviewers({ maxReviewers: 12 })).toBe(12);
		expect(maxReviewers({ maxReviewers: 0 })).toBe(DEFAULT_MAX_REVIEWERS);
	});

	it("refuses a round over the cap, saying how to raise it", () => {
		expect(tooMany(8, 8, PATH)).toBeUndefined();
		const refusal = tooMany(22, 8, PATH);

		expect(refusal).toMatch(/22 reviewers/);
		expect(refusal).toMatch(/the most a round may ask is 8/);
		expect(refusal).toContain(`review.ask.maxReviewers in ${PATH}`);
	});

	it("lists each set with its size", () => {
		expect(setSizes(SECTION)).toEqual([
			{ name: "deep", size: 3 },
			{ name: "quick", size: 1 },
		]);
	});
});
