/**
 * Every round keeps what an answer told it about itself.
 *
 * Each round built its participant's outcome by hand, and the council
 * was the only one that kept a failed participant's usage and advisory:
 * the judge, the critique, the audit and the stack round dropped both.
 * A reviewer that died at its deadline spent the whole budget, so the
 * round's cost lost its largest term, and a stale install's advisory
 * never reached the reader who had to restart pi.
 *
 * Written as one table over every round, because the rule belongs to
 * none of them, and the next round added would be free to forget it.
 */

import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	CouncilDeps,
	Finding,
	Participant,
	ParticipantOutcome,
} from "../../../../lib/core/review/index.ts";
import {
	runAudit,
	runCouncil,
	runCritique,
	runJudge,
	runStackCouncil,
} from "../../../../lib/core/review/index.ts";

/** A participant, spelled the way a roster carries one. */
const ONE: Participant = { id: "wren", model: "opus" };

/** The one change a stack round reads. */
const TIP = "refs/heads/tip";

/** Deps that give every participant the same answer. */
function deps(answer: AskAnswer): CouncilDeps {
	let issued = 0;
	return {
		ask: async () => answer,
		async record(findings) {
			return findings.map((finding): Finding => {
				issued += 1;
				return { ...finding, id: issued };
			});
		},
		now: () => new Date("2026-07-30T01:00:00.000Z"),
	};
}

/** Every round, and the outcome it gives its one participant. */
const ROUNDS: readonly [
	string,
	(answer: AskAnswer) => Promise<ParticipantOutcome | undefined>,
][] = [
	[
		"a council",
		async (answer) =>
			(
				await runCouncil(
					{ roster: { reviewers: [ONE] }, prompt: "look", seq: 1 },
					deps(answer),
				)
			).run.outcomes[0],
	],
	[
		"a stack round",
		async (answer) => {
			const council = deps(answer);
			return (
				await runStackCouncil(
					{
						roster: { reviewers: [ONE] },
						prompt: "look",
						seq: 1,
						stackRefs: [TIP],
					},
					{ ...council, record: (_ref, found) => council.record(found) },
				)
			).run.outcomes[0];
		},
	],
	[
		"a judge",
		async (answer) =>
			(
				await runJudge(
					{ judge: ONE, prompt: "consolidate", seq: 1 },
					deps(answer),
				)
			).run.outcomes[0],
	],
	[
		"a critique",
		async (answer) =>
			(
				await runCritique(
					{
						roster: { reviewers: [ONE] },
						prompt: "push back",
						seq: 1,
						findingIds: [1],
					},
					deps(answer),
				)
			).run.outcomes[0],
	],
	[
		"an audit",
		async (answer) =>
			(
				await runAudit(
					{
						auditor: ONE,
						prompt: "judge the threads",
						seq: 1,
						threadIndices: [1],
					},
					deps(answer),
				)
			).run.outcomes[0],
	],
];

describe.each(ROUNDS)("%s", (_name, outcomeOf) => {
	it("keeps what a failed participant cost and what it advised", async () => {
		const outcome = await outcomeOf({
			failure: "deadline",
			usage: { tokens: 90_000, cost: 1.25 },
			advisory: "pi is older than this package; restart it",
		});

		expect(outcome).toEqual({
			participantId: ONE.id,
			findingIds: [],
			failure: "deadline",
			usage: { tokens: 90_000, cost: 1.25 },
			advisory: "pi is older than this package; restart it",
		});
	});

	it("says nothing a failure did not carry", async () => {
		const outcome = await outcomeOf({ failure: "overloaded" });

		expect(outcome).toEqual({
			participantId: ONE.id,
			findingIds: [],
			failure: "overloaded",
		});
	});

	it("keeps where an answer was stopped, kept and what it cost", async () => {
		const outcome = await outcomeOf({
			text: "",
			stopped: { limit: "idle", detail: "went quiet" },
			answerPath: "/answers/wren.txt",
			usage: { tokens: 12, cost: 0.01 },
		});

		expect(outcome).toMatchObject({
			participantId: ONE.id,
			stopped: { limit: "idle", detail: "went quiet" },
			answerPath: "/answers/wren.txt",
			usage: { tokens: 12, cost: 0.01 },
		});
	});

	it("leaves out what an answer did not carry", async () => {
		const outcome = await outcomeOf({ text: "" });

		expect(outcome).not.toHaveProperty("stopped");
		expect(outcome).not.toHaveProperty("answerPath");
		expect(outcome).not.toHaveProperty("usage");
	});
});
