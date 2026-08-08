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
import type { ParticipantOverride } from "../../../lib/review/index.js";
import {
	overrideRoster,
	parseParticipant,
	retryCannotResettle,
} from "../../../lib/review/index.js";

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

		// The whole sentence, because asserting it contains "xhi" is
		// satisfied by the typo being quoted back and says nothing about
		// whether the message names a way out, and asserting "xhigh" is
		// satisfied by the same three letters plus two more.
		expect(parsed).toEqual({
			refusal:
				'review.ask.reviewers[0].thinkingLevel is "xhi", which pi does ' +
				"not accept. Use one of off, minimal, low, medium, high, xhigh.",
		});
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

		// Naming who it does ask is the actionable half, and the earlier
		// assertion for it was satisfied by "hawkk" containing "hawk".
		expect(over).toEqual({
			refusal:
				'This roster has nobody called "hawkk". It asks "hawk", "owl", "judge".',
		});
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

	it("refuses somebody this round will not ask, and says so differently", () => {
		// A council does not ask the judge, so tuning the judge for one did
		// nothing and said nothing. Membership of the roster is the wrong
		// question; what this round asks is the right one.
		const over = overrideRoster(
			ROSTER,
			{ judge: { thinkingLevel: "xhigh" } },
			ROSTER.reviewers,
		);

		expect(over).toEqual({
			refusal:
				'This round does not ask "judge", so setting anything for them ' +
				'would do nothing. It asks "hawk", "owl".',
		});
	});

	it("is refused on a retry, which cannot re-settle what it re-asks", () => {
		// A retry substitutes its answer into a round that already recorded
		// who it asked and at what. On a different model that files one
		// participant's answer into a run whose ledger names another, and
		// the identity ledger cannot catch it: the substitution keeps the
		// held run's participants, so nothing ever claims the new setting.
		const why = retryCannotResettle(
			{ hawk: { model: "openai/gpt-5" } },
			{ id: "council-1" },
			"hawk",
		);

		expect(why).toContain("cannot take new settings");
		expect(why).toContain("council-1");
		// And says what to do instead, since a refusal without one is a
		// dead end for whoever hit it.
		expect(why).toContain("fresh council");
	});

	it("leaves an ordinary retry alone", () => {
		expect(
			retryCannotResettle(undefined, { id: "council-1" }, "hawk"),
		).toBeUndefined();
	});

	it("refuses an empty tool palette, which reads as the opposite", () => {
		// The runner treats an empty palette as none given and hands over
		// the default one, so a reviewer meant to be blind would have got
		// everything and the ledger would have recorded a palette it never
		// had.
		const over = overrideRoster(ROSTER, { hawk: { tools: [] } });

		expect(over).toEqual({
			refusal: expect.stringContaining("default palette"),
		});
	});

	it("changes the lens for one round, including to one the repo owns", () => {
		// Deliberately not allowed at first, on the reasoning that a lens
		// belongs to a participant and a spare one is a roster entry. Repo
		// agents made that wrong: the roster is one file covering every
		// repo an operator reviews in, and a repo's own lenses exist only
		// in that repo, so a global entry naming one refuses everywhere
		// else. Per-round is the only scope that fits.
		const over = overrideRoster(ROSTER, {
			hawk: { persona: "repo:code-reviewer" },
		});

		expect(over).toEqual({
			roster: expect.objectContaining({
				reviewers: [
					expect.objectContaining({
						id: "hawk",
						persona: "repo:code-reviewer",
					}),
					expect.objectContaining({ id: "owl" }),
				],
			}),
		});
	});

	it("takes the settings it names and nothing else a caller sends", () => {
		// The type says four fields and a type says nothing at runtime.
		// Spreading whatever arrived let a caller rename a participant
		// through a door meant for settings, and a changed id would slip
		// past the collision check that runs only over a whole roster.
		const over = overrideRoster(ROSTER, {
			hawk: { id: "owl", colour: "red" } as ParticipantOverride,
		});

		expect(over).toEqual({
			roster: expect.objectContaining({
				reviewers: [
					{
						id: "hawk",
						persona: "architect",
						model: "anthropic/claude-opus-5",
					},
					{ id: "owl", persona: "test-skeptic", thinkingLevel: "high" },
				],
			}),
		});
	});
});
