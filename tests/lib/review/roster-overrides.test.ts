/**
 * Who a round asks, decided at the call rather than only in a file.
 *
 * The roster came from config and nothing else, so trying one reviewer
 * on a different model meant editing a file, running the round, and
 * editing it back. The fan-out tool next door has taken model,
 * thinking level and tools per call since it was written, and the
 * asymmetry has no reason behind it.
 *
 * The thinking level is the other half. It was read as any non-blank
 * string and handed to pi's `--thinking` flag, so "xhi" reached the
 * CLI and a reviewer ran at whatever pi does with a level it does not
 * know. An override would have made that easier to do by accident, so
 * both roads go through one gate.
 */

import { describe, expect, it } from "vitest";
import { overrideRoster, parseParticipant } from "../../../lib/review/index.js";

/** A roster as config produces one. */
const ROSTER = {
	reviewers: [
		{ id: "hawk", persona: "architect", model: "anthropic/claude-opus-5" },
		{ id: "owl", persona: "test-skeptic", thinkingLevel: "high" },
	],
	judge: { id: "judge", model: "anthropic/claude-opus-5" },
};

describe("a thinking level pi would not accept", () => {
	it("is refused where it is written, naming what it should be", () => {
		const parsed = parseParticipant(
			{ id: "hawk", thinkingLevel: "xhi" },
			"review.ask.reviewers[0]",
		);

		expect(parsed).toEqual({
			refusal: expect.stringContaining("xhi"),
		});
		expect("refusal" in parsed && parsed.refusal).toContain("xhigh");
	});

	it("still accepts every level pi does", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			expect(
				parseParticipant({ id: "hawk", thinkingLevel: level }, "path"),
			).toEqual({
				participant: expect.objectContaining({ thinkingLevel: level }),
			});
		}
	});
});

describe("overriding a roster for one round", () => {
	it("changes only what the override names", () => {
		const over = overrideRoster(ROSTER, { hawk: { thinkingLevel: "xhigh" } });

		expect(over).toEqual({
			roster: {
				reviewers: [
					{
						id: "hawk",
						persona: "architect",
						model: "anthropic/claude-opus-5",
						thinkingLevel: "xhigh",
					},
					{ id: "owl", persona: "test-skeptic", thinkingLevel: "high" },
				],
				judge: { id: "judge", model: "anthropic/claude-opus-5" },
			},
		});
	});

	it("reaches the judge, who is asked the same way a reviewer is", () => {
		const over = overrideRoster(ROSTER, { judge: { model: "openai/gpt-5" } });

		expect(over).toEqual({
			roster: expect.objectContaining({
				judge: { id: "judge", model: "openai/gpt-5" },
			}),
		});
	});

	it("refuses a name nobody on the roster answers to", () => {
		// The likeliest thing to get wrong, and silently doing nothing is
		// the worst answer: the round runs, costs what it costs, and the
		// setting the person asked for was never applied.
		const over = overrideRoster(ROSTER, { hawkk: { thinkingLevel: "xhigh" } });

		expect(over).toEqual({ refusal: expect.stringContaining("hawkk") });
		expect("refusal" in over && over.refusal).toContain("hawk");
	});

	it("refuses a level pi would not accept, the same as config does", () => {
		const over = overrideRoster(ROSTER, { hawk: { thinkingLevel: "xhi" } });

		expect(over).toEqual({ refusal: expect.stringContaining("xhigh") });
	});

	it("refuses a model carrying a colon, the same as config does", () => {
		// A colon is pi's thinking-level separator, so a model holding one
		// silently becomes a different request than the one written.
		const over = overrideRoster(ROSTER, {
			hawk: { model: "anthropic/claude-opus-5:high" },
		});

		expect(over).toEqual({ refusal: expect.stringContaining("colon") });
	});

	it("leaves the roster alone when nothing is overridden", () => {
		expect(overrideRoster(ROSTER, {})).toEqual({ roster: ROSTER });
	});
});
