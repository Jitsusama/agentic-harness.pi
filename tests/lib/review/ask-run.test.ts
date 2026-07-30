import { describe, expect, it } from "vitest";
import type { AskRun, ParticipantIdentity } from "../../../lib/review/index.js";
import {
	askedOf,
	newRunId,
	runSummary,
	substituteOutcome,
} from "../../../lib/review/index.js";

const hawk: ParticipantIdentity = {
	id: "hawk",
	role: "reviewer",
	model: "opus",
};
const owl: ParticipantIdentity = {
	id: "owl",
	role: "reviewer",
	model: "sonnet",
};

function run(over: Partial<AskRun> = {}): AskRun {
	return {
		id: "council-20260730-000001",
		round: "council",
		startedAt: "2026-07-30T00:00:00.000Z",
		participants: [hawk, owl],
		outcomes: [
			{ participantId: "hawk", findingIds: [1, 2] },
			{ participantId: "owl", findingIds: [3] },
		],
		...over,
	};
}

describe("naming a run", () => {
	it("carries the round, so a bare id says what it was", () => {
		expect(newRunId("council", new Date("2026-07-30T12:34:56Z"), 1)).toMatch(
			/^council-/,
		);
	});

	it("sorts by when it happened", () => {
		const early = newRunId("council", new Date("2026-07-30T00:00:00Z"), 1);
		const late = newRunId("council", new Date("2026-07-30T00:00:01Z"), 1);
		expect([late, early].sort()).toEqual([early, late]);
	});

	it("distinguishes two runs inside one millisecond", () => {
		// A timestamp is not unique enough on its own. Two ids that
		// collide would make one run's findings unreachable, so the
		// sequence is part of the name rather than a tiebreak applied
		// later.
		const at = new Date("2026-07-30T00:00:00.000Z");
		expect(newRunId("council", at, 1)).not.toBe(newRunId("council", at, 2));
	});

	it("keeps the sequence ordering too, so ties still sort", () => {
		const at = new Date("2026-07-30T00:00:00.000Z");
		const first = newRunId("council", at, 9);
		const second = newRunId("council", at, 10);
		expect([second, first].sort()).toEqual([first, second]);
	});
});

describe("what a run came to", () => {
	it("counts who was asked, who answered and what they raised", () => {
		expect(runSummary(run())).toEqual({
			asked: 2,
			answered: 2,
			failed: 0,
			findings: 3,
		});
	});

	it("counts a failure as asked but not answered", () => {
		const summary = runSummary(
			run({
				outcomes: [
					{ participantId: "hawk", findingIds: [1, 2] },
					{ participantId: "owl", findingIds: [], failure: "timed out" },
				],
			}),
		);
		expect(summary).toEqual({ asked: 2, answered: 1, failed: 1, findings: 2 });
	});

	it("counts an answer of nothing as an answer", () => {
		// A reviewer that read the change and had no complaint is not a
		// failure, and reporting it as one would make a clean review
		// look broken.
		const summary = runSummary(
			run({
				outcomes: [
					{ participantId: "hawk", findingIds: [] },
					{ participantId: "owl", findingIds: [] },
				],
			}),
		);
		expect(summary).toEqual({ asked: 2, answered: 2, failed: 0, findings: 0 });
	});

	it("counts someone asked who never reported at all as failed", () => {
		// A participant with no outcome is not the same as one that
		// answered nothing: nothing came back, and the count has to say
		// so or a dropped reviewer disappears silently.
		const summary = runSummary(
			run({ outcomes: [{ participantId: "hawk", findingIds: [1] }] }),
		);
		expect(summary).toEqual({ asked: 2, answered: 1, failed: 1, findings: 1 });
	});
});

describe("who was asked", () => {
	it("finds a participant by id", () => {
		expect(askedOf(run(), "owl")).toEqual(owl);
	});

	it("says nothing about somebody who was not in the run", () => {
		expect(askedOf(run(), "wren")).toBeUndefined();
	});
});

describe("substituting one outcome", () => {
	it("replaces that participant's outcome and leaves the rest", () => {
		const next = substituteOutcome(run(), {
			participantId: "owl",
			findingIds: [7, 8],
		});

		expect(next.outcomes).toEqual([
			{ participantId: "hawk", findingIds: [1, 2] },
			{ participantId: "owl", findingIds: [7, 8] },
		]);
	});

	it("keeps the outcome where it was, so the roster order holds", () => {
		// A retry that moved a reviewer to the end would reorder every
		// report of the run for no reason a reader could see.
		const next = substituteOutcome(run(), {
			participantId: "hawk",
			findingIds: [9],
		});

		expect(next.outcomes.map((o) => o.participantId)).toEqual(["hawk", "owl"]);
	});

	it("clears a failure when the retry succeeds", () => {
		const failed = run({
			outcomes: [
				{ participantId: "hawk", findingIds: [] },
				{ participantId: "owl", findingIds: [], failure: "timed out" },
			],
		});

		const next = substituteOutcome(failed, {
			participantId: "owl",
			findingIds: [5],
		});

		expect(next.outcomes[1]).toEqual({
			participantId: "owl",
			findingIds: [5],
		});
		expect(runSummary(next).failed).toBe(0);
	});

	it("leaves the original untouched", () => {
		// A run is a record of what happened. Editing one in place
		// would rewrite history that something else may already hold.
		const before = run();
		substituteOutcome(before, { participantId: "owl", findingIds: [7] });

		expect(before.outcomes[1]).toEqual({
			participantId: "owl",
			findingIds: [3],
		});
	});

	it("adds an outcome for someone asked who had none", () => {
		const partial = run({
			outcomes: [{ participantId: "hawk", findingIds: [1] }],
		});

		const next = substituteOutcome(partial, {
			participantId: "owl",
			findingIds: [4],
		});

		expect(next.outcomes).toHaveLength(2);
		expect(runSummary(next)).toEqual({
			asked: 2,
			answered: 2,
			failed: 0,
			findings: 2,
		});
	});

	it("refuses to invent a participant nobody asked", () => {
		// Substituting an outcome for someone outside the roster would
		// make the run claim it asked somebody it never did.
		expect(() =>
			substituteOutcome(run(), { participantId: "wren", findingIds: [1] }),
		).toThrow(/wren/);
	});
});
