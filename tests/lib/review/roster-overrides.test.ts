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
		// Naming what it objected to, since the refusal now lets some
		// settings through and a reader has to know which one stopped it.
		expect(why).toContain('"model"');
		// And says what to do instead, since a refusal without one is a
		// dead end for whoever hit it.
		expect(why).toContain("fresh council");
	});

	it("lets a retry move the clock that refused it", () => {
		// The retry of a stopped reviewer is refused outright unless its
		// wall has moved, so refusing the setting that moves the wall
		// leaves editing a committed file as the only road to the retry
		// this rule is telling somebody to run. How long a reviewer was
		// allowed does not change what its findings mean, which is the
		// whole reason the other settings are refused.
		expect(
			retryCannotResettle(
				{ hawk: { backstopMs: 5_400_000 } },
				{ id: "council-1" },
				"hawk",
			),
		).toBeUndefined();
		// And still refuses when a clock is carrying something else in
		// beside it.
		expect(
			retryCannotResettle(
				{ hawk: { backstopMs: 5_400_000, thinkingLevel: "low" } },
				{ id: "council-1" },
				"hawk",
			),
		).toContain('"thinkingLevel"');
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

describe("a clock one participant keeps", () => {
	it("is read off the roster it was written in", () => {
		const parsed = parseParticipant(
			{ id: "opus", backstopMs: 5_400_000, answerMs: 0 },
			"review.ask.reviewers[0]",
		);

		expect(parsed).toEqual({
			participant: { id: "opus", backstopMs: 5_400_000, answerMs: 0 },
		});
	});

	it("is held to what the runner will actually accept", () => {
		// The same rule the model and the level get, and taken from the
		// runner rather than restated: a clock written down and silently
		// dropped is a reviewer running under settings nobody chose, and
		// a clock refused hours later from inside a round is a council
		// nobody gets.
		//
		// The first version of this refused zero and nothing else, which
		// let through every value that actually kills a spawn.
		expect(
			parseParticipant(
				{ id: "hawk", backstopMs: 0 },
				"review.ask.reviewers[0]",
			),
		).toEqual({
			refusal:
				"review.ask.reviewers[0].backstopMs is 0ms, which is below the " +
				"1000ms floor and would stop the run almost at once. " +
				"Milliseconds, not seconds. Give it a duration in milliseconds, " +
				"or leave it out to take the round's.",
		});
		// The one somebody actually writes: seconds where milliseconds
		// were meant. It passed the first version of this gate and threw
		// at spawn, hours later, as an error about a runner.
		expect(
			parseParticipant(
				{ id: "hawk", backstopMs: 45 },
				"review.ask.reviewers[0]",
			),
		).toMatchObject({
			refusal: expect.stringContaining("Milliseconds, not seconds"),
		});
		expect(
			parseParticipant(
				{ id: "hawk", answerMs: 1_500.5 },
				"review.ask.reviewers[0]",
			),
		).toMatchObject({
			refusal: expect.stringContaining("whole number of milliseconds"),
		});
		expect(
			parseParticipant({ id: "hawk", idleMs: -1 }, "review.ask.reviewers[0]"),
		).toMatchObject({ refusal: expect.stringContaining("idleMs is -1ms") });
		expect(
			parseParticipant(
				{ id: "hawk", answerMs: "90s" },
				"review.ask.reviewers[0]",
			),
		).toEqual({
			refusal:
				"review.ask.reviewers[0].answerMs must be a number of milliseconds.",
		});
	});

	it("can be moved for one round, which is when somebody asks", () => {
		// The adjustment made right after being told a reviewer ran out
		// of time. Editing a committed file and running again is the
		// wrong shape for that, and it is the shape this had.
		const over = overrideRoster(ROSTER, { hawk: { backstopMs: 5_400_000 } });

		expect(over).toEqual({
			roster: expect.objectContaining({
				reviewers: [
					{
						id: "hawk",
						persona: "architect",
						model: "anthropic/claude-opus-5",
						backstopMs: 5_400_000,
					},
					{ id: "owl", persona: "test-skeptic", thinkingLevel: "high" },
				],
			}),
		});
	});

	it("goes through the same gate wherever it was written", () => {
		// An override is easier to get wrong than a file, since nobody
		// reviews it, so it is the road that most needs the refusal.
		expect(overrideRoster(ROSTER, { owl: { idleMs: 0 } })).toMatchObject({
			refusal: expect.stringContaining('the override for "owl".idleMs is 0ms'),
		});
	});

	it("refuses an idle guard that outlives the wall beside it", () => {
		// No single value is wrong here, which is why it needs a rule of
		// its own: the runner refuses the pair outright, and this is the
		// mistake somebody makes by moving one column of the table.
		expect(
			parseParticipant(
				{ id: "hawk", backstopMs: 600_000, idleMs: 900_000 },
				"review.ask.reviewers[0]",
			),
		).toMatchObject({
			refusal: expect.stringContaining(
				"idleMs (900000ms) outlives backstopMs (600000ms)",
			),
		});
	});

	it("keeps a clock that is perfectly usable", () => {
		// The other side, which nothing asserted: a parse that read every
		// clock and dropped it would have passed every refusal above.
		expect(
			parseParticipant(
				{ id: "hawk", idleMs: 1_200_000 },
				"review.ask.reviewers[0]",
			),
		).toEqual({ participant: { id: "hawk", idleMs: 1_200_000 } });
		expect(
			overrideRoster(ROSTER, { owl: { idleMs: 1_200_000 } }),
		).toMatchObject({
			roster: {
				reviewers: [
					expect.objectContaining({ id: "hawk" }),
					expect.objectContaining({ id: "owl", idleMs: 1_200_000 }),
				],
			},
		});
	});
});
