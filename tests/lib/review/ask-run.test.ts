import { describe, expect, it } from "vitest";
import type { AskRun, ParticipantIdentity } from "../../../lib/review/index.js";
import {
	askedOf,
	failureLines,
	newRunId,
	runSummary,
	staleRuntimeAdvisory,
	stoppedNotes,
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

describe("saying what became of a stopped participant", () => {
	it("names who was stopped, by what, and where the answer went", () => {
		// Recording the path and never printing it is most of the way to
		// losing the answer anyway: nobody reads a ledger they have no
		// reason to open.
		const said = stoppedNotes(
			run({
				outcomes: [
					{
						participantId: "hawk",
						findingIds: [1, 2],
						stopped: { limit: "wall-clock", detail: "timed out" },
						answerPath: "/state/answers/council-1/hawk.txt",
					},
					{ participantId: "owl", findingIds: [3] },
				],
			}),
		);

		expect(said).toHaveLength(1);
		expect(said[0]).toContain("hawk");
		expect(said[0]).toContain("wall-clock");
		expect(said[0]).toContain("/state/answers/council-1/hawk.txt");
	});

	it("still says a reviewer was stopped when no answer was kept", () => {
		const said = stoppedNotes(
			run({
				outcomes: [
					{
						participantId: "hawk",
						findingIds: [],
						stopped: { limit: "idle", detail: "went quiet" },
					},
				],
			}),
		);

		expect(said).toHaveLength(1);
		expect(said[0]).toContain("hawk");
		expect(said[0]).not.toContain("undefined");
	});

	it("says nothing about a round where nobody was stopped", () => {
		expect(stoppedNotes(run())).toEqual([]);
	});
});

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
			pending: 0,
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
		expect(summary).toEqual({
			asked: 2,
			answered: 1,
			failed: 1,
			pending: 0,
			findings: 2,
		});
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
		expect(summary).toEqual({
			asked: 2,
			answered: 2,
			failed: 0,
			pending: 0,
			findings: 0,
		});
	});

	it("counts someone asked who never reported at all as failed", () => {
		// A participant with no outcome is not the same as one that
		// answered nothing: nothing came back, and the count has to say
		// so or a dropped reviewer disappears silently.
		const summary = runSummary(
			run({ outcomes: [{ participantId: "hawk", findingIds: [1] }] }),
		);
		expect(summary).toEqual({
			asked: 2,
			answered: 1,
			failed: 1,
			pending: 0,
			findings: 1,
		});
	});

	it("counts silence on an open round as pending, not as failure", () => {
		// The same silence means opposite things either side of settling.
		// A started round that has recorded nothing counted as everybody
		// failing, and every sentence built on that read as an accusation
		// against reviewers who were at that moment working.
		const summary = runSummary({ ...run(), open: true, outcomes: [] });

		expect(summary).toEqual({
			asked: 2,
			answered: 0,
			failed: 0,
			pending: 2,
			findings: 0,
		});
	});

	it("still counts a recorded failure on an open round", () => {
		// Only silence changes meaning. A failure somebody wrote down is
		// a failure whatever state the round is in, and a collect that
		// died halfway leaves exactly that: some outcomes recorded, the
		// round still open.
		const summary = runSummary({
			...run(),
			open: true,
			outcomes: [{ participantId: "hawk", findingIds: [], failure: "died" }],
		});

		expect(summary).toMatchObject({ failed: 1, pending: 1, answered: 0 });
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
			pending: 0,
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

describe("a round that died because pi is no longer where it was", () => {
	// Measured. Pi upgraded mid-session and deleted the versioned
	// install directory the running session pins its children to, so
	// every reviewer crashed at startup reading a theme from a path that
	// had gone. The health check catches exactly this and writes an
	// actionable sentence, the runner puts that sentence on every
	// participant, and the round then printed it once per participant as
	// though seven different things had gone wrong. Retrying is the one
	// thing that cannot work, and retrying is what a reader reaches for.
	const stale =
		"Pi runtime stale: the running pi install at `/x/.pi/pkg/pi-0.83.0` no " +
		"longer exists on disk. Pi was likely updated (nix gc, brew upgrade, " +
		"etc.) mid-session; restart pi to load the new binary. Subagent " +
		"dispatch will fail until you do.";

	/** A round where every reviewer died of the same broken session. */
	function wrecked(): AskRun {
		return run({
			outcomes: [
				{
					participantId: "hawk",
					findingIds: [],
					failure: stale,
					advisory: stale,
				},
				{
					participantId: "owl",
					findingIds: [],
					failure: stale,
					advisory: stale,
				},
			],
		});
	}

	it("says it once, naming the install and the way out", () => {
		const said = staleRuntimeAdvisory(wrecked());

		expect(said).toContain("pi-0.83.0");
		expect(said).toContain("restart");
	});

	it("is said once in the whole round, not once per participant", () => {
		// The measurement that matters, and the one the first version of
		// this got wrong by counting inside the advisory itself, which
		// is one sentence by construction. What a reader sees is the
		// advisory plus the roll call, and hoisting a sentence already
		// on every outcome made a seven-reviewer round eight copies
		// long rather than one.
		const round = wrecked();
		const hoisted = staleRuntimeAdvisory(round);
		const whole = [hoisted, ...failureLines(round, hoisted)].join("\n");

		expect(whole.match(/pi-0\.83\.0/g)).toHaveLength(1);
	});

	it("still names every reviewer that failed", () => {
		// Collapsing the repetition must not collapse the roll call. A
		// round that hid who was asked would read as one that never ran.
		const lines = failureLines(wrecked(), stale);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("hawk");
		expect(lines[1]).toContain("owl");
	});

	it("prints a failure of its own in full", () => {
		// Only the repeated sentence is collapsed. A reviewer that died
		// of something else in the same round still says what.
		const lines = failureLines(
			run({
				outcomes: [
					{
						participantId: "hawk",
						findingIds: [],
						failure: stale,
						advisory: stale,
					},
					{
						participantId: "owl",
						findingIds: [],
						failure: "the model was overloaded",
					},
				],
			}),
			stale,
		);

		expect(lines[0]).toBe("hawk: as above.");
		expect(lines[1]).toBe("owl: the model was overloaded");
	});

	it("says nothing when no participant died of it", () => {
		expect(staleRuntimeAdvisory(run())).toBeUndefined();
	});

	it("says nothing for a failure that merely mentions a path", () => {
		// It is a fact the dispatching side states, not a shape read out
		// of prose. A reviewer whose own message quotes a package path
		// is a different event, and telling somebody to restart pi over
		// it costs them the session this exists to save.
		expect(
			staleRuntimeAdvisory(
				run({
					outcomes: [
						{
							participantId: "hawk",
							findingIds: [],
							failure: `${stale} (quoted by a reviewer, not diagnosed)`,
						},
					],
				}),
			),
		).toBeUndefined();
	});

	it("speaks up when only one participant hit it", () => {
		// A stale install kills every reviewer it reaches, so one is
		// enough to know, and a round where a single dispatch raced the
		// deletion is exactly as unrecoverable by retry as one where all
		// seven did.
		const said = staleRuntimeAdvisory(
			run({
				outcomes: [
					{ participantId: "hawk", findingIds: [1] },
					{
						participantId: "owl",
						findingIds: [],
						failure: stale,
						advisory: stale,
					},
				],
			}),
		);

		expect(said).toBeDefined();
	});
});
